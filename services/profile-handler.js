const EventFetcher = require('./event-fetcher');
const EventProcessor = require('./event-processor');

const KIND_PROFILE = 0;

class ProfileHandler {
  constructor(relayUrls, database, log) {
    this.eventFetcher = new EventFetcher(relayUrls, database, log);
    this.eventProcessor = new EventProcessor(database, log);
    this.database = database;
    this.log = log || console;
    this.isStopping = false;
  }

  async fetchAndProcessProfiles(pubkeys) {
    if (pubkeys.length === 0) {
      this.log.info('No ranked pubkeys found, skipping profile subscription.');
      return;
    }

    // Filter out pubkeys we already have profiles for (with timestamp check)
    const newPubkeys = await this.database.filterNewPubkeys(pubkeys);
    if (newPubkeys.length === 0) {
      console.log(`[KIND-0 PROFILE FETCH] All ${pubkeys.length} profiles queried recently, skipping.`);
    } else {
      console.log(`[KIND-0 PROFILE FETCH] Fetching ${newPubkeys.length} kind-0 profiles (${pubkeys.length - newPubkeys.length} queried recently)`);
      
    // Batch requests - kind-0 is replaceable so we can batch larger (500 pubkeys = 500 events max)
    const BATCH_SIZE = 500;
    
    for (let i = 0; i < newPubkeys.length; i += BATCH_SIZE) {
      if (this.isStopping) {
        console.log('[KIND-0 PROFILE FETCH] Shutdown requested, stopping...');
        return;
      }
      const batch = newPubkeys.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(newPubkeys.length / BATCH_SIZE);
      const progressPct = Math.round((i / newPubkeys.length) * 100);
      
      console.log(`[KIND-0 PROFILE FETCH] Batch ${batchNum}/${totalBatches} (${progressPct}% - ${i}/${newPubkeys.length} processed)`);
      
      const batchEvents = await this.eventFetcher.fetchLatestEvents(KIND_PROFILE, batch);
      
      // Process batch immediately instead of accumulating
      await this.eventProcessor.processEvents(batchEvents, KIND_PROFILE);
      
      // Build profile timestamp map from fetched events
      const profileTimestamps = new Map();
      batchEvents.forEach(event => {
        const existing = profileTimestamps.get(event.pubkey);
        if (!existing || event.created_at > existing) {
          profileTimestamps.set(event.pubkey, event.created_at);
        }
      });
      
      // Record profile timestamps only (does NOT touch last_activity_check - that's for activity checks)
      try {
        await this.database.recordProfileTimestamp(batch, profileTimestamps);
        console.log(`[KIND-0 PROFILE FETCH] Recorded profile timestamps for ${batch.length} pubkeys`);
      } catch (err) {
        console.error(`[KIND-0 PROFILE FETCH] Failed to record profile timestamps: ${err.message}`);
      }
      
      // Small delay between batches to be nice to relays
      if (i + BATCH_SIZE < newPubkeys.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
    }
    
    console.log(`[KIND-0 PROFILE FETCH] Complete - ${newPubkeys.length} kind-0 profiles fetched.`);
    }
    
    // Filter to users whose activity is stale:
    //   - never checked before (no row in profile_refresh_queue), OR
    //   - last_activity_check older than 7 days
    const pubkeysNeedingActivity = await this.database.query(`
      SELECT DISTINCT ur.ranked_user_pubkey
      FROM user_rankings ur
      LEFT JOIN profile_refresh_queue prq
        ON ur.ranked_user_pubkey = prq.pubkey
      WHERE prq.pubkey IS NULL
         OR prq.last_activity_check IS NULL
         OR prq.last_activity_check <= NOW() - INTERVAL '7 days'
    `);
    const activityPubkeys = pubkeysNeedingActivity.rows.map(r => r.ranked_user_pubkey);
    
    if (activityPubkeys.length === 0) {
      console.log('[ACTIVITY CHECK] All users queried within 7 days, skipping.');
      return;
    }
    
    console.log(`[ACTIVITY CHECK] Checking activity for ${activityPubkeys.length} users (last_activity_check NULL or >7 days old)`);
    
    const BATCH_SIZE = 5; // Even smaller batches to avoid relay timeouts
    for (let i = 0; i < activityPubkeys.length; i += BATCH_SIZE) {
      if (this.isStopping) {
        console.log('[ACTIVITY CHECK] Shutdown requested, stopping...');
        return;
      }
      const batch = activityPubkeys.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(activityPubkeys.length / BATCH_SIZE);
      const progressPct = Math.round((i / activityPubkeys.length) * 100);
      
      console.log(`[ACTIVITY CHECK] Batch ${batchNum}/${totalBatches} (${progressPct}%)`);
      
      // Get last activity timestamps for this batch to filter events
      // Only use last_activity_timestamp if we've actually done a proper activity check before
      // (last_activity_check IS NOT NULL means we did a batch check and know the timestamp is valid)
      const lastCheckResult = await this.database.query(`
        SELECT pubkey, 
               CASE 
                 WHEN last_activity_check IS NOT NULL THEN COALESCE(last_activity_timestamp, 0)
                 ELSE 0
               END as last_check_ts
        FROM profile_refresh_queue
        WHERE pubkey = ANY($1::text[])
      `, [batch]);
      
      const lastCheckMap = new Map();
      lastCheckResult.rows.forEach(row => {
        lastCheckMap.set(row.pubkey, row.last_check_ts || 0);
      });
      
      // Initialize missing pubkeys with 0 (they're not in the queue yet)
      batch.forEach(pubkey => {
        if (!lastCheckMap.has(pubkey)) {
          lastCheckMap.set(pubkey, 0);
        }
      });
      
      // Query for most recent event of any kind authored by these users (use different relays for activity)
      const activityRelayUrls = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.primal.net', 'wss://relay.nostr.band'];
      
      // Use minimum since timestamp for the batch to only get events newer than last check
      const sinceTimestamps = Array.from(lastCheckMap.values()).filter(ts => ts > 0);
      const minSince = sinceTimestamps.length > 0 ? Math.min(...sinceTimestamps) : 0;
      
      // The limit applies to the whole filter, not per-author
      // Relay limit is 500, so with 5 users per batch we get ~100 events per user on average
      // No kinds filter = any kind (faster, but some relays may reject)
      const activityFilter = { 
        authors: batch, 
        limit: 500 
      };
      if (minSince > 0) {
        activityFilter.since = minSince;
      }
      
      // Debug: log filter summary
      console.log(`[ACTIVITY CHECK] Filter: since=${minSince || 'none'}, batch_size=${batch.length}, relays=${activityRelayUrls.length}`);
      
      // Try query with retry logic for 0-event batches
      // querySync waits for ALL relays to respond (EOSE, timeout, or error) before returning
      // Use longer initial timeout to give all relays time to respond
      let activityEvents = [];
      let retryCount = 0;
      const MAX_RETRIES = 1; // Retry once with even longer timeout
      const INITIAL_MAX_WAIT = 15000; // 15s initial timeout to wait for all relays
      const RETRY_MAX_WAIT = 30000; // 30s retry timeout
      
      while (retryCount <= MAX_RETRIES) {
        try {
          const startTime = Date.now();
          const currentMaxWait = retryCount === 0 ? INITIAL_MAX_WAIT : RETRY_MAX_WAIT;
          
          
          // Use subscribeEose with onclose to catch relay errors
          const relayCloses = [];
          const events = [];
          let eoseReceived = false;
          let subscriptionClosed = false;
          
          const sub = this.eventFetcher.pool.subscribeEose(
            activityRelayUrls,
            activityFilter,
            {
              maxWait: currentMaxWait,
              onevent: (event) => {
                events.push(event);
              },
              oneose: () => {
                eoseReceived = true;
              },
              onclose: (reasons) => {
                subscriptionClosed = true;
                // reasons is an array of close reasons, one per relay
                if (Array.isArray(reasons)) {
                  reasons.forEach((reason, idx) => {
                    if (reason && !reason.includes('closed automatically on eose') && !reason.includes('closed by caller')) {
                      relayCloses.push({ relay: activityRelayUrls[idx], reason });
                    }
                  });
                }
              }
            }
          );
          
          // Wait for EOSE or timeout (subscribeEose closes automatically on EOSE)
          const waitStart = Date.now();
          while (!subscriptionClosed && (Date.now() - waitStart) < currentMaxWait + 2000) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          
          // Ensure subscription is closed
          if (!subscriptionClosed) {
            sub.close();
          }
          
          activityEvents = events;
          const elapsed = Date.now() - startTime;
          
          if (relayCloses.length > 0) {
            console.log(`[ACTIVITY CHECK] ⚠️ Relay errors: ${relayCloses.map(r => `${r.relay.split('/').pop()}: ${r.reason}`).join(', ')}`);
          }
          
          console.log(`[ACTIVITY CHECK] Query completed in ${elapsed}ms, got ${activityEvents.length} events`);
          
          // If we got events, break out of retry loop
          if (activityEvents.length > 0) {
            break;
          }
          
          // If we got 0 events and this is the first attempt, retry with longer timeout
          if (retryCount === 0 && activityEvents.length === 0) {
            console.log(`[ACTIVITY CHECK] Got 0 events after ${elapsed}ms, retrying with longer timeout...`);
            retryCount++;
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
            continue;
          }
          
          // If retry also got 0, we can conclude inactive (all relays responded)
          break;
        } catch (err) {
          console.error(`[ACTIVITY CHECK] Relay query failed (attempt ${retryCount + 1}): ${err.message}`);
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait before retry
            continue;
          } else {
            console.error(err.stack);
            activityEvents = [];
            break;
          }
        }
      }
      
      // Build activity map: pubkey -> latest created_at (newer than last check)
      const batchActivity = new Map();
      activityEvents.forEach(event => {
        const lastCheck = lastCheckMap.get(event.pubkey) || 0;
        if (event.created_at > lastCheck) {
          const existing = batchActivity.get(event.pubkey);
          if (!existing || event.created_at > existing) {
            batchActivity.set(event.pubkey, event.created_at);
          }
        }
      });
      
      console.log(`[ACTIVITY CHECK] Relay returned ${activityEvents.length} total events; ${batchActivity.size}/${batch.length} users had new activity`);
      
      // KEYS WITH A RESULT: update last_activity_timestamp and last_activity_check
      const usersWithActivity = Array.from(batchActivity.keys());
      if (usersWithActivity.length > 0) {
        try {
          await this.database.recordActivityCheck(usersWithActivity, batchActivity);
        } catch (err) {
          console.error(`[ACTIVITY CHECK] Failed to record activity: ${err.message}`);
          console.error(err.stack);
        }
      }
      
      // KEYS WITHOUT A RESULT: get re-batched (no DB update, they stay stale)
      // EXCEPTION: if the WHOLE batch returned 0 events AFTER retry, mark all as checked
      // (querySync waits for all relays to respond, so 0 events means user is legitimately inactive)
      if (activityEvents.length === 0 && retryCount >= MAX_RETRIES) {
        console.log('[ACTIVITY CHECK] Batch returned 0 events after retry; all relays responded. Marking all pubkeys as checked (inactive).');
        const usersWithoutActivity = batch.filter(p => !batchActivity.has(p));
        if (usersWithoutActivity.length > 0) {
          try {
            await this.database.recordActivityCheck(usersWithoutActivity, new Map());
          } catch (err) {
            console.error(`[ACTIVITY CHECK] Failed to mark inactive: ${err.message}`);
            console.error(err.stack);
          }
        }
      } else if (activityEvents.length === 0) {
        console.log('[ACTIVITY CHECK] Batch returned 0 events on first try; will retry next run (not marking as checked yet).');
        // Don't update last_activity_check - leave it NULL so it gets re-batched
      }
      
      // Delay after each batch to be nice to relays
      if (i + BATCH_SIZE < activityPubkeys.length) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Increased delay
      }
    }
    
    console.log(`[ACTIVITY CHECK] Complete.`);
  }

  close() {
    this.isStopping = true;
    this.eventFetcher.close();
  }
}

module.exports = ProfileHandler;




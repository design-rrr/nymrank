const EventFetcher = require('./event-fetcher');
const EventProcessor = require('./event-processor');
const { getRelayConfig } = require('./config');

const KIND_PROFILE = 0;
const MIN_RANK_VALUE_ACTIVITY = 35;
/**
 * Single window for everything we care about on the list: "recent" activity and how often we re-check.
 * If last_activity_timestamp is within this window, we skip relay queries. If not, we may query when
 * last_activity_check is older than this (or never).
 */
const ACTIVITY_WINDOW_DAYS = 10;
const TIER1_BATCH_SIZE = 10;
/** Second pass after tier-1 for the same users who still have no activity in ACTIVITY_WINDOW_DAYS. */
const TIER2_VERIFY_BATCH_SIZE = 3;

class ProfileHandler {
  constructor(relayUrls, database, log) {
    this.eventFetcher = new EventFetcher(relayUrls, database, log);
    this.eventProcessor = new EventProcessor(database, log);
    this.database = database;
    this.log = log || console;
    this.activityRelayUrls = getRelayConfig().socialRelayUrls;
    this.isStopping = false;
  }

  /**
   * @returns {{ suggestSoonRecheck: boolean }} When true, scheduler may run again soon after a long pass (see RelayListener).
   */
  async fetchAndProcessProfiles(pubkeys) {
    let suggestSoonRecheck = false;

    if (pubkeys.length === 0) {
      this.log.info('No ranked pubkeys found, skipping profile subscription.');
      return { suggestSoonRecheck: false };
    }

    // Filter out pubkeys we already have profiles for (with timestamp check)
    const newPubkeys = await this.database.filterNewPubkeys(pubkeys);
    if (newPubkeys.length === 0) {
      console.log(`[KIND-0 PROFILE FETCH] All ${pubkeys.length} profiles queried recently, skipping.`);
    } else {
      suggestSoonRecheck = true;
      console.log(`[KIND-0 PROFILE FETCH] Fetching ${newPubkeys.length} kind-0 profiles (${pubkeys.length - newPubkeys.length} queried recently)`);
      
    // Batch requests - kind-0 is replaceable so we can batch larger (500 pubkeys = 500 events max)
    const BATCH_SIZE = 500;
    
    for (let i = 0; i < newPubkeys.length; i += BATCH_SIZE) {
      if (this.isStopping) {
        console.log('[KIND-0 PROFILE FETCH] Shutdown requested, stopping...');
        return { suggestSoonRecheck: true };
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
    
    const windowDays = String(ACTIVITY_WINDOW_DAYS);
    const activityDueResult = await this.database.query(
      `
      SELECT ur.ranked_user_pubkey
      FROM user_rankings ur
      LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
      WHERE ur.rank_value >= $1
        AND (
          prq.last_activity_timestamp IS NULL
          OR prq.last_activity_timestamp < EXTRACT(EPOCH FROM (NOW() - ($2::text || ' days')::INTERVAL))::bigint
        )
        AND (
          prq.pubkey IS NULL
          OR prq.last_activity_check IS NULL
          OR prq.last_activity_check <= NOW() - ($2::text || ' days')::INTERVAL
        )
      GROUP BY ur.ranked_user_pubkey
    `,
      [MIN_RANK_VALUE_ACTIVITY, windowDays]
    );
    const tier1Pubkeys = activityDueResult.rows.map((r) => r.ranked_user_pubkey);

    if (tier1Pubkeys.length === 0) {
      await this.logActivityCheckSkipBreakdown(windowDays);
      return { suggestSoonRecheck };
    }

    console.log(
      `[ACTIVITY CHECK] Tier-1: ${tier1Pubkeys.length} users without activity in last ${ACTIVITY_WINDOW_DAYS}d and check due, batch ${TIER1_BATCH_SIZE}`
    );
    await this.processActivityBatches(tier1Pubkeys, TIER1_BATCH_SIZE, 'tier1');

    const stillNoRecentActivity = await this.database.query(
      `
      SELECT prq.pubkey AS ranked_user_pubkey
      FROM profile_refresh_queue prq
      INNER JOIN user_rankings ur ON ur.ranked_user_pubkey = prq.pubkey
      WHERE ur.rank_value >= $1
        AND prq.pubkey = ANY($3::text[])
        AND (
          prq.last_activity_timestamp IS NULL
          OR prq.last_activity_timestamp < EXTRACT(EPOCH FROM (NOW() - ($2::text || ' days')::INTERVAL))::bigint
        )
    `,
      [MIN_RANK_VALUE_ACTIVITY, windowDays, tier1Pubkeys]
    );
    const tier2Pubkeys = stillNoRecentActivity.rows.map((r) => r.ranked_user_pubkey);

    if (tier2Pubkeys.length > 0) {
      console.log(
        `[ACTIVITY CHECK] Tier-2 (verify after tier-1; still no activity in last ${ACTIVITY_WINDOW_DAYS}d): ${tier2Pubkeys.length} users, batch ${TIER2_VERIFY_BATCH_SIZE}`
      );
      await this.processActivityBatches(tier2Pubkeys, TIER2_VERIFY_BATCH_SIZE, 'tier2');
    } else {
      console.log(
        `[ACTIVITY CHECK] Tier-2 verify: 0 pubkeys still stale after tier-1 (no small-batch pass needed this cycle).`
      );
    }

    console.log('[ACTIVITY CHECK] Complete.');
    return { suggestSoonRecheck: true };
  }

  /**
   * When tier-1 eligibility is empty, explain why and log that tier-2 cannot run (it only follows tier-1).
   */
  async logActivityCheckSkipBreakdown(windowDays) {
    const p = [MIN_RANK_VALUE_ACTIVITY, windowDays];
    const freshQ = await this.database.query(
      `
      SELECT COUNT(DISTINCT ur.ranked_user_pubkey)::bigint AS c
      FROM user_rankings ur
      INNER JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
      WHERE ur.rank_value >= $1
        AND prq.last_activity_timestamp >= EXTRACT(EPOCH FROM (NOW() - ($2::text || ' days')::INTERVAL))::bigint
      `,
      p
    );
    const cooldownQ = await this.database.query(
      `
      SELECT COUNT(DISTINCT ur.ranked_user_pubkey)::bigint AS c
      FROM user_rankings ur
      INNER JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
      WHERE ur.rank_value >= $1
        AND (
          prq.last_activity_timestamp IS NULL
          OR prq.last_activity_timestamp < EXTRACT(EPOCH FROM (NOW() - ($2::text || ' days')::INTERVAL))::bigint
        )
        AND prq.last_activity_check IS NOT NULL
        AND prq.last_activity_check > NOW() - ($2::text || ' days')::INTERVAL
      `,
      p
    );
    const fresh = Number(freshQ.rows[0].c);
    const cooldown = Number(cooldownQ.rows[0].c);
    console.log(
      `[ACTIVITY CHECK] Tier-1=0 → tier-2 not run (tier-2 only runs after tier-1 in the same pass). ` +
        `Breakdown (rank>=${MIN_RANK_VALUE_ACTIVITY}): ${fresh} with last_activity in last ${ACTIVITY_WINDOW_DAYS}d (skip); ` +
        `${cooldown} stale/NULL activity but checked within ${ACTIVITY_WINDOW_DAYS}d (cooldown).`
    );
  }

  /**
   * @param {string[]} activityPubkeys
   * @param {number} batchSize
   * @param {string} label
   */
  async processActivityBatches(activityPubkeys, batchSize, label) {
    for (let i = 0; i < activityPubkeys.length; i += batchSize) {
      if (this.isStopping) {
        console.log('[ACTIVITY CHECK] Shutdown requested, stopping...');
        return;
      }
      const batch = activityPubkeys.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(activityPubkeys.length / batchSize);
      const progressPct = Math.round((i / activityPubkeys.length) * 100);

      console.log(`[ACTIVITY CHECK] ${label} batch ${batchNum}/${totalBatches} (${progressPct}%)`);
      
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
      
      // Query for most recent activity events (see kinds list below) authored by these users (use different relays for activity)
      const activityRelayUrls = this.activityRelayUrls;
      
      // Use minimum since timestamp for the batch to only get events newer than last check
      const sinceTimestamps = Array.from(lastCheckMap.values()).filter(ts => ts > 0);
      const minSince = sinceTimestamps.length > 0 ? Math.min(...sinceTimestamps) : 0;
      
      // The limit applies to the whole filter, not per-author
      // Relay limit is 500, so with 10 users per batch we get ~50 events per user on average
      const activityFilter = { 
        authors: batch,
        kinds: [
          1,      // Text notes (NIP-01)
          3,      // Contacts/follows (NIP-02)
          4,      // Encrypted DMs (NIP-04)
          5,      // Event deletion (NIP-09)
          6,      // Reposts (NIP-18)
          7,      // Reactions (NIP-25)
          16,     // Generic repost (NIP-18, alternative to 6)
          21,     // Video (NIP-94)
          22,     // Video (NIP-94)
          1984,   // Reports (NIP-56)
          30023,  // Long-form articles (NIP-23)
          9734    // Zap receipt (NIP-57)
        ],
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
      const INITIAL_MAX_WAIT = 5000; // 5s initial timeout to wait for all relays
      const RETRY_MAX_WAIT = 10000; // 10s retry timeout
      
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
      
      const eventCount = activityEvents.length;
      console.log(`[ACTIVITY CHECK] Relay returned ${eventCount} total events; ${batchActivity.size}/${batch.length} users had new activity`);
      
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
      if (eventCount === 0 && retryCount >= MAX_RETRIES) {
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
      } else if (eventCount === 0) {
        console.log('[ACTIVITY CHECK] Batch returned 0 events on first try; will retry next run (not marking as checked yet).');
        // Don't update last_activity_check - leave it NULL so it gets re-batched
      }
      
      // Clear all batch-local references to help GC
      activityEvents = null;
      lastCheckResult.rows.length = 0;
      lastCheckMap.clear();
      batchActivity.clear();
      
      // Force garbage collection if available (run with --expose-gc)
      if (global.gc) {
        global.gc();
      }
      
      // Delay after each batch to be nice to relays
      if (i + batchSize < activityPubkeys.length) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Increased delay
      }
    }
  }

  close() {
    this.isStopping = true;
    this.eventFetcher.close();
  }
}

module.exports = ProfileHandler;




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
      console.log(`[Profile Refresh] All ${pubkeys.length} profiles queried recently, skipping.`);
    } else {
      console.log(`[Profile Refresh] Fetching ${newPubkeys.length} profiles (${pubkeys.length - newPubkeys.length} queried recently)`);
      
    // Batch requests to avoid "filter too large" errors
    const BATCH_SIZE = 100;
    
    for (let i = 0; i < newPubkeys.length; i += BATCH_SIZE) {
      if (this.isStopping) {
        console.log('[Profile Fetch] Shutdown requested, stopping...');
        return;
      }
      const batch = newPubkeys.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(newPubkeys.length / BATCH_SIZE);
      const progressPct = Math.round((i / newPubkeys.length) * 100);
      
      console.log(`[Profile Fetch] Batch ${batchNum}/${totalBatches} (${progressPct}% - ${i}/${newPubkeys.length} processed)`);
      
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
      
      // Record query attempt for this batch so we don't re-fetch on restart
      try {
        await this.database.recordProfileQueryAttempt(batch, profileTimestamps, new Map());
        console.log(`[Profile Fetch] Recorded query attempt for ${batch.length} pubkeys`);
      } catch (err) {
        console.error(`[Profile Fetch] Failed to record query attempt: ${err.message}`);
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
    
    console.log(`[Profile Refresh] Complete - ${newPubkeys.length} profiles fetched.`);
    }
    
    // Filter to users whose activity is stale (>7 days since last query)
    // Use LEFT JOIN instead of NOT IN for better performance
    const pubkeysNeedingActivity = await this.database.query(`
      SELECT DISTINCT ur.ranked_user_pubkey 
      FROM user_rankings ur
      LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey 
        AND prq.last_query_attempt > NOW() - INTERVAL '7 days'
      WHERE prq.pubkey IS NULL
      LIMIT 208691
    `);
    const activityPubkeys = pubkeysNeedingActivity.rows.map(r => r.ranked_user_pubkey);
    
    if (activityPubkeys.length === 0) {
      console.log('[Activity Refresh] All users queried within 7 days, skipping.');
      return;
    }
    
    console.log(`[Activity Refresh] ${activityPubkeys.length} users need activity check (stale >7 days)`);
    
    const BATCH_SIZE = 50;
    for (let i = 0; i < activityPubkeys.length; i += BATCH_SIZE) {
      if (this.isStopping) {
        console.log('[Activity Refresh] Shutdown requested, stopping...');
        return;
      }
      const batch = activityPubkeys.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(activityPubkeys.length / BATCH_SIZE);
      const progressPct = Math.round((i / activityPubkeys.length) * 100);
      
      console.log(`[Activity Refresh] Batch ${batchNum}/${totalBatches} (${progressPct}%)`);
      
      // Get last activity timestamps for this batch to filter events
      const lastCheckResult = await this.database.query(`
        SELECT pubkey, 
               COALESCE(
                 last_activity_timestamp, 
                 CASE WHEN last_query_attempt IS NOT NULL THEN EXTRACT(EPOCH FROM last_query_attempt)::BIGINT ELSE 0 END,
                 0
               ) as last_check_ts
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
      const activityRelayUrls = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://nostrue.com'];
      
      // Use minimum since timestamp for the batch to only get events newer than last check
      const sinceTimestamps = Array.from(lastCheckMap.values()).filter(ts => ts > 0);
      const minSince = sinceTimestamps.length > 0 ? Math.min(...sinceTimestamps) : 0;
      
      // The limit applies to the whole filter, not per-author
      // Relay limit is 500, so with 50 users per batch we get ~10 events per user on average
      const activityFilter = { authors: batch, limit: 500 };
      if (minSince > 0) {
        activityFilter.since = minSince;
      }
      
      const activityEvents = await this.eventFetcher.pool.querySync(
        activityRelayUrls,
        activityFilter
      );
      
      // Build activity map for this batch - only keep events newer than last check per user
      const batchActivity = new Map();
      activityEvents.forEach(event => {
        const lastCheck = lastCheckMap.get(event.pubkey) || 0;
        // Only update if this event is newer than the last check
        if (event.created_at > lastCheck) {
          const existing = batchActivity.get(event.pubkey);
          if (!existing || event.created_at > existing) {
            batchActivity.set(event.pubkey, event.created_at);
          }
        }
      });
      
      console.log(`[Activity Refresh] Found ${batchActivity.size} users with activity out of ${batch.length} queried`);
      
      // Only update last_query_attempt for users we found activity for
      // Users without activity will have NULL last_query_attempt and get re-checked
      const usersWithActivity = Array.from(batchActivity.keys());
      
      if (usersWithActivity.length > 0) {
        try {
          await this.database.recordProfileQueryAttempt(usersWithActivity, new Map(), batchActivity);
        } catch (err) {
          console.error(`[Activity Refresh] Failed to record batch: ${err.message}`);
          console.error(err.stack);
        }
      } else {
        console.log(`[Activity Refresh] No activity found for batch, skipping database update`);
      }
      
      if (i + BATCH_SIZE < activityPubkeys.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log(`[Activity Refresh] Complete.`);
  }

  close() {
    this.isStopping = true;
    this.eventFetcher.close();
  }
}

module.exports = ProfileHandler;




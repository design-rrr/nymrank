const EventFetcher = require('./event-fetcher');
const EventProcessor = require('./event-processor');

const KIND_PROFILE = 0;

class ProfileHandler {
  constructor(relayUrls, database, log) {
    this.eventFetcher = new EventFetcher(relayUrls, database, log);
    this.eventProcessor = new EventProcessor(database, log);
    this.database = database;
    this.log = log || console;
  }

  async fetchAndProcessProfiles(pubkeys) {
    if (pubkeys.length === 0) {
      this.log.info('No ranked pubkeys found, skipping profile subscription.');
      return;
    }

    console.log(`\n[Profile Fetch] Starting: ${pubkeys.length} total ranked users`);
    
    // Filter out pubkeys we already have profiles for (with timestamp check)
    const newPubkeys = await this.database.filterNewPubkeys(pubkeys);
    if (newPubkeys.length === 0) {
      console.log('[Profile Fetch] All profiles already cached, skipping.');
    } else {
      console.log(`[Profile Fetch] Need to fetch: ${newPubkeys.length} profiles (${pubkeys.length - newPubkeys.length} already cached)\n`);
      
    // Batch requests to avoid "filter too large" errors
    const BATCH_SIZE = 100;
    
    for (let i = 0; i < newPubkeys.length; i += BATCH_SIZE) {
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
    
    console.log(`\n[Profile Fetch] Complete! Processed profiles from ${newPubkeys.length} queries.\n`);
    }
    
    // Always check activity for ALL ranked users (not just new ones)
    // Activity should be updated periodically to keep "last seen" current
    console.log(`[Activity Check] Fetching latest activity for ${pubkeys.length} users...\n`);
    
    // Filter to users without activity timestamp OR whose activity is stale (>7 days)
    // We rely on last_query_attempt to prevent re-querying users we recently checked,
    // even if we didn't find any activity for them.
    const pubkeysNeedingActivity = await this.database.query(`
      SELECT DISTINCT ranked_user_pubkey FROM user_rankings
      WHERE ranked_user_pubkey NOT IN (
        SELECT pubkey FROM profile_refresh_queue 
        WHERE last_query_attempt > NOW() - INTERVAL '7 days'
      )
      LIMIT 208691
    `);
    const activityPubkeys = pubkeysNeedingActivity.rows.map(r => r.ranked_user_pubkey);
    
    if (activityPubkeys.length === 0) {
      console.log('[Activity Check] All users have recent activity data, skipping.\n');
      return;
    }
    
    console.log(`[Activity Check] ${activityPubkeys.length} users need activity check\n`);
    
    const BATCH_SIZE = 100;
    for (let i = 0; i < activityPubkeys.length; i += BATCH_SIZE) {
      const batch = activityPubkeys.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(activityPubkeys.length / BATCH_SIZE);
      const progressPct = Math.round((i / activityPubkeys.length) * 100);
      
      console.log(`[Activity Check] Batch ${batchNum}/${totalBatches} (${progressPct}%)`);
      
      // Query for most recent event of any kind authored by these users (use different relays for activity)
      const activityRelayUrls = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://nostrue.com'];
      
      // Use a limit to prevent fetching too many events per user, but enough to cover the batch
      // Note: limit applies to the whole filter, not per-author. 
      // We use 500 (common relay max) to get as much coverage as possible for the batch of 100.
      const activityEvents = await this.eventFetcher.pool.querySync(
        activityRelayUrls,
        { authors: batch, limit: 500 }
      );
      
      // Build activity map for this batch only
      const batchActivity = new Map();
      activityEvents.forEach(event => {
        const existing = batchActivity.get(event.pubkey);
        if (!existing || event.created_at > existing) {
          batchActivity.set(event.pubkey, event.created_at);
        }
      });
      
      // Record activity for this batch immediately (don't accumulate)
      console.log(`[Activity Check] About to call recordProfileQueryAttempt with ${batch.length} pubkeys, ${batchActivity.size} activity entries`);
      try {
        await this.database.recordProfileQueryAttempt(batch, new Map(), batchActivity);
        console.log(`[Activity Check] recordProfileQueryAttempt completed successfully`);
      } catch (err) {
        console.error(`[Activity Check] Failed to record attempt for batch: ${err.message}`);
        console.error(err.stack);
      }
      
      if (i + BATCH_SIZE < activityPubkeys.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log(`\n[Activity Check] Complete!\n`);
  }

  close() {
    this.eventFetcher.close();
  }
}

module.exports = ProfileHandler;




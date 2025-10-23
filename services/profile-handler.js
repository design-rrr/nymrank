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
      return;
    }
    
    console.log(`[Profile Fetch] Need to fetch: ${newPubkeys.length} profiles (${pubkeys.length - newPubkeys.length} already cached)\n`);
    
    // Batch requests to avoid "filter too large" errors
    const BATCH_SIZE = 100;
    let allProfileEvents = [];
    
    for (let i = 0; i < newPubkeys.length; i += BATCH_SIZE) {
      const batch = newPubkeys.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(newPubkeys.length / BATCH_SIZE);
      const progressPct = Math.round((i / newPubkeys.length) * 100);
      
      console.log(`[Profile Fetch] Batch ${batchNum}/${totalBatches} (${progressPct}% - ${i}/${newPubkeys.length} processed)`);
      
      const batchEvents = await this.eventFetcher.fetchLatestEvents(KIND_PROFILE, batch);
      allProfileEvents.push(...batchEvents);
      
      // Small delay between batches to be nice to relays
      if (i + BATCH_SIZE < newPubkeys.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log(`\n[Profile Fetch] Complete! Fetched ${allProfileEvents.length} profiles from ${newPubkeys.length} queries.\n`);
    
    // Also fetch most recent event of any kind to check activity
    console.log(`[Activity Check] Fetching latest activity for ${newPubkeys.length} users...\n`);
    const lastActivity = new Map();
    
    for (let i = 0; i < newPubkeys.length; i += BATCH_SIZE) {
      const batch = newPubkeys.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(newPubkeys.length / BATCH_SIZE);
      
      console.log(`[Activity Check] Batch ${batchNum}/${totalBatches}`);
      
      // Query for most recent event of any kind (kinds 1, 6, 7, etc - common event types)
      const activityEvents = await this.eventFetcher.pool.querySync(
        this.eventFetcher.profileRelayUrls,
        { kinds: [1, 6, 7], authors: batch, limit: 1 }
      );
      
      activityEvents.forEach(event => {
        const existing = lastActivity.get(event.pubkey);
        if (!existing || event.created_at > existing) {
          lastActivity.set(event.pubkey, event.created_at);
        }
      });
      
      if (i + BATCH_SIZE < newPubkeys.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log(`\n[Activity Check] Complete! Found activity for ${lastActivity.size} users.\n`);
    
    // Record which pubkeys we queried and their profile timestamps
    const profileTimestamps = new Map();
    allProfileEvents.forEach(event => {
      profileTimestamps.set(event.pubkey, event.created_at);
    });
    
    // Mark all queried pubkeys (even ones without profiles) to avoid re-querying soon
    await this.database.recordProfileQueryAttempt(newPubkeys, profileTimestamps, lastActivity);
    
    await this.eventProcessor.processEvents(allProfileEvents, KIND_PROFILE);
  }

  close() {
    this.eventFetcher.close();
  }
}

module.exports = ProfileHandler;




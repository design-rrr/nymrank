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

    this.log.info(`Fetching profile events for ${pubkeys.length} pubkeys...`);
    
    // Filter out pubkeys we already have profiles for (with timestamp check)
    const newPubkeys = await this.database.filterNewPubkeys(pubkeys);
    if (newPubkeys.length === 0) {
      this.log.info('All pubkeys already have profiles, skipping fetch.');
      return;
    }
    
    this.log.info(`Fetching profiles for ${newPubkeys.length} new pubkeys (${pubkeys.length - newPubkeys.length} already cached)...`);
    
    // Batch requests to avoid "filter too large" errors
    const BATCH_SIZE = 100;
    let allProfileEvents = [];
    
    for (let i = 0; i < newPubkeys.length; i += BATCH_SIZE) {
      const batch = newPubkeys.slice(i, i + BATCH_SIZE);
      this.log.info(`Fetching profile batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(newPubkeys.length / BATCH_SIZE)} (${batch.length} pubkeys)...`);
      
      const batchEvents = await this.eventFetcher.fetchLatestEvents(KIND_PROFILE, batch);
      allProfileEvents.push(...batchEvents);
      
      // Small delay between batches to be nice to relays
      if (i + BATCH_SIZE < newPubkeys.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    this.log.info(`Found ${allProfileEvents.length} profile events across ${Math.ceil(newPubkeys.length / BATCH_SIZE)} batches.`);
    
    // Record which pubkeys we queried and their profile timestamps
    const profileTimestamps = new Map();
    allProfileEvents.forEach(event => {
      profileTimestamps.set(event.pubkey, event.created_at);
    });
    
    // Mark all queried pubkeys (even ones without profiles) to avoid re-querying soon
    await this.database.recordProfileQueryAttempt(newPubkeys, profileTimestamps);
    
    await this.eventProcessor.processEvents(allProfileEvents, KIND_PROFILE);
  }

  close() {
    this.eventFetcher.close();
  }
}

module.exports = ProfileHandler;




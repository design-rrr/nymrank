const EventFetcher = require('./event-fetcher');
const EventProcessor = require('./event-processor');

const KIND_RANKING = 30382;

class RankingHandler {
  constructor(relayUrls, database, log) {
    this.eventFetcher = new EventFetcher(relayUrls, database, log);
    this.eventProcessor = new EventProcessor(database, log);
    this.database = database;
    this.log = log || console;
  }

  async fetchAndProcessRankings(servicePubkeys) {
    this.log.info(`Starting ranking event backfill for ${servicePubkeys.length} service pubkeys.`);
    
    for (const pubkey of servicePubkeys) {
      this.log.info({ service: pubkey }, 'Fetching ranking events for service');

      const events = await this.eventFetcher.fetchAllHistoricalEvents(KIND_RANKING, [pubkey]);
      this.log.info(`Completed backfill for ${pubkey}, found ${events.length} events.`);
      
      // Process the events
      await this.eventProcessor.processEvents(events, KIND_RANKING);
    }

    // Get all ranked pubkeys from the database after backfill
    const rankedPubkeysResult = await this.database.query(
      'SELECT DISTINCT ranked_user_pubkey FROM user_rankings WHERE ranked_user_pubkey IS NOT NULL'
    );
    const rankedPubkeys = rankedPubkeysResult.rows.map(row => row.ranked_user_pubkey);
    this.log.info(`Found ${rankedPubkeys.length} unique ranked pubkeys from database.`);

    return rankedPubkeys;
  }

  close() {
    this.eventFetcher.close();
  }
}

module.exports = RankingHandler;




const EventFetcher = require('./event-fetcher');
const EventProcessor = require('./event-processor');

const KIND_DELEGATION = 10040;

class DelegationHandler {
  constructor(relayUrls, database, log) {
    this.eventFetcher = new EventFetcher(relayUrls, database, log);
    this.eventProcessor = new EventProcessor(database, log);
    this.log = log || console;
  }

  async fetchAndProcessDelegations(committeePubkeys) {
    if (committeePubkeys.length === 0) {
      this.log.info('No committee members found, skipping delegation subscription.');
      return;
    }

    this.log.info('Fetching latest delegation events...');
    const delegationEvents = await this.eventFetcher.fetchLatestEvents(KIND_DELEGATION, committeePubkeys);
    this.log.info(`Found ${delegationEvents.length} delegation events.`);
    
    await this.eventProcessor.processEvents(delegationEvents, KIND_DELEGATION);
    
    return delegationEvents;
  }

  async fetchLatestDelegations(committeePubkeys) {
    return this.fetchAndProcessDelegations(committeePubkeys);
  }

  close() {
    this.eventFetcher.close();
  }
}

module.exports = DelegationHandler;




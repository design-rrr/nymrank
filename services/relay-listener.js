const DelegationHandler = require('./delegation-handler');
const RankingHandler = require('./ranking-handler');
const ProfileHandler = require('./profile-handler');

class RelayListener {
  constructor(relayUrls, profileRelayUrls, database, log) {
    this.relayUrls = Array.isArray(relayUrls) ? relayUrls : [relayUrls];
    this.profileRelayUrls = Array.isArray(profileRelayUrls) ? profileRelayUrls : [profileRelayUrls];
    this.database = database;
    this.log = log || console;
    
    this.delegationHandler = new DelegationHandler(relayUrls, database, log);
    this.rankingHandler = new RankingHandler(relayUrls, database, log);
    this.profileHandler = new ProfileHandler(profileRelayUrls, database, log);
  }

  async start() {
    try {
      await this.initializeSubscriptions()
    } catch (error) {
      this.log.error('Failed to start relay listener:', error);
    }
  }

  async initializeSubscriptions() {
    try {
      // Step 1: Get committee members and fetch delegation events
      const committeePubkeys = ['3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088']; // Temporary: Justin only for testing
      this.log.info(`Found ${committeePubkeys.length} active committee members (testing Justin only).`);

      await this.subscribeToDelegations(committeePubkeys);

    } catch (error) {
      this.log.error('Failed to start relay listener:', error);
      throw error;
    }
  }

  async subscribeToDelegations(committeePubkeys) {
    await this.delegationHandler.fetchAndProcessDelegations(committeePubkeys);

    // Fetch all known service pubkeys from delegations
    const servicePubkeys = await this.database.getServicePubkeys();
    this.log.info(`Using service pubkeys from delegations: ${servicePubkeys.length} services.`);

    this.subscribeToRankings(servicePubkeys);
  }

  async subscribeToRankings(servicePubkeys) {
    const rankedPubkeys = await this.rankingHandler.fetchAndProcessRankings(servicePubkeys);

    if (rankedPubkeys.length > 0) {
      this.subscribeToProfiles(rankedPubkeys);
    }
  }

  async subscribeToProfiles(pubkeys) {
    await this.profileHandler.fetchAndProcessProfiles(pubkeys);
  }

  close() {
    this.delegationHandler.close();
    this.rankingHandler.close();
    this.profileHandler.close();
  }
}

module.exports = RelayListener;
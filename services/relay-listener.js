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
      // Skip attestation backfill - assume JSONL import has been run
      this.log.info('Skipping attestation backfill (use JSONL import for initial sync)');
      
      // Get all ranked users from the database
      const rankedUsers = await this.database.query('SELECT DISTINCT ranked_user_pubkey FROM user_rankings');
      const rankedPubkeys = rankedUsers.rows.map(r => r.ranked_user_pubkey);
      
      this.log.info(`Found ${rankedPubkeys.length} ranked users in database`);
      
      if (rankedPubkeys.length > 0) {
        await this.subscribeToProfiles(rankedPubkeys);
      } else {
        this.log.warn('No ranked users found - run JSONL import first');
      }

    } catch (error) {
      this.log.error('Failed to start relay listener:', error);
      throw error;
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
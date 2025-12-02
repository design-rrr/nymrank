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
      // Note: Both delegations (kind 10040) and attestations (kind 30382) require 
      // full historical backfill via negentropy. Run externally:
      //   strfry sync wss://nip85.brainstorm.world --filter '{"kinds":[10040,30382],"authors":[...]}' --dir down
      //   strfry export > events.jsonl
      //   node import-events.js < events.jsonl
      this.log.info('Delegations and attestations backfill requires external negentropy sync');
      
      // Get all ranked users from the database (populated during backfill)
      const rankedUsers = await this.database.query('SELECT DISTINCT ranked_user_pubkey FROM user_rankings');
      const rankedPubkeys = rankedUsers.rows.map(r => r.ranked_user_pubkey);
      
      this.log.info(`Found ${rankedPubkeys.length} ranked users in database`);
      
      if (rankedPubkeys.length > 0) {
        await this.subscribeToProfiles(rankedPubkeys);
      } else {
        this.log.warn('No ranked users found - run backfill first');
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
    // Close all websocket connections
    try {
      if (this.profileHandler.eventFetcher && this.profileHandler.eventFetcher.pool) {
        this.profileHandler.eventFetcher.pool.close([...this.relayUrls, ...this.profileRelayUrls]);
      }
    } catch (e) {
      // Ignore close errors
    }
  }
}

module.exports = RelayListener;
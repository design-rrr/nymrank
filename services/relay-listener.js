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
    
    this.profileCheckInterval = null;
    this.rankedPubkeys = [];
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
      
      // Store for periodic checks
      this.rankedPubkeys = rankedPubkeys;
      
      if (rankedPubkeys.length > 0) {
        // Run initial profile/activity check
        await this.subscribeToProfiles(rankedPubkeys);
        
        // Schedule periodic profile/activity checks (every 6 hours)
        // This ensures:
        // - Profile refreshes happen within 1 day (checked every 6h)
        // - Activity checks happen within 7 days (checked every 6h)
        this.startPeriodicProfileChecks();
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

  startPeriodicProfileChecks() {
    // Run profile/activity checks every 6 hours
    // fetchAndProcessProfiles internally checks timestamps:
    // - Profiles: refreshes if last_profile_fetch > 1 day old
    // - Activity: checks if last_activity_check is NULL or > 7 days old
    const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
    
    this.log.info(`Starting periodic profile/activity checks (every ${INTERVAL_MS / 1000 / 60} minutes)`);
    
    const runCheck = () => {
      this.subscribeToProfiles(this.rankedPubkeys)
        .then(() => {
          this.log.info('[Periodic Check] Profile/activity refresh complete');
        })
        .catch((error) => {
          this.log.error('[Periodic Check] Error during profile/activity refresh:', error);
        });
    };
    
    this.profileCheckInterval = setInterval(() => {
      this.log.info('[Periodic Check] Running profile/activity refresh...');
      runCheck();
    }, INTERVAL_MS);
  }

  close() {
    // Stop periodic checks
    if (this.profileCheckInterval) {
      clearInterval(this.profileCheckInterval);
      this.profileCheckInterval = null;
    }
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
const { Pool } = require('pg');

class Database {
  constructor() {
    this.pool = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      // PostgreSQL connection configuration
      const config = {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'nymrank',
        user: process.env.DB_USER || 'nymrank_user',
        password: process.env.DB_PASSWORD || 'nymrank_password',
        max: 20, // Maximum number of clients in the pool
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      };

      this.pool = new Pool(config);
      
      // Test the connection
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      
      this.isConnected = true;
      console.log('Connected to PostgreSQL database');
      // Ensure auxiliary tables exist
      await this.ensureAttestationEventsTable();
      
    } catch (error) {
      console.error('Failed to connect to PostgreSQL:', error);
      throw error;
    }
  }

  async query(text, params) {
    if (!this.isConnected) {
      throw new Error('Database not connected');
    }
    
    try {
      const result = await this.pool.query(text, params);
      return result;
    } catch (error) {
      console.error('Database query error:', error);
      throw error;
    }
  }

  async ensureAttestationEventsTable() {
    if (!this.isConnected) {
      throw new Error('Database not connected');
    }
    const ddl = `
      CREATE TABLE IF NOT EXISTS attestation_events (
        event_id TEXT PRIMARY KEY,
        ranked_user_pubkey TEXT NOT NULL,
        service_pubkey TEXT NOT NULL,
        committee_member_pubkey TEXT,
        event_timestamp TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attestation_events_service_ts
        ON attestation_events (service_pubkey, event_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_attestation_events_ranked
        ON attestation_events (ranked_user_pubkey);
    `;
    await this.pool.query(ddl);
  }

  async disconnect() {
    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
      console.log('Disconnected from PostgreSQL database');
    }
  }

  async clearData() {
    if (!this.isConnected) {
      throw new Error('Database not connected');
    }
    try {
      // Clear tables in reverse order of foreign key dependencies
      await this.pool.query('TRUNCATE TABLE user_rankings, delegations, user_names RESTART IDENTITY CASCADE');
      console.log('Database tables (user_rankings, delegations, user_names) cleared.');
    } catch (error) {
      console.error('Failed to clear database tables:', error);
      throw error;
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
      console.log('Disconnected from PostgreSQL database');
    }
  }

  // Health check method
  async healthCheck() {
    try {
      const result = await this.query('SELECT NOW() as timestamp');
      return {
        status: 'healthy',
        timestamp: result.rows[0].timestamp
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  // Insert ranking data from kind 30382 events
  async insertRanking(data) {
    const query = `
      INSERT INTO user_rankings (
        ranked_user_pubkey, service_pubkey, committee_member_pubkey,
        rank_value, hops, influence_score, average_score, confidence_score,
        input_value, pagerank_score, follower_count, muter_count, reporter_count,
        event_timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (ranked_user_pubkey, service_pubkey, committee_member_pubkey)
      DO UPDATE SET
        rank_value = EXCLUDED.rank_value,
        hops = EXCLUDED.hops,
        influence_score = EXCLUDED.influence_score,
        average_score = EXCLUDED.average_score,
        confidence_score = EXCLUDED.confidence_score,
        input_value = EXCLUDED.input_value,
        pagerank_score = EXCLUDED.pagerank_score,
        follower_count = EXCLUDED.follower_count,
        muter_count = EXCLUDED.muter_count,
        reporter_count = EXCLUDED.reporter_count,
        event_timestamp = EXCLUDED.event_timestamp,
        last_updated = CURRENT_TIMESTAMP
      WHERE EXCLUDED.event_timestamp > user_rankings.event_timestamp
    `;
    
    const params = [
      data.ranked_user_pubkey,
      data.service_pubkey,
      data.committee_member_pubkey,
      data.rank_value,
      data.hops,
      data.influence_score,
      data.average_score,
      data.confidence_score,
      data.input_value,
      data.pagerank_score,
      data.follower_count,
      data.muter_count,
      data.reporter_count,
      data.event_timestamp
    ];
    
    await this.query(query, params);
  }

  async insertAttestationEvent(eventId, data) {
    const query = `
      INSERT INTO attestation_events (
        event_id, ranked_user_pubkey, service_pubkey, committee_member_pubkey, event_timestamp
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (event_id) DO NOTHING
    `;
    const params = [
      eventId,
      data.ranked_user_pubkey,
      data.service_pubkey,
      data.committee_member_pubkey || null,
      data.event_timestamp
    ];
    await this.query(query, params);
  }

  // Insert delegation data from kind 10040 events
  async insertDelegation(data) {
    const query = `
      INSERT INTO delegations (
        delegator_pubkey, service_pubkey, source_relay,
        event_timestamp
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (delegator_pubkey, service_pubkey)
      DO UPDATE SET
        source_relay = EXCLUDED.source_relay,
        event_timestamp = EXCLUDED.event_timestamp,
        last_updated = CURRENT_TIMESTAMP
      WHERE EXCLUDED.event_timestamp > delegations.event_timestamp
    `;
    
    const params = [
      data.delegator_pubkey,
      data.service_pubkey,
      data.source_relay,
      data.event_timestamp
    ];
    
    await this.query(query, params);
  }

  async insertUserName(data) {
    const query = `
      INSERT INTO user_names (pubkey, name, nip05, lud16, profile_timestamp)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (pubkey) DO UPDATE SET
        name = EXCLUDED.name,
        nip05 = EXCLUDED.nip05,
        lud16 = EXCLUDED.lud16,
        profile_timestamp = EXCLUDED.profile_timestamp,
        last_updated = CURRENT_TIMESTAMP
      WHERE EXCLUDED.profile_timestamp > user_names.profile_timestamp
    `;
    const params = [data.pubkey, data.name, data.nip05, data.lud16, data.profile_timestamp];
    await this.query(query, params);
  }

  async filterNewPubkeys(pubkeys) {
    if (pubkeys.length === 0) {
      return [];
    }
    const placeholders = pubkeys.map((_, i) => `$${i + 1}`).join(',');
    
    // Check both user_names (have profile) and profile_refresh_queue (recently queried)
    // Don't requery if:
    // 1. We have their profile already, OR
    // 2. We queried recently (within last 24 hours) even if they had no profile
    const query = `
      SELECT DISTINCT pubkey FROM (
        SELECT pubkey FROM user_names WHERE pubkey IN (${placeholders})
        UNION
        SELECT pubkey FROM profile_refresh_queue 
        WHERE pubkey IN (${placeholders})
          AND last_query_attempt > NOW() - INTERVAL '24 hours'
      ) AS existing_pubkeys
    `;
    const result = await this.query(query, pubkeys);
    const existingPubkeys = new Set(result.rows.map(row => row.pubkey));
    return pubkeys.filter(p => !existingPubkeys.has(p));
  }
  
  async recordProfileQueryAttempt(pubkeys, profileTimestamps) {
    if (pubkeys.length === 0) return;
    
    // Record that we attempted to fetch these profiles
    // profileTimestamps is a Map of pubkey -> timestamp (or null if not found)
    const values = pubkeys.map((pubkey, i) => {
      const timestamp = profileTimestamps.get(pubkey) || 0;
      return `($${i * 3 + 1}, $${i * 3 + 2}, NOW())`;
    }).join(',');
    
    const params = pubkeys.flatMap(pubkey => {
      const timestamp = profileTimestamps.get(pubkey) || 0;
      return [pubkey, timestamp];
    });
    
    const query = `
      INSERT INTO profile_refresh_queue (pubkey, profile_timestamp, last_query_attempt)
      VALUES ${values}
      ON CONFLICT (pubkey) DO UPDATE SET
        profile_timestamp = GREATEST(profile_refresh_queue.profile_timestamp, EXCLUDED.profile_timestamp),
        last_query_attempt = EXCLUDED.last_query_attempt
    `;
    
    await this.query(query, params);
  }

  async getServicePubkeys() {
    const query = 'SELECT DISTINCT service_pubkey FROM delegations WHERE service_pubkey IS NOT NULL AND service_pubkey != \'\'';
    const result = await this.query(query);
    return result.rows.map(row => row.service_pubkey);
  }

  async getDelegatorForService(servicePubkey) {
    const query = 'SELECT delegator_pubkey FROM delegations WHERE service_pubkey = $1';
    const result = await this.query(query, [servicePubkey]);
    return result.rows.length > 0 ? result.rows[0].delegator_pubkey : null;
  }
}

module.exports = Database;



const { Pool } = require('pg');

class Database {
  constructor() {
    this.pool = null;
    this.isConnected = false;
    this.isShuttingDown = false;
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
      
      // Set up listener for rankings refresh notifications
      await this.setupRankingsRefreshListener();
      
    } catch (error) {
      console.error('Failed to connect to PostgreSQL:', error);
      throw error;
    }
  }
  
  async setupRankingsRefreshListener() {
    try {
      const client = await this.pool.connect();
      await client.query('LISTEN rankings_changed');
      
      let refreshPending = false;
      let refreshTimeout = null;
      
      client.on('notification', async (msg) => {
        if (msg.channel === 'rankings_changed' && !refreshPending) {
          // Debounce: wait 5 seconds after last change before refreshing
          refreshPending = true;
          if (refreshTimeout) clearTimeout(refreshTimeout);
          refreshTimeout = setTimeout(async () => {
            try {
              console.log('[DB] Refreshing precomputed_rankings materialized view...');
              await this.pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY precomputed_rankings');
              console.log('[DB] Materialized view refreshed successfully');
            } catch (err) {
              console.error('[DB] Failed to refresh materialized view:', err.message);
            }
            refreshPending = false;
          }, 5000);
        }
      });
      
      console.log('[DB] Listening for rankings_changed notifications');
    } catch (error) {
      console.error('[DB] Failed to setup rankings refresh listener:', error.message);
    }
  }
  
  async refreshRankings() {
    try {
      console.log('[DB] Manually refreshing precomputed_rankings...');
      await this.pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY precomputed_rankings');
      console.log('[DB] Materialized view refreshed');
    } catch (error) {
      console.error('[DB] Failed to refresh rankings:', error.message);
      throw error;
    }
  }

  async query(text, params) {
    if (!this.isConnected || this.isShuttingDown) {
      return { rows: [], rowCount: 0 }; // Return empty result during shutdown
    }
    
    try {
      const result = await this.pool.query(text, params);
      return result;
    } catch (error) {
      if (this.isShuttingDown) {
        return { rows: [], rowCount: 0 }; // Suppress errors during shutdown
      }
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
    
    // Ensure profile_refresh_queue has new columns
    await this.pool.query(`
      ALTER TABLE profile_refresh_queue 
      ADD COLUMN IF NOT EXISTS last_profile_fetch TIMESTAMP;
    `);
    await this.pool.query(`
      ALTER TABLE profile_refresh_queue 
      ADD COLUMN IF NOT EXISTS last_activity_check TIMESTAMP;
    `);
    
    // Ensure precomputed_rankings materialized view exists
    await this.ensurePrecomputedRankings();
  }
  
  async ensurePrecomputedRankings() {
    // Check if materialized view exists
    const checkResult = await this.pool.query(`
      SELECT EXISTS (
        SELECT FROM pg_matviews WHERE matviewname = 'precomputed_rankings'
      ) as exists
    `);
    
    if (!checkResult.rows[0].exists) {
      console.log('[DB] Creating precomputed_rankings materialized view...');
      
      await this.pool.query(`
        CREATE MATERIALIZED VIEW precomputed_rankings AS
        SELECT 
          ur.ranked_user_pubkey,
          un.name,
          un.nip05,
          un.lud16,
          AVG(ur.rank_value)::INTEGER as rank_value,
          AVG(ur.influence_score) as influence_score,
          AVG(ur.hops)::INTEGER as hops,
          AVG(ur.follower_count)::INTEGER as follower_count,
          COALESCE(MAX(prq.last_activity_timestamp), MAX(un.profile_timestamp)) as last_seen,
          (AVG(ur.influence_score) * LOG(GREATEST(AVG(ur.follower_count), 1) + 1)) as effective_score
        FROM user_rankings ur
        LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
        LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
        GROUP BY ur.ranked_user_pubkey, un.pubkey, un.name, un.nip05, un.lud16
      `);
      
      await this.pool.query(`CREATE UNIQUE INDEX idx_precomputed_pubkey ON precomputed_rankings(ranked_user_pubkey)`);
      await this.pool.query(`CREATE INDEX idx_precomputed_effective_score ON precomputed_rankings(effective_score DESC NULLS LAST)`);
      await this.pool.query(`CREATE INDEX idx_precomputed_name ON precomputed_rankings(name)`);
      await this.pool.query(`CREATE INDEX idx_precomputed_nip05 ON precomputed_rankings(nip05)`);
      await this.pool.query(`CREATE INDEX idx_precomputed_lud16 ON precomputed_rankings(lud16)`);
      
      console.log('[DB] Materialized view created with indexes');
    }
    
    // Ensure trigger function exists
    await this.pool.query(`
      CREATE OR REPLACE FUNCTION trigger_rankings_refresh()
      RETURNS TRIGGER AS $$
      BEGIN
        PERFORM pg_notify('rankings_changed', '');
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    
    // Ensure trigger exists
    await this.pool.query(`
      DROP TRIGGER IF EXISTS rankings_changed_trigger ON user_rankings
    `);
    await this.pool.query(`
      CREATE TRIGGER rankings_changed_trigger
      AFTER INSERT OR UPDATE ON user_rankings
      FOR EACH STATEMENT
      EXECUTE FUNCTION trigger_rankings_refresh()
    `);
    
    console.log('[DB] Precomputed rankings view and triggers ready');
  }

  async disconnect() {
    this.isShuttingDown = true;
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
    // Calculate name affinity: name=2, nip05=1, lud16=1 (max 4 points)
    let nameAffinity = 0;
    if (data.name) nameAffinity += 2;
    if (data.nip05) nameAffinity += 1;
    if (data.lud16) nameAffinity += 1;
    
    // Determine primary name (prefer name field, fallback to nip05, then lud16)
    const primaryName = data.name || data.nip05 || data.lud16 || null;
    
    const query = `
      INSERT INTO user_names (pubkey, name, nip05, lud16, name_affinity, primary_name, profile_timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (pubkey) DO UPDATE SET
        name = EXCLUDED.name,
        nip05 = EXCLUDED.nip05,
        lud16 = EXCLUDED.lud16,
        name_affinity = EXCLUDED.name_affinity,
        primary_name = EXCLUDED.primary_name,
        profile_timestamp = EXCLUDED.profile_timestamp,
        last_updated = CURRENT_TIMESTAMP
      WHERE EXCLUDED.profile_timestamp > user_names.profile_timestamp
    `;
    const params = [data.pubkey, data.name, data.nip05, data.lud16, nameAffinity, primaryName, data.profile_timestamp];
    await this.query(query, params);
  }

  async filterNewPubkeys(pubkeys) {
    if (pubkeys.length === 0) {
      return [];
    }
    
    // Split into chunks to avoid postgres parameter limit (max ~32k parameters)
    const CHUNK_SIZE = 10000;
    const existingPubkeys = new Set();
    
    for (let i = 0; i < pubkeys.length; i += CHUNK_SIZE) {
      const chunk = pubkeys.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
      
      // Skip if we fetched the profile recently (within last 1 day)
      const query = `
        SELECT pubkey FROM profile_refresh_queue
        WHERE pubkey IN (${placeholders})
          AND last_profile_fetch > NOW() - INTERVAL '1 day'
      `;
      const result = await this.query(query, chunk);
      result.rows.forEach(row => existingPubkeys.add(row.pubkey));
    }
    
    return pubkeys.filter(p => !existingPubkeys.has(p));
  }
  
  // Record profile fetch (for kind-0 fetches) - sets profile_timestamp and last_profile_fetch
  async recordProfileTimestamp(pubkeys, profileTimestamps) {
    if (pubkeys.length === 0) return;
    
    const CHUNK_SIZE = 1000;
    const now = new Date();
    
    for (let i = 0; i < pubkeys.length; i += CHUNK_SIZE) {
      const chunk = pubkeys.slice(i, i + CHUNK_SIZE);
      
      const values = chunk.map((pubkey, idx) => {
        return `($${idx * 3 + 1}, $${idx * 3 + 2}, $${idx * 3 + 3})`;
      }).join(',');
      
      const params = chunk.flatMap(pubkey => {
        const profileTs = profileTimestamps.get(pubkey) || 0;
        return [pubkey, profileTs, now];
      });
      
      const query = `
        INSERT INTO profile_refresh_queue (pubkey, profile_timestamp, last_profile_fetch)
        VALUES ${values}
        ON CONFLICT (pubkey) DO UPDATE SET
          profile_timestamp = GREATEST(profile_refresh_queue.profile_timestamp, EXCLUDED.profile_timestamp),
          last_profile_fetch = EXCLUDED.last_profile_fetch
      `;
      
      await this.query(query, params);
    }
  }
  
  // Record activity check results - sets last_activity_timestamp and last_activity_check
  async recordActivityCheck(pubkeys, activityTimestamps) {
    if (pubkeys.length === 0) return;
    
    const CHUNK_SIZE = 500;
    const now = new Date();
    
    for (let i = 0; i < pubkeys.length; i += CHUNK_SIZE) {
      const chunk = pubkeys.slice(i, i + CHUNK_SIZE);
      
      // Split into pubkeys with activity and without
      const withActivity = chunk.filter(p => activityTimestamps.has(p));
      const withoutActivity = chunk.filter(p => !activityTimestamps.has(p));
      
      // Update pubkeys WITH activity (set both last_activity_timestamp and last_activity_check)
      if (withActivity.length > 0) {
        // Use unnest for batch update
        const activityValues = withActivity.map(p => activityTimestamps.get(p));
        await this.query(`
          UPDATE profile_refresh_queue prq
          SET last_activity_timestamp = GREATEST(COALESCE(prq.last_activity_timestamp, 0), v.activity_ts),
              last_activity_check = $3
          FROM (SELECT unnest($1::text[]) as pubkey, unnest($2::bigint[]) as activity_ts) v
          WHERE prq.pubkey = v.pubkey
        `, [withActivity, activityValues, now]);
      }
      
      // Update pubkeys WITHOUT activity (just set last_activity_check)
      if (withoutActivity.length > 0) {
        await this.query(`
          UPDATE profile_refresh_queue
          SET last_activity_check = $2
          WHERE pubkey = ANY($1::text[])
        `, [withoutActivity, now]);
      }
    }
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



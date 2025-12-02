'use strict'

const fastify = require('fastify')
const pino = require('pino')
const stream = require('stream')
const Database = require('./services/database');
const RelayListener = require('./services/relay-listener');

// --- In-memory logger setup ---
const logBuffer = []
const logThroughStream = new stream.PassThrough()

logThroughStream.on('data', (chunk) => {
  if (logBuffer.length >= 100) {
    logBuffer.shift()
  }
  logBuffer.push(chunk.toString())
})

const streams = pino.multistream([
  { stream: process.stdout },
  { stream: logThroughStream }
])

const server = fastify({
  logger: {
    level: 'info',
    stream: streams
  },
  pluginTimeout: 30000
})

// --- Services ---
const database = new Database();
const relayUrls = ['ws://localhost:7777'];
const profileRelayUrls = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://nostrue.com'];
const relayListener = new RelayListener(relayUrls, profileRelayUrls, database, server.log);

// --- Hooks ---
server.addHook('onReady', async () => {
  try {
    await database.connect();
    server.log.info('Database connected successfully');

    if (process.argv.includes('--fresh')) {
      server.log.info('"--fresh" flag detected. Starting fresh backfill...');
    }

    // Do not await this, let it run in the background
    relayListener.start();
  } catch (dbError) {
    server.log.warn('Database connection failed:', dbError.message);
  }
});

server.addHook('onClose', (instance, done) => {
  database.close().then(() => {
    if (relayListener && relayListener.pool) {
      const allRelays = [...relayListener.relayUrls, ...relayListener.profileRelayUrls];
      relayListener.pool.close(allRelays);
    }
    done();
  }).catch(done);
});

// --- Decorate server with database ---
server.decorate('database', database);

// --- Register static file serving ---
server.register(require('@fastify/static'), {
  root: require('path').join(__dirname, 'public'),
  prefix: '/public/',
});

// --- Register routes ---
server.register(require('./routes/web'));

// --- Routes ---
server.get('/stats', async (request, reply) => {
  try {
    server.log.info('Stats endpoint called');
    
    // Ensure database is connected
    if (!database.client) {
      server.log.warn('Database not connected, attempting to connect...');
      await database.connect();
    }
    
    const rankingsResult = await database.query('SELECT COUNT(*) FROM user_rankings;');
    const attestationsEventResult = await database.query('SELECT COUNT(*) FROM attestation_events;');
    const namesResult = await database.query('SELECT COUNT(*) FROM user_names;');
    const delegationsResult = await database.query('SELECT COUNT(*) FROM delegations;');

    const rankingsCount = parseInt(rankingsResult.rows[0].count, 10);
    const attestationEventsCount = parseInt(attestationsEventResult.rows[0].count, 10);
    const namesCount = parseInt(namesResult.rows[0].count, 10);
    const delegationsCount = parseInt(delegationsResult.rows[0].count, 10);

    const stats = {
      user_rankings: rankingsCount,
      attestation_events: attestationEventsCount,
      user_names: namesCount,
      delegations: delegationsCount
    };
    
    server.log.info('Stats result:', stats);
    return stats;
  } catch (error) {
    server.log.error(error, 'Error fetching stats');
    reply.status(500).send({ error: 'Internal Server Error' });
  }
});

server.get('/log', async (request, reply) => {
  reply.header('Content-Type', 'text/plain');
  return logBuffer.join('');
});

server.get('/check-activity', async (request, reply) => {
  try {
    const { pubkey } = request.query;
    if (!pubkey) {
      return reply.status(400).send({ error: 'Missing pubkey parameter (npub or hex)' });
    }

    // Convert npub to hex if needed
    const trimmed = pubkey.trim();
    let hexPubkey;
    
    if (trimmed.toLowerCase().startsWith('npub')) {
      try {
        const { decode } = require('nostr-tools/nip19');
        const decoded = decode(trimmed);
        if (decoded.type !== 'npub') {
          return reply.status(400).send({ error: 'Invalid npub format: decoded type is ' + decoded.type });
        }
        hexPubkey = decoded.data;
        if (!hexPubkey || typeof hexPubkey !== 'string' || hexPubkey.length !== 64) {
          return reply.status(400).send({ error: 'Decoded npub is invalid hex format' });
        }
      } catch (err) {
        return reply.status(400).send({ error: 'Failed to decode npub: ' + err.message });
      }
    } else {
      // Treat as hex pubkey
      if (trimmed.length !== 64 || !/^[0-9a-fA-F]+$/.test(trimmed)) {
        return reply.status(400).send({ error: 'Invalid hex pubkey format (must be 64 hex chars, got length ' + trimmed.length + ')' });
      }
      hexPubkey = trimmed;
    }

    // Query relays for activity (any event kind)
    const activityRelayUrls = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.primal.net', 'wss://relay.nostr.band'];
    const { SimplePool, useWebSocketImplementation } = require('nostr-tools/pool');
    const WebSocket = require('ws');
    useWebSocketImplementation(WebSocket);
    
    const pool = new SimplePool();
    const activityFilter = { authors: [hexPubkey], limit: 100 };
    
    const events = await pool.querySync(activityRelayUrls, activityFilter);
    pool.close(activityRelayUrls);

    // Find most recent event
    let latestEvent = null;
    if (events.length > 0) {
      latestEvent = events.reduce((latest, event) => 
        event.created_at > latest.created_at ? event : latest
      );
    }

    // Update database with activity if we found any
    if (latestEvent) {
      const activityMap = new Map();
      activityMap.set(hexPubkey, latestEvent.created_at);
      await database.recordActivityCheck([hexPubkey], activityMap);
    } else {
      // No activity found - still update last_activity_check timestamp
      await database.recordActivityCheck([hexPubkey], new Map());
    }

    // Get profile info from DB (after update so we see the new values)
    const profileResult = await database.query(`
      SELECT 
        un.name,
        un.nip05,
        un.lud16,
        prq.last_activity_timestamp,
        prq.profile_timestamp,
        prq.last_activity_check,
        prq.last_profile_fetch
      FROM user_names un
      LEFT JOIN profile_refresh_queue prq ON un.pubkey = prq.pubkey
      WHERE un.pubkey = $1
    `, [hexPubkey]);

    const profile = profileResult.rows[0] || null;

    return {
      pubkey: hexPubkey,
      latest_event: latestEvent ? {
        id: latestEvent.id,
        kind: latestEvent.kind,
        created_at: latestEvent.created_at,
        created_at_iso: new Date(latestEvent.created_at * 1000).toISOString(),
        days_ago: Math.floor((Date.now() / 1000 - latestEvent.created_at) / 86400)
      } : null,
      total_events_found: events.length,
      profile: profile ? {
        name: profile.name,
        nip05: profile.nip05,
        lud16: profile.lud16,
        last_activity_timestamp: profile.last_activity_timestamp,
        profile_timestamp: profile.profile_timestamp,
        last_activity_check: profile.last_activity_check,
        last_profile_fetch: profile.last_profile_fetch
      } : null
    };
  } catch (error) {
    server.log.error(error, 'Error checking activity');
    return reply.status(500).send({ error: 'Internal Server Error: ' + error.message });
  }
});


// --- Start and Shutdown ---
const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await server.listen({ port })
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

let isShuttingDown = false;

const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('\nShutting down...');
  
  // Force exit after 5 seconds (querySync default timeout is 4s)
  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
  
  // Stop accepting new work
  if (relayListener) {
    relayListener.close();
  }
  
  // Close database
  try {
    await database.disconnect();
  } catch (e) {
    // Ignore errors during shutdown
  }
  
  try {
    await server.close();
  } catch (e) {
    // Ignore
  }
  
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the process alive indefinitely, but don't block exit
const keepAliveInterval = setInterval(() => {}, 1 << 30);
process.on('exit', () => clearInterval(keepAliveInterval));

start()

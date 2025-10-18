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


// --- Start and Shutdown ---
const start = async () => {
  try {
    await server.listen({ port: 3000 })
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

let isShuttingDown = false;

const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('\nShutting down gracefully...');
  
  // Stop accepting new work
  if (relayListener) {
    relayListener.close();
  }
  
  // Give ongoing operations time to complete
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  await server.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the process alive indefinitely, but don't block exit
const keepAliveInterval = setInterval(() => {}, 1 << 30);
process.on('exit', () => clearInterval(keepAliveInterval));

start()

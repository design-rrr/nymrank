'use strict'

module.exports = async function (fastify, opts) {
  fastify.get('/healthz', async function (request, reply) {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {}
    }

    // Check database health
    try {
      if (fastify.database.isConnected) {
        health.services.database = await fastify.database.healthCheck()
      } else {
        health.services.database = {
          status: 'disconnected',
          message: 'Database not connected'
        }
      }
    } catch (error) {
      health.services.database = {
        status: 'unhealthy',
        error: error.message
      }
    }

    // Check relay health
    health.services.relay = {
      status: fastify.relayListener.isConnected ? 'subscribed' : 'disconnected',
      urls: fastify.relayListener.relayUrls
    };

    // Overall health status
    const allHealthy = Object.values(health.services).every(
      service => service.status === 'healthy' || service.status === 'subscribed' || service.status === 'disconnected' // db can be disconnected
    );
    
    health.status = allHealthy ? 'ok' : 'degraded';

    return reply.code(allHealthy ? 200 : 503).send(health)
  })
}

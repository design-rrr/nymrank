'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const Fastify = require('fastify')
const apiRoutes = require('../../routes/api')

async function buildApiApp (overrides = {}) {
  const app = Fastify()
  app.decorate('database', {
    query: overrides.query || (async () => ({ rows: [] }))
  })
  app.register(apiRoutes)
  await app.ready()
  return app
}

test('GET /api/names/:name returns available when no occupant', async (t) => {
  const app = await buildApiApp()
  t.after(() => app.close())

  const res = await app.inject({
    method: 'GET',
    url: '/api/names/alice'
  })

  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.payload)
  assert.equal(body.name, 'alice')
  assert.equal(body.available, true)
  assert.equal(body.occupant, null)
})

test('GET /api/users/:pubkey/rank validates pubkey', async (t) => {
  const app = await buildApiApp()
  t.after(() => app.close())
  const res = await app.inject({
    method: 'GET',
    url: '/api/users/not-a-pubkey/rank'
  })

  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.payload)
  assert.equal(body.error.code, 'invalid_pubkey')
})

test('GET /api/users/:pubkey/activity validates pubkey', async (t) => {
  const app = await buildApiApp()
  t.after(() => app.close())
  const res = await app.inject({
    method: 'GET',
    url: '/api/users/not-a-pubkey/activity'
  })

  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.payload)
  assert.equal(body.error.code, 'invalid_pubkey')
})

test('GET /api/status returns ok when db query succeeds', async (t) => {
  const app = await buildApiApp({
    query: async () => ({ rows: [{ '?column?': 1 }] })
  })
  t.after(() => app.close())

  const res = await app.inject({
    method: 'GET',
    url: '/api/status'
  })

  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.payload)
  assert.equal(body.ok, true)
  assert.equal(body.service, 'nymrank-api')
})

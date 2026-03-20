'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const Fastify = require('fastify')
const apiRoutes = require('../../routes/api')

test('example is loaded', async (t) => {
  const app = Fastify()
  app.decorate('database', {
    query: async () => ({ rows: [{ '?column?': 1 }] })
  })
  app.register(apiRoutes)
  await app.ready()
  t.after(() => app.close())

  const res = await app.inject({
    url: '/api/status'
  })
  assert.ok([200, 503].includes(res.statusCode))
})

// inject callback style:
//
// test('example is loaded', (t) => {
//   t.plan(2)
//   const app = await build(t)
//
//   app.inject({
//     url: '/example'
//   }, (err, res) => {
//     t.error(err)
//     assert.equal(res.payload, 'this is an example')
//   })
// })

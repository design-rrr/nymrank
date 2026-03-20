'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const Fastify = require('fastify')
const path = require('node:path')

test('default root route', async (t) => {
  const app = Fastify()
  app.register(require('@fastify/static'), {
    root: path.join(__dirname, '..', '..', 'public'),
    prefix: '/public/'
  })
  app.get('/api-docs', async (request, reply) => reply.sendFile('api-docs.html'))
  await app.ready()
  t.after(() => app.close())

  const res = await app.inject({
    url: '/api-docs'
  })
  assert.equal(res.statusCode, 200)
  assert.match(res.payload, /NymRank API/)
})

// inject callback style:
//
// test('default root route', (t) => {
//   t.plan(2)
//   const app = await build(t)
//
//   app.inject({
//     url: '/'
//   }, (err, res) => {
//     t.error(err)
//     assert.deepStrictEqual(JSON.parse(res.payload), { root: true })
//   })
// })

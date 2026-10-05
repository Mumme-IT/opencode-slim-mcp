import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { withoutRedirects } from '../../src/cli/endpoint.js'

test('endpoint redirects cannot forward a capability or MCP arguments to another destination', async () => {
  let forwarded = false
  const destination = createServer((_request, response) => { forwarded = true; response.end('unexpected') })
  const redirect = createServer((_request, response) => {
    const address = destination.address()
    if (!address || typeof address === 'string') throw new Error('Missing destination port')
    response.writeHead(307, { location: `http://127.0.0.1:${address.port}` }).end()
  })
  try {
    await new Promise<void>(done => destination.listen(0, '127.0.0.1', done))
    await new Promise<void>(done => redirect.listen(0, '127.0.0.1', done))
    const address = redirect.address()
    if (!address || typeof address === 'string') throw new Error('Missing redirect port')
    await assert.rejects(withoutRedirects(`http://127.0.0.1:${address.port}`, { method: 'POST', body: '{"capability":"secret","arguments":{"value":3}}' }))
    assert.equal(forwarded, false)
  } finally {
    await Promise.all([destination, redirect].map(server => new Promise<void>(done => server.close(() => done()))))
  }
})

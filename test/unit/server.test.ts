import assert from 'node:assert/strict'
import { test } from 'node:test'
import plugin from '../../src/server/index.js'

test('the package provides only the native V2 lifecycle', () => {
  assert.equal(plugin.id, 'slim-mcp')
  assert.equal(typeof plugin.setup, 'function')
  assert.equal('server' in plugin, false)
})

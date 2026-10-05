import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Info, ToolEditor } from '@opencode/plugin/promise/tool'
import { Mapping } from '../../src/server/mapping.js'

// This adapter exercises the public registry editor, not the native registry internals.
function catalog(input: Info['input']): { mapping: Mapping; entry: Info & { id: string }; removed: string[]; editor: ToolEditor } {
  const mapping = new Mapping(['fixture'])
  mapping.configure([['fixture', { type: 'local', command: ['fixture'] }]])
  const entry = { id: 'fixture_echo', name: 'echo', description: 'Echo', input, options: { namespace: 'fixture' }, execute: async () => ({ content: 'ok' }) }
  const removed: string[] = []
  const editor: ToolEditor = { list: () => [entry], get: () => entry, remove: id => { removed.push(id) }, add: () => {}, update: () => {}, namespace: () => {} }
  mapping.capture(editor)
  return { mapping, entry, removed, editor }
}

test('mapped tools disappear from the registry and reject invalid nested arguments', () => {
  const { mapping, entry, removed } = catalog({ type: 'object', properties: { nested: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }, required: ['nested'], additionalProperties: false })
  assert.deepEqual(removed, ['fixture_echo'])
  mapping.validate(entry, { nested: { count: 3 } })
  assert.throws(() => mapping.validate(entry, { nested: { count: '3' } }), /invalid_arguments/)
  assert.throws(() => mapping.validate(entry, { nested: { count: 3 }, extra: true }), /invalid_arguments/)
})

test('JSON Schema formats and newer dialects do not silently weaken validation', () => {
  const { mapping, entry } = catalog({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { email: { type: 'string', format: 'email' } }, required: ['email'], additionalProperties: false })
  mapping.validate(entry, { email: 'user@example.com' })
  assert.throws(() => mapping.validate(entry, { email: 'not-an-email' }), /invalid_arguments/)
  const unsupported = catalog({ type: 'object', properties: { value: { type: 'string', format: 'custom-unknown-format' } } })
  assert.throws(() => unsupported.mapping.validate(unsupported.entry, { value: 'anything' }), /unsupported_schema/)
})

test('configuration changes revoke old catalogs and normalized MCP namespace collisions fail closed', () => {
  const { mapping, removed, editor } = catalog({ type: 'object' })
  const version = mapping.version
  const pending = mapping.signal
  mapping.configure([['fixture', { type: 'local', command: ['different-account'] }]])
  assert.equal(pending.aborted, true)
  assert.equal(mapping.signal.aborted, false)
  assert.notEqual(mapping.version, version)
  assert.throws(() => mapping.get('fixture', 'echo'), /tool_not_ready/)
  mapping.configure([])
  mapping.capture(editor)
  assert.deepEqual(removed, ['fixture_echo', 'fixture_echo'], 'Cached selected definitions must remain hidden after configuration removal')
  assert.throws(() => mapping.get('fixture', 'echo'), /tool_not_ready/)
  assert.throws(() => new Mapping(['a.b', 'a_b']), /namespace_collision/)
  const selected = new Mapping(['a.b'])
  assert.throws(() => selected.configure([['a.b', {}], ['a_b', {}]]), /namespace_collision/)
})

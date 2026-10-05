import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArguments, parseJson } from '../../src/cli/arguments.js'

test('CLI accepts nested JSON without converting numbers or accepting ambiguous input sources', () => {
  assert.deepEqual(parseJson('{"items":[{"count":3,"active":false}],"optional":null}'), { items: [{ count: 3, active: false }], optional: null })
  assert.equal(parseArguments(['call', 'fixture', 'echo', '--stdin']).stdin, true)
  assert.throws(() => parseArguments(['call', 'fixture', 'echo', '--stdin', '--json', '{}']))
  assert.throws(() => parseArguments(['list', 'fixture', '--json', '{}']))
  assert.throws(() => parseJson('[]'))
  assert.throws(() => parseJson('null'))
  assert.throws(() => parseJson('not JSON'))
  assert.throws(() => parseJson(JSON.stringify({ text: 'x'.repeat(1_048_576) })))
})

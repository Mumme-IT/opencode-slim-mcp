import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises'
import { boundedResult } from '../../src/server/result.js'

test('typed results remain intact and large results use private artifacts instead of flooding stdout', async () => {
  await mkdir('/tmp/opencode', { recursive: true })
  process.env.XDG_STATE_HOME = await mkdtemp('/tmp/opencode/slim-mcp-result-')
  const result = { content: [{ type: 'text', text: 'small' }], metadata: { nested: true } }
  assert.deepEqual(await boundedResult(result, '/tmp/opencode/result-test'), { completed: true, result })
  const media = { content: [{ type: 'file', uri: 'data:image/png;base64,aGVsbG8=', mime: 'image/png' }] }
  const mediaWritten = await boundedResult(media, '/tmp/opencode/result-test') as { artifact: { path: string } }
  assert.ok(mediaWritten.artifact, 'Media must use an artifact even when its encoded result is small')
  assert.deepEqual(JSON.parse(await readFile(mediaWritten.artifact.path, 'utf8')), media)
  const large = { content: [{ type: 'text', text: 'x'.repeat(70_000) }] }
  const written = await boundedResult(large, '/tmp/opencode/result-test') as { artifact: { path: string } }
  assert.deepEqual(JSON.parse(await readFile(written.artifact.path, 'utf8')), large)
  assert.equal((await stat(written.artifact.path)).mode & 0o777, 0o600)
  await assert.rejects(boundedResult({ text: 'x'.repeat(16_777_216) }, '/tmp/opencode/result-test'), /result_too_large/)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Invocations } from '../../src/server/invocation.js'
import type { ToolContext } from '@opencode/plugin/promise/tool'

const context = (session: string) => ({ sessionID: session, agent: 'build', messageID: 'message', id: 'call', signal: new AbortController().signal, progress: async () => {} }) as unknown as ToolContext

test('a shell capability binds the real context, rejects replay, and expires at shell completion', async () => {
  const invocations = new Invocations()
  let capability = ''
  await invocations.shell('echo nested', context('session-a'), async marked => {
    const prepared = invocations.prepare(marked)!
    assert.equal(prepared.command, 'echo nested')
    capability = prepared.capability
    const bound = invocations.resolve(capability, 'request-1', new AbortController().signal)
    assert.equal(bound.sessionID, 'session-a')
    assert.throws(() => invocations.resolve(capability, 'request-1', new AbortController().signal), /replayed_request/)
    assert.throws(() => invocations.prepare(marked), /invalid_invocation/)
  })
  assert.throws(() => invocations.resolve(capability, 'request-2', new AbortController().signal), /invalid_invocation/)
})

test('concurrent shells do not share identity and unload cancels active calls', async () => {
  const invocations = new Invocations()
  const signals: AbortSignal[] = []
  await Promise.all(['session-a', 'session-b'].map(session => invocations.shell('echo test', context(session), async marked => {
    const prepared = invocations.prepare(marked)!
    const bound = invocations.resolve(prepared.capability, 'request', new AbortController().signal)
    assert.equal(bound.sessionID, session)
    signals.push(bound.signal)
    await Promise.resolve()
    if (signals.length === 2) invocations.close()
  })))
  assert.equal(signals.length, 2)
  assert.ok(signals.every(signal => signal.aborted))
  await assert.rejects(invocations.shell('echo later', context('session-c'), async () => {
    assert.fail('Closed authority must never execute another shell')
  }), /plugin_unavailable/)
})

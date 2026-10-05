import { test, expect } from 'bun:test'
import { OpenCode } from '@opencode/client'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'

test('the installed native server binds CLI calls to real shell context and preserves MCP permissions', async () => {
  const binary = process.env.OPENCODE_TEST_BINARY ?? resolve('node_modules/@opencode/cli-linux-x64/bin/opencode')
  expect(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()).toMatch(/^(?:opencode v)?2\.0\.23$/)
  mkdirSync('/tmp/opencode', { recursive: true })
  const root = mkdtempSync('/tmp/opencode/slim-mcp-integration-')
  const project = `${root}/project`
  const home = `${root}/home`
  mkdirSync(project)
  mkdirSync(home)
  // Exercise the published files and bin, not an accidental workspace-only entrypoint.
  // npm 11 returns an array; npm 12 keys the same report by package name.
  const report = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { encoding: 'utf8' })) as Array<{ filename: string }> | Record<string, { filename: string }>
  const packed = Array.isArray(report) ? report : Object.values(report)
  if (packed.length !== 1 || !packed[0]?.filename) throw new Error('npm pack must report exactly one package tarball')
  execFileSync('npm', ['install', '--prefix', `${root}/installed`, `${root}/${packed[0].filename}`, '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'pipe' })
  const installed = `${root}/installed/node_modules/opencode-slim-mcp`
  const requests: unknown[] = []
  const model = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const body = await request.json() as { messages: Array<{ role: string; content: string }>; tools?: unknown[] }
      requests.push(body)
      const executed = body.messages.some(message => message.role === 'tool')
      const command = body.messages.find(message => message.role === 'user')?.content ?? ''
      const delta = executed ? { content: 'Done.' } : { tool_calls: [{ index: 0, id: 'fixture-shell-call', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command }) } }] }
      return new Response([
        { id: 'probe', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
        { id: 'probe', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta: {}, finish_reason: executed ? 'stop' : 'tool_calls' }] },
      ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const port = await new Promise<number>(done => {
    const socket = createServer()
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address()
      if (!address || typeof address === 'string') throw new Error('Missing ephemeral port')
      socket.close(() => done(address.port))
    })
  })
  const endpoint = `http://127.0.0.1:${port}`
  writeFileSync(`${project}/opencode.json`, JSON.stringify({
    model: 'probe/probe',
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    agents: { title: { disabled: true }, restricted: { mode: 'primary', permissions: [{ action: 'fixture_echo', resource: '*', effect: 'deny' }] } },
    mcp: { servers: { fixture: { type: 'local', command: [process.execPath, resolve('test/fixtures/mcp.ts')], environment: { FIXTURE_LOG: `${root}/calls.jsonl`, FIXTURE_CANCEL_LOG: `${root}/cancel.jsonl` } }, untouched: { type: 'local', command: [process.execPath, resolve('test/fixtures/mcp.ts')] } } },
    plugins: [{ package: resolve('test/fixtures'), options: { baseURL: `http://127.0.0.1:${model.port}/v1`, passwordFile: `${root}/stdout.log` } }, { package: installed, options: { servers: ['fixture'], exclusiveNamespaces: true, endpoint } }],
  }))
  const child = Bun.spawn([binary, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: project,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: `${home}/config`, XDG_STATE_HOME: `${home}/state`, XDG_DATA_HOME: `${home}/data`, XDG_CACHE_HOME: `${home}/cache`, OPENCODE_CONFIG: `${project}/opencode.json`, OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_SERVER_PASSWORD: '', OPENCODE_SERVER_USERNAME: '', OPENCODE_LOG_LEVEL: 'DEBUG' },
    stdout: Bun.file(`${root}/stdout.log`), stderr: Bun.file(`${root}/stderr.log`),
  })
  try {
    let password = ''
    for (let attempt = 0; !password; attempt++) {
      try { password = /server password (\S+)/.exec(readFileSync(`${root}/stdout.log`, 'utf8'))?.[1] ?? '' } catch { /* Startup has not created the file yet. */ }
      if (attempt > 300) throw new Error('Native server did not print a password')
      if (!password) await Bun.sleep(50)
    }
    const client = OpenCode.make({ baseUrl: endpoint, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } })
    for (let attempt = 0; ; attempt++) {
      try { await client.server.info(); break } catch {
        if (attempt > 300) throw new Error(`Native server did not start: ${readFileSync(`${root}/stderr.log`, 'utf8')}`)
        await Bun.sleep(50)
      }
    }
    const location = { directory: project }
    for (let attempt = 0; ; attempt++) {
      const status = await client.mcp.list({ location })
      if (status.data.find(server => server.name === 'fixture')?.status.status === 'connected') break
      if (attempt > 200) throw new Error('Fixture MCP did not connect')
      await Bun.sleep(50)
    }
    const cli = `node ${JSON.stringify(`${root}/installed/node_modules/.bin/slim-mcp`)}`
    const run = async (command: string, permissions?: Array<{ action: string; resource: string; effect: 'deny' | 'ask' }>, reply?: 'once' | 'always' | 'reject', selectedLocation = location, agent = 'build') => {
      const session = await client.session.create({ title: 'CLI fixture', model: { providerID: 'probe', id: 'probe' }, location: selectedLocation, permissions, agent })
      await client.session.prompt({ sessionID: session.id, text: command })
      if (reply) {
        let found = false
        for (let attempt = 0; attempt < 300; attempt++) {
          const pending = await client.permission.list({ sessionID: session.id })
          if (pending.length) {
            await client.permission.reply({ sessionID: session.id, requestID: pending[0]!.id, decision: reply })
            found = true
            break
          }
          await Bun.sleep(20)
        }
        expect(found).toBe(true)
      }
      await client.session.wait({ sessionID: session.id })
      return JSON.stringify(await client.session.context({ sessionID: session.id }))
    }
    const success = await run(`${cli} call fixture echo --json '{"value":{"count":3}}'`)
    writeFileSync(`${root}/context.json`, success)
    expect(success).toContain('completed')
    expect(readFileSync(`${root}/calls.jsonl`, 'utf8')).toContain('"count":3')
    expect(JSON.stringify(requests)).not.toContain('tools[\\"fixture\\"]')
    expect(JSON.stringify(requests)).toContain('tools[\\"untouched\\"]')
    expect(JSON.stringify(requests)).toContain('Keep this project instruction.')
    expect(JSON.stringify(requests)).not.toContain('Native delta instructions.')
    const before = readFileSync(`${root}/calls.jsonl`, 'utf8')
    const denied = await run(`${cli} call fixture echo --json '{"value":{"count":4}}'`, [{ action: 'fixture_echo', resource: '*', effect: 'deny' }])
    expect(denied).toContain('Exited with code 4')
    expect(readFileSync(`${root}/calls.jsonl`, 'utf8')).toBe(before)
    const skillDenied = await run(`${cli} list fixture`, [{ action: 'skill', resource: '*', effect: 'deny' }])
    expect(skillDenied).toContain('Exited with code 4')
    expect(skillDenied).not.toContain('Run echo through')
    const ask = await run(`${cli} call fixture echo --stdin <<'JSON'\n{"value":{"count":5}}\nJSON`, [{ action: 'fixture_echo', resource: '*', effect: 'ask' }], 'once')
    expect(ask).toContain('completed')
    expect(readFileSync(`${root}/calls.jsonl`, 'utf8')).toContain('"count":5')
    const deniedBefore = readFileSync(`${root}/calls.jsonl`, 'utf8')
    const rejected = await run(`${cli} call fixture echo --json '{"value":{"count":6}}'`, [{ action: 'fixture_echo', resource: '*', effect: 'ask' }], 'reject')
    expect(rejected).toContain('Exited with code 4')
    expect(readFileSync(`${root}/calls.jsonl`, 'utf8')).toBe(deniedBefore)
    const failed = await run(`${cli} call fixture fail --json '{"value":{"count":7}}'`)
    expect(failed).toContain('Exited with code 4')
    expect(failed).not.toContain('\\"completed\\":true')
    const large = await run(`${cli} call fixture large --json '{"value":{"count":8}}'`)
    expect(large).toContain('artifact')
    expect(large.length).toBeLessThan(50_000)
    const noAuthority = await run(`env -u SLIM_MCP_CAPABILITY ${cli} list fixture`)
    expect(noAuthority).toContain('invocation_required')
    // A native stop interrupts the genuine tool context and the associated RPC/MCP call.
    const interrupted = await client.session.create({ title: 'Cancellation fixture', model: { providerID: 'probe', id: 'probe' }, location })
    await client.session.prompt({ sessionID: interrupted.id, text: `${cli} call fixture slow --json '{"value":{"count":9}}'` })
    for (let attempt = 0; !readFileSync(`${root}/calls.jsonl`, 'utf8').includes('"count":9'); attempt++) {
      if (attempt > 300) throw new Error('Slow MCP call did not start')
      await Bun.sleep(20)
    }
    await client.session.interrupt({ sessionID: interrupted.id, resume: false })
    await client.session.wait({ sessionID: interrupted.id })
    expect(JSON.stringify(await client.session.context({ sessionID: interrupted.id }))).not.toContain('\\"completed\\":true')
    for (let attempt = 0; ; attempt++) {
      try { expect(readFileSync(`${root}/cancel.jsonl`, 'utf8')).toContain('notifications/cancelled'); break } catch {
        if (attempt > 200) throw new Error('Native MCP cancellation did not reach the fixture')
        await Bun.sleep(20)
      }
    }
    const invalidBefore = readFileSync(`${root}/calls.jsonl`, 'utf8')
    const invalid = await run(`${cli} call fixture echo --json '{"value":{"count":"wrong"}}'`)
    expect(invalid).toContain('invalid_arguments')
    expect(readFileSync(`${root}/calls.jsonl`, 'utf8')).toBe(invalidBefore)
    await client.mcp.disconnect({ server: 'fixture', location })
    const disconnectedBefore = readFileSync(`${root}/calls.jsonl`, 'utf8')
    const disconnected = await run(`${cli} call fixture echo --json '{"value":{"count":10}}'`)
    expect(disconnected).toContain('Exited with code 4')
    expect(readFileSync(`${root}/calls.jsonl`, 'utf8')).toBe(disconnectedBefore)
    await client.mcp.connect({ server: 'fixture', location })
    const reconnected = await run(`${cli} call fixture echo --json '{"value":{"count":11}}'`)
    expect(reconnected).toContain('completed')
    expect(readFileSync(`${root}/calls.jsonl`, 'utf8')).toContain('"count":11')
    const secondProject = `${root}/second-project`
    mkdirSync(secondProject)
    const secondConfig = JSON.parse(readFileSync(`${project}/opencode.json`, 'utf8'))
    secondConfig.mcp.servers.fixture.environment.FIXTURE_LOG = `${root}/second-calls.jsonl`
    writeFileSync(`${secondProject}/opencode.json`, JSON.stringify(secondConfig))
    const crossLocation = await run(`SLIM_MCP_DIRECTORY=${JSON.stringify(secondProject)} ${cli} list fixture`)
    expect(crossLocation).toContain('invalid_invocation')
    const firstLocationBefore = readFileSync(`${root}/calls.jsonl`, 'utf8')
    const second = await run(`${cli} call fixture echo --json '{"value":{"count":12}}'`, undefined, undefined, { directory: secondProject })
    expect(second).toContain('completed')
    expect(readFileSync(`${root}/second-calls.jsonl`, 'utf8')).toContain('"count":12')
    expect(readFileSync(`${root}/calls.jsonl`, 'utf8')).toBe(firstLocationBefore)
    const agentDenied = await run(`${cli} call fixture echo --json '{"value":{"count":14}}'`, undefined, undefined, location, 'restricted')
    expect(agentDenied).toContain('Exited with code 4')
    expect(readFileSync(`${root}/calls.jsonl`, 'utf8')).toBe(firstLocationBefore)
    // Replacing the native account/configuration while approval is pending must revoke the admitted call.
    const pending = await client.session.create({ title: 'Replacement fixture', model: { providerID: 'probe', id: 'probe' }, location, permissions: [{ action: 'fixture_echo', resource: '*', effect: 'ask' }] })
    await client.session.prompt({ sessionID: pending.id, text: `${cli} call fixture echo --json '{"value":{"count":13}}'` })
    let approval: Awaited<ReturnType<typeof client.permission.list>>[number] | undefined
    for (let attempt = 0; !approval; attempt++) {
      approval = (await client.permission.list({ sessionID: pending.id }))[0]
      if (attempt > 300) throw new Error('Replacement fixture did not reach permission waiting')
      if (!approval) await Bun.sleep(20)
    }
    const replacement = JSON.parse(readFileSync(`${project}/opencode.json`, 'utf8'))
    replacement.mcp.servers.fixture.environment.FIXTURE_LOG = `${root}/replacement-calls.jsonl`
    writeFileSync(`${project}/opencode.json`, JSON.stringify(replacement))
    await client.location.reload()
    const remaining = await client.permission.list({ sessionID: pending.id })
    if (remaining.some(item => item.id === approval!.id)) await client.permission.reply({ sessionID: pending.id, requestID: approval.id, decision: 'once' })
    await client.session.wait({ sessionID: pending.id })
    expect(JSON.stringify(await client.session.context({ sessionID: pending.id }))).not.toContain('\\"completed\\":true')
    expect(readFileSync(`${root}/calls.jsonl`, 'utf8')).not.toContain('"count":13')
    if (existsSync(`${root}/replacement-calls.jsonl`)) expect(readFileSync(`${root}/replacement-calls.jsonl`, 'utf8')).not.toContain('"count":13')
    const saved = await run(`${cli} call fixture echo --json '{"value":{"count":15}}'; ${cli} call fixture echo --json '{"value":{"count":16}}'`, [{ action: 'fixture_echo', resource: '*', effect: 'ask' }], 'always')
    expect(saved).toContain('completed')
    expect(readFileSync(`${root}/replacement-calls.jsonl`, 'utf8')).toContain('"count":15')
    expect(readFileSync(`${root}/replacement-calls.jsonl`, 'utf8')).toContain('"count":16')
  } finally {
    child.kill()
    await child.exited
    model.stop(true)
  }
}, 60_000)

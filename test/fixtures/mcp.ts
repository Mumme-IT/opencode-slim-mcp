import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'

const schema = { type: 'object', properties: { value: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }, required: ['value'], additionalProperties: false }
const timers = new Map<number, ReturnType<typeof setTimeout>>()
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.method === 'notifications/cancelled') {
    if (process.env.FIXTURE_CANCEL_LOG) appendFileSync(process.env.FIXTURE_CANCEL_LOG, JSON.stringify(request) + '\n')
    const timer = timers.get(request.params.requestId)
    if (timer) clearTimeout(timer)
    timers.delete(request.params.requestId)
  }
  if (request.id === undefined) continue
  let result: unknown = {}
  if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1' }, instructions: 'Use this fixture namespace to echo nested JSON.' }
   if (request.method === 'tools/list') result = { tools: ['echo', 'fail', 'slow', 'large'].map(name => ({ name, description: `Run ${name} through the native MCP connection.`, inputSchema: schema })) }
  if (request.method === 'tools/call') {
    if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(request.params) + '\n')
     if (request.params.name === 'slow') {
       timers.set(request.id, setTimeout(() => {
         timers.delete(request.id)
         process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'Slow result' }] } }) + '\n')
       }, 30_000))
       continue
     }
     result = request.params.name === 'fail' ? { isError: true, content: [{ type: 'text', text: 'Fixture failure' }] } : { content: [{ type: 'text', text: request.params.name === 'large' ? 'x'.repeat(100_000) : JSON.stringify(request.params) }], structuredContent: { value: request.params.arguments.value } }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}

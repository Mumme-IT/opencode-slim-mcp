#!/usr/bin/env node
import { OpenCode } from '@opencode/client'
import { Service } from '@opencode/client/service'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { SlimMcp } from '../rpc.js'
import { parseArguments, parseJson } from './arguments.js'
import { withoutRedirects } from './endpoint.js'

const help = `Usage: slim-mcp status | list <server> | schema <server> <tool>
       slim-mcp call <server> <tool> (--json '<object>' | --stdin)
Options: --url <OpenCode URL> --directory <Location directory>
Run inside a foreground OpenCode shell tool. Native MCP permissions still apply.`

async function main(): Promise<void> {
  if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
    console.log(help)
    return
  }
  let args
  let input: Record<string, unknown> | undefined
  try {
    args = parseArguments(process.argv.slice(2))
    if (args.command === 'call') {
      let text = args.json ?? ''
      if (args.stdin) {
        process.stdin.setEncoding('utf8')
        for await (const chunk of process.stdin) {
          text += chunk.toString()
          if (Buffer.byteLength(text) > 1_048_576) throw new Error('JSON arguments exceed 1 MiB')
        }
      }
      input = parseJson(text)
    }
  } catch {
    console.error(JSON.stringify({ error: 'invalid_arguments', help }))
    process.exitCode = 2
    return
  }
  const capability = process.env.SLIM_MCP_CAPABILITY
  if (!capability) {
    console.error(JSON.stringify({ error: 'invocation_required', message: 'Use the foreground OpenCode shell tool, not an external terminal.' }))
    process.exitCode = 4
    return
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    const explicit = args.url ?? process.env.SLIM_MCP_URL
    const endpoint = explicit ? { url: explicit, auth: undefined } : await Service.discover()
    if (!endpoint) throw new Error('service_unavailable')
    const url = new URL(endpoint.url)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('insecure_endpoint')
    if (url.username || url.password || url.search || url.hash) throw new Error('invalid_endpoint')
    const headers = process.env.SLIM_MCP_HEADERS ? parseJson(process.env.SLIM_MCP_HEADERS) as Record<string, string> : Service.headers(endpoint)
    if (headers && Object.values(headers).some(value => typeof value !== 'string')) throw new Error('invalid_headers')
    const client = OpenCode.make({ baseUrl: endpoint.url, headers, fetch: withoutRedirects })
    const rpc = client.rpc(SlimMcp)
    const request = () => ({ capability, requestID: randomUUID() })
    const options = {
      location: { directory: resolve(args.directory ?? process.env.SLIM_MCP_DIRECTORY ?? process.cwd()), ...(process.env.SLIM_MCP_WORKSPACE_ID ? { workspaceID: process.env.SLIM_MCP_WORKSPACE_ID } : {}) },
      signal: controller.signal,
    }
    let result: unknown
    if (args.command === 'status') result = await rpc.status(request(), options)
    else if (args.command === 'list') result = await rpc.catalog({ ...request(), server: args.server! }, options)
    else if (args.command === 'schema') result = await rpc.schema({ ...request(), server: args.server!, tool: args.tool! }, options)
    else {
      const schema = await rpc.schema({ ...request(), server: args.server!, tool: args.tool! }, options) as { version: string }
      result = await rpc.call({ ...request(), server: args.server!, tool: args.tool!, version: schema.version, arguments: input! }, options)
    }
    console.log(JSON.stringify(result))
  } catch (error) {
    const rejected = error as { type?: string; data?: { code?: string } }
    console.error(JSON.stringify({ error: controller.signal.aborted ? 'cancelled' : rejected.data?.code ?? 'service_or_rpc_error', message: args.command === 'call' ? 'Call did not return successfully. Do not automatically retry mutations.' : 'Discovery failed.' }))
    process.exitCode = controller.signal.aborted ? 6 : rejected.type === 'rejected' ? 4 : 3
  } finally {
    EventEmitter.prototype.removeListener.call(process, 'SIGINT', abort)
    EventEmitter.prototype.removeListener.call(process, 'SIGTERM', abort)
  }
}

await main()

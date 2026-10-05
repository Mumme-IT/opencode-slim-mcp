import { Plugin } from '@opencode/plugin'
import type { ToolContext } from '@opencode/plugin/promise/tool'
import { SlimMcp } from '../rpc.js'
import { Invocations, Rejected } from './invocation.js'
import { Mapping } from './mapping.js'
import { skill, skillID } from './skills.js'
import { boundedResult } from './result.js'

interface Request {
  capability: string
  requestID: string
  server: string
  tool: string
  version: string
  arguments: Record<string, unknown>
}

export default Plugin.define({
  id: 'slim-mcp',
  async setup(ctx) {
    if (ctx.app.version !== '2.0.23') throw new Error('slim-mcp requires the validated OpenCode 2.0.23 runtime')
    if (ctx.options.exclusiveNamespaces !== true) throw new Error('slim-mcp requires explicit exclusiveNamespaces: true approval; other plugins must not override selected MCP namespaces')
    const servers = ctx.options.servers
    if (!Array.isArray(servers) || servers.some(server => typeof server !== 'string' || !server.trim() || /["<>\r\n]/.test(server)) || new Set(servers).size !== servers.length) {
      throw new Error('slim-mcp options.servers must be an array of unique nonempty MCP server names')
    }
    const mapping = new Mapping(servers)
    const invocations = new Invocations()
    const endpoint = ctx.options.endpoint
    if (endpoint !== undefined && typeof endpoint !== 'string') throw new Error('slim-mcp options.endpoint must be a URL')
    let closed = false
    const instructions = new Map<string, string>()
    let skillUpdate: Promise<void> = Promise.resolve()
    let skillQueued = false
    const updateSkills = () => {
      if (skillQueued || closed) return
      skillQueued = true
      queueMicrotask(() => {
        skillQueued = false
        if (!closed) skillUpdate = skillUpdate.then(() => ctx.skill.reload()).catch(() => console.error('slim-mcp skill reload failed'))
      })
    }
    await ctx.mcp.transform(editor => mapping.configure(editor.list()))
    await ctx.skill.transform(editor => {
      for (const server of mapping.servers) {
        const id = skillID(server)
        if (editor.get(id)) throw new Error(`slim-mcp skill ID already exists: ${id}`)
        editor.add(skill(server, ctx.location.directory, instructions.get(server)))
      }
    })
    await ctx.shell.hook('create.before', event => {
      // Never carry a capability from an inherited environment into an unrelated shell.
      delete event.env.SLIM_MCP_CAPABILITY
      const prepared = invocations.prepare(event.command)
      if (!prepared) return
      event.command = prepared.command
      event.env.SLIM_MCP_CAPABILITY = prepared.capability
      event.env.SLIM_MCP_DIRECTORY = ctx.location.directory
      event.env.SLIM_MCP_WORKSPACE_ID = ctx.location.workspaceID ?? ''
      if (endpoint) event.env.SLIM_MCP_URL = endpoint
    })
    await ctx.tool.transform(editor => {
      if (mapping.capture(editor)) updateSkills()
      editor.update('shell', tool => {
        const execute = tool.execute
        tool.execute = (input, context) => {
          const shell = input as { command: string; background?: boolean }
          // Background shells outlive the tool invocation and cannot safely retain its authority.
          if (shell.background) return execute(input, context)
          return invocations.shell(shell.command, context, command => execute({ ...shell, command }, context))
        }
      })
    })
    // Native MCP guidance is a structured instruction block, not arbitrary prose.
    // Remove selected server blocks from outgoing messages only, retaining unrelated guidance.
    const removeServers = (text: string) => text.replace(/\s*<server name="([^"]*)">([\s\S]*?)<\/server>/g, (serverBlock, name: string, body: string) => {
      if (!mapping.servers.includes(name)) return serverBlock
      const guidance = body.split('\n').filter(line => !line.trim().startsWith('Use tools from this server through `execute` under ')).map(line => line.trim()).join('\n').trim()
      if (instructions.get(name) !== guidance) {
        instructions.set(name, guidance)
        updateSkills()
      }
      return ''
    })
    const rewrite = (text: string) => text
      .replace(/<mcp_instructions>[\s\S]*?<\/mcp_instructions>/g, removeServers)
      .replace(/(^|\n)(New MCP server instructions are available in addition to those previously listed:\n)((?:[ \t]*<server name="[^"]*">[\s\S]*?<\/server>[ \t]*(?:\n|$))+)/g, (_block, start: string, heading: string, servers: string) => start + heading + removeServers(servers))
    const rewriteContext = (event: { system: Array<{ type: string; text?: string }>; messages: unknown[] }) => {
      for (const part of event.system) if (part.type === 'text' && typeof part.text === 'string') part.text = rewrite(part.text)
      for (const message of event.messages) {
        const value = message as { role?: string; content?: unknown }
        if (value.role !== 'system') continue
        if (typeof value.content === 'string') value.content = rewrite(value.content)
        else if (Array.isArray(value.content)) for (const part of value.content) if (part.type === 'text') part.text = rewrite(part.text)
      }
    }
    await ctx.session.hook('context', rewriteContext)
    await ctx.session.hook('compaction', rewriteContext)
    await ctx.session.hook('generate', rewriteContext)
    await ctx.session.hook('title', rewriteContext)

    const authorizeDiscovery = async (server: string, context: ToolContext) => {
      // Use the native skill executor for the native skill permission assertion.
      // Neither an invocation capability nor shell approval overrides skill visibility.
      const nativeSkill = (await ctx.tool.list()).find(tool => tool.id === 'skill')
      if (!nativeSkill) throw new Rejected('skill_unavailable')
      await nativeSkill.execute({ id: skillID(server) }, context)
    }
    const refresh = async () => {
      if (closed) throw new Rejected('plugin_unloaded')
      const status = await ctx.mcp.list()
      await ctx.tool.list()
      return status.data
    }
    const changes = new AbortController()
    // Native connection/account changes can occur without a JSON configuration change.
    // Conservatively revoke active calls before accepting a future catalog version.
    const watch = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: changes.signal })) {
          if (event.type === 'credential.switched' || event.type === 'credential.updated' || event.type === 'integration.updated') mapping.invalidate()
          if (event.type === 'mcp.status.changed' && (!event.location || event.location.directory === ctx.location.directory)) mapping.invalidate()
        }
      } catch { if (!closed) { invocations.close(); console.error('slim-mcp connection watcher failed; invocation authority revoked') } }
    })()
    await ctx.rpc.register(SlimMcp, {
      status: async (input, rpc) => {
        try {
          const request = input as Request
          const context = invocations.resolve(request.capability, request.requestID, rpc.signal)
          const status = await refresh()
          const result = []
          for (const server of mapping.servers) {
            await authorizeDiscovery(server, context)
            const native = status.find(item => item.name === server)
            // Native failure messages can contain endpoint or credential details.
            result.push({ server, state: native?.status.status ?? 'missing' })
          }
          return { version: mapping.version, servers: result }
        } catch (error) { return rpc.error('rejected', 'Discovery failed', { code: error instanceof Rejected ? error.code : 'permission_or_runtime_error' }) }
      },
      catalog: async (input, rpc) => {
        try {
          const request = input as Request
          const context = invocations.resolve(request.capability, request.requestID, rpc.signal)
          await refresh()
          await authorizeDiscovery(request.server, context)
          return mapping.catalog(request.server)
        } catch (error) { return rpc.error('rejected', 'Discovery failed', { code: error instanceof Rejected ? error.code : 'permission_or_runtime_error' }) }
      },
      schema: async (input, rpc) => {
        try {
          const request = input as Request
          const context = invocations.resolve(request.capability, request.requestID, rpc.signal)
          await refresh()
          await authorizeDiscovery(request.server, context)
          return mapping.schema(request.server, request.tool)
        } catch (error) { return rpc.error('rejected', 'Discovery failed', { code: error instanceof Rejected ? error.code : 'permission_or_runtime_error' }) }
      },
      call: async (input, rpc) => {
        try {
          const request = input as Request
          const context = invocations.resolve(request.capability, request.requestID, rpc.signal)
          const status = await refresh()
          await authorizeDiscovery(request.server, context)
          if (request.version !== mapping.version) throw new Rejected('stale_catalog')
          if (status.find(server => server.name === request.server)?.status.status !== 'connected') throw new Rejected('server_not_ready')
          const entry = mapping.get(request.server, request.tool)
          mapping.validate(entry, request.arguments)
          const result = await entry.execute(request.arguments, { ...context, signal: AbortSignal.any([context.signal, mapping.signal]) })
          return await boundedResult(result, ctx.location.directory, ctx.location.workspaceID)
        } catch (error) { return rpc.error('rejected', 'Call failed; do not automatically retry mutations', { code: error instanceof Rejected ? error.code : 'permission_or_runtime_error' }) }
      },
    })
    return async () => {
      closed = true
      invocations.close()
      changes.abort()
      mapping.invalidate()
      await watch
      await skillUpdate
    }
  },
})

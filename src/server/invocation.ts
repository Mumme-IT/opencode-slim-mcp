import { randomBytes, randomUUID } from 'node:crypto'
import type { ToolContext } from '@opencode/plugin/promise/tool'

export class Rejected extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

interface Binding {
  context: ToolContext
  controller: AbortController
  expires: number
  requests: Set<string>
}

/** Capabilities never leave the process except through the environment of the bound shell. */
export class Invocations {
  private closed = false
  private bindings = new Map<string, Binding>()
  private markers = new Map<string, { command: string; token: string }>()

  async shell<T>(command: string, context: ToolContext, execute: (marked: string) => Promise<T>): Promise<T> {
    if (this.closed) throw new Rejected('plugin_unavailable')
    const token = randomBytes(32).toString('base64url')
    const marker = randomUUID()
    const controller = new AbortController()
    const signal = AbortSignal.any([context.signal, controller.signal, AbortSignal.timeout(300_000)])
    this.bindings.set(token, { context: { ...context, signal }, controller, expires: Date.now() + 300_000, requests: new Set() })
    this.markers.set(marker, { command, token })
    try {
      return await execute(`# slim-mcp-invocation:${marker}\n${command}`)
    } finally {
      controller.abort()
      this.markers.delete(marker)
      this.bindings.delete(token)
    }
  }

  prepare(command: string): { command: string; capability: string } | undefined {
    const match = /^# slim-mcp-invocation:([^\n]+)\n/.exec(command)
    if (!match) return undefined
    const marker = this.markers.get(match[1])
    if (!marker || command.slice(match[0].length) !== marker.command) throw new Rejected('invalid_invocation')
    this.markers.delete(match[1])
    return { command: marker.command, capability: marker.token }
  }

  resolve(capability: string, requestID: string, signal: AbortSignal): ToolContext {
    const binding = this.bindings.get(capability)
    if (!binding || binding.expires <= Date.now() || binding.context.signal.aborted) throw new Rejected('invalid_invocation')
    if (binding.requests.has(requestID)) throw new Rejected('replayed_request')
    if (binding.requests.size >= 1024) throw new Rejected('invocation_limit')
    binding.requests.add(requestID)
    return { ...binding.context, signal: AbortSignal.any([binding.context.signal, signal]) }
  }

  close(): void {
    this.closed = true
    for (const binding of this.bindings.values()) binding.controller.abort()
    this.bindings.clear()
    this.markers.clear()
  }
}

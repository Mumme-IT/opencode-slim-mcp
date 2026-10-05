import { createHash, randomUUID } from 'node:crypto'
import type { Info, ToolEditor } from '@opencode/plugin/promise/tool'
import Ajv from 'ajv'
import Ajv2019 from 'ajv/dist/2019.js'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { Rejected } from './invocation.js'

type Entry = Info & { readonly id: string }
const normalize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** This module owns only the mapped catalog, never MCP connections or credentials. */
export class Mapping {
  readonly servers: readonly string[]
  private namespaces: Map<string, string>
  private configs = new Map<string, string>()
  private entries = new Map<string, Map<string, Entry>>()
  private fingerprint = ''
  version = randomUUID()
  private lifetime = new AbortController()
  private validators = new Map<string, ReturnType<Ajv['compile']>>()

  get signal(): AbortSignal { return this.lifetime.signal }

  /** Revoke calls admitted against an earlier configuration, connection, or catalog. */
  invalidate(): void {
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.version = randomUUID()
  }

  constructor(servers: readonly string[]) {
    this.servers = [...servers]
    this.namespaces = new Map()
    for (const server of servers) {
      const namespace = normalize(server)
      if (this.namespaces.has(namespace)) throw new Rejected('namespace_collision')
      this.namespaces.set(namespace, server)
    }
  }

  configure(configs: readonly (readonly [string, unknown])[]): void {
    for (const [name] of configs) {
      const selected = this.namespaces.get(normalize(name))
      if (selected && name !== selected) throw new Rejected('namespace_collision')
    }
    const selected = new Map(configs.filter(([name]) => this.servers.includes(name)).map(([name, config]) => [name, hash(config)]))
    if (JSON.stringify([...selected]) === JSON.stringify([...this.configs])) return
    this.configs = selected
    this.entries.clear()
    this.fingerprint = ''
    this.validators.clear()
    this.invalidate()
  }

  capture(editor: ToolEditor): boolean {
    const entries = new Map<string, Map<string, Entry>>()
    for (const entry of editor.list()) {
      const namespace = entry.options?.namespace
      const server = namespace && this.namespaces.get(namespace)
      if (!server) continue
      // Namespace ownership is an explicit installation constraint, not inferred from ID prefixes.
      if (entry.id !== `${normalize(server)}_${normalize(entry.name)}`) throw new Rejected('namespace_collision')
      editor.remove(entry.id)
      if (!this.configs.has(server)) continue
      if (!entries.has(server)) entries.set(server, new Map())
      entries.get(server)!.set(entry.name, entry)
    }
    const fingerprint = hash([...entries].map(([server, tools]) => [server, this.configs.get(server), [...tools].map(([name, entry]) => [name, entry.id, entry.description, entry.input, entry.output])]))
    const changed = fingerprint !== this.fingerprint
    this.entries = entries
    if (changed) {
      this.fingerprint = fingerprint
      this.validators.clear()
      this.invalidate()
    }
    return changed
  }

  catalog(server: string): object {
    this.selected(server)
    return { version: this.version, server, tools: [...(this.entries.get(server)?.values() ?? [])].map(entry => ({ name: entry.name, description: entry.description })) }
  }

  schema(server: string, tool: string): object {
    const entry = this.get(server, tool)
    this.jsonSchema(entry.input)
    return { version: this.version, server, tool, input: entry.input, output: entry.output ?? null }
  }

  get(server: string, tool: string): Entry {
    this.selected(server)
    const entry = this.entries.get(server)?.get(tool)
    if (!entry) throw new Rejected('tool_not_ready')
    return entry
  }

  validate(entry: Entry, args: unknown): void {
    this.jsonSchema(entry.input)
    if (Buffer.byteLength(JSON.stringify(args)) > 1_048_576) throw new Rejected('invalid_arguments')
    let validate = this.validators.get(entry.id)
    if (!validate) {
      const schema = entry.input as { $schema?: string }
      const dialect = schema.$schema
      const index = !dialect || dialect === 'http://json-schema.org/draft-07/schema#' || dialect === 'http://json-schema.org/draft-07/schema' ? 0 : dialect === 'https://json-schema.org/draft/2019-09/schema' ? 1 : dialect === 'https://json-schema.org/draft/2020-12/schema' ? 2 : -1
      if (index < 0) throw new Rejected('unsupported_schema')
      const Constructor = [Ajv, Ajv2019, Ajv2020][index]!
      try { validate = addFormats(new Constructor({ strictSchema: true, strictTypes: false, allErrors: true })).compile(entry.input as object) } catch { throw new Rejected('unsupported_schema') }
      this.validators.set(entry.id, validate)
    }
    if (!validate(args)) throw new Rejected('invalid_arguments')
  }

  private jsonSchema(input: unknown): void {
    if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype || '~standard' in input || '~effect/Schema' in input) throw new Rejected('unsupported_schema')
  }

  private selected(server: string): void {
    if (!this.servers.includes(server)) throw new Rejected('server_not_selected')
  }
}

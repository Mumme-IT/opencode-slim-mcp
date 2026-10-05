import { Rpc } from '@opencode/plugin/rpc'

const selection = {
  server: { type: 'string', minLength: 1 },
  tool: { type: 'string', minLength: 1 },
} as const
const credentials = {
  capability: { type: 'string', minLength: 1 },
  requestID: { type: 'string', minLength: 1 },
} as const
const errors = {
  rejected: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
} as const

/** Discovery also requires a live shell invocation. It is not an alternate permission surface. */
export const SlimMcp = Rpc.define({
  id: 'slim-mcp',
  events: {},
  methods: {
    status: {
      input: { type: 'object', properties: credentials, required: ['capability', 'requestID'], additionalProperties: false },
      output: { type: 'object', properties: { version: { type: 'string' }, servers: { type: 'array', items: { type: 'object', properties: { server: { type: 'string' }, state: { type: 'string' } }, required: ['server', 'state'], additionalProperties: false } } }, required: ['version', 'servers'], additionalProperties: false }, errors,
    },
    catalog: {
      input: { type: 'object', properties: { ...credentials, server: selection.server }, required: ['capability', 'requestID', 'server'], additionalProperties: false },
      output: { type: 'object', properties: { version: { type: 'string' }, server: { type: 'string' }, tools: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'], additionalProperties: false } } }, required: ['version', 'server', 'tools'], additionalProperties: false }, errors,
    },
    schema: {
      input: { type: 'object', properties: { ...credentials, ...selection }, required: ['capability', 'requestID', 'server', 'tool'], additionalProperties: false },
      output: { type: 'object', properties: { version: { type: 'string' }, server: { type: 'string' }, tool: { type: 'string' }, input: { type: 'object' }, output: {} }, required: ['version', 'server', 'tool', 'input', 'output'], additionalProperties: false }, errors,
    },
    call: {
      input: { type: 'object', properties: { ...credentials, ...selection, version: { type: 'string' }, arguments: { type: 'object' } }, required: ['capability', 'requestID', 'server', 'tool', 'version', 'arguments'], additionalProperties: false },
      output: { oneOf: [
        { type: 'object', properties: { completed: { const: true }, result: {} }, required: ['completed', 'result'], additionalProperties: false },
        { type: 'object', properties: { completed: { const: true }, artifact: { type: 'object', properties: { path: { type: 'string' }, bytes: { type: 'integer', minimum: 0 }, type: { const: 'application/json' } }, required: ['path', 'bytes', 'type'], additionalProperties: false } }, required: ['completed', 'artifact'], additionalProperties: false },
      ] }, errors,
    },
  },
})

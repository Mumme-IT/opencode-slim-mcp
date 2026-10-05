import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import plugin from '../dist/server.js'
import { SlimMcp } from '../dist/rpc.js'

assert.equal(plugin.id, 'slim-mcp')
assert.equal('server' in plugin, false)
assert.equal(SlimMcp.id, 'slim-mcp')
assert.match(execFileSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' }), /slim-mcp call/)

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Rejected } from './invocation.js'

export async function boundedResult(result: unknown, directory: string, workspaceID?: string): Promise<object> {
  const json = JSON.stringify(result)
  const bytes = Buffer.byteLength(json)
  if (bytes > 16_777_216) throw new Rejected('result_too_large')
  const content = result && typeof result === 'object' && 'content' in result ? result.content : undefined
  const hasMedia = Array.isArray(content) && content.some(part => part && typeof part === 'object' && part.type === 'file')
  if (bytes <= 65_536 && !hasMedia) return { completed: true, result }
  const location = createHash('sha256').update(JSON.stringify([directory, workspaceID])).digest('hex')
  const root = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'opencode', 'slim-mcp', 'artifacts', location)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, `${randomUUID()}.json`)
  await writeFile(path, json, { mode: 0o600, flag: 'wx' })
  return { completed: true, artifact: { path, bytes, type: 'application/json' } }
}

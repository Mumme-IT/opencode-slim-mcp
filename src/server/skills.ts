import { resolve } from 'node:path'
import { Skill } from '@opencode/plugin'

export const skillID = (server: string) => `slim-mcp-${Buffer.from(server).toString('hex')}`
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function skill(server: string, directory: string, instructions = '') {
  const content = [
    `# ${server}`,
    'Use the installed `slim-mcp` CLI inside the OpenCode shell tool. Do not use a terminal outside this session.',
    `1. Run \`slim-mcp list ${shellQuote(server)}\` to discover tool names.\n2. Run \`slim-mcp schema ${shellQuote(server)} <tool>\` to get the complete input schema.\n3. Run \`slim-mcp call ${shellQuote(server)} <tool> --json '<JSON object>'\`, or pipe a JSON object to \`--stdin\`.`,
    "These examples use POSIX shell quoting. Use JSON for nested objects and arrays. Native MCP permissions still apply. Never automatically retry a mutation after a timeout or disconnect. If the result contains an artifact path, read that file on the OpenCode server to obtain the complete typed result. Discovery and execution require a live, foreground OpenCode shell invocation. Use `slim-mcp status` for native connection state. Sign in using OpenCode's MCP interface if authentication is required.",
    instructions ? `## MCP server instructions\n\n${instructions}` : '',
  ].filter(Boolean).join('\n\n')
  return Skill.Info.make({
    id: Skill.ID.make(skillID(server)),
    name: Skill.Name.make(`MCP: ${server}`),
    description: `Use ${server} through the slim-mcp CLI. Load for tools from this MCP server.`,
    // A virtual Markdown path avoids SKILL.md directory scanning. No files are written here.
    path: Skill.Info.fields.path.make(resolve(directory, '.opencode', 'slim-mcp', `${skillID(server)}.md`)),
    content,
  })
}

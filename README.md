# opencode-slim-mcp

Converts MCP servers into opencode **skills** + **CLI wrappers**. Agent discovers tools via on-demand skill loading (zero idle token cost), calls them via shell.

## Problem

- Full MCP registration = token bloat (hundreds of schemas in context)
- `mcp-lazy-proxy` strips schemas → agent flies blind
- No middle ground existed

## Quick Start

```bash
npm install
# Place your mcp-lazy-proxy.json in the project root (or pass path as arg)
node generate.js
```

Outputs land in `~/.config/opencode/` by default.

## CLI Flags

```
node generate.js [config.json] [options]

Options:
  --output-dir <path>      Base output directory (default: ~/.config/opencode)
  --skills-dir <path>      Override skills output path
  --bin-dir <path>         Override CLI wrappers output path
  --ai-skills-dir <path>   Override schema cache path
```

## Config Format

Reads `mcp-lazy-proxy.json` — supports both `{ mcpServers: {} }` and `{ servers: {} }` shapes. Each entry needs `command` and optional `args`:

```json
{
  "mcpServers": {
    "gitea": { "command": "gitea-mcp", "args": ["-t", "stdio"] }
  }
}
```

## Generated CLI Usage

```bash
mcp-<server> <tool> [key=value ...]         # simple params
mcp-<server> <tool> key:='["json","val"]'   # complex params (httpie convention)
mcp-<server> <tool> --params '{"k":"v"}'    # full JSON params
echo '{"k":"v"}' | mcp-<server> <tool> -    # params via stdin
mcp-<server> --list                          # list available tools
mcp-<server> --schema <tool>                 # show tool input schema
```

## Output Structure

```
~/.config/opencode/
├── skills/mcp-<server>/SKILL.md     # Tool names, descriptions, param docs
├── bin/mcp-<server>                 # Executable CLI wrapper (Node.js)
└── .ai-skills/slim-mcp/
    ├── schemas/<server>/*.json      # Per-tool input schemas
    ├── manifest.json                # Generation metadata + paths
    └── config.json                  # Cached server definitions
```

## Refresh

Re-run `node generate.js` (or `npm run refresh`) to re-introspect servers and regenerate all artifacts.

## Prerequisites

- Node.js (ESM)
- `@modelcontextprotocol/sdk` (installed via `npm install`)
- MCP servers must be reachable via their configured `command`/`args`

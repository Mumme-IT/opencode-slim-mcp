# opencode-slim-mcp

OpenCode plugin that converts MCP servers into **skills** + **CLI wrappers**. Agent discovers tools via on-demand skill loading (zero idle token cost), calls them via shell.

## Problem

- Full MCP registration = token bloat (hundreds of schemas in context)
- `mcp-lazy-proxy` strips schemas → agent flies blind
- No middle ground existed

## Install

Add to `opencode.json`:

```json
{
  "plugin": ["opencode-slim-mcp"]
}
```

Place MCP server config as `mcp-lazy-proxy.json` or `mcp.json` in project root or `~/.config/opencode/`.

```json
{
  "mcpServers": {
    "gitea": { "command": "gitea-mcp", "args": ["-t", "stdio"] }
  }
}
```

Both `{ mcpServers: {} }` and `{ servers: {} }` shapes supported.

## What Happens on Startup

1. Plugin discovers MCP config (project dir → `~/.config/opencode/`)
2. Introspects each server for available tools
3. Generates SKILL.md files + CLI wrappers + schema cache
4. Registers skills path via `config` hook
5. Injects `~/.config/opencode/bin` into agent `PATH` via `shell.env` hook

Regeneration only triggers when server list changes.

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
    └── manifest.json                # Generation metadata
```

## Manual Regeneration

Standalone CLI available for manual re-introspection:

```bash
npx slim-mcp-generate [config.json] [options]

Options:
  --output-dir <path>      Base output directory (default: ~/.config/opencode)
  --skills-dir <path>      Override skills output path
  --bin-dir <path>         Override CLI wrappers output path
  --ai-skills-dir <path>   Override schema cache path
```

## Prerequisites

- Node.js (ESM)
- MCP servers must be reachable via their configured `command`/`args`

# opencode-slim-mcp

OpenCode plugin that converts MCP servers marked `slim: true` into **skills** + a single **native proxy tool**. Agent discovers tools via on-demand skill loading (zero idle token cost), calls them through a pooled MCP connection.

## Problem

- Full MCP registration = token bloat (hundreds of schemas in context)
- No middle ground between full registration and blind proxying

## How to Install

### 1. Add the plugin to your `opencode.json`

```json
{
  "plugin": ["opencode-slim-mcp"]
}
```

### 2. Mark MCP servers with `slim: true`

In your project or global `opencode.json`, add `"slim": true` to any MCP server you want managed by this plugin:

```json
{
  "mcp": {
    "todoist": {
      "command": "npx",
      "args": ["-y", "@anthropics/todoist-mcp"],
      "slim": true
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@anthropics/playwright-mcp"],
      "slim": true
    },
    "regular-mcp": {
      "command": "some-mcp-server",
      "args": ["--stdio"]
    }
  }
}
```

Servers **without** `slim: true` are left untouched — opencode handles them normally.

### 3. (Optional) Disable a slim server

Set `"enabled": false` to disable a server without removing it from config:

```json
{
  "mcp": {
    "todoist": {
      "command": "npx",
      "args": ["-y", "@anthropics/todoist-mcp"],
      "slim": true,
      "enabled": false
    }
  }
}
```

Disabled servers appear as `[disabled]` in `mcp-status` but won't start, generate skills, or accept tool calls.

## What Happens on Startup

1. Plugin reads `opencode.json` (project dir + `~/.config/opencode/`)
2. Extracts entries with `slim: true` (skips disabled ones)
3. Introspects each server for available tools
4. Generates `SKILL.md` files + schema cache per server
5. Registers a single `mcp` tool that proxies calls to any slim server
6. Probes remote reachability first; auth failures stay enabled for `opencode mcp auth`
7. Sets `enabled: false` on remaining slim entries in host config (prevents double-handling)

Regeneration only triggers when the enabled server list changes.

## Plugin Configuration

Create `slim-mcp-config.json` in your project root or `~/.config/opencode/`:

```json
{
  "lazy-loading": true,
  "lazy-idle-shutdown-interval": "5m"
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `lazy-loading` | `true` | Connect to servers on first tool call (vs. eagerly on startup) |
| `lazy-idle-shutdown-interval` | `"5m"` | Disconnect idle servers after this duration (e.g. `"5m"`, `"300000"`) |

## Tools Provided

### `mcp`

Calls a tool on any enabled slim MCP server.

```
mcp(server: "todoist", tool: "add-tasks", params: '{"tasks": [...]}')
```

### `mcp-status`

Shows status of all slim MCP servers: `connected`, `pending`, `disabled`, or `error`.

## Output Structure

```
~/.local/state/opencode/slim-mcp/
├── skills/mcp-<server>/SKILL.md     # Tool names, descriptions, param docs
├── schemas/<server>/*.json           # Per-tool input schemas
├── manifest.json                     # Generation metadata
└── status.json                       # Server status (consumed by TUI plugin)
```

## TUI Sidebar Plugin

Shows slim MCP server status in the opencode TUI sidebar (connection state, errors, auth status).

Add to your global TUI config at `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-slim-mcp"]
}
```

Renders below the built-in MCP sidebar (order 210). Polls `status.json` on startup + after `mcp`/`mcp-status` tool calls.

## Prerequisites

- Node.js (ESM)
- MCP servers must be reachable via their configured `command`/`args`

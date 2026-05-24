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

1. Plugin reads raw `opencode.json` files (project dir + `~/.config/opencode/`)
2. Extracts entries with `slim: true` (skips disabled ones)
3. Introspects each server for available tools
4. Generates `SKILL.md` files + schema cache per server
5. Registers single `mcp` tool that proxies calls to any slim server
6. During `config(cfg)`, also discovers live `cfg.mcp` entries injected by earlier plugins
7. Removes plugin-handled slim entries from final `cfg.mcp` before opencode validation
8. If slim server fails introspection/auth, entry stays in `cfg.mcp` but `slim` flag gets stripped so opencode can handle fallback/auth flow

## Plugin Ordering

`opencode-slim-mcp` discovers slim MCP servers from two sources:

1. **Raw config files** — `opencode.json` in project dir and `~/.config/opencode/` (read at startup)
2. **Live `cfg.mcp`** — entries injected by a prior plugin inside its `config(cfg)` hook (read at config time)

If another plugin dynamically injects `cfg.mcp.<name>` entries with `slim: true`, that plugin **must be listed before** `opencode-slim-mcp` in your plugin array. opencode runs plugin `config` hooks in declaration order, so the producer's hook must run first.

```json
{
  "plugin": [
    "my-dynamic-mcp-plugin",
    "opencode-slim-mcp"
  ]
}
```

The producer plugin injects entries like this in its `config(cfg)` hook:

```typescript
config: async (cfg) => {
  cfg.mcp = cfg.mcp ?? {};
  cfg.mcp["my-server"] = {
    type: "local",
    command: ["npx", "-y", "my-mcp-server"],
    slim: true,
  };
}
```

`opencode-slim-mcp` will register the server, introspect its tools, generate a skill, then **remove the entry from `cfg.mcp`** before opencode's final validation. The `slim` flag never reaches opencode's config validator.

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

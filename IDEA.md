# opencode-slim-mcp

Convert MCP servers into opencode skills + CLI wrappers.
Agent gets tool awareness via skills, calls tools on-demand via shell.

## Problem

- MCP tools loaded into context = token bloat (hundreds of schemas)
- `mcp-lazy-proxy` strips schemas → agent has no clue what tools do or what params they take
- No middle ground: either pay full token cost or fly blind

## Solution

```
mcp-lazy-proxy.json ──► generator ──► skills/gitea/SKILL.md   (tool names + descriptions)
                                    ──► bin/mcp-gitea          (CLI wrapper script)
                                    ──► .ai-skills/gitea/      (config, schema cache)
```

1. **Introspect** each MCP server → dump tool schemas (names, descriptions, params)
2. **Generate SKILL.md** per server — agent sees skill in list, loads on demand, gets full tool awareness
3. **Generate CLI wrapper** per server — single script that calls any tool via MCP protocol
4. **Agent flow**: Sees `gitea` skill → loads → sees all tools + params → calls via `mcp-gitea create_issue title="foo"`

## Architecture

### Generator Script (`generate.js`)

Input: `mcp-lazy-proxy.json`
Output: Skills + CLI wrappers + config

```
~/.config/opencode/
├── skills/
│   └── mcp-gitea/
│       └── SKILL.md           # Tool descriptions, usage, param docs
│   └── mcp-github/
│       └── SKILL.md
│   └── mcp-kindly-search/
│       └── SKILL.md
│   └── mcp-playwright/
│       └── SKILL.md
├── bin/
│   └── mcp-gitea              # CLI: mcp-gitea <tool> [key=value...]
│   └── mcp-github
│   └── mcp-kindly-search
│   └── mcp-playwright
└── .ai-skills/
    └── slim-mcp/
        ├── config.json        # Server definitions, schema cache
        └── manifest.json      # Version tracking
```

### CLI Wrapper Pattern

```bash
#!/bin/sh
# mcp-gitea — call any Gitea MCP tool from CLI
# Usage: mcp-gitea <tool_name> [key=value] [key=value] ...
#
# Examples:
#   mcp-gitea list_my_repos
#   mcp-gitea create_issue owner=foo repo=bar title="New issue"
#   mcp-gitea --list                    # list available tools
#   mcp-gitea --schema create_issue     # show tool schema

TOOL="$1"; shift
SCHEMA_DIR="$HOME/.config/opencode/.ai-skills/slim-mcp/schemas/gitea"

if [ "$TOOL" = "--list" ]; then
  ls "$SCHEMA_DIR" | sed 's/\.json$//'
  exit 0
fi

if [ "$TOOL" = "--schema" ]; then
  cat "$SCHEMA_DIR/$1.json"
  exit 0
fi

# Build JSON args from key=value pairs
ARGS="{"
FIRST=true
for pair in "$@"; do
  KEY="${pair%%=*}"
  VAL="${pair#*=}"
  [ "$FIRST" = true ] && FIRST=false || ARGS="$ARGS,"
  ARGS="$ARGS\"$KEY\":\"$VAL\""
done
ARGS="$ARGS}"

# Call via mcp-tui or direct MCP protocol
mcp-tui --cmd gitea-mcp --args "-t,stdio" tool call "$TOOL" "$@" 2>/dev/null
```

### SKILL.md Template

```markdown
---
name: mcp-gitea
description: Use when interacting with Gitea — issues, repos, PRs, releases, wiki, timetracking, labels, milestones. Triggers on: gitea, git.mumme-it.de, create issue, list repos, merge PR.
inference_examples:
  - "Create a Gitea issue"
  - "List my Gitea repositories"
  - "Merge pull request on Gitea"
---

# Gitea MCP Tools

### Usage
```bash
mcp-gitea <tool> [key=value ...]
mcp-gitea --list            # list tools
mcp-gitea --schema <tool>   # show params
```

### Tools

| Tool | Description |
|---|---|
| create_issue | Create a new issue |
| list_my_repos | List repositories you own" |
| ... | ... |

### Key Parameters

#### create_issue
- `owner` (string, required) — repo owner
- `repo` (string, required) — repo name
- `title` (string, required) — issue title
- `body` (string) — issue description

#### list_my_repos
(none)
```

## Introspection Strategy

### Option A: mcp-tui (recommended)

```bash
mcp-tui --cmd gitea-mcp --args "-t,stdio" tool list --json
```

- Go binary, single install
- Built-in JSON output
- Supports stdio/SSE/HTTP transports

### Option B: MCP SDK directly

```javascript
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const transport = new StdioClientTransport({ command: "gitea-mcp", args: ["-t", "stdio"] })
const client = new Client({ name: "introspector" })
await client.connect(transport)
const { tools } = await client.listTools()
```

- No extra dependency (MCP SDK already in node_modules via lazy-proxy)
- More control over output format
- Requires Node.js runtime

### Option C: Parse lazy-proxy cache

If mcp-lazy-proxy has already cached schemas:
```bash
find ~/.cache/mcp-lazy-proxy -name "*.json" -exec cat {} \;
```

- Zero cost if cache exists
- Fragile: cache format may change between versions

## Comparison

| Approach | Agent Awareness | Token Cost | Server Uptime | Setup Effort |
|---|---|---|---|---|
| Direct MCP registration | Full (expensive) | High | Persistent | Zero |
| mcp-lazy-proxy (lazy) | Stub only | Low | Persistent | Low |
| mcp-lazy-proxy (eager) | Full | High | Persistent | Low |
| mcpproxy-go (BM25) | Via retrieve_tools | Very low | Persistent | Medium |
| **opencode-slim-mcp** | **Skill-loaded on demand** | **Low** | **Spawned per call** | **One-time generate** |

## Implementation Checklist

- [ ] `generate.js` — reads mcp-lazy-proxy.json, introspects servers, outputs skills + wrappers
- [ ] CLI wrapper template — shell script per server, calls mcp-tui or MCP SDK
- [ ] SKILL.md template — per-server skill with tool table + param docs
- [ ] Schema caching — store introspected schemas in `.ai-skills/slim-mcp/schemas/`
- [ ] `refresh` command — re-introspect and regenerate when MCP servers update
- [ ] `opencode.json` integration — register bin/ scripts as local MCP servers or just rely on skills + bash
- [ ] Handle complex params (nested objects, arrays) — key=value syntax may not cover all cases
- [ ] Handle streaming/large responses — consider response truncation

## Open Questions

1. **Transport for tool calls**: mcp-tui spawns server per call (slow). Alternative: keep server alive briefly with a timeout daemon.
2. **Complex params**: `key=value` doesn't handle nested JSON. May need `key:=json` convention (like httpie).
3. **opencode.json registration**: Should CLI wrappers register as MCP servers (circular) or just be called via Bash?
4. **Refresh cadence**: Manual? Git hook? Watch mcp-lazy-proxy.json for changes?

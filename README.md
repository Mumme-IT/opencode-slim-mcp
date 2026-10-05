# opencode-slim-mcp

Expose selected native OpenCode MCP tools through a CLI and on-demand skills instead of advertising their tool descriptions.

**Version 1.0.0 is a breaking, V2-only implementation. It requires OpenCode 2.0.23 and Node.js 24 or newer.** Other OpenCode releases are rejected until their tool, shell, and permission contracts are validated.

**This release has explicitly accepted limitations.** A live catalog change during pending approval can precede revocation and affect the operation being approved. Atomic catalog identity requires an upstream execution interface. Remote OAuth and net token savings remain unverified. See [implementation evidence and release limitations](docs/implementation.md) before deployment.

## Architecture

OpenCode owns MCP configuration, transports, OAuth, timeouts, catalog refresh, and connection state. The plugin captures native tool executors with the public tool transform and removes selected definitions from future model catalogs. It registers one short skill per selected server. The skill teaches the agent to discover schemas and execute tools using `slim-mcp`.

The CLI connects to the existing OpenCode server through `@opencode/client` and typed plugin RPC. It does not embed another OpenCode host, open a second MCP connection, read credential files, or add a generic model-visible proxy tool.

## Installation

Build and install the repository package before configuring the plugin:

```sh
npm ci
npm run build
npm pack --ignore-scripts
npm install --global ./opencode-slim-mcp-1.0.0.tgz
slim-mcp --help
```

Configure the installed plugin directory, or use `opencode-slim-mcp@1.0.0` after that release is published. The CLI must be installed on the **OpenCode server host** and available on the shell's `PATH`; installing it only on a remote TUI's computer is not enough. Local development can point the plugin entry at this repository directory after building.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "docs": {
        "type": "local",
        "command": ["npx", "-y", "your-mcp-package"],
        "disabled": false
      }
    }
  },
  "plugins": [
    {
      "package": "/absolute/path/to/installed/opencode-slim-mcp",
      "options": { "servers": ["docs"], "exclusiveNamespaces": true }
    }
  ]
}
```

Only explicitly selected names are mapped. Unselected MCP servers retain their native tools. Keep native MCP definitions enabled: disabling a server disconnects it rather than merely hiding its descriptions.

Server namespaces must be exclusive to the corresponding native MCP server. Do not install another plugin that registers or replaces tools in a selected namespace. Native V2 does not expose typed tool provenance. Names that normalize to the same native namespace, such as `a.b` and `a_b`, are rejected.

Setting `exclusiveNamespaces: true` explicitly accepts this installation requirement. The plugin rejects startup without that approval. Names containing quotes, XML delimiters, or newlines are unsupported because native MCP instruction rendering does not escape those names.

## Agent workflow

Load the server's `MCP: <server>` skill, then use these commands through the native foreground OpenCode `shell` tool:

```sh
slim-mcp status
slim-mcp list docs
slim-mcp schema docs search
slim-mcp call docs search --json '{"query":"example","limit":3}'
printf '%s' '{"query":"example","filters":{"tags":["api"]}}' |
  slim-mcp call docs search --stdin
```

These examples use POSIX shell quoting. The catalog reports the native normalized tool names. JSON arguments preserve nested objects, arrays, numbers, booleans, and nulls. Choose exactly one of `--json` and `--stdin`. Arguments are limited to **1 MiB**. Supported input schemas are JSON Schema draft-07, 2019-09, and 2020-12; unknown keywords, formats, references, and non-JSON schemas fail explicitly rather than weakening validation.

Commands return JSON on stdout and sanitized JSON errors on stderr. Exit codes are `0` for success, `2` for invalid CLI input, `3` for endpoint/RPC failure, `4` for rejected authority, permissions, validation, or execution, and `6` for CLI cancellation. Never automatically retry mutations after a timeout, disconnect, or uncertain result.

There is no separate V2 sidebar in this release. Use `slim-mcp status` inside the agent's shell or OpenCode's native MCP interface.

## Permissions and invocation authority

The CLI requires a short-lived capability issued only to a genuine foreground native shell tool invocation. The plugin binds the capability to the actual session, agent, message, tool call, cancellation signal, and Location. A shell hook removes a one-use correlation marker before native shell permission checks and spawning; only the environment contains the secret capability. The plugin never fabricates a tool context or changes global process environment variables.

Capabilities expire after **5 minutes**, become invalid when the shell finishes, and accept at most **1,024** unique RPC requests. Duplicate request IDs are rejected. Session interruption, CLI interruption, and plugin unload cancel associated native calls. Background shells and external terminals have no authority. The capability is a bearer secret: do not print, persist, or send the shell's environment to another party. Shell descendants share that invocation's authority only while it remains live.

Native skill permissions control discovery. Native MCP permission assertions control execution, including `ask` and `deny`; shell approval does not approve MCP operations. The plugin does not auto-approve requests. Use OpenCode's MCP interface to sign in to OAuth servers. The plugin reads native readiness without copying credentials.

Calls use the captured native executor, not the outer MCP tool dispatcher. They retain native MCP permissions, authentication, cancellation, and structured results. They do not trigger separate MCP tool dispatch hooks or create a separate MCP tool-history row. The shell's history records the CLI result and receives progress. Plugins that require outer MCP dispatch hooks are not compatible with this execution path.

## Endpoint and Location

The CLI uses native service discovery without starting a service. For an explicit remote or standalone server, configure `options.endpoint` in the plugin and provide OpenCode authentication headers securely to the server-side shell environment through `SLIM_MCP_HEADERS` (a JSON object of string headers). Do not store secrets in plugin options, skills, or commands.

`--url` / `SLIM_MCP_URL` override endpoint discovery. `--directory` / `SLIM_MCP_DIRECTORY` select the Location; the genuine shell normally supplies the correct directory and workspace ID. Changing the Location or endpoint does not transfer invocation authority. HTTPS is required except for loopback HTTP. URLs containing credentials, query strings, or fragments are rejected.

No headers are guessed for an explicit server. Native service discovery supplies authentication only for its discovered managed endpoint. Missing explicit authentication produces an error instead of silently starting or selecting another server. HTTP redirects are rejected so they cannot forward invocation capabilities or arguments to another destination.

## Results and sensitive artifacts

Typed text results up to **64 KiB** are returned inline. Results containing native file/media content use artifacts even below that limit. Larger results, up to **16 MiB**, are also written as private JSON artifacts under:

```text
$XDG_STATE_HOME/opencode/slim-mcp/artifacts/<Location hash>/<UUID>.json
# Default: ~/.local/state/opencode/slim-mcp/artifacts/...
```

Artifacts use mode `0600` and plugin-created directories use mode `0700`. RPC returns the server-host path, byte count, and media type. Read the artifact on that host to obtain the complete result. Results above 16 MiB fail without automatic retries. Artifact-write failure can occur after a remote operation succeeds.

Artifacts can contain sensitive MCP output. They have no automatic retention policy: review and remove only owned artifacts that you no longer need. No schemas, OAuth secrets, transport definitions, or shared status files are persisted by this plugin.

## Token costs

The idle catalog contains one short skill summary per selected server, not its tool names or schemas. Selected native namespace instructions are removed from outgoing model context; useful server instructions move into the loaded skill. Schemas and results enter context only when requested.

This does **not** mean zero idle tokens. Native V2 Code Mode already compresses MCP catalogs. CLI skill loading, discovery, shell commands, and results also cost tokens. Compare complete tasks against native Code Mode before choosing this plugin; small catalogs can cost more through the CLI.

## Migration from 0.x

1. Back up your prior configuration and generated files.
2. Install the V2-only package and update the plugin directory or package reference.
3. Keep MCP definitions under native `mcp.servers`; move selections from `slim: true` into `options.servers`.
4. Remove old `mcp` / `mcp-status` proxy instructions and generator configuration. The new binary is `slim-mcp`, not `slim-mcp-generate`.
5. Remove the old TUI plugin entry. The V1 sidebar is not included in this release.
6. Inventory old generated skills, wrappers, schema files, manifests, and status files. Remove only files with verified ownership after approval. Do not remove native MCP credentials or recursively delete shared skill/state directories.

The new implementation does not parse V1 configurations, run V1 hooks, or support dual entrypoints. See [research](docs/research/opencode-v2-migration.md), [migration plan](docs/migration-plan.md), and [implementation evidence](docs/implementation.md).

## Development and verification

Use npm and `package-lock.json`; Bun is required only for the native integration harness.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
# Linux x64 defaults to the pinned @opencode/cli executable installed by npm ci.
bun run test:integration
# Other environments can provide a validated executable:
OPENCODE_TEST_BINARY=/path/to/opencode-2.0.23 bun run test:integration
```

`npm run check` runs all gates, including a packed-package installation against an isolated real OpenCode server. The fixture model and MCP server are local; no paid model or user credentials are needed. GitHub is the sole npm release authority; the Gitea mirror validates without publishing.

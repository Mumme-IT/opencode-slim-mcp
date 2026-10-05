# OpenCode V2 migration research for opencode-slim-mcp

## Scope and evidence baseline

This is a findings document, not a migration plan. The requested destination is V2-only: MCP capabilities map to a CLI and on-demand skills. Dual V1/V2 support is out of scope. Architecture recommendations below are explicitly distinguished from verified API facts.

- **Research date:** 2026-10-05. Official V2 documentation and its published OpenAPI document were retrieved on this date. These website URLs are mutable. [D1][D2][D3][D7]
- **Plugin repository baseline:** `4116489a9cdd1e6349319adcc6f3139abb71e248`, package version `0.6.4`. All citations to this repository use that commit. [R1]
- **OpenCode source baseline:** the first-party repository's `v2` branch at `e3c3786f43d01ff05a35eabe92bb396f9872975b`, committed `2026-10-05T12:23:10Z`. The source package declares `@opencode/plugin` version `2.0.23`. **This source snapshot is not proven to be the release build commit.** [S0][S1]
- **Published package baseline:** npm's first-party package records identify `2.0.23` as `latest` for `@opencode/plugin`, `@opencode/client`, and `@opencode/sdk`. Their publication times are respectively `2026-10-05T05:25:03.914Z`, `2026-10-05T05:23:28.308Z`, and `2026-10-05T05:27:37.519Z`. The plugin and client records contain no `gitHead`. Relevant declarations were also inspected in those published tarballs. [N1][N2][N3]
- **Source selection matters:** the repository default `dev` branch and its older `2.0` branch are not substitutes for this V2 documentation's implementation. The selected `v2` snapshot contains `services/www/src/docs/content/build/plugins/index.mdx`, the matching documentation source. [S0][S2]

## Executive findings

1. **A native redesign can remove most of the current integration machinery.** V2 provides replayable MCP configuration transforms, executable tool entries, runtime skill registration, custom RPC, plugin storage, and native CLI service discovery. These are supported extension surfaces, not replacements invented by this research. [D3][D4][D5][D6]
2. **Keep OpenCode in charge of MCP connections and OAuth.** Removing a selected server through `ctx.mcp.transform` also removes its native runtime connection. Instead, keep its server configuration and remove selected tool entries through `ctx.tool.transform`. This separates transport ownership from model exposure. [D3][S3][S4]
3. **The native registry exposes the ingredients for a catalog and executor bridge.** `ToolEditor.list/get` return the full tool definition, including `execute`, schemas, options, and effective `id`. A transform can retain an entry before removing it. Promise adapters explicitly make native executors callable with an `AbortSignal`. However, this does **not** amount to a documented public session-aware tool-dispatch API. [S5][S6][S7]
4. **The critical unresolved boundary is CLI/RPC execution context.** MCP executors enforce native MCP permissions internally, but require the invoking session, agent, message, and tool-call identity. RPC handlers receive cancellation and error helpers, not an authenticated `ToolContext`. A naïve `RPC.call → captured.execute` bridge is not established as permission-, hook-, validation-, history-, or cancellation-equivalent to native dispatch. [S8][S9][S10][S11]
5. **No public direct MCP tool-call endpoint or MCP tool catalog was found.** The documented/public MCP API offers server status, experimental lifecycle operations, and resource catalog access. `ctx.mcp` offers only `list`, `transform`, and `reload`. Internal `Mcp.Service.tools/callTool` exist, but they are not those public APIs. [D7][S12][S13][S14]
6. **V2 already reduces MCP description tokens with Code Mode.** MCP defaults to Code Mode, which advertises a bounded catalog summary and supports further discovery. This is a comparison baseline, not a substitute for the requested CLI-plus-skill mapping. Skills still advertise their own summaries, so “zero idle token cost” is not an accurate unconditional claim. [D8][D9][S15][S16]

## 1. What this repository actually implements

### Intent versus the current runtime

`IDEA.md` describes the requested shape: introspect MCP, generate skills and CLI wrappers, and call through shell. `generate.js` implements that independent generator. By contrast, `README.md` and `index.ts` describe and implement a native `mcp` proxy tool plus skills and a plugin-owned connection pool. The V2 design should preserve the stated CLI-and-skill goal rather than mistake the latest proxy implementation for a requirement. [R2][R3][R4][R5]

The runtime currently reads only project-root and resolved-global `opencode.json` files with `JSON.parse`. It also inspects an earlier plugin's mutable `cfg.mcp`, removes successfully handled entries, and retains failed entries after stripping `slim`. It appends generated skill directories to `cfg.skills.paths`. These behaviors depend on V1's config hook and raw-file conventions. [R4: index.ts L208-L279, L829-L896][R6]

The runtime owns stdio/Streamable HTTP connections, idle timers, introspection, status files, generated skills, schema files, and a manifest. It reads OpenCode's `mcp-auth.json` directly and adapts stored tokens with a read-only OAuth provider. Its `mcp` tool calls the MCP SDK directly and formats content into a string. [R4: index.ts L29-L111, L290-L470, L474-L567, L736-L825]

The current `_confirm` value is deterministic (`slim-${server}`), and the system reminder lists tool names for every enabled server. Neither the implementation nor the generator establishes an actual per-session record proving skill loading. Consequently, the current confirmation token is a workflow hint, not an authorization secret. This conclusion follows from the generated literal and the tool's string comparison. [R4: index.ts L519-L527, L649-L704, L903-L929]

The separate generator reads `mcp-lazy-proxy.json`, starts stdio connections to introspect, writes wrappers and schema/config caches, and opens a new MCP connection for each wrapper call. It does not use the runtime pool. Its generated CLI does not contain native OpenCode permission evaluation. [R5: generate.js L13-L65, L161-L287, L339-L387]

The TUI imports V1 `@opencode-ai/plugin/tui` APIs, reads a state file through untyped SDK calls, polls every `60_000` milliseconds, and listens for an untyped `tool.execute.after` event. It registers `sidebar_content` with order `210`. Package exports already separate `./server` and `./tui`; the installed binary is the generator, not a shared-service execution CLI. [R7][R1]

### Constraints worth revisiting, not silently preserving

- **Recommendation:** Preserve selective handling of MCP servers. Do not take over every configured MCP server by default. Select names in plugin options rather than adding a non-native `slim` field to MCP configuration. Native V2 server schemas do not declare that field. [R3][S17]
- **Recommendation:** Prefer one package CLI that accepts a server and tool, with optional thin aliases. Do not generate independent executable implementations or duplicate connection ownership. The current generator and runtime are separate paths. [R4][R5]
- **Recommendation:** Do not promise current README defaults without deciding them. The README says lazy loading defaults to `true` with `5m` idle shutdown, while `index.ts` defaults to `false` and `60_000` milliseconds when no plugin file is present. Native MCP instead connects servers automatically. [R3: README.md L118-L130][R4: index.ts L160-L204][D8]

## 2. V2-only API mapping specific to this repository

The general and plugin migration guides explicitly state that V1 plugin implementations do not run in V2. V2 uses a default-exported definition with a stable `id` and `setup(ctx)`, not a returned object of V1 hooks. [D1][D2]

- **Entrypoint:** `SlimMcpPlugin: Plugin = async (input) => ...` from `@opencode-ai/plugin` maps to `Plugin.define({ id, setup(ctx) })` from `@opencode/plugin`. Do not add the migration guide's optional V1 `server()` compatibility implementation. [R4: index.ts L829-L950][D2]
- **Directory/project:** `input.directory` maps to `ctx.location.directory`; project metadata lives at `ctx.location.project`. This is the plugin instance's location, not necessarily every accessible session's location. [D2][D3]
- **Custom settings:** `slim-mcp-config.json` is current plugin-owned discovery, not a V2 requirement. V2 plugin configuration accepts `{ package, options }`, read as `ctx.options`. [R4: index.ts L181-L204][D2][D3]
- **Config interception:** `config(cfg)`, `extractCfgMcpEntries`, and `cleanCfgMcp` have no equivalent mutable global config hook. Use MCP transforms for MCP configuration, tool transforms for exposure, and skill transforms for skills. [R6][D2][D3]
- **Tools:** the returned `tool` map and V1 `tool.schema` helper map to synchronous `ctx.tool.transform` edits, JSON Schema or supported schema definitions, and structured execution results. Names, namespaces, and executor shape change. [R4: index.ts L488-L605, L898-L901][D2][S5][S7]
- **System reminder:** `experimental.chat.system.transform` maps to `ctx.session.hook("context", ...)` when a model-visible reminder is still needed. It changes outgoing context, not persisted history. Register additional request-kind hooks only if those request kinds need the same change. [R4: index.ts L903-L945][D2][D3]
- **Connection pool/auth:** native MCP owns connection lifecycle, OAuth, token refresh, schema discovery, timeouts, and session metadata. There is no documented plugin API for an identical lazy-idle-disconnect policy. [R4: index.ts L290-L470][D8][S3]
- **Generated skills:** `writeSkill`, `writeSchemas`, manifest reads, and `cfg.skills.paths` are not prerequisites for runtime skills. `ctx.skill.transform` accepts complete content directly. Files remain useful when skills need actual scripts or reference files. [R4: index.ts L736-L783, L888-L895][D3][S18][S19]
- **Status:** replace `status.json` with `ctx.mcp.list()` for native connection status and plugin RPC for mapping/catalog status. Native states are `connected`, `pending`, `disabled`, `failed`, and `needs_auth`, not the repository's exact old enum. [R7][S17: schema/mcp.ts L69-L97][D4]
- **TUI:** replace `TuiPluginModule`/`tui(api)` with `Plugin.define({ id, setup(context) })` from `@opencode/plugin/tui`. Use `context.ui.slot({ append: "sidebar.content", render })`, location data, and typed events or RPC. There is no documented equivalent numeric order `210` in that slot registration. [R7][D5]
- **Client/embedding:** network integration uses `@opencode/client`. `@opencode/sdk` embeds a separately owned host; it is not the V2 name for a client connected to the current shared service. [D6][D10]
- **Configuration syntax:** `plugin` becomes `plugins`; MCP servers move to `mcp.servers`; `enabled` becomes inverse `disabled`; timeouts become an object; skill sources become an array. The user requests V2-only syntax even though supported V1 config is generally normalized by V2. [D1]

## 3. Native MCP management: verified scope and limits

### Exact plugin surface

The public Promise MCP domain has the following declared shape. `McpApi` supplies the generated list contract. **The list result is an envelope, not a raw array:** the host builds `{ location, data }`. The editor reads configuration tuples, not live tool catalogs. [S13][S20: plugin/host.ts L374-L402][S12]

```ts
interface MCPEditor {
  list(): readonly [string, DeepMutable<Mcp.ServerConfig>][]
  get(name: string): DeepMutable<Mcp.ServerConfig> | undefined
  set(name: string, config: Mcp.ServerConfig): void
  update(name: string, update: (config: DeepMutable<Mcp.ServerConfig>) => void): void
  remove(name: string): void
}

interface MCPDomain extends Pick<McpApi, "list"> {
  readonly transform: Transform<MCPEditor>
  readonly reload: () => Promise<void>
}
```

`disabled: true` prevents connection and disconnects a running server. Removing a server reconciles it out of the runtime. Definitions and connections are different states: registration does not mean startup or catalog discovery has completed. Native startup is asynchronous, and tools from a still-starting server appear later. [D3][D8][S3: mcp/index.ts L488-L578, L663-L668]

**Recommendation:** Keep selected servers registered normally. Intercept their tools rather than deleting or disabling their MCP configurations. This is the only investigated native option that preserves OpenCode's existing transport and OAuth ownership while hiding the mapped tool catalog. It also preserves native prompts/resources, which need an explicit product decision rather than accidental removal. [S4][S12][D8]

### Public MCP catalog/call: negative result, with boundaries

The inspected OpenAPI MCP operations are `mcp.list`, `experimental.mcp.add/remove/connect/disconnect`, and `mcp.resource.catalog`. No MCP `tools/list`, `tools/call`, `mcp.callTool`, or general `tool.execute` HTTP operation is present in that retrieved contract. The plugin MCP domain likewise has no direct catalog or execution method. This is a finding about the reviewed contract, not proof that no future release can add one. [D7][S12][S13]

Internal Core `Mcp.Interface` has `tools()` and `callTool({ server, name, args?, sessionID? })`, among other methods. They are used by OpenCode's own MCP-to-tool adapter. **Do not present `ctx.mcp.callTool`, `client.mcp.callTool`, or `client.tool.execute` as supported calls.** Importing `@opencode/core/mcp` and acquiring Effect services is not established as a supported published-plugin dependency. [S14][S8]

The public server status object contains `name`, a tagged `status`, and optional `integrationID`; it does not contain tool schemas or secrets. OAuth-enabled servers expose their integration identity so clients can act on the right native integration. [S17: schema/mcp.ts L69-L97]

## 4. Tool interception and executor capture

### Exact entries, naming, and removal

The Promise tool API returns executable definitions, not only model descriptions. Its published declarations and the source expose these fields and operations. The context adds `signal` and Promise-based `progress` to the shared tool identity. [S5][S7][N1]

```ts
interface ToolContext {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly messageID: SessionMessage.ID
  readonly id: Tool.CallID
  readonly signal: AbortSignal
  readonly progress: (update: Tool.Metadata) => Promise<void>
}

type Info<
  Input extends Tool.ValueSchema<any> = Tool.ValueSchema<any>,
  Output extends Tool.ValueSchema<any> | undefined = Tool.ValueSchema<any> | undefined,
> = Omit<Tool.Info<Input, Output>, "execute"> & {
  readonly execute: (
    input: Parameters<Tool.Info<Input, Output>["execute"]>[0],
    context: ToolContext,
  ) => Promise<Tool.Result<Output>>
}

interface ToolEditor {
  list(): readonly (Info & { readonly id: string })[]
  get(id: string): (Info & { readonly id: string }) | undefined
  namespace(namespace: Tool.Namespace): void
  add<Input extends Tool.ValueSchema<any>, Output extends Tool.ValueSchema<any> | undefined>(
    tool: Info<Input, Output>,
  ): void
  update(id: string, update: (tool: Types.Mutable<Info>) => void): void
  remove(id: string): void
}
```

The shared `Tool.Info` fields are `name`, `input`, `description`, `execute`, optional `output`, and optional `options`. Options include namespace, permission action, Code Mode selection, and pinned discovery. The options union does not permit `pinned` when `codemode` is explicitly `false`. These schema/editor excerpts use the declarations' referenced types; they are not standalone compilable plugin examples. [S7: schema/tool.ts L27-L42, L92-L102][S5]

MCP's native adapter registers the original MCP tool name and uses the normalized server name as `options.namespace`. The effective registry ID is `<namespace>_<normalized-tool>`. Code Mode uses a dotted/bracket namespace path instead. Tool updates preserve the original name and namespace; remove/get use the effective ID. The namespace and normalized tool names are subject to validation, and the reviewed implementation rejects overlong names. [D3][D8][S8: tool/mcp.ts L16-L17, L40-L48][S21: tool/runtime.ts L274-L279][S4: tool.ts L186-L204, L304-L325]

**Recommendation:** Build a mapping from explicit selected server names to native namespaces and entries. Do not split an effective ID on `_` to recover ownership: both server and tool names can contain underscores. Reject normalization collisions. `ToolInfo` does not include a typed MCP provenance field, so namespace matching alone is not an unforgeable indication that an entry came from MCP; another plugin can use the same namespace. [S5][S7][S8][D8]

Transforms replay in registration order. Later transforms can inspect, update, override, or remove earlier entries. The source test `isolates invalid MCP tools and preserves plugin transforms through catalog updates` proves removals and overrides continue to apply after MCP catalog refresh, and disposal reveals the underlying current definitions again. [D3][S22]

**Evidence-backed feasibility:** An interception transform can obtain a tool entry, retain its executor/schema definition, and remove its model-visible registry entry without changing its MCP configuration. The Promise adapter wraps native Effect executors into Promise executors and passes the caller's `context.signal` to the runtime. [S6: adapter.ts L251-L260, L465-L501][S4: tool.ts L167-L204][S8]

**Important limit:** Each native model request captures an executable snapshot. Later transforms or disposal do not revoke that earlier snapshot. An executor can also close over mutable data. A captured executor must therefore be treated as a versioned capability, not a permanently safe identifier. The reviewed executor ultimately calls the current server connection by name. [D3][S4: tool.ts L225-L286][S8: tool/mcp.ts L64-L70][S3: mcp/index.ts L669-L691]

### What direct executor calls preserve

The native MCP executor itself calls `Permission.assert` with the normalized MCP action, resource `*`, supplied session and agent, and supplied message/call source. It waits for permission before calling the server, forwards the session ID, converts MCP `isError` into failure, and returns native text/file content and structured output. Tests cover permissions, session forwarding, errors, JSON text, and media. Capturing this executor preserves those internal operations **if** the context is correct and the Promise cancellation adapter remains active. [S8][S23][S6]

The underlying native MCP client passes an Effect-derived cancellation signal, configured execution timeout, and `_meta["ai.opencode/sessionID"]` to MCP `tools/call`. This is stronger than the repository's old direct call, which does not forward the OpenCode tool cancellation signal. [S24: mcp/client.ts L317-L363][R4: index.ts L545-L552]

### What direct executor calls bypass

Native dispatch does additional work outside the executor: validates input, normalizes/encodes output, runs `tool.execute.before/after`, normalizes images, and returns a normalized result. The session runner additionally truncates large tool content. The public Promise executor wrapper calls `execute` directly, not `Tool.snapshot.execute` or `tool/runtime.execute`. Thus, RPC-to-executor reuse does **not** automatically retain those outer behaviors. [S21: tool/runtime.ts L28-L60][S4: tool.ts L103-L156, L263-L283][S6: adapter.ts L251-L260][S25: runner/step.ts L88-L132][S26]

**Recommendation:** A bridge needs an explicit input validator for the captured tool's schema and a defined output/error contract. Never rely on JSON validation of the outer RPC request to validate nested MCP arguments. Do not claim native hook/history equivalence unless an integration test proves it or an upstream public dispatch API supplies it. [S10: rpc.ts L108-L141][S21][S6]

### Readiness and refresh gaps

The MCP-to-tool adapter waits for its own initial discovery before registering the source transform, then debounces later catalog updates by `100 millis` and reloads the tool registry. Its `flush` is an internal service, not a method on `ctx.mcp` or `ctx.tool`. There is no public “wait for MCP tool catalog” method in the reviewed plugin surface. [S8: tool/mcp.ts L19-L21, L36-L41, L124-L144][S5][S13]

**Recommendation:** Validate transform ordering against real startup, including servers that connect after plugin setup. Do not take one `ctx.tool.list()` snapshot in `setup` and assume it is complete. Ensure interception sits after the native MCP source transform and continues to capture refreshed entries. Do not import internal `flush` merely to make a prototype appear ready. [S8][S22][D3]

Transforms must stay synchronous, cheap, and replayable; external data is loaded before registration, and domain `reload()` invalidates captured inputs. Generating files, registering skills asynchronously, or emitting events inside a tool transform conflicts with that contract. [D2][D3][S27]

**Recommendation:** Keep interception a repeatable projection of tool entries. Publish generated skill/catalog changes outside the transform. A reconciler may use native MCP events or bounded status polling, but must tolerate the adapter's later debounce and avoid a `tool.reload → skill.reload → tool.reload` cycle. This exact cross-domain reconciliation pattern has not been established by an upstream example and is a validation gate. [S8][S27]

## 5. RPC and the permission/security boundary

### Supported transport and handler shape

`Rpc.define` from `@opencode/plugin/rpc` declares method inputs/outputs/errors and object-valued events. `ctx.rpc.register(contract, handlers)` registers an implementation. Promise handlers receive `{ signal, error }`; registration supports disposal and event emission. RPC is location-scoped, and the HTTP handler waits for that location's plugin activation. [D4][S9][S10][S11]

An external client imports the shared contract and calls a typed RPC method with a separate request-options object. That object can contain `location`, `signal`, and `headers`. Generic HTTP clients use `POST /api/rpc/{rpcID}/{method}` with `{ "input": ... }`, receiving `{ "output": ... }`. Omitting location falls back to native request defaults, not necessarily the shell's desired project. [D4][D6][S28]

```ts
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { SlimMcp } from "opencode-slim-mcp/rpc"

const endpoint = await Service.ensure()
const client = OpenCode.make({
  baseUrl: endpoint.url,
  headers: Service.headers(endpoint),
})

// SlimMcp and catalog are proposed plugin-owned contract names, not native APIs.
const slim = client.rpc(SlimMcp)
const result = await slim.catalog(
  { server: "todoist" },
  { location: { directory: process.cwd() }, signal: controller.signal },
)
```

The connection portion of this example is documented. `SlimMcp.catalog` is illustrative future plugin functionality and is **not implemented or provided by OpenCode**. [D6]

### Why a naïve executable RPC is unsafe to ship

An RPC request does not become an OpenCode model tool call merely because it runs in a plugin. The reviewed RPC dispatcher validates its own contract and invokes its handler. It has no built-in session permission assertion or tool identity. The HTTP handler similarly does not obtain `ToolContext`. [S10: rpc.ts L108-L141][S11][S9]

The native MCP executor requires `sessionID`, `agent`, `messageID`, and call `id`; its source assertion uses those values. A caller-supplied session ID is not authentication, and native MCP documentation explicitly warns against using session metadata for authorization. Passing guessed IDs or an arbitrary agent risks applying the wrong permission rules and producing false audit attribution. [S7][S8][D8][S29: permission.ts L158-L188]

There is one useful native foothold: the shell tool sets `OPENCODE_SESSION_ID` in the child environment. However, it does not also provide the full tool identity. The public `shell.create.before` hook exposes command, working directory, timeout, shell, and environment, but not session, agent, message, or call IDs. The inspected tool hooks do contain those identities, but not a per-invocation signal. [S30: shell.ts L196-L217][S31][S5: promise/tool.ts L38-L63]

**Recommendation:** Treat `OPENCODE_SESSION_ID` as correlation only. Any executable RPC must derive or verify the session against the requested location and bind execution to a valid invocation. It must not accept an unchecked agent override or pretend a static confirmation token is permission. If a capability is introduced, make it short-lived, scoped to location/session/invocation, revocable, and protected against replay. The mechanism is plugin design work, not a native guarantee. [S7][S8][S30][D8]

**Do not assume `ctx.permission.assert` exists.** The published Promise plugin permission domain contains only native `list`, `get`, `reply`, and the `evaluate` hook. There is also no `ctx.permission.rules` in the reviewed `2.0.23` declarations, despite that method appearing in the website overview. [S32][N1][D3]

The public HTTP API does expose `POST /api/session/{sessionID}/permission` (`session.permission.create`). It calls native `permission.ask`, which evaluates rules and creates a pending request when needed, then returns `{ id, effect }`. It is not the same as `assert`, which waits on approval. Reimplementing an assertion through this endpoint needs denial handling, approval waiting, rejection semantics, cancellation, and cleanup; it does not automatically solve RPC invocation identity. [D7][S33: handlers/permission.ts L39-L58][S29: permission.ts L223-L259]

**Recommendation:** Preserve the captured native MCP executor's permission assertion rather than independently copying policy evaluation. Avoid auto-replying to permission requests, overriding permission hooks to allow calls, or treating permission to run the CLI as permission for every MCP action. Native shell permission and native MCP permission are separate actions. [S8][D11]

### Cancellation and output are separate gates

RPC Promise handlers receive an `AbortSignal`; captured native Promise executors accept another signal, so passing the RPC signal is mechanically supported. Location invalidation also interrupts a long-running RPC. However, linking session interruption to an RPC that originates in a shell child is not documented as automatic. The CLI must propagate process termination and abort its request; the server must not continue an MCP side effect after the invoking session is stopped. [D4][S6][S9][S10: rpc.ts L132-L137][S24]

**Recommendation:** Verify permission rejection, session interruption, CLI `SIGINT`/`SIGTERM`, HTTP disconnect, and plugin unload before allowing mutations. Cancellation is not a guarantee of rollback after an external service has acted. Do not retry uncertain mutating MCP calls automatically. This is a safety requirement, not a discovered native retry guarantee.

Returning JSON through shell preserves text, not automatic model-visible native `Tool.FileContent`. Native MCP supports structured output and media, while native tool dispatch normalizes images and bounds content. A CLI needs a declared representation for text, structured JSON, attachments, errors, and large output. [S8][S7][S4][S26][R5: generate.js L234-L243]

**Recommendation:** Keep typed results in RPC, reserve stdout for machine output, and send diagnostics to stderr. Define exit status for MCP errors and authorization rejection. Return references to bounded artifacts for binary output; do not claim that printing a data URI through shell renders an image as native MCP does. [S7][S8][S26]

## 6. Client choice: service discovery, remote connections, and embedding

`@opencode/client/service` is the native Node service-management entrypoint. `Service.discover()` finds a healthy registered endpoint without starting a process; `ensure()` can start one; `headers(endpoint)` supplies its authentication headers. `ensure` can require an exact version or compatibility predicate and accepts a custom registration file and service command. [D6][S34][N2]

**Recommendation:** Use `@opencode/client` for the execution CLI. Decide explicitly whether to discover-only or ensure/start. Do not always call `ensure` when the user selected a remote server or a standalone private service: that can connect to a different instance than the TUI. Explicit server URL/authentication options should take precedence, and the CLI should send an explicit location. [D6][D7][D5]

`@opencode/sdk` hosts OpenCode in the application, routes requests through an in-memory HTTP router, and opens no listener. Its host owns Location services and plugin scopes and must be closed. Starting this in each CLI invocation would create a host, not attach to the currently running service. This distinction makes embedding a poor default for preserving an existing MCP connection and permission interaction. [D10]

**Recommendation:** Do not migrate old `@opencode-ai/sdk` assumptions to `@opencode/sdk` by a package rename. Keep SDK embedding as a separate explicit architecture option only if the product intentionally owns a separate host. [D1][D6][D10]

## 7. Native skills: content, path, advertising, and lifecycle

The native skill definition requires `id`, `name`, absolute `path`, and `content`; `description` and `autoinvoke` are optional. `ctx.skill.transform` can add/update/remove it directly. The registry stores the supplied content; the skill tool loads that content after its native skill permission check rather than rereading a required `SKILL.md` body. [S18][S19][S35]

```ts
await ctx.skill.transform((editor) => {
  editor.add({
    id: "mcp-todoist",
    name: "Todoist MCP",
    description: "Use Todoist through the slim-mcp CLI.",
    path: "/plugin-owned/skills/mcp-todoist.md",
    content: "Plugin-generated CLI instructions and tool reference.",
  })
})
```

This shows the documented registration shape, not a requirement that `/plugin-owned` be a real universal location. OpenCode itself registers built-in skills at virtual paths such as `/builtin/opencode.md`. The path determines the reported base directory. If its basename is `SKILL.md`, skill preparation scans that directory to sample supporting files; a flat Markdown basename avoids that scan. Real relative resources therefore need a real controlled directory. [D3][S36: plugin/skill.ts L27-L44][S19: skill.ts L36-L67]

For filesystem discovery, IDs derive from paths; frontmatter `name` is a display label. Explicitly registered skills have their explicit `id`. Advertised skills require a description, must not set `autoinvoke: false`, and must pass skill visibility rules. The model sees IDs, names, and descriptions, not full bodies. `skill` loads by `{ id }`. [D9][S18][S16][S35]

**Recommendation:** Register one short skill summary per mapped server and load its detailed CLI/tool reference on demand. Do not inject every tool name into `context` as the current runtime does. Consider further per-tool detail through CLI `schema` rather than making one skill body enormous. Reject duplicate/colliding generated skill IDs. [R4: index.ts L903-L929][D9][S16]

**Permission distinction:** skill permissions govern skill advertising/loading; MCP permissions govern executable calls. Loading a skill does not authorize an MCP mutation. Conversely, hiding a skill is not enough to secure an exposed executable RPC. [D9][D11][S35][S8][S10]

Registration disposal and plugin unload remove runtime transforms. Captured source inputs are not watched automatically; call `ctx.skill.reload()` after those inputs change. Config-directory changes can reload plugins, but unwatched dependencies may require a service restart. [D3][D12][S27]

**Recommendation:** Prefer runtime skills over a globally wiped generated directory. If actual scripts/reference files are needed, use a plugin-owned, location-separated directory and manifest-based ownership checks. Never repeat the current broad removal of generated skill/schema trees in a shared global path across unrelated Location instances. [R4: index.ts L843-L868][S20][D3]

## 8. Configuration, Location scope, storage, and status refresh

V2 supports JSONC and discovers configuration through all ancestors to the filesystem root. Direct configs merge from farthest to nearest; discovered `.opencode` configs merge afterwards. Project MCP overrides replace the whole same-name server object. The current two-file `JSON.parse` reader cannot reproduce this behavior. [D13][D8][R4: index.ts L208-L279]

**Recommendation:** Let native configuration and MCP transforms supply resolved server definitions, including definitions from earlier plugins. Put selection and bridge behavior in `ctx.options`. Do not copy raw config parsing, credential paths, or V1 config-field stripping into V2. [D2][D3][S20: plugin/host.ts L374-L402][S17]

The reviewed native config MCP adapter reads normalized `Config.Document` entries, merges global timeouts, registers servers, and reloads on `config.updated`. This is existing first-party configuration machinery the plugin can leave intact. [S37]

`ctx.location` identifies one plugin instance. Registry services and RPC are Location-scoped. By contrast, plugin storage is keyed by **plugin ID only** in a global KV service: the host storage prefix has no directory/project component. Therefore, `ctx.storage` must not be assumed automatically per-project or per-location. [D3][S20: plugin/host.ts L602-L629][S38: kv.ts L92][S10: rpc.ts L35-L40]

**Recommendation:** Use Location-owned in-memory state for executors and live connections. Use explicit directory/workspace/account identity in durable cache keys. Persist only JSON metadata, not executor functions, OAuth tokens, server environment variables, or raw headers. Do not use a same-name server in two projects as the same cache identity. [S20][S38][D8]

RPC events are live-only. External subscribers receive events across locations and must filter `event.location`. The Promise client shares one lazy native/RPC event connection, with no replay or automatic reconnection after source failure. [D4][D6]

**Recommendation:** Expose an authoritative status/catalog read RPC plus a lightweight changed event. A TUI should fetch status after subscription, filter by its current location, and refetch after reconnect. Use native `context.data.location.mcp.server` for connection state; use plugin RPC only for mapping-specific state. Do not poll a server filesystem file from the TUI. [D5][D4][D6][R7]

Cleanup functions own timers, subprocesses, sockets, and subscription controllers. Hook/transform registrations are automatically scoped. Files written by a plugin are not automatically removed by registration disposal. [D2][D3][S27]

**Recommendation:** Cleanup should abort reconciliation and calls, revoke captured capabilities, close subscriptions, and stop plugin-owned resources. Keep persistent cache retention and legacy-artifact cleanup explicit and ownership-aware; never delete unrelated files merely because a directory has the expected historical name. [R4: index.ts L713-L733][D2]

## 9. Native Code Mode as the token-saving baseline

MCP config defaults `codemode` to `true`; `false` exposes tools directly. Code Mode keeps normal permissions on nested tools and lets JavaScript combine calls without putting every intermediate output into context. [D8][D14][S4]

The inspected catalog summary uses `INLINE_BUDGET = 2_000`, estimates tokens as characters divided by `4`, limits a tool's first-line description to `120` characters, and attempts to keep namespaces visible while selecting representative entries. This is an implementation heuristic, **not an exact token guarantee or hard cap on every namespace description**. More definitions can be discovered with Code Mode's search functionality. [S15: codemode/catalog.ts L48-L126][S39: codemode/tool.ts L60-L68, L73-L108]

**Recommendation:** Benchmark the native default before attributing all gains to slim mapping. Compare native direct MCP, native default Code Mode, and CLI-plus-skill mapping on identical servers, requests, and models. Measure advertised context, discovery turns, loaded skill size, and output—not only JSON Schema count. [D8][S15][D9]

Removing selected tool entries suppresses their direct/Code Mode tool definitions, but does not remove native MCP server instructions. The MCP instruction renderer derives guidance from the internal MCP inventory and permissions, not the transformed tool registry, and can still tell the model to use `execute` under that server namespace. This is both residual context cost and potentially wrong guidance after hiding the tools. [S40: mcp/instructions.ts L17-L24, L81-L105]

**Recommendation:** Treat native server instructions as a validation gate. Avoid a blanket system override based on assumptions about rendering. Decide whether selected MCP instructions must be included in generated skill bodies, suppressed through a verified public context change, or addressed upstream. The current reviewed public plugin context provides no dedicated MCP-instruction transform. [S40][S41]

**Token-cost conclusion:** CLI-plus-skill mapping can remove mapped tool descriptions from the persistent catalog, while retaining short discovery summaries. It cannot honestly claim that enabled skill discovery, loaded skill bodies, native MCP instructions, shell descriptions, and RPC/CLI output all cost zero tokens. [D9][S16][S40][D14]

## 10. Architecture options and research decision

### Option A — Native MCP ownership, tool interception, runtime skills, CLI-to-RPC

**Recommendation: preferred research direction, conditional on safety gates.** Native MCP owns transport/auth/catalog refresh. A later tool transform captures selected executable entries and removes them from advertised tool catalogs. Runtime skills document a package CLI. The CLI connects through `@opencode/client` to plugin RPC. This uses the investigated native extension seams and preserves the requested UX. [D3][D4][D6][S6][S8][S22]

The unresolved part is a trustworthy, cancellable invocation context for executable RPC, plus validation and handling of behaviors outside the captured executor. Catalog/status RPC and native skill registration are supported; **production-safe executable RPC is not proven by those APIs alone**. [S7][S9][S10][S21][S25]

### Option B — Plugin-owned MCP client/daemon with CLI and runtime skills

**Recommendation: explicit fallback only if native execution cannot pass the gates.** This resembles the current pool or generator, but would retain duplicate transport/auth/catalog ownership. It must not read native credential files or silently claim native MCP permission equivalence. The existing repository demonstrates such ownership, while the supported native MCP API does not expose direct transport reuse. [R4][R5][S13][S14]

A separately documented shell-only authorization model is a product/security change, not an equivalent port. Preserving native per-tool approval would require a supported permission bridge and reliable session identity; the public permission-create endpoint alone is not a waiting assertion. [D11][S33][S29]

### Option C — Native Code Mode plus skills, without an execution CLI

**Recommendation: benchmark/reference or an explicitly approved scope change, not the requested destination.** This retains native execution context, permissions, cancellation, media, and hooks, while reducing advertised schemas. It does not satisfy the user's explicit CLI mapping. [D8][D14][S4][S8]

### Option D — Upstream public session-aware dispatch API

**Recommendation: request upstream support if Option A's safety boundary cannot be completed cleanly.** A public dispatch operation that executes a selected native tool under verified session/invocation context would remove much of the bridge uncertainty. No such operation was found in the reviewed API. Its existence must be verified before a future plan depends on it. [D7][S12][S13][S5]

### Decision boundary

Proceed with native catalog/skills/client/RPC feasibility as Option A. Do not equate executor availability with a safe execution service. Block mutating CLI execution until identity, native permission enforcement, cancellation, and output semantics pass the gates below. If those gates fail, choose an explicit fallback/security scope change or upstream API work; do not conceal it behind V1-shaped pool code.

## 11. Packaging and native CLI/TUI separation

The V2 package host resolves a server entry from `./server` first, then the root export, and separately resolves `./tui` and `./rpc`. A server module must default-export an `id` plus `setup` or `effect`. A CLI plugin uses `@opencode/plugin/tui`, and a package's `./tui` export supports automatic CLI loading alongside its main plugin. CLI-only plugins use global `cli.json` with `plugins`; V1 layered `tui.json(c)` is not the native V2 configuration. [S42][S43][D5][D1]

The CLI reads the active server plugin list from the connected server and automatically loads its TUI components, including with a remote server. Adding the same server/TUI package again to `cli.json` is not required. `cli.json` is for independently configured CLI-only extensions. [D15]

**Recommendation:** Keep ESM exports for root/server, add a lightweight `./rpc` contract export, preserve `./tui` as an optional terminal extension, and add a real execution/catalog CLI binary. The RPC contract must be importable without executing server setup. This is a packaging proposal, not a requirement to keep the current filenames. [R1][D4][S42]

The published V2 plugin dependency is `@opencode/plugin`, not `@opencode-ai/plugin`. The current CLI-plugin docs illustrate OpenTUI peers `>=0.5.8`, while the inspected `2.0.23` source package lists `>=0.5.14`. This is a real version-detail discrepancy; test and pin against the shipped target instead of preserving the repository's `>=0.2.6` assumptions or copying a broad `latest` range. [D5][S1][R1][N1]

**Recommendation:** Align `@opencode/plugin` and `@opencode/client` with the validated OpenCode release. Externalize runtime-provided UI dependencies when building JSX. Verify the installed npm tarball, root/server/TUI/RPC exports, Node CLI imports, and bin executable permissions—not only a source-linked development copy. V2's own migration verification guidance explicitly requires testing the installed published package. [D2][D5][N1][N2]

**Recommendation:** Remove the current postbuild copy into `.opencode/plugins` from normal package publication if it causes duplicate local/package loading. Keep development installation explicit. The current package's `postbuild` creates that copy; V2 automatically discovers files in `.opencode/plugins`. [R1: package.json L43-L48][D12]

## 12. Hard blockers, risks, and validation gates

These are validation requirements and unresolved questions, not implementation tickets.

### Release blockers

1. **Invocation identity:** Show how a CLI call acquires a valid session, location, agent, message, and call source without trusting arbitrary caller values. `OPENCODE_SESSION_ID` alone is insufficient. Test two concurrent sessions, a subagent, a moved session, and a human terminal call without session context. [S7][S8][S30][D8]
2. **Permission parity:** Demonstrate native MCP `deny`, `ask`, allow-once, allow-always, rejection with feedback, agent-specific rules, saved approvals, and policy denial. Prove that a shell allow rule does not bypass MCP denial. Captured MCP executors assert permission; RPC itself does not. [S8][S29][S10][D11]
3. **Cancellation parity:** Stop an RPC during native permission waiting and during MCP execution. Interrupt the session and kill the CLI. Confirm that no orphan operation, pending approval, or server task remains. Signals exist, but the full CLI/session chain is not a documented integrated path. [S6][S9][S24][S29]
4. **Registry readiness and refresh:** Start with no catalog, then connect/authenticate a server; add/remove/change tools; disable/remove/reconfigure the server; unload/reload the plugin. Confirm native tools never leak back into future advertised catalogs and stale captured calls cannot target an unintended replacement. Test actual startup order rather than only tests that await internal `flush`. [S8][S22][S3][D3]
5. **Validation and output:** Reject invalid nested MCP parameters before calling the server. Preserve MCP errors and distinguish permission rejection from a successful text response. Define structured output, media, large output, truncation, and audit/history semantics. Direct executor reuse bypasses native outer dispatch. [S21][S4][S25][S26]

### Additional material risks

- **Scope collision:** Same server name in different projects, normalized namespace collisions, and shared plugin storage keys must not cross-contaminate executors, schema caches, skills, or accounts. [S17][S20][S38][D8]
- **Provenance/ordering:** Namespace matching can include a different plugin's tool, and later plugins may override a selected definition. Decide which transformed executor is authoritative and reject ambiguous ownership. [S5][S22][D3]
- **Residual native guidance:** Server instructions can still advertise hidden Code Mode paths. Confirm that model-visible context points only to the selected CLI workflow. [S40]
- **Catalog secrecy:** `ctx.tool.list()` is a registry read, not an agent-filtered snapshot. Decide how catalog/status/schema RPC limits visibility for agents that cannot execute a tool. Do not expose private tool descriptions merely because execution would later be denied. [S4: tool.ts L221-L235][S8]
- **Schema quality:** Native tools can carry JSON Schema, Standard Schema, or Effect schemas. The public entry is not guaranteed to contain a plain `inputSchema` object. Decide how skill/CLI schema output handles each supported shape without importing internal conversion helpers. [S5][S7][S21]
- **Remote/private service selection:** Test global/project plugin loading, a remote server, managed service, and standalone private server. Service discovery must not silently select a different service than the invoking TUI. [D5][D6]
- **Refresh delivery:** Recover from missed RPC events and event-stream failures through authoritative rereads. Native/RPC subscriptions are live-only. [D4][D6]
- **Skill path/resources:** Test virtual flat skill paths, real `SKILL.md` directories, relative references, skill denial, duplicate IDs, and generated content changes. [S18][S19][S35][D9]
- **Credential hygiene:** Do not retain the old native credential-file reader. Test OAuth through native integration management and confirm that RPC status/schema output and caches contain no tokens or environment/header values. [R4: index.ts L34-L111][D8][S17]
- **Token claims:** Quantify savings against default Code Mode and include short skill summaries, native MCP guidance, discovery turns, and output. Do not publish “zero idle tokens” without a narrow definition and measured evidence. [S15][S16][S40][R3]
- **Installed-package parity:** Verify the actual target `2.0.23` declarations and runtime. The pinned source postdates package publication, and the docs have permission-method and UI peer-version differences. [S0][N1][N2][S32][D3][D5]

## 13. Explicit gaps and confidence limits

- **Verified:** native MCP configuration/status; tool entry inspection and removal; callable Promise executors; native permission checks inside MCP executors; runtime skill content; RPC registration/call/events; native service discovery; V2 server/TUI exports. [S13][S5][S6][S8][S18][D4][D5][D6]
- **Not verified:** a complete supported CLI-to-captured-executor design that binds full tool identity, preserves hooks/validation/history, and stops with the invoking session. No end-to-end prototype or OpenCode runtime test was run during this research. The source is sufficient to identify the missing contracts, not to claim a validated bridge. [S7][S10][S21][S25]
- **Not found in the reviewed public contract:** direct MCP call/catalog or session-aware native tool-dispatch methods. Internal methods are not evidence that the corresponding `ctx` or generated client calls exist. [D7][S12][S13][S14]
- **Docs/source discrepancy:** the plugins overview includes `ctx.permission.rules`, while the published plugin declarations expose only list/get/reply plus a hook. Some overview examples omit generated response envelopes; source and OpenAPI show `.data`. Treat package declarations and the target server's `/openapi.json` as validation inputs, not a guessed reconciliation. [D3][S32][S20][D7][N1]
- **No migration plan is included.** The parent session can use these findings to select an architecture and sequence work after resolving the stated gates.

## Sources

All sources are first-party documentation, first-party repository code, this repository's own code, or official npm metadata for the first-party packages. Source links below are commit-pinned. Labels with a location suffix refer to the same pinned file at those lines.

### Official V2 documentation

- [D1] https://opencode.ai/v2/docs/migrate-v1 — breaking changes, config and plugin migration, client and CLI settings.
- [D2] https://opencode.ai/v2/docs/build/plugins/migrate-v1 — entrypoint, API mapping, transforms, lifecycle, verification.
- [D3] https://opencode.ai/v2/docs/build/plugins — complete plugin domains, transforms, tools, skills, storage, hooks.
- [D4] https://opencode.ai/v2/docs/build/plugins/rpc — contracts, registration, cancellation, transport, events.
- [D5] https://opencode.ai/v2/docs/build/plugins/cli — TUI context, slots, data, package exports and peers.
- [D6] https://opencode.ai/v2/docs/build/client — generated client, RPC location/options, events, service discovery.
- [D7] https://opencode.ai/v2/docs/api and https://opencode.ai/v2/openapi.json — retrieved public HTTP contract and schemas.
- [D8] https://opencode.ai/v2/docs/mcp-servers — native config, connection ownership, OAuth, Code Mode, context metadata.
- [D9] https://opencode.ai/v2/docs/skills — discovery, IDs, summaries, loading, resources, permissions.
- [D10] https://opencode.ai/v2/docs/build/sdk — embedded host ownership versus network client.
- [D11] https://opencode.ai/v2/docs/permissions — native actions, rules, approvals and policy boundaries.
- [D12] https://opencode.ai/v2/docs/plugins — discovery, ordering, automatic reload, terminal configuration.
- [D13] https://opencode.ai/v2/docs/config — JSONC, configuration locations and merge order. Its link to the unversioned editor schema was not used to infer V2 shapes.
- [D14] https://opencode.ai/v2/docs/tools — shell, skills, Code Mode and nested permissions.
- [D15] https://opencode.ai/v2/docs/cli/plugins — automatic loading from the connected server, remote behavior and CLI-only configuration.

### This repository at the reviewed baseline

- [R1] https://github.com/Mumme-IT/opencode-slim-mcp/blob/4116489a9cdd1e6349319adcc6f3139abb71e248/package.json#L1-L80
- [R2] https://github.com/Mumme-IT/opencode-slim-mcp/blob/4116489a9cdd1e6349319adcc6f3139abb71e248/IDEA.md#L1-L52
- [R3] https://github.com/Mumme-IT/opencode-slim-mcp/blob/4116489a9cdd1e6349319adcc6f3139abb71e248/README.md#L1-L174
- [R4] https://github.com/Mumme-IT/opencode-slim-mcp/blob/4116489a9cdd1e6349319adcc6f3139abb71e248/index.ts#L1-L950
- [R5] https://github.com/Mumme-IT/opencode-slim-mcp/blob/4116489a9cdd1e6349319adcc6f3139abb71e248/generate.js#L1-L392
- [R6] https://github.com/Mumme-IT/opencode-slim-mcp/blob/4116489a9cdd1e6349319adcc6f3139abb71e248/config-utils.ts#L1-L108
- [R7] https://github.com/Mumme-IT/opencode-slim-mcp/blob/4116489a9cdd1e6349319adcc6f3139abb71e248/tui.tsx#L1-L155

### OpenCode source snapshot

- [S0] https://api.github.com/repos/anomalyco/opencode/commits/e3c3786f43d01ff05a35eabe92bb396f9872975b — exact source revision and commit date.
- [S1] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/plugin/package.json#L1-L72 — package name, version, exports and peers.
- [S2] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/services/www/src/docs/content/build/plugins/index.mdx — corresponding documentation source; repository metadata: https://api.github.com/repos/anomalyco/opencode; comparison branch snapshots: https://github.com/anomalyco/opencode/tree/907b3bc518fa48e90e8ec24dd327d13eee71c36c (`dev`) and https://github.com/anomalyco/opencode/tree/7a6ce05d0939826aa6c8e1c481489a713b2d633f (`2.0`).
- [S3] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/mcp/index.ts#L488-L691 — reconciliation, startup, inventory and calls.
- [S4] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/tool.ts#L103-L325 — registry edits, snapshots, dispatch and validation of registrations.
- [S5] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/plugin/src/promise/tool.ts#L1-L72 — full executable entries, context, editor and hooks.
- [S6] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/plugin/src/promise/adapter.ts#L251-L260 and #L465-L501 — native executor adaptation; #L620-L626 for Promise tool signal/progress.
- [S7] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/schema/src/tool.ts#L14-L102 — required identity, options, result/content and schemas.
- [S8] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/tool/mcp.ts#L13-L144 — MCP registry adapter, permission assertion, results and refresh.
- [S9] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/plugin/src/promise/adapter.ts#L119-L157 — Promise RPC handler context.
- [S10] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/rpc.ts#L35-L173 — location scope, schema boundary, invocation and invalidation.
- [S11] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/server/src/handlers/rpc.ts#L8-L33 — HTTP-to-RPC dispatch.
- [S12] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/protocol/src/groups/mcp.ts#L8-L103 — full public MCP HTTP group.
- [S13] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/plugin/src/promise/mcp.ts — public MCP plugin domain.
- [S14] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/mcp/index.ts#L113-L139 — internal tools and callTool interface.
- [S15] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/codemode/catalog.ts#L48-L139 — summary budget, token estimate and selection.
- [S16] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/skill/instructions.ts#L9-L33 and #L73-L89 — model-visible summaries.
- [S17] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/schema/src/mcp.ts#L7-L97 — native configs, status and integration identity.
- [S18] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/schema/src/skill.ts#L26-L34 — native Skill.Info fields.
- [S19] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/skill.ts#L33-L125 — preparation, paths, content, editor and registry.
- [S20] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/plugin/host.ts#L374-L467 and #L602-L629 — native context domains, envelopes and storage namespace.
- [S21] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/tool/runtime.ts#L28-L164 and #L274-L279 — input/output boundary and effective naming.
- [S22] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/test/mcp.test.ts#L2109-L2230 — transforms persist across catalog updates.
- [S23] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/test/mcp.test.ts#L2320-L2540 — native session forwarding, outputs, failures, media and permission waiting.
- [S24] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/mcp/client.ts#L317-L363 — signal, timeout and session metadata.
- [S25] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/session/runner/step.ts#L88-L132 — dispatch and output truncation.
- [S26] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/tool-output.ts#L13-L117 — output bounds, managed file and metadata.
- [S27] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/state.ts#L172-L250 — synchronous replay, scoped disposal and reload.
- [S28] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/client/src/promise/rpc.ts#L96-L116 — RPC input/output and request location/options.
- [S29] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/permission.ts#L158-L259 — native rules, ask versus assert, waiting and cleanup.
- [S30] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/tool/plugin/shell.ts#L188-L217 — native shell child session environment.
- [S31] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/plugin/src/promise/shell.ts#L1-L17 — shell hook context.
- [S32] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/plugin/src/promise/permission.ts#L1-L24 — public plugin permission domain.
- [S33] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/server/src/handlers/permission.ts#L39-L84 — permission-create and reply HTTP behavior.
- [S34] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/client/src/promise/service.ts — published service wrapper implementation.
- [S35] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/tool/plugin/skill.ts#L38-L66 — skill permission and supplied body.
- [S36] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/plugin/skill.ts#L27-L44 — embedded skills with virtual paths.
- [S37] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/config/plugin/mcp.ts#L17-L57 — native config contribution and reload.
- [S38] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/kv.ts#L27-L92 — JSON persistence and global service scope.
- [S39] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/codemode/tool.ts#L60-L108 — executable catalog and search instruction.
- [S40] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/mcp/instructions.ts#L17-L24 and #L81-L105 — guidance independent of transformed tool registry.
- [S41] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/plugin/src/promise/plugin.ts#L26-L54 — complete public context domains.
- [S42] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/plugin/src/host.ts#L17-L43 — server/TUI/RPC export resolution.
- [S43] https://github.com/anomalyco/opencode/blob/e3c3786f43d01ff05a35eabe92bb396f9872975b/packages/core/src/plugin/module.ts#L60-L73 and #L94-L131 — default definition validation and entrypoint metadata.

### Published package metadata and declarations

- [N1] https://registry.npmjs.org/@opencode%2fplugin and https://registry.npmjs.org/@opencode%2fplugin/2.0.23 — tags, publication time, exports and tarball. Inspected tarball locations: `package/dist/promise/tool.d.ts`, `mcp.d.ts`, `permission.d.ts`, and `plugin.d.ts`. Tarball integrity: `sha512-xk59WBQ4HcX5V2nNrPpy1/4zeaL5hA4/qDxdWIR5ryVWCJ7yctjWVTgPoRnOFKHK7pvIxhpdioYzpDY073i3qA==`.
- [N2] https://registry.npmjs.org/@opencode%2fclient and https://registry.npmjs.org/@opencode%2fclient/2.0.23 — tags, publication time, exports and tarball. Inspected `package/dist/promise/service.d.ts`. Tarball integrity: `sha512-tHfYu7sKNxFu2dZ7Pu5vZG4T8GHqU71ZCsXHZ/RoI0LLdG7t2zwePHWR9aNbcSP+jDUGyaQlzr5utC9Uduczvg==`.
- [N3] https://registry.npmjs.org/@opencode%2fsdk and https://registry.npmjs.org/@opencode%2fsdk/2.0.23 — tags, publication time and exports.

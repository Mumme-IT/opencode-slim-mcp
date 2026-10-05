# V2-only migration plan

## Destination

Replace the V1 implementation with a native OpenCode V2 plugin. Preserve the product goal, not its current internal design:

1. Map explicitly selected MCP servers to a CLI.
2. Advertise short skills that teach the CLI workflow on demand.
3. Keep selected MCP tool descriptions and schemas out of the persistent model catalog.
4. Keep OpenCode responsible for MCP connections, authentication, permissions, and cancellation wherever the public interfaces support this.

There is no V1 runtime, compatibility entrypoint, dual configuration parser, or legacy proxy-tool mode in the destination. This plan does not authorize implementation or changes to user configuration.

**Research:** [OpenCode V2 migration findings](research/opencode-v2-migration.md). Research date: 2026-10-05. Repository baseline: `4116489a9cdd1e6349319adcc6f3139abb71e248`, plugin version `0.6.4`. The first validation target is OpenCode and native packages `2.0.23`. Research distinguishes that published package from the later inspected source snapshot; runtime validation must resolve differences.

## Architecture decision

**Choose native MCP ownership, tool interception, runtime skills, and a CLI connected to plugin RPC. Treat executable RPC as conditional, not already solved.**

The intended execution path is:

```text
OpenCode native configuration
  -> native MCP connections, OAuth, and catalog updates
  -> plugin tool transform captures selected entries and hides their definitions
  -> plugin registers short, on-demand skills

Agent loads skill
  -> native shell runs the slim-mcp CLI
  -> @opencode/client connects to the same OpenCode instance and Location
  -> plugin RPC validates the invocation and arguments
  -> captured native MCP executor checks native MCP permission
  -> native MCP connection executes the request
  -> CLI returns bounded output through shell
```

The last four steps require a feasibility proof. The public interfaces expose executable tool definitions, but no public session-aware tool-dispatch method. RPC does not supply a native tool invocation identity. Calling an executor also bypasses parts of native dispatch. See research sections 4–6 and 12.

### Responsibilities

- **OpenCode owns:** resolved configuration, MCP connections, OAuth and token refresh, native catalog updates, native MCP execution timeouts, and native permission assertions inside MCP executors.
- **The plugin owns:** explicit server selection, catalog projection, runtime skills, its RPC contract, invocation binding, CLI serialization, mapping status, and cleanup of plugin-owned work.
- **The CLI owns:** arguments, correct endpoint and Location selection, request cancellation, stdout/stderr separation, and exit status. It does not launch a second MCP client.
- **The optional TUI owns:** presentation. It does not read plugin state files or own MCP lifecycle.

Use `@opencode/plugin` for the server plugin and `@opencode/client` for the CLI. Do not embed `@opencode/sdk` in each CLI process: embedding creates a host rather than attaching to the existing one. See research sections 2 and 6.

### Hard limits

Do not ship any of these shortcuts:

- Importing private `@opencode/core` MCP or tool dispatch internals.
- Inventing `ctx.mcp.callTool`, `client.mcp.callTool`, `client.tool.execute`, or `ctx.permission.assert`.
- Trusting arbitrary caller-supplied session, agent, message, or tool-call IDs.
- Treating `OPENCODE_SESSION_ID`, a loaded skill, or shell approval as MCP authorization.
- Reading OpenCode credential files or implementing a second OAuth adapter.
- Reintroducing a plugin-owned MCP pool because the execution bridge is difficult.
- Silently exposing mapped tools again when bridge execution fails.

If the bridge cannot pass the feasibility gates through supported interfaces, pause execution work and request the missing upstream interface. A separate daemon or shell-only permission model needs an explicit product decision. Native Code Mode without the execution CLI is a useful benchmark, not fulfillment of this request.

## Proposed external interface

These names and shapes are proposed plugin contracts, not existing native methods.

### Configuration

Keep native MCP configuration intact. Select servers through plugin options instead of a custom `slim` field:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-slim-mcp",
      "options": {
        "servers": ["todoist"]
      }
    }
  ],
  "mcp": {
    "servers": {
      "todoist": {
        "type": "remote",
        "url": "https://mcp.example.com",
        "disabled": false
      }
    }
  }
}
```

The URL is illustrative. `options.servers` belongs to this proposed plugin. Native `plugins`, `mcp.servers`, and `disabled` follow the V2 guides. Preserve unrelated configuration. Do not add configuration flags until the validated implementation needs them.

Unknown selected names produce clear mapping status. They must not cause unrelated MCP servers to disappear. Reject names that normalize to the same namespace or generated skill ID. Decide how to reject ambiguous ownership when another plugin uses a selected namespace; namespace matching alone is not verified MCP provenance.

Remove the old lazy-loading and idle-shutdown settings. Native MCP lifecycle is the new behavior. Do not advertise the old README defaults or imply that token reduction also reduces connection cost.

### CLI

Ship one execution binary, `slim-mcp`, rather than generating a separate implementation per server:

```sh
slim-mcp status
slim-mcp list todoist
slim-mcp schema todoist add_task
slim-mcp call todoist add_task --json '{"content":"Review migration"}'
slim-mcp call todoist add_task --stdin < parameters.json
```

- Accept JSON through one explicit input source. Reject mixed input sources and invalid JSON. Preserve arrays, nested objects, booleans, numbers, and null.
- Do not make `key=value` conversion the primary interface. Do not silently convert malformed JSON to strings.
- Use one shared RPC contract for CLI and TUI. Keep the contract import free of server setup effects.
- Preserve native error distinctions in RPC. Print machine-readable output to stdout and diagnostics to stderr.
- Return a nonzero exit status for malformed input, permission denial, authentication failure, missing tools, cancellation, and MCP errors. Freeze exact codes with the RPC error contract in phase 4.
- Require a valid, verified invocation for `call`. Reject standalone terminal execution without such context in the first release. Adding a human execution flow requires its own verified native invocation path.
- Catalog reads also need a documented visibility policy. Service authentication alone must not imply that every agent can read every tool description.

Do not add a `refresh` command that implies public native `tools/list` control. Reconciliation can reread available registries; native MCP owns catalog refresh. Optional per-server aliases can follow later, but must delegate to the same binary without embedding credentials or connection code.

### Skills and context budget

Register one short skill description per selected server with `ctx.skill.transform`. The body teaches `list`, `schema`, and `call`, with a small example. Load detailed schemas through CLI discovery when needed. Do not inject every tool name or schema into the system context.

Use a stable explicit skill ID, an absolute plugin-owned path, and runtime content. A virtual flat Markdown path is sufficient when no relative files are needed. If real references are needed, give each Location an owned directory rather than a shared globally wiped tree. See research section 7.

Native MCP server instructions may still advertise hidden Code Mode namespaces. Resolve that separately through verified public context editing or upstream support. Do not remove unrelated system text with an untested substring filter.

### Result semantics

The CLI returns text and JSON through shell. It does not automatically preserve native model-visible image rendering or native MCP tool history.

Preserve typed content and structured output in RPC. Define a bounded CLI representation for media and large output. Return controlled artifact references instead of dumping binary data or unbounded base64 into context. Document which execution hooks, media behavior, and audit records differ from native dispatch. Required plugin interoperability must have an integration test; do not claim equivalence without one.

## Module layout

Keep the public surface small. A suggested layout is:

```text
src/server/index.ts          Native plugin definition and lifecycle composition
src/server/mapping.ts        Selection, versioned catalog, interception, reconciliation
src/server/invocation.ts     Verified invocation binding and native executor use
src/server/skills.ts         Skill rendering and runtime registration
src/rpc.ts                  Shared public contract and typed errors
src/cli/index.ts            CLI parsing, endpoint selection, RPC, output, signals
src/tui/index.tsx           Optional native V2 sidebar
test/fixtures/             Deterministic local and remote MCP fixtures
test/integration/          Installed-plugin, CLI, permission, and lifecycle tests
```

Files can change as implementation reveals a better seam. Do not create a generic transport abstraction or adapters for hypothetical V1 support.

The mapping module exposes a versioned catalog and lookup, not its connection internals. The invocation module accepts verified invocation context, not free-form identity fields. Tests cross these same interfaces. Native registration and RPC are adapters at those seams.

Live executors stay in Location-owned memory. Durable storage contains only needed JSON metadata, under explicitly Location-scoped keys. `ctx.storage` is plugin-scoped globally in the reviewed source, not automatically project-scoped. Do not persist functions, capabilities, credentials, environment values, or raw headers.

## Migration path

### Phase 0 — Lock the V2 baseline

**Depends on:** completed research.

**Work:**

1. Create an isolated V2 development fixture; do not install over the user's current configuration.
2. Install and pin the target OpenCode runtime and `@opencode/plugin` / `@opencode/client` declarations.
3. Verify actual exports, response envelopes, permissions, schema types, and UI peer versions against the installed runtime.
4. Build one local MCP fixture with nested parameters, controlled delays, errors, media, and catalog changes. Build one remote fixture for authentication and disconnect cases.
5. Capture native direct-MCP and default Code Mode behavior before adding the plugin.

**Deliverable:** a reproducible compatibility fixture and baseline observations.

**Exit gate:** a packed minimal V2 plugin loads exactly once and its CLI connects to the intended instance and Location. Record package versions and runtime contract discrepancies. Do not rely only on the inspected repository branch.

### Phase 1 — Prove the native execution path

**Depends on:** phase 0. **Blocks:** production execution and the final architecture commitment.

**Work:**

1. Prove interception ordering with a server that connects after plugin setup. Capture a native executable entry and retain its version without disabling its server.
2. Prove how a shell-originated CLI obtains a trustworthy invocation: Location, session, agent, message, call identity, and cancellation.
3. Investigate a public shell hook or a native shell executor wrapper only if it preserves shell semantics and concurrent invocation isolation. Do not assume a mutable global environment or session ID is sufficient.
4. If a capability is needed, specify authenticated delivery, short lifetime, allowed target scope, revocation, replay handling, redaction, and disposal. Do not put a reusable secret in a generated skill or persisted command.
5. Call one captured native MCP executor with verified context through RPC. Validate its arguments before execution.
6. Test native MCP `allow`, `deny`, `ask`, rejection, allow-once, saved approvals, agent-specific rules, and policy denial while shell execution remains allowed.
7. Interrupt both permission waiting and active execution through session interruption, CLI termination, HTTP disconnect, and plugin unload.
8. Identify the dispatch behavior bypassed by executor reuse. Resolve required validation, output bounds, hook interoperability, and audit attribution explicitly.
9. Verify schema/provenance handling and inspect residual MCP system instructions after removal.

**Deliverable:** a disposable vertical slice plus a decision record in this plan: supported bridge, required upstream change, or blocker. The slice is not the production rewrite.

**Exit gate:** no fabricated identity, no cross-session execution, no MCP permission bypass, no orphan calls, no private Core imports, and a documented result contract. A native permission assertion must remain authoritative. If these conditions fail, stop and pursue upstream support; do not compensate with a V1-shaped pool.

### Phase 2 — Build the native mapping runtime

**Depends on:** phases 0 and 1 passing.

**Work:**

1. Default-export `Plugin.define({ id, setup })`. Validate `ctx.options.servers` and use `ctx.location`.
2. Leave native MCP server definitions and authentication intact. Use native status reads; account for generated `{ location, data }` envelopes.
3. Implement a synchronous, cheap tool transform that captures and removes only selected, verified entries.
4. Handle absent catalogs, late connections, OAuth completion, server disable/remove/reconfiguration, catalog changes, and plugin ordering.
5. Publish a versioned immutable catalog outside transform callbacks. Reconcile skills and RPC events outside callbacks; prevent reload loops.
6. Resolve normalized-name collisions and ambiguous namespace ownership before hiding entries.
7. Invalidate stale executors when server configuration or catalog identity changes. Do not let an old catalog version invoke an unintended replacement account or server.
8. Abort reconciliation and revoke plugin-owned calls on cleanup. Do not close native MCP connections directly.

**Deliverable:** the mapping module with no custom transport or credential reader.

**Exit gate:** selected definitions remain hidden in future direct and Code Mode catalogs through real lifecycle transitions. Unselected tools remain unchanged. Same-name servers in different Locations never share executors or caches. Earlier native model snapshots follow documented snapshot semantics; do not claim retroactive revocation of those snapshots.

### Phase 3 — Deliver discovery through RPC, CLI, and skills

**Depends on:** phase 2.

**Work:**

1. Define proposed `status`, `catalog`, and `schema` methods with `Rpc.define`; register handlers with `ctx.rpc.register`.
2. Define caller visibility and support all selected native schema forms through public interfaces. Fail explicitly for unsupported schemas instead of weakening validation.
3. Implement `slim-mcp status`, `list`, and `schema` using `@opencode/client`.
4. Prefer explicit endpoint/authentication and Location selection. For local discovery, use native service discovery. Do not silently start or select a different instance than a remote or standalone TUI.
5. Register compact runtime skills. Handle zero-tool servers, denied skills, duplicate skill IDs, and catalog changes.
6. Remove misleading native namespace guidance for selected servers only through the validated phase-1 mechanism. Preserve unrelated MCP instructions and useful selected-server guidance in the skill when appropriate.
7. Verify that the installed CLI is reachable from the agent's shell, including documented remote-host deployment requirements.

**Deliverable:** the full on-demand discovery workflow.

**Exit gate:** an agent finds a short skill, learns CLI usage, and obtains a tool schema without any mapped tool schema in the idle catalog. Missing servers report native authentication/readiness status without exposing secrets. Visibility denial does not leak restricted descriptions through a different discovery path.

### Phase 4 — Complete CLI execution

**Depends on:** phases 1–3.

**Work:**

1. Define the proposed `call` RPC with catalog version, server/tool selection, JSON arguments, and the validated invocation binding. Do not expose raw identity override fields.
2. Bind requests to the intended OpenCode endpoint and Location. Reject expired, replayed, wrong-session, and stale-catalog requests.
3. Invoke the captured native MCP executor with verified context and both invocation and request cancellation. Keep native MCP permission checks intact.
4. Implement `call --json` and `call --stdin`; validate nested arguments server-side.
5. Preserve typed RPC results; implement bounded stdout, artifact handling, stderr diagnostics, and stable exit codes.
6. Document audit attribution and dispatch-hook behavior accurately. Do not auto-approve permission requests.
7. Do not automatically retry mutations after timeout or uncertain disconnect. Cancellation cannot undo an external side effect that already occurred.

**Deliverable:** one complete read-only workflow and one mutation workflow through skill, shell, CLI, RPC, and native MCP.

**Exit gate:** the permission and cancellation matrix from phase 1 passes against the installed package. Concurrent sessions and subagents cannot inherit each other's invocation. Invalid arguments never reach the fixture server. MCP errors cannot appear as successful CLI text.

### Phase 5 — Port the optional sidebar

**Depends on:** phase 3; can proceed independently of phase 4 after the discovery contract is stable.

**Work:**

1. Use `Plugin.define` from `@opencode/plugin/tui` and `context.ui.slot({ append: "sidebar.content", render })`.
2. Read native connection state from the documented Location data. Use RPC for mapping-specific status only.
3. Subscribe to mapping events, then fetch authoritative state. Filter events by Location and refetch after connection recovery.
4. Handle Location switching, remote servers, missed events, and teardown. Do not assume event replay or automatic client reconnection.
5. Verify automatic TUI export loading from the server plugin. Avoid redundant CLI configuration and duplicate sidebar registrations.

**Deliverable:** a typed V2 sidebar without filesystem polling or untyped tool events.

**Exit gate:** local and remote sidebars agree with CLI/native status and recover from missed events. UI peers match the validated runtime, not the old `>=0.2.6` range.

### Phase 6 — Remove the V1 implementation and publish the V2-only package

**Depends on:** phases 2–5 and all release gates below. The sidebar must either pass or be explicitly removed from the release; do not leave a V1 TUI export.

**Replace or retire:**

- `index.ts`: replace its V1 hook implementation with the native server entrypoint.
- `config-utils.ts`: remove raw config discovery and legacy MCP extraction/mutation after their replacement is tested.
- `index.test.ts`: replace architecture-specific V1 assertions with selected-server, lifecycle, permission, and CLI behavior tests.
- `generate.js`: retire independent connection-owning generated wrappers. Replace the published generator binary with the execution/discovery CLI.
- `tui.tsx` and `build-tui.ts`: port to the V2 terminal plugin interfaces and validated peers.
- `package.json`: publish ESM root/`./server`, `./rpc`, optional `./tui`, and the `slim-mcp` binary. Remove V1 plugin/SDK dependencies and the direct MCP SDK dependency if the native implementation no longer needs it.
- Build scripts: remove automatic postbuild copying into `.opencode/plugins`. Make development installation explicit.
- `bun.lock` and `package-lock.json`: regenerate consistently with the chosen package-management policy. Do not keep stale V1 resolution paths.
- `.opencode/tui.json`: replace or retire the tracked V1 development fixture containing an absolute developer path. Do not edit global user `cli.json` as part of repository migration.
- `README.md`: rewrite installation, native configuration, CLI, skills, authentication, permissions, result limits, endpoint selection, and measured token claims.
- `.github/workflows/publish.yml` and `.gitea/workflows/publish.yml`: require typecheck, tests, builds, and packed-package smoke tests before publication. Choose one release authority or explicitly coordinate both publishers.

**Release policy:** use a breaking plugin release, preferably `1.0.0`, and label it OpenCode V2-only. This plugin version is separate from OpenCode's own version. Keep old release tags as history; do not add compatibility logic to the new package. Fail clearly on unsupported OpenCode versions.

**User migration instructions:** back up the prior setup; update the plugin package and native configuration; move `slim: true` selections into `options.servers`; replace generator/proxy-tool instructions with CLI skills. Native OpenCode can normalize legacy configuration, but this plugin must not implement a legacy configuration mode.

Legacy generated skills, wrappers, manifests, and status files must not remain active alongside the new runtime skills. Provide an explicit inventory and cleanup guide. Remove only artifacts with established plugin ownership and user approval. Do not recursively wipe shared state or global skill directories. Do not remove native credentials.

**Exit gate:** a clean tarball installation completes the entire workflow. The new package contains no V1 plugin entrypoint, old config hook, pooled MCP transport, credential-file reader, legacy proxy tool, or independent generator runtime.

## Dependency map

```text
Research complete
  -> Phase 0: pinned installed-runtime baseline
  -> Phase 1: supported execution feasibility decision
  -> Phase 2: native mapping runtime
  -> Phase 3: RPC discovery, CLI discovery, runtime skills
       -> Phase 4: secure CLI execution
       -> Phase 5: optional native TUI
  -> Phase 6: V1 removal, packed-package validation, V2-only release

If Phase 1 fails:
  -> upstream interface work
  -> repeat Phase 1 against the release containing that interface
  -> do not release an unsafe execution fallback
```

Phases 0–1 answer whether the clean native path is feasible. Phases 2–5 implement that proven path. Phase 6 removes the old runtime rather than carrying both designs forward.

## Release acceptance criteria

### Function and isolation

- Selected MCP servers provide CLI discovery and execution plus on-demand skills.
- Unselected servers retain native behavior; selected-server failures do not trigger silent native-tool fallback.
- Late startup, authentication, catalog refresh, disable/remove/reconfiguration, and plugin unload preserve correct mapping.
- Two projects with the same server name and different accounts cannot share catalogs, executors, artifacts, or capabilities.
- Global/project configuration and definitions contributed by earlier plugins work without raw-file parsing. Ambiguous provenance or ordering fails clearly.
- Managed, explicit remote, and standalone endpoints select the intended server and Location. Missing execution CLI installation produces an actionable error.

### Safety and result correctness

- Native MCP permission denial remains effective even when shell allows the CLI command.
- Permission requests use the correct invocation and support rejection and approval waiting without orphan requests.
- Session interruption, CLI termination, request abort, and plugin unload stop pending plugin-owned work.
- Argument validation covers nested JSON and each accepted schema form.
- CLI results distinguish successful text, structured data, MCP failure, permission denial, media references, and truncated output.
- No status response, skill, command, persistent cache, or diagnostic contains credentials or invocation secrets.
- Uncertain mutations are never retried automatically. Document cancellation limits for already-completed external side effects.

### Token savings

Measure the same server sets and task suite in three modes:

1. Native direct MCP, with Code Mode disabled for that baseline.
2. Native default MCP Code Mode.
3. The V2 CLI-plus-skill mapping.

Record provider/model, tokenizer or estimator, server/tool counts, schema sizes, and repeated task runs. Measure idle advertised context, native server instructions, discovery turns, skill body loading, RPC/CLI output, total input tokens, latency, and task success. Character-count estimates must be labeled as estimates.

The mapped idle catalog must omit selected tool schemas and descriptions. A representative description-heavy workload must demonstrate net token savings over default Code Mode without breaking task success. Report workloads where discovery overhead makes the mapping worse. Do not claim universal savings or “zero idle token cost.” The accepted numerical token budget should follow the phase-0 baseline, not an invented percentage.

### Distribution

- Typecheck, behavior tests, integration tests, server/TUI builds, and packed-package smoke tests pass.
- Root/server/TUI/RPC exports and the CLI binary work from the tarball without source-relative imports or postbuild installation effects.
- Version requirements match tested packages. Resolve published declarations versus docs discrepancies before selecting dependency ranges.
- Publication is gated and coordinated. No new code path supports V1.

## First implementation task

Start with phases 0 and 1, not a package rename or full rewrite. Demonstrate one native MCP call through shell, CLI, and RPC with real permission and cancellation context. That result determines whether the migration proceeds entirely within today's public interfaces or first needs upstream V2 support.

## Primary-source anchors

The research document contains commit-pinned source links and package evidence for all findings used here. The most important official guides are:

- [V1 migration](https://opencode.ai/v2/docs/migrate-v1)
- [Plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
- [Native plugin interfaces](https://opencode.ai/v2/docs/build/plugins)
- [Plugin RPC](https://opencode.ai/v2/docs/build/plugins/rpc)
- [Native client and service discovery](https://opencode.ai/v2/docs/build/client)
- [MCP servers](https://opencode.ai/v2/docs/mcp-servers)
- [Skills](https://opencode.ai/v2/docs/skills)
- [Permissions](https://opencode.ai/v2/docs/permissions)
- [Native terminal plugins](https://opencode.ai/v2/docs/build/plugins/cli)

All filenames, CLI commands, options, RPC methods, module layouts, release choices, and phase deliverables proposed by this plan remain design choices until implementation and validation establish them.

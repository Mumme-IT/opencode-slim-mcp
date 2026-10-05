# V2 implementation and verification

## Status

The repository now builds a V2-only `1.0.0` package for **OpenCode 2.0.23**. The implementation uses public `@opencode/plugin` and `@opencode/client` interfaces. It does not contain a V1 runtime, an independent MCP connection pool, a credential-file reader, or a generic model-visible proxy tool. No package has been published.

The optional sidebar is omitted from this release. Its old V1 implementation and export are removed rather than retained as compatibility code.

## Phase 1 decision: verified foreground shell authority

The installed OpenCode runtime provides a usable execution path without fabricating session identity:

1. A public tool transform wraps the native foreground `shell` executor and receives its real `ToolContext`.
2. The wrapper records that context and adds a one-use, non-secret correlation marker to the command.
3. The public `shell.create.before` hook verifies and removes the marker before the native shell permission preparation and spawn. The hook adds a random secret capability to that shell's environment, not to the command or global environment.
4. Plugin RPC resolves the capability in the plugin's Location-scoped memory. The context retains the real session, agent, message, call ID, progress handler, and cancellation signal.
5. The captured native MCP executor performs its own native permission assertion. The capability does not approve that assertion.
6. Shell completion, interruption, expiry, or plugin unload revokes authority and interrupts associated calls.

This sequence is verified through a genuine model-driven shell call, a packed CLI installation, the public HTTP client and plugin RPC, and a local native MCP connection. It is not a test that manually constructs a production `ToolContext`.

The sequence relies on the validated shell ordering in 2.0.23. Other releases fail closed until the installed-runtime tests validate them. Background shells and external terminals cannot use this authority.

## Implemented modules

- `src/server/mapping.ts` captures selected native executors, removes their definitions, versions the catalog, validates arguments, and rejects normalized namespace collisions.
- `src/server/invocation.ts` manages live foreground authority, replay rejection, cancellation, and cleanup.
- `src/server/skills.ts` registers compact runtime skills rather than generated transport-owning scripts.
- `src/server/index.ts` registers native transforms, hooks, skills, and typed RPC. It leaves native MCP transports and authentication intact.
- `src/server/result.ts` preserves typed results and bounds inline output with private server-host artifacts.
- `src/cli/` provides status, catalog, schema, and call commands through the existing OpenCode server.
- `src/rpc.ts` is the shared public contract.

Configuration selection lives in `options.servers`. The plugin does not parse or mutate V1 configuration files. Native OpenCode remains responsible for configuration discovery and supported configuration normalization.

The user explicitly approves the exclusive-namespace installation restriction during implementation. Startup requires `exclusiveNamespaces: true`. This is an opt-in trust constraint, not automatic proof of native executor provenance.

## Verified behavior

`npm run check` runs typechecking, unit tests, builds, package export/bin smoke tests, and the installed native integration test. The integration harness isolates all OpenCode configuration and state under an owned `/tmp/opencode/` directory. Its model and MCP endpoints are local. It does not use user credentials or a paid model.

The installed-runtime tests verify:

- A tarball includes the directory-loading entrypoint, exports, and executable CLI.
- CLI calls use a genuine foreground shell context and the existing native MCP connection.
- Selected tools and their native namespace guidance are absent from outgoing context; unrelated MCP guidance remains.
- Native MCP `allow`, `deny`, approved `ask`, and rejected `ask` retain their behavior.
- Saved approvals and agent-specific denial retain their behavior.
- Denied skill permissions prevent alternate CLI discovery.
- Invalid nested arguments do not reach the MCP server.
- Native MCP error results produce a nonzero CLI exit, not successful text.
- Large typed results produce bounded shell output and private artifacts.
- Missing invocation authority fails closed.
- Session interruption reaches the fixture as native MCP cancellation.
- Disconnect rejects execution and reconnect restores it.
- Replacing a server configuration while MCP approval is pending cancels the admitted call before it can reach the replacement connection.
- Two Locations with the same server name use different executors and logs. Moving the first shell's capability to the second Location fails.

Unit tests also cover replay rejection, concurrent invocation separation, shell-completion expiry, unload cancellation, schema dialects and formats, configuration invalidation and cancellation, namespace collisions, JSON input sources, HTTP redirect rejection, and artifact limits and modes.

### Validation record

The full `npm run check` passes on 2026-10-05 with Node.js 24 and Bun 1.4.2: typechecking, nine unit tests, package builds, export/bin smoke tests, and one installed OpenCode 2.0.23 integration test containing 42 assertions. The package is installed from a fresh tarball for the integration test. Markdown local links, code fences, whitespace, and `git diff --check` also pass.

These automated checks are not the token-cost or remote OAuth validation described below. Passing them does not authorize publication.

## Review

### Standards

No hard standards violations remain. Review fixes preserve unrelated XML instructions, keep cached selected definitions hidden after configuration removal, permanently revoke closed authority, and reject credential-forwarding redirects. One low-priority duplicated authorization/error-handling heuristic remains in the RPC registration code.

### Spec

The review identifies four remaining partial requirements: atomic execution across live catalog changes, distinct native error categories, deployment/cancellation validation, and measured token savings. Small native file/media results now use private artifact references instead of inline binary data. Configuration-replacement cancellation and scoped instruction filtering have regression tests. The remaining requirements block release acceptance.

Summary: one low-priority Standards heuristic and four Spec gaps remain. The worst Standards issue is duplication; the worst Spec issue is atomic live-catalog execution safety.

## Remaining release validation

The local installed-runtime proof does not establish every deployment's behavior. Before publishing or deploying broadly, complete these checks:

- Compare complete representative tasks with native V2 Code Mode using the intended model and its tokenizer. Include skill loading, discovery, commands, results, and cache effects. No net token-cost reduction is claimed from catalog removal alone.
- Exercise remote HTTP MCP servers, OAuth expiry and account changes, and remote/standalone endpoint authentication in the intended deployment.
- Exercise live MCP catalog replacement, native policy denial, CLI termination, and OAuth account switching against representative servers. The local configuration-replacement test is not an OAuth account-switch test.
- Verify the CLI installation and artifact access on the OpenCode server host.
- Confirm that selected native namespaces are not registered or overridden by other plugins. V2 does not expose typed executor provenance.

Calling a captured native MCP executor retains its internal permission assertion and cancellation, but does not pass through the separate outer MCP dispatcher. It does not emit separate MCP dispatch hooks or a separate MCP history row. This is an explicit compatibility constraint, not a claimed replacement for those hooks.

The 2.0.23 native MCP executor also converts several internal failures, including permission failures, into the same tool failure. RPC preserves explicit plugin rejection codes but reports this collapsed native failure generically. It does not infer authentication or approval outcomes from arbitrary server error text. Fully distinct native permission, transport, and authentication errors require an upstream executor contract change.

Catalog and configuration invalidation abort calls that are waiting for approval or executing. Public MCP status and credential/integration events also conservatively invalidate the admitted catalog. A failed event watcher permanently revokes invocation authority. These cancellations cannot undo external side effects that already occurred.

The pinned public plugin event stream does not include `mcp.tools.changed`, although the internal schema defines that event. Catalog capture detects changes after native reconciliation. A live catalog change can therefore precede revocation while a call waits for approval. Atomic catalog identity checks at the native execution point require an upstream interface; the local configuration-replacement test does not prove this stronger property. This is a remaining release blocker, not a supported unsafe fallback.

## Release and cleanup

GitHub is the single npm publication authority. Both GitHub and the Gitea mirror validate the package; the mirror does not publish. Publication also requires the production environment variable `SLIM_MCP_RELEASE_VALIDATED=true`; leave it unset until the documented acceptance blockers are resolved. Build steps do not copy plugins into a user's configuration.

Keep historical 0.x releases separate. Remove obsolete generated artifacts only after verifying ownership and obtaining approval. Never remove native credentials or recursively wipe shared skill/state directories. The runtime does not perform legacy cleanup automatically.

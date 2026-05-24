import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { fileURLToPath } from "url";
import path from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens, OAuthClientInformationMixed, OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(__dirname, "..", "..", "skills");

const DEFAULT_BASE_DIR = join(homedir(), ".config", "opencode");
const STATE_DIR = join(homedir(), ".local", "state", "opencode", "slim-mcp");
const GENERATED_SKILLS_DIR = join(STATE_DIR, "skills");
const MCP_STATUS_FILE = join(STATE_DIR, "status.json");
const MCP_AUTH_FILE = join(homedir(), ".local", "share", "opencode", "mcp-auth.json");

// ─── Stored MCP Auth Provider ────────────────────────────────────────────────

interface StoredMcpAuth {
  clientInfo?: OAuthClientInformationMixed;
  serverUrl?: string;
  tokens?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scope?: string;
  };
}

function loadMcpAuth(serverName: string): StoredMcpAuth | undefined {
  if (!existsSync(MCP_AUTH_FILE)) return undefined;
  try {
    const data = JSON.parse(readFileSync(MCP_AUTH_FILE, "utf8"));
    return data[serverName] ?? undefined;
  } catch {
    return undefined;
  }
}


class StoredOAuthClientProvider implements OAuthClientProvider {
  private stored: StoredMcpAuth;
  private serverName: string;

  constructor(serverName: string, stored: StoredMcpAuth) {
    this.serverName = serverName;
    this.stored = stored;
  }

  get redirectUrl(): string | undefined {
    return undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [],
      client_name: `slim-mcp-${this.serverName}`,
    } as OAuthClientMetadata;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.stored.clientInfo;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Re-read from disk each time — opencode core may have refreshed tokens
    const fresh = loadMcpAuth(this.serverName);
    if (!fresh?.tokens) return undefined;
    return {
      access_token: fresh.tokens.accessToken,
      refresh_token: fresh.tokens.refreshToken,
      token_type: "Bearer",
      expires_in: fresh.tokens.expiresAt
        ? Math.max(0, Math.floor(fresh.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: fresh.tokens.scope,
    } as OAuthTokens;
  }

  async saveTokens(_tokens: OAuthTokens): Promise<void> {
    // Read-only — opencode core manages token persistence
  }

  async redirectToAuthorization(_url: URL): Promise<void> {
    throw new Error(
      `Server '${this.serverName}' requires authentication. Run: opencode mcp auth ${this.serverName}`
    );
  }

  async saveCodeVerifier(_verifier: string): Promise<void> {}
  async codeVerifier(): Promise<string> { return ""; }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface SlimMcpConfig {
  type?: "local" | "remote";
  command?: string[];
  url?: string;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
  slim?: boolean;
  enabled?: boolean;
  timeout?: number;
}

interface SlimPluginConfig {
  lazyLoading: boolean;
  idleShutdownMs: number;
  debugging: boolean;
}

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

type ServerState = "pending" | "connected" | "disabled" | "error" | "needs_auth";

// ─── Auth Error Detection ────────────────────────────────────────────────────

const AUTH_ERROR_PATTERNS = [
  /no access token/i,
  /access token.*provided/i,
  /invalid.?_?token/i,
  /unauthorized/i,
  /401/,
  /authentication required/i,
  /authorizationCode is required/i,
  /not authenticated/i,
  /not logged in/i,
  /login required/i,
  /prepareTokenRequest/i,
];

function isAuthError(error: string): boolean {
  return AUTH_ERROR_PATTERNS.some((p) => p.test(error));
}

const DEFAULT_IDLE_MS = 60_000;

// ─── Plugin Config Discovery ─────────────────────────────────────────────────

function parseIntervalMs(value: string): number {
  const match = value.match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!match) return DEFAULT_IDLE_MS;

  const num = parseInt(match[1], 10);
  switch ((match[2] || "ms").toLowerCase()) {
    case "h":
      return num * 3_600_000;
    case "m":
      return num * 60_000;
    case "s":
      return num * 1_000;
    default:
      return num;
  }
}

function loadPluginConfig(projectDir: string): SlimPluginConfig {
  const candidates = [
    join(projectDir, "slim-mcp-config.json"),
    join(DEFAULT_BASE_DIR, "slim-mcp-config.json"),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(readFileSync(candidate, "utf8"));
      return {
        lazyLoading: raw["lazy-loading"] === true,
        idleShutdownMs: raw["lazy-idle-shutdown-interval"]
          ? parseIntervalMs(String(raw["lazy-idle-shutdown-interval"]))
          : DEFAULT_IDLE_MS,
        debugging: raw["debugging"] === true,
      };
    } catch {
      continue;
    }
  }

  return { lazyLoading: false, idleShutdownMs: DEFAULT_IDLE_MS, debugging: false };
}

// ─── MCP Config Discovery ────────────────────────────────────────────────────

function findOpenCodeConfigs(projectDir: string): string[] {
  return [
    join(projectDir, "opencode.json"),
    join(DEFAULT_BASE_DIR, "opencode.json"),
  ].filter(existsSync);
}

function normalizeCommand(entry: any): string[] | null {
  if (Array.isArray(entry.command)) return entry.command;
  if (typeof entry.command === "string") {
    const args = Array.isArray(entry.args) ? entry.args : [];
    return [entry.command, ...args];
  }
  return null;
}

function isSupportedMcp(entry: any): boolean {
  if (entry.type === "local" || entry.type === "remote") return true;
  if (!entry.type) return !!(entry.url || entry.command);
  return false;
}

function inferType(entry: any): "local" | "remote" {
  if (entry.type === "remote" || (!entry.type && entry.url)) return "remote";
  return "local";
}

function extractSlimMcpEntries(
  projectDir: string
): Record<string, SlimMcpConfig> {
  const slimEntries: Record<string, SlimMcpConfig> = {};

  for (const configPath of findOpenCodeConfigs(projectDir)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const mcp = config.mcp;
      if (!mcp) continue;

      for (const [name, entry] of Object.entries(mcp) as [string, any][]) {
        if (entry.slim !== true || !isSupportedMcp(entry)) continue;

        const isRemote = inferType(entry) === "remote";

        if (isRemote) {
          if (!entry.url) continue;
          slimEntries[name] = {
            type: "remote",
            url: entry.url,
            headers: entry.headers,
            slim: true,
            enabled: entry.enabled,
            timeout: entry.timeout,
          };
        } else {
          const command = normalizeCommand(entry);
          if (!command) continue;
          slimEntries[name] = {
            type: "local",
            command,
            environment: entry.environment,
            slim: true,
            enabled: entry.enabled,
            timeout: entry.timeout,
          };
        }
      }
    } catch {
      continue;
    }
  }

  return slimEntries;
}

function extractCfgMcpEntries(
  cfg: any,
  alreadyKnown: Set<string>,
): Record<string, SlimMcpConfig> {
  const entries: Record<string, SlimMcpConfig> = {};
  const mcp = cfg?.mcp;
  if (!mcp) return entries;

  for (const [name, entry] of Object.entries(mcp) as [string, any][]) {
    if (alreadyKnown.has(name)) continue;
    if (entry?.slim !== true || !isSupportedMcp(entry)) continue;

    if (inferType(entry) === "remote") {
      if (!entry.url) continue;
      entries[name] = {
        type: "remote",
        url: entry.url,
        headers: entry.headers,
        slim: true,
        enabled: entry.enabled,
        timeout: entry.timeout,
      };
    } else {
      const command = normalizeCommand(entry);
      if (!command) continue;
      entries[name] = {
        type: "local",
        command,
        environment: entry.environment,
        slim: true,
        enabled: entry.enabled,
        timeout: entry.timeout,
      };
    }
  }

  return entries;
}

function cleanCfgMcp(
  cfg: any,
  allSlimNames: Set<string>,
  failedServers: Set<string>,
): void {
  const mcp = cfg?.mcp;
  if (!mcp) return;

  for (const [name, entry] of Object.entries(mcp) as [string, any][]) {
    if (allSlimNames.has(name)) {
      if (failedServers.has(name)) {
        delete entry.slim;
      } else {
        delete mcp[name];
      }
    } else if (entry?.slim === true) {
      delete entry.slim;
    }
  }
}

// ─── MCP Connection Pool ─────────────────────────────────────────────────────

interface PooledConnection {
  client: Client;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout> | null;
}

class McpConnectionPool {
  private connections = new Map<string, PooledConnection>();
  private configs = new Map<string, SlimMcpConfig>();
  private errors = new Map<string, string>();
  private authErrors = new Set<string>();
  private idleShutdownMs: number;
  private lazy: boolean;
  private debugging: boolean;
  constructor(pluginConfig: SlimPluginConfig) {
    this.idleShutdownMs = pluginConfig.idleShutdownMs;
    this.lazy = pluginConfig.lazyLoading;
    this.debugging = pluginConfig.debugging;
  }

  register(name: string, config: SlimMcpConfig): void {
    this.configs.set(name, config);
  }

  async unregister(name: string): Promise<void> {
    await this.disconnect(name);
    this.configs.delete(name);
    this.errors.delete(name);
    this.authErrors.delete(name);
  }

  async markFailed(name: string, error: string): Promise<void> {
    await this.disconnect(name);
    if (isAuthError(error)) {
      this.authErrors.add(name);
    }
    this.errors.set(name, error);
    this.writeStatus();
  }

  availableServers(): string[] {
    return [...this.configs.keys()];
  }

  serverState(name: string): ServerState {
    const config = this.configs.get(name);
    if (!config) return "disabled";
    if (config.enabled === false) return "disabled";
    if (this.authErrors.has(name)) return "needs_auth";
    if (this.errors.has(name)) return "error";
    if (this.connections.has(name)) return "connected";
    return "pending";
  }

  enabledServers(): string[] {
    return [...this.configs.entries()]
      .filter(([, cfg]) => cfg.enabled !== false)
      .map(([name]) => name);
  }

  serverError(name: string): string | undefined {
    return this.errors.get(name);
  }

  serversNeedingAuth(): string[] {
    return [...this.authErrors];
  }

  markNeedsAuth(name: string, error: string): void {
    this.authErrors.add(name);
    this.errors.set(name, error);
    this.writeStatus();
  }

  /** Write current pool state to disk for TUI plugin consumption. */
  writeStatus(): void {
    const servers = this.availableServers().map((name) => ({
      name,
      status: this.serverState(name),
      error: this.serverError(name) || undefined,
    }));
    try {
      ensureDir(path.dirname(MCP_STATUS_FILE));
      writeFileSync(MCP_STATUS_FILE, JSON.stringify({ servers, updatedAt: Date.now() }), "utf8");
    } catch {
      // Best-effort — TUI will show stale data
    }
  }

  async getClient(name: string): Promise<Client> {
    const config = this.configs.get(name);
    if (!config) throw new Error(`Unknown MCP server: ${name}`);
    if (config.enabled === false)
      throw new Error(`MCP server '${name}' is disabled`);

    const existing = this.connections.get(name);
    if (existing) {
      existing.lastUsed = Date.now();
      this.resetIdleTimer(name, existing);
      return existing.client;
    }

    return this.connect(name);
  }

  private async connect(name: string): Promise<Client> {
    const config = this.configs.get(name);
    if (!config) throw new Error(`Unknown MCP server: ${name}`);

    this.errors.delete(name);

    let transport;

    if (config.type === "remote") {
      const url = new URL(config.url!);
      const storedAuth = loadMcpAuth(name);
      const authProvider = storedAuth
        ? new StoredOAuthClientProvider(name, storedAuth)
        : undefined;
      transport = new StreamableHTTPClientTransport(url, {
        authProvider,
        requestInit: config.headers
          ? { headers: config.headers }
          : undefined,
      });
    } else {
      const env = config.environment
        ? { ...process.env, ...config.environment }
        : undefined;

      const [command, ...args] = config.command!;
      transport = new StdioClientTransport({
        command,
        args,
        env,
        stderr: "pipe",
      });
    }

    const client = new Client({
      name: `slim-mcp-${name}`,
      version: "1.0.0",
    });

    try {
      await client.connect(transport);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (isAuthError(msg)) {
        this.authErrors.add(name);
      }
      this.errors.set(name, msg);
      throw err;
    }

    const timer =
      this.lazy && this.idleShutdownMs > 0
        ? setTimeout(() => this.disconnect(name), this.idleShutdownMs)
        : null;

    this.connections.set(name, { client, lastUsed: Date.now(), timer });
    this.writeStatus();
    return client;
  }

  private resetIdleTimer(name: string, conn: PooledConnection): void {
    if (!this.lazy || this.idleShutdownMs <= 0) return;

    if (conn.timer) clearTimeout(conn.timer);
    conn.timer = setTimeout(() => this.disconnect(name), this.idleShutdownMs);
  }

  private async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;

    if (conn.timer) clearTimeout(conn.timer);
    this.connections.delete(name);

    try {
      await conn.client.close();
    } catch {
      // Server may already be gone
    }
    this.writeStatus();
  }
}

// ─── Tool Result Formatting ─────────────────────────────────────────────────

function formatToolResult(result: any): string {
  const content = result.content ?? result;
  if (Array.isArray(content)) {
    return content
      .map((item: any) =>
        item.type === "text" ? item.text : JSON.stringify(item, null, 2)
      )
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

// ─── Tools ───────────────────────────────────────────────────────────────────

function createMcpTool(pool: McpConnectionPool) {
  return tool({
    description:
      "Call a tool on a slim MCP server. " +
      "IMPORTANT: Before calling this tool, you MUST first load the skill named \"mcp-<server>\" " +
      "(e.g. skill \"mcp-todoist\") to discover available tool names, parameters, and the required confirmation token. " +
      "Do NOT guess tool names or parameters — load the skill first. " +
      "Available servers: " +
      pool.enabledServers().join(", "),
    args: {
      server: tool.schema
        .string()
        .describe("MCP server name — one of: " + pool.enabledServers().join(", ")),
      tool: tool.schema
        .string()
        .describe("Tool name on that server. You MUST load the mcp-<server> skill first to see available tool names."),
      params: tool.schema
        .string()
        .optional()
        .describe(
          'Tool parameters as a JSON string. Example: \'{"query": "test"}\'. Omit if the tool takes no parameters.'
        ),
      _confirm: tool.schema
        .string()
        .describe(
          "Confirmation token from the mcp-<server> skill. Load the skill to obtain this value. The call will be rejected without it."
        ),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: `mcp: ${args.server}/${args.tool}` });

      // Gate: reject if skill was not loaded (missing or wrong confirmation token)
      const expectedToken = `slim-${args.server}`;
      if (args._confirm !== expectedToken) {
        return (
          `DENIED: You must load the skill first.\n` +
          `Run: skill(name="mcp-${args.server}")\n` +
          `The skill contains the required confirmation token and lists all available tools and parameters.\n` +
          `Do NOT guess — load the skill, then retry.`
        );
      }

      let client: Client;
      try {
        client = await pool.getClient(args.server);
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (isAuthError(msg)) {
          return (
            `Server '${args.server}' requires authentication.\n` +
            `Run: opencode mcp auth ${args.server}\n\n` +
            `Original error: ${msg}`
          );
        }
        throw err;
      }

      const toolParams = args.params ? JSON.parse(args.params) : {};

      let result;
      try {
        result = await client.callTool({
          name: args.tool,
          arguments: toolParams,
        });
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (isAuthError(msg)) {
          pool.markNeedsAuth(args.server, msg);
          return (
            `Server '${args.server}' requires authentication.\n` +
            `Run: opencode mcp auth ${args.server}\n\n` +
            `Original error: ${msg}`
          );
        }
        throw err;
      }

      return formatToolResult(result);
    },
  });
}

function createMcpStatusTool(pool: McpConnectionPool) {
  return tool({
    description:
      "Show status of all slim MCP servers: connected, pending, disabled, or error.",
    args: {},
    async execute(_args, ctx) {
      ctx.metadata({ title: "mcp-status" });

      const servers = pool.availableServers();
      if (servers.length === 0) return "No slim MCP servers configured.";

      const lines = servers.map((name) => {
        const state = pool.serverState(name);
        const error = pool.serverError(name);
        const icon =
          state === "connected"
            ? "[connected]"
            : state === "needs_auth"
              ? "[needs_auth]"
              : state === "error"
                ? "[error]"
                : state === "disabled"
                  ? "[disabled]"
                  : "[pending]";
        const suffix = state === "needs_auth"
          ? ` — Run: opencode mcp auth ${name}`
          : error
            ? ` — ${error}`
            : "";
        return `${icon} ${name}${suffix}`;
      });

      return lines.join("\n");
    },
  });
}

// ─── SKILL.md Generation ─────────────────────────────────────────────────────

function firstLine(text?: string): string {
  if (!text) return "";
  const line = text.split("\n")[0].trim();
  return line.length > 120 ? line.slice(0, 117) + "..." : line;
}

function formatParamDocs(toolInfo: ToolInfo): string {
  const schema = toolInfo.inputSchema;
  if (!schema?.properties || Object.keys(schema.properties).length === 0) {
    return "(none)";
  }

  const required = new Set(schema.required || []);
  return Object.entries(schema.properties)
    .map(([name, prop]: [string, any]) => {
      const type = prop.type || "any";
      const req = required.has(name) ? ", required" : "";
      const desc = prop.description ? ` — ${firstLine(prop.description)}` : "";
      return `- \`${name}\` (${type}${req})${desc}`;
    })
    .join("\n");
}

function buildExampleParams(t: ToolInfo): string {
  const schema = t.inputSchema;
  if (!schema?.properties || Object.keys(schema.properties).length === 0) {
    return "{}";
  }
  const example: Record<string, any> = {};
  const required = new Set(schema.required || []);
  for (const [name, prop] of Object.entries(schema.properties) as [string, any][]) {
    if (!required.has(name) && Object.keys(example).length >= 2) continue;
    if (prop.type === "number" || prop.type === "integer") example[name] = 1;
    else if (prop.type === "boolean") example[name] = true;
    else example[name] = "...";
  }
  return JSON.stringify(example);
}

function generateSkillMd(serverName: string, tools: ToolInfo[]): string {
  const triggers = tools
    .slice(0, 3)
    .map((t) => t.name.replace(/_/g, " "))
    .join(", ");

  const toolTable = tools
    .map((t) => `| \`${t.name}\` | ${firstLine(t.description)} |`)
    .join("\n");

  const paramSections = tools
    .map((t) => `#### \`${t.name}\`\n${formatParamDocs(t)}`)
    .join("\n\n");

  // Build a concrete example using the first tool
  const exTool = tools[0];
  const exParams = buildExampleParams(exTool);

  return `---
name: mcp-${serverName}
description: >
  Use when interacting with ${serverName} via MCP.
  Triggers on: ${serverName}, ${triggers}.
---

# How to call ${serverName} tools

You MUST use the \`mcp\` tool to call ${serverName}. Do NOT run shell commands. Do NOT invent other tools.

The \`mcp\` tool requires these parameters:
- **server** (string, required): Always \`"${serverName}"\`
- **tool** (string, required): One of the tool names listed below
- **params** (string, optional): A JSON string with tool parameters
- **_confirm** (string, required): Always \`"slim-${serverName}"\`

### Example

To call \`${exTool.name}\`, invoke the \`mcp\` tool like this:

\`\`\`
server: "${serverName}"
tool: "${exTool.name}"
params: '${exParams}'
_confirm: "slim-${serverName}"
\`\`\`

## Available Tools

| Tool | Description |
|---|---|
${toolTable}

## Parameter Reference

${paramSections}
`;
}

// ─── File Writers ────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Remove legacy artifacts from ~/.config/opencode/ left by versions < 0.5.0. */
function cleanupLegacyPaths(serverNames: string[]): void {
  const legacyAiSkillsDir = join(DEFAULT_BASE_DIR, ".ai-skills", "slim-mcp");
  const legacySkillsDir = join(DEFAULT_BASE_DIR, "skills");

  // Remove old .ai-skills/slim-mcp/ directory (status.json, schemas, manifest)
  if (existsSync(legacyAiSkillsDir)) {
    try {
      rmSync(legacyAiSkillsDir, { recursive: true, force: true });
    } catch {}
  }

  // Remove old generated skills: ~/.config/opencode/skills/mcp-<server>/
  for (const name of serverNames) {
    const legacySkillDir = join(legacySkillsDir, `mcp-${name}`);
    if (existsSync(legacySkillDir)) {
      try {
        rmSync(legacySkillDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

function writeSkill(serverName: string, content: string): void {
  const dir = join(GENERATED_SKILLS_DIR, `mcp-${serverName}`);
  ensureDir(dir);
  writeFileSync(join(dir, "SKILL.md"), content, "utf8");
}

function writeSchemas(serverName: string, tools: ToolInfo[]): void {
  const schemaDir = join(STATE_DIR, "schemas", serverName);
  ensureDir(schemaDir);
  for (const t of tools) {
    writeFileSync(
      join(schemaDir, `${t.name}.json`),
      JSON.stringify(t.inputSchema ?? {}, null, 2),
      "utf8"
    );
  }
}

// ─── Manifest ────────────────────────────────────────────────────────────────

interface ManifestServerEntry {
  toolCount: number;
  tools: { name: string; description: string }[];
}

interface Manifest {
  generatedAt: string;
  servers: Record<string, ManifestServerEntry>;
}

function loadManifest(): Manifest | null {
  const manifestPath = join(STATE_DIR, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function saveManifest(manifest: Manifest): void {
  ensureDir(STATE_DIR);
  writeFileSync(
    join(STATE_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );
}

// ─── Server Processing ───────────────────────────────────────────────────────

async function processServers(
  names: string[],
  pool: McpConnectionPool,
  manifest: Manifest,
  failedServers: Set<string>,
  pluginConfig: SlimPluginConfig,
): Promise<void> {
  const results = await Promise.allSettled(
    names.map(async (name) => {
      const client = await pool.getClient(name);
      const { tools } = await client.listTools();
      if (tools.length === 0) return;

      const toolInfos = tools as ToolInfo[];
      writeSkill(name, generateSkillMd(name, toolInfos));
      writeSchemas(name, toolInfos);
      manifest.servers[name] = {
        toolCount: toolInfos.length,
        tools: toolInfos.map((t) => ({
          name: t.name,
          description: firstLine(t.description),
        })),
      };
    })
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "rejected") {
      const name = names[i];
      const reason = (results[i] as PromiseRejectedResult).reason;
      const msg = String(reason?.message ?? reason);
      failedServers.add(name);
      await pool.markFailed(name, msg);
      if (pluginConfig.debugging) {
        console.error(`[slim-mcp] Failed to connect/introspect ${name}:`, reason);
      }
    }
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const SlimMcpPlugin: Plugin = async (input) => {
  const projectDir = input.directory;
  const pluginConfig = loadPluginConfig(projectDir);
  const rawEntries = extractSlimMcpEntries(projectDir);
  const pool = new McpConnectionPool(pluginConfig);
  const allSlimNames = new Set<string>(Object.keys(rawEntries));
  const manifest: Manifest = { generatedAt: new Date().toISOString(), servers: {} };
  const failedServers = new Set<string>();

  // Phase 1: register + connect + introspect raw file entries
  for (const [name, config] of Object.entries(rawEntries)) {
    if (config.enabled !== false) pool.register(name, config);
  }

  if (pool.enabledServers().length > 0) {
    cleanupLegacyPaths(Object.keys(rawEntries));
    for (const dir of [GENERATED_SKILLS_DIR, join(STATE_DIR, "schemas")]) {
      if (existsSync(dir)) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
    await processServers(pool.enabledServers(), pool, manifest, failedServers, pluginConfig);
    saveManifest(manifest);
    pool.writeStatus();
  }

  return {
    config: async (cfg: any) => {
      // Phase 2: discover slim entries injected into cfg.mcp by prior plugins
      const cfgEntries = extractCfgMcpEntries(cfg, allSlimNames);

      if (Object.keys(cfgEntries).length > 0) {
        // Wipe stale artifacts if phase 1 skipped it (no raw entries)
        if (Object.keys(rawEntries).length === 0) {
          for (const dir of [GENERATED_SKILLS_DIR, join(STATE_DIR, "schemas")]) {
            if (existsSync(dir)) {
              try { rmSync(dir, { recursive: true, force: true }); } catch {}
            }
          }
        }

        for (const [name, config] of Object.entries(cfgEntries)) {
          allSlimNames.add(name);
          if (config.enabled !== false) pool.register(name, config);
        }

        const newNames = Object.keys(cfgEntries).filter(
          (n) => cfgEntries[n].enabled !== false,
        );
        if (newNames.length > 0) {
          await processServers(newNames, pool, manifest, failedServers, pluginConfig);
          saveManifest(manifest);
          pool.writeStatus();
        }
      }

      // Remove/strip all slim entries from cfg.mcp before opencode validation
      cleanCfgMcp(cfg, allSlimNames, failedServers);

      cfg.skills = cfg.skills || {};
      cfg.skills.paths = cfg.skills.paths || [];
      if (!cfg.skills.paths.includes(GENERATED_SKILLS_DIR)) {
        cfg.skills.paths.push(GENERATED_SKILLS_DIR);
      }
      if (!cfg.skills.paths.includes(SKILLS_DIR)) {
        cfg.skills.paths.push(SKILLS_DIR);
      }
    },

    tool: {
      mcp: createMcpTool(pool),
      "mcp-status": createMcpStatusTool(pool),
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const servers = pool.enabledServers();
      if (servers.length > 0) {
        const manifest = loadManifest();
        const skillList = servers.map((s) => `"mcp-${s}"`).join(", ");

        let catalog = "";
        if (manifest?.servers) {
          for (const s of servers) {
            const entry = manifest.servers[s];
            if (!entry?.tools?.length) continue;
            const names = entry.tools.map((t) => t.name).join(", ");
            catalog += `\n- ${s} (skill: "mcp-${s}"): ${names}`;
          }
        }

        output.system.push(
          `<system-reminder>\n` +
          `MCP TOOL USAGE — MANDATORY WORKFLOW:\n` +
          `Before calling the "mcp" tool, you MUST first load the matching skill using the skill tool.\n` +
          `Available MCP skills: ${skillList}.\n` +
          `Step 1: Load skill (e.g. skill name="mcp-${servers[0]}").\n` +
          `Step 2: Read the skill output to find tool parameters and the required confirmation token.\n` +
          `Step 3: Call the mcp tool with server, tool, params, and _confirm.\n` +
          `Do NOT guess parameters or confirmation tokens. Always load the skill first.\n` +
          (catalog ? `\nAvailable tools per server:${catalog}` : "") +
          `</system-reminder>`
        );
      }

      const needsAuth = pool.serversNeedingAuth();
      if (needsAuth.length === 0) return;

      const lines = needsAuth.map(
        (name) => `- MCP server '${name}' requires authentication. Run: opencode mcp auth ${name}`
      );
      output.system.push(
        `<system-reminder>\n` +
        `The following MCP servers need authentication before use:\n` +
        `${lines.join("\n")}\n` +
        `Inform the user about this when relevant.\n` +
        `</system-reminder>`
      );
    },
  };
};

export { SlimMcpPlugin, extractCfgMcpEntries, cleanCfgMcp };

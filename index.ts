import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { fileURLToPath } from "url";
import path from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(__dirname, "..", "..", "skills");

const DEFAULT_BASE_DIR = join(homedir(), ".config", "opencode");
const DEFAULT_SKILLS_DIR = join(DEFAULT_BASE_DIR, "skills");
const AI_SKILLS_DIR = join(DEFAULT_BASE_DIR, ".ai-skills", "slim-mcp");

// ─── Types ───────────────────────────────────────────────────────────────────

interface SlimMcpConfig {
  command: string[];
  environment?: Record<string, string>;
  slim?: boolean;
  enabled?: boolean;
  timeout?: number;
}

interface SlimPluginConfig {
  lazyLoading: boolean;
  idleShutdownMs: number;
}

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

type ServerState = "pending" | "connected" | "disabled" | "error";

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
        lazyLoading: raw["lazy-loading"] !== false,
        idleShutdownMs: raw["lazy-idle-shutdown-interval"]
          ? parseIntervalMs(String(raw["lazy-idle-shutdown-interval"]))
          : DEFAULT_IDLE_MS,
      };
    } catch {
      continue;
    }
  }

  return { lazyLoading: true, idleShutdownMs: DEFAULT_IDLE_MS };
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

function isLocalMcp(entry: any): boolean {
  return !entry.type || entry.type === "local";
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
        if (entry.slim !== true || !isLocalMcp(entry)) continue;

        const command = normalizeCommand(entry);
        if (!command) continue;

        slimEntries[name] = {
          command,
          environment: entry.environment,
          slim: true,
          enabled: entry.enabled,
          timeout: entry.timeout,
        };
      }
    } catch {
      continue;
    }
  }

  return slimEntries;
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
  private idleShutdownMs: number;
  private lazy: boolean;

  constructor(pluginConfig: SlimPluginConfig) {
    this.idleShutdownMs = pluginConfig.idleShutdownMs;
    this.lazy = pluginConfig.lazyLoading;
  }

  register(name: string, config: SlimMcpConfig): void {
    this.configs.set(name, config);
  }

  availableServers(): string[] {
    return [...this.configs.keys()];
  }

  serverState(name: string): ServerState {
    const config = this.configs.get(name);
    if (!config) return "disabled";
    if (config.enabled === false) return "disabled";
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

  async connectAll(): Promise<void> {
    const names = this.enabledServers();
    const results = await Promise.allSettled(
      names.map((n) => this.getClient(n))
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        const reason = (results[i] as PromiseRejectedResult).reason;
        this.errors.set(names[i], String(reason?.message ?? reason));
        console.error(`[slim-mcp] Failed to connect ${names[i]}:`, reason);
      }
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

    const env = config.environment
      ? { ...process.env, ...config.environment }
      : undefined;

    const [command, ...args] = config.command;
    const transport = new StdioClientTransport({
      command,
      args,
      env,
      stderr: "pipe",
    });
    const client = new Client({
      name: `slim-mcp-${name}`,
      version: "1.0.0",
    });

    try {
      await client.connect(transport);
    } catch (err: any) {
      this.errors.set(name, String(err?.message ?? err));
      throw err;
    }

    const timer =
      this.lazy && this.idleShutdownMs > 0
        ? setTimeout(() => this.disconnect(name), this.idleShutdownMs)
        : null;

    this.connections.set(name, { client, lastUsed: Date.now(), timer });
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
  }
}

// ─── Introspection ───────────────────────────────────────────────────────────

async function introspectServer(config: SlimMcpConfig): Promise<ToolInfo[]> {
  const [command, ...args] = config.command;
  const env = config.environment
    ? { ...process.env, ...config.environment }
    : undefined;

  const transport = new StdioClientTransport({
    command,
    args,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "slim-mcp-introspect", version: "1.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    return tools as ToolInfo[];
  } catch {
    try {
      await client.close();
    } catch {}
    return [];
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
      "Use the mcp-<server> skill to discover available tools and parameters. " +
      "Available servers: " +
      pool.enabledServers().join(", "),
    args: {
      server: tool.schema
        .string()
        .describe("MCP server name, e.g. todoist, playwright"),
      tool: tool.schema
        .string()
        .describe("Tool name on that server, e.g. web_search, add-tasks"),
      params: tool.schema
        .string()
        .optional()
        .describe(
          'Tool parameters as JSON string, e.g. \'{"query": "test"}\''
        ),
    },
    async execute(args, ctx) {
      ctx.metadata({ title: `mcp: ${args.server}/${args.tool}` });

      const client = await pool.getClient(args.server);
      const toolParams = args.params ? JSON.parse(args.params) : {};

      const result = await client.callTool({
        name: args.tool,
        arguments: toolParams,
      });

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
            : state === "error"
              ? "[error]"
              : state === "disabled"
                ? "[disabled]"
                : "[pending]";
        const suffix = error ? ` — ${error}` : "";
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

  return `---
name: mcp-${serverName}
description: >
  Use when interacting with ${serverName} via MCP.
  Triggers on: ${serverName}, ${triggers}.
---

# ${serverName} MCP Tools

Call via the \`mcp\` tool:

\`\`\`
mcp(server="${serverName}", tool="<tool_name>", params='{"key": "value"}')
\`\`\`

## Available Tools

| Tool | Description |
|---|---|
${toolTable}

## Parameters

${paramSections}
`;
}

// ─── File Writers ────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function writeSkill(serverName: string, content: string): void {
  const dir = join(DEFAULT_SKILLS_DIR, `mcp-${serverName}`);
  ensureDir(dir);
  writeFileSync(join(dir, "SKILL.md"), content, "utf8");
}

function writeSchemas(serverName: string, tools: ToolInfo[]): void {
  const schemaDir = join(AI_SKILLS_DIR, "schemas", serverName);
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

const MANIFEST_VERSION = 3;

interface Manifest {
  version?: number;
  generatedAt: string;
  servers: Record<string, { toolCount: number }>;
}

function loadManifest(): Manifest | null {
  const manifestPath = join(AI_SKILLS_DIR, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function saveManifest(manifest: Manifest): void {
  ensureDir(AI_SKILLS_DIR);
  writeFileSync(
    join(AI_SKILLS_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );
}

function needsRegeneration(servers: Record<string, SlimMcpConfig>): boolean {
  const manifest = loadManifest();
  if (!manifest) return true;
  if ((manifest.version ?? 0) < MANIFEST_VERSION) return true;

  const enabledServers = Object.entries(servers)
    .filter(([, cfg]) => cfg.enabled !== false)
    .map(([name]) => name);
  const manifestKeys = Object.keys(manifest.servers).sort().join(",");
  const currentKeys = enabledServers.sort().join(",");
  return manifestKeys !== currentKeys;
}

// ─── Generation Orchestrator ─────────────────────────────────────────────────

async function generateAll(
  servers: Record<string, SlimMcpConfig>,
  pool: McpConnectionPool
): Promise<void> {
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    servers: {},
  };

  const entries = Object.entries(servers).filter(
    ([, cfg]) => cfg.enabled !== false
  );
  const results = await Promise.allSettled(
    entries.map(async ([serverName, config]) => {
      pool.register(serverName, config);
      const tools = await introspectServer(config);
      if (tools.length === 0) return;

      writeSkill(serverName, generateSkillMd(serverName, tools));
      writeSchemas(serverName, tools);
      manifest.servers[serverName] = { toolCount: tools.length };
    })
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "rejected") {
      const name = entries[i][0];
      console.error(
        `[slim-mcp] Failed to introspect ${name}:`,
        (results[i] as PromiseRejectedResult).reason
      );
    }
  }

  saveManifest(manifest);
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const SlimMcpPlugin: Plugin = async (input) => {
  const projectDir = input.directory;
  const pluginConfig = loadPluginConfig(projectDir);
  const slimEntries = extractSlimMcpEntries(projectDir);
  const pool = new McpConnectionPool(pluginConfig);

  if (Object.keys(slimEntries).length === 0) {
    return {
      config: async (cfg: any) => {
        cfg.skills = cfg.skills || {};
        cfg.skills.paths = cfg.skills.paths || [];
        if (!cfg.skills.paths.includes(SKILLS_DIR)) {
          cfg.skills.paths.push(SKILLS_DIR);
        }
      },
    };
  }

  // Register all servers in pool
  for (const [name, config] of Object.entries(slimEntries)) {
    pool.register(name, config);
  }

  // Regenerate skills if needed
  if (needsRegeneration(slimEntries)) {
    await generateAll(slimEntries, pool);
  }

  // Eager connect if lazy-loading is disabled
  if (!pluginConfig.lazyLoading) {
    await pool.connectAll();
  }

  return {
    config: async (cfg: any) => {
      if (cfg.mcp) {
        const slimNames = new Set(Object.keys(slimEntries).filter(
          (name) => slimEntries[name].enabled !== false
        ));
        for (const [name, entry] of Object.entries(cfg.mcp) as [string, any][]) {
          if (slimNames.has(name)) {
            entry.enabled = false;
          }
        }
      }

      cfg.skills = cfg.skills || {};
      cfg.skills.paths = cfg.skills.paths || [];

      if (!cfg.skills.paths.includes(DEFAULT_SKILLS_DIR)) {
        cfg.skills.paths.push(DEFAULT_SKILLS_DIR);
      }
      if (!cfg.skills.paths.includes(SKILLS_DIR)) {
        cfg.skills.paths.push(SKILLS_DIR);
      }
    },

    tool: {
      mcp: createMcpTool(pool),
      "mcp-status": createMcpStatusTool(pool),
    },
  };
};

export { SlimMcpPlugin };

import type { Plugin, ToolDefinition } from "@opencode-ai/plugin";
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
import { z } from "zod";

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

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

// ─── Config Discovery ────────────────────────────────────────────────────────

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

const IDLE_TIMEOUT_MS = 60_000;

interface PooledConnection {
  client: Client;
  transport: StdioClientTransport;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
}

class McpConnectionPool {
  private connections = new Map<string, PooledConnection>();
  private configs = new Map<string, SlimMcpConfig>();

  register(name: string, config: SlimMcpConfig): void {
    this.configs.set(name, config);
  }

  async getClient(name: string): Promise<Client> {
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

    const env = config.environment
      ? { ...process.env, ...config.environment }
      : undefined;

    const [command, ...args] = config.command;
    const transport = new StdioClientTransport({
      command,
      args,
      env,
    });
    const client = new Client({
      name: `slim-mcp-${name}`,
      version: "1.0.0",
    });

    await client.connect(transport);

    const pooled: PooledConnection = {
      client,
      transport,
      lastUsed: Date.now(),
      timer: setTimeout(() => this.disconnect(name), IDLE_TIMEOUT_MS),
    };

    this.connections.set(name, pooled);
    return client;
  }

  private resetIdleTimer(
    name: string,
    connection: PooledConnection
  ): void {
    clearTimeout(connection.timer);
    connection.timer = setTimeout(
      () => this.disconnect(name),
      IDLE_TIMEOUT_MS
    );
  }

  private async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;

    clearTimeout(connection.timer);
    this.connections.delete(name);

    try {
      await connection.client.close();
    } catch {
      // Server may already be gone
    }
  }

  async disconnectAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.allSettled(names.map((n) => this.disconnect(n)));
  }
}

// ─── Introspection ───────────────────────────────────────────────────────────

async function introspectServer(config: SlimMcpConfig): Promise<ToolInfo[]> {
  const [command, ...args] = config.command;
  const env = config.environment
    ? { ...process.env, ...config.environment }
    : undefined;

  const transport = new StdioClientTransport({ command, args, env });
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

// ─── Zod Schema Conversion ──────────────────────────────────────────────────

function jsonSchemaPropertyToZod(prop: any, isRequired: boolean): z.ZodTypeAny {
  let schema: z.ZodTypeAny;

  switch (prop.type) {
    case "string":
      schema = prop.enum ? z.enum(prop.enum) : z.string();
      break;
    case "number":
    case "integer":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "array":
      schema = z.array(z.any());
      break;
    case "object":
      schema = z.record(z.any());
      break;
    default:
      schema = z.any();
  }

  if (prop.description) {
    schema = schema.describe(prop.description);
  }

  return isRequired ? schema : schema.optional();
}

function jsonSchemaToZodShape(
  inputSchema?: Record<string, any>
): z.ZodRawShape {
  if (!inputSchema?.properties) return {};

  const required = new Set(inputSchema.required || []);
  const shape: z.ZodRawShape = {};

  for (const [name, prop] of Object.entries(inputSchema.properties) as [
    string,
    any,
  ][]) {
    shape[name] = jsonSchemaPropertyToZod(prop, required.has(name));
  }

  return shape;
}

// ─── Proxy Tool Registration ─────────────────────────────────────────────────

function createProxyTool(
  serverName: string,
  toolInfo: ToolInfo,
  pool: McpConnectionPool
): ToolDefinition {
  const description = toolInfo.description || `Call ${toolInfo.name} on ${serverName} MCP`;
  const zodShape = jsonSchemaToZodShape(toolInfo.inputSchema);

  return tool({
    description,
    args: zodShape,
    async execute(args, ctx) {
      ctx.metadata({ title: `${serverName}/${toolInfo.name}` });

      const client = await pool.getClient(serverName);
      const result = await client.callTool({
        name: toolInfo.name,
        arguments: args,
      });

      const content = result.content ?? result;
      if (Array.isArray(content)) {
        return content
          .map((item: any) =>
            item.type === "text" ? item.text : JSON.stringify(item, null, 2)
          )
          .join("\n");
      }

      return JSON.stringify(content, null, 2);
    },
  });
}

function buildProxyTools(
  serverName: string,
  tools: ToolInfo[],
  pool: McpConnectionPool
): Record<string, ToolDefinition> {
  const result: Record<string, ToolDefinition> = {};

  for (const toolInfo of tools) {
    const toolKey = `${serverName}_${toolInfo.name}`;
    result[toolKey] = createProxyTool(serverName, toolInfo, pool);
  }

  return result;
}

// ─── SKILL.md Generation ─────────────────────────────────────────────────────

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
      const desc = prop.description ? ` — ${prop.description}` : "";
      return `- \`${name}\` (${type}${req})${desc}`;
    })
    .join("\n");
}

function generateSkillMd(serverName: string, tools: ToolInfo[]): string {
  const triggers = tools
    .slice(0, 3)
    .map((t) => t.name.replace(/_/g, " "))
    .join(", ");

  const toolTableWithIds = tools
    .map((t) => `| \`${serverName}_${t.name}\` | ${t.description || ""} |`)
    .join("\n");
  const paramSectionsWithIds = tools
    .map((t) => `#### \`${serverName}_${t.name}\`\n${formatParamDocs(t)}`)
    .join("\n\n");

  return `---
name: mcp-${serverName}
description: >
  Use when interacting with ${serverName} via MCP.
  Triggers on: ${serverName}, ${triggers}.
---

# ${serverName} MCP Tools

These are native opencode tools. Call them directly by tool name — do NOT use Bash or CLI wrappers.

## Tools

| Tool (use this exact name) | Description |
|---|---|
${toolTableWithIds}

## Parameters

${paramSectionsWithIds}
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
  for (const toolInfo of tools) {
    writeFileSync(
      join(schemaDir, `${toolInfo.name}.json`),
      JSON.stringify(toolInfo.inputSchema ?? {}, null, 2),
      "utf8"
    );
  }
}

// ─── Manifest ────────────────────────────────────────────────────────────────

const MANIFEST_VERSION = 2;

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

function needsRegeneration(
  servers: Record<string, SlimMcpConfig>
): boolean {
  const manifest = loadManifest();
  if (!manifest) return true;
  if ((manifest.version ?? 0) < MANIFEST_VERSION) return true;

  const manifestKeys = Object.keys(manifest.servers).sort().join(",");
  const currentKeys = Object.keys(servers).sort().join(",");
  return manifestKeys !== currentKeys;
}

// ─── Generation Orchestrator ─────────────────────────────────────────────────

interface GenerationResult {
  tools: Record<string, ToolDefinition>;
  serverTools: Record<string, ToolInfo[]>;
}

async function generateAll(
  servers: Record<string, SlimMcpConfig>,
  pool: McpConnectionPool
): Promise<GenerationResult> {
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    servers: {},
  };
  let allTools: Record<string, ToolDefinition> = {};
  const serverTools: Record<string, ToolInfo[]> = {};

  const entries = Object.entries(servers);
  const results = await Promise.allSettled(
    entries.map(async ([serverName, config]) => {
      pool.register(serverName, config);
      const tools = await introspectServer(config);
      if (tools.length === 0) return;

      serverTools[serverName] = tools;
      writeSkill(serverName, generateSkillMd(serverName, tools));
      writeSchemas(serverName, tools);

      const proxyTools = buildProxyTools(serverName, tools, pool);
      allTools = { ...allTools, ...proxyTools };

      manifest.servers[serverName] = { toolCount: tools.length };
    })
  );

  // Log failures for visibility
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
  return { tools: allTools, serverTools };
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const SlimMcpPlugin: Plugin = async (input) => {
  const projectDir = input.directory;
  const slimEntries = extractSlimMcpEntries(projectDir);
  const pool = new McpConnectionPool();

  let proxyTools: Record<string, ToolDefinition> = {};

  if (Object.keys(slimEntries).length > 0) {
    if (needsRegeneration(slimEntries)) {
      const result = await generateAll(slimEntries, pool);
      proxyTools = result.tools;
    } else {
      // Skills already generated — just register pool + build tools from cached schemas
      for (const [name, config] of Object.entries(slimEntries)) {
        pool.register(name, config);

        const schemaDir = join(AI_SKILLS_DIR, "schemas", name);
        if (!existsSync(schemaDir)) continue;

        const { readdirSync } = await import("fs");
        const schemaFiles = readdirSync(schemaDir).filter((f: string) =>
          f.endsWith(".json")
        );

        const tools: ToolInfo[] = schemaFiles.map((f: string) => {
          const toolName = f.slice(0, -5);
          const schema = JSON.parse(
            readFileSync(join(schemaDir, f), "utf8")
          );
          return { name: toolName, inputSchema: schema };
        });

        const toolsForServer = buildProxyTools(name, tools, pool);
        proxyTools = { ...proxyTools, ...toolsForServer };
      }
    }
  }

  return {
    config: async (cfg: any) => {
      // Disable slim MCPs so opencode doesn't load their tool schemas
      if (cfg.mcp) {
        for (const [name, entry] of Object.entries(cfg.mcp) as [
          string,
          any,
        ][]) {
          if (entry.slim === true) {
            entry.enabled = false;
          }
        }
      }

      // Register skills paths
      cfg.skills = cfg.skills || {};
      cfg.skills.paths = cfg.skills.paths || [];

      if (!cfg.skills.paths.includes(DEFAULT_SKILLS_DIR)) {
        cfg.skills.paths.push(DEFAULT_SKILLS_DIR);
      }
      if (!cfg.skills.paths.includes(SKILLS_DIR)) {
        cfg.skills.paths.push(SKILLS_DIR);
      }
    },

    tool: proxyTools,
  };
};

export { SlimMcpPlugin };

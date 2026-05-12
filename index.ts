import type { Plugin } from "@opencode-ai/plugin";
import { fileURLToPath } from "url";
import path from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(__dirname, "..", "..", "skills");

const DEFAULT_BASE_DIR = join(homedir(), ".config", "opencode");
const DEFAULT_BIN_DIR = join(DEFAULT_BASE_DIR, "bin");
const DEFAULT_SKILLS_DIR = join(DEFAULT_BASE_DIR, "skills");
const AI_SKILLS_DIR = join(DEFAULT_BASE_DIR, ".ai-skills", "slim-mcp");

// ─── MCP Config Discovery ────────────────────────────────────────────────────

interface ServerConfig {
  command: string;
  args?: string[];
}

function findMcpConfig(projectDir: string): Record<string, ServerConfig> | null {
  const candidates = [
    join(projectDir, "slim-mcp.json"),
    join(DEFAULT_BASE_DIR, "slim-mcp.json"),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const config = JSON.parse(readFileSync(candidate, "utf8"));
      const servers = config.mcpServers ?? config.servers;
      if (servers && Object.keys(servers).length > 0) return servers;
    } catch {
      continue;
    }
  }

  return null;
}

// ─── Introspection ───────────────────────────────────────────────────────────

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

async function introspectServer(serverConfig: ServerConfig): Promise<ToolInfo[]> {
  const { command, args = [] } = serverConfig;
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "slim-mcp-plugin", version: "1.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    return tools as ToolInfo[];
  } catch {
    try { await client.close(); } catch {}
    return [];
  }
}

// ─── SKILL.md Generation ─────────────────────────────────────────────────────

function formatParamDocs(tool: ToolInfo): string {
  const schema = tool.inputSchema;
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
  const toolTable = tools
    .map((t) => `| \`${t.name}\` | ${t.description || ""} |`)
    .join("\n");
  const paramSections = tools
    .map((t) => `#### \`${t.name}\`\n${formatParamDocs(t)}`)
    .join("\n\n");
  const triggers = tools.slice(0, 3).map((t) => t.name.replace(/_/g, " ")).join(", ");

  return `---
name: mcp-${serverName}
description: >
  Use when interacting with ${serverName} via MCP.
  Triggers on: ${serverName}, ${triggers}.
---

# ${serverName} MCP Tools

## Usage

\`\`\`bash
mcp-${serverName} <tool> [key=value ...]          # call tool
mcp-${serverName} <tool> --params '{"key":"val"}' # complex params via JSON
echo '{"key":"val"}' | mcp-${serverName} <tool> - # complex params via stdin
mcp-${serverName} --list                           # list available tools
mcp-${serverName} --schema <tool>                  # show tool schema
\`\`\`

## Tools

| Tool | Description |
|---|---|
${toolTable}

## Parameters

${paramSections}
`;
}

// ─── CLI Wrapper Generation ──────────────────────────────────────────────────

function generateCliWrapper(serverName: string, serverConfig: ServerConfig): string {
  const schemaDir = join(AI_SKILLS_DIR, "schemas", serverName);

  return `#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const SCHEMA_DIR = ${JSON.stringify(schemaDir)};
const SERVER_CMD = ${JSON.stringify(serverConfig.command)};
const SERVER_ARGS = ${JSON.stringify(serverConfig.args || [])};

function listTools() {
  try {
    return readdirSync(SCHEMA_DIR).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5));
  } catch { return []; }
}

function showSchema(toolName) {
  try {
    console.log(readFileSync(join(SCHEMA_DIR, toolName + ".json"), "utf8"));
  } catch {
    console.error("Schema not found for: " + toolName);
    process.exit(1);
  }
}

function parseKvArgs(argv) {
  const params = {};
  for (const pair of argv) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair[eq - 1] === ":") {
      const key = pair.slice(0, eq - 1);
      try { params[key] = JSON.parse(pair.slice(eq + 1)); }
      catch { params[key] = pair.slice(eq + 1); }
    } else {
      params[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return params;
}

async function callTool(toolName, toolParams) {
  const transport = new StdioClientTransport({ command: SERVER_CMD, args: SERVER_ARGS });
  const client = new Client({ name: "mcp-${serverName}-cli", version: "1.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: toolName, arguments: toolParams });
    const content = result.content ?? result;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === "text") process.stdout.write(item.text);
        else console.log(JSON.stringify(item, null, 2));
      }
    } else {
      console.log(JSON.stringify(content, null, 2));
    }
  } finally {
    await client.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--list") { listTools().forEach(t => console.log(t)); return; }
  if (argv[0] === "--schema") { showSchema(argv[1]); return; }
  const toolName = argv[0];
  if (!toolName) { console.error("Usage: mcp-${serverName} <tool> [key=value ...]"); process.exit(1); }

  const paramsIdx = argv.indexOf("--params");
  const stdinIdx = argv.indexOf("-");
  let toolParams = {};
  if (paramsIdx !== -1 && argv[paramsIdx + 1]) {
    toolParams = JSON.parse(argv[paramsIdx + 1]);
  } else if (stdinIdx !== -1) {
    toolParams = JSON.parse(readFileSync("/dev/stdin", "utf8").trim());
  } else {
    toolParams = parseKvArgs(argv.slice(1).filter(a => !a.startsWith("--")));
  }
  await callTool(toolName, toolParams);
}

main().catch(err => { console.error(err.message); process.exit(1); });
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

function writeCliWrapper(serverName: string, content: string): void {
  ensureDir(DEFAULT_BIN_DIR);
  const filePath = join(DEFAULT_BIN_DIR, `mcp-${serverName}`);
  writeFileSync(filePath, content, "utf8");
  chmodSync(filePath, 0o755);
}

function writeSchemas(serverName: string, tools: ToolInfo[]): void {
  const schemaDir = join(AI_SKILLS_DIR, "schemas", serverName);
  ensureDir(schemaDir);
  for (const tool of tools) {
    writeFileSync(
      join(schemaDir, `${tool.name}.json`),
      JSON.stringify(tool.inputSchema ?? {}, null, 2),
      "utf8"
    );
  }
}

// ─── Generation Orchestrator ─────────────────────────────────────────────────

interface Manifest {
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
  writeFileSync(join(AI_SKILLS_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function configHash(servers: Record<string, ServerConfig>): string {
  return JSON.stringify(Object.keys(servers).sort());
}

function needsRegeneration(servers: Record<string, ServerConfig>): boolean {
  const manifest = loadManifest();
  if (!manifest) return true;

  const manifestServers = Object.keys(manifest.servers).sort().join(",");
  const currentServers = Object.keys(servers).sort().join(",");
  return manifestServers !== currentServers;
}

async function generateAll(servers: Record<string, ServerConfig>): Promise<void> {
  const manifest: Manifest = { generatedAt: new Date().toISOString(), servers: {} };

  const results = await Promise.allSettled(
    Object.entries(servers).map(async ([serverName, serverConfig]) => {
      const tools = await introspectServer(serverConfig);
      if (tools.length === 0) return;

      writeSkill(serverName, generateSkillMd(serverName, tools));
      writeCliWrapper(serverName, generateCliWrapper(serverName, serverConfig));
      writeSchemas(serverName, tools);
      manifest.servers[serverName] = { toolCount: tools.length };
    })
  );

  saveManifest(manifest);
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const SlimMcpPlugin: Plugin = async (input) => {
  const projectDir = input.directory;
  const servers = findMcpConfig(projectDir);

  if (servers && needsRegeneration(servers)) {
    generateAll(servers).catch(() => {});
  }

  return {
    config: async (cfg: any) => {
      cfg.skills = cfg.skills || {};
      cfg.skills.paths = cfg.skills.paths || [];

      if (!cfg.skills.paths.includes(DEFAULT_SKILLS_DIR)) {
        cfg.skills.paths.push(DEFAULT_SKILLS_DIR);
      }

      if (!cfg.skills.paths.includes(SKILLS_DIR)) {
        cfg.skills.paths.push(SKILLS_DIR);
      }
    },

    "shell.env": async (_input, output) => {
      if (!existsSync(DEFAULT_BIN_DIR)) return;

      const currentPath = output.env.PATH || process.env.PATH || "";
      if (!currentPath.includes(DEFAULT_BIN_DIR)) {
        output.env.PATH = `${DEFAULT_BIN_DIR}:${currentPath}`;
      }
    },
  };
};

export { SlimMcpPlugin };

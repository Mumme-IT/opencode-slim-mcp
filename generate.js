#!/usr/bin/env node
// generate.js — reads mcp-lazy-proxy.json, introspects MCP servers, generates SKILL.md + CLI wrappers
// Usage: node generate.js [config.json] [--output-dir /path] [--skills-dir /path] [--bin-dir /path]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG_FILE = "mcp-lazy-proxy.json";

function getConfigBaseDir(env = process.env, homeDir = homedir()) {
  if (env.OPENCODE_CONFIG) return dirname(env.OPENCODE_CONFIG);
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "opencode");
  return join(homeDir, ".config", "opencode");
}

const DEFAULT_BASE_DIR = getConfigBaseDir();

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    configFile: DEFAULT_CONFIG_FILE,
    outputDir: null,
    skillsDir: null,
    binDir: null,
    aiSkillsDir: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-dir") opts.outputDir = args[++i];
    else if (args[i] === "--skills-dir") opts.skillsDir = args[++i];
    else if (args[i] === "--bin-dir") opts.binDir = args[++i];
    else if (args[i] === "--ai-skills-dir") opts.aiSkillsDir = args[++i];
    else if (!args[i].startsWith("--")) opts.configFile = args[i];
  }

  const base = opts.outputDir ? resolve(opts.outputDir) : DEFAULT_BASE_DIR;
  opts.skillsDir = opts.skillsDir ? resolve(opts.skillsDir) : join(base, "skills");
  opts.binDir = opts.binDir ? resolve(opts.binDir) : join(base, "bin");
  opts.aiSkillsDir = opts.aiSkillsDir ? resolve(opts.aiSkillsDir) : join(base, ".ai-skills", "slim-mcp");

  return opts;
}

// ─── MCP Introspection ───────────────────────────────────────────────────────

async function introspectServer(serverName, serverConfig) {
  const { command, args = [] } = serverConfig;
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: "slim-mcp-generator", version: "1.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    return tools;
  } catch (err) {
    console.error(`  ✗ ${serverName}: ${err.message}`);
    return [];
  }
}

// ─── SKILL.md Generation ─────────────────────────────────────────────────────

function formatParamDocs(tool) {
  const schema = tool.inputSchema;
  if (!schema?.properties || Object.keys(schema.properties).length === 0) {
    return "(none)";
  }

  const required = new Set(schema.required || []);
  return Object.entries(schema.properties)
    .map(([name, prop]) => {
      const type = prop.type || "any";
      const req = required.has(name) ? ", required" : "";
      const desc = prop.description ? ` — ${prop.description}` : "";
      return `- \`${name}\` (${type}${req})${desc}`;
    })
    .join("\n");
}

function buildToolTable(tools) {
  const rows = tools.map((t) => `| \`${t.name}\` | ${t.description || ""} |`).join("\n");
  return `| Tool | Description |\n|---|---|\n${rows}`;
}

function buildParamSections(tools) {
  return tools
    .map((t) => `#### \`${t.name}\`\n${formatParamDocs(t)}`)
    .join("\n\n");
}

function buildTriggerHints(serverName, tools) {
  const names = tools.slice(0, 3).map((t) => t.name.replace(/_/g, " "));
  return names.join(", ");
}

function buildExampleParams(t) {
  const schema = t.inputSchema;
  if (!schema?.properties || Object.keys(schema.properties).length === 0) {
    return "{}";
  }
  const example = {};
  const required = new Set(schema.required || []);
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (!required.has(name) && Object.keys(example).length >= 2) continue;
    if (prop.type === "number" || prop.type === "integer") example[name] = 1;
    else if (prop.type === "boolean") example[name] = true;
    else example[name] = "...";
  }
  return JSON.stringify(example);
}

function generateSkillMd(serverName, tools) {
  const skillName = `mcp-${serverName}`;
  const triggers = buildTriggerHints(serverName, tools);
  const exTool = tools[0];
  const exParams = buildExampleParams(exTool);

  return `---
name: ${skillName}
description: >
  Use when interacting with ${serverName} via MCP.
  Triggers on: ${serverName}, ${triggers}.
---

# How to call ${serverName} tools

Use the CLI wrapper to call ${serverName} tools from the terminal.

\`\`\`bash
mcp-${serverName} <tool> [key=value ...]          # call tool
mcp-${serverName} <tool> --params '{"key":"val"}' # complex params via JSON
echo '{"key":"val"}' | mcp-${serverName} <tool> - # complex params via stdin
mcp-${serverName} --list                           # list available tools
mcp-${serverName} --schema <tool>                  # show tool schema
\`\`\`

### Example

\`\`\`bash
mcp-${serverName} ${exTool.name} --params '${exParams}'
\`\`\`

## Available Tools

${buildToolTable(tools)}

## Parameter Reference

${buildParamSections(tools)}
`;
}

// ─── CLI Wrapper Generation ──────────────────────────────────────────────────

function generateCliWrapper(serverName, serverConfig, aiSkillsDir) {
  const { command, args = [] } = serverConfig;
  const cmdStr = [command, ...args].map((a) => `"${a}"`).join(" ");
  const schemaDir = join(aiSkillsDir, "schemas", serverName);

  return `#!/usr/bin/env node
// mcp-${serverName} — CLI wrapper for ${serverName} MCP server
// Usage: mcp-${serverName} <tool> [key=value ...] [--params '{"json":"val"}']
//        mcp-${serverName} --list
//        mcp-${serverName} --schema <tool>

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const SCHEMA_DIR = ${JSON.stringify(schemaDir)};
const SERVER_CMD = ${JSON.stringify(command)};
const SERVER_ARGS = ${JSON.stringify(args)};

function listTools() {
  try {
    return readdirSync(SCHEMA_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => f.slice(0, -5));
  } catch {
    return [];
  }
}

function showSchema(toolName) {
  try {
    const data = readFileSync(join(SCHEMA_DIR, toolName + ".json"), "utf8");
    console.log(data);
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
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    // Support key:=json for complex values (httpie convention)
    if (pair.slice(eq - 1, eq) === ":") {
      const cleanKey = pair.slice(0, eq - 1);
      try { params[cleanKey] = JSON.parse(raw); }
      catch { params[cleanKey] = raw; }
    } else {
      params[key] = raw;
    }
  }
  return params;
}

function readStdinSync() {
  try {
    return readFileSync("/dev/stdin", "utf8").trim();
  } catch {
    return "";
  }
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

  if (argv[0] === "--list") {
    const tools = listTools();
    if (tools.length === 0) console.log("(no cached tools — run generator)");
    else tools.forEach(t => console.log(t));
    return;
  }

  if (argv[0] === "--schema") {
    if (!argv[1]) { console.error("Usage: --schema <tool>"); process.exit(1); }
    showSchema(argv[1]);
    return;
  }

  const toolName = argv[0];
  if (!toolName) {
    console.error("Usage: mcp-${serverName} <tool> [key=value ...] [--params '{}']");
    process.exit(1);
  }

  // Resolve params from --params flag, stdin (-), or key=value pairs
  const paramsIdx = argv.indexOf("--params");
  const stdinIdx = argv.indexOf("-");
  let toolParams = {};

  if (paramsIdx !== -1 && argv[paramsIdx + 1]) {
    toolParams = JSON.parse(argv[paramsIdx + 1]);
  } else if (stdinIdx !== -1) {
    toolParams = JSON.parse(readStdinSync());
  } else {
    toolParams = parseKvArgs(argv.slice(1).filter(a => !a.startsWith("--")));
  }

  await callTool(toolName, toolParams);
}

main().catch(err => { console.error(err.message); process.exit(1); });
`;
}

// ─── File Writers ────────────────────────────────────────────────────────────

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function writeSkill(skillsDir, serverName, content) {
  const dir = join(skillsDir, `mcp-${serverName}`);
  ensureDir(dir);
  const path = join(dir, "SKILL.md");
  writeFileSync(path, content, "utf8");
  return path;
}

function writeCliWrapper(binDir, serverName, content) {
  ensureDir(binDir);
  const path = join(binDir, `mcp-${serverName}`);
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function writeSchemas(aiSkillsDir, serverName, tools) {
  const schemaDir = join(aiSkillsDir, "schemas", serverName);
  ensureDir(schemaDir);
  for (const tool of tools) {
    const path = join(schemaDir, `${tool.name}.json`);
    writeFileSync(path, JSON.stringify(tool.inputSchema ?? {}, null, 2), "utf8");
  }
  return schemaDir;
}

function writeManifest(aiSkillsDir, manifest) {
  ensureDir(aiSkillsDir);
  const path = join(aiSkillsDir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf8");
  return path;
}

function writeConfigCache(aiSkillsDir, servers) {
  ensureDir(aiSkillsDir);
  const path = join(aiSkillsDir, "config.json");
  writeFileSync(path, JSON.stringify(servers, null, 2), "utf8");
  return path;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function generate() {
  const opts = parseArgs(process.argv);

  const configPath = resolve(opts.configFile);
  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  // Support both { mcpServers: {} } and { servers: {} } shapes
  const servers = config.mcpServers ?? config.servers ?? {};
  const serverNames = Object.keys(servers);

  if (serverNames.length === 0) {
    console.error("No servers found in config.");
    process.exit(1);
  }

  console.log(`\nGenerating skills for ${serverNames.length} server(s)...\n`);
  const manifest = { generatedAt: new Date().toISOString(), servers: {} };

  for (const serverName of serverNames) {
    const serverConfig = servers[serverName];
    console.log(`→ ${serverName}`);

    const tools = await introspectServer(serverName, serverConfig);
    if (tools.length === 0) {
      console.log(`  ⚠ Skipped (no tools introspected)`);
      continue;
    }

    const skillPath = writeSkill(opts.skillsDir, serverName, generateSkillMd(serverName, tools));
    const cliPath = writeCliWrapper(opts.binDir, serverName, generateCliWrapper(serverName, serverConfig, opts.aiSkillsDir));
    const schemaDir = writeSchemas(opts.aiSkillsDir, serverName, tools);

    manifest.servers[serverName] = {
      toolCount: tools.length,
      skillPath,
      cliPath,
      schemaDir,
    };

    console.log(`  ✓ ${tools.length} tools → ${skillPath}`);
    console.log(`  ✓ CLI wrapper → ${cliPath}`);
  }

  writeManifest(opts.aiSkillsDir, manifest);
  writeConfigCache(opts.aiSkillsDir, servers);

  console.log(`\nDone. Manifest: ${join(opts.aiSkillsDir, "manifest.json")}`);
}

generate().catch(err => { console.error(err); process.exit(1); });

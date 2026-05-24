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

function normalizeCommand(entry: any): string[] | null {
  if (Array.isArray(entry?.command)) return entry.command;
  if (typeof entry?.command === "string") {
    const args = Array.isArray(entry.args) ? entry.args : [];
    return [entry.command, ...args];
  }
  return null;
}

function isSupportedMcp(entry: any): boolean {
  if (entry?.type === "local" || entry?.type === "remote") return true;
  if (!entry?.type) return !!(entry?.url || entry?.command);
  return false;
}

function inferType(entry: any): "local" | "remote" {
  if (entry?.type === "remote" || (!entry?.type && entry?.url)) return "remote";
  return "local";
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
      continue;
    }

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
      continue;
    }

    if (entry?.slim === true) {
      delete entry.slim;
    }
  }
}

export { cleanCfgMcp, extractCfgMcpEntries };

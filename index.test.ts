import { describe, it, expect } from "bun:test";
import { extractCfgMcpEntries, cleanCfgMcp } from "./index.ts";

// ─── extractCfgMcpEntries ────────────────────────────────────────────────────

describe("extractCfgMcpEntries", () => {
  it("extracts local command entry (array form)", () => {
    const cfg = {
      mcp: {
        myServer: { type: "local", command: ["node", "server.js"], slim: true },
      },
    };
    const result = extractCfgMcpEntries(cfg, new Set());
    expect(result).toHaveProperty("myServer");
    expect(result.myServer.type).toBe("local");
    expect(result.myServer.command).toEqual(["node", "server.js"]);
    expect(result.myServer.slim).toBe(true);
  });

  it("extracts local command entry (string + args form)", () => {
    const cfg = {
      mcp: {
        myServer: { command: "node", args: ["server.js"], slim: true },
      },
    };
    const result = extractCfgMcpEntries(cfg, new Set());
    expect(result.myServer.command).toEqual(["node", "server.js"]);
    expect(result.myServer.type).toBe("local");
  });

  it("extracts remote url entry", () => {
    const cfg = {
      mcp: {
        remoteServer: {
          type: "remote",
          url: "https://example.com/mcp",
          slim: true,
        },
      },
    };
    const result = extractCfgMcpEntries(cfg, new Set());
    expect(result).toHaveProperty("remoteServer");
    expect(result.remoteServer.type).toBe("remote");
    expect(result.remoteServer.url).toBe("https://example.com/mcp");
    expect(result.remoteServer.slim).toBe(true);
  });

  it("extracts remote entry inferred from url field (no explicit type)", () => {
    const cfg = {
      mcp: {
        implicitRemote: { url: "https://example.com/mcp", slim: true },
      },
    };
    const result = extractCfgMcpEntries(cfg, new Set());
    expect(result.implicitRemote.type).toBe("remote");
    expect(result.implicitRemote.url).toBe("https://example.com/mcp");
  });

  it("ignores entries without slim: true", () => {
    const cfg = {
      mcp: {
        normalServer: { type: "local", command: ["node", "s.js"] },
        slimServer: { type: "local", command: ["node", "s.js"], slim: true },
      },
    };
    const result = extractCfgMcpEntries(cfg, new Set());
    expect(Object.keys(result)).toEqual(["slimServer"]);
  });

  it("skips entries already in alreadyKnown", () => {
    const cfg = {
      mcp: {
        knownServer: { type: "local", command: ["node", "s.js"], slim: true },
        newServer: { type: "local", command: ["node", "s.js"], slim: true },
      },
    };
    const result = extractCfgMcpEntries(cfg, new Set(["knownServer"]));
    expect(Object.keys(result)).toEqual(["newServer"]);
    expect(result).not.toHaveProperty("knownServer");
  });

  it("ignores remote entry without url", () => {
    const cfg = {
      mcp: { badRemote: { type: "remote", slim: true } },
    };
    expect(Object.keys(extractCfgMcpEntries(cfg, new Set()))).toHaveLength(0);
  });

  it("ignores local entry without command", () => {
    const cfg = {
      mcp: { badLocal: { type: "local", slim: true } },
    };
    expect(Object.keys(extractCfgMcpEntries(cfg, new Set()))).toHaveLength(0);
  });

  it("preserves enabled and timeout fields", () => {
    const cfg = {
      mcp: {
        s: { command: ["npx", "srv"], slim: true, enabled: false, timeout: 5000 },
      },
    };
    const result = extractCfgMcpEntries(cfg, new Set());
    expect(result.s.enabled).toBe(false);
    expect(result.s.timeout).toBe(5000);
  });

  it("returns empty object when cfg.mcp is absent", () => {
    expect(extractCfgMcpEntries({}, new Set())).toEqual({});
    expect(extractCfgMcpEntries(null, new Set())).toEqual({});
    expect(extractCfgMcpEntries(undefined, new Set())).toEqual({});
  });
});

// ─── cleanCfgMcp ─────────────────────────────────────────────────────────────

describe("cleanCfgMcp", () => {
  it("removes local command slim entry from cfg.mcp", () => {
    const cfg = {
      mcp: {
        myServer: { type: "local", command: ["node", "s.js"], slim: true },
      },
    };
    cleanCfgMcp(cfg, new Set(["myServer"]), new Set());
    expect(cfg.mcp).not.toHaveProperty("myServer");
  });

  it("removes remote url slim entry from cfg.mcp", () => {
    const cfg = {
      mcp: {
        remoteServer: {
          type: "remote",
          url: "https://example.com/mcp",
          slim: true,
        },
      },
    };
    cleanCfgMcp(cfg, new Set(["remoteServer"]), new Set());
    expect(cfg.mcp).not.toHaveProperty("remoteServer");
  });

  it("keeps failed slim entry but removes slim flag", () => {
    const cfg = {
      mcp: {
        failedServer: { type: "local", command: ["node", "s.js"], slim: true },
      },
    };
    cleanCfgMcp(cfg, new Set(["failedServer"]), new Set(["failedServer"]));
    expect(cfg.mcp).toHaveProperty("failedServer");
    expect(cfg.mcp.failedServer.slim).toBeUndefined();
    expect(cfg.mcp.failedServer.command).toEqual(["node", "s.js"]);
  });

  it("slim never remains in final cfg.mcp — all cases covered", () => {
    const cfg = {
      mcp: {
        server1: { type: "local", command: ["a"], slim: true },
        server2: { type: "remote", url: "https://x.com", slim: true },
        server3: { type: "local", command: ["b"], slim: true }, // failed
        normalServer: { type: "local", command: ["c"] },        // no slim — untouched
        straySlim: { type: "local", command: ["d"], slim: true }, // not in allSlimNames
      },
    };
    const allSlimNames = new Set(["server1", "server2", "server3"]);
    const failedServers = new Set(["server3"]);

    cleanCfgMcp(cfg, allSlimNames, failedServers);

    for (const entry of Object.values(cfg.mcp) as any[]) {
      expect(entry.slim).toBeUndefined();
    }
    // plugin-handled entries removed
    expect(cfg.mcp).not.toHaveProperty("server1");
    expect(cfg.mcp).not.toHaveProperty("server2");
    // stray slim entry stays but slim flag stripped (plugin doesn't own it)
    expect(cfg.mcp).toHaveProperty("straySlim");
    expect((cfg.mcp.straySlim as any).slim).toBeUndefined();
    // failed entry kept, slim stripped
    expect(cfg.mcp).toHaveProperty("server3");
    // normal entry untouched
    expect(cfg.mcp).toHaveProperty("normalServer");
  });

  it("does not modify non-slim entries", () => {
    const cfg = {
      mcp: {
        normalServer: { type: "local", command: ["c"], enabled: true },
      },
    };
    cleanCfgMcp(cfg, new Set(), new Set());
    expect(cfg.mcp.normalServer.command).toEqual(["c"]);
    expect(cfg.mcp.normalServer.enabled).toBe(true);
  });

  it("handles absent cfg.mcp gracefully", () => {
    expect(() => cleanCfgMcp({}, new Set(["x"]), new Set())).not.toThrow();
    expect(() => cleanCfgMcp(null, new Set(), new Set())).not.toThrow();
  });

  it("removes disabled slim entry entirely", () => {
    const cfg = {
      mcp: {
        disabledServer: {
          type: "local",
          command: ["node", "s.js"],
          slim: true,
          enabled: false,
        },
      },
    };
    cleanCfgMcp(cfg, new Set(["disabledServer"]), new Set());
    expect(cfg.mcp).not.toHaveProperty("disabledServer");
  });
});

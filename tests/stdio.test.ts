import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isAlive,
  isWindows,
  makeServiceHost,
  makeTempDirs,
  waitFor,
  type ServiceHost,
  type TempDirs,
} from "./helpers.js";

// Built from the current sources by tests/global-setup.ts.
const bin = inject("crotMcpBin");

let dirs: TempDirs;
// Each test has its own per-user state, so its stdio clients attach to their own CROT service (WP-20).
let host: ServiceHost;
beforeEach(async () => {
  dirs = await makeTempDirs();
  host = await makeServiceHost(dirs.outside);
});
afterEach(async () => {
  await host.cleanup(bin);
  await dirs.cleanup();
});

// End-to-end check of the built stdio server (a shim of the CROT service since WP-20).
describe("crot-mcp stdio server (built)", () => {
  it("serves tools over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--workspace", dirs.workspace, "--no-audit"],
      env: host.env,
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === "fs_write_file")).toBe(true);
      await client.callTool({ name: "fs_write_file", arguments: { path: "e2e.txt", content: "ok" } });
      const result = (await client.callTool({
        name: "fs_read_file",
        arguments: { path: "e2e.txt" },
      })) as CallToolResult;
      const first = result.content[0];
      expect(first?.type === "text" && JSON.parse(first.text).content).toBe("ok");
    } finally {
      await client.close();
    }
  });

  it("returns invalid tool arguments as a CROT INVALID_INPUT tool error", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--workspace", dirs.workspace, "--mode", "full-control", "--no-audit"],
      env: host.env,
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-invalid-input-test", version: "0.0.0" });
    await client.connect(transport);
    const errorOf = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      expect(result.isError, name).toBe(true);
      const first = result.content[0];
      expect(first?.type, name).toBe("text");
      // CROT's error format: JSON text, not the SDK's plain "MCP error -32602 ..." text.
      const body = JSON.parse(first?.type === "text" ? first.text : "") as { error: { code: string; message: string } };
      return body.error;
    };
    try {
      // The published schema is still the Core schema.
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === "fs_read_file")?.inputSchema.required).toEqual(["path"]);

      for (const [name, args] of [
        ["fs_read_file", { path: 42 }],
        ["fs_read_file", { path: "a", bogus: true }],
        ["fs_read_file", {}],
        ["browser_navigate", { url: "file:///etc/hostname" }],
        ["browser_tab_open", { url: "javascript:alert(1)" }],
      ] as const) {
        const error = await errorOf(name, args);
        expect(error.code, `${name} ${JSON.stringify(args)}`).toBe("INVALID_INPUT");
        expect(error.message).toMatch(/^Invalid input: /);
      }
      // Nothing was created by the rejected calls; valid calls still work.
      await expect(stat(path.join(dirs.workspace, "a"))).rejects.toThrow();
      expect((await client.callTool({ name: "crot_status", arguments: {} })).isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});

describe("crot-mcp shutdown (built)", () => {
  /** Connect to the built server with a file audit log and start a long-running background process. */
  async function serveWithBackgroundProcess() {
    const auditFile = path.join(dirs.outside, "audit.jsonl");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--workspace", dirs.workspace, "--audit-log", auditFile],
      env: host.env,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    const client = new Client({ name: "shutdown-test", version: "0.0.0" });
    await client.connect(transport);
    const started = (await client.callTool({
      name: "process_start",
      arguments: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
    })) as CallToolResult;
    const first = started.content[0];
    const pid = first?.type === "text" ? (JSON.parse(first.text) as { pid: number }).pid : NaN;
    expect(isAlive(pid)).toBe(true);
    return { transport, client, pid, auditFile, serverPid: transport.pid!, stderr: () => stderr };
  }

  const auditedOperations = async (file: string) =>
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { operation: string }).operation);

  it("closing stdin stops background processes and flushes the audit log", async () => {
    const s = await serveWithBackgroundProcess();
    const closing = Date.now();
    await s.client.close();
    // Clients force-kill servers that are still running 2 s after closing stdin
    // (the SDK sends SIGTERM, which is TerminateProcess on Windows): CROT must finish first.
    expect(Date.now() - closing).toBeLessThan(2_000);
    expect(s.stderr()).toMatch(/shutting down \((stdin|transport) closed\)/);
    await waitFor(() => !isAlive(s.serverPid), 10_000);
    await waitFor(() => !isAlive(s.pid), 5_000);
    expect(await auditedOperations(s.auditFile)).toContain("process.start");
  });

  it.runIf(!isWindows)("SIGHUP shuts down gracefully: background processes stopped, audit flushed", async () => {
    const s = await serveWithBackgroundProcess();
    process.kill(s.serverPid, "SIGHUP");
    await waitFor(() => !isAlive(s.serverPid), 10_000);
    await waitFor(() => !isAlive(s.pid), 5_000);
    expect(s.stderr()).toContain("shutting down (SIGHUP)");
    expect(await auditedOperations(s.auditFile)).toContain("process.start");
    await s.client.close().catch(() => undefined);
  });

  it.runIf(!isWindows)("SIGTERM shuts down gracefully", async () => {
    const s = await serveWithBackgroundProcess();
    process.kill(s.serverPid, "SIGTERM");
    await waitFor(() => !isAlive(s.serverPid), 10_000);
    await waitFor(() => !isAlive(s.pid), 5_000);
    expect(s.stderr()).toContain("shutting down (SIGTERM)");
    await s.client.close().catch(() => undefined);
  });
});

// Browser bridge wiring (Linux: the state directory follows XDG_STATE_HOME).
describe.runIf(process.platform === "linux")("crot-mcp browser bridge (built)", () => {
  async function serve(browser: { enabled: boolean } | undefined, mode = "sandbox") {
    const configFile = path.join(dirs.outside, "crot.json");
    await writeFile(
      configFile,
      JSON.stringify({ workspace: { root: dirs.workspace }, ...(browser ? { browser } : {}) }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--config", configFile, "--mode", mode, "--no-audit"],
      env: host.env,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    const client = new Client({ name: "browser-wiring-test", version: "0.0.0" });
    await client.connect(transport);
    const status = async () => {
      const result = (await client.callTool({ name: "crot_status", arguments: {} })) as CallToolResult;
      const first = result.content[0];
      return first?.type === "text" ? (JSON.parse(first.text) as { browser: { state: string } }) : undefined;
    };
    return { client, status, stateDir: host.stateDir, stderr: () => stderr };
  }

  it("is disabled by default and creates no bridge files", async () => {
    const s = await serve(undefined);
    try {
      expect((await s.status())?.browser.state).toBe("disabled");
      await expect(stat(path.join(s.stateDir, "browser-token"))).rejects.toThrow();
    } finally {
      await s.client.close();
    }
  });

  it("browser.enabled starts the bridge; crot_status reports it; the token file is protected", async () => {
    const s = await serve({ enabled: true }, "full-control");
    const tokenFile = path.join(s.stateDir, "browser-token");
    try {
      expect((await s.status())?.browser.state).toBe("waiting");
      await waitFor(() => s.stderr().includes("browser: waiting"));
      const before = await readFile(tokenFile, "utf8");
      expect(s.stderr()).not.toContain(before.trim());
      const write = (await s.client.callTool({
        name: "fs_write_file",
        arguments: { path: tokenFile, content: "x" },
      })) as CallToolResult;
      expect(write.isError).toBe(true);
      expect(await readFile(tokenFile, "utf8")).toBe(before);
    } finally {
      await s.client.close();
    }
    // Shutdown closes the bridge: the socket file is removed.
    await waitFor(
      async () => (await stat(path.join(s.stateDir, "browser.sock")).catch(() => undefined)) === undefined,
      5_000,
    );
  });

  it("a bridge that cannot start does not stop CROT", async () => {
    const stateDir = host.stateDir;
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(stateDir, "browser.sock"), "not a socket");
    const s = await serve({ enabled: true });
    try {
      await waitFor(() => s.stderr().includes("warning: browser bridge unavailable"));
      expect((await s.status())?.browser.state).toBe("disabled");
      const { tools } = await s.client.listTools();
      expect(tools.some((t) => t.name === "fs_read_file")).toBe(true);
    } finally {
      await s.client.close();
    }
    expect(await readFile(path.join(stateDir, "browser.sock"), "utf8")).toBe("not a socket");
  });
});

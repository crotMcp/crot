import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isAlive, isWindows, makeTempDirs, waitFor, type TempDirs } from "./helpers.js";

// Built from the current sources by tests/global-setup.ts.
const bin = inject("crotMcpBin");

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(() => dirs.cleanup());

// End-to-end check of the built stdio server.
describe("crot-mcp stdio server (built)", () => {
  it("serves tools over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--workspace", dirs.workspace, "--no-audit"],
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === "fs_write_file")).toBe(true);
      await client.callTool({ name: "fs_write_file", arguments: { path: "e2e.txt", content: "ok" } });
      const result = (await client.callTool({ name: "fs_read_file", arguments: { path: "e2e.txt" } })) as CallToolResult;
      const first = result.content[0];
      expect(first?.type === "text" && JSON.parse(first.text).content).toBe("ok");
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

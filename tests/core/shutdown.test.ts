import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAuditSink, StreamAuditSink } from "../../src/core/audit/audit.js";
import { localPrincipal } from "../../src/core/auth/principal.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { createTestCore, isAlive, makeTempDirs, testContext as ctx, waitFor, type TempDirs } from "../helpers.js";

const node = process.execPath;
let dirs: TempDirs;
let core: CrotCore;
let audit: MemoryAuditSink;

beforeEach(async () => {
  dirs = await makeTempDirs();
  audit = new MemoryAuditSink();
  core = await createTestCore({ workspace: { root: dirs.workspace } }, audit);
});
afterEach(async () => {
  await core.shutdown();
  await dirs.cleanup();
});

/** Start a background parent that spawns a long-running grandchild; resolve with both pids. */
async function startTree(): Promise<{ id: string; pid: number; grandchild: number }> {
  await writeFile(path.join(dirs.workspace, "gc.js"), "require('fs').writeFileSync('gc.pid', String(process.pid)); setInterval(() => {}, 1000);");
  await writeFile(
    path.join(dirs.workspace, "parent.js"),
    "require('child_process').spawn(process.execPath, ['gc.js'], { stdio: 'ignore' }); setInterval(() => {}, 1000);",
  );
  const info = await core.processes.start(ctx, { command: node, args: ["parent.js"] });
  const pidFile = path.join(dirs.workspace, "gc.pid");
  await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).length > 0);
  return { id: info.id, pid: info.pid!, grandchild: Number(await readFile(pidFile, "utf8")) };
}

describe("Core shutdown", () => {
  it("terminates running foreground commands and records them before closing the audit log", async () => {
    const running = core.processes.exec(ctx, { command: node, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    await core.shutdown();
    expect(Date.now() - started).toBeLessThan(8_000);
    const result = await running;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    // The in-flight operation was audited before shutdown returned.
    expect(audit.events.map((e) => e.operation)).toContain("process.exec");
  });

  it("terminates background process trees", async () => {
    const tree = await startTree();
    await core.shutdown();
    await waitFor(() => !isAlive(tree.pid) && !isAlive(tree.grandchild), 5_000);
  });

  it("refuses new commands once shutdown has started, and is idempotent", async () => {
    const first = core.shutdown();
    const second = core.shutdown();
    expect(second).toBe(first);
    await first;
    await expect(core.processes.exec(ctx, { command: node, args: ["-v"] })).rejects.toMatchObject({
      code: "OPERATION_FAILED",
      message: expect.stringContaining("shutting down"),
    });
    await expect(core.processes.start(ctx, { command: node, args: ["-v"] })).rejects.toMatchObject({ code: "OPERATION_FAILED" });
  });

  it("terminateProcessesSync force-kills every tree synchronously (host exit path)", async () => {
    const tree = await startTree();
    core.terminateProcessesSync();
    await waitFor(() => !isAlive(tree.pid) && !isAlive(tree.grandchild), 5_000);
  });
});

describe("StreamAuditSink", () => {
  it("close() waits until buffered events are flushed", async () => {
    const written: string[] = [];
    let release: () => void = () => undefined;
    const slow = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _enc, cb) {
        written.push(chunk.toString());
        // The first write completes only when released.
        if (written.length === 1) release = () => cb();
        else cb();
      },
    });
    const sink = new StreamAuditSink(slow, 5_000);
    await sink.record({
      id: "1",
      timestamp: new Date().toISOString(),
      operation: "x",
      capabilities: [],
      principal: localPrincipal("t"),
      paths: [],
      outcome: "success",
      durationMs: 0,
    });
    let closed = false;
    const closing = sink.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    expect(written[0]).toContain('"crot.audit"');
  });
});

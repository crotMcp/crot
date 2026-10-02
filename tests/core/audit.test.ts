import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlFileAuditSink, MemoryAuditSink, type AuditEvent } from "../../src/core/audit/audit.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import { CrotCore } from "../../src/core/crot-core.js";
import { createTestCore, makeTempDirs, testContext as ctx, type TempDirs } from "../helpers.js";

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(() => dirs.cleanup());

describe("audit", () => {
  it("records successful, failed and denied operations", async () => {
    const sink = new MemoryAuditSink();
    const core = await createTestCore({ workspace: { root: dirs.workspace } }, sink);
    await core.filesystem.writeFile(ctx, { path: "a.txt", content: "secret-content" });
    await expect(core.filesystem.readFile(ctx, { path: "missing.txt" })).rejects.toThrow();
    await expect(core.filesystem.readFile(ctx, { path: path.join(dirs.outside, "x") })).rejects.toThrow();

    expect(sink.events.map((e) => [e.operation, e.outcome])).toEqual([
      ["filesystem.write_file", "success"],
      ["filesystem.read_file", "error"],
      ["filesystem.read_file", "denied"],
    ]);
    const [write, failed, denied] = sink.events as [AuditEvent, AuditEvent, AuditEvent];
    expect(write.paths).toEqual([path.join(dirs.workspace, "a.txt")]);
    expect(write.principal).toEqual(ctx.principal);
    expect(write.capabilities).toEqual(["filesystem.write"]);
    expect(failed.error?.code).toBe("NOT_FOUND");
    expect(denied.error?.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(sink.events)).not.toContain("secret-content");
  });

  it("records command lines but not environment values or stdin", async () => {
    const sink = new MemoryAuditSink();
    const core = await createTestCore({ workspace: { root: dirs.workspace } }, sink);
    await core.processes.exec(ctx, { command: process.execPath, args: ["-e", "1"], env: { TOKEN: "hunter2" }, stdin: "stdin-secret" });
    const event = sink.events[0]!;
    expect(event.details).toMatchObject({ command: process.execPath, args: ["-e", "1"], envKeys: ["TOKEN"], stdin: true });
    expect(JSON.stringify(event)).not.toContain("hunter2");
    expect(JSON.stringify(event)).not.toContain("stdin-secret");
  });

  it("writes JSON lines to the configured file", async () => {
    const file = path.join(dirs.outside, "logs", "audit.jsonl");
    const core = await CrotCore.create({ workspace: { root: dirs.workspace }, audit: { sink: "file", path: file } });
    await core.filesystem.writeFile(ctx, { path: "a.txt", content: "x" });
    await core.filesystem.listDirectory(ctx, {});
    await core.shutdown();
    const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as AuditEvent);
    expect(lines.map((l) => l.operation)).toEqual(["filesystem.write_file", "filesystem.list_directory"]);
    expect(core.status().audit).toEqual({ sink: "file", path: file });
  });

  it("does not fail operations when the audit sink fails", async () => {
    const blocker = path.join(dirs.outside, "not-a-dir");
    await writeFile(blocker, "");
    const errors: unknown[] = [];
    const core = await CrotCore.create(
      { workspace: { root: dirs.workspace } },
      { auditSink: new JsonlFileAuditSink(path.join(blocker, "audit.jsonl")), onAuditError: (e) => errors.push(e) },
    );
    await expect(core.filesystem.writeFile(ctx, { path: "a.txt", content: "x" })).resolves.toMatchObject({ bytesWritten: 1 });
    expect(errors.length).toBe(1);
  });

  it("defaults the file sink to audit.jsonl in the platform logs directory", async () => {
    const logs = path.join(dirs.outside, "logs");
    const platform = await createNodePlatform({ directories: { config: path.join(dirs.outside, "config"), state: dirs.outside, logs }, startupPath: "inherited" });
    const core = await CrotCore.create({ workspace: { root: dirs.workspace }, audit: { sink: "file" } }, { platform });
    try {
      const expected = path.join(logs, "audit.jsonl");
      expect(core.status().audit).toMatchObject({ sink: "file", path: expected });
      expect(core.status().protectedPaths).toContain(expected);
      await core.filesystem.writeFile(ctx, { path: "a.txt", content: "x" });
      await core.shutdown();
      expect((await readFile(expected, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      await core.shutdown();
    }
  });
});

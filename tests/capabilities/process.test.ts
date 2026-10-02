import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutputBuffer } from "../../src/core/capabilities/process/output-buffer.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { createTestCore, makeTempDirs, testContext as ctx, type TempDirs } from "../helpers.js";

const node = process.execPath;
let dirs: TempDirs;
let core: CrotCore;

beforeEach(async () => {
  dirs = await makeTempDirs();
  core = await createTestCore({ workspace: { root: dirs.workspace }, limits: { maxOutputBytes: 1024, maxCommandTimeoutMs: 30_000 } });
});
afterEach(async () => {
  await core.shutdown();
  await dirs.cleanup();
});

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 5_000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
};

describe("OutputBuffer", () => {
  it("keeps the most recent bytes and tracks offsets", () => {
    const b = new OutputBuffer(4);
    b.append(Buffer.from("abc"));
    b.append(Buffer.from("def"));
    expect(b.text()).toBe("cdef");
    expect(b.truncated).toBe(true);
    expect(b.totalBytes).toBe(6);
    expect(b.readFrom(0)).toEqual({ data: "cdef", nextOffset: 6, droppedBytes: 2 });
    expect(b.readFrom(5)).toEqual({ data: "f", nextOffset: 6, droppedBytes: 0 });
    expect(b.readFrom(6)).toEqual({ data: "", nextOffset: 6, droppedBytes: 0 });
  });
});

describe("process: exec", () => {
  it("runs a command with arguments, cwd, env and stdin", async () => {
    await mkdir(path.join(dirs.workspace, "sub"));
    const script = "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(process.cwd(), process.env.CROT_T, d.trim());console.error('err');process.exit(3)})";
    const r = await core.processes.exec(ctx, { command: node, args: ["-e", script], cwd: "sub", env: { CROT_T: "v" }, stdin: "in" });
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.trim()).toBe(`${path.join(dirs.workspace, "sub")} v in`);
    expect(r.stderr.trim()).toBe("err");
  });

  it("does not interpret arguments through a shell", async () => {
    const r = await core.processes.exec(ctx, { command: node, args: ["-e", "console.log(process.argv[1])", "$(echo hi); rm -rf x"] });
    expect(r.stdout.trim()).toBe("$(echo hi); rm -rf x");
  });

  it("enforces timeouts", async () => {
    const r = await core.processes.exec(ctx, { command: node, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
  });

  it("rejects timeouts above the configured maximum", async () => {
    await expect(core.processes.exec(ctx, { command: node, args: ["-v"], timeoutMs: 60_000 })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("bounds captured output", async () => {
    const r = await core.processes.exec(ctx, { command: node, args: ["-e", "process.stdout.write('a'.repeat(5000)+'END')"] });
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout.length).toBe(1024);
    expect(r.stdout.endsWith("END")).toBe(true);
  });

  it("reports unknown executables as NOT_FOUND", async () => {
    await expect(core.processes.exec(ctx, { command: "crot-definitely-missing-binary" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("denies working directories outside the workspace in sandbox mode", async () => {
    await expect(core.processes.exec(ctx, { command: node, args: ["-v"], cwd: dirs.outside })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(core.processes.shell(ctx, { script: "pwd", cwd: ".." })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("allows outside working directories in full_control mode", async () => {
    const full = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
    const r = await full.processes.exec(ctx, { command: node, args: ["-e", "console.log(process.cwd())"], cwd: dirs.outside });
    expect(r.stdout.trim()).toBe(dirs.outside);
  });

  it("denies execution when shell.execute is not granted", async () => {
    const ro = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { capabilities: ["filesystem.read"] } });
    await expect(ro.processes.exec(ctx, { command: node, args: ["-v"] })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe.skipIf(process.platform === "win32")("process: shell", () => {
  it("runs scripts through the system shell", async () => {
    const r = await core.processes.shell(ctx, { script: "echo one && echo two >&2; exit 4" });
    expect(r).toMatchObject({ exitCode: 4, stdout: "one\n", stderr: "two\n" });
  });

  it("kills the whole process tree on timeout", async () => {
    const started = Date.now();
    const r = await core.processes.shell(ctx, { script: `"${node}" -e "setInterval(()=>{},1000)" & wait`, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("process: background", () => {
  it("starts, lists, reads output incrementally and stops", async () => {
    const info = await core.processes.start(ctx, {
      command: node,
      args: ["-e", "console.log('ready');setInterval(()=>console.log('tick'),50)"],
    });
    expect(info).toMatchObject({ id: "p1", status: "running", cwd: "." });
    await waitFor(async () => (await core.processes.readOutput(ctx, { id: info.id })).stdout.includes("tick"));
    const first = await core.processes.readOutput(ctx, { id: info.id });
    expect(first.stdout.startsWith("ready")).toBe(true);
    const next = await core.processes.readOutput(ctx, { id: info.id, stdoutOffset: first.nextStdoutOffset });
    expect(next.stdout.startsWith("ready")).toBe(false);
    expect((await core.processes.list(ctx)).map((p) => p.id)).toEqual(["p1"]);

    const stopped = await core.processes.stop(ctx, { id: info.id });
    expect(stopped.status).toBe("exited");
    expect((await core.processes.remove(ctx, { id: info.id })).removed).toBe(true);
    expect(await core.processes.list(ctx)).toEqual([]);
  });

  it("requires exactly one of command or script", async () => {
    await expect(core.processes.start(ctx, {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(core.processes.start(ctx, { command: node, script: "echo" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("enforces the background process limit", async () => {
    const limited = await createTestCore({ workspace: { root: dirs.workspace }, limits: { maxBackgroundProcesses: 1 } });
    try {
      await limited.processes.start(ctx, { command: node, args: ["-e", "setInterval(()=>{},1000)"] });
      await expect(limited.processes.start(ctx, { command: node, args: ["-e", "1"] })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    } finally {
      await limited.shutdown();
    }
  });

  it("requires process.manage", async () => {
    const noManage = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { capabilities: ["shell.execute"] } });
    await expect(noManage.processes.start(ctx, { command: node, args: ["-v"] })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(noManage.processes.list(ctx)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("reports unknown process ids", async () => {
    await expect(core.processes.readOutput(ctx, { id: "p999" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

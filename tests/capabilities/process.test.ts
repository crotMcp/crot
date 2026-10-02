import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutputBuffer } from "../../src/core/capabilities/process/output-buffer.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { createTestCore, isAlive, isWindows, makeTempDirs, testContext as ctx, waitFor, type TempDirs } from "../helpers.js";

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

describe.skipIf(isWindows)("process: shell (POSIX)", () => {
  it("runs scripts through the system shell", async () => {
    const r = await core.processes.shell(ctx, { script: "echo one && echo two >&2; exit 4" });
    expect(r).toMatchObject({ exitCode: 4, stdout: "one\n", stderr: "two\n" });
  });

  it("terminates descendants left running when a foreground command finishes", async () => {
    const script = `"${node}" -e "require('fs').writeFileSync('orphan.pid', String(process.pid)); setInterval(()=>{},1000)" & sleep 0.5`;
    const r = await core.processes.shell(ctx, { script });
    expect(r.exitCode).toBe(0);
    const pid = Number(await readFile(path.join(dirs.workspace, "orphan.pid"), "utf8"));
    await waitFor(() => !isAlive(pid), 3_000);
  });

  it("supports bash when available", async (t) => {
    if (!core.platform.info.shells.some((s) => s.id === "bash")) t.skip();
    const r = await core.processes.shell(ctx, { script: "a=(x y); echo ${#a[@]}", shell: "bash" });
    expect(r.stdout.trim()).toBe("2");
  });

  it("kills the whole process tree on timeout", async () => {
    const started = Date.now();
    const r = await core.processes.shell(ctx, { script: `"${node}" -e "setInterval(()=>{},1000)" & wait`, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe.runIf(isWindows)("process: shell (Windows)", () => {
  it("runs cmd.exe scripts with quotes and operators", async () => {
    const r = await core.processes.shell(ctx, { script: 'echo "a b"& (echo err)1>&2& exit /b 4' });
    expect(r.exitCode).toBe(4);
    expect(r.stdout.trim()).toBe('"a b"');
    expect(r.stderr.trim()).toBe("err");
  });

  it("uses cmd as the default shell", () => {
    expect(core.platform.info.defaultShell).toBe("cmd");
  });

  it("runs .cmd shims through cmd.exe with escaped arguments", async () => {
    const bin = path.join(dirs.workspace, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "argv.cmd"), `@"${node}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
    const args = ["a b", "x&y", "(paren)", "semi;colon", "pipe|char"];
    const r = await core.processes.exec(ctx, { command: "node_modules/.bin/argv", args });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout.trim())).toEqual(args);
  });

  it("merges environment variables case-insensitively", async () => {
    const marker = "C:\\crot-marker";
    const r = await core.processes.exec(ctx, {
      command: node,
      args: ["-e", "const k=Object.keys(process.env).filter(n=>n.toUpperCase()==='PATH');console.log(JSON.stringify([k.length, process.env.PATH]))"],
      env: { path: `${process.env.PATH};${marker}` },
    });
    const [count, value] = JSON.parse(r.stdout.trim()) as [number, string];
    expect(count).toBe(1);
    expect(value.endsWith(marker)).toBe(true);
  });
});

describe("process: shells", () => {
  it("runs PowerShell scripts when available (no command-line quoting)", async (t) => {
    const ps = core.platform.info.shells.find((s) => s.id === "pwsh" || s.id === "powershell");
    if (!ps) t.skip();
    const r = await core.processes.shell(ctx, { script: `$x = 'a "quoted" b'; Write-Output $x; exit 3`, shell: ps!.id, timeoutMs: 30_000 });
    expect(r.exitCode).toBe(3);
    expect(r.stdout.trim()).toBe('a "quoted" b');
  });

  it("reports unavailable shells", async () => {
    const missing = (["zsh", "pwsh", "powershell", "bash"] as const).find((id) => !core.platform.info.shells.some((s) => s.id === id));
    if (!missing) return;
    await expect(core.processes.shell(ctx, { script: "echo", shell: missing })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("process: commands and environment", () => {
  it("resolves npm from PATH (a .cmd file on Windows)", async () => {
    const r = await core.processes.exec(ctx, { command: "npm", args: ["--version"], timeoutMs: 30_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("removes variables set to null", async () => {
    process.env.CROT_TEST_REMOVE_ME = "present";
    try {
      const name = isWindows ? "crot_test_remove_me" : "CROT_TEST_REMOVE_ME";
      const r = await core.processes.exec(ctx, {
        command: node,
        args: ["-e", "console.log(String(process.env.CROT_TEST_REMOVE_ME))"],
        env: { [name]: null, CROT_TEST_ADDED: "1" },
      });
      expect(r.stdout.trim()).toBe("undefined");
    } finally {
      delete process.env.CROT_TEST_REMOVE_ME;
    }
  });

  it("rejects invalid environment names", async () => {
    await expect(core.processes.exec(ctx, { command: node, args: ["-v"], env: { "A=B": "x" } })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("process: background", () => {
  it("stops the whole tree of a background process", async () => {
    await writeFile(path.join(dirs.workspace, "gc.js"), "require('fs').writeFileSync('gc.pid', String(process.pid)); setInterval(() => {}, 1000);");
    await writeFile(
      path.join(dirs.workspace, "parent.js"),
      "require('child_process').spawn(process.execPath, ['gc.js'], { stdio: 'ignore' }); setInterval(() => {}, 1000);",
    );
    const info = await core.processes.start(ctx, { command: node, args: ["parent.js"] });
    const pidFile = path.join(dirs.workspace, "gc.pid");
    await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).length > 0);
    const grandchild = Number(await readFile(pidFile, "utf8"));
    expect(isAlive(grandchild)).toBe(true);
    const stopped = await core.processes.stop(ctx, { id: info.id });
    expect(stopped.status).toBe("exited");
    await waitFor(() => !isAlive(grandchild), 5_000);
  });

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

/**
 * crot-l1-init and the service side of its channel (sandbox.ts), REAL
 * processes without namespaces: the compiled init is started directly
 * (not under crot-bwrap) so the process model is tested on every Linux CI
 * runner. Covered: start/stdio/exit, exec failures, the per-command
 * subreaper ending descendants that call setsid or fork twice, graceful and
 * forced termination, and the end of the sandbox ending every tree.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, LaunchError, Sandbox } from "../../../src/native-host/linux-l1/sandbox.js";
import { buildInit, isAlive, isLinux, readAll, waitFor } from "./l1-support.js";

const init = isLinux ? buildInit() : null;
let dir: string;
let sandbox: Sandbox | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "crot-initp-"));
});
afterEach(async () => {
  await sandbox?.close();
  sandbox = undefined;
  await rm(dir, { recursive: true, force: true });
});

const env = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" };
const pids = async (file: string) => (await readFile(file, "utf8")).split(/\s+/).filter(Boolean).map(Number);

describe("frame codec", () => {
  it("decodes frames split at any byte", () => {
    const frames: [number, number, string][] = [];
    const d = new FrameDecoder((t, id, p) => frames.push([t, id, p.toString()]));
    const bytes = Buffer.concat([encodeFrame(13, 7, Buffer.from("hello")), encodeFrame(16, 7)]);
    for (const b of bytes) d.push(Buffer.from([b]));
    expect(frames).toEqual([
      [13, 7, "hello"],
      [16, 7, ""],
    ]);
  });
});

describe.skipIf(!init)("crot-l1-init (real processes, no namespaces)", () => {
  const start = async () => (sandbox = await Sandbox.start({ file: init!, args: [] }));

  it("says HELLO with its label and answers PING", async () => {
    const s = await start();
    expect(s.label.length).toBeGreaterThan(0);
    expect(await s.ping()).toBe(true);
  });

  it("runs a command with arguments, cwd, environment and stdin; reports the exit code", async () => {
    const s = await start();
    const p = await s.launch(
      "/bin/sh",
      ["-c", 'read x; echo "$x $1 $CROT_T $(pwd)"; echo err >&2; exit 3', "sh", "arg"],
      dir,
      { ...env, CROT_T: "v" },
      true,
    );
    p.stdin!.end("input\n");
    const [out, err, status] = await Promise.all([readAll(p.stdout), readAll(p.stderr), p.exited]);
    expect(out.trim()).toBe(`input arg v ${dir}`);
    expect(err.trim()).toBe("err");
    expect(status).toEqual({ code: 3, signal: null });
    expect(p.pid).toBeGreaterThan(0);
  });

  it("reports exec failures as LaunchError with the errno (command's own problem)", async () => {
    const s = await start();
    await expect(s.launch("/nonexistent/tool", [], dir, env, false)).rejects.toMatchObject({ errno: 2 });
    await expect(s.launch("/nonexistent/tool", [], dir, env, false)).rejects.toBeInstanceOf(LaunchError);
    expect(await s.ping()).toBe(true);
  });

  it("ends the whole tree, including setsid and double-forked descendants (forced)", async () => {
    const s = await start();
    const record = path.join(dir, "pids");
    const script = `
      setsid sh -c 'sleep 300 & echo $! >> "$1"; wait' sh "$1" &
      ( sleep 300 & echo $! >> "$1" ) &
      sleep 300 & echo $! >> "$1"
      wait`;
    const p = await s.launch("/bin/sh", ["-c", script, "sh", record], dir, env, false);
    await waitFor(async () => (await readFile(record, "utf8").catch(() => "")).trim().split(/\s+/).length >= 3);
    const tree = await pids(record);
    for (const pid of tree) expect(isAlive(pid)).toBe(true);
    await p.terminate("force");
    await waitFor(() => tree.every((pid) => !isAlive(pid)));
    expect(await p.exited).toMatchObject({ code: null });
    expect(s.size).toBe(0);
  });

  it("terminates gracefully with SIGTERM", async () => {
    const s = await start();
    const p = await s.launch("/bin/sh", ["-c", "trap 'exit 7' TERM; while :; do sleep 0.05; done"], dir, env, false);
    await new Promise((r) => setTimeout(r, 200));
    await p.terminate("graceful");
    expect(await p.exited).toEqual({ code: 7, signal: null });
  });

  it("ends every tree when the sandbox closes (die-with-parent model)", async () => {
    const s = await start();
    const record = path.join(dir, "bg");
    const p = await s.launch(
      "/bin/sh",
      ["-c", 'nohup sleep 300 > /dev/null 2>&1 & echo $! > "$1"; wait', "sh", record],
      dir,
      env,
      false,
    );
    await waitFor(async () => (await readFile(record, "utf8").catch(() => "")).trim().length > 0);
    const [bg] = await pids(record);
    expect(isAlive(bg!)).toBe(true);
    await s.close();
    sandbox = undefined;
    await waitFor(() => !isAlive(bg!));
    expect(s.running).toBe(false);
    await p.exited;
  });
});

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CrotCore } from "../../src/core/crot-core.js";
import type { ManagedProcess } from "../../src/core/platform/types.js";
import { NativeHost } from "../../src/native-host/native-host.js";
import { loadJobObjectApi } from "../../src/native-host/windows-job.js";
import {
  createTestCore,
  isAlive,
  isWindows,
  makeTempDirs,
  testContext as ctx,
  waitFor,
  type TempDirs,
} from "../helpers.js";

const node = process.execPath;
const GC = "require('fs').writeFileSync('gc.pid', String(process.pid)); setInterval(() => {}, 1000);";
/** Starts gc.js and exits as soon as it is running, leaving an orphaned grandchild. */
const ORPHANING_PARENT =
  "require('child_process').spawn(process.execPath, ['gc.js'], { stdio: 'ignore', detached: true }).unref();" +
  "const fs = require('fs'); const t = setInterval(() => { if (fs.existsSync('gc.pid') && fs.readFileSync('gc.pid', 'utf8')) { clearInterval(t); process.exit(0); } }, 20);";

describe.runIf(isWindows)("native host: Windows Job Objects", () => {
  let dirs: TempDirs;
  let native: NativeHost;
  let core: CrotCore;
  const pids: number[] = [];

  beforeEach(async () => {
    dirs = await makeTempDirs();
    native = await NativeHost.start({ startupPath: "inherited", windowsAcl: false });
    core = await createTestCore(
      { workspace: { root: dirs.workspace }, limits: { maxCommandTimeoutMs: 30_000 } },
      undefined,
      { platform: native.platform },
    );
    await writeFile(path.join(dirs.workspace, "gc.js"), GC);
    await writeFile(path.join(dirs.workspace, "parent.js"), ORPHANING_PARENT);
  });
  afterEach(async () => {
    await core.shutdown();
    await native.close();
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    }
    await dirs.cleanup();
  });

  const grandchild = async (): Promise<number> => {
    const file = path.join(dirs.workspace, "gc.pid");
    await waitFor(async () => (await readFile(file, "utf8").catch(() => "")).length > 0);
    const pid = Number(await readFile(file, "utf8"));
    pids.push(pid);
    return pid;
  };

  const launchDirect = async (): Promise<ManagedProcess> => {
    const env = native.platform.baseEnvironment;
    const spec = await native.platform.launcher.resolveCommand(node, ["parent.js"], { cwd: dirs.workspace, env });
    const proc = await native.platform.launcher.launch(spec, { cwd: dirs.workspace, env, stdin: false });
    proc.stdout.resume();
    proc.stderr.resume();
    return proc;
  };

  it("reports kernel-enforced tree control", () => {
    expect(native.platform.launcher.canTerminateOrphanedDescendants).toBe(true);
    expect(core.platform.info.processControl.treeTermination).toBe("job-object");
  });

  it("foreground commands: orphaned descendants do not outlive the command", async () => {
    const r = await core.processes.exec(ctx, { command: node, args: ["parent.js"] });
    expect(r.exitCode).toBe(0);
    const gc = await grandchild();
    await waitFor(() => !isAlive(gc), 5_000);
  });

  it("forced termination after the direct child exited still cleans up the tree", async () => {
    const proc = await launchDirect();
    const gc = await grandchild();
    await proc.exited;
    expect(isAlive(gc)).toBe(true);
    expect(native.status().processControl.openJobs).toBe(1);
    await proc.terminate("force");
    await waitFor(() => !isAlive(gc), 5_000);
    expect(native.status().processControl.openJobs).toBe(0);
  });

  it("closing the Native Host terminates every remaining tree", async () => {
    const proc = await launchDirect();
    const gc = await grandchild();
    await proc.exited;
    expect(isAlive(gc)).toBe(true);
    native.closeSync();
    await waitFor(() => !isAlive(gc), 5_000);
    expect(native.status()).toMatchObject({ state: "closed", processControl: { openJobs: 0 } });
  });

  it("stopping a background process terminates its descendants", async () => {
    await writeFile(
      path.join(dirs.workspace, "stay.js"),
      "require('child_process').spawn(process.execPath, ['gc.js'], { stdio: 'ignore', detached: true }); setInterval(() => {}, 1000);",
    );
    const info = await core.processes.start(ctx, { command: node, args: ["stay.js"] });
    const gc = await grandchild();
    expect(isAlive(gc)).toBe(true);
    await core.processes.stop(ctx, { id: info.id });
    await waitFor(() => !isAlive(gc), 5_000);
  });

  it("validates process ids and rejects use after close", async () => {
    const api = await loadJobObjectApi();
    const job = api.createKillOnCloseJob();
    for (const bad of [0, -1, 1.5, 2 ** 32])
      expect(() => job.assign(bad)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(job.activeProcessCount()).toBe(0);
    job.close();
    job.close();
    expect(job.closed).toBe(true);
    expect(() => job.assign(process.pid)).toThrow(expect.objectContaining({ code: "OPERATION_FAILED" }));
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CrotCore } from "../../src/core/crot-core.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import { NativeHost } from "../../src/native-host/native-host.js";
import { createTestCore, isWindows, makeTempDirs, testContext as ctx, type TempDirs } from "../helpers.js";

const node = process.execPath;
let dirs: TempDirs;
let native: NativeHost;
const cores: CrotCore[] = [];

beforeEach(async () => {
  dirs = await makeTempDirs();
  native = await NativeHost.start({ startupPath: "inherited" });
});
afterEach(async () => {
  for (const core of cores.splice(0)) await core.shutdown();
  await native.close();
  await dirs.cleanup();
});

async function coreOn(config: Record<string, unknown>): Promise<CrotCore> {
  const core = await createTestCore({ workspace: { root: dirs.workspace }, ...config }, undefined, { platform: native.platform });
  cores.push(core);
  return core;
}

describe("native host: lifecycle", () => {
  it("starts running and closes idempotently", async () => {
    expect(native.running).toBe(true);
    expect(native.status().state).toBe("running");
    await native.close();
    await native.close();
    native.closeSync();
    expect(native.running).toBe(false);
    expect(native.status()).toMatchObject({ state: "closed", processControl: { openJobs: 0 } });
  });

  it("rejects launches after close", async () => {
    const launcher = native.platform.launcher;
    const env = native.platform.baseEnvironment;
    const spec = await launcher.resolveCommand(node, ["-v"], { cwd: dirs.workspace, env });
    await native.close();
    await expect(launcher.launch(spec, { cwd: dirs.workspace, env, stdin: false })).rejects.toMatchObject({ code: "OPERATION_FAILED" });
  });
});

describe.skipIf(isWindows)("native host: POSIX keeps the Core mechanisms", () => {
  it("reports the same process and private-file guarantees as Core", async () => {
    const core = await createNodePlatform({ startupPath: "inherited" });
    expect(native.platform.info.processControl).toEqual(core.info.processControl);
    expect(native.platform.info.processControl.treeTermination).toBe("process-group");
    expect(native.platform.info.privateFiles).toEqual({ mechanism: "posix-mode", enforced: true });
    expect(native.status()).toMatchObject({ processControl: { provider: "core" }, privateFiles: { provider: "core" }, notes: [] });
  });
});

describe.runIf(isWindows)("native host: Windows mechanisms", () => {
  it("uses Job Objects and owner-only ACLs", () => {
    expect(native.platform.info.processControl).toEqual({ treeTermination: "job-object", orphanedDescendants: true, gracefulTermination: false });
    expect(native.platform.launcher.canTerminateOrphanedDescendants).toBe(true);
    expect(native.platform.info.privateFiles).toEqual({ mechanism: "windows-acl", enforced: true });
    expect(native.status()).toMatchObject({ processControl: { provider: "native-host" }, privateFiles: { provider: "native-host" } });
  });

  it("falls back to Core tree termination when the FFI module is unavailable or malformed", async () => {
    const loaders = [
      async () => {
        throw new Error("Cannot find package 'koffi'");
      },
      async () => ({}),
    ];
    for (const loadFfi of loaders) {
      const fallback = await NativeHost.start({ startupPath: "inherited", windowsAcl: false, loadFfi });
      try {
        expect(fallback.platform.info.processControl.treeTermination).toBe("taskkill-tree");
        expect(fallback.status().processControl.provider).toBe("core");
        expect(fallback.status().notes.some((n) => n.startsWith("Job Objects unavailable"))).toBe(true);
      } finally {
        await fallback.close();
      }
    }
  });
});

describe("native host: Core authorization is still required", () => {
  it("sandbox: working directories outside the workspace are denied", async () => {
    const core = await coreOn({});
    await expect(core.processes.exec(ctx, { command: node, args: ["-v"], cwd: dirs.outside })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("capabilities: execution without shell.execute is denied", async () => {
    const core = await coreOn({ permissions: { capabilities: ["filesystem.read"] } });
    await expect(core.processes.exec(ctx, { command: node, args: ["-v"] })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("authorized commands run through the Native Host launcher", async () => {
    const core = await coreOn({ limits: { maxCommandTimeoutMs: 30_000 } });
    expect(core.platform.launcher).toBe(native.platform.launcher);
    const r = await core.processes.exec(ctx, { command: node, args: ["-e", "console.log('ok')"] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });

  it("full_control behaves as before", async () => {
    const core = await coreOn({ permissions: { mode: "full_control" } });
    const r = await core.processes.exec(ctx, { command: node, args: ["-e", "console.log(process.cwd())"], cwd: dirs.outside });
    expect(r.stdout.trim()).toBe(dirs.outside);
  });
});

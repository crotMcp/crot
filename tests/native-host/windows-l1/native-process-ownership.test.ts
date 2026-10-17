/** Portable exact-owner failure injection; not native kernel qualification. */
import { describe, expect, it, vi } from "vitest";
import { NativeProcessLauncher } from "../../../src/native-host/windows-l1/native-process.js";
import { WindowsLaunchEnvironment } from "../../../src/native-host/windows-l1/launch-environment.js";
import type { RestrictedToken } from "../../../src/native-host/windows-l1/restricted-token.js";
import type { BytePipeApi } from "../../../src/native-host/windows-l1/byte-stdio.js";
import type { ProcessLauncher } from "../../../src/core/platform/types.js";
import type { JobObject } from "../../../src/native-host/windows-job.js";
const ownerSid = "S-1-5-21-1-2-3-1001",
  restrictingSid = "S-1-5-21-4-5-6-1002";
function fixture() {
  let id = 0,
    jobCloseFails = false,
    processCloseFails = false;
  const nativeClose = vi.fn(() => {
    if (processCloseFails) throw new Error("process close fault");
  });
  const pipes: BytePipeApi = {
    create: async () => {
      const child = BigInt(++id);
      return {
        child,
        parent: child + 100n,
        read: () => {
          throw new Error("unexpected read");
        },
        write: () => {
          throw new Error("unexpected write");
        },
        closeChild: vi.fn(),
        closeParent: vi.fn(),
      };
    },
  };
  const job: JobObject = {
    closed: false,
    assign: () => true,
    accounting: () => ({ active: 0, total: 0 }),
    activeProcessCount: () => 0,
    terminate: () => true,
    close: vi.fn(() => {
      if (jobCloseFails) throw new Error("job close fault");
    }),
  };
  const launchProbe = vi.fn(() => ({
    pid: 42,
    closed: false,
    finalExitCode: 1,
    exitCode: () => null,
    close: nativeClose,
  }));
  const token: RestrictedToken = {
    restrictingSid,
    closed: false,
    prepareProbeObjects: () => undefined,
    lowerProbeIntegrity: () => undefined,
    fileDaclAccess: () => ({ readData: false, writeData: false }),
    launchProbe,
    close: () => undefined,
  };
  const desktop = {
    desktop: `crot-${"c".repeat(48)}\\actor`,
    restrictingSid,
    closed: false,
    exited: new Promise<never>(() => undefined),
    close: vi.fn(async () => undefined),
    closeSync: vi.fn(),
  };
  const resolver = {
    processControl: { treeTermination: "job-object", orphanedDescendants: true, gracefulTermination: false },
    canTerminateOrphanedDescendants: true,
    resolveCommand: vi.fn(),
    launch: vi.fn(),
  } as unknown as ProcessLauncher;
  const launcher = new NativeProcessLauncher({
    token,
    ownerSid,
    pipes,
    jobs: { createKillOnCloseJob: () => job },
    resolver,
    environment: {
      caseInsensitive: true,
      get: (env, key) => env[key],
      merge: (base) =>
        Object.fromEntries(Object.entries(base).filter((x): x is [string, string] => typeof x[1] === "string")),
    },
    childEnvironment: new WindowsLaunchEnvironment({
      systemRoot: "C:\\Windows",
      privateRoot: "C:\\private",
      runtimeBins: [],
    }),
    desktop,
  });
  const launch = () =>
    launcher.launch(
      { file: "C:\\node.exe", args: [], display: "owned test" },
      { cwd: "C:\\private", env: {}, stdin: true },
    );
  return {
    launcher,
    launch,
    launchProbe,
    job,
    nativeClose,
    desktop,
    setJobFailure: (value: boolean) => {
      jobCloseFails = value;
    },
    setProcessFailure: (value: boolean) => {
      processCloseFails = value;
    },
  };
}
describe("Native launcher incomplete cleanup ownership", () => {
  it("retains failed startup Job cleanup, blocks launches and retries the same owned Job", async () => {
    const f = fixture();
    f.setJobFailure(true);
    f.launchProbe.mockImplementation(() => {
      throw new Error("startup fault");
    });
    await expect(f.launch()).rejects.toThrow("startup fault");
    await expect(f.launch()).rejects.toThrow("cleanup");
    expect(f.launchProbe).toHaveBeenCalledOnce();
    await expect(f.launcher.close()).rejects.toThrow();
    expect(f.desktop.close).not.toHaveBeenCalled();
    f.setJobFailure(false);
    await f.launcher.close();
    expect(f.desktop.close).toHaveBeenCalledOnce();
    expect(f.job.close).toHaveBeenCalled();
  });
  it("does not dispose the helper before failed actor cleanup can be retried", async () => {
    const f = fixture();
    const process = await f.launch();
    f.setProcessFailure(true);
    await expect(process.terminate("force")).rejects.toThrow("cleanup");
    await expect(f.launch()).rejects.toThrow("cleanup");
    expect(f.launchProbe).toHaveBeenCalledOnce();
    await expect(f.launcher.close()).rejects.toThrow("cleanup");
    expect(f.desktop.close).not.toHaveBeenCalled();
    f.setProcessFailure(false);
    await f.launcher.close();
    expect(f.desktop.close).toHaveBeenCalledOnce();
    expect(f.nativeClose.mock.calls.length).toBe(3);
  });
});

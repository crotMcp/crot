/** Portable protocol/lifetime fault injection; not a Windows kernel result. */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { bindViewJobObjectApi } from "../../../src/native-host/windows-job.js";
import { createOwnedWorkspaceView, workspaceViewFrame } from "../../../src/native-host/windows-l1/workspace-view.js";
import type { ExitStatus, ProcessLauncher } from "../../../src/core/platform/types.js";
const fs = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  lstat: vi.fn(async () => ({ isSymbolicLink: () => false })),
  rmdir: vi.fn(async () => undefined),
}));
vi.mock("node:fs/promises", () => fs);
const config = {
  root: "C:\\medium\\project",
  mount: "C:\\private\\mount",
  ownerSid: "S-1-5-21-1-2-3-1001",
  restrictingSid: "S-1-5-21-4-5-6-1002",
  jobName: `Local\\crot-view-job-${"a".repeat(48)}`,
  protectedRelativeRoots: ["\\.crot", "\\private\\state"],
};
function fixture(marker = "CROT_VIEW_READY\n", startupError?: string) {
  let closed = false,
    terminated = 0,
    finish!: (s: ExitStatus) => void;
  const exited = new Promise<ExitStatus>((resolve) => {
    finish = resolve;
  });
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    stdin = new PassThrough();
  stdin.once("data", () => queueMicrotask(() => (startupError ? stderr.write(startupError) : stdout.write(marker))));
  stdin.once("finish", () => finish({ code: 0, signal: null }));
  const calls: Record<string, (...a: unknown[]) => unknown> = {
    CreateJobObjectW: () => 1n,
    GetLastError: () => 0,
    SetLastError: () => undefined,
    SetInformationJobObject: () => 1,
    QueryInformationJobObject: (_h, _t, out) => {
      Object.assign(out as object, { ActiveProcesses: 0, TotalProcesses: 0 });
      return 1;
    },
    CloseHandle: () => {
      closed = true;
      return 1;
    },
    TerminateJobObject: () => {
      terminated++;
      return 1;
    },
    OpenProcess: () => 2n,
    AssignProcessToJobObject: () => 1,
  };
  const ffi = {
    struct: () => undefined,
    load: () => ({
      func: (s: string) => {
        const n = /\b(\w+)\(/.exec(s)?.[1];
        if (!n || !calls[n]) throw Error("unexpected ABI");
        return calls[n];
      },
    }),
  };
  const jobs = bindViewJobObjectApi(ffi);
  const helper = {
    pid: 5,
    hasExited: false,
    terminateSync: () => finish({ code: 0, signal: null }),
    stdin,
    stdout,
    stderr,
    exited,
    terminate: vi.fn(async () => finish({ code: 0, signal: null })),
  };
  const helperLauncher: ProcessLauncher = {
    canTerminateOrphanedDescendants: true,
    processControl: { treeTermination: "job-object", orphanedDescendants: true, gracefulTermination: false },
    resolveCommand: async (file, args) => ({ file, args: [...args], display: "fixed helper" }),
    launch: async () => helper,
  };
  return {
    options: {
      ...config,
      privateRoot: "C:\\private",
      helper: "C:\\packaged\\helper.exe",
      helperLauncher,
      jobs,
      environment: { SystemRoot: "C:\\Windows" },
    },
    helper,
    finish,
    get closed() {
      return closed;
    },
    get terminated() {
      return terminated;
    },
  };
}
describe("workspace view trusted frame", () => {
  it("serializes exact UTF16 identities, exclusions and bounded field lengths", () => {
    const frame = workspaceViewFrame(config);
    let offset = 4;
    expect(frame.readUInt32LE(0)).toBe(0x43525631);
    const field = () => {
      const n = frame.readUInt32LE(offset);
      offset += 4;
      const s = frame.toString("utf16le", offset, offset + 2 * n);
      offset += 2 * n;
      return s;
    };
    expect(Array.from({ length: 5 }, field)).toEqual([
      config.root,
      config.mount,
      config.ownerSid,
      config.restrictingSid,
      config.jobName,
    ]);
    expect(frame.readUInt32LE(offset)).toBe(2);
    offset += 4;
    expect([field(), field()]).toEqual(config.protectedRelativeRoots);
    expect(offset).toBe(frame.length);
  });
  it.each(["\\..\\escape", "\\dir\\", "\\file:stream", "\\short~1", "\\trailing.", "\\a\0b", "relative"])(
    "rejects ambiguous excluded path %j",
    (name) => {
      expect(() => workspaceViewFrame({ ...config, protectedRelativeRoots: [name] })).toThrow();
    },
  );
  it("rejects arbitrary Job names, common identity and unbounded frames", () => {
    expect(() => workspaceViewFrame({ ...config, jobName: "Local\\shared" })).toThrow();
    expect(() => workspaceViewFrame({ ...config, restrictingSid: config.ownerSid })).toThrow();
    expect(() => workspaceViewFrame({ ...config, protectedRelativeRoots: Array(1025).fill("\\private") })).toThrow();
    expect(() =>
      workspaceViewFrame({ ...config, protectedRelativeRoots: Array(1000).fill("\\" + "a".repeat(200)) }),
    ).toThrow();
  });
});
describe("workspace view ownership", () => {
  it("transfers exactly one empty named Job and releases the mount without recursive deletion", async () => {
    const f = fixture(),
      view = await createOwnedWorkspaceView(f.options);
    expect(view.mount).toMatch(/^C:\\private\\view-[0-9a-f]{48}$/);
    const actor = view.jobs.createKillOnCloseJob();
    expect(actor.accounting()).toEqual({ active: 0, total: 0 });
    expect(() => view.jobs.createKillOnCloseJob()).toThrow();
    actor.close();
    await view.close();
    await view.close();
    expect(f.closed).toBe(true);
    expect(fs.rmdir).toHaveBeenCalledWith(view.mount);
  });
  it("terminates the exact actor Job after helper loss and refuses a late actor launch", async () => {
    const f = fixture(),
      view = await createOwnedWorkspaceView(f.options);
    f.finish({ code: 3, signal: null });
    await Promise.resolve();
    expect(f.terminated).toBe(1);
    expect(() => view.jobs.createKillOnCloseJob()).toThrow();
    await expect(view.close()).rejects.toThrow("helper unmount status");
    expect(f.closed).toBe(true);
    // The exact exited helper and detached mount are checked again before
    // dropping the retained failed owner; no fresh helper is allocated.
    await view.close();
  });
  it("does not accept another readiness protocol and releases failed setup", async () => {
    const f = fixture("CROT_VIEW_READY\nextra\n");
    await expect(createOwnedWorkspaceView(f.options)).rejects.toThrow("readiness protocol");
    expect(f.closed).toBe(true);
  });
  it.each(["control-probe", "control-zero-open", "control-read-open"])(
    "refuses actor readiness on %s and releases the exact failed setup",
    async (stage) => {
      const f = fixture("", `CROT_VIEW_ERROR:${stage}\n`);
      await expect(createOwnedWorkspaceView(f.options)).rejects.toThrow(`helper startup ${stage}`);
      expect(f.closed).toBe(true);
      expect(fs.rmdir).toHaveBeenCalled();
    },
  );
  it("reports bounded profile evidence only for an explicitly trusted diagnostic run", async () => {
    const f = fixture("", "CROT_VIEW_ERROR:control-zero-open:a5b00000\n");
    const resolve = vi.spyOn(f.options.helperLauncher, "resolveCommand");
    await expect(createOwnedWorkspaceView({ ...f.options, diagnoseControlProfiles: true })).rejects.toMatchObject({
      details: {
        stage: "helper startup control-zero-open",
        controlProfiles: { completed: true, ownerControls: true, devicePackageAccessGranted: false },
      },
    });
    expect(resolve.mock.calls[0]?.[1]).toEqual(["--diagnose-control-profiles"]);
    expect(f.closed).toBe(true);
  });
  it("preserves a bounded owner NTSTATUS as a failed prerequisite, never actor denial", async () => {
    const f = fixture("", "CROT_VIEW_ERROR:control-zero-open:a5d00002:c000000d\n");
    await expect(createOwnedWorkspaceView({ ...f.options, diagnoseControlProfiles: true })).rejects.toMatchObject({
      details: {
        controlProfiles: { completed: false, stage: "owner-nt-metadata", lastNativePrerequisiteStatus: "c000000d" },
      },
    });
    expect(f.closed).toBe(true);
  });
  it("does not expose unsolicited profile diagnostics or treat them as readiness", async () => {
    const f = fixture("", "CROT_VIEW_ERROR:control-zero-open:a5b00000\n");
    await expect(createOwnedWorkspaceView(f.options)).rejects.toMatchObject({
      details: { stage: "helper startup control-zero-open" },
    });
    expect(f.closed).toBe(true);
  });
  it("keeps a diagnostic setup or cleanup failure behind the mandatory control gate", async () => {
    for (const frame of ["a5d00000", "a5c00000", "00000000"]) {
      const f = fixture("", `CROT_VIEW_ERROR:control-zero-open:${frame}\n`);
      await expect(createOwnedWorkspaceView({ ...f.options, diagnoseControlProfiles: true })).rejects.toThrow(
        "helper startup control-zero-open",
      );
      expect(f.closed).toBe(true);
    }
  });
  it("retains failed mount removal and blocks allocations until exact cleanup is retried", async () => {
    const f = fixture(),
      view = await createOwnedWorkspaceView(f.options);
    fs.rmdir.mockRejectedValueOnce(new Error("busy"));
    await expect(view.close()).rejects.toThrow("busy");
    fs.rmdir.mockRejectedValueOnce(new Error("still busy"));
    await expect(createOwnedWorkspaceView(f.options)).rejects.toThrow("prior cleanup");
    await view.close();
    expect(f.closed).toBe(true);
  });
});

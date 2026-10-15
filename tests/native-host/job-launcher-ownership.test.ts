/** Portable failure/ordering evidence; native tree-kill gates remain mandatory. */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createJobObjectLauncher, JobTracker } from "../../src/native-host/job-launcher.js";
import type { ExitStatus, ManagedProcess, ProcessLauncher } from "../../src/core/platform/types.js";
import type { JobObject } from "../../src/native-host/windows-job.js";

function fixture() {
  let open = true;
  let resolveExit!: (value: ExitStatus) => void;
  const exited = new Promise<ExitStatus>((resolve) => {
    resolveExit = resolve;
  });
  const proc: ManagedProcess = {
    pid: 123,
    stdin: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    hasExited: false,
    exited,
    terminate: vi.fn(async () => undefined),
    terminateSync: vi.fn(),
  };
  const job: JobObject = {
    closed: false,
    assign: vi.fn(() => true),
    accounting: vi.fn(() => ({ active: 0, total: 1 })),
    activeProcessCount: vi.fn(() => 0),
    terminate: vi.fn(() => true),
    close: vi.fn(() => undefined),
  };
  const api = { createKillOnCloseJob: vi.fn(() => job) };
  const inner = {
    launch: vi.fn(async () => proc),
    resolveCommand: vi.fn(),
  } as unknown as ProcessLauncher & { launch: ReturnType<typeof vi.fn> };
  const tracker = new JobTracker();
  const launcher = createJobObjectLauncher(inner, api, tracker, () => open);
  const launch = () =>
    launcher.launch({ file: "C:\\node.exe", args: [], display: "node" }, { cwd: "C:\\project", env: {}, stdin: false });
  return {
    proc,
    job,
    api,
    inner,
    tracker,
    launch,
    resolveExit,
    closeHost: () => {
      open = false;
      tracker.terminateAll();
    },
  };
}

describe("general Windows host Job cleanup ownership", () => {
  it("retains failed shutdown owners, attempts other Jobs, then retries exact owners", () => {
    const f = fixture();
    const other = { ...f.job, close: vi.fn() };
    f.tracker.add(f.job);
    f.tracker.add(other);
    vi.mocked(f.job.close).mockImplementationOnce(() => {
      throw new Error("close denied");
    });
    f.tracker.terminateAll();
    expect(other.close).toHaveBeenCalledOnce();
    expect(f.tracker.size).toBe(1);
    f.tracker.terminateAll();
    expect(f.tracker.size).toBe(0);
    expect(f.job.close).toHaveBeenCalledTimes(2);
    expect(other.close).toHaveBeenCalledOnce();
  });
  it("retains failed launch cleanup without replacing the original launch error", async () => {
    const f = fixture();
    f.inner.launch.mockRejectedValueOnce(new Error("launch failed"));
    vi.mocked(f.job.close).mockImplementation(() => {
      throw new Error("close denied");
    });
    await expect(f.launch()).rejects.toThrow("launch failed");
    expect(f.tracker.size).toBe(1);
    await expect(f.launch()).rejects.toThrow("close denied");
    expect(f.api.createKillOnCloseJob).toHaveBeenCalledOnce();
    expect(f.inner.launch).toHaveBeenCalledOnce();
    vi.mocked(f.job.close).mockImplementation(() => undefined);
    f.closeHost();
    expect(f.tracker.size).toBe(0);
  });
  it("stops an unassigned child when the host closes while inner launch is pending", async () => {
    const f = fixture();
    let ready!: (proc: ManagedProcess) => void;
    f.inner.launch.mockImplementationOnce(
      () =>
        new Promise<ManagedProcess>((resolve) => {
          ready = resolve;
        }),
    );
    const pending = f.launch();
    expect(f.tracker.size).toBe(1);
    f.closeHost();
    ready(f.proc);
    await expect(pending).rejects.toThrow("Native Host is closed");
    expect(f.proc.terminate).toHaveBeenCalledWith("force");
    expect(f.job.assign).not.toHaveBeenCalled();
    expect(f.tracker.uncontained).toBe(0);
    expect(f.tracker.size).toBe(0);
  });
  it("stops an unassigned child if fallback cleanup fails, retaining the failed owner", async () => {
    const f = fixture();
    vi.mocked(f.job.assign).mockReturnValue(false);
    vi.mocked(f.job.close).mockImplementationOnce(() => {
      throw new Error("close denied");
    });
    await expect(f.launch()).rejects.toThrow("close denied");
    expect(f.proc.terminate).toHaveBeenCalledWith("force");
    expect(f.tracker.size).toBe(1);
    expect(f.tracker.uncontained).toBe(0);
    f.closeHost();
    expect(f.tracker.size).toBe(0);
  });
  it("does not turn asynchronous empty-tree close failures into unhandled rejections or lost ownership", async () => {
    const f = fixture();
    const managed = await f.launch();
    vi.mocked(f.job.close).mockImplementationOnce(() => {
      throw new Error("close denied");
    });
    f.resolveExit({ code: 0, signal: null });
    await managed.exited;
    await Promise.resolve();
    expect(f.tracker.size).toBe(1);
    f.closeHost();
    expect(f.tracker.size).toBe(0);
  });
  it("attempts kill-on-close even when TerminateJobObject throws", async () => {
    const f = fixture();
    const managed = await f.launch();
    vi.mocked(f.job.terminate).mockImplementationOnce(() => {
      throw new Error("terminate failed");
    });
    await expect(managed.terminate("force")).rejects.toThrow("terminate failed");
    expect(f.job.close).toHaveBeenCalledOnce();
    expect(f.tracker.size).toBe(0);
  });
  it("retains an unreturned child's failed cleanup and blocks allocation until synchronous recovery", async () => {
    const f = fixture();
    let ready!: (proc: ManagedProcess) => void;
    f.inner.launch.mockImplementationOnce(
      () =>
        new Promise<ManagedProcess>((resolve) => {
          ready = resolve;
        }),
    );
    const pending = f.launch();
    f.closeHost();
    vi.mocked(f.proc.terminate).mockRejectedValueOnce(new Error("child termination failed"));
    vi.mocked(f.proc.terminateSync).mockImplementationOnce(() => {
      throw new Error("sync termination failed");
    });
    ready(f.proc);
    await expect(pending).rejects.toThrow("child termination failed");
    expect(f.tracker.incompleteProcessCleanup).toBe(1);
    expect(() => f.tracker.retryFailedCleanup()).toThrow("sync termination failed");
    expect(f.tracker.incompleteProcessCleanup).toBe(1);
    f.closeHost();
    expect(f.tracker.incompleteProcessCleanup).toBe(0);
    expect(f.api.createKillOnCloseJob).toHaveBeenCalledOnce();
  });
  it("preserves the existing non-L1 general-host assignment fallback", async () => {
    const f = fixture();
    vi.mocked(f.job.assign).mockReturnValue(false);
    expect(await f.launch()).toBe(f.proc);
    expect(f.tracker.uncontained).toBe(1);
    expect(f.tracker.size).toBe(0);
  });
});

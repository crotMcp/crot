/** Portable fault injection, not Windows kernel evidence. */
import { describe, expect, it, vi } from "vitest";
import { bindJobObjectApi, bindViewJobObjectApi, ownedViewJobName } from "../../src/native-host/windows-job.js";
function fixture() {
  const live = new Set<unknown>(),
    faults = new Set<unknown>();
  let id = 0;
  const allocate = () => {
    const h = BigInt(++id);
    live.add(h);
    return h;
  };
  const calls = {
    CreateJobObjectW: vi.fn(allocate),
    GetLastError: vi.fn(() => 0),
    SetLastError: vi.fn(() => undefined),
    SetInformationJobObject: vi.fn(() => 1),
    QueryInformationJobObject: vi.fn((_h, _c, out) => {
      Object.assign(out, { ActiveProcesses: 0, TotalProcesses: 0 });
      return 1;
    }),
    OpenProcess: vi.fn(allocate),
    AssignProcessToJobObject: vi.fn(() => 1),
    TerminateJobObject: vi.fn(() => 1),
    CloseHandle: vi.fn((handle: unknown) => {
      if (faults.has(handle) || !live.has(handle)) return 0;
      live.delete(handle);
      return 1;
    }),
  };
  const ffi = {
    struct: () => undefined,
    load: () => ({
      func: (signature: string) => {
        const name = /\b(\w+)\(/.exec(signature)?.[1];
        if (!name || !(name in calls)) throw new Error("Unexpected Job declaration.");
        return calls[name as keyof typeof calls] as (...args: unknown[]) => unknown;
      },
    }),
  };
  const api = bindJobObjectApi(ffi);
  return { api, ffi, live, faults, calls };
}
describe("Job handle ownership on native close failure", () => {
  it("does not report a failed Job close as closed and can retry the exact owned handle", () => {
    const f = fixture(),
      job = f.api.createKillOnCloseJob();
    f.faults.add(1n);
    expect(() => job.close()).toThrow("Job Object");
    expect(job.closed).toBe(false);
    expect(f.live.size).toBe(1);
    f.faults.clear();
    job.close();
    job.close();
    expect(job.closed).toBe(true);
    expect(f.live.size).toBe(0);
    expect(f.calls.CloseHandle.mock.calls).toEqual([[1n], [1n]]);
  });
  it("retains a failed assignment-process close, closes the Job anyway, and retries without reopening by PID", () => {
    const f = fixture(),
      job = f.api.createKillOnCloseJob();
    f.faults.add(2n);
    expect(() => job.assign(123)).toThrow("process assignment");
    expect(() => job.close()).toThrow("process assignment");
    expect(job.closed).toBe(true);
    expect([...f.live]).toEqual([2n]);
    f.faults.clear();
    job.close();
    expect(f.live.size).toBe(0);
    expect(f.calls.OpenProcess).toHaveBeenCalledOnce();
  });
  it("closes a normal assignment handle and remains idempotent", () => {
    const f = fixture(),
      job = f.api.createKillOnCloseJob();
    expect(job.assign(123)).toBe(true);
    expect([...f.live]).toEqual([1n]);
    job.close();
    job.close();
    expect(f.live.size).toBe(0);
  });
  it.each([false, true])("cleans up failed configuration, including native throw=%s", (throws) => {
    const f = fixture();
    if (throws)
      f.calls.SetInformationJobObject.mockImplementationOnce(() => {
        throw new Error("native configure");
      });
    else f.calls.SetInformationJobObject.mockReturnValueOnce(0);
    expect(() => f.api.createKillOnCloseJob()).toThrow(throws ? "native configure" : "kill-on-close");
    expect(f.live.size).toBe(0);
    const next = f.api.createKillOnCloseJob();
    next.close();
    expect(f.live.size).toBe(0);
  });
  it("retains failed creation across rebindings and refuses further allocations until exact cleanup succeeds", () => {
    const f = fixture();
    f.calls.SetInformationJobObject.mockReturnValueOnce(0);
    f.faults.add(1n);
    expect(() => f.api.createKillOnCloseJob()).toThrow("kill-on-close");
    const rebound = bindJobObjectApi(f.ffi);
    expect(() => rebound.createKillOnCloseJob()).toThrow("Job Object");
    expect(f.calls.CreateJobObjectW).toHaveBeenCalledOnce();
    expect([...f.live]).toEqual([1n]);
    f.faults.clear();
    const next = rebound.createKillOnCloseJob();
    expect([...f.live]).toEqual([2n]);
    next.close();
    expect(f.live.size).toBe(0);
  });
});

describe("owned projection Job identity", () => {
  it("creates a fresh host-generated name without changing empty accounting or kill-on-close", () => {
    const f = fixture(),
      api = bindViewJobObjectApi(f.ffi),
      job = api.createKillOnCloseJob();
    const name = ownedViewJobName(job);
    expect(name).toMatch(/^Local\\crot-view-job-[0-9a-f]{48}$/);
    expect(f.calls.CreateJobObjectW).toHaveBeenCalledWith(null, name);
    expect(job.accounting()).toEqual({ active: 0, total: 0 });
    const unnamed = f.api.createKillOnCloseJob();
    expect(() => ownedViewJobName(unnamed)).toThrow("projection Job");
    unnamed.close();
    job.close();
    expect(() => ownedViewJobName(job)).toThrow("projection Job");
  });
  it("never configures or terminates an existing name collision, and retries failed close before allocation", () => {
    const f = fixture(),
      api = bindViewJobObjectApi(f.ffi);
    f.calls.GetLastError.mockReturnValue(183);
    f.faults.add(1n);
    expect(() => api.createKillOnCloseJob()).toThrow("collision");
    expect(f.calls.SetInformationJobObject).not.toHaveBeenCalled();
    expect(f.calls.TerminateJobObject).not.toHaveBeenCalled();
    expect(() => api.createKillOnCloseJob()).toThrow("close incomplete");
    expect(f.calls.CreateJobObjectW).toHaveBeenCalledOnce();
    f.faults.clear();
    f.calls.GetLastError.mockReturnValue(0);
    const job = api.createKillOnCloseJob();
    job.close();
    expect(f.live.size).toBe(0);
  });
});

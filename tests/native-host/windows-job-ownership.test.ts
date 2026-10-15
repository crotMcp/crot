/** Portable fault injection, not Windows kernel evidence. */
import { describe, expect, it, vi } from "vitest";
import { bindJobObjectApi } from "../../src/native-host/windows-job.js";
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

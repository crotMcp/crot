/** Fixed diagnostic attach ordering: no real debugger is exercised here. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownedAccessStack } from "./diagnostics/owned-access-stack.js";
import type { RestrictedToken } from "../../../src/native-host/windows-l1/restricted-token.js";
import type { JobObjectApi } from "../../../src/native-host/windows-job.js";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "crot-owned-attach-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function fixture(ready = true) {
  const log = path.join(dir, "owned.log");
  const job = {};
  const proc = { exitCode: vi.fn((): number | null => (ready ? null : 0)), close: vi.fn() };
  const launch = vi.fn(() => {
    if (ready) writeFileSync(log, "CROT_OWNED_DEBUG_READY\r\n", "utf16le");
    return proc;
  });
  const createJob = vi.fn(() => job);
  const trace = ownedAccessStack({
    debuggerPath: "C:\\SDK\\cdb.exe",
    log,
    cwd: "C:\\Windows",
    systemRoot: "C:\\Windows",
    token: { launchProbe: launch } as unknown as RestrictedToken,
    jobs: { createKillOnCloseJob: createJob } as unknown as JobObjectApi,
  });
  return { trace, launch, createJob, job, proc, log };
}
describe("fixed owned CDB attach", () => {
  it("avoids a break-in thread/target-kill/resume option and uses only the fresh target and Job", () => {
    const f = fixture();
    f.trace.beforeResume(123);
    expect(f.createJob).toHaveBeenCalledOnce();
    const [spec, job] = f.launch.mock.calls[0] as unknown as [
      { executable: string; args: string[]; stdio: string },
      unknown,
    ];
    expect(spec.executable).toBe("C:\\SDK\\cdb.exe");
    expect(spec.args).toEqual([
      "-G",
      "-pb",
      "-pd",
      "-noshell",
      "-noinh",
      "-nosqm",
      "-p",
      "123",
      "-c",
      expect.any(String),
    ]);
    expect(spec.args).not.toContain("-pr");
    expect(spec.stdio).toBe("nul");
    expect(job).toBe(f.job);
    expect(f.trace.collect()).toMatchObject({
      ready: true,
      debuggerExitCode: null,
      exitObservationFailed: false,
      denialSites: 0,
    });
    expect(() => f.trace.beforeResume(456)).toThrow("identity");
    expect(f.launch).toHaveBeenCalledOnce();
    f.trace.close();
    expect(f.proc.close).toHaveBeenCalledOnce();
  });
  it("reports debugger failure before readiness without manufacturing ready/denial evidence", () => {
    const f = fixture(false);
    expect(() => f.trace.beforeResume(123)).toThrow("before readiness");
    expect(f.trace.collect()).toMatchObject({
      ready: false,
      debuggerExitCode: 0,
      denialSites: 0,
      frames: { native: [], managed: [] },
    });
    f.trace.close();
    expect(f.proc.close).toHaveBeenCalledOnce();
  });
  it("does not promote an unreadable debugger exit state to a successful observation", () => {
    const f = fixture();
    f.trace.beforeResume(123);
    f.proc.exitCode.mockImplementation(() => {
      throw new Error("owned observation failure");
    });
    expect(f.trace.collect()).toMatchObject({ exitObservationFailed: true, debuggerExitCode: null });
    f.trace.close();
  });
});

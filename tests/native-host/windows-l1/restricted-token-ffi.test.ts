import { bindProbeIntegrity, type ProbeLabel } from "../../../src/native-host/windows-l1/probe-integrity.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobObject } from "../../../src/native-host/windows-job.js";
import type { ProbeSpec } from "../../../src/native-host/windows-l1/probe-process.js";
import {
  bindRestrictedTokens,
  type RestrictedTokenApi,
  type TokenFfi,
} from "../../../src/native-host/windows-l1/restricted-token.js";

function compiler(): string | undefined {
  if (process.platform === "win32") return undefined;
  for (const cc of ["cc", "gcc", "clang"]) {
    try {
      execFileSync(cc, ["--version"], { stdio: "ignore" });
      return cc;
    } catch {
      /* next */
    }
  }
  return undefined;
}
const cc = compiler();
const sid = "S-1-5-32-545";
let dir = "";
let api: RestrictedTokenApi;
let labelFixture: (file: string, label: ProbeLabel) => void;
let fault: (n: number) => void;
let live: () => number;
let resetProcess: () => void;
let markAssigned: () => void;
let creates: () => number;
let resumes: () => number;
let kills: () => number;
const spec: ProbeSpec = {
  executable: "C:\\fixture\\node.exe",
  args: ["-e", "process.exit(0)"],
  cwd: "C:\\fixture",
  env: { SystemRoot: "C:\\Windows" },
};
function job(options: { assign?: boolean; accounting?: boolean; empty?: boolean; throws?: boolean } = {}): JobObject {
  let closed = false;
  let assigned = false;
  return {
    get closed() {
      return closed;
    },
    assign: (pid) => {
      expect(pid).toBe(42);
      if (options.throws) throw new Error("assign failed");
      if (options.assign === false) return false;
      assigned = true;
      markAssigned();
      return true;
    },
    accounting: () =>
      options.accounting === false
        ? null
        : { active: assigned || options.empty === false ? 1 : 0, total: assigned || options.empty === false ? 1 : 0 },
    activeProcessCount: () => (assigned ? 1 : 0),
    terminate: () => true,
    close: () => {
      closed = true;
    },
  };
}

describe.skipIf(!cc)("restricted tokens: compiled native ABI stand-in (not real L1)", () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "crot-token-ffi-"));
    const lib = path.join(dir, "token.so");
    const source = fileURLToPath(new URL("./fixtures/token-ffi.c", import.meta.url));
    execFileSync(cc!, ["-shared", "-fPIC", "-o", lib, source]);
    const imported: unknown = await import("koffi");
    const ffi = ((imported as { default?: unknown }).default ?? imported) as TokenFfi;
    api = bindRestrictedTokens(ffi, { advapi32: lib, kernel32: lib });
    labelFixture = bindProbeIntegrity(ffi, { advapi32: lib, kernel32: lib });
    expect(bindRestrictedTokens(ffi, { advapi32: lib, kernel32: lib })).toBe(api);
    fault = ffi.load(lib).func("void SetFault(int n)") as typeof fault;
    live = ffi.load(lib).func("int LiveAllocations(void)") as typeof live;
    resetProcess = ffi.load(lib).func("void ResetProcessCounters(void)") as typeof resetProcess;
    markAssigned = ffi.load(lib).func("void MarkJobAssigned(void)") as typeof markAssigned;
    creates = ffi.load(lib).func("int CreateCount(void)") as typeof creates;
    resumes = ffi.load(lib).func("int ResumeCount(void)") as typeof resumes;
    kills = ffi.load(lib).func("int KillCount(void)") as typeof kills;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("marshals a restricting SID, output handles and read/write DACL decisions", () => {
    fault(0);
    const token = api.create(sid);
    try {
      expect(live()).toBe(2);
      expect(token.fileDaclAccess("C:\\fixture\\none")).toEqual({ readData: false, writeData: false });
      expect(token.fileDaclAccess("C:\\fixture\\R")).toEqual({ readData: true, writeData: false });
      expect(token.fileDaclAccess("C:\\fixture\\RW")).toEqual({ readData: true, writeData: true });
      expect(live()).toBe(2);
    } finally {
      token.close();
    }
    token.close();
    expect(token.closed).toBe(true);
    expect(() => token.fileDaclAccess("C:\\fixture\\R")).toThrow(/closed/);
    expect(live()).toBe(0);
  });
  it.each([1, 2, 3, 4, 5])("cleans native allocations on setup failure %i", (n) => {
    fault(n);
    expect(() => api.create(sid)).toThrow(expect.objectContaining({ code: "OPERATION_FAILED" }));
    expect(live()).toBe(0);
    fault(0);
  });
  it.each([6, 7, 8])("rejects native access failure/malformed grant %i without leak", (n) => {
    fault(0);
    const token = api.create(sid);
    try {
      fault(n);
      expect(() => token.fileDaclAccess("C:\\fixture\\secret")).toThrow(/failed/);
      expect(live()).toBe(2);
    } finally {
      fault(0);
      token.close();
    }
    expect(live()).toBe(0);
  });
  it("validates SID and paths before native calls", () => {
    fault(0);
    expect(() => api.create("not-a-sid")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(live()).toBe(0);
    const token = api.create(sid);
    try {
      for (const p of ["relative", "C:\\bad\0path", 'C:\\bad"path'])
        expect(() => token.fileDaclAccess(p)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    } finally {
      token.close();
    }
    expect(live()).toBe(0);
  });
  it("creates suspended with explicit env/no inherited handles and resumes only after Job assignment", () => {
    fault(0);
    resetProcess();
    const token = api.create(sid);
    const j = job();
    const process = token.launchProbe(spec, j);
    expect(process.pid).toBe(42);
    expect(process.exitCode()).toBeNull();
    expect(creates()).toBe(1);
    expect(resumes()).toBe(1);
    expect(live()).toBe(3);
    process.close();
    process.close();
    expect(j.closed).toBe(true);
    expect(process.closed).toBe(true);
    expect(() => process.exitCode()).toThrow(/closed/);
    expect(kills()).toBe(1);
    expect(live()).toBe(2);
    token.close();
    expect(live()).toBe(0);
  });
  it.each([9, 10, 11])("cleans partial creation/resume failure %i without native leaks", (n) => {
    fault(0);
    resetProcess();
    const token = api.create(sid);
    const j = job();
    try {
      fault(n);
      expect(() => token.launchProbe(spec, j)).toThrow();
      expect(resumes()).toBe(n === 11 ? 1 : 0);
      expect(kills()).toBe(n === 9 ? 0 : 1);
      expect(j.closed).toBe(true);
      expect(live()).toBe(2);
    } finally {
      fault(0);
      token.close();
    }
    expect(live()).toBe(0);
  });
  it.each([false, true])("kills a suspended process without resume on Job assignment failure (throws=%s)", (throws) => {
    fault(0);
    resetProcess();
    const token = api.create(sid);
    const j = job({ assign: false, throws });
    try {
      expect(() => token.launchProbe(spec, j)).toThrow();
      expect(creates()).toBe(1);
      expect(resumes()).toBe(0);
      expect(kills()).toBe(1);
      expect(j.closed).toBe(true);
      expect(live()).toBe(2);
    } finally {
      token.close();
    }
    expect(live()).toBe(0);
  });
  it.each([{ empty: false }, { accounting: false }])(
    "rejects nonempty/unverifiable Jobs before process creation %j",
    (options) => {
      fault(0);
      resetProcess();
      const token = api.create(sid);
      const j = job(options);
      try {
        expect(() => token.launchProbe(spec, j)).toThrow();
        expect(creates()).toBe(0);
        expect(resumes()).toBe(0);
        expect(j.closed).toBe(false);
      } finally {
        token.close();
      }
      expect(live()).toBe(0);
    },
  );
  it("closed tokens close the supplied Job without launching", () => {
    fault(0);
    resetProcess();
    const token = api.create(sid);
    token.close();
    const j = job();
    expect(() => token.launchProbe(spec, j)).toThrow(/closed/);
    expect(creates()).toBe(0);
    expect(j.closed).toBe(true);
    expect(live()).toBe(0);
  });
  it("closed tokens do not close Jobs that may contain another workload", () => {
    fault(0);
    resetProcess();
    const token = api.create(sid);
    token.close();
    const j = job({ empty: false });
    expect(() => token.launchProbe(spec, j)).toThrow(/closed/);
    expect(j.closed).toBe(false);
    expect(creates()).toBe(0);
    expect(live()).toBe(0);
  });
  it("rejects invalid executable/argument/environment before creation and disposes the Job", () => {
    fault(0);
    resetProcess();
    const token = api.create(sid);
    try {
      for (const bad of [
        { ...spec, executable: "C:\\fixture\\x.cmd" },
        { ...spec, args: ["bad\0argument"] },
        { ...spec, env: { PATH: "a", Path: "b" } },
      ]) {
        const j = job();
        expect(() => token.launchProbe(bad, j)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
        expect(j.closed).toBe(true);
      }
      expect(creates()).toBe(0);
      expect(live()).toBe(2);
    } finally {
      token.close();
    }
    expect(live()).toBe(0);
  });
  it("marshals both unique and common probe SIDs, with no SID allocation leak", () => {
    fault(0);
    const token = api.create("S-1-5-21-101-102-103-104", true);
    try {
      token.prepareProbeObjects("S-1-5-21-201-202-203-204");
      expect(live()).toBe(2);
    } finally {
      token.close();
    }
    expect(live()).toBe(0);
  });
  it("marshals a trusted logon SID for the session object namespace", () => {
    fault(0);
    const token = api.create("S-1-5-21-101-102-103-104", true, "S-1-5-5-101-102");
    expect(live()).toBe(2);
    token.close();
    expect(live()).toBe(0);
  });
  it.each(["S-1-5-32-545", "S-1-5-21-1-2-3-4", "S-1-5-5-1-2\0"])(
    "rejects non-logon probe SID %s before allocation",
    (value) => {
      expect(() => api.create("S-1-5-21-101-102-103-104", true, value)).toThrow(/logon SID/);
      expect(live()).toBe(0);
    },
  );
  it("rejects a logon SID outside the explicit common-resource experiment", () => {
    expect(() => api.create("S-1-5-21-101-102-103-104", false, "S-1-5-5-1-2")).toThrow(/logon SID/);
    expect(live()).toBe(0);
  });
  it("prepares only a unique probe token default DACL and releases its descriptor", () => {
    fault(0);
    const token = api.create("S-1-5-21-101-102-103-104");
    try {
      token.prepareProbeObjects("S-1-5-21-201-202-203-204");
      expect(live()).toBe(2);
    } finally {
      token.close();
    }
    expect(live()).toBe(0);
  });
  it.each([12, 13, 14, 15])("cleans descriptor on default DACL failure %i", (n) => {
    fault(0);
    const token = api.create("S-1-5-21-101-102-103-104");
    try {
      fault(n);
      expect(() => token.prepareProbeObjects("S-1-5-21-201-202-203-204")).toThrow(/failed/);
      expect(live()).toBe(2);
    } finally {
      fault(0);
      token.close();
    }
    expect(live()).toBe(0);
  });
  it("does not grant normal group SIDs access to new probe objects", () => {
    fault(0);
    const token = api.create(sid);
    try {
      expect(() => token.prepareProbeObjects("S-1-5-21-201-202-203-204")).toThrow(/unique restricting SID/);
      expect(live()).toBe(2);
    } finally {
      token.close();
    }
    expect(live()).toBe(0);
  });
  it("does not leak handles across repeated create/check/close cycles", () => {
    fault(0);
    for (let i = 0; i < 200; i++) {
      const token = api.create(sid);
      try {
        expect(token.fileDaclAccess("C:\\fixture\\RW").writeData).toBe(true);
      } finally {
        token.close();
      }
    }
    expect(live()).toBe(0);
  });
  it("marshals WRITE_RESTRICTED without changing the default token mode", () => {
    fault(0);
    const token = api.create(sid, false, undefined, "write-only");
    token.lowerProbeIntegrity();
    expect(live()).toBe(2);
    token.close();
    expect(live()).toBe(0);
    expect(() => token.lowerProbeIntegrity()).toThrow(/closed/);
  });
  it("rejects unknown restriction modes before allocating native resources", () => {
    expect(() => api.create(sid, false, undefined, "none" as "write-only")).toThrow(/restriction mode/);
    expect(live()).toBe(0);
  });
  it.each([2, 16])("releases the integrity SID when native operation %i fails", (n) => {
    fault(0);
    const token = api.create(sid);
    try {
      fault(n);
      expect(() => token.lowerProbeIntegrity()).toThrow(/failed/);
      expect(live()).toBe(2);
    } finally {
      fault(0);
      token.close();
    }
    expect(live()).toBe(0);
  });
  it.each(["low-write", "medium-write", "medium-no-read"] as const)(
    "sets only fixture mandatory label %s and frees descriptor",
    (label) => {
      fault(0);
      labelFixture("C:\\fixture\\probe", label);
      expect(live()).toBe(0);
    },
  );
  it.each([12, 17, 18])("cleans mandatory-label descriptor on native failure %i", (n) => {
    fault(n);
    expect(() => labelFixture("C:\\fixture\\probe", "medium-no-read")).toThrow(/mandatory label failed/);
    expect(live()).toBe(0);
    fault(0);
  });
  it("rejects arbitrary labels without invoking native code", () => {
    expect(() => labelFixture("C:\\fixture\\probe", "none" as ProbeLabel)).toThrow(/invalid fixture label/);
    expect(live()).toBe(0);
  });
  it("marshals privilege-stripped MIC-only with zero SID count/null pointer; rejects implicit filters", () => {
    fault(0);
    const token = api.create("S-1-5-21-101-102-103-104", false, undefined, "mic-only");
    token.prepareProbeObjects("S-1-5-21-201-202-203-204");
    token.lowerProbeIntegrity();
    expect(live()).toBe(2);
    token.close();
    expect(live()).toBe(0);
    expect(() => api.create(sid, true, undefined, "mic-only")).toThrow(/extra SID filtering/);
    expect(live()).toBe(0);
  });
});

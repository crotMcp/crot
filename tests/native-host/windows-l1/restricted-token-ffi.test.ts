import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
let fault: (n: number) => void;
let live: () => number;

describe.skipIf(!cc)("restricted tokens: compiled native ABI stand-in (not real L1)", () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "crot-token-ffi-"));
    const lib = path.join(dir, "token.so");
    const source = fileURLToPath(new URL("./fixtures/token-ffi.c", import.meta.url));
    execFileSync(cc!, ["-shared", "-fPIC", "-o", lib, source]);
    const imported: unknown = await import("koffi");
    const ffi = ((imported as { default?: unknown }).default ?? imported) as TokenFfi;
    api = bindRestrictedTokens(ffi, { advapi32: lib, kernel32: lib });
    expect(bindRestrictedTokens(ffi, { advapi32: lib, kernel32: lib })).toBe(api);
    fault = ffi.load(lib).func("void SetFault(int n)") as typeof fault;
    live = ffi.load(lib).func("int LiveAllocations(void)") as typeof live;
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
});

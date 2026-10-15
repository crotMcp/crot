import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bnoIsolationAttribute,
  bindBnoIsolationVerifier,
  createBnoIsolation,
  type BnoIsolation,
} from "../../../src/native-host/windows-l1/bno-isolation.js";
import type { TokenFfi } from "../../../src/native-host/windows-l1/restricted-token.js";
it("uses only a new branded CROT prefix with exact BOOL/WCHAR[136] layout", () => {
  const cap = createBnoIsolation(),
    a = bnoIsolationAttribute(cap),
    b = bnoIsolationAttribute(createBnoIsolation());
  expect(a.length).toBe(276);
  expect(a.readUInt32LE()).toBe(1);
  expect(a.subarray(4).toString("utf16le").replace(/\0+$/, "")).toMatch(/^crot-bno-[a-f0-9]{48}$/);
  expect(a.equals(b)).toBe(false);
  expect(bnoIsolationAttribute(cap)).toEqual(a);
  expect(() => bnoIsolationAttribute({ kind: "owned-bno-isolation" } as BnoIsolation)).toThrow("unowned capability");
});
let cc: string | undefined;
if (process.platform !== "win32")
  for (const c of ["cc", "gcc", "clang"])
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      cc = c;
      break;
    } catch {
      /*next*/
    }
describe.skipIf(!cc)("BNO bounded native ABI read-back (not kernel isolation)", () => {
  let dir: string, verifier: ReturnType<typeof bindBnoIsolationVerifier>, cap: BnoIsolation;
  let fault: (n: number) => void, live: () => number, invalid: () => number, opens: () => number;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "crot-bno-"));
    const lib = path.join(dir, "bno.so");
    execFileSync(cc!, ["-shared", "-fPIC", "-o", lib, fileURLToPath(new URL("./fixtures/bno-ffi.c", import.meta.url))]);
    const m: string = "koffi",
      module = await import(m),
      ffi = (module.default ?? module) as TokenFfi;
    const native = ffi.load(lib);
    fault = native.func("void BnoFault(int n)") as typeof fault;
    live = native.func("int BnoLive(void)") as typeof live;
    invalid = native.func("int BnoInvalid(void)") as typeof invalid;
    opens = native.func("int BnoOpens(void)") as typeof opens;
    const set = native.func("void SetBnoPrefix(str16 prefix)");
    cap = createBnoIsolation();
    set(bnoIsolationAttribute(cap).subarray(4).toString("utf16le").replace(/\0+$/, ""));
    verifier = bindBnoIsolationVerifier(ffi, { kernel32: lib, advapi32: lib });
    expect(bindBnoIsolationVerifier(ffi, { kernel32: lib, advapi32: lib })).toBe(verifier);
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));
  it("reads only the actual owned process token and releases it after exact bounded prefix verification", () => {
    fault(0);
    verifier.retry();
    verifier.verify(0x123n, cap);
    expect(live()).toBe(0);
    expect(invalid()).toBe(0);
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])("fails closed for native/malformed read-back %i without losing a token", (n) => {
    fault(n);
    expect(() => verifier.verify(0x123n, cap)).toThrow();
    fault(0);
    verifier.retry();
    expect(live()).toBe(0);
    expect(invalid()).toBe(0);
  });
  it("retains an unclosed token and forbids further token allocation until retry succeeds", () => {
    fault(10);
    expect(() => verifier.verify(0x123n, cap)).toThrow("CloseHandle");
    expect(live()).toBe(1);
    const before = opens();
    for (let i = 0; i < 3; i++) {
      expect(() => verifier.verify(0x123n, cap)).toThrow("CloseHandle");
      expect(opens()).toBe(before);
      expect(live()).toBe(1);
    }
    fault(0);
    verifier.retry();
    verifier.verify(0x123n, cap);
    expect(live()).toBe(0);
    expect(invalid()).toBe(0);
  });
});

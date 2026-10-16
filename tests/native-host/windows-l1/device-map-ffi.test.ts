/** Compiled ABI and ownership tests; real security is qualified separately on Windows. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { bindPrivatePipeMaps } from "../../../src/native-host/windows-l1/device-map.js";
const cc = (() => {
  if (process.platform === "win32") return undefined;
  for (const c of ["cc", "gcc", "clang"]) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {
      /* next */
    }
  }
  return undefined;
})();
describe.skipIf(!cc)("private pipe map real native ABI stand-in", () => {
  let dir: string,
    maps: ReturnType<typeof bindPrivatePipeMaps>,
    live: () => number,
    fault: (n: number) => void,
    applications: () => number;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "crot-map-ffi-"));
    const lib = path.join(dir, "map.so");
    execFileSync(cc!, [
      "-shared",
      "-fPIC",
      "-o",
      lib,
      fileURLToPath(new URL("./fixtures/device-map-ffi.c", import.meta.url)),
    ]);
    const imported = await import("koffi"),
      ffi = imported.default ?? imported;
    maps = bindPrivatePipeMaps(ffi, { ntdll: lib, kernel32: lib, advapi32: lib });
    const n = ffi.load(lib);
    live = n.func("int MapLive(void)");
    fault = n.func("void MapFault(int n)");
    applications = n.func("int MapApplications(void)");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const create = () => maps.create("S-1-5-21-1-2-3-1001", "S-1-15-2-1-2-3-4-5-6-7");
  it("uses the full zero-padded 40-byte DeviceMap union and assigns only the explicit process", () => {
    const before = applications(),
      p = create();
    expect(live()).toBe(5);
    p.apply(42);
    expect(applications()).toBe(before + 1);
    expect(() => p.apply(42)).toThrow(/admission/);
    p.close();
    p.close();
    expect(live()).toBe(0);
    expect(() => p.apply(42)).toThrow(/admission/);
  });
  it.each([1, 2, 3])("releases every setup allocation after native fault %i", (n) => {
    fault(n);
    try {
      expect(create).toThrow(/failed/);
    } finally {
      fault(0);
    }
    expect(live()).toBe(0);
  });
  it("fails closed on process assignment without choosing a different/global map", () => {
    const p = create(),
      before = applications();
    fault(4);
    try {
      expect(() => p.apply(42)).toThrow(/assignment/);
    } finally {
      fault(0);
      p.close();
    }
    expect(applications()).toBe(before);
    expect(live()).toBe(0);
  });
  it("retains failed releases and blocks allocation until that exact lease is closed", () => {
    const p = create();
    fault(5);
    try {
      expect(() => p.close()).toThrow(/release/);
      expect(create).toThrow(/incomplete/);
    } finally {
      fault(0);
      p.close();
    }
    expect(live()).toBe(0);
    const next = create();
    next.close();
    expect(live()).toBe(0);
  });
  it("rejects a non-package identity before creating objects", () => {
    expect(() => maps.create("S-1-5-21-1", "S-1-5-32-545")).toThrow(/package admission/);
    expect(live()).toBe(0);
  });
});

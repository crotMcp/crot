/** Contract/pointer ABI qualification, NOT native Windows protection evidence. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindWindowsPrivateState } from "../../../src/native-host/windows-state.js";
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
describe.skipIf(!cc)("exact CROT private state native ABI", () => {
  let dir: string,
    api: ReturnType<typeof bindWindowsPrivateState>,
    fault: (n: number) => void,
    handles: () => number,
    memory: () => number,
    invalid: () => number,
    sets: () => number;
  const owner = "S-1-5-21-1-2-3-1000",
    file = "C:\\fixture\\state\\credential.txt";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "crot-state-ffi-"));
    const lib = path.join(dir, "state.so");
    execFileSync(cc!, [
      "-shared",
      "-fPIC",
      "-o",
      lib,
      fileURLToPath(new URL("./fixtures/state-ffi.c", import.meta.url)),
    ]);
    const name: string = "koffi",
      m = await import(name),
      ffi = m.default ?? m,
      n = ffi.load(lib);
    fault = n.func("void StateFault(int f)");
    handles = n.func("int StateHandles(void)");
    memory = n.func("int StateMemory(void)");
    invalid = n.func("int StateInvalid(void)");
    sets = n.func("int StateSets(void)");
    api = bindWindowsPrivateState(ffi, { kernel32: lib, advapi32: lib, ntdll: lib });
    expect(bindWindowsPrivateState(ffi, { kernel32: lib, advapi32: lib, ntdll: lib })).toBe(api);
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));
  it.each([false, true])(
    "pins every ancestor/type before installing and reading back exact owner-only Medium-NR (directory=%s)",
    (directory) => {
      fault(0);
      expect(api(file, owner, directory, true)).toBe(true);
      expect(handles()).toBe(0);
      expect(memory()).toBe(0);
      expect(invalid()).toBe(0);
    },
  );
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14])(
    "fails closed for state ABI failure %i and releases all partial owners",
    (n) => {
      fault(n);
      expect(() => api(file, owner, false, true)).toThrow();
      fault(0);
      expect(handles()).toBe(0);
      expect(memory()).toBe(0);
      expect(invalid()).toBe(0);
    },
  );
  it.each([3, 4, 12, 13])("refuses alias/reparse/unsafe-parent case %i before changing any descriptor", (n) => {
    fault(n);
    const before = sets();
    expect(() => api(file, owner, false, true)).toThrow();
    fault(0);
    expect(sets()).toBe(before);
  });
  it.each([10, 11])("retains failed native release %i and blocks allocation until recovery", (n) => {
    fault(n);
    expect(() => api(file, owner, false, true)).toThrow("native release");
    const h = handles(),
      m = memory();
    expect(h + m).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      expect(() => api(file, owner, false, true)).toThrow("native release");
      expect(handles()).toBe(h);
      expect(memory()).toBe(m);
    }
    fault(0);
    expect(api(file, owner, false, true)).toBe(true);
    expect(handles()).toBe(0);
    expect(memory()).toBe(0);
    expect(invalid()).toBe(0);
  });
  it("does not mutate state in inspect mode", () => {
    fault(0);
    const before = sets();
    expect(api(file, owner, false, false)).toBe(false);
    expect(sets()).toBe(before);
    expect(handles()).toBe(0);
    expect(memory()).toBe(0);
  });
  it.each(["C:\\fixture\\..\\secret", "C:\\fixture\\secret:stream", "\\\\host\\share\\secret"])(
    "rejects unpinned state path %s before native allocation",
    (name) => {
      fault(0);
      expect(() => api(name, owner, false, true)).toThrow();
      expect(handles()).toBe(0);
      expect(memory()).toBe(0);
    },
  );
});

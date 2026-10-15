/** Compiled native pointer/ABI qualification; not Windows kernel evidence. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindBytePipeApi, type BytePipeApi } from "../../../src/native-host/windows-l1/byte-stdio.js";
import type { TokenFfi } from "../../../src/native-host/windows-l1/restricted-token.js";
const owner = "S-1-5-21-1-2-3-1000";
let compiler: string | undefined;
if (process.platform !== "win32")
  for (const candidate of ["cc", "gcc", "clang"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      compiler = candidate;
      break;
    } catch {
      /* next */
    }
  }
describe.skipIf(!compiler)("owned byte transport compiled native ABI", () => {
  let dir: string, api: BytePipeApi, live: () => number, invalid: () => number;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "crot-byte-ffi-"));
    const lib = path.join(dir, "byte.so");
    execFileSync(compiler!, [
      "-shared",
      "-fPIC",
      "-o",
      lib,
      fileURLToPath(new URL("./fixtures/byte-ffi.c", import.meta.url)),
    ]);
    const moduleName: string = "koffi";
    const module = await import(moduleName);
    const ffi = (module.default ?? module) as TokenFfi;
    api = bindBytePipeApi(ffi, { kernel32: lib, advapi32: lib });
    live = ffi.load(lib).func("int LiveByteHandles(void)") as typeof live;
    invalid = ffi.load(lib).func("int InvalidByteAbi(void)") as typeof invalid;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("keeps native read buffer and OVERLAPPED alive after ReadFile returns; no temporary count pointer", async () => {
    const pair = await api.create("output", owner);
    const data = Buffer.alloc(257);
    const read = pair.read(data);
    expect(read.completed).toBe(false);
    expect(() => read.release()).toThrow("pending native memory");
    expect(read.poll()).toEqual({ state: "complete", bytes: 257 });
    expect(data).toEqual(Buffer.alloc(257, 0xa5));
    read.release();
    pair.closeChild();
    pair.closeParent();
    expect(live()).toBe(0);
    expect(invalid()).toBe(0);
  });
  it("uses exact native write byte count and releases only after acknowledged cancellation", async () => {
    const pair = await api.create("input", owner);
    const write = pair.write(Buffer.from([0, 255, 128, 0]));
    expect(write.poll()).toEqual({ state: "complete", bytes: 4 });
    write.release();
    const pending = pair.write(Buffer.alloc(65536));
    pending.cancel();
    expect(() => pending.poll()).toThrow(
      expect.objectContaining({ details: { stage: "complete overlapped I/O", nativeCode: 995 } }),
    );
    expect(pending.completed).toBe(true);
    pending.release();
    pending.release();
    pair.closeChild();
    pair.closeParent();
    expect(live()).toBe(0);
    expect(invalid()).toBe(0);
  });
});

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bindLocalPipeShim } from "../../../src/native-host/windows-l1/local-shim.js";
import type { TokenFfi } from "../../../src/native-host/windows-l1/restricted-token.js";
function fixture(code = 0) {
  const inject = vi.fn(() => code),
    unload = vi.fn();
  const ffi: TokenFfi = {
    struct: vi.fn(),
    sizeof: () => 8,
    encode: vi.fn(),
    load: vi.fn(() => ({ func: (signature: string) => (signature.includes("Version") ? () => 1 : inject), unload })),
  };
  return { ffi, inject, unload };
}
describe("LOCAL shim ownership, not a kernel security proof", () => {
  it("passes only the held process handle and unloads once", () => {
    const f = fixture(),
      shim = bindLocalPipeShim(f.ffi, "C:\\owned\\crot-local-shim.dll");
    shim.prepareSuspended(42);
    expect(f.inject).toHaveBeenCalledExactlyOnceWith(42);
    shim.close();
    shim.close();
    expect(f.unload).toHaveBeenCalledOnce();
    expect(() => shim.prepareSuspended(42)).toThrow(/closed/);
  });
  it("fails closed on injection error with no alternative native call", () => {
    const f = fixture(5),
      shim = bindLocalPipeShim(f.ffi, "C:\\owned\\crot-local-shim.dll");
    expect(() => shim.prepareSuspended(42)).toThrow(/before ResumeThread/);
    expect(f.inject).toHaveBeenCalledOnce();
    shim.close();
  });
  it.each([null, undefined, 0, 0n])("refuses an absent process handle", (handle) => {
    const f = fixture(),
      shim = bindLocalPipeShim(f.ffi, "C:\\owned\\crot-local-shim.dll");
    expect(() => shim.prepareSuspended(handle)).toThrow(/owned suspended/);
    expect(f.inject).not.toHaveBeenCalled();
    shim.close();
  });
});
const cc = (() => {
  if (process.platform === "win32") return undefined;
  try {
    execFileSync("c++", ["--version"], { stdio: "ignore" });
    return "c++";
  } catch {
    return undefined;
  }
})();
it.skipIf(!cc)("compiled C++ mapper redirects only the two literal libuv prefixes, never CROT or Docker", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crot-prefix-"));
  try {
    const source = path.join(dir, "probe.cpp"),
      exe = path.join(dir, "probe");
    await writeFile(
      source,
      String.raw`#include "pipe-prefix.h"
int main(){
 const wchar_t* valid[]={LR"(\\?\pipe\uv\one)",LR"(\\.\pipe\uv\one)"};
 for(auto input:valid){std::wstring out;if(!crotLocalPipeName(input,out)||out!=LR"(\\.\pipe\LOCAL\uv\one)")return 1;}
 const wchar_t* unchanged[]={LR"(\\.\pipe\service.sock)",LR"(\\.\pipe\control.sock)",LR"(\\.\pipe\docker_engine)",LR"(\\.\pipe\crot-control-owner)",LR"(\\?\pipe\uv-other\one)",LR"(\\.\pipe\LOCAL\uv\one)",LR"(C:\workspace\uv\one)",LR"(\\?\pipe\uv\)"};
 for(auto input:unchanged){std::wstring out;if(crotLocalPipeName(input,out))return 2;}
 std::wstring out;if(crotLocalPipeName(nullptr,out))return 3;return 0;
}`,
    );
    execFileSync(cc!, ["-std=c++17", "-I", path.resolve("native/windows-local-shim"), source, "-o", exe]);
    expect(execFileSync(exe).length).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Actual UTF16 pointer/output/allocator ABI, not a Windows security proof. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bindAppContainerProfiles } from "../../../src/native-host/windows-l1/appcontainer-profile.js";
const compiler = () => {
  if (process.platform === "win32") return undefined;
  for (const cc of ["cc", "gcc", "clang"]) {
    try {
      execFileSync(cc, ["--version"], { stdio: "ignore" });
      return cc;
    } catch {
      /* next compiler */
    }
  }
  return undefined;
};
const cc = compiler();
describe.skipIf(!cc)("AppContainer profile native ABI stand-in", () => {
  it("decodes LPWSTR data as UTF16 characters, not a pointer-to-pointer, and frees the right allocators", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "crot-profile-ffi-"));
    try {
      const lib = path.join(directory, "profile.so");
      execFileSync(cc!, [
        "-shared",
        "-fPIC",
        "-o",
        lib,
        fileURLToPath(new URL("./fixtures/appcontainer-profile-ffi.c", import.meta.url)),
      ]);
      const imported = await import("koffi"),
        ffi = imported.default ?? imported;
      const api = bindAppContainerProfiles(ffi, { userenv: lib, advapi32: lib, kernel32: lib });
      const live = ffi.load(lib).func("int ProfileLive(void)"),
        removed = ffi.load(lib).func("int ProfileRemoved(void)");
      const profile = api.create();
      expect(profile.sid).toBe("S-1-15-2-1-2-3-4-5-6-7");
      expect(live()).toBe(1);
      profile.close();
      expect(live()).toBe(0);
      expect(removed()).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

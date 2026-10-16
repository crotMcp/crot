import { describe, expect, it } from "vitest";
import { lockCreateFailure } from "../../src/service/locks.js";
describe("directory-lock mkdir failure: no ownership without successful mkdir", () => {
  it("treats ambiguous Windows delete-pending EPERM only as contention, never as ownership", () => {
    expect(lockCreateFailure({ code: "EPERM" }, "win32")).toBe("contended");
  });
  it.each(["linux", "darwin"] as const)("does not hide POSIX permission failures on %s", (platform) => {
    expect(lockCreateFailure({ code: "EPERM" }, platform)).toBe("fatal");
  });
  it.each(["EACCES", "ENOENT", "ENOSPC", "EIO"])("preserves other Windows failures %s", (code) => {
    expect(lockCreateFailure({ code }, "win32")).toBe("fatal");
  });
  it.each(["win32", "linux", "darwin"] as const)("preserves ordinary EEXIST on %s", (platform) => {
    expect(lockCreateFailure({ code: "EEXIST" }, platform)).toBe("exists");
  });
});

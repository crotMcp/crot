import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPosixExecutable } from "../../src/core/platform/node-launcher.js";
import { findWindowsExecutable } from "../../src/core/platform/windows-command.js";
import { isWindows, makeTempDirs, type TempDirs } from "../helpers.js";

describe("Windows lookup without the working directory (AD-1)", () => {
  const files = new Set(["C:\\repo\\git.bat", "C:\\repo\\bin\\git.exe", "C:\\Git\\cmd\\git.exe"]);
  const isFile = async (p: string) => files.has(p);
  const base = { cwd: "C:\\repo", pathExt: ".COM;.EXE;.BAT;.CMD", isFile };

  it("searches the working directory first by default", async () => {
    expect(await findWindowsExecutable("git", { ...base, path: "C:\\Git\\cmd" })).toBe("C:\\repo\\git.bat");
  });

  it("uses only fully qualified PATH entries when the working directory is excluded", async () => {
    const lookup = { ...base, path: "bin;.;\\x;C:rel;C:\\Git\\cmd", searchCurrentDirectory: false };
    expect(await findWindowsExecutable("git", lookup)).toBe("C:\\Git\\cmd\\git.exe");
  });

  it("refuses relative command paths and finds nothing without PATH", async () => {
    const lookup = { ...base, path: "C:\\Git\\cmd", searchCurrentDirectory: false };
    expect(await findWindowsExecutable(".\\git.bat", lookup)).toBeNull();
    expect(await findWindowsExecutable("bin\\git.exe", lookup)).toBeNull();
    expect(await findWindowsExecutable("git", { ...lookup, path: undefined })).toBeNull();
  });
});

describe.skipIf(isWindows)("POSIX lookup without the working directory (AD-1)", () => {
  let dirs: TempDirs;
  beforeEach(async () => {
    dirs = await makeTempDirs();
    for (const dir of [path.join(dirs.workspace, "bin"), path.join(dirs.outside, "bin")]) {
      await mkdir(dir);
      const file = path.join(dir, "tool");
      await writeFile(file, "#!/bin/sh\n");
      await chmod(file, 0o755);
    }
  });
  afterEach(() => dirs.cleanup());

  it("skips relative PATH entries", async () => {
    const pathValue = `bin:${path.join(dirs.outside, "bin")}`;
    expect(await findPosixExecutable("tool", dirs.workspace, pathValue)).toBe(path.join(dirs.workspace, "bin", "tool"));
    expect(await findPosixExecutable("tool", dirs.workspace, pathValue, false)).toBe(
      path.join(dirs.outside, "bin", "tool"),
    );
  });

  it("refuses relative command paths", async () => {
    expect(await findPosixExecutable("./bin/tool", dirs.workspace, "", false)).toBeNull();
    expect(await findPosixExecutable(path.join(dirs.outside, "bin", "tool"), dirs.workspace, "", false)).toBe(
      path.join(dirs.outside, "bin", "tool"),
    );
  });
});

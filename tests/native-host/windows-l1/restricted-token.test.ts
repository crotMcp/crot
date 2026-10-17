import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeHost } from "../../../src/native-host/native-host.js";
import { runTool, windowsTools } from "../../../src/native-host/windows-acl.js";
import {
  loadRestrictedTokens,
  type RestrictedTokenApi,
  type RestrictedToken,
} from "../../../src/native-host/windows-l1/restricted-token.js";
import { isWindows, makeTempDirs, type TempDirs } from "../../helpers.js";

const SID_USERS = "S-1-5-32-545";
const required = process.env.CROT_WINDOWS_TOKEN_REQUIRED === "1";
if (required && (!isWindows || !["x64", "arm64"].includes(process.arch)))
  throw new Error("Required native Windows token spike cannot run on this platform/architecture.");

// Only changes temporary fixture files. Never modifies a real user's ACLs.
const ALLOW_USERS = `
$ErrorActionPreference = 'Stop'
$p = $env:CROT_TOKEN_FIXTURE
$acl = [System.IO.File]::GetAccessControl($p)
$sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$rights = if ($env:CROT_TOKEN_RIGHTS -eq 'read') { [System.Security.AccessControl.FileSystemRights]::Read } else { [System.Security.AccessControl.FileSystemRights]::Read -bor [System.Security.AccessControl.FileSystemRights]::Write }
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($p, $acl)
`;

describe.runIf(isWindows)("Windows L1 spike: real restricted token and DACL (not complete L1)", () => {
  let dirs: TempDirs;
  let native: NativeHost;
  let api: RestrictedTokenApi;
  const tokens: RestrictedToken[] = [];
  beforeEach(async () => {
    dirs = await makeTempDirs();
    native = await NativeHost.start({ startupPath: "inherited", jobObjects: false });
    api = await loadRestrictedTokens();
  });
  afterEach(async () => {
    for (const token of tokens.splice(0)) token.close();
    await native.close();
    await dirs.cleanup();
  });
  const create = () => {
    const token = api.create(SID_USERS);
    tokens.push(token);
    return token;
  };
  const fixture = async (name: string, rights?: "read" | "read-write") => {
    const file = path.join(dirs.workspace, name);
    await writeFile(file, "canary");
    await native.platform.privateFiles.protectFile!(file);
    if (rights) {
      const tool = windowsTools(process.env.SystemRoot ?? "C:\\Windows").powershell;
      await runTool(tool, ["-NoProfile", "-NonInteractive", "-Command", ALLOW_USERS], {
        ...native.platform.baseEnvironment,
        CROT_TOKEN_FIXTURE: file,
        CROT_TOKEN_RIGHTS: rights,
      });
    }
    return file;
  };
  it("denies owner-only secret read/write while trusted service retains access", async () => {
    const file = await fixture("secret.txt");
    const token = create();
    expect(token.fileDaclAccess(file)).toEqual({ readData: false, writeData: false });
    expect(await readFile(file, "utf8")).toBe("canary");
    await writeFile(file, "service-update");
    expect(await readFile(file, "utf8")).toBe("service-update");
  });
  it("permits fixture workspace read/write with an explicit restricting-SID grant", async () => {
    expect(create().fileDaclAccess(await fixture("workspace.txt", "read-write"))).toEqual({
      readData: true,
      writeData: true,
    });
  });
  it("separates fixture read access from write access", async () => {
    expect(create().fileDaclAccess(await fixture("readonly.txt", "read"))).toEqual({
      readData: true,
      writeData: false,
    });
  });
  it("reveals the developer-read gap: owner-only user files are also denied", async () => {
    // A real restriction of this candidate, not an accepted product reduction.
    expect(create().fileDaclAccess(await fixture("user-project-read.txt"))).toEqual({
      readData: false,
      writeData: false,
    });
  });
  it("rejects missing descriptors rather than claiming access denied/available", () => {
    expect(() => create().fileDaclAccess(path.join(dirs.workspace, "missing"))).toThrow(
      expect.objectContaining({ code: "OPERATION_FAILED" }),
    );
  });
  it("closes handles idempotently and rejects use after close", async () => {
    const file = await fixture("lifecycle.txt", "read-write");
    const token = create();
    token.close();
    token.close();
    expect(token.closed).toBe(true);
    expect(() => token.fileDaclAccess(file)).toThrow(/closed/);
  });
});

/** Comparative research, not production L1 acceptance. Never relabel user files. */
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeHost } from "../../../src/native-host/native-host.js";
import { currentUserSid, runTool, windowsTools } from "../../../src/native-host/windows-acl.js";
import { loadJobObjectApi, type JobObjectApi } from "../../../src/native-host/windows-job.js";
import { loadProbeIntegrity } from "../../../src/native-host/windows-l1/probe-integrity.js";
import { loadRestrictedTokens, type RestrictedToken } from "../../../src/native-host/windows-l1/restricted-token.js";
import type { ProbeProcess } from "../../../src/native-host/windows-l1/probe-process.js";
import { isWindows, makeTempDirs, waitFor, type TempDirs } from "../../helpers.js";

if (process.env.CROT_WINDOWS_TOKEN_REQUIRED === "1" && (!isWindows || !["x64", "arm64"].includes(process.arch)))
  throw new Error("Required native Windows MIC experiment cannot run on this platform/architecture.");
const GRANT = `
$ErrorActionPreference = 'Stop'
$p = $env:CROT_MIC_WORKSPACE
$acl = [System.IO.Directory]::GetAccessControl($p)
$sid = [System.Security.Principal.SecurityIdentifier]::new($env:CROT_MIC_SID)
$flags = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::Modify, $flags, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($p, $acl)
`;
describe.runIf(isWindows)("Windows L1 spike: write-restricted / MIC comparison, disposable fixtures only", () => {
  let dirs: TempDirs;
  let host: NativeHost;
  let token: RestrictedToken;
  let jobs: JobObjectApi;
  let label: Awaited<ReturnType<typeof loadProbeIntegrity>>;
  let executable: string;
  let project: string;
  let secret: string;
  const probes: ProbeProcess[] = [];
  beforeEach(async () => {
    dirs = await makeTempDirs();
    host = await NativeHost.start({ startupPath: "inherited", jobObjects: false });
    jobs = await loadJobObjectApi();
    label = await loadProbeIntegrity();
    const n = randomBytes(16);
    const sid = `S-1-5-21-${n.readUInt32LE(0)}-${n.readUInt32LE(4)}-${n.readUInt32LE(8)}-${n.readUInt32LE(12)}`;
    token = (await loadRestrictedTokens()).create(sid, true, undefined, "write-only");
    const tools = windowsTools(process.env.SystemRoot ?? "C:\\Windows");
    token.prepareProbeObjects(await currentUserSid(tools));
    await runTool(tools.powershell, ["-NoProfile", "-NonInteractive", "-Command", GRANT], {
      ...host.platform.baseEnvironment,
      CROT_MIC_WORKSPACE: dirs.workspace,
      CROT_MIC_SID: sid,
    });
    project = path.join(dirs.outside, "owner-project.txt");
    secret = path.join(dirs.outside, "crot-like-canary.txt");
    for (const file of [project, secret]) {
      await writeFile(file, "owner-content");
      await host.platform.privateFiles.protectFile!(file);
    }
    label(dirs.workspace, "medium-write");
    label(project, "medium-write");
    label(secret, "medium-write");
    executable = path.join(dirs.workspace, "node probe.exe");
    await copyFile(process.execPath, executable);
  });
  afterEach(async () => {
    for (const probe of probes.splice(0)) probe.close();
    token?.close();
    await host?.close();
    await dirs?.cleanup();
  });
  const execute = async (body: string) => {
    const result = path.join(dirs.workspace, "result.json");
    const p = token.launchProbe(
      {
        executable,
        args: [
          "-e",
          `const fs=require('fs');const attempt=f=>{try{f();return 'ALLOWED'}catch(e){return e.code}};const r=(${body});fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(r));`,
        ],
        cwd: dirs.workspace,
        env: {
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          PATH: dirs.workspace,
          TEMP: dirs.workspace,
          TMP: dirs.workspace,
        },
      },
      jobs.createKillOnCloseJob(),
    );
    probes.push(p);
    await waitFor(() => p.exitCode() !== null, 10000);
    expect(p.exitCode()).toBe(0);
    return JSON.parse(await readFile(result, "utf8"));
  };
  it("write restriction preserves owner-project reads but alone DOES NOT protect owner-only secrets", async () => {
    expect(token.fileDaclAccess(project).readData).toBe(true);
    expect(token.fileDaclAccess(secret).readData).toBe(true);
    const r = await execute(
      `{project:attempt(()=>fs.readFileSync(${JSON.stringify(project)})),secret:attempt(()=>fs.readFileSync(${JSON.stringify(secret)}))}`,
    );
    expect(r).toEqual({ project: "ALLOWED", secret: "ALLOWED" });
    // Expected exposure is evidence against accepting WRITE_RESTRICTED alone.
  });
  it("low IL + medium NO_READ_UP denies secret reads while retaining project reads and low fixture writes", async () => {
    label(dirs.workspace, "low-write");
    label(secret, "medium-no-read");
    token.lowerProbeIntegrity();
    // DACL-only AccessCheck cannot establish or refute the MIC boundary.
    expect(token.fileDaclAccess(secret).readData).toBe(true);
    const r = await execute(
      `{project:attempt(()=>fs.readFileSync(${JSON.stringify(project)})),read:attempt(()=>fs.readFileSync(${JSON.stringify(secret)})),write:attempt(()=>fs.writeFileSync(${JSON.stringify(secret)},'changed')),remove:attempt(()=>fs.unlinkSync(${JSON.stringify(secret)})),projectWrite:attempt(()=>fs.writeFileSync(${JSON.stringify(project)},'changed'))}`,
    );
    expect(r.project).toBe("ALLOWED");
    for (const key of ["read", "write", "remove", "projectWrite"]) expect(["EACCES", "EPERM"]).toContain(r[key]);
    expect(await readFile(secret, "utf8")).toBe("owner-content");
    expect(await readFile(project, "utf8")).toBe("owner-content");
  });
  it("documents the workspace gap: low IL cannot write an ordinary medium workspace without mediation", async () => {
    // Results use a separate low disposable directory, not the medium workspace.
    const output = path.join(dirs.workspace, "low-output");
    await mkdir(output);
    label(output, "low-write");
    label(secret, "medium-no-read");
    token.lowerProbeIntegrity();
    const result = path.join(output, "gap.json");
    const target = path.join(dirs.workspace, "must-not-write.txt");
    const script = `const fs=require('fs');let outcome;try{fs.writeFileSync(${JSON.stringify(target)},'bad');outcome='ALLOWED'}catch(e){outcome=e.code}fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({outcome}));`;
    const p = token.launchProbe(
      {
        executable,
        args: ["-e", script],
        cwd: dirs.workspace,
        env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: output, TMP: output },
      },
      jobs.createKillOnCloseJob(),
    );
    probes.push(p);
    await waitFor(() => p.exitCode() !== null, 10000);
    expect(p.exitCode()).toBe(0);
    expect(["EACCES", "EPERM"]).toContain(JSON.parse(await readFile(result, "utf8")).outcome);
  });
});

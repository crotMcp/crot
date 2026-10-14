import { randomBytes } from "node:crypto";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeHost } from "../../../src/native-host/native-host.js";
import { currentUserSid, runTool, windowsTools } from "../../../src/native-host/windows-acl.js";
import { loadJobObjectApi, type JobObject, type JobObjectApi } from "../../../src/native-host/windows-job.js";
import { loadRestrictedTokens, type RestrictedToken } from "../../../src/native-host/windows-l1/restricted-token.js";
import type { ProbeProcess, ProbeSpec } from "../../../src/native-host/windows-l1/probe-process.js";
import { isAlive, isWindows, makeTempDirs, waitFor, type TempDirs } from "../../helpers.js";

const GRANT_FIXTURE = `
$ErrorActionPreference = 'Stop'
$p = $env:CROT_TOKEN_FIXTURE
$acl = [System.IO.Directory]::GetAccessControl($p)
$sid = [System.Security.Principal.SecurityIdentifier]::new($env:CROT_TOKEN_RESTRICTING_SID)
$flags = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::Modify, $flags, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($p, $acl)
`;
if (process.env.CROT_WINDOWS_TOKEN_REQUIRED === "1" && (!isWindows || !["x64", "arm64"].includes(process.arch)))
  throw new Error("Required native Windows process probe cannot run on this platform/architecture.");

describe.runIf(isWindows)("Windows L1 spike: actual suspended restricted child and descendants (not full L1)", () => {
  let dirs: TempDirs;
  let host: NativeHost;
  let token: RestrictedToken;
  let jobs: JobObjectApi;
  let executable: string;
  let protectedDir: string;
  let secret: string;
  const probes: ProbeProcess[] = [];
  beforeEach(async () => {
    dirs = await makeTempDirs();
    host = await NativeHost.start({ startupPath: "inherited", jobObjects: false });
    jobs = await loadJobObjectApi();
    const random = randomBytes(16);
    const uniqueSid = `S-1-5-21-${random.readUInt32LE(0)}-${random.readUInt32LE(4)}-${random.readUInt32LE(8)}-${random.readUInt32LE(12)}`;
    const tools = windowsTools(process.env.SystemRoot ?? "C:\\Windows");
    // Trusted fixture identity, not remote policy input. Logon SID enables the
    // session BaseNamedObjects path; IPC isolation is explicitly not proven.
    const logonSid = (
      await runTool(
        tools.powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[System.Security.Principal.WindowsIdentity]::GetCurrent().Groups | Where-Object { $_.Value -match '^S-1-5-5-\\d+-\\d+$' } | ForEach-Object { $_.Value }",
        ],
        host.platform.baseEnvironment,
      )
    ).trim();
    expect(logonSid).toMatch(/^S-1-5-5-\d+-\d+$/);
    token = (await loadRestrictedTokens()).create(uniqueSid, true, logonSid);
    token.prepareProbeObjects(await currentUserSid(windowsTools(process.env.SystemRoot ?? "C:\\Windows")));
    protectedDir = path.join(dirs.outside, "protected");
    await host.platform.privateFiles.ensureDirectory(protectedDir);
    secret = path.join(protectedDir, "secret.txt");
    await writeFile(secret, "canary-only");
    // Grants affect only this disposable workspace, never the installed Node executable.
    await runTool(
      windowsTools(process.env.SystemRoot ?? "C:\\Windows").powershell,
      ["-NoProfile", "-NonInteractive", "-Command", GRANT_FIXTURE],
      {
        ...host.platform.baseEnvironment,
        CROT_TOKEN_FIXTURE: dirs.workspace,
        CROT_TOKEN_RESTRICTING_SID: token.restrictingSid,
      },
    );
    executable = path.join(dirs.workspace, "node probe.exe");
    await copyFile(process.execPath, executable);
    expect(token.fileDaclAccess(executable).readData).toBe(true);
  });
  afterEach(async () => {
    for (const p of probes.splice(0)) p.close();
    token?.close();
    await host?.close();
    await dirs?.cleanup();
  });
  const spec = (script: string, args: string[] = []): ProbeSpec => ({
    executable,
    args: ["-e", script, "--", ...args],
    cwd: dirs.workspace,
    env: {
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      PATH: dirs.workspace,
      TEMP: dirs.workspace,
      TMP: dirs.workspace,
    },
  });
  const launch = (script: string, args: string[] = []) => {
    const p = token.launchProbe(spec(script, args), jobs.createKillOnCloseJob());
    probes.push(p);
    return p;
  };
  it("runs allowed workspace code but actual secret read/write and outside creation are denied", async () => {
    const result = path.join(dirs.workspace, "result.json");
    const outside = path.join(protectedDir, "outside-write.txt");
    const script = `const fs=require('fs');const attempt=f=>{try{f();return 'ALLOWED'}catch(e){return e.code}};const r={read:attempt(()=>fs.readFileSync(${JSON.stringify(secret)})),write:attempt(()=>fs.writeFileSync(${JSON.stringify(secret)},'changed')),outside:attempt(()=>fs.writeFileSync(${JSON.stringify(outside)},'bad')),arch:process.arch};fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(r));`;
    const p = launch(script);
    await waitFor(() => p.exitCode() !== null, 10000);
    expect(p.exitCode()).toBe(0);
    const r = JSON.parse(await readFile(result, "utf8"));
    for (const key of ["read", "write", "outside"]) expect(["EACCES", "EPERM"]).toContain(r[key]);
    expect(r.arch).toBe(process.arch);
    expect(await readFile(secret, "utf8")).toBe("canary-only");
    expect(await stat(outside).catch(() => undefined)).toBeUndefined();
  });
  it("quotes executable/argv and passes only the explicit child environment", async () => {
    const result = path.join(dirs.workspace, "argv.json");
    const args = ["a b", 'a"b', "trailing\\", "", "Юникод", "%PATH%&echo"];
    const old = process.env.CROT_SPIKE_PARENT_ONLY;
    process.env.CROT_SPIKE_PARENT_ONLY = "not-for-child";
    try {
      const p = launch(
        `require('fs').writeFileSync(${JSON.stringify(result)},JSON.stringify({args:process.argv.slice(1),leak:process.env.CROT_SPIKE_PARENT_ONLY??null}));`,
        args,
      );
      await waitFor(() => p.exitCode() !== null, 10000);
      expect(p.exitCode()).toBe(0);
      expect(JSON.parse(await readFile(result, "utf8"))).toEqual({ args, leak: null });
    } finally {
      if (old === undefined) delete process.env.CROT_SPIKE_PARENT_ONLY;
      else process.env.CROT_SPIKE_PARENT_ONLY = old;
    }
  });
  it("does not execute user code when Job assignment fails; destroys the suspended process", async () => {
    const marker = path.join(dirs.workspace, "must-not-run");
    const real = jobs.createKillOnCloseJob();
    let pid = 0;
    const rejected: JobObject = {
      get closed() {
        return real.closed;
      },
      assign: (n) => {
        pid = n;
        return false;
      },
      accounting: () => real.accounting(),
      activeProcessCount: () => real.activeProcessCount(),
      terminate: (code) => real.terminate(code),
      close: () => real.close(),
    };
    expect(() =>
      token.launchProbe(spec(`require('fs').writeFileSync(${JSON.stringify(marker)},'ran');`), rejected),
    ).toThrow(/Job assignment/);
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => !isAlive(pid));
    expect(real.closed).toBe(true);
    expect(await stat(marker).catch(() => undefined)).toBeUndefined();
  });
  it("grandchildren inherit restrictions and Job close cleans detached descendants after parent exit", async () => {
    const result = path.join(dirs.workspace, "grandchild.json");
    const gc = `const fs=require('fs');let read;try{fs.readFileSync(${JSON.stringify(secret)});read='ALLOWED'}catch(e){read=e.code}fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({pid:process.pid,read}));setInterval(()=>{},1000);`;
    const parent = `const fs=require('fs');require('child_process').spawn(process.execPath,['-e',${JSON.stringify(gc)}],{stdio:'ignore',detached:true}).unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(result)})){clearInterval(t);process.exit(0)}},20);`;
    const p = launch(parent);
    await waitFor(async () => (await readFile(result, "utf8").catch(() => "")).length > 0, 10000);
    const r = JSON.parse(await readFile(result, "utf8"));
    expect(["EACCES", "EPERM"]).toContain(r.read);
    await waitFor(() => p.exitCode() !== null, 10000);
    expect(p.exitCode()).toBe(0);
    expect(isAlive(r.pid)).toBe(true);
    p.close();
    await waitFor(() => !isAlive(r.pid));
  });
  it("reports a nonzero native exit code", async () => {
    const p = launch("process.exit(17)");
    await waitFor(() => p.exitCode() !== null, 10000);
    expect(p.exitCode()).toBe(17);
  });
});

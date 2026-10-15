/** Mandatory native unique-SID component gate, not full filesystem acceptance. */
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { startOwnedLoaderTrace, type OwnedLoaderTrace } from "./diagnostics/owned-loader.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, inject } from "vitest";
import { NativeHost } from "../../../src/native-host/native-host.js";
import { currentUserSid, runTool, windowsTools } from "../../../src/native-host/windows-acl.js";
import { loadJobObjectApi } from "../../../src/native-host/windows-job.js";
import { loadRestrictedTokens, type RestrictedToken } from "../../../src/native-host/windows-l1/restricted-token.js";
import { createCommandToken } from "../../../src/native-host/windows-l1/command-token.js";
import { loadProbeIntegrity } from "../../../src/native-host/windows-l1/probe-integrity.js";
import { loadBytePipeApi } from "../../../src/native-host/windows-l1/byte-stdio.js";
import { WindowsLaunchEnvironment } from "../../../src/native-host/windows-l1/launch-environment.js";
import { NativeProcessLauncher } from "../../../src/native-host/windows-l1/native-process.js";
import { isWindows, makeTempDirs, type TempDirs } from "../../helpers.js";
const GRANT = `
$ErrorActionPreference='Stop'
$p=$env:CROT_OWNED_WRITE_ROOT
$acl=[System.IO.Directory]::GetAccessControl($p)
$sid=[System.Security.Principal.SecurityIdentifier]::new($env:CROT_WRITE_FILTER_SID)
$flags=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::Modify,$flags,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($p,$acl)
`;
describe.runIf(isWindows)("Windows unique write-filter component — real global Low denial", () => {
  let dirs: TempDirs, host: NativeHost, token: RestrictedToken, launcher: NativeProcessLauncher;
  let privateRoot: string, outside: string, project: string;
  beforeEach(async () => {
    dirs = await makeTempDirs();
    host = await NativeHost.start({ startupPath: "inherited", jobObjects: false });
    const tools = windowsTools(process.env.SystemRoot ?? "C:\\Windows");
    const ownerSid = await currentUserSid(tools);
    token = createCommandToken(await loadRestrictedTokens(), ownerSid);
    privateRoot = path.join(dirs.outside, "new-crot-owned");
    outside = path.join(dirs.outside, "unapproved-low");
    await mkdir(privateRoot);
    await mkdir(outside);
    const label = await loadProbeIntegrity();
    label(privateRoot, "low-write");
    label(outside, "low-write");
    // Only a newly created CROT-owned fixture receives the unique SID grant.
    // The actual Medium workspace and the unrelated Low root receive no grant.
    await runTool(tools.powershell, ["-NoProfile", "-NonInteractive", "-Command", GRANT], {
      ...host.platform.baseEnvironment,
      CROT_OWNED_WRITE_ROOT: privateRoot,
      CROT_WRITE_FILTER_SID: token.restrictingSid,
    });
    project = path.join(dirs.workspace, "owner-only-project.txt");
    await writeFile(project, "project control");
    await host.platform.privateFiles.protectFile!(project);
    const target = path.join(outside, "target.txt");
    await writeFile(target, "unchanged");
    // Working same-owner trusted controls, not a startup failure called denial.
    await writeFile(path.join(outside, "create-control.txt"), "control");
    await writeFile(target, "trusted write control");
    await writeFile(target, "unchanged");
    const childEnvironment = new WindowsLaunchEnvironment({
      systemRoot: process.env.SystemRoot ?? "C:\\Windows",
      privateRoot,
      runtimeBins: [path.dirname(process.execPath)],
    });
    for (const dir of Object.values(childEnvironment.directories)) await mkdir(dir, { recursive: true });
    launcher = new NativeProcessLauncher({
      token,
      ownerSid,
      pipes: await loadBytePipeApi(),
      jobs: await loadJobObjectApi(),
      environment: host.platform.environment,
      resolver: host.platform.launcher,
      childEnvironment,
    });
  });
  afterEach(async () => {
    await launcher?.close();
    token?.close();
    await host?.close();
    await dirs?.cleanup();
  });
  const body = () =>
    `const fs=require('fs');const attempt=f=>{try{f();return 'ALLOWED'}catch(e){return e.code}};const r={ready:true,project:attempt(()=>fs.readFileSync(${JSON.stringify(project)})),privateWrite:attempt(()=>fs.writeFileSync(${JSON.stringify(path.join(privateRoot, "allowed.txt"))},'allowed')),outsideCreate:attempt(()=>fs.writeFileSync(${JSON.stringify(path.join(outside, "forbidden.txt"))},'forbidden')),outsideWrite:attempt(()=>fs.writeFileSync(${JSON.stringify(path.join(outside, "target.txt"))},'forbidden'))};process.stdout.write(JSON.stringify(r));`;
  async function run(script: string) {
    const child = await launcher.launch(
      { file: process.execPath, args: ["-e", script], display: "unique write boundary gate" },
      { cwd: dirs.workspace, env: {}, stdin: false },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const timeout = setTimeout(() => {
      void child.terminate("force");
    }, 10000);
    try {
      const status = await child.exited;
      const ended = (stream: typeof child.stdout) =>
        new Promise<void>((resolve) => {
          if (stream.readableEnded || stream.destroyed) return resolve();
          stream.once("end", resolve);
          stream.once("close", resolve);
        });
      await Promise.all([ended(child.stdout), ended(child.stderr)]);
      expect(child.failure).toBeUndefined();
      expect({ code: status.code, stderrEmpty: errors.length === 0 }).toEqual({ code: 0, stderrEmpty: true });
      return JSON.parse(output) as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
      await child.terminate("force");
    }
  }
  const verify = async (observed: Record<string, unknown>) => {
    expect(observed.ready).toBe(true);
    expect(observed.project).toBe("ALLOWED");
    expect(observed.privateWrite).toBe("ALLOWED");
    for (const key of ["outsideCreate", "outsideWrite"]) expect(["EPERM", "EACCES"]).toContain(observed[key]);
    expect(await readFile(path.join(privateRoot, "allowed.txt"), "utf8")).toBe("allowed");
    expect(await readFile(path.join(outside, "target.txt"), "utf8")).toBe("unchanged");
  };
  it("traces the exact owned unique-token loader before JS (diagnosis is not a denial proof)", async () => {
    const ffi = createRequire(import.meta.url)("koffi");
    let trace: OwnedLoaderTrace | undefined;
    const jobs = await loadJobObjectApi();
    const environment = new WindowsLaunchEnvironment({
      systemRoot: process.env.SystemRoot ?? "C:\\Windows",
      privateRoot,
      runtimeBins: [path.dirname(process.execPath)],
    });
    const child = token.launchProbe(
      {
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: dirs.workspace,
        env: environment.prepare({}),
        stdio: "nul",
        diagnostics: {
          debugOnlyThisProcess: true,
          beforeResume: (pid) => {
            trace = startOwnedLoaderTrace(ffi, pid);
          },
        },
      },
      jobs.createKillOnCloseJob(),
    );
    try {
      const observation = await trace!.collect();
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({ title: "CROT-6A-unique-token-loader", value: observation }) + "\n",
      );
      expect(observation.exited).toBe(true);
      expect(observation.exitCode).toBe(0);
    } finally {
      trace?.close();
      child.close();
    }
  }, 25000);
  it("runs ordinary Node APIs with owner-project reads, private writes and unrelated Low denial", async () => {
    await verify(await run(body()));
  });
  it.each([false, true])(
    "retains that boundary in an actually ready Node descendant (windowsHide=%s)",
    async (windowsHide) => {
      const script = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(body())}],{windowsHide:${windowsHide},stdio:['pipe','pipe','pipe']});c.stdin.end();c.stdout.pipe(process.stdout);c.stderr.pipe(process.stderr);c.on('error',e=>{console.log(JSON.stringify({spawnError:e.code}));process.exitCode=99});c.on('exit',code=>{process.exitCode=code});`;
      await verify(await run(script));
    },
  );
});

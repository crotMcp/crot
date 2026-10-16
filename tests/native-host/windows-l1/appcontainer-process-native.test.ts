/** Selected AppContainer launch primitive + existing ProcessLauncher; not full L1 availability. */
import { appendFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { bindNpfsRootQualification } from "../../../src/native-host/windows-l1/npfs-root.js";
import { NativeHost } from "../../../src/native-host/native-host.js";
import { currentUserSid, runTool, windowsTools } from "../../../src/native-host/windows-acl.js";
import { loadJobObjectApi } from "../../../src/native-host/windows-job.js";
import {
  loadAppContainerProfiles,
  type AppContainerProfile,
} from "../../../src/native-host/windows-l1/appcontainer-profile.js";
import { bindAppContainerProcessIdentity } from "../../../src/native-host/windows-l1/appcontainer-process.js";
import { NativeProcessLauncher } from "../../../src/native-host/windows-l1/native-process.js";
import { loadBytePipeApi, quarantinedStdioOperations } from "../../../src/native-host/windows-l1/byte-stdio.js";
import { WindowsLaunchEnvironment } from "../../../src/native-host/windows-l1/launch-environment.js";
import { createServicePrivateFiles } from "../../../src/service/private-files.js";
import { isAlive, isWindows, makeTempDirs, waitFor, type TempDirs } from "../../helpers.js";
import type { ManagedProcess } from "../../../src/core/platform/types.js";
const grantFixture = `
$ErrorActionPreference='Stop'
$sid=[System.Security.Principal.SecurityIdentifier]::new($env:CROT_APPC_TEST_SID)
foreach($p in @($env:CROT_APPC_TEST_WORKSPACE,$env:CROT_APPC_TEST_PRIVATE)) {
 $acl=[System.IO.Directory]::GetAccessControl($p)
 $flags=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
 $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::Modify,$flags,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
 $acl.AddAccessRule($rule)
 [System.IO.Directory]::SetAccessControl($p,$acl)
}
`;
const bytes = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
describe.runIf(isWindows)("Windows AppContainer verified launch through NativeProcessLauncher", () => {
  let dirs: TempDirs, profile: AppContainerProfile, launcher: NativeProcessLauncher, host: NativeHost;
  let executable: string, secret: string;
  const children = new Set<ManagedProcess>();
  beforeEach(async () => {
    dirs = await makeTempDirs();
    profile = (await loadAppContainerProfiles()).create();
    host = await NativeHost.start({ startupPath: "inherited", jobObjects: false });
    const privateRoot = path.join(dirs.outside, "private-runtime");
    const environment = new WindowsLaunchEnvironment({
      systemRoot: process.env.SystemRoot ?? "C:\\Windows",
      privateRoot,
      runtimeBins: [path.join(privateRoot, "cache")],
    });
    for (const p of Object.values(environment.directories)) await mkdir(p, { recursive: true });
    executable = path.join(environment.directories.cache, "node.exe");
    await copyFile(process.execPath, executable);
    secret = path.join(dirs.outside, "actual-protected-canary.txt");
    await writeFile(secret, "");
    await createServicePrivateFiles(true, [profile.sid]).protectFile!(secret);
    await writeFile(secret, "canary");
    const tools = windowsTools(process.env.SystemRoot ?? "C:\\Windows");
    // Explicit test-host preparation, never implicit production elevation.
    await runTool(tools.powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.resolve("scripts/l1-install-win.ps1"),
      "-Apply",
    ]);
    // Disposable component fixtures ONLY. No ancestor/user-tree ACL mutation.
    await runTool(tools.powershell, ["-NoProfile", "-NonInteractive", "-Command", grantFixture], {
      ...host.platform.baseEnvironment,
      CROT_APPC_TEST_SID: profile.sid,
      CROT_APPC_TEST_WORKSPACE: dirs.workspace,
      CROT_APPC_TEST_PRIVATE: privateRoot,
    });
    const imported = await import("koffi");
    const ffi = imported.default ?? imported;
    const dll = (n: string) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", n);
    const ownerSid = await currentUserSid(tools);
    launcher = new NativeProcessLauncher({
      token: bindAppContainerProcessIdentity(
        ffi,
        { advapi32: dll("advapi32.dll"), kernel32: dll("kernel32.dll") },
        profile,
        ownerSid,
      ),
      ownerSid,
      pipes: await loadBytePipeApi(),
      jobs: await loadJobObjectApi(),
      environment: host.platform.environment,
      childEnvironment: environment,
      resolver: host.platform.launcher,
    });
  }, 120000);
  afterEach(async () => {
    try {
      await launcher?.close();
      expect(quarantinedStdioOperations()).toBe(0);
      profile?.close();
    } finally {
      await host?.close();
      await dirs?.cleanup();
      children.clear();
    }
  }, 30000);
  const launch = async (body: string, stdin = false, args: string[] = []) => {
    const p = await launcher.launch(
      { file: executable, args: ["-e", body, "--", ...args], display: "AppContainer native launch qualification" },
      { cwd: dirs.workspace, env: {}, stdin },
    );
    children.add(p);
    return p;
  };
  it("transports binary stdin/stdout/stderr, Unicode argv and real exit without a restricted-token fallback", async () => {
    const p = await launch(
      "const a=[];process.stdin.on('data',b=>a.push(b));process.stdin.on('end',()=>{if(process.argv[1]!=='юникод space')process.exit(71);process.stderr.write(Buffer.alloc(262144,0xfd));process.stdout.write(Buffer.concat(a),()=>process.exit(23))})",
      true,
      ["юникод space"],
    );
    const output = bytes(p.stdout),
      error = bytes(p.stderr),
      input = Buffer.alloc(1048576, 0xfe);
    p.stdin!.end(input);
    const [exit, out, err] = await Promise.all([p.exited, output, error]);
    expect(exit.code).toBe(23);
    expect(out.equals(input)).toBe(true);
    expect(err.equals(Buffer.alloc(262144, 0xfd))).toBe(true);
    await p.terminate("force");
    appendFileSync(
      inject("stage6aEvidence"),
      JSON.stringify({
        title: "CROT-6A-appcontainer-native-launcher",
        value: {
          ready: true,
          exitCode: 23,
          stdinStdoutBytes: out.length,
          stderrBytes: err.length,
          unicodeArgv: true,
          treeClosed: true,
        },
      }) + "\n",
    );
  }, 30000);
  it("denies read/write of a real protected file and outside writes after a ready Node startup", async () => {
    const target = path.join(dirs.outside, "forbidden.txt");
    const p = await launch(
      `const f=require('fs');const a=op=>{try{op();return 'ALLOWED'}catch(e){return e.code}};process.stdout.write(JSON.stringify({ready:true,read:a(()=>f.readFileSync(${JSON.stringify(secret)})),write:a(()=>f.writeFileSync(${JSON.stringify(secret)},'bad')),outside:a(()=>f.writeFileSync(${JSON.stringify(target)},'bad'))}));`,
    );
    const [exit, out, err] = await Promise.all([p.exited, bytes(p.stdout), bytes(p.stderr)]);
    expect(exit.code).toBe(0);
    expect(err.length).toBe(0);
    const result = JSON.parse(out.toString());
    expect(result.ready).toBe(true);
    for (const key of ["read", "write", "outside"]) expect(["EPERM", "EACCES"]).toContain(result[key]);
    expect(await readFile(secret, "utf8")).toBe("canary");
    await p.terminate("force");
    appendFileSync(
      inject("stage6aEvidence"),
      JSON.stringify({ title: "CROT-6A-appcontainer-native-launcher-denials", value: result }) + "\n",
    );
  }, 30000);
  it("ends a detached descendant and retains profile ownership until the complete Job drains", async () => {
    const imported = await import("koffi"),
      ffi = imported.default ?? imported;
    const dll = (name: string) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
    let lease: ReturnType<ReturnType<typeof bindNpfsRootQualification>> | undefined;
    try {
      lease = bindNpfsRootQualification(ffi, { kernel32: dll("kernel32.dll"), advapi32: dll("advapi32.dll") })(
        profile.sid,
      );
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-6A-npfs-root-grant",
          value: { mask: lease.mask, inherited: false, sid: profile.sid },
        }) + "\n",
      );
      const trace = path.join(dirs.workspace, "descendant-trace.jsonl");
      const record = `const record=v=>require('fs').appendFileSync(${JSON.stringify(trace)},JSON.stringify(v)+'\\n');`;
      const descendant =
        record +
        "record({step:'child-start',pid:process.pid});process.stdout.write('READY:'+process.pid+'\\n');setInterval(()=>{},1000)";
      const p = await launch(
        `${record}record({step:'parent-start'});const cp=require('child_process');record({step:'before-spawn'});const c=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','pipe','ignore']});record({step:'after-spawn',pid:c.pid});c.on('spawn',()=>record({step:'spawn-event',pid:c.pid}));let ready=false;c.stdout.once('data',b=>{ready=true;process.stdout.write(b,()=>process.exit(23))});c.on('error',e=>{process.stderr.write('CHILD_ERROR:'+e.code+'\\n');process.exitCode=71});c.on('exit',(code,signal)=>{if(!ready){process.stderr.write('CHILD_EARLY_EXIT:'+JSON.stringify({code,signal})+'\\n');process.exitCode=72}});`,
      );
      // A live descendant may retain an inherited stream. Do not wait for
      // stream EOF before terminating that very descendant (circular wait).
      let output = "",
        errors = "";
      p.stdout.on("data", (data: Buffer) => {
        output += data.toString();
      });
      p.stderr.on("data", (data: Buffer) => {
        errors += data.toString();
      });
      try {
        await waitFor(() => /READY:[0-9]+\n/.test(output) && p.hasExited, 10000);
      } catch (error) {
        appendFileSync(
          inject("stage6aEvidence"),
          JSON.stringify({
            title: "CROT-6A-appcontainer-native-launcher-descendant-failure",
            value: {
              parentHasExited: p.hasExited,
              parentExit: p.hasExited ? (await p.exited).code : null,
              stdout: output,
              stderr: errors,
              transportFailure: p.failure?.message ?? null,
              trace: await readFile(trace, "utf8").catch((e) => "TRACE_READ_ERROR:" + e.code),
            },
          }) + "\n",
        );
        throw error;
      }
      expect((await p.exited).code).toBe(23);
      expect(errors).toBe("");
      const pid = Number(/READY:([0-9]+)/.exec(output)?.[1]);
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(isAlive(pid)).toBe(true);
      expect(() => profile.close()).toThrow(/still owns actors/);
      await p.terminate("force");
      await waitFor(() => !isAlive(pid), 5000);
      profile.close();
      expect(profile.closed).toBe(true);
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-6A-appcontainer-native-launcher-descendant",
          value: {
            ready: true,
            parentExit: 23,
            descendantReady: true,
            profileHeldUntilJobDrain: true,
            descendantTerminated: true,
            profileClosed: true,
          },
        }) + "\n",
      );
    } catch (error) {
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-6A-npfs-root-failure",
          value: { message: String(error), details: (error as { details?: unknown }).details },
        }) + "\n",
      );
      throw error;
    } finally {
      // Even on failed spawn, stop/drain the complete Job BEFORE touching NPFS.
      await launcher.close();
      lease?.close();
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({ title: "CROT-6A-npfs-root-restored", value: { exact: Boolean(lease) } }) + "\n",
      );
    }
  }, 30000);
});

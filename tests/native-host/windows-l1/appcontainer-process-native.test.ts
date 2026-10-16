/** Selected AppContainer launch primitive + existing ProcessLauncher; not full L1 availability. */
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { once } from "node:events";
import { CrotService } from "../../../src/service/service.js";
import { ControlClient } from "../../../src/service/control-client.js";
import { openSecretStore, generateSecret } from "../../../src/service/secrets/store.js";
import { secretFile } from "../../../src/service/secrets/backends.js";
import { secretCredentialStore, serviceEndpoint } from "../../../src/service/endpoints.js";
import { openAppContainerNetwork, type AppContainerNetworkLease } from "../../../src/native-host/windows-l1/network.js";
import { loadAppContainerNetworkNative } from "../../../src/native-host/windows-l1/network-native.js";
import type { LeaseJournalStore } from "../../../src/native-host/windows-l1/lease-journal.js";
import { appendFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { bindLocalPipeShim, type LocalPipeShim } from "../../../src/native-host/windows-l1/local-shim.js";
import { buildLocalShimFixture } from "./diagnostics/local-shim-build.js";
import { openLeaseJournalStore } from "../../../src/native-host/windows-l1/lease-journal.js";
import { loadWindowsLeaseLock } from "../../../src/native-host/windows-l1/lease-lock.js";
import { leasePlan } from "./lease-fixture.js";
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
$p=$env:CROT_APPC_TEST_COMPAT
$acl=[System.IO.Directory]::GetAccessControl($p)
$flags=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,$flags,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow))
[System.IO.Directory]::SetAccessControl($p,$acl)
`;
const bytes = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
describe.runIf(isWindows)("Windows AppContainer verified launch through NativeProcessLauncher", () => {
  let dirs: TempDirs, profile: AppContainerProfile, launcher: NativeProcessLauncher, host: NativeHost;
  let executable: string, secret: string;
  let localShim: LocalPipeShim | undefined;
  let buildLauncher: (network?: AppContainerNetworkLease) => Promise<NativeProcessLauncher>;
  let networkLease: AppContainerNetworkLease | undefined, networkStore: LeaseJournalStore | undefined;
  const children = new Set<ManagedProcess>();
  let shimBuild: Awaited<ReturnType<typeof buildLocalShimFixture>>, shimLibrary: string;
  beforeAll(async () => {
    shimBuild = await buildLocalShimFixture();
  }, 150000);
  afterAll(async () => {
    await shimBuild?.cleanup();
  });
  beforeEach(async () => {
    dirs = await makeTempDirs();
    profile = (await loadAppContainerProfiles()).create();
    host = await NativeHost.start({ startupPath: "inherited", jobObjects: false });
    const privateRoot = path.join(dirs.outside, "private-runtime");
    const compat = path.join(dirs.outside, "local-compat");
    await mkdir(compat);
    shimLibrary = path.join(compat, "crot-local-shim.dll");
    await copyFile(shimBuild.library, shimLibrary);
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
      CROT_APPC_TEST_COMPAT: compat,
    });
    const imported = await import("koffi");
    const ffi = imported.default ?? imported;
    const dll = (n: string) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", n);
    const ownerSid = await currentUserSid(tools);
    localShim = bindLocalPipeShim(ffi, shimLibrary);
    buildLauncher = async (network) =>
      new NativeProcessLauncher({
        token: bindAppContainerProcessIdentity(
          ffi,
          { advapi32: dll("advapi32.dll"), kernel32: dll("kernel32.dll") },
          profile,
          ownerSid,
          localShim,
          network,
        ),
        ownerSid,
        pipes: await loadBytePipeApi(),
        jobs: await loadJobObjectApi(),
        environment: host.platform.environment,
        childEnvironment: environment,
        resolver: host.platform.launcher,
      });
    launcher = await buildLauncher();
  }, 120000);
  afterEach(async () => {
    try {
      await launcher?.close();
      expect(quarantinedStdioOperations()).toBe(0);
      localShim?.close();
      localShim = undefined;
      await networkLease?.close();
      networkLease = undefined;
      await networkStore?.close();
      networkStore = undefined;
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
      `const f=require('fs');const a=op=>{try{op();return 'ALLOWED'}catch(e){return e.code}};process.stdout.write(JSON.stringify({ready:true,read:a(()=>f.readFileSync(${JSON.stringify(secret)})),write:a(()=>f.writeFileSync(${JSON.stringify(secret)},'bad')),outside:a(()=>f.writeFileSync(${JSON.stringify(target)},'bad')),shimWrite:a(()=>{const h=f.openSync(${JSON.stringify(shimLibrary)},'r+');f.closeSync(h)})}));`,
    );
    const [exit, out, err] = await Promise.all([p.exited, bytes(p.stdout), bytes(p.stderr)]);
    expect(exit.code).toBe(0);
    expect(err.length).toBe(0);
    const result = JSON.parse(out.toString());
    expect(result.ready).toBe(true);
    for (const key of ["read", "write", "outside", "shimWrite"]) expect(["EPERM", "EACCES"]).toContain(result[key]);
    expect(await readFile(secret, "utf8")).toBe("canary");
    await p.terminate("force");
    appendFileSync(
      inject("stage6aEvidence"),
      JSON.stringify({ title: "CROT-6A-appcontainer-native-launcher-denials", value: result }) + "\n",
    );
  }, 30000);
  it("denies read/write of the flushed lease WAL with real AppContainer EPERM", async () => {
    const directory = path.join(dirs.outside, "private-lease-journal");
    const store = await openLeaseJournalStore({
      directory,
      privateFiles: createServicePrivateFiles(true, [profile.sid]),
      lock: await loadWindowsLeaseLock(),
    });
    try {
      // Synthetic transaction bytes qualify WAL isolation, NOT ACL recovery.
      const plan = leasePlan();
      await store.create(plan);
      const file = path.join(directory, `lease-${plan.id}.wal`),
        before = await readFile(file);
      const p = await launch(
        `const f=require('fs');const op=fn=>{try{fn();return 'ALLOWED'}catch(e){return e.code}};process.stdout.write(JSON.stringify({ready:true,read:op(()=>f.readFileSync(${JSON.stringify(file)})),write:op(()=>f.writeFileSync(${JSON.stringify(file)},'bad'))}));`,
      );
      const [exit, out, err] = await Promise.all([p.exited, bytes(p.stdout), bytes(p.stderr)]);
      expect(exit.code).toBe(0);
      expect(err.length).toBe(0);
      const result = JSON.parse(out.toString());
      expect(result).toEqual({ ready: true, read: "EPERM", write: "EPERM" });
      expect(await readFile(file)).toEqual(before);
      await p.terminate("force");
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({ title: "CROT-6A-lease-WAL-denials", value: { ...result, unchanged: true } }) + "\n",
      );
    } finally {
      await store.close();
    }
  }, 30000);
  it.each(["off", "on"] as const)(
    "qualifies actual network=%s with owned loopback, HTTP auth and real CROT denials",
    async (mode) => {
      const nativeNetwork = await loadAppContainerNetworkNative();
      networkStore = await openLeaseJournalStore({
        directory: path.join(dirs.outside, "network-wal"),
        privateFiles: createServicePrivateFiles(true, [profile.sid]),
        lock: await loadWindowsLeaseLock(),
      });
      const plan = leasePlan(profile.name.slice("crot.l1.".length));
      plan.profile = { name: profile.name, sid: profile.sid };
      plan.workspace = dirs.workspace;
      plan.network = mode;
      // Synthetic SDs: this test qualifies networking, not full native recovery.
      await networkStore.create(plan);
      networkLease = await openAppContainerNetwork(profile, networkStore, nativeNetwork);
      await launcher.close();
      launcher = await buildLauncher(networkLease);
      const server = createServer((_request, response) => {
        response.end("NETWORK-READY");
      });
      server.listen(0, "0.0.0.0");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No owned TCP port");
      const lan = Object.values(networkInterfaces())
        .flat()
        .find((v) => v && v.family === "IPv4" && !v.internal)?.address;
      if (!lan) throw new Error("No LAN interface for qualification");
      let service: CrotService | undefined;
      let control: Awaited<ReturnType<typeof ControlClient.connect>>;
      try {
        // Owner controls prove host connectivity before accepting sandbox results.
        for (const host of ["127.0.0.1", lan]) {
          const r = await fetch(`http://${host}:${address.port}`, { signal: AbortSignal.timeout(10000) });
          expect(await r.text()).toBe("NETWORK-READY");
        }
        const stateDir = path.join(dirs.outside, "network-service-state");
        const privateFiles = createServicePrivateFiles(true, [profile.sid]);
        const started = await CrotService.start({
          command: {
            kind: "serve",
            config: {
              workspace: { root: dirs.workspace },
              environment: { path: "inherited" },
              secrets: { store: "file" },
              browser: { enabled: false },
              http: { enabled: true, port: 0 },
              audit: { sink: "file", path: path.join(stateDir, "audit.jsonl") },
            },
            warnings: [],
          },
          launch: "managed",
          stateDir,
          privateFiles,
          log: () => undefined,
          requestStop: () => undefined,
        });
        if (started === "already_running") throw new Error("Service collision");
        service = started;
        const store = await openSecretStore(stateDir, privateFiles);
        await store.write("device-key", generateSecret());
        control = await ControlClient.connect({ stateDir, privateFiles });
        if (!control) throw new Error("No actual owner control");
        await control.request("preset.set", { value: "require-approval" });
        const credential = await secretCredentialStore(stateDir, privateFiles).read("control");
        if (!credential || !service.httpUrl) throw new Error("Missing real service endpoint");
        const endpoint = serviceEndpoint(stateDir, "control", credential).path;
        const files = (["service-token", "control-token", "device-key", "http-token"] as const).map((n) =>
          secretFile(stateDir, n),
        );
        files.push(path.join(stateDir, "service-settings.json"), path.join(stateDir, "audit.jsonl"));
        const before = await Promise.all(files.map((f) => readFile(f)));
        const body = `
        const http=require('http'),https=require('https'),net=require('net'),fs=require('fs');
        const get=(url,headers={})=>new Promise(resolve=>{let done=false;const finish=v=>{if(!done){done=true;resolve(v)}};const r=(url.startsWith('https:')?https:http).get(url,{headers},s=>{s.resume();s.on('end',()=>finish({status:s.statusCode}))});r.on('error',e=>finish({error:e.code}));r.setTimeout(12000,()=>{r.destroy();finish({error:'TIMEOUT'})})});
        const op=f=>{try{f();return 'ALLOWED'}catch(e){return e.code}};
        (async()=>{const result={ready:true,mode:${JSON.stringify(mode)}};
        result.loopback=await get(${JSON.stringify(`http://127.0.0.1:${address.port}`)});
        result.lan=await get(${JSON.stringify(`http://${lan}:${address.port}`)});
        result.internet=await get('https://api.github.com/',{'User-Agent':'CROT-network-qualification'});
        result.httpNoToken=await get(${JSON.stringify(service.httpUrl)});
        result.httpWrongToken=await get(${JSON.stringify(service.httpUrl)},{Authorization:'Bearer deliberately-wrong-token'});
        result.reads=${JSON.stringify(files)}.map(f=>op(()=>fs.readFileSync(f)));
        result.writes=${JSON.stringify(files)}.map(f=>op(()=>{const h=fs.openSync(f,'r+');fs.closeSync(h)}));
        result.control=await new Promise(resolve=>{const c=net.connect(${JSON.stringify(endpoint)});c.on('error',e=>resolve(e.code));c.on('connect',()=>{c.destroy();resolve('ALLOWED')})});
        process.stdout.write(JSON.stringify(result));})().catch(e=>{process.stderr.write(e.stack);process.exit(70)});
      `;
        const p = await launch(body);
        const [exit, out, err] = await Promise.all([p.exited, bytes(p.stdout), bytes(p.stderr)]);
        expect(exit.code).toBe(0);
        expect(err.length).toBe(0);
        const result = JSON.parse(out.toString());
        appendFileSync(
          inject("stage6aEvidence"),
          JSON.stringify({ title: `CROT-6A-appcontainer-network-${mode}`, value: result }) + "\n",
        );
        expect(result.ready).toBe(true);
        for (const target of ["loopback", "lan", "internet"]) {
          if (mode === "on") expect(result[target].status).toBeGreaterThan(0);
          else expect(["EACCES", "EPERM"]).toContain(result[target].error);
        }
        if (mode === "on") {
          expect(result.httpNoToken.status).toBe(401);
          expect(result.httpWrongToken.status).toBe(401);
        } else {
          expect(["EACCES", "EPERM"]).toContain(result.httpNoToken.error);
        }
        expect(result.reads).toEqual(files.map(() => "EPERM"));
        expect(result.writes).toEqual(files.map(() => "EPERM"));
        expect(result.control).toBe("EPERM");
        expect(await Promise.all(files.map((f) => readFile(f)))).toEqual(before);
        expect(await control.request("ping")).toMatchObject({ state: "running" });
        await p.terminate("force");
        await launcher.close();
        await networkLease.close();
        expect(await nativeNetwork.contains(profile.sid)).toBe(false);
        networkLease = undefined;
        appendFileSync(
          inject("stage6aEvidence"),
          JSON.stringify({
            title: `CROT-6A-appcontainer-network-${mode}-cleanup`,
            value: { loopbackRemoved: true, serviceUnchanged: true, ownerAuthenticated: true },
          }) + "\n",
        );
      } finally {
        control?.close();
        await service?.shutdown("Network qualification end");
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    120000,
  );
  it("ends a detached descendant and retains profile ownership until the complete Job drains", async () => {
    const trace = path.join(dirs.workspace, "descendant-trace.jsonl");
    const record = `const record=v=>require('fs').appendFileSync(${JSON.stringify(trace)},JSON.stringify(v)+'\\n');`;
    const grandchild = "process.stdout.write('READY:'+process.pid+'\\n');setInterval(()=>{},1000)";
    const descendant =
      record +
      `record({step:'child-start',pid:process.pid});const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','pipe','ignore']});c.on('error',e=>{record({step:'grandchild-error',code:e.code});process.exit(74)});c.stdout.once('data',b=>process.stdout.write('READY:'+process.pid+':'+c.pid+'\\n'));setInterval(()=>{},1000)`;
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
      await waitFor(() => /READY:[0-9]+:[0-9]+\n/.test(output) && p.hasExited, 10000);
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
    const match = /READY:([0-9]+):([0-9]+)/.exec(output);
    const pid = Number(match?.[1]),
      grandchildPid = Number(match?.[2]);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(isAlive(pid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);
    expect(() => profile.close()).toThrow(/still owns actors/);
    await p.terminate("force");
    await waitFor(() => !isAlive(pid) && !isAlive(grandchildPid), 5000);
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
          grandchildTerminated: true,
          shimPropagatedAcrossTwoSpawns: true,
          profileClosed: true,
        },
      }) + "\n",
    );
  }, 30000);
});

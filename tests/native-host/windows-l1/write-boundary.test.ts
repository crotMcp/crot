/** Mandatory native unique-SID component gate, not full filesystem acceptance. */
import { appendFileSync, openSync, closeSync, readSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { snapshotWorkspaceDescriptor } from "./diagnostics/workspace-view-security.js";
import { buildWorkspaceViewFixture } from "./diagnostics/workspace-view-build.js";
import { ownedAccessStack } from "./diagnostics/owned-access-stack.js";
import { createRequire } from "node:module";
import { startOwnedLoaderTrace, type OwnedLoaderTrace } from "./diagnostics/owned-loader.js";
import { access, mkdir, readFile, rm, writeFile, link } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BnoIsolation } from "../../../src/native-host/windows-l1/bno-isolation.js";
import type { OwnedDesktop } from "../../../src/native-host/windows-l1/owned-desktop.js";
import { afterEach, beforeEach, describe, expect, it, inject } from "vitest";
import type { CommandSpec } from "../../../src/core/platform/types.js";
import type { NativeHost } from "../../../src/native-host/native-host.js";
import { currentUserSid, runTool, windowsTools } from "../../../src/native-host/windows-acl.js";
import type { loadJobObjectApi } from "../../../src/native-host/windows-job.js";
import type { loadRestrictedTokens, RestrictedToken } from "../../../src/native-host/windows-l1/restricted-token.js";
import { createCommandToken } from "../../../src/native-host/windows-l1/command-token.js";
import type { loadProbeIntegrity } from "../../../src/native-host/windows-l1/probe-integrity.js";
import type { loadBytePipeApi } from "../../../src/native-host/windows-l1/byte-stdio.js";
import { WindowsLaunchEnvironment } from "../../../src/native-host/windows-l1/launch-environment.js";
import type { NativeProcessLauncher } from "../../../src/native-host/windows-l1/native-process.js";
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
  let desktop: OwnedDesktop;
  let bnoIsolation: BnoIsolation;
  let native: {
    loadViewJobObjectApi: typeof import("../../../src/native-host/windows-job.js").loadViewJobObjectApi;
    createOwnedWorkspaceView: typeof import("../../../src/native-host/windows-l1/workspace-view.js").createOwnedWorkspaceView;
    CrotService: typeof import("../../../src/service/service.js").CrotService;
    createServicePrivateFiles: typeof import("../../../src/service/private-files.js").createServicePrivateFiles;
    ControlClient: typeof import("../../../src/service/control-client.js").ControlClient;
    openSecretStore: typeof import("../../../src/service/secrets/store.js").openSecretStore;
    generateSecret: typeof import("../../../src/service/secrets/store.js").generateSecret;
    secretFile: typeof import("../../../src/service/secrets/backends.js").secretFile;
    secretCredentialStore: typeof import("../../../src/service/endpoints.js").secretCredentialStore;
    serviceEndpoint: typeof import("../../../src/service/endpoints.js").serviceEndpoint;
    createBnoIsolation: typeof import("../../../src/native-host/windows-l1/bno-isolation.js").createBnoIsolation;
    NativeHost: typeof import("../../../src/native-host/native-host.js").NativeHost;
    NativeProcessLauncher: typeof import("../../../src/native-host/windows-l1/native-process.js").NativeProcessLauncher;
    loadRestrictedTokens: typeof loadRestrictedTokens;
    loadJobObjectApi: typeof loadJobObjectApi;
    loadProbeIntegrity: typeof loadProbeIntegrity;
    loadBytePipeApi: typeof loadBytePipeApi;
    createOwnedDesktop: typeof import("../../../src/native-host/windows-l1/owned-desktop.js").createOwnedDesktop;
  };
  // Four trusted tool calls each already have a 30s deadline; the owned
  // desktop has a separate 10s handshake. Vitest's default 10s hook can expire
  // while valid setup still owns live resources. This composition budget does
  // not change any actor readiness/exit/security assertion or operation timer.
  const fixtureDeadline = 150_000;
  let setupPending: Promise<void> = Promise.resolve();
  let owned: {
    dirs?: TempDirs;
    host?: NativeHost;
    token?: RestrictedToken;
    desktop?: OwnedDesktop;
    launcher?: NativeProcessLauncher;
  } = {};
  const setup = async () => {
    owned = {};
    const started = Date.now();
    const phase = (name: string) =>
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({ title: "CROT-6A-fixture-setup", value: { phase: name, elapsedMs: Date.now() - started } }) +
          "\n",
      );
    dirs = await makeTempDirs();
    owned.dirs = dirs;
    phase("directories");
    // All native ownership brands and Koffi type registries must come from ONE
    // built module graph. Mixing TS and built copies would register native
    // types twice and, worse, break exact byte-stdio ownership authority.
    const built = async (file: string) =>
      import(pathToFileURL(path.resolve(path.dirname(inject("crotMcpBin")), "..", file)).href);
    native = Object.assign(
      {},
      ...(await Promise.all(
        [
          "service/service.js",
          "service/private-files.js",
          "service/control-client.js",
          "service/secrets/store.js",
          "service/secrets/backends.js",
          "service/endpoints.js",
          "native-host/windows-l1/bno-isolation.js",
          "native-host/windows-l1/workspace-view.js",
          "native-host/native-host.js",
          "native-host/windows-job.js",
          "native-host/windows-l1/restricted-token.js",
          "native-host/windows-l1/probe-integrity.js",
          "native-host/windows-l1/byte-stdio.js",
          "native-host/windows-l1/native-process.js",
          "native-host/windows-l1/owned-desktop.js",
        ].map(built),
      )),
    );
    phase("module-graph");
    host = await native.NativeHost.start({ startupPath: "inherited", jobObjects: true });
    owned.host = host;
    phase("native-host");
    const tools = windowsTools(process.env.SystemRoot ?? "C:\\Windows");
    const ownerSid = await currentUserSid(tools);
    token = createCommandToken(await native.loadRestrictedTokens(), ownerSid);
    owned.token = token;
    phase("actor-token");
    privateRoot = path.join(dirs.outside, "new-crot-owned");
    outside = path.join(dirs.outside, "unapproved-low");
    await mkdir(privateRoot);
    await mkdir(outside);
    const label = await native.loadProbeIntegrity();
    label(privateRoot, "low-write");
    label(outside, "low-write");
    // Only a newly created CROT-owned fixture receives the unique SID grant.
    // The actual Medium workspace and the unrelated Low root receive no grant.
    await runTool(tools.powershell, ["-NoProfile", "-NonInteractive", "-Command", GRANT], {
      ...host.platform.baseEnvironment,
      CROT_OWNED_WRITE_ROOT: privateRoot,
      CROT_WRITE_FILTER_SID: token.restrictingSid,
    });
    phase("owned-write-grant");
    project = path.join(dirs.workspace, "owner-only-project.txt");
    await writeFile(project, "project control");
    await host.platform.privateFiles.protectFile!(project);
    phase("project-control");
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
    desktop = await native.createOwnedDesktop({
      launcher: host.platform.launcher,
      environment: host.platform.environment,
      privateRoot,
      ownerSid,
      restrictingSid: token.restrictingSid,
      systemRoot: process.env.SystemRoot ?? "C:\\Windows",
    });
    owned.desktop = desktop;
    phase("owned-desktop");
    bnoIsolation = native.createBnoIsolation();
    launcher = new native.NativeProcessLauncher({
      bnoIsolation,
      desktop,
      token,
      ownerSid,
      pipes: await native.loadBytePipeApi(),
      jobs: await native.loadJobObjectApi(),
      environment: host.platform.environment,
      resolver: host.platform.launcher,
      childEnvironment,
    });
    owned.launcher = launcher;
    phase("ready");
  };
  beforeEach(() => {
    setupPending = setup();
    return setupPending;
  }, fixtureDeadline);
  afterEach(async () => {
    // A failed/expired hook is not cancellation of its Promise. Settle the
    // exact setup before releasing resources or allowing another fixture.
    await setupPending.catch(() => undefined);
    try {
      if (owned.launcher) await owned.launcher.close();
      else await owned.desktop?.close();
    } finally {
      try {
        owned.token?.close();
      } finally {
        try {
          await owned.host?.close();
        } finally {
          await owned.dirs?.cleanup();
        }
      }
    }
  }, fixtureDeadline);
  const body = () =>
    `const fs=require('fs');const attempt=f=>{try{f();return 'ALLOWED'}catch(e){return e.code}};const r={ready:true,project:attempt(()=>fs.readFileSync(${JSON.stringify(project)})),privateWrite:attempt(()=>fs.writeFileSync(${JSON.stringify(path.join(privateRoot, "allowed.txt"))},'allowed')),outsideCreate:attempt(()=>fs.writeFileSync(${JSON.stringify(path.join(outside, "forbidden.txt"))},'forbidden')),outsideWrite:attempt(()=>fs.writeFileSync(${JSON.stringify(path.join(outside, "target.txt"))},'forbidden'))};process.stdout.write(JSON.stringify(r));`;
  async function runCommand(spec: CommandSpec, expectedCode = 0) {
    const child = await launcher.launch(spec, { cwd: dirs.workspace, env: {}, stdin: false });
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
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-6A-unique-process-result",
          value: {
            kind: spec.display === "unique write boundary gate" ? "node" : "shell",
            code: status.code,
            stderrEmpty: errors.length === 0,
            errorCodes: [
              ...new Set(errors.match(/\b(?:0x[0-9a-f]{8}|EACCES|EPERM|ENOENT|EINVAL|EBADF|EPIPE)\b/gi) ?? []),
            ].slice(0, 12),
            errorKinds: [
              /access is denied|access.*denied|отказано в доступе/i.test(errors) ? "access-denied" : "",
              /CLR|Common Language Runtime/i.test(errors) ? "clr" : "",
              /handle.*invalid|invalid.*handle/i.test(errors) ? "invalid-handle" : "",
              /uv_spawn|uv_pipe|node:internal\/child_process/i.test(errors) ? "node-spawn" : "",
            ].filter(Boolean),
            stdoutBytes: Buffer.byteLength(output),
            structured: (() => {
              try {
                const r = JSON.parse(output);
                return {
                  ready: r.ready,
                  spawnError: r.spawnError,
                  childCode: r.childCode,
                  childReady: r.childReady,
                  signal: r.signal,
                };
              } catch {
                return undefined;
              }
            })(),
          },
        }) + "\n",
      );
      expect(child.failure).toBeUndefined();
      expect({ code: status.code, stderrEmpty: errors.length === 0 }).toEqual({
        code: expectedCode,
        stderrEmpty: true,
      });
      return output;
    } finally {
      clearTimeout(timeout);
      await child.terminate("force");
    }
  }
  const run = async (script: string) =>
    JSON.parse(
      await runCommand({ file: process.execPath, args: ["-e", script], display: "unique write boundary gate" }),
    ) as Record<string, unknown>;
  const verify = async (observed: Record<string, unknown>) => {
    expect(observed.ready).toBe(true);
    expect(observed.project).toBe("ALLOWED");
    expect(observed.privateWrite).toBe("ALLOWED");
    for (const key of ["outsideCreate", "outsideWrite"]) expect(["EPERM", "EACCES"]).toContain(observed[key]);
    expect(await readFile(path.join(privateRoot, "allowed.txt"), "utf8")).toBe("allowed");
    expect(await readFile(path.join(outside, "target.txt"), "utf8")).toBe("unchanged");
  };
  it("projects actual Medium backing through ordinary Node fs without relabeling or copy-back", async () => {
    const built = await buildWorkspaceViewFixture();
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const ownerSid = await currentUserSid(windowsTools(systemRoot));
    const helperSid = `S-1-5-21-${randomBytes(4).readUInt32LE()}-${randomBytes(4).readUInt32LE()}-${randomBytes(4).readUInt32LE()}-1001`;
    const helperToken = (await native.loadRestrictedTokens()).create(helperSid, false, undefined, "mic-only");
    let helperLauncher: NativeProcessLauncher | undefined;
    let actor: NativeProcessLauncher | undefined;
    let view: Awaited<ReturnType<typeof native.createOwnedWorkspaceView>> | undefined;
    const event = (phase: string, value: unknown) =>
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({ title: "CROT-6A-workspace-view", value: { phase, value } }) + "\n",
      );
    try {
      event("signed-component-build", { passed: true, arch: process.arch, version: "2.3.1.1000" });
      helperToken.prepareProbeObjects(ownerSid);
      helperLauncher = new native.NativeProcessLauncher({
        token: helperToken,
        ownerSid,
        pipes: await native.loadBytePipeApi(),
        jobs: await native.loadJobObjectApi(),
        environment: host.platform.environment,
        resolver: host.platform.launcher,
        childEnvironment: new WindowsLaunchEnvironment({
          systemRoot,
          privateRoot: path.dirname(built.helper),
          runtimeBins: [],
        }),
      });
      const ffi = createRequire(import.meta.url)("koffi");
      const protectedDir = path.join(dirs.workspace, "view-ЗаЩиТа");
      await mkdir(protectedDir);
      await writeFile(path.join(protectedDir, "secret.txt"), "unchanged protected fixture");
      const linked = path.join(dirs.workspace, "hardlink.txt");
      await link(project, linked);
      // Native OWNER/GROUP/DACL/LABEL snapshots of the original root and
      // existing file; no SID/SD bytes are placed in assertions or evidence.
      const descriptor = () => [dirs.workspace, project].map((file) => snapshotWorkspaceDescriptor(ffi, file));
      const before = descriptor();
      expect(before.every((s) => s.medium)).toBe(true);
      event("original-medium-before", { passed: true, objects: before.length });
      view = await native
        .createOwnedWorkspaceView({
          helper: built.helper,
          diagnoseControlProfiles: true,
          helperLauncher,
          jobs: await native.loadViewJobObjectApi(),
          root: dirs.workspace,
          privateRoot,
          ownerSid,
          restrictingSid: token.restrictingSid,
          protectedRelativeRoots: ["\\view-ЗаЩиТа"],
          environment: { SystemRoot: systemRoot },
        })
        .catch((error: unknown) => {
          if (error && typeof error === "object" && "details" in error) {
            const details = error.details as { controlProfiles?: unknown } | undefined;
            if (details?.controlProfiles) event("control-profile-probes", details.controlProfiles);
          }
          throw error; // diagnostic output NEVER bypasses the mandatory gate
        });
      event("mounted", { passed: true });
      // Existing NativeProcessLauncher keeps its suspended-create, exact Job,
      // unique-token, byte-stdio, owned desktop and BNO verification unchanged.
      actor = new native.NativeProcessLauncher({
        token,
        ownerSid,
        pipes: await native.loadBytePipeApi(),
        jobs: view.jobs,
        environment: host.platform.environment,
        resolver: host.platform.launcher,
        desktop,
        bnoIsolation,
        childEnvironment: new WindowsLaunchEnvironment({
          systemRoot,
          privateRoot,
          runtimeBins: [path.dirname(process.execPath)],
        }),
      });
      const script = `const fs=require('fs');const a=f=>{try{f();return 'ALLOWED'}catch(e){return e.code}};
let phase='create';try{
const name='native-юникод.txt';fs.writeFileSync(name,'live-original');phase='rename';fs.renameSync(name,'native-renamed.txt');
phase='delete-create';fs.writeFileSync('delete-me.txt','delete');phase='delete';fs.unlinkSync('delete-me.txt');
phase='read';const read=fs.readFileSync('native-renamed.txt','utf8')==='live-original';phase='enumerate';const enumerated=fs.readdirSync('.').includes('native-renamed.txt');
phase='negative';process.stdout.write(JSON.stringify({ready:true,read,enumerated,protected:a(()=>fs.readFileSync('VIEW-защита/secret.txt')),hardlink:a(()=>fs.writeFileSync('hardlink.txt','forbidden')),outside:a(()=>fs.writeFileSync(${JSON.stringify(path.join(outside, "view-escape.txt"))},'forbidden'))}));
}catch(e){const code=typeof e.code==='string'&&/^E[A-Z0-9_]{1,30}$/.test(e.code)?e.code:'unexpected';process.stdout.write(JSON.stringify({ready:true,failurePhase:phase,errorCode:code}));process.exitCode=1;}`;
      const proc = await actor.launch(
        { file: process.execPath, args: ["-e", script], display: "same-backing filesystem gate" },
        { cwd: view.mount, env: {}, stdin: false },
      );
      let stdout = "",
        stderrBytes = 0;
      proc.stdout.on("data", (b: Buffer) => {
        if (stdout.length + b.length < 4096) stdout += b.toString();
      });
      proc.stderr.on("data", (b: Buffer) => {
        stderrBytes += b.length;
      });
      const timer = setTimeout(() => {
        void proc.terminate("force");
      }, 15000);
      try {
        const result = await proc.exited;
        // Native byte streams can finish after process signalling.
        await Promise.all(
          [proc.stdout, proc.stderr].map(
            (stream) =>
              new Promise<void>((resolve) => {
                if (stream.readableEnded || stream.destroyed) return resolve();
                stream.once("end", resolve);
                stream.once("close", resolve);
              }),
          ),
        );
        // Only bounded, fixed diagnostics; never publish stderr, paths or identity.
        let failurePhase: string | undefined, errorCode: string | undefined;
        try {
          const diagnostic = JSON.parse(stdout);
          if (
            ["create", "rename", "delete-create", "delete", "read", "enumerate", "negative"].includes(
              diagnostic.failurePhase,
            )
          )
            failurePhase = diagnostic.failurePhase;
          if (typeof diagnostic.errorCode === "string" && /^(E[A-Z0-9_]{1,30}|unexpected)$/.test(diagnostic.errorCode))
            errorCode = diagnostic.errorCode;
        } catch {
          /* A pre-JS failure is not a filesystem denial. */
        }
        event("actor-result", {
          code: result.code,
          failurePhase,
          errorCode,
          stderrEmpty: stderrBytes === 0,
          stdoutBytes: Buffer.byteLength(stdout),
        });
        expect(proc.failure).toBeUndefined();
        expect(result.code).toBe(0);
        expect(stderrBytes).toBe(0);
        const observed = JSON.parse(stdout);
        expect(observed.ready).toBe(true);
        expect(observed.read).toBe(true);
        expect(observed.enumerated).toBe(true);
        for (const key of ["protected", "hardlink", "outside"]) expect(["EACCES", "EPERM"]).toContain(observed[key]);
        // Read the original before unmount: this cannot pass by copy-back.
        expect(await readFile(path.join(dirs.workspace, "native-renamed.txt"), "utf8")).toBe("live-original");
        expect(await readFile(project, "utf8")).toBe("project control");
        expect(await readFile(path.join(protectedDir, "secret.txt"), "utf8")).toBe("unchanged protected fixture");
        const after = descriptor();
        expect(after.every((s, i) => s.medium && s.fingerprint === before[i]!.fingerprint)).toBe(true);
        event("live-backing-and-original-descriptor", { passed: true });
      } finally {
        clearTimeout(timer);
        await proc.terminate("force");
      }
    } finally {
      try {
        await actor?.close();
      } finally {
        try {
          await view?.close();
        } finally {
          try {
            await helperLauncher?.close();
          } finally {
            helperToken.close();
            await built.cleanup();
          }
        }
      }
    }
  }, 300_000);
  it("protects actual service secrets/settings/audit with working owner controls and ready-actor attempts", async () => {
    // Real CrotService and real SecretStore, not lookalike canary paths. This
    // fixture is not Docker, arbitrary external config or self-approval coverage.
    const stateDir = path.join(dirs.outside, "actual-service-state");
    const privateFiles = native.createServicePrivateFiles(true);
    await mkdir(stateDir); // legacy inherited-ACL installation, not a Low parent
    const legacy = native.generateSecret();
    await writeFile(native.secretFile(stateDir, "service-token"), legacy + "\n");
    const audit = path.join(stateDir, "audit.jsonl");
    const service = await native.CrotService.start({
      command: {
        kind: "serve",
        config: {
          workspace: { root: dirs.workspace },
          environment: { path: "inherited" },
          secrets: { store: "file" },
          browser: { enabled: false },
          audit: { sink: "file", path: audit },
        },
        warnings: [],
      },
      launch: "managed",
      stateDir,
      privateFiles,
      log: () => undefined,
      requestStop: () => undefined,
    });
    if (service === "already_running") throw new Error("unexpected fixture service collision");
    let control: Awaited<ReturnType<typeof native.ControlClient.connect>>;
    try {
      const store = await native.openSecretStore(stateDir, privateFiles);
      await store.write("device-key", native.generateSecret());
      control = await native.ControlClient.connect({ stateDir, privateFiles });
      if (!control) throw new Error("owner control did not connect");
      expect(await control.request("ping")).toEqual({ pid: process.pid, state: "running" });
      const changed = await control.request("preset.set", { value: "require-approval" });
      expect(changed).toMatchObject({ ok: true });
      expect((await store.read("service-token")) === legacy).toBe(true);
      const files = [
        native.secretFile(stateDir, "service-token"),
        native.secretFile(stateDir, "control-token"),
        native.secretFile(stateDir, "device-key"),
        path.join(stateDir, "service-settings.json"),
        audit,
      ];
      const before = await Promise.all(files.map((f) => readFile(f)));
      expect(before.every((b) => b.length > 0)).toBe(true);
      for (const file of files) expect((await privateFiles.inspect(file)).ownerOnly).toBe(true);
      const credential = await native.secretCredentialStore(stateDir, privateFiles).read("control");
      if (!credential) throw new Error("actual control credential missing");
      const endpoint = native.serviceEndpoint(stateDir, "control", credential).path;
      const channelModule = pathToFileURL(
        path.resolve(path.dirname(inject("crotMcpBin")), "..", "service/channel.js"),
      ).href;
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-6A-actual-state-owner-control",
          value: {
            serviceStarted: true,
            ownerAuthenticated: true,
            ownerSettingsWrite: true,
            legacyCredentialPreserved: true,
            privateDescriptorsVerified: files.length,
            actorAttempted: false,
          },
        }) + "\n",
      );
      // Import is outside the denial catch: module/startup failure cannot pass.
      // Deliberately wrong fixture credential, never the service's real secret.
      const script = `const fs=require('fs');(async()=>{const {connectChannel}=await import(${JSON.stringify(channelModule)});const attempt=f=>{try{f();return 'ALLOWED'}catch(e){return e.code}};const files=${JSON.stringify(files)};const reads=files.map(f=>attempt(()=>fs.readFileSync(f)));const writes=files.map(f=>attempt(()=>fs.writeFileSync(f,'forbidden')));let endpointResult='ALLOWED';try{const c=await connectChannel(${JSON.stringify(endpoint)},{channel:'control',credential:'invalid-fixture-credential',maxFrameBytes:1048576});await c.close()}catch(e){endpointResult=e.reason||e.code||'unexpected'}process.stdout.write(JSON.stringify({ready:true,reads,writes,endpointAttempted:true,endpointResult}))})().catch(()=>process.exit(71));`;
      const observed = await run(script);
      const reads = observed.reads as unknown[],
        writes = observed.writes as unknown[];
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-6A-actual-state-ready-actor",
          value: {
            ready: observed.ready,
            reads,
            writes,
            endpointAttempted: observed.endpointAttempted,
            endpointResult: observed.endpointResult,
          },
        }) + "\n",
      );
      expect(observed.ready).toBe(true);
      expect(reads).toHaveLength(files.length);
      expect(writes).toHaveLength(files.length);
      for (const result of [...reads, ...writes]) expect(["EPERM", "EACCES"]).toContain(result);
      expect(observed.endpointAttempted).toBe(true);
      expect(["unreachable", "unauthenticated", "EACCES", "EPERM"]).toContain(observed.endpointResult);
      // No secret values or paths are emitted on assertion failure.
      expect((await Promise.all(files.map((f) => readFile(f)))).every((b, i) => b.equals(before[i]!))).toBe(true);
      expect(await control.request("ping")).toEqual({ pid: process.pid, state: "running" });
    } finally {
      control?.close();
      await service.shutdown("actual state fixture end");
    }
  }, 45000);
  it("traces the exact owned unique-token loader before JS (diagnosis is not a denial proof)", async () => {
    const ffi = createRequire(import.meta.url)("koffi");
    let trace: OwnedLoaderTrace | undefined;
    const jobs = await native.loadJobObjectApi();
    const environment = new WindowsLaunchEnvironment({
      systemRoot: process.env.SystemRoot ?? "C:\\Windows",
      privateRoot,
      runtimeBins: [path.dirname(process.execPath)],
    });
    const child = token.launchProbe(
      {
        executable: process.execPath,
        args: [
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(path.join(privateRoot, "loader-js-ready.json"))},'ready');process.exit(0)`,
        ],
        cwd: dirs.workspace,
        env: environment.prepare({}),
        stdio: "nul",
        desktop: desktop.desktop,
        bnoIsolation,
        console: "owned-hidden",
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
        JSON.stringify({
          title: "CROT-6A-unique-token-loader",
          value: {
            ...observation,
            jsReady:
              (await readFile(path.join(privateRoot, "loader-js-ready.json"), "utf8").catch(() => "")) === "ready",
          },
        }) + "\n",
      );
      expect(observation.exited).toBe(true);
      expect(observation.exitCode).toBe(0);
    } finally {
      trace?.close();
      child.close();
    }
  }, 25000);
  it("captures fixed owned startup access-denial call sites without raw memory/arguments", async () => {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    const debuggerPath = path.join(
      path.parse(root).root,
      "Program Files (x86)",
      "Windows Kits",
      "10",
      "Debuggers",
      process.arch,
      "cdb.exe",
    );
    const debuggerAvailable = await access(debuggerPath).then(
      () => true,
      () => false,
    );
    const n = randomBytes(16),
      helperSid = `S-1-5-21-${n.readUInt32LE(0)}-${n.readUInt32LE(4)}-${n.readUInt32LE(8)}-${n.readUInt32LE(12)}`;
    const helperToken = (await native.loadRestrictedTokens()).create(helperSid, false, undefined, "mic-only");
    const ownerSid = await currentUserSid(windowsTools(root));
    helperToken.prepareProbeObjects(ownerSid);
    const debugRoot = path.join(dirs.outside, "owned-debug");
    await host.platform.privateFiles.ensureDirectory(debugRoot);
    (await native.loadProbeIntegrity())(debugRoot, "medium-no-read");
    const log = path.join(debugRoot, "owned-access-stack.log");
    const debuggerTrace = ownedAccessStack({
      debuggerPath,
      log,
      cwd: dirs.outside,
      systemRoot: root,
      token: helperToken,
      jobs: await native.loadJobObjectApi(),
    });
    let child: import("../../../src/native-host/windows-l1/probe-process.js").ProbeProcess | undefined;
    try {
      child = token.launchProbe(
        {
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: dirs.workspace,
          env: { SystemRoot: root, TEMP: privateRoot, TMP: privateRoot },
          desktop: desktop.desktop,
          bnoIsolation,
          console: "owned-hidden",
          stdio: "nul",
          ...(debuggerAvailable
            ? {
                diagnostics: {
                  debugOnlyThisProcess: false,
                  beforeResume: (pid: number, debuggerAttached: () => boolean) => {
                    try {
                      debuggerTrace.beforeResume(pid, debuggerAttached);
                    } catch (error) {
                      debuggerTrace.close();
                      throw error;
                    }
                  },
                },
              }
            : {}),
        },
        (await native.loadJobObjectApi()).createKillOnCloseJob(),
      );
      const deadline = Date.now() + 15000;
      while (child.exitCode() === null && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (debuggerAvailable) expect(debuggerTrace.collect().ready).toBe(true);
      expect(child.exitCode()).toBe(0);
    } finally {
      try {
        // Retain the bounded diagnostic even if native launch/resume fails.
        // A returned child/ready debugger is not a JavaScript attempt witness.
        appendFileSync(
          inject("stage6aEvidence"),
          JSON.stringify({
            title: "CROT-6A-unique-owned-access-stack",
            value: {
              status: debuggerAvailable ? "COLLECTED" : "UNAVAILABLE",
              ...debuggerTrace.collect(),
              targetReturned: child !== undefined,
              exitCode: child?.exitCode() ?? null,
            },
          }) + "\n",
        );
      } finally {
        try {
          child?.close();
        } finally {
          try {
            debuggerTrace.close();
          } finally {
            try {
              helperToken.close();
            } finally {
              await rm(debugRoot, { recursive: true, force: true });
            }
          }
        }
      }
    }
  }, 45000);
  it("runs ordinary Node APIs with owner-project reads, private writes and unrelated Low denial", async () => {
    await verify(await run(body()));
  });
  it("supports ordinary NUL reopen needed by ignored-stdio descendants after a trusted working control", async () => {
    const fd = openSync("\\\\.\\NUL", "r+");
    try {
      expect(writeSync(fd, Buffer.from("x"))).toBe(1);
      expect(readSync(fd, Buffer.alloc(1), 0, 1, null)).toBe(0);
    } finally {
      closeSync(fd);
    }
    const observed = await run(
      "const fs=require('fs');let opened=false,written=null,read=null,error=null,fd;try{fd=fs.openSync('\\\\\\\\.\\\\NUL','r+');opened=true;written=fs.writeSync(fd,Buffer.from('x'));read=fs.readSync(fd,Buffer.alloc(1),0,1,null)}catch(e){error=e.code}finally{if(fd!==undefined)fs.closeSync(fd)}console.log(JSON.stringify({ready:true,opened,written,read,error}));",
    );
    expect(observed).toEqual({ ready: true, opened: true, written: 1, read: 0, error: null });
  });
  it.each([false, true])(
    "retains that boundary in an actually ready Node descendant (windowsHide=%s)",
    async (windowsHide) => {
      const witness = path.join(privateRoot, "pipe-child-ready.json");
      const childBody =
        `require('fs').writeFileSync(${JSON.stringify(witness)},JSON.stringify({ready:true}));` + body();
      const script = `const fs=require('fs');const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childBody)}],{windowsHide:${windowsHide},stdio:['pipe','pipe','pipe']});c.stdin.end();c.stdout.pipe(process.stdout);c.stderr.pipe(process.stderr);c.on('error',e=>{console.log(JSON.stringify({spawnError:e.code}));process.exitCode=99});c.on('exit',(code,signal)=>{if(code!==0)console.log(JSON.stringify({childCode:code,signal,childReady:fs.existsSync(${JSON.stringify(witness)})}));process.exitCode=code??96});`;
      await verify(await run(script));
    },
  );
  it.each([false, true])("runs a genuinely ready ignored-stdio descendant (windowsHide=%s)", async (windowsHide) => {
    const result = path.join(privateRoot, "ignored-ready.json");
    const ignored = body().replace(
      "process.stdout.write(JSON.stringify(r))",
      `fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(r))`,
    );
    const script = `const fs=require('fs');const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(ignored)}],{windowsHide:${windowsHide},stdio:'ignore'});c.on('error',()=>{process.exitCode=98});c.on('exit',code=>{if(code!==0){console.log(JSON.stringify({startupExit:code}));process.exitCode=97;return}process.stdout.write(fs.readFileSync(${JSON.stringify(result)}));});`;
    await verify(await run(script));
  });
  it.each(["cmd", "powershell"] as const)(
    "runs production %s ordinary private CRUD/redirection without startup substitution",
    async (shell) => {
      const first = path.join(privateRoot, "shell space ж.txt"),
        renamed = path.join(privateRoot, "renamed ж.txt");
      const ps = (p: string) => "'" + p.replaceAll("'", "''") + "'";
      const script =
        shell === "cmd"
          ? `echo unique-shell-ready>"${first}" & type "${first}" & ren "${first}" "${path.basename(renamed)}" & del "${renamed}" & exit /b 23`
          : `$ErrorActionPreference='Stop';'unique-shell-ready' > ${ps(first)};Get-Content -LiteralPath ${ps(first)};[IO.File]::Move(${ps(first)},${ps(renamed)});[IO.File]::Delete(${ps(renamed)});exit 23`;
      const output = await runCommand(host.platform.shells.command(script, shell), 23);
      expect(output).toContain("unique-shell-ready");
      await expect(readFile(first)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(renamed)).rejects.toMatchObject({ code: "ENOENT" });
    },
    20000,
  );
  it("denies owner WRITE_DAC bypass after an identical trusted native ACL update succeeds", async () => {
    const koffiPath = createRequire(import.meta.url).resolve("koffi");
    const target = path.join(outside, "target.txt");
    const script = `const k=require(${JSON.stringify(koffiPath)});k.struct('CROT_GATE_ACL_HANDLE',{value:'void *'});const a=k.load('advapi32.dll'),b=k.load('kernel32.dll');const get=a.func('uint32_t __stdcall GetNamedSecurityInfoW(str16 name,int kind,uint32_t info,void *owner,void *group,_Out_ CROT_GATE_ACL_HANDLE *dacl,void *sacl,_Out_ CROT_GATE_ACL_HANDLE *sd)');const set=a.func('uint32_t __stdcall SetNamedSecurityInfoW(str16 name,int kind,uint32_t info,void *owner,void *group,void *dacl,void *sacl)');const free=b.func('void * __stdcall LocalFree(void *memory)');const acl={},sd={};const readCode=get(${JSON.stringify(target)},1,4,null,null,acl,null,sd);let code=null;try{if(readCode===0&&acl.value)code=set(${JSON.stringify(target)},1,4,null,null,acl.value,null)}finally{if(sd.value)free(sd.value)}console.log(JSON.stringify({ready:true,readCode,attempted:code!==null,code}));`;
    const trusted = await host.platform.launcher.launch(
      { file: process.execPath, args: ["-e", script], display: "trusted identical ACL control" },
      { cwd: dirs.workspace, env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }, stdin: false },
    );
    let out = "";
    trusted.stdout.on("data", (b: Buffer) => {
      out += b.toString();
    });
    trusted.stderr.resume();
    try {
      expect((await trusted.exited).code).toBe(0);
      await new Promise<void>((resolve) => {
        if (trusted.stdout.readableEnded || trusted.stdout.destroyed) resolve();
        else trusted.stdout.once("end", resolve);
      });
      expect(JSON.parse(out)).toEqual({ ready: true, readCode: 0, attempted: true, code: 0 });
    } finally {
      await trusted.terminate("force");
    }
    const observed = await run(script);
    expect(observed).toEqual({ ready: true, readCode: 0, attempted: true, code: 5 });
    expect(await readFile(target, "utf8")).toBe("unchanged");
  });
});

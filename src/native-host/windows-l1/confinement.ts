/** Production Windows L1: no authorization, elevation or unconfined retry. */
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { Readable } from "node:stream";
import { CrotError } from "../../core/errors.js";
import { confinementUnavailableError } from "../../core/platform/confinement.js";
import type {
  CommandConfinement,
  ConfinementNetwork,
  ConfinementReason,
  ConfinementScope,
  ConfinementStatus,
  CoreConfinement,
  EnvironmentPolicy,
  ProcessLauncher,
  PrivateFileProtection,
} from "../../core/platform/types.js";
import { loadJobObjectApi } from "../windows-job.js";
import { bindAppContainerProcessIdentity } from "./appcontainer-process.js";
import { loadBytePipeApi } from "./byte-stdio.js";
import { verifyWindowsComponents, WindowsPreparationError, type WindowsComponents } from "./components.js";
import { openWindowsDockerEndpoint } from "./docker-endpoint.js";
import { windowsDockerConfiguration } from "./docker-config.js";
import { canonicalWindowsDockerPath } from "./docker-paths.js";
import { WindowsLaunchEnvironment } from "./launch-environment.js";
import { loadLeaseAclObjects } from "./lease-acl.js";
import type { NativeLease } from "./lease-owner.js";
import { bindLocalPipeShim } from "./local-shim.js";
import { NativeProcessLauncher } from "./native-process.js";
import type { WindowsLeaseServiceLifecycle } from "./service-lifecycle.js";
import { createUpstream } from "../linux-l1/docker-endpoint.js";
const control = Object.freeze({
  treeTermination: "job-object",
  orphanedDescendants: true,
  gracefulTermination: false,
} as const);
const failed = (cause: unknown) =>
  new CrotError(
    "CONFINEMENT_FAILED",
    "Windows AppContainer confinement failed; no unconfined retry is permitted.",
    undefined,
    { cause },
  );
const unavailable = (network: ConfinementNetwork, reason: ConfinementReason, detail: string): ConfinementStatus => ({
  mechanism: "windows-appcontainer",
  available: false,
  network,
  reason,
  detail,
});
interface Runtime {
  lease: NativeLease;
  launcher: NativeProcessLauncher;
  directory: string;
  close(): Promise<void>;
  closeSync(): void;
}
export interface WindowsConfinementOptions {
  readonly stateDir: string;
  readonly ownerSid: string | undefined;
  readonly privateFiles: PrivateFileProtection;
  readonly runtimeFiles: PrivateFileProtection;
  readonly writableRuntimeFiles: PrivateFileProtection;
  readonly lifecycle: WindowsLeaseServiceLifecycle | undefined;
  readonly base: ProcessLauncher;
  readonly environment: EnvironmentPolicy;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
}
export class WindowsConfinement implements CommandConfinement {
  private readonly probes = new Map<ConfinementNetwork, Promise<ConfinementStatus>>();
  private readonly healthy = new Map<ConfinementNetwork, ConfinementStatus>();
  private active = 0;
  private fault: unknown;
  private probeTail: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: WindowsConfinementOptions) {}
  private async components(): Promise<WindowsComponents> {
    const c = await verifyWindowsComponents(
      this.options.stateDir,
      this.options.runtimeFiles,
      this.options.privateFiles,
    );
    if (!this.options.ownerSid || !this.options.lifecycle || this.options.lifecycle.failure)
      throw new WindowsPreparationError(
        "private_storage_unavailable",
        "Windows L1 lease storage or recovery is unavailable.",
      );
    return c;
  }
  probe(network: ConfinementNetwork): Promise<ConfinementStatus> {
    if (this.fault)
      return Promise.resolve(unavailable(network, "self_test_failed", "An active Windows L1 native resource failed."));
    if (this.active && this.healthy.has(network)) return Promise.resolve(this.healthy.get(network)!);
    const previous = this.probes.get(network);
    if (previous) return previous;
    const pending = this.probeTail.then(async () => {
      let status: ConfinementStatus;
      try {
        const c = await this.components();
        await this.selfTest(c, network);
        status = {
          mechanism: "windows-appcontainer",
          available: true,
          network,
          reason: null,
          detail:
            network === "on"
              ? "Host network is available; unauthenticated host execution endpoints remain the owner's residual risk (AD-20.14)."
              : null,
        };
        this.healthy.set(network, status);
      } catch (cause) {
        this.options.log?.(
          `Windows L1 readiness failure: ${cause instanceof Error ? cause.message.split(/\r?\n/)[0]!.slice(0, 180) : "native error"}`,
        );
        status = unavailable(
          network,
          cause instanceof WindowsPreparationError ? cause.reason : "self_test_failed",
          cause instanceof WindowsPreparationError
            ? cause.message
            : "Windows L1 native startup self-test did not complete.",
        );
        this.healthy.delete(network);
      }
      this.options.log?.(`Windows L1 ${network}: ${status.available ? "available" : status.reason}`);
      return status;
    });
    this.probeTail = pending.catch(() => undefined);
    this.probes.set(network, pending);
    void pending.finally(() => this.probes.delete(network));
    return pending;
  }
  private async runtime(c: WindowsComponents, scope: ConfinementScope): Promise<Runtime> {
    const { writableRuntimeFiles: privateFiles, ownerSid, lifecycle, environment, base } = this.options;
    if (!ownerSid || !lifecycle) throw failed("lease owner unavailable");
    const directory = path.join(this.options.stateDir, "windows-l1", "runtime", randomUUID());
    await privateFiles.ensureDirectory(directory);
    const home = this.options.env.USERPROFILE ?? "C:\\Users\\Default";
    const contextPaths = [
      ...new Set(
        [path.join(home, ".docker"), this.options.env.DOCKER_CONFIG, this.options.env.DOCKER_CERT_PATH].filter(
          (p): p is string => !!p,
        ),
      ),
    ];
    const layout = new WindowsLaunchEnvironment({
      systemRoot: this.options.env.SystemRoot ?? "C:\\Windows",
      privateRoot: directory,
      runtimeBins: [c.root],
    });
    for (const p of Object.values(layout.directories)) await mkdir(p, { recursive: true });
    let launcher: NativeProcessLauncher | undefined;
    let lease: NativeLease | undefined;
    const protectedPaths = [...new Set([...scope.protectedPaths, ...contextPaths])];
    const hostEnvironment: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.options.env)) if (value !== undefined) hostEnvironment[key] = value;
    let dockerExecutable: string | undefined;
    try {
      dockerExecutable = (
        await base.resolveCommand("docker.exe", [], {
          cwd: directory,
          env: hostEnvironment,
          searchCurrentDirectory: false,
        })
      ).file;
    } catch (cause) {
      if (!(cause instanceof CrotError) || cause.code !== "NOT_FOUND") throw cause;
    }
    let dockerBin: string | undefined;
    if (dockerExecutable) {
      // Resolve the actual host file before trusting it as an upstream tool.
      // A PATH alias/junction into the actor's workspace is not a host CLI.
      const acl = await loadLeaseAclObjects();
      const object = acl.capture(dockerExecutable, "protected", "S-1-15-2-1-2-3-4-5-6-7", 0);
      const guard = acl.hold(object, false);
      try {
        const observed = guard.snapshot();
        const executable = canonicalWindowsDockerPath(observed.dosPath.replace(/^\\\\\?\\/, ""));
        for (const root of [scope.workspace, directory]) {
          const writable = canonicalWindowsDockerPath(root);
          if (executable === writable || executable.startsWith(writable + "\\"))
            throw failed("Docker CLI resolves inside actor-writable storage");
        }
        if (observed.links !== 1) throw failed("Docker CLI has multiple host aliases");
        dockerExecutable = executable;
      } finally {
        guard.close();
      }
      // The host CLI remains host-only. Its disposable child-side copy needs
      // no WRITE_DAC/lease grant on Program Files, C:\ or a package manager.
      dockerBin = path.join(directory, "tools");
      await mkdir(dockerBin);
      await copyFile(dockerExecutable, path.join(dockerBin, "docker.exe"));
    }
    const dockerConfig = await windowsDockerConfiguration({ ...hostEnvironment, ...scope.dockerEnvironment }, home);
    const upstream = dockerExecutable
      ? createUpstream({
          host: dockerConfig.host,
          tls: dockerConfig.tls,
          env: dockerConfig.env,
          docker: dockerExecutable,
        })
      : {
          local: true,
          transport: "other" as const,
          connect: async (): Promise<never> => {
            throw failed("Docker CLI is not installed");
          },
        };
    try {
      lease = await (
        await lifecycle.get()
      ).openLease({
        workspace: scope.workspace,
        network: scope.network,
        writableRuntime: [directory],
        readOnlyRuntime: [c.root],
        protectedPaths,
        start: async (profile, network) => {
          const moduleName: string = "koffi";
          const imported = await import(moduleName),
            ffi = imported.default ?? imported;
          const dll = (name: string) => path.join(this.options.env.SystemRoot ?? "C:\\Windows", "System32", name);
          const shim = bindLocalPipeShim(ffi, c.library);
          const acl = await loadLeaseAclObjects();
          const guards: ReturnType<typeof acl.hold>[] = [];
          let unhealthy: unknown;
          let docker: Awaited<ReturnType<typeof openWindowsDockerEndpoint>> | undefined;
          const closeResources = async () => {
            let error: unknown;
            for (const release of [
              async () => launcher?.close(),
              async () => docker?.endpoint.close(),
              async () => {
                for (const g of [...guards].reverse()) g.close();
              },
              async () => shim.close(),
            ])
              try {
                await release();
              } catch (cause) {
                error ??= cause;
              }
            if (error) throw error;
          };
          try {
            docker = await openWindowsDockerEndpoint({
              profile,
              ownerSid,
              upstream,
              paths: {
                writable: [scope.workspace, directory],
                protectedPaths,
                dockerContextPaths: contextPaths,
                // Outside writable roots a Docker bind has not been proven
                // readable by this exact AppContainer token; refuse it.
                unreadable: [...new Set([path.win32.parse(scope.workspace).root, path.win32.parse(directory).root])],
                daemonSockets: ["\\\\.\\pipe\\docker_engine"],
                resolve: (source) => {
                  // Retain every current-name identity guard through lease end,
                  // not merely through this synchronous policy callback. Reparse,
                  // case-sensitive directories and hardlink sources fail closed.
                  const canonical = canonicalWindowsDockerPath(source);
                  let p = canonical;
                  const chain: string[] = [];
                  for (;;) {
                    chain.unshift(p);
                    const parent = path.win32.dirname(p);
                    if (parent === p) break;
                    p = parent;
                  }
                  for (const entry of chain) {
                    if (guards.length >= 10000) throw failed("Docker guard capacity");
                    const object = acl.capture(entry, "protected", profile.sid, 0);
                    const guard = acl.hold(object);
                    guards.push(guard);
                    const observed = guard.snapshot();
                    if (observed.links !== 1 && !object.identity.directory) throw failed("Docker source hardlink");
                    if (
                      canonicalWindowsDockerPath(observed.dosPath.replace(/^\\\\\?\\/, "")) !==
                      canonicalWindowsDockerPath(entry)
                    )
                      throw failed("Docker source identity changed");
                  }
                  return source;
                },
              },
              onRefusal: (request, reason) => scope.audit({ event: "confinement.docker_refused", request, reason }),
              failed: (cause) => {
                unhealthy = cause;
                this.fault = cause;
                launcher?.closeSync();
              },
            });
            launcher = new NativeProcessLauncher({
              token: bindAppContainerProcessIdentity(
                ffi,
                { kernel32: dll("kernel32.dll"), advapi32: dll("advapi32.dll") },
                profile,
                ownerSid,
                shim,
                network,
              ),
              ownerSid,
              pipes: await loadBytePipeApi(),
              jobs: await loadJobObjectApi(),
              environment,
              resolver: base,
              childEnvironment: new WindowsLaunchEnvironment({
                systemRoot: this.options.env.SystemRoot ?? "C:\\Windows",
                privateRoot: directory,
                runtimeBins: dockerBin ? [c.root, dockerBin] : [c.root],
                dockerHost: docker.dockerHost,
              }),
            });
            if (unhealthy) throw unhealthy;
            return {
              close: closeResources,
              closeSync: () => {
                launcher!.closeSync();
                docker!.endpoint.closeSync();
              },
            };
          } catch (cause) {
            await closeResources();
            throw cause;
          }
        },
      });
      this.active++;
      let closed = false;
      return {
        lease,
        launcher: launcher!,
        directory,
        close: async () => {
          if (closed) return;
          await lease!.close();
          closed = true;
          this.active--;
          await rm(directory, { recursive: true, force: true });
        },
        closeSync: () => lease!.closeSync(),
      };
    } catch (cause) {
      this.fault = cause;
      this.options.log?.(
        `Windows L1 runtime: ${cause instanceof Error ? cause.message.split(/\r?\n/)[0]!.slice(0, 180) : "native resource failure"}`,
      );
      throw failed(cause);
    }
  }
  private async selfTest(c: WindowsComponents, network: ConfinementNetwork): Promise<void> {
    const root = path.join(this.options.stateDir, "windows-l1", "self-test", randomUUID()),
      workspace = path.join(root, "workspace"),
      secret = path.join(root, "private-canary");
    await this.options.writableRuntimeFiles.ensureDirectory(root);
    await mkdir(workspace);
    await writeFile(secret, "self-test-canary");
    await this.options.privateFiles.protectFile!(secret);
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    let runtime: Runtime | undefined, failure: unknown;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw failed("self-test HTTP address");
      runtime = await this.runtime(c, {
        workspace,
        protectedPaths: [secret],
        network,
        dockerEnvironment: {},
        audit: () => undefined,
      });
      const code = `const f=require('fs'),cp=require('child_process'),http=require('http');
const secret=${JSON.stringify(secret)};for(const fn of [()=>f.readFileSync(secret),()=>f.writeFileSync(secret,'bad')]){try{fn();process.exit(91)}catch(e){if(e.code!=='EPERM')process.exit(92)}}
f.writeFileSync('a','ok');f.renameSync('a','b');f.writeFileSync(require('path').join(process.env.TEMP,'runtime-canary'),'ok');
const child=cp.spawnSync(process.execPath,['-e',"require('child_process').spawnSync(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});process.exit(0)"],{stdio:'ignore'});if(child.error||child.status!==0)process.exit(93);
const req=http.get('http://127.0.0.1:${address.port}',r=>{r.resume();r.on('end',()=>process.exit(${network === "on" ? "r.statusCode===200?0:94" : "95"}))});req.on('error',()=>process.exit(${network === "off" ? "0" : "96"}));req.setTimeout(4000,()=>process.exit(${network === "off" ? "0" : "97"}));`;
      const process_ = await runtime.launcher.launch(
        { file: c.executable, args: ["-e", code], display: "Windows L1 native startup self-test" },
        { cwd: workspace, env: {}, stdin: false },
      );
      let diagnostic = "";
      const output = consume(process_.stdout),
        errors = (async () => {
          for await (const bytes of process_.stderr)
            if (diagnostic.length < 2048) diagnostic += String(bytes).slice(0, 2048 - diagnostic.length);
        })();
      const exit = await Promise.race([
        process_.exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(failed("self-test deadline")), 15000).unref()),
      ]);
      await process_.terminate("force");
      await Promise.all([output, errors]);
      if (exit.code !== 0 || (await readFile(secret, "utf8")) !== "self-test-canary") {
        this.options.log?.(
          `Windows L1 self-test exit: ${exit.code}; ${diagnostic.replace(/\s+/g, " ").slice(0, 1600)}`,
        );
        throw failed("self-test result");
      }
    } catch (cause) {
      failure = cause;
    } finally {
      for (const cleanup of [
        async () => runtime?.close(),
        async () => new Promise<void>((resolve) => server.close(() => resolve())),
        async () => rm(root, { recursive: true, force: true }),
      ])
        try {
          await cleanup();
        } catch (cause) {
          failure ??= cause;
        }
    }
    if (failure) throw failure;
  }
  async open(scope: ConfinementScope): Promise<CoreConfinement> {
    let status = await this.probe(scope.network),
      runtime: Promise<Runtime> | undefined,
      current: Runtime | undefined,
      closed = false,
      admitted = status.available;
    const requireRuntime = async () => {
      if (closed) throw failed("Core is closed");
      if (this.fault) throw failed(this.fault);
      if (!status.available) {
        if (admitted) throw failed("readiness lost after admission");
        throw confinementUnavailableError(status);
      }
      runtime ??= this.components()
        .then((c) => this.runtime(c, scope))
        .then((r) => {
          current = r;
          return r;
        });
      try {
        const value = await runtime;
        if (closed) {
          await value.close();
          throw failed("Core closed during setup");
        }
        return value;
      } catch (cause) {
        throw failed(cause);
      }
    };
    const launcher: ProcessLauncher = {
      canTerminateOrphanedDescendants: true,
      processControl: control,
      resolveCommand: async (...args) => (await requireRuntime()).launcher.resolveCommand(...args),
      launch: async (...args) => (await requireRuntime()).launcher.launch(...args),
    };
    return {
      status: () => status,
      assertAdmission: () => {
        if (admitted && (!status.available || this.fault)) throw failed("readiness lost after admission");
      },
      refresh: async () => {
        status = await this.probe(scope.network);
        // Keep reporting truthful status; the ProcessService admission guard
        // prevents both local and remote post-admission fallback.
        admitted ||= status.available;
        return status;
      },
      launcher,
      close: async () => {
        closed = true;
        if (runtime) await (await runtime).close();
      },
      closeSync: () => {
        closed = true;
        current?.closeSync();
      },
    };
  }
}
async function consume(stream: Readable): Promise<void> {
  for await (const _ of stream) {
    /* bounded self-test output discarded */
  }
}

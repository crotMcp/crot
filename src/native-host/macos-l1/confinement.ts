import { randomUUID } from "node:crypto";
import { MacosActors } from "./actors.js";
import { launchSeatbelt } from "./launch.js";
/** macOS Seatbelt L1. Core authorization stays in ProcessService; no unconfined retry. */
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { CrotError } from "../../core/errors.js";
import type {
  CommandConfinement,
  ConfinementNetwork,
  ConfinementReason,
  ConfinementScope,
  ConfinementStatus,
  CoreConfinement,
  ManagedProcess,
  ProcessLauncher,
  LaunchOptions,
  CommandSpec,
} from "../../core/platform/types.js";
import { DockerEndpoint, createUpstream, type DockerUpstream } from "../linux-l1/docker-endpoint.js";
import { currentContextHost, unixSocketOf } from "../linux-l1/layout.js";
import { canonicalPath, type SeatbeltLayout } from "./profile.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const failed = () =>
  new CrotError("CONFINEMENT_FAILED", "macOS Seatbelt confinement failed; command was not retried outside L1");
const statusOf = (network: ConfinementNetwork, reason: ConfinementReason | null): ConfinementStatus => ({
  mechanism: "macos-seatbelt",
  available: reason === null,
  network,
  reason,
  detail: reason ? `macOS Seatbelt readiness: ${reason}` : null,
});
export interface MacosConfinementOptions {
  readonly base: ProcessLauncher;
  readonly stateDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
  /** Test seam: transport only, never replaces policy or self_test. */
  readonly upstream?: DockerUpstream;
}

export class MacosConfinement implements CommandConfinement {
  private actors: Promise<MacosActors> | undefined;
  constructor(private readonly options: MacosConfinementOptions) {}

  async probe(network: ConfinementNetwork): Promise<ConfinementStatus> {
    if (process.platform !== "darwin" || !["x64", "arm64"].includes(process.arch))
      return statusOf(network, "components_missing");
    try {
      const st = await lstat(SANDBOX_EXEC);
      if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0) return statusOf(network, "components_mismatch");
    } catch {
      return statusOf(network, "components_missing");
    }
    let root: string | undefined;
    try {
      root = await privateRoot();
      const workspace = path.join(root, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      const sandbox = await this.openPrepared(
        { workspace, protectedPaths: [this.options.stateDir], network, dockerEnvironment: {}, audit: () => undefined },
        root,
      );
      const status = sandbox.status();
      await sandbox.close();
      root = undefined;
      return status;
    } catch {
      return statusOf(network, "self_test_failed");
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
  }

  async open(scope: ConfinementScope): Promise<CoreConfinement> {
    const ready = await this.probe(scope.network);
    if (!ready.available) return unavailableCore(ready);
    let root: string | undefined;
    try {
      root = await privateRoot();
      return await this.openPrepared(scope, root);
    } catch {
      if (root) await rm(root, { recursive: true, force: true });
      return unavailableCore(statusOf(scope.network, "self_test_failed"));
    }
  }

  private async openPrepared(scope: ConfinementScope, root: string): Promise<MacosCore> {
    const home = path.join(root, "home"),
      temp = path.join(root, "tmp");
    await mkdir(home, { mode: 0o700 });
    await mkdir(temp, { mode: 0o700 });
    const realHome = canonicalPath(this.options.env.HOME ?? os.homedir());
    const host =
      this.options.env.DOCKER_HOST ??
      (await currentContextHost(this.options.env, realHome)) ??
      "unix:///var/run/docker.sock";
    const protectedPaths = [
      ...new Set(
        [
          ...scope.protectedPaths,
          this.options.stateDir,
          path.join(realHome, "Library/Application Support/CROT"),
          path.join(realHome, "Library/Logs/CROT"),
          path.join(realHome, "Library/Keychains"),
          "/Library/Keychains",
          path.join(realHome, ".docker"),
          path.join(realHome, ".colima"),
          path.join(realHome, ".orbstack"),
          this.options.env.DOCKER_CONFIG,
          this.options.env.DOCKER_CERT_PATH,
          "/var/run/docker.sock",
          unixSocketOf(host),
        ]
          .filter((p): p is string => !!p)
          .map(canonicalPath),
      ),
    ];
    const layout: SeatbeltLayout = {
      writable: [canonicalPath(scope.workspace), home, temp],
      protectedPaths,
      dockerSocket: path.join(root, "d.sock"),
      network: scope.network,
    };
    const endpoint = await DockerEndpoint.start({
      socketPath: layout.dockerSocket,
      upstream:
        this.options.upstream ??
        createUpstream({
          host,
          tls: !!this.options.env.DOCKER_TLS_VERIFY || !!this.options.env.DOCKER_CERT_PATH,
          env: scope.dockerEnvironment,
          docker: "docker",
        }),
      boundary: {
        writable: layout.writable,
        protectedPaths,
        unreadable: protectedPaths,
        daemonSockets: [
          canonicalPath("/var/run/docker.sock"),
          ...(unixSocketOf(host) ? [canonicalPath(unixSocketOf(host)!)] : []),
        ],
        endpointSocket: layout.dockerSocket,
        resolve: canonicalPath,
      },
      containerProfile: "",
      onRefusal: (request, reason) => scope.audit({ event: "confinement.docker_refused", request, reason }),
    });
    const actors = await (this.actors ??= MacosActors.load());
    const core = new MacosCore(this.options.base, actors, scope, root, home, temp, layout, endpoint);
    try {
      await core.selfTest();
      return core;
    } catch (error) {
      await core.close();
      throw error;
    }
  }
}

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "crot-l1-"));
  const st = await lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
    throw new Error("private storage unavailable");
  return root;
}

class MacosCore implements CoreConfinement {
  private closed = false;
  private broken = false;
  private refreshing: Promise<ConfinementStatus> | undefined;
  private readonly children = new Set<ManagedProcess>();
  readonly launcher: ProcessLauncher;
  constructor(
    private readonly base: ProcessLauncher,
    private readonly actors: MacosActors,
    private readonly scope: ConfinementScope,
    private readonly root: string,
    private readonly home: string,
    private readonly temp: string,
    private readonly layout: SeatbeltLayout,
    private readonly endpoint: DockerEndpoint,
  ) {
    this.launcher = {
      ...base,
      resolveCommand: (command, args, options) =>
        base.resolveCommand(command, args, { ...options, env: this.environment(options.env) }),
      launch: (spec, options) => this.launch(spec, options),
    };
  }
  status(): ConfinementStatus {
    return statusOf(this.scope.network, this.broken || this.closed ? "self_test_failed" : null);
  }
  async refresh(): Promise<ConfinementStatus> {
    // Status is shared by concurrent stdio clients and tray polling: one live
    // self_test per Core, never bind the same control canary twice.
    if (!this.refreshing)
      this.refreshing = (async () => {
        try {
          this.assertAdmission();
          await this.selfTest();
        } catch {
          this.broken = true;
        }
        return this.status();
      })().finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
  assertAdmission(): void {
    if (this.closed || this.broken) throw failed();
  }
  private environment(env: Readonly<Record<string, string>>): Record<string, string> {
    const out = { ...env };
    for (const key of Object.keys(out))
      if (/^(DYLD_|DOCKER_|SSH_AUTH_SOCK$|GIT_CONFIG|BASH_ENV$|ENV$|ZDOTDIR$|NODE_OPTIONS$)/.test(key)) delete out[key];
    return {
      ...out,
      HOME: this.home,
      TMPDIR: this.temp,
      TMP: this.temp,
      TEMP: this.temp,
      XDG_CACHE_HOME: this.home,
      XDG_CONFIG_HOME: this.home,
      XDG_DATA_HOME: this.home,
      npm_config_cache: path.join(this.home, "npm"),
      PIP_CACHE_DIR: path.join(this.home, "pip"),
      CARGO_HOME: path.join(this.home, "cargo"),
      RUSTUP_HOME: path.join(this.home, "rustup"),
      GOPATH: path.join(this.home, "go"),
      GOCACHE: path.join(this.home, "go-cache"),
      DOCKER_HOST: `unix://${this.layout.dockerSocket}`,
      DOCKER_CONFIG: path.join(this.home, "docker"),
    };
  }
  private async launch(spec: CommandSpec, options: LaunchOptions): Promise<ManagedProcess> {
    this.assertAdmission();
    try {
      // Re-resolve every policy path before launch: a moved/replaced protected root is not silently admitted.
      for (const p of [...this.layout.writable, ...this.layout.protectedPaths])
        if (canonicalPath(p) !== p) throw failed();
      const id = await this.actors.identity(this.root);
      const child = await launchSeatbelt(this.base, this.actors, id, this.layout, spec, {
        ...options,
        env: this.environment({ ...options.env, ...spec.env }),
      });
      this.children.add(child);
      // Drain detached/reparented descendants as soon as the direct command
      // exits; retain the record until the drain, not an indefinitely reusable PID.
      void child.exited.then(() => {
        try {
          child.terminateSync();
          this.children.delete(child);
        } catch {
          this.broken = true;
        }
      });
      return child;
    } catch {
      this.broken = true;
      throw failed();
    }
  }
  async selfTest(): Promise<void> {
    const probeName = `.crot-l1-check-${randomUUID()}`;
    const canary = path.join(this.root, "canary");
    await writeFile(canary, "not-a-secret", { mode: 0o600 });
    const control = path.join(this.root, "c.sock");
    const server = net.createServer((s) => s.end("must-not-be-readable"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(control, resolve);
    });
    try {
      const script = `const fs=require('fs'),net=require('net');
const denied=f=>{try{f();throw Error('escape')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}};
denied(()=>fs.readFileSync(${JSON.stringify(canary)}));
denied(()=>fs.writeFileSync(${JSON.stringify(path.join(this.root, "outside"))},'x'));
fs.writeFileSync(${JSON.stringify(path.join(this.scope.workspace, probeName))},'ok',{flag:'wx'});
fs.unlinkSync(${JSON.stringify(path.join(this.scope.workspace, probeName))});
fs.writeFileSync(${JSON.stringify(path.join(this.temp, "self-test"))},'ok');
const s=net.connect(${JSON.stringify(control)});s.on('connect',()=>process.exit(42));s.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))process.exit(43);else console.log('CROT-SEATBELT-READY')});`;
      const id = await this.actors.identity(this.root);
      const child = await launchSeatbelt(
        this.base,
        this.actors,
        id,
        { ...this.layout, protectedPaths: [...this.layout.protectedPaths, canary, control] },
        { file: process.execPath, args: ["-e", script], display: "macOS L1 self_test" },
        { cwd: this.scope.workspace, env: this.environment(process.env as Record<string, string>), stdin: false },
      );
      let stdout = "";
      child.stdout.on("data", (b) => {
        stdout += String(b);
      });
      child.stderr.resume();
      const timer = setTimeout(() => child.terminateSync(), 10_000);
      const exit = await child.exited;
      clearTimeout(timer);
      child.terminateSync();
      if (!child.stdout.readableEnded) await new Promise<void>((resolve) => child.stdout.once("end", resolve));
      const result = { stdout };
      if (exit.code !== 0) throw failed();
      if (
        result.stdout.trim() !== "CROT-SEATBELT-READY" ||
        (await readFile(path.join(this.temp, "self-test"), "utf8")) !== "ok"
      )
        throw failed();
    } finally {
      server.close();
      await rm(control, { force: true });
      await rm(canary, { force: true });
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closeSync();
    await this.endpoint.close();
    await rm(this.root, { recursive: true, force: true });
  }
  closeSync(): void {
    this.closed = true;
    for (const child of this.children) child.terminateSync();
    this.children.clear();
    this.endpoint.closeSync();
  }
}

function unavailableCore(status: ConfinementStatus): CoreConfinement {
  const refuse = async (): Promise<never> => {
    throw new CrotError("CONFINEMENT_UNAVAILABLE", "macOS Seatbelt unavailable", { reason: status.reason });
  };
  return {
    status: () => status,
    refresh: async () => status,
    launcher: {
      resolveCommand: refuse,
      launch: refuse,
      canTerminateOrphanedDescendants: false,
      processControl: { treeTermination: "process-group", orphanedDescendants: false, gracefulTermination: false },
    },
    close: async () => undefined,
    closeSync: () => undefined,
  };
}

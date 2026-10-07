/**
 * Command confinement L1 on Linux (ARCHITECTURE.md §27 AD-20): availability
 * checks, the per-Core sandbox and its ProcessLauncher.
 *
 * Performs no authorization. ProcessService decides, inside the operation
 * the PermissionEngine already authorized, whether a command is confined,
 * refused or run as before (AD-20 point 11); this module only reports the
 * state and launches into the sandbox. A launch that fails for a sandbox
 * reason throws CONFINEMENT_FAILED and never starts the command elsewhere.
 */
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import type {
  CommandConfinement,
  CommandSpec,
  ConfinementNetwork,
  ConfinementReason,
  ConfinementScope,
  ConfinementStatus,
  CoreConfinement,
  LaunchOptions,
  ManagedProcess,
  ProcessControlInfo,
  ProcessLauncher,
  ResolveCommandOptions,
} from "../../core/platform/types.js";
import { isWithin, sandboxCommand, type SandboxLayout } from "./bwrap-args.js";
import { L1_VERSION, profileNames, verifyComponents, type ComponentFs, type L1Components } from "./components.js";
import { createUpstream, DockerEndpoint, type DockerUpstream } from "./docker-endpoint.js";
import {
  apparmorRequired,
  hostPathExists,
  readHostFacts,
  readHostFile,
  type HostExists,
  type HostReader,
} from "./host.js";
import {
  agentSockets,
  allowedDevices,
  currentContextHost,
  DAEMON_SOCKETS,
  defaultHome,
  dockerHiddenPaths,
  hiddenEntries,
  homeSubmounts,
  SECRET_STORE_DIRS,
  unixSocketOf,
} from "./layout.js";
import { hostNetworkNotes } from "./notes.js";
import { LaunchError, Sandbox, SandboxError } from "./sandbox.js";
import { ensureLayer, openStorage, StorageError, type L1Storage } from "./storage.js";

/** Process-tree guarantees of confined launches: crot-l1-init's per-command subreaper. */
export const L1_PROCESS_CONTROL: ProcessControlInfo = {
  treeTermination: "process-group",
  orphanedDescendants: true,
  gracefulTermination: true,
};

export interface LinuxConfinementOptions {
  /** The service's state directory: one L1 storage subdirectory per state directory. */
  readonly stateDir: string;
  /** The Core launcher (command resolution stays in Core). */
  readonly base: ProcessLauncher;
  /** Environment of the service (home, runtime directory, agent sockets, Docker CLI). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Report a change of availability (service log). */
  readonly log?: (line: string) => void;
  /** Test seams. */
  readonly version?: string;
  readonly componentsRoot?: string;
  readonly componentFs?: ComponentFs;
  readonly read?: HostReader;
  readonly exists?: HostExists;
  readonly storageParent?: string;
  /** Replace the verified components (tests that run an uninstalled build). */
  readonly components?: L1Components;
  /** Treat AppArmor as absent (tests on hosts without the policy). */
  readonly ignoreAppArmor?: boolean;
  /** Path of the docker executable for the endpoint's upstream. */
  readonly docker?: string;
}

const unavailable = (network: ConfinementNetwork, reason: ConfinementReason, detail: string): ConfinementStatus => ({
  mechanism: "linux-bubblewrap",
  available: false,
  network,
  reason,
  detail,
});

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 300);
/** The AppArmor label crot-l1-init reported, for a mismatch detail (a kernel profile name, never a secret). */
const observedLabel = (l: string) => JSON.stringify(oneLine(l).slice(0, 120) || "none");

/** Classify a crot-bwrap failure (its diagnostics never reach status). */
export function classifySandboxFailure(
  diagnostics: string,
  apparmorEnabled: boolean,
): { reason: ConfinementReason; detail: string } {
  const d = diagnostics.toLowerCase();
  if (d.includes("overlay"))
    return { reason: "overlay_unavailable", detail: "the private home layer cannot be mounted" };
  if (
    /(uid map|gid map|new namespace|unshare|setting up uid|clone|user namespace|creating new namespace)/.test(d) &&
    d.includes("permi")
  )
    return apparmorEnabled
      ? {
          reason: "apparmor_profile_not_loaded",
          detail: "crot-bwrap is denied its user namespace (the L1 policy is not loaded)",
        }
      : { reason: "userns_unavailable", detail: "unprivileged user namespaces are not permitted" };
  return { reason: "self_test_failed", detail: "the sandbox could not be set up" };
}

interface Prepared {
  readonly components: L1Components;
  readonly storage: L1Storage;
  readonly apparmor: boolean;
}

/** The host side of a layout: everything but the per-sandbox temp and the Docker socket. */
async function baseLayout(
  options: LinuxConfinementOptions,
  prepared: Prepared,
  scope: Pick<ConfinementScope, "workspace" | "protectedPaths" | "network">,
  homeLayer: { readonly upper: string; readonly work: string } = {
    upper: prepared.storage.homeUpper,
    work: prepared.storage.homeWork,
  },
): Promise<Omit<SandboxLayout, "temp" | "dockerSocket">> {
  const env = options.env;
  const home = defaultHome(env);
  const uid = process.getuid?.() ?? -1;
  const mountinfo = (await readFile("/proc/self/mountinfo", "utf8").catch(() => "")) as string;
  // Submounts inside the workspace are covered by the workspace bind; the others get their own private layer.
  const subs = homeSubmounts(mountinfo, home).filter((p) => !isWithin(scope.workspace, p));
  const homeSubmountsLayers = [];
  let i = 0;
  for (const p of subs) {
    const layer = await ensureLayer(prepared.storage, i++, uid);
    homeSubmountsLayers.push({ path: p, ...layer });
  }
  const runtimeDir =
    env.XDG_RUNTIME_DIR && path.posix.isAbsolute(env.XDG_RUNTIME_DIR)
      ? path.posix.resolve(env.XDG_RUNTIME_DIR)
      : undefined;
  const hidden = await hiddenEntries([
    ...scope.protectedPaths,
    ...SECRET_STORE_DIRS.map((d) => path.join(home, d)),
    ...(await dockerHiddenPaths(env, home)),
  ]);
  return {
    bwrap: prepared.components.bwrap,
    init: prepared.components.init,
    network: scope.network,
    workspace: scope.workspace,
    home,
    homeLayer,
    homeSubmounts: homeSubmountsLayers,
    ...(runtimeDir ? { runtimeDir } : {}),
    agentSockets: await agentSockets(env, home),
    devices: await allowedDevices(),
    hidden,
    emptyFile: prepared.storage.emptyFile,
    emptyDir: prepared.storage.emptyDir,
  };
}

/** Linux implementation of the platform's CommandConfinement. */
export class LinuxConfinement implements CommandConfinement {
  private readonly version: string;
  private readonly read: HostReader;
  private readonly exists: HostExists;
  private lastReported = new Map<ConfinementNetwork, string>();

  constructor(private readonly options: LinuxConfinementOptions) {
    this.version = options.version ?? L1_VERSION;
    this.read = options.read ?? readHostFile;
    this.exists = options.exists ?? hostPathExists;
  }

  /** The static checks (no sandbox). */
  private async prepare(
    network: ConfinementNetwork,
  ): Promise<{ ok: true; prepared: Prepared } | { ok: false; status: ConfinementStatus }> {
    const facts = await readHostFacts(this.version, this.read, this.exists);
    if (!facts.userns)
      return {
        ok: false,
        status: unavailable(network, "userns_unavailable", "unprivileged user namespaces are disabled"),
      };
    let components = this.options.components;
    if (!components) {
      const check = await verifyComponents(this.version, this.options.componentsRoot, this.options.componentFs);
      if (!check.ok) return { ok: false, status: unavailable(network, check.reason, check.detail) };
      components = check.components;
    }
    const apparmor = facts.apparmorEnabled && !this.options.ignoreAppArmor;
    if (!apparmor && apparmorRequired(facts, network) && !this.options.ignoreAppArmor)
      return {
        ok: false,
        status: unavailable(
          network,
          "apparmor_unavailable",
          facts.usernsRestricted
            ? "AppArmor is not enabled but restricts user namespaces"
            : "AppArmor is not enabled; network off would not need it",
        ),
      };
    if (apparmor && facts.profilesLoaded === false)
      return {
        ok: false,
        status: unavailable(network, "apparmor_profile_not_loaded", `the L1 policy ${this.version} is not loaded`),
      };
    if (apparmor && network === "on" && !facts.unixMediation)
      return {
        ok: false,
        status: unavailable(
          network,
          "apparmor_unix_mediation_unavailable",
          "the kernel does not mediate Unix sockets; network off would be available",
        ),
      };
    let storage: L1Storage;
    try {
      storage = await openStorage(
        this.options.stateDir,
        this.options.storageParent ? { parent: this.options.storageParent } : {},
      );
    } catch (error) {
      return {
        ok: false,
        status: unavailable(
          network,
          "private_storage_unavailable",
          `the L1 private storage ${error instanceof StorageError ? error.message : "cannot be created"}`,
        ),
      };
    }
    return { ok: true, prepared: { components, storage, apparmor } };
  }

  /**
   * The boundary self-test in a fresh sandbox (AD-20 point 12): it must fail
   * to read a canary in a CROT-protected path, to write outside the write
   * boundary, to connect to an abstract canary socket of the service (network
   * on) and to signal the service; it must read the home and write the
   * workspace, the private temp and the home layer.
   */
  private async selfTest(
    prepared: Prepared,
    network: ConfinementNetwork,
    workspace: string,
  ): Promise<ConfinementStatus | null> {
    const canaryKey = randomBytes(8).toString("hex");
    // Per run: several Cores of one service may check at the same time.
    const canaryDir = path.join(prepared.storage.root, `canary-${canaryKey}`);
    // A fresh home layer of its own: the shared one may be mounted by a running sandbox.
    const layerDir = path.join(prepared.storage.root, `selftest-${canaryKey}`);
    const selfLayer = { upper: path.join(layerDir, "upper"), work: path.join(layerDir, "work") };
    const canary = path.join(canaryDir, `secret-${canaryKey}`);
    const homeProbe = `.crot-l1-selftest-${canaryKey}`;
    const home = defaultHome(this.options.env);
    let abstract: net.Server | undefined;
    const abstractName = `crot-l1-canary-${canaryKey}`;
    let sandbox: Sandbox | undefined;
    let temp: Awaited<ReturnType<L1Storage["newTemp"]>> | undefined;
    try {
      await rm(canaryDir, { recursive: true, force: true });
      await mkdir(canaryDir, { mode: 0o700 });
      await mkdir(selfLayer.upper, { recursive: true, mode: 0o700 });
      await mkdir(selfLayer.work, { recursive: true, mode: 0o700 });
      await writeFile(canary, "canary", { mode: 0o600 });
      if (network === "on") {
        abstract = net.createServer((s) => s.destroy());
        await new Promise<void>((resolve, reject) => {
          abstract!.once("error", reject);
          abstract!.listen(`\0${abstractName}`, () => resolve());
        });
      }
      temp = await prepared.storage.newTemp();
      const layout: SandboxLayout = {
        ...(await baseLayout(this.options, prepared, { workspace, protectedPaths: [canaryDir], network }, selfLayer)),
        temp,
      };
      try {
        sandbox = await Sandbox.start(sandboxCommand(layout));
      } catch (error) {
        const diag = error instanceof SandboxError ? error.diagnostics : "";
        const c = classifySandboxFailure(diag, prepared.apparmor);
        return unavailable(network, c.reason, c.detail);
      }
      const { label } = profileNames(this.version);
      if (prepared.apparmor && sandbox.label !== label)
        return unavailable(
          network,
          "apparmor_profile_not_loaded",
          `the sandbox does not run under the L1 policy ${this.version} (its label: ${observedLabel(sandbox.label)})`,
        );
      const ops = [
        `read-deny:${canary}`,
        `read-deny:${canaryDir}`,
        "write-deny:/usr",
        "write-deny:/etc",
        `signal-deny:${process.pid}`,
        `read-allow:${home}`,
        `write-allow:${workspace}`,
        "write-allow:/tmp",
        "write-allow:/var/tmp",
        `write-allow:${home}`,
        ...(network === "on" ? [`abstract-deny:${abstractName}`] : []),
        ...(prepared.apparmor ? [`label:${label}`] : []),
      ];
      const lines = await sandbox.selftest(ops);
      const failed = lines.filter((l) => l.startsWith("FAIL"));
      if (lines.length !== ops.length || failed.length > 0) {
        const what = failed.map((l) => l.split(" ")[1]).join(", ") || "incomplete report";
        return unavailable(network, "self_test_failed", `the boundary self-test failed (${what})`);
      }
      // The home layer: a write in the sandbox's home lands in the private layer, never in the real home.
      const probe = await sandbox.launch(
        "/bin/sh",
        ["-c", `echo x > "$1"`, "sh", path.join(home, homeProbe)],
        workspace,
        {},
        false,
      );
      await probe.exited;
      await probe.terminate("force");
      const leaked = existsSync(path.join(home, homeProbe));
      const layered = existsSync(path.join(selfLayer.upper, homeProbe));
      if (leaked) {
        await rm(path.join(home, homeProbe), { force: true });
        return unavailable(
          network,
          "self_test_failed",
          "the boundary self-test failed (a home write reached the real home)",
        );
      }
      if (!layered)
        return unavailable(network, "overlay_unavailable", "the private home layer does not receive home writes");
      return null;
    } catch (error) {
      return unavailable(
        network,
        "self_test_failed",
        `the boundary self-test failed (${oneLine((error as Error).message)})`,
      );
    } finally {
      await sandbox?.close();
      abstract?.close();
      await temp?.remove();
      await rm(canaryDir, { recursive: true, force: true }).catch(() => undefined);
      // The overlay work directory holds a mode-0000 "work" entry: make it removable first.
      await chmod(path.join(selfLayer.work, "work"), 0o700).catch(() => undefined);
      await rm(layerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Run every check of AD-20 point 12 in order; the first failing check is the reason. */
  async check(
    network: ConfinementNetwork,
    workspace?: string,
  ): Promise<{ status: ConfinementStatus; prepared?: Prepared }> {
    const pre = await this.prepare(network);
    if (!pre.ok) return this.report(pre.status);
    const ws = workspace ?? path.join(pre.prepared.storage.root, "selftest-workspace");
    if (!workspace) await mkdir(ws, { recursive: true, mode: 0o700 });
    const failure = await this.selfTest(pre.prepared, network, ws);
    if (failure) return this.report(failure);
    return this.report(
      { mechanism: "linux-bubblewrap", available: true, network, reason: null, detail: null },
      pre.prepared,
    );
  }

  private report(status: ConfinementStatus, prepared?: Prepared): { status: ConfinementStatus; prepared?: Prepared } {
    const key = `${status.available}:${status.reason ?? ""}`;
    if (this.lastReported.get(status.network) !== key) {
      this.lastReported.set(status.network, key);
      this.options.log?.(
        status.available
          ? `confinement: L1 available (network ${status.network})`
          : `confinement: L1 unavailable (network ${status.network}): ${status.reason}${status.detail ? ` - ${status.detail}` : ""}`,
      );
    }
    return prepared ? { status, prepared } : { status };
  }

  async probe(network: ConfinementNetwork): Promise<ConfinementStatus> {
    return (await this.check(network)).status;
  }

  async open(scope: ConfinementScope): Promise<CoreConfinement> {
    const core = new LinuxCoreConfinement(this, this.options, scope);
    await core.refresh();
    return core;
  }
}

/** Resolve the daemon host the service's Docker CLI uses (no connection is made). */
async function resolveDockerHost(
  env: Readonly<Record<string, string>>,
  home: string,
): Promise<{ host: string; tls: boolean }> {
  if (env.DOCKER_HOST) return { host: env.DOCKER_HOST, tls: Boolean(env.DOCKER_TLS_VERIFY) || Boolean(env.DOCKER_TLS) };
  const fromContext = await currentContextHost(env, home);
  if (fromContext) return { host: fromContext, tls: false };
  return { host: "unix:///var/run/docker.sock", tls: false };
}

/** The confinement of one Core: one sandbox, its Docker endpoint, its launcher. */
class LinuxCoreConfinement implements CoreConfinement {
  private current: ConfinementStatus;
  private prepared: Prepared | undefined;
  private sandbox: Sandbox | undefined;
  private starting: Promise<Sandbox> | undefined;
  private temp: Awaited<ReturnType<L1Storage["newTemp"]>> | undefined;
  private endpoint: DockerEndpoint | undefined;
  private upstream: DockerUpstream | undefined;
  private closed = false;
  private notes: string[] = [];
  readonly launcher: ProcessLauncher;

  constructor(
    private readonly owner: LinuxConfinement,
    private readonly options: LinuxConfinementOptions,
    private readonly scope: ConfinementScope,
  ) {
    this.current = unavailable(scope.network, "self_test_failed", "the checks have not run yet");
    const base = options.base;
    this.launcher = {
      resolveCommand: (command: string, args: readonly string[], o: ResolveCommandOptions): Promise<CommandSpec> =>
        base.resolveCommand(command, args, o),
      launch: (spec, o) => this.launch(spec, o),
      canTerminateOrphanedDescendants: true,
      processControl: L1_PROCESS_CONTROL,
    };
  }

  status(): ConfinementStatus {
    if (!this.current.available) return this.current;
    return this.notes.length > 0
      ? { ...this.current, detail: oneLine(`host network: ${this.notes.join("; ")}`) }
      : this.current;
  }

  async refresh(): Promise<ConfinementStatus> {
    if (this.closed) return this.current;
    const { status, prepared } = await this.owner.check(this.scope.network, this.scope.workspace);
    this.current = status;
    this.prepared = prepared;
    if (status.available && status.network === "on") {
      this.notes = await hostNetworkNotes(
        {
          ...(this.upstream
            ? {
                docker: {
                  transport: this.upstream.transport,
                  local: this.upstream.local,
                  ...(this.upstream.port !== undefined ? { port: this.upstream.port } : {}),
                  ...(this.endpoint ? { apparmor: await this.endpoint.daemonSupportsAppArmor() } : {}),
                },
              }
            : {}),
          ...(this.options.env.XDG_RUNTIME_DIR ? { runtimeDir: this.options.env.XDG_RUNTIME_DIR } : {}),
        },
        this.options.read ?? readHostFile,
        this.options.exists ?? hostPathExists,
      ).catch(() => []);
    }
    return this.status();
  }

  private failed(message: string): CrotError {
    return new CrotError(
      "CONFINEMENT_FAILED",
      `Command confinement L1 failed: ${message}. The command was not started.`,
    );
  }

  private async startEndpoint(prepared: Prepared): Promise<DockerEndpoint> {
    const home = defaultHome(this.options.env);
    const env = this.scope.dockerEnvironment;
    const { host, tls } = await resolveDockerHost(env, home);
    const upstream = createUpstream({ host, tls, env, docker: this.options.docker ?? "docker" });
    this.upstream = upstream;
    const socketPath = path.join(prepared.storage.run, `docker-${randomBytes(6).toString("hex")}.sock`);
    const resolve = upstream.local
      ? (p: string) => {
          try {
            return realpathSync(p);
          } catch {
            return p;
          }
        }
      : undefined;
    const upstreamSocket = unixSocketOf(host);
    const unreadable = [
      "/tmp",
      "/var/tmp",
      "/proc",
      ...(this.options.env.XDG_RUNTIME_DIR ? [this.options.env.XDG_RUNTIME_DIR] : []),
      ...SECRET_STORE_DIRS.map((d) => path.join(home, d)),
      ...(await dockerHiddenPaths(this.options.env, home)),
    ];
    return DockerEndpoint.start({
      socketPath,
      upstream,
      containerProfile: profileNames(prepared.components.version).container,
      boundary: {
        writable: [this.scope.workspace, prepared.storage.root],
        protectedPaths: this.scope.protectedPaths,
        unreadable,
        daemonSockets: [...DAEMON_SOCKETS, ...(upstreamSocket ? [upstreamSocket] : [])],
        endpointSocket: socketPath,
        ...(resolve ? { resolve } : {}),
      },
      onRefusal: (request, reason) => this.scope.audit({ event: "confinement.docker_refused", request, reason }),
    });
  }

  private async ensureSandbox(): Promise<Sandbox> {
    if (this.sandbox?.running) return this.sandbox;
    this.starting ??= (async () => {
      if (!this.prepared || !this.current.available) {
        await this.refresh();
        if (!this.prepared || !this.current.available)
          throw this.failed(`L1 is no longer available (${this.current.reason ?? "unknown"})`);
      }
      const prepared = this.prepared;
      this.endpoint ??= await this.startEndpoint(prepared);
      await this.temp?.remove();
      this.temp = await prepared.storage.newTemp();
      const layout: SandboxLayout = {
        ...(await baseLayout(this.options, prepared, this.scope)),
        temp: this.temp,
        dockerSocket: this.endpoint.socketPath,
      };
      let sandbox: Sandbox;
      try {
        sandbox = await Sandbox.start(sandboxCommand(layout), () => {
          // A sandbox that ends while CROT runs is a sandbox failure: check availability again.
          if (!this.closed) void this.refresh();
        });
      } catch (error) {
        void this.refresh();
        throw this.failed(error instanceof SandboxError ? error.message : "the sandbox could not be started");
      }
      const { label } = profileNames(prepared.components.version);
      if (prepared.apparmor && sandbox.label !== label) {
        await sandbox.close();
        void this.refresh();
        throw this.failed(`the sandbox does not run under the L1 policy (its label: ${observedLabel(sandbox.label)})`);
      }
      this.sandbox = sandbox;
      return sandbox;
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Environment of a confined child: Docker goes through the endpoint (AD-20 point 9). */
  private childEnv(env: Readonly<Record<string, string>>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (
        k === "DOCKER_CONTEXT" ||
        k === "DOCKER_TLS_VERIFY" ||
        k === "DOCKER_CERT_PATH" ||
        k === "DOCKER_TLS" ||
        k === "DOCKER_HOST"
      )
        continue;
      out[k] = v;
    }
    if (this.endpoint) out.DOCKER_HOST = `unix://${this.endpoint.socketPath}`;
    return out;
  }

  private async launch(spec: CommandSpec, options: LaunchOptions): Promise<ManagedProcess> {
    if (this.closed) throw this.failed("the Core's sandbox has been closed");
    const sandbox = await this.ensureSandbox();
    const env = this.childEnv({ ...options.env, ...(spec.env ?? {}) });
    try {
      return await sandbox.launch(spec.file, spec.args, options.cwd, env, options.stdin);
    } catch (error) {
      if (error instanceof LaunchError) {
        // exec inside the sandbox failed: the command's own problem, not the sandbox's.
        if (error.errno === 2 || error.errno === 20)
          throw new CrotError("NOT_FOUND", `Executable not found in the confined view: ${spec.display}`);
        throw new CrotError("OPERATION_FAILED", `Failed to start ${spec.display} (errno ${error.errno}).`);
      }
      void this.refresh();
      throw this.failed(error instanceof Error ? error.message : String(error));
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.starting?.catch(() => undefined);
    await this.sandbox?.close();
    await this.endpoint?.close().catch(() => undefined);
    await this.temp?.remove().catch(() => undefined);
  }

  closeSync(): void {
    this.closed = true;
    this.sandbox?.kill();
    this.endpoint?.closeSync();
  }
}

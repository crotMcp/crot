import path from "node:path";
import type { ServiceStatus } from "./service-status.js";
import { ApprovalBroker } from "./approvals/broker.js";
import { ExposureTracker, type UntrustedContentSetting } from "./approvals/exposure.js";
import { RemoteExposureStore } from "./approvals/remote-exposure.js";
import type { ApprovalProvider, ApprovalRuleId } from "./approvals/types.js";
import { JsonlFileAuditSink, NullAuditSink, StreamAuditSink, type AuditSink } from "./audit/audit.js";
import type { BrowserConnection } from "./capabilities/browser/connection.js";
import type { BrowserBridgeState } from "./capabilities/browser/schemas.js";
import { BrowserService } from "./capabilities/browser/service.js";
import { DockerService } from "./capabilities/docker/service.js";
import { FileSystemService } from "./capabilities/filesystem/service.js";
import { GitMetadataLock } from "./capabilities/git/metadata-lock.js";
import { GitService } from "./capabilities/git/service.js";
import { NetworkService } from "./capabilities/network/service.js";
import { ProcessService } from "./capabilities/process/service.js";
import { parseConfig } from "./config/load.js";
import { expandHome } from "./config/paths.js";
import type { AuditConfig, CrotConfig, Limits } from "./config/schema.js";
import { CrotError } from "./errors.js";
import { ExecutionGuard } from "./execution/guard.js";
import { CAPABILITIES, ENFORCED_CAPABILITIES, type Capability } from "./permissions/capabilities.js";
import { PermissionEngine } from "./permissions/engine.js";
import { NetworkPolicy, type NetworkPolicySummary } from "./permissions/network/policy.js";
import { createPermissionPolicy, type PermissionMode } from "./permissions/policy.js";
import { DEFAULT_AUDIT_FILE_NAME } from "./platform/directories.js";
import { createChildEnvironment, type ChildEnvironmentSummary } from "./platform/child-environment.js";
import { createNodePlatform } from "./platform/node-platform.js";
import type { Platform, PlatformInfo, PrivateFileProtection, PrivateFileStatus } from "./platform/types.js";
import { Workspace, type WorkspaceInfo } from "./workspace/workspace.js";

export interface CrotStatus {
  readonly version: string;
  readonly mode: PermissionMode;
  readonly workspace: WorkspaceInfo;
  readonly capabilities: readonly { capability: Capability; granted: boolean; enforced: boolean }[];
  readonly limits: Limits;
  readonly audit: {
    readonly sink: AuditConfig["sink"];
    readonly path?: string;
    readonly protection?: PrivateFileStatus;
  };
  readonly platform: PlatformInfo;
  /** Paths CROT tools may never modify (audit log, configuration). */
  readonly protectedPaths: readonly string[];
  /** Paths holding CROT secrets: CROT tools may neither read nor modify them, in any mode (AD-18). */
  readonly secretPaths: readonly string[];
  /** Environment of process-tool children: allowlist summary, no values (AD-18). */
  readonly childEnvironment: ChildEnvironmentSummary;
  /** Browser bridge state (no browser data). */
  readonly browser: { readonly state: BrowserBridgeState };
  /** Host policy of network.access (rules as configured). */
  readonly network: NetworkPolicySummary;
  /** Approval gates: configured rules and whether an approval UI is registered (never pending requests). */
  readonly approvals: {
    readonly rules: readonly ApprovalRuleId[];
    readonly timeoutMs: number;
    readonly maxPending: number;
    readonly providers: number;
    /** The built-in untrusted-content rule (AD-12). */
    readonly untrustedContent: UntrustedContentSetting;
    readonly note?: string;
  };
  /** The supervised service running this Core (WP-20); absent when Core is embedded without a service. */
  readonly service?: ServiceStatus;
}

export const CORE_VERSION = "0.1.0";

/** How long shutdown waits for operations in flight to finish and be audited. */
const SHUTDOWN_DRAIN_MS = 2_000;

export interface CrotCoreOptions {
  /** Override the audit sink derived from configuration (embedding, tests). */
  readonly auditSink?: AuditSink;
  /** Receives audit sink failures. Defaults to a message on stderr. */
  readonly onAuditError?: (error: unknown) => void;
  /** Platform implementation (defaults to the Node.js platform for the host OS). */
  readonly platform?: Platform;
  /** Additional files CROT tools must never modify, e.g. the configuration file in use. */
  readonly protectedPaths?: readonly string[];
  /**
   * Files and directories holding CROT secrets (secret store files, legacy
   * token files; AD-18). No CROT operation may read, list into, mount or
   * modify them, in any mode; they are also protected paths.
   */
  readonly secretPaths?: readonly string[];
  /**
   * Connection to the CROT Browser Extension (the browser bridge). Omitted
   * when browser support is disabled. Core only sends authorized requests
   * through it; the bridge cannot call into Core.
   */
  readonly browser?: BrowserConnection;
  /**
   * Approval providers: UIs that ask the local user to approve gated
   * operations (the tray app). Registered only here; no adapter, browser
   * bridge or tool can reach the approval broker. Without a provider every
   * operation matched by a permissions.approvals rule is denied.
   */
  readonly approvalProviders?: readonly ApprovalProvider[];
  /**
   * File in CROT's private state that keeps the exposure of remote scopes
   * across restarts (ARCHITECTURE.md §27, AD-15 point 8). It becomes a
   * protected path. When it cannot be read, every remote scope is exposed.
   */
  readonly remoteExposureFile?: string;
  /**
   * A ready remote exposure store (tests, embedding); takes precedence over
   * remoteExposureFile. Without either, every remote scope is treated as
   * exposed (fail closed).
   */
  readonly remoteExposure?: RemoteExposureStore;
  /**
   * State of the hosting service for crot_status (WP-20). Read-only
   * information supplied by the host; Core never acts on it.
   */
  readonly serviceStatus?: () => ServiceStatus;
}

/**
 * CROT Core: the composition root of the product layer.
 *
 * Adapters (MCP today; Native Host and others later) receive a CrotCore and
 * call its services. They never construct services or make permission
 * decisions themselves.
 */
export class CrotCore {
  private constructor(
    readonly config: CrotConfig,
    readonly workspace: Workspace,
    readonly permissions: PermissionEngine,
    readonly guard: ExecutionGuard,
    readonly filesystem: FileSystemService,
    readonly processes: ProcessService,
    readonly git: GitService,
    readonly docker: DockerService,
    readonly browser: BrowserService,
    readonly network: NetworkService,
    readonly platform: Platform,
    private readonly approvalBroker: ApprovalBroker,
    private readonly audit: AuditSink,
    private readonly auditProtection: PrivateFileStatus | undefined,
    private readonly serviceStatus: (() => ServiceStatus) | undefined,
    private readonly childEnvironment: ChildEnvironmentSummary,
  ) {}

  private shuttingDown: Promise<void> | undefined;

  static async create(configInput: unknown, options: CrotCoreOptions = {}): Promise<CrotCore> {
    const parsed = parseConfig(configInput);
    let config: CrotConfig = {
      ...parsed,
      workspace: { ...parsed.workspace, root: expandHome(parsed.workspace.root) },
      audit: parsed.audit.path ? { ...parsed.audit, path: path.resolve(expandHome(parsed.audit.path)) } : parsed.audit,
    };
    const platform = options.platform ?? (await createNodePlatform({ startupPath: config.environment.path }));
    if (config.audit.sink === "file" && !config.audit.path) {
      // Default audit file in the OS-conventional logs directory.
      config = {
        ...config,
        audit: { ...config.audit, path: path.join(platform.info.directories.logs, DEFAULT_AUDIT_FILE_NAME) },
      };
    }
    const workspace = await Workspace.open(config.workspace.root, {
      ...(config.workspace.name ? { name: config.workspace.name } : {}),
      rules: platform.paths,
      probeCaseSensitivity: (d) => platform.probeCaseSensitivity(d),
    });
    const policy = createPermissionPolicy(
      config.permissions.capabilities
        ? { mode: config.permissions.mode, capabilities: config.permissions.capabilities }
        : { mode: config.permissions.mode },
    );
    // Validated before anything is opened: an invalid rule is a configuration error.
    const networkPolicy = NetworkPolicy.create(config.permissions.network, config.permissions.mode);
    const audit = options.auditSink ?? createAuditSink(config.audit, platform.privateFiles);
    const auditFile =
      audit instanceof JsonlFileAuditSink ? audit.file : config.audit.sink === "file" ? config.audit.path : undefined;
    const auditProtection = auditFile ? await platform.privateFiles.inspect(auditFile) : undefined;
    const remoteExposureFile = options.remoteExposureFile ? path.resolve(options.remoteExposureFile) : undefined;
    const guarded = [
      ...(options.protectedPaths ?? []),
      ...(remoteExposureFile ? [remoteExposureFile] : []),
      ...(config.audit.sink === "file" && config.audit.path ? [config.audit.path] : []),
      ...(audit instanceof JsonlFileAuditSink ? [audit.file] : []),
    ];
    const resolveAll = async (paths: readonly string[]) => [
      ...new Set(await Promise.all(paths.map(async (p) => (await workspace.resolve(path.resolve(p))).absolute))),
    ];
    const secretPaths = await resolveAll(options.secretPaths ?? []);
    const protectedPaths = await resolveAll([...guarded, ...secretPaths]);
    const permissions = new PermissionEngine(policy, {
      protectedPaths,
      secretPaths,
      contains: (a, c) => workspace.contains(a, c),
      network: networkPolicy,
      approvals: {
        rules: config.permissions.approvals.rules,
        timeoutMs: config.permissions.approvals.timeoutMs,
        untrustedContent: config.permissions.approvals.untrustedContent,
      },
    });
    const remoteExposure =
      options.remoteExposure ??
      (remoteExposureFile
        ? await RemoteExposureStore.open(remoteExposureFile, platform.privateFiles, {
            onError: (e) =>
              process.stderr.write(`crot: remote exposure state: ${e instanceof Error ? e.message : String(e)}\n`),
          })
        : undefined);
    const approvalBroker = new ApprovalBroker({ maxPending: config.permissions.approvals.maxPending });
    for (const provider of options.approvalProviders ?? []) approvalBroker.register(provider);
    const guard = new ExecutionGuard(permissions, audit, {
      approvals: approvalBroker,
      exposure: new ExposureTracker(remoteExposure ? { remote: remoteExposure } : {}),
      // Step 4 of a gated operation: every path must still resolve to the same place.
      revalidatePath: async (p) => {
        const again = await workspace.resolve(p.absolute, { followFinalSymlink: false });
        return again.absolute === p.absolute && again.insideWorkspace === p.insideWorkspace;
      },
      onAuditError:
        options.onAuditError ?? ((e) => process.stderr.write(`crot: audit write failed: ${(e as Error).message}\n`)),
    });
    // Git operations and CROT writes into the Git directories they use never run at the same time
    // (AD-1 point 6, AD-2); git.write operations on one repository are also serialized.
    const gitLock = new GitMetadataLock((a, c) => workspace.contains(a, c));
    const filesystem = new FileSystemService({ workspace, guard, limits: config.limits, gitLock });
    // Children of process tools and Git start from the allowlisted environment (AD-18); Docker keeps its own list (AD-3).
    const childEnvironment = createChildEnvironment(
      platform.baseEnvironment,
      config.environment.allow,
      platform.environment.caseInsensitive,
    );
    const processes = new ProcessService({
      workspace,
      guard,
      platform,
      limits: config.limits,
      baseEnv: childEnvironment.base,
    });
    const git = new GitService({
      workspace,
      guard,
      platform,
      limits: config.limits,
      lock: gitLock,
      baseEnv: childEnvironment.base,
    });
    const docker = new DockerService({
      workspace,
      guard,
      platform,
      limits: config.limits,
      protectedPaths,
      secretPaths,
    });
    const browser = new BrowserService({
      guard,
      limits: config.limits,
      ...(options.browser ? { connection: options.browser } : {}),
    });
    const network = new NetworkService({ guard, limits: config.limits });
    return new CrotCore(
      config,
      workspace,
      permissions,
      guard,
      filesystem,
      processes,
      git,
      docker,
      browser,
      network,
      platform,
      approvalBroker,
      audit,
      auditProtection,
      options.serviceStatus,
      childEnvironment.summary,
    );
  }

  /**
   * Release resources, in order: cancel every pending approval request (so
   * none uses up the drain window and none can be approved afterwards); stop accepting browser operations and cancel
   * those waiting for the browser; abort network requests in flight; stop accepting commands and terminate every
   * process tree CROT started (including running Git and Docker commands); wait for
   * operations in flight to write their audit records; flush and close the
   * audit sink. Idempotent.
   *
   * The browser bridge itself is closed by the host after this returns.
   */
  shutdown(): Promise<void> {
    this.shuttingDown ??= (async () => {
      this.approvalBroker.cancelAll("shutdown");
      this.browser.shutdown();
      this.network.shutdown();
      await this.processes.shutdown();
      await this.git.shutdown();
      await this.docker.shutdown();
      await this.guard.drain(SHUTDOWN_DRAIN_MS);
      await this.audit.close?.();
    })();
    return this.shuttingDown;
  }

  /**
   * Last-resort cleanup when the host process exits without a completed
   * shutdown (fatal error, second signal, timeout): forced, synchronous
   * termination of every process tree CROT started. Safe to call repeatedly.
   */
  terminateProcessesSync(): void {
    this.processes.terminateAllSync();
    this.git.terminateAllSync();
    this.docker.terminateAllSync();
  }

  status(): CrotStatus {
    return {
      version: CORE_VERSION,
      mode: this.permissions.mode,
      workspace: this.workspace.info(),
      capabilities: CAPABILITIES.map((capability) => ({
        capability,
        granted: this.permissions.isGranted(capability),
        enforced: ENFORCED_CAPABILITIES.has(capability),
      })),
      limits: this.config.limits,
      audit: {
        sink: this.config.audit.sink,
        ...(this.config.audit.path ? { path: this.config.audit.path } : {}),
        ...(this.auditProtection ? { protection: this.auditProtection } : {}),
      },
      platform: this.platform.info,
      protectedPaths: this.permissions.protected,
      secretPaths: this.permissions.secrets,
      childEnvironment: this.childEnvironment,
      browser: { state: this.browser.state() },
      network: this.permissions.network.summary(),
      approvals: this.approvalStatus(),
      ...(this.serviceStatus ? { service: this.serviceStatus() } : {}),
    };
  }

  private approvalStatus(): CrotStatus["approvals"] {
    const { rules, timeoutMs, untrustedContent } = this.permissions.approvals;
    const providers = this.approvalBroker.providerCount;
    const notes: string[] = [];
    if (rules.length > 0 && providers === 0)
      notes.push(
        "Approval rules are configured but no approval UI is registered: operations matched by them are denied.",
      );
    const sourceGranted = this.permissions.isGranted("browser.read") || this.permissions.isGranted("network.access");
    if (untrustedContent === "require-approval" && providers === 0 && sourceGranted)
      notes.push(
        "No approval UI is registered: after a session reads a web page, screenshot, tab list or network response, " +
          "its operations with effects are denied (permissions.approvals.untrustedContent).",
      );
    return {
      rules: rules.map((r) => r.id),
      timeoutMs,
      maxPending: this.config.permissions.approvals.maxPending,
      providers,
      untrustedContent,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
  }
}

function createAuditSink(config: AuditConfig, protection: PrivateFileProtection): AuditSink {
  switch (config.sink) {
    case "none":
      return new NullAuditSink();
    case "stderr":
      return new StreamAuditSink(process.stderr);
    case "file":
      if (!config.path) throw new CrotError("CONFIG_ERROR", "audit.path is required for the file sink."); // resolved by create()
      return new JsonlFileAuditSink(config.path, protection);
  }
}

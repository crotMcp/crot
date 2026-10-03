import path from "node:path";
import { JsonlFileAuditSink, NullAuditSink, StreamAuditSink, type AuditSink } from "./audit/audit.js";
import type { BrowserConnection } from "./capabilities/browser/connection.js";
import type { BrowserBridgeState } from "./capabilities/browser/schemas.js";
import { BrowserService } from "./capabilities/browser/service.js";
import { FileSystemService } from "./capabilities/filesystem/service.js";
import { GitMetadataLock } from "./capabilities/git/metadata-lock.js";
import { GitService } from "./capabilities/git/service.js";
import { ProcessService } from "./capabilities/process/service.js";
import { parseConfig } from "./config/load.js";
import { expandHome } from "./config/paths.js";
import type { AuditConfig, CrotConfig, Limits } from "./config/schema.js";
import { CrotError } from "./errors.js";
import { ExecutionGuard } from "./execution/guard.js";
import { CAPABILITIES, ENFORCED_CAPABILITIES, type Capability } from "./permissions/capabilities.js";
import { PermissionEngine } from "./permissions/engine.js";
import { createPermissionPolicy, type PermissionMode } from "./permissions/policy.js";
import { DEFAULT_AUDIT_FILE_NAME } from "./platform/directories.js";
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
  /** Browser bridge state (no browser data). */
  readonly browser: { readonly state: BrowserBridgeState };
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
   * Connection to the CROT Browser Extension (the browser bridge). Omitted
   * when browser support is disabled. Core only sends authorized requests
   * through it; the bridge cannot call into Core.
   */
  readonly browser?: BrowserConnection;
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
    readonly browser: BrowserService,
    readonly platform: Platform,
    private readonly audit: AuditSink,
    private readonly auditProtection: PrivateFileStatus | undefined,
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
    const audit = options.auditSink ?? createAuditSink(config.audit, platform.privateFiles);
    const auditFile =
      audit instanceof JsonlFileAuditSink ? audit.file : config.audit.sink === "file" ? config.audit.path : undefined;
    const auditProtection = auditFile ? await platform.privateFiles.inspect(auditFile) : undefined;
    const guarded = [
      ...(options.protectedPaths ?? []),
      ...(config.audit.sink === "file" && config.audit.path ? [config.audit.path] : []),
      ...(audit instanceof JsonlFileAuditSink ? [audit.file] : []),
    ];
    const protectedPaths = [
      ...new Set(await Promise.all(guarded.map(async (p) => (await workspace.resolve(path.resolve(p))).absolute))),
    ];
    const permissions = new PermissionEngine(policy, { protectedPaths, contains: (a, c) => workspace.contains(a, c) });
    const guard = new ExecutionGuard(permissions, audit, {
      onAuditError:
        options.onAuditError ?? ((e) => process.stderr.write(`crot: audit write failed: ${(e as Error).message}\n`)),
    });
    // git.read and CROT writes into the Git directories it reads never run at the same time (AD-1, point 6).
    const gitLock = new GitMetadataLock((a, c) => workspace.contains(a, c));
    const filesystem = new FileSystemService({ workspace, guard, limits: config.limits, gitLock });
    const processes = new ProcessService({ workspace, guard, platform, limits: config.limits });
    const git = new GitService({ workspace, guard, platform, limits: config.limits, lock: gitLock });
    const browser = new BrowserService({
      guard,
      limits: config.limits,
      ...(options.browser ? { connection: options.browser } : {}),
    });
    return new CrotCore(
      config,
      workspace,
      permissions,
      guard,
      filesystem,
      processes,
      git,
      browser,
      platform,
      audit,
      auditProtection,
    );
  }

  /**
   * Release resources, in order: stop accepting browser operations and cancel
   * those waiting for the browser; stop accepting commands and terminate every
   * process tree CROT started (including running Git commands); wait for
   * operations in flight to write their audit records; flush and close the
   * audit sink. Idempotent.
   *
   * The browser bridge itself is closed by the host after this returns.
   */
  shutdown(): Promise<void> {
    this.shuttingDown ??= (async () => {
      this.browser.shutdown();
      await this.processes.shutdown();
      await this.git.shutdown();
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
      browser: { state: this.browser.state() },
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

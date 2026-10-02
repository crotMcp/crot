import path from "node:path";
import { JsonlFileAuditSink, NullAuditSink, StreamAuditSink, type AuditSink } from "./audit/audit.js";
import { FileSystemService } from "./capabilities/filesystem/service.js";
import { ProcessService } from "./capabilities/process/service.js";
import { parseConfig } from "./config/load.js";
import { expandHome } from "./config/paths.js";
import type { AuditConfig, CrotConfig, Limits } from "./config/schema.js";
import { CrotError } from "./errors.js";
import { ExecutionGuard } from "./execution/guard.js";
import { CAPABILITIES, ENFORCED_CAPABILITIES, type Capability } from "./permissions/capabilities.js";
import { PermissionEngine } from "./permissions/engine.js";
import { createPermissionPolicy, type PermissionMode } from "./permissions/policy.js";
import { createNodePlatform } from "./platform/node-platform.js";
import type { Platform, PlatformInfo } from "./platform/types.js";
import { Workspace, type WorkspaceInfo } from "./workspace/workspace.js";

export interface CrotStatus {
  readonly version: string;
  readonly mode: PermissionMode;
  readonly workspace: WorkspaceInfo;
  readonly capabilities: readonly { capability: Capability; granted: boolean; enforced: boolean }[];
  readonly limits: Limits;
  readonly audit: { readonly sink: AuditConfig["sink"]; readonly path?: string };
  readonly platform: PlatformInfo;
  /** Paths CROT tools may never modify (audit log, configuration). */
  readonly protectedPaths: readonly string[];
}

export const CORE_VERSION = "0.1.0";

export interface CrotCoreOptions {
  /** Override the audit sink derived from configuration (embedding, tests). */
  readonly auditSink?: AuditSink;
  /** Receives audit sink failures. Defaults to a message on stderr. */
  readonly onAuditError?: (error: unknown) => void;
  /** Platform implementation (defaults to the Node.js platform for the host OS). */
  readonly platform?: Platform;
  /** Additional files CROT tools must never modify, e.g. the configuration file in use. */
  readonly protectedPaths?: readonly string[];
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
    readonly platform: Platform,
    private readonly audit: AuditSink,
  ) {}

  static async create(configInput: unknown, options: CrotCoreOptions = {}): Promise<CrotCore> {
    const parsed = parseConfig(configInput);
    const config: CrotConfig = {
      ...parsed,
      workspace: { ...parsed.workspace, root: expandHome(parsed.workspace.root) },
      audit: parsed.audit.path ? { ...parsed.audit, path: path.resolve(expandHome(parsed.audit.path)) } : parsed.audit,
    };
    const platform = options.platform ?? (await createNodePlatform({ startupPath: config.environment.path }));
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
    const audit = options.auditSink ?? createAuditSink(config.audit);
    const guarded = [
      ...(options.protectedPaths ?? []),
      ...(config.audit.sink === "file" && config.audit.path ? [config.audit.path] : []),
      ...(audit instanceof JsonlFileAuditSink ? [audit.file] : []),
    ];
    const protectedPaths = [...new Set(await Promise.all(guarded.map(async (p) => (await workspace.resolve(path.resolve(p))).absolute)))];
    const permissions = new PermissionEngine(policy, { protectedPaths, contains: (a, c) => workspace.contains(a, c) });
    const guard = new ExecutionGuard(permissions, audit, {
      onAuditError: options.onAuditError ?? ((e) => process.stderr.write(`crot: audit write failed: ${(e as Error).message}\n`)),
    });
    const filesystem = new FileSystemService({ workspace, guard, limits: config.limits });
    const processes = new ProcessService({ workspace, guard, platform, limits: config.limits });
    return new CrotCore(config, workspace, permissions, guard, filesystem, processes, platform, audit);
  }

  /** Release resources: terminate background processes and flush the audit log. */
  async shutdown(): Promise<void> {
    await this.processes.shutdown();
    await this.audit.close?.();
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
      audit: { sink: this.config.audit.sink, ...(this.config.audit.path ? { path: this.config.audit.path } : {}) },
      platform: this.platform.info,
      protectedPaths: this.permissions.protected,
    };
  }
}

function createAuditSink(config: AuditConfig): AuditSink {
  switch (config.sink) {
    case "none":
      return new NullAuditSink();
    case "stderr":
      return new StreamAuditSink(process.stderr);
    case "file":
      if (!config.path) throw new CrotError("CONFIG_ERROR", "audit.path is required for the file sink.");
      return new JsonlFileAuditSink(config.path);
  }
}

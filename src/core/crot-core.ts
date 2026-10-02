import { FileSystemService } from "./capabilities/filesystem/service.js";
import { parseConfig } from "./config/load.js";
import type { CrotConfig, Limits } from "./config/schema.js";
import { ExecutionGuard } from "./execution/guard.js";
import { CAPABILITIES, ENFORCED_CAPABILITIES, type Capability } from "./permissions/capabilities.js";
import { PermissionEngine } from "./permissions/engine.js";
import { createPermissionPolicy, type PermissionMode } from "./permissions/policy.js";
import { Workspace, type WorkspaceInfo } from "./workspace/workspace.js";

export interface CrotStatus {
  readonly version: string;
  readonly mode: PermissionMode;
  readonly workspace: WorkspaceInfo;
  readonly capabilities: readonly { capability: Capability; granted: boolean; enforced: boolean }[];
  readonly limits: Limits;
}

export const CORE_VERSION = "0.1.0";

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
  ) {}

  static async create(configInput: unknown): Promise<CrotCore> {
    const config = parseConfig(configInput);
    const workspace = await Workspace.open(config.workspace.root, config.workspace.name);
    const policy = createPermissionPolicy(
      config.permissions.capabilities
        ? { mode: config.permissions.mode, capabilities: config.permissions.capabilities }
        : { mode: config.permissions.mode },
    );
    const permissions = new PermissionEngine(policy);
    const guard = new ExecutionGuard(permissions);
    const filesystem = new FileSystemService({ workspace, guard, limits: config.limits });
    return new CrotCore(config, workspace, permissions, guard, filesystem);
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
    };
  }
}

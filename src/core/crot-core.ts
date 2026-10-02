import path from "node:path";
import { JsonlFileAuditSink, NullAuditSink, StreamAuditSink, type AuditSink } from "./audit/audit.js";
import type { BrowserConnection } from "./capabilities/browser/connection.js";
import type { BrowserBridgeState } from "./capabilities/browser/schemas.js";
import { BrowserService } from "./capabilities/browser/service.js";
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
  readonly audit: { readonly sink: AuditConfig["sink"]; readonly path?: string; readonly protection?: PrivateFileStatus };
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
    readonly browser: BrowserService,
    readonly platform: Platform,
    private readonly audit: AuditSink,
    private readonly auditProtection: PrivateFileStatus | undefined,
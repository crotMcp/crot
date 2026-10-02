import type { AuditSink } from "../audit/audit.js";
import { newAuditEventId } from "../audit/audit.js";
import type { AuthContext } from "../auth/principal.js";
import { CrotError, PermissionDeniedError } from "../errors.js";
import type { Capability } from "../permissions/capabilities.js";
import type { PermissionEngine } from "../permissions/engine.js";
import type { ResolvedPath } from "../workspace/workspace.js";

/** Description of one Core operation, used for authorization and auditing. */
export interface OperationDescriptor {
  /** Stable operation name, e.g. "filesystem.read_file". */
  readonly operation: string;
  /** Capability, or capabilities that must all be granted. */
  readonly capability: Capability | readonly Capability[];
  /** Every path the operation touches (targets, working directories). */
  readonly paths?: readonly ResolvedPath[];
  /** Audit-safe summary of the operation. Never include file contents, output or secrets. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ExecutionGuardOptions {
  /** Called when the audit sink fails; the operation itself is not affected. */
  readonly onAuditError?: (error: unknown) => void;
}

/**
 * The execution pipeline every Core operation passes through:
 * authorize (PermissionEngine) -> execute -> audit.
 *
 * Capability services never call the operating system before the guard has
 * authorized the operation, and every authorized or denied operation is audited.
 */
export class ExecutionGuard {
  constructor(
    private readonly engine: PermissionEngine,
    private readonly audit: AuditSink,
    private readonly options: ExecutionGuardOptions = {},
  ) {}

  async run<T>(context: AuthContext, op: OperationDescriptor, execute: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const capabilities: readonly Capability[] = typeof op.capability === "string" ? [op.capability] : op.capability;
    const base = {
      operation: op.operation,
      capabilities,
      principal: context.principal,
      ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
      paths: (op.paths ?? []).map((p) => p.absolute),
      ...(op.details !== undefined ? { details: op.details } : {}),
    };
    const record = (outcome: "success" | "error" | "denied", error?: unknown) =>
      this.record({
        id: newAuditEventId(),
        timestamp: new Date(started).toISOString(),
        ...base,
        outcome,
        durationMs: Date.now() - started,
        ...(error !== undefined ? { error: summarizeError(error) } : {}),
      });

    for (const capability of capabilities) {
      const decision = this.engine.authorize({ context, capability, paths: op.paths ?? [] });
      if (!decision.allowed) {
        const denied = new PermissionDeniedError(decision.reason, { operation: op.operation, missing: decision.missing });
        await record("denied", denied);
        throw denied;
      }
    }
    try {
      const result = await execute();
      await record("success");
      return result;
    } catch (error) {
      await record("error", error);
      throw error;
    }
  }

  private async record(event: Parameters<AuditSink["record"]>[0]): Promise<void> {
    try {
      await this.audit.record(event);
    } catch (error) {
      this.options.onAuditError?.(error);
    }
  }
}

function summarizeError(error: unknown): { code: string; message: string } {
  if (error instanceof CrotError) return { code: error.code, message: error.message };
  return { code: "OPERATION_FAILED", message: error instanceof Error ? error.message : String(error) };
}

/**
 * Error model shared by CROT Core and every adapter.
 *
 * Adapters translate CrotError codes into their own protocol representation;
 * they never need to inspect messages to decide behaviour.
 */
import { z } from "zod";

export type CrotErrorCode =
  | "INVALID_INPUT"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "LIMIT_EXCEEDED"
  | "TIMEOUT"
  | "CONFIG_ERROR"
  | "OPERATION_FAILED";

export class CrotError extends Error {
  readonly code: CrotErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: CrotErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CrotError";
    this.code = code;
    this.details = details;
  }
}

export class PermissionDeniedError extends CrotError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("PERMISSION_DENIED", message, details);
    this.name = "PermissionDeniedError";
  }
}

/** Validate untrusted input against a schema, raising INVALID_INPUT on failure. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new CrotError("INVALID_INPUT", `Invalid input: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Map Node.js system errors (ENOENT, EEXIST, ...) to CrotError. */
export function fromNodeError(error: unknown, context: string): CrotError {
  if (error instanceof CrotError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "ENOENT":
      return new CrotError("NOT_FOUND", `${context}: not found`, undefined, { cause: error });
    case "EEXIST":
      return new CrotError("ALREADY_EXISTS", `${context}: already exists`, undefined, { cause: error });
    case "EACCES":
    case "EPERM":
      return new CrotError("OPERATION_FAILED", `${context}: operating system denied access`, { errno: code }, { cause: error });
    default:
      return new CrotError("OPERATION_FAILED", `${context}: ${message}`, code ? { errno: code } : undefined, { cause: error });
  }
}

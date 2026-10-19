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
  | "RESOURCE_BUSY"
  | "TIMEOUT"
  | "CONFIG_ERROR"
  | "OPERATION_FAILED"
  /** Browser support is disabled, or the CROT Browser Extension is not connected. */
  | "BROWSER_NOT_CONNECTED"
  /** Another CROT instance owns the browser bridge. Only browser operations are unavailable. */
  | "BROWSER_BRIDGE_IN_USE"
  /** The browser does not allow the operation on this page (e.g. browser-internal or store pages). */
  | "BROWSER_PAGE_RESTRICTED"
  /**
   * An element reference from browser_snapshot no longer names its element:
   * its document, frame, element, tab, debugger session or connection changed.
   * Nothing was done; the agent takes a new snapshot (ARCHITECTURE.md §27, AD-16 point 5).
   */
  | "BROWSER_STALE_REF"
  | "BROWSER_DIALOG_OPEN"
  /**
   * The repository's own Git configuration contains settings that could make a
   * git.read or git.write operation run programs; the operation is refused
   * (ARCHITECTURE.md §27, AD-1 and AD-2).
   */
  | "UNSAFE_REPOSITORY"
  /**
   * A Compose project uses settings that docker.use does not allow (they could
   * load unauthorized files, grant containers host privileges, build or pull
   * images); the operation is refused (ARCHITECTURE.md §27, AD-3).
   */
  | "UNSAFE_COMPOSE"
  /**
   * Command confinement L1 is not available on this machine in the configured
   * network mode; shell.execute / process.manage of a remote principal in
   * workspace mode are refused before any process starts. `details.reason`
   * is the L1 reason code (ARCHITECTURE.md §27, AD-20 points 11 and 12).
   */
  | "CONFINEMENT_UNAVAILABLE"
  /**
   * L1 was available but the sandbox could not be set up or the launch failed
   * for a sandbox reason. The command was not started, confined or otherwise;
   * it is never retried unconfined (AD-20 point 11).
   */
  | "CONFINEMENT_FAILED";

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

/**
 * Map Node.js system errors to CrotError, consistently across Linux, macOS and
 * Windows (where e.g. locked files surface as EBUSY or EPERM).
 */
export function fromNodeError(error: unknown, context: string): CrotError {
  if (error instanceof CrotError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  const make = (c: CrotErrorCode, text: string) =>
    new CrotError(c, `${context}: ${text}`, code ? { errno: code } : undefined, { cause: error });
  switch (code) {
    case "ENOENT":
      return make("NOT_FOUND", "not found");
    case "EEXIST":
      return make("ALREADY_EXISTS", "already exists");
    case "ENOTEMPTY":
      return make("INVALID_INPUT", "directory is not empty");
    case "EISDIR":
      return make("INVALID_INPUT", "is a directory");
    case "ENOTDIR":
      return make("INVALID_INPUT", "a path component is not a directory");
    case "ENAMETOOLONG":
      return make("INVALID_INPUT", "path is too long for this platform");
    case "EINVAL":
      return make("INVALID_INPUT", "invalid path or argument for this platform");
    case "EBUSY":
    case "ETXTBSY":
      return make("RESOURCE_BUSY", "in use by another process");
    case "EACCES":
      return make("OPERATION_FAILED", "operating system denied access");
    case "EPERM":
      return make(
        "OPERATION_FAILED",
        "operation not permitted by the operating system (on Windows the file may be read-only or in use)",
      );
    case "EMFILE":
    case "ENFILE":
      return make("LIMIT_EXCEEDED", "too many open files");
    case "ENOSPC":
      return make("OPERATION_FAILED", "no space left on device");
    case "EROFS":
      return make("OPERATION_FAILED", "read-only filesystem");
    case "EXDEV":
      return make("OPERATION_FAILED", "cross-device operation not supported");
    default:
      return make("OPERATION_FAILED", message);
  }
}

import { MAX_ERROR_MESSAGE_LENGTH } from "../../src/browser-bridge/protocol.js";

/**
 * Error codes the extension reports. They are the codes the CROT Host accepts
 * from the extension (EXTENSION_ERROR_CODES in src/browser-bridge/server.ts);
 * bridge-state codes are deliberately absent: the extension cannot claim
 * them, and the host would map them to OPERATION_FAILED anyway.
 *
 * PERMISSION_DENIED is reserved for the expected browser subject check of
 * approved operations (ARCHITECTURE.md §27, AD-11). The host accepts it only
 * in answer to a command that carried an expected subject; it can only deny
 * that one operation.
 */
export const EXTENSION_ERROR_CODES = [
  "NOT_FOUND",
  "INVALID_INPUT",
  "TIMEOUT",
  "LIMIT_EXCEEDED",
  "RESOURCE_BUSY",
  "OPERATION_FAILED",
  "BROWSER_PAGE_RESTRICTED",
  "PERMISSION_DENIED",
] as const;

export type ExtensionErrorCode = (typeof EXTENSION_ERROR_CODES)[number];

const CODES: ReadonlySet<string> = new Set<string>(EXTENSION_ERROR_CODES);

export const isExtensionErrorCode = (value: unknown): value is ExtensionErrorCode =>
  typeof value === "string" && CODES.has(value);

/** A failure of one command, reported to the host as an error response. */
export class ExtensionError extends Error {
  constructor(
    readonly code: ExtensionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExtensionError";
  }
}

export interface WireError {
  readonly code: ExtensionErrorCode;
  readonly message: string;
}

/** Single-line, bounded text. */
export function cleanMessage(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/** The error of an error response: ExtensionErrors keep their code, anything else is OPERATION_FAILED. */
export function toWireError(error: unknown): WireError {
  if (error instanceof ExtensionError) return { code: error.code, message: cleanMessage(error.message) };
  const message = error instanceof Error ? error.message : String(error);
  return { code: "OPERATION_FAILED", message: cleanMessage("Browser operation failed: " + message) };
}

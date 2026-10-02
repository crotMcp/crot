import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CrotError } from "../../core/errors.js";

/** Encode a Core result as an MCP tool result. */
export function toToolResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Encode an image result: MCP image content (base64 data) followed by its metadata as JSON text. */
export function toImageToolResult(data: string, mimeType: string, metadata: Record<string, unknown>): CallToolResult {
  return {
    content: [
      { type: "image", data, mimeType },
      { type: "text", text: JSON.stringify(metadata, null, 2) },
    ],
  };
}

/** Encode a Core error as an MCP tool error (tool-level, so the agent can react to it). */
export function toToolError(error: unknown): CallToolResult {
  const e =
    error instanceof CrotError
      ? error
      : new CrotError("OPERATION_FAILED", error instanceof Error ? error.message : String(error));
  const body: Record<string, unknown> = { error: { code: e.code, message: e.message } };
  if (e.details) (body.error as Record<string, unknown>).details = e.details;
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

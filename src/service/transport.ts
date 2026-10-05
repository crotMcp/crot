/**
 * MCP transport over one authenticated shim connection (WP-20).
 *
 * The service side of `crot-mcp` in stdio mode: the shim forwards its stdin
 * lines unchanged, and the service answers with the same serialization the SDK
 * stdio transport writes to stdout. Every connection gets its own McpServer and
 * therefore its own exposure scope (AD-12, AD-15).
 */
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { AuthenticatedChannel } from "./channel.js";

export class ChannelServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private closed = false;

  constructor(private readonly channel: AuthenticatedChannel) {}

  async start(): Promise<void> {
    // Messages arrive through receiveLine(), fed by the service's message loop.
  }

  /** One stdin line of the client, as forwarded by the shim. */
  receiveLine(line: string): void {
    if (this.closed) return;
    try {
      this.onmessage?.(deserializeMessage(line.replace(/\r$/, "")));
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return;
    if (!this.channel.send({ t: "mcp", data: serializeMessage(message) })) await this.channel.drained();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

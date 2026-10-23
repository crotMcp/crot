/** Dedicated, ordinary local MCP client. No control-channel execution or policy bypass. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOLS } from "../adapters/mcp/tools.js";

export const UI_TOOLS = [
  "crot_status",
  "fs_stat",
  "fs_list_directory",
  "fs_read_file",
  "fs_write_file",
  "fs_create_directory",
  "fs_delete",
  "fs_move",
  "process_start",
  "process_list",
  "process_read_output",
  "process_stop",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "git_add",
  "git_commit",
  "docker_ps",
  "docker_logs",
  "docker_compose_up",
  "docker_compose_down",
  "browser_status",
  "browser_tabs_list",
  "browser_snapshot",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_dialog_handle",
  "browser_history",
] as const;
export function validateUiTool(name: unknown, input: unknown): { name: string; arguments: Record<string, unknown> } {
  if (typeof name !== "string" || !(UI_TOOLS as readonly string[]).includes(name))
    throw new Error("Unsupported UI operation");
  if (JSON.stringify(input)?.length > 256 * 1024) throw new Error("UI input too large");
  const tool = TOOLS.find((t) => t.name === name)!;
  return { name, arguments: tool.inputSchema.parse(input) as Record<string, unknown> };
}

export class TrayToolClient {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  constructor(
    private readonly options: { command: string; entry: string; args: readonly string[]; env?: Record<string, string> },
  ) {}
  async call(name: unknown, input: unknown): Promise<unknown> {
    const request = validateUiTool(name, input);
    const client = await this.connect();
    // Same schemas, principal, ExecutionGuard, approvals and audit as every other local MCP client.
    return client.callTool(request, undefined, { timeout: 180_000 });
  }
  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ name: "CROT Control Center", version: "0.1.0" });
      const transport = new StdioClientTransport({
        command: this.options.command,
        args: [this.options.entry, ...this.options.args],
        env: {
          ...(this.options.env ??
            Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))),
          ELECTRON_RUN_AS_NODE: "1",
        },
        stderr: "ignore",
      });
      client.onclose = () => {
        if (this.client === client) this.client = undefined;
      };
      try {
        await client.connect(transport);
        this.client = client;
        return client;
      } catch (error) {
        await transport.close();
        throw error;
      }
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
}

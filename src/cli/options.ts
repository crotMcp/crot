import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfigFile } from "../core/config/load.js";
import type { CrotConfigInput } from "../core/config/schema.js";
import { CrotError } from "../core/errors.js";

export const USAGE = `Usage: crot-mcp [options]

Starts the CROT MCP server on stdio.

Options:
  -c, --config <file>      JSON configuration file (or set CROT_CONFIG)
  -w, --workspace <dir>    Workspace root (overrides the config file)
  -m, --mode <mode>        Permission mode: sandbox | full-control (overrides the config file)
      --audit-log <file>   Append audit events to this file (JSON lines)
      --no-audit           Disable audit logging
  -h, --help               Show this help
  -v, --version            Show the version

Without a config file, --workspace is required. The default mode is sandbox.
`;

export type CliCommand = { kind: "help" } | { kind: "version" } | { kind: "serve"; config: CrotConfigInput };

/** Parse command-line arguments into a configuration input. CLI flags override the config file. */
export async function parseCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<CliCommand> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        config: { type: "string", short: "c" },
        workspace: { type: "string", short: "w" },
        mode: { type: "string", short: "m" },
        "audit-log": { type: "string" },
        "no-audit": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    throw new CrotError("CONFIG_ERROR", `${(error as Error).message}\n\n${USAGE}`);
  }
  const v = parsed.values;
  if (v.help) return { kind: "help" };
  if (v.version) return { kind: "version" };

  const configFile = v.config ?? env.CROT_CONFIG;
  const base: Partial<CrotConfigInput> = configFile ? await loadConfigFile(configFile) : {};
  const config: Record<string, unknown> = { ...base };

  if (v.workspace !== undefined) {
    config.workspace = { ...(base.workspace ?? {}), root: path.resolve(v.workspace) };
  }
  if (!config.workspace) {
    throw new CrotError("CONFIG_ERROR", `A workspace is required: pass --workspace <dir> or --config <file>.\n\n${USAGE}`);
  }
  if (v.mode !== undefined) {
    config.permissions = { ...(base.permissions ?? {}), mode: parseMode(v.mode) };
  }
  if (v["audit-log"] !== undefined && v["no-audit"]) {
    throw new CrotError("CONFIG_ERROR", "--audit-log and --no-audit cannot be combined.");
  }
  if (v["audit-log"] !== undefined) config.audit = { sink: "file", path: path.resolve(v["audit-log"]) };
  if (v["no-audit"]) config.audit = { sink: "none" };
  return { kind: "serve", config: config as CrotConfigInput };
}

function parseMode(value: string): "sandbox" | "full_control" {
  switch (value) {
    case "sandbox":
      return "sandbox";
    case "full-control":
    case "full_control":
      return "full_control";
    default:
      throw new CrotError("CONFIG_ERROR", `Unknown mode '${value}'. Use 'sandbox' or 'full-control'.`);
  }
}

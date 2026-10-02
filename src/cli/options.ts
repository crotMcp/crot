import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfigFile } from "../core/config/load.js";
import { expandHome } from "../core/config/paths.js";
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
"~" is expanded. Prefer absolute paths: MCP clients may start CROT in any directory.
`;

export interface ServeCommand {
  readonly kind: "serve";
  readonly config: CrotConfigInput;
  /** Absolute path of the configuration file in use, if any (protected from modification). */
  readonly configFile?: string;
  /** Non-fatal notices for the operator (written to stderr). */
  readonly warnings: readonly string[];
}

export type CliCommand = { kind: "help" } | { kind: "version" } | ServeCommand;

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

  const warnings: string[] = [];
  const toAbsolute = (flag: string, value: string): string => {
    const expanded = expandHome(value);
    const absolute = path.resolve(expanded);
    if (!path.isAbsolute(expanded)) warnings.push(`${flag} '${value}' is relative; resolved against the current directory to ${absolute}.`);
    return absolute;
  };

  const configSource = v.config ?? env.CROT_CONFIG;
  const configFile = configSource !== undefined ? toAbsolute(v.config !== undefined ? "--config" : "CROT_CONFIG", configSource) : undefined;
  const base: Partial<CrotConfigInput> = configFile ? await loadConfigFile(configFile) : {};
  const config: Record<string, unknown> = { ...base };

  if (v.workspace !== undefined) {
    config.workspace = { ...(base.workspace ?? {}), root: toAbsolute("--workspace", v.workspace) };
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
  if (v["audit-log"] !== undefined) config.audit = { sink: "file", path: toAbsolute("--audit-log", v["audit-log"]) };
  if (v["no-audit"]) config.audit = { sink: "none" };
  return { kind: "serve", config: config as CrotConfigInput, ...(configFile ? { configFile } : {}), warnings };
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

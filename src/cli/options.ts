import { stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfigFile } from "../core/config/load.js";
import { expandHome } from "../core/config/paths.js";
import type { CrotConfigInput } from "../core/config/schema.js";
import { DEFAULT_CONFIG_FILE_NAME } from "../core/platform/directories.js";
import { hostDirectories } from "../core/platform/node-platform.js";
import type { PlatformDirectories } from "../core/platform/types.js";
import { CrotError } from "../core/errors.js";

export const USAGE = `Usage: crot-mcp [options]
       crot-mcp browser install

Starts the CROT MCP server on stdio (default) or, with --http, on loopback HTTP.

Options:
  -c, --config <file>      JSON configuration file (or set CROT_CONFIG; default:
                           config.json in the CROT configuration directory, if present)
  -w, --workspace <dir>    Workspace root (overrides the config file)
  -m, --mode <mode>        Permission mode: sandbox | full-control (overrides the config file)
      --audit-log <file>   Append audit events to this file (JSON lines)
      --no-audit           Disable audit logging
      --http               Serve MCP over Streamable HTTP instead of stdio
                           (loopback only, bearer token required)
      --http-host <host>   HTTP bind address (loopback; default 127.0.0.1)
      --http-port <port>   HTTP port (default 7337; 0 picks a free port)
  -h, --help               Show this help
  -v, --version            Show the version

Commands:
  browser install          Register the CROT Host with Chrome, Edge and Brave (current
                           user) so the CROT Browser Extension can connect to it.
                           Grants no permissions; enable the bridge with
                           "browser": { "enabled": true } in the configuration.

Without a config file, --workspace is required. The default mode is sandbox.
Default locations: Linux ~/.config/crot, macOS ~/Library/Application Support/CROT,
Windows %APPDATA%\\CROT (see the README).
"~" is expanded. Prefer absolute paths: MCP clients may start CROT in any directory.
`;

export interface ServeCommand {
  readonly kind: "serve";
  readonly config: CrotConfigInput;
  /** Absolute path of the configuration file in use, if any (protected from modification). */
  readonly configFile?: string;
  /** How the configuration file was chosen. */
  readonly configSource?: "flag" | "env" | "default";
  /** Non-fatal notices for the operator (written to stderr). */
  readonly warnings: readonly string[];
}

export type CliCommand = { kind: "help" } | { kind: "version" } | { kind: "browser-install" } | ServeCommand;

/** Parse command-line arguments into a configuration input. CLI flags override the config file. */
export interface ParseCliOptions {
  /** Default directories (defaults to the host OS conventions). */
  readonly directories?: PlatformDirectories;
}

export async function parseCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  options: ParseCliOptions = {},
): Promise<CliCommand> {
  if (argv[0] === "browser") return parseBrowserCommand(argv.slice(1));
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
        http: { type: "boolean" },
        "http-host": { type: "string" },
        "http-port": { type: "string" },
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
    if (!path.isAbsolute(expanded))
      warnings.push(`${flag} '${value}' is relative; resolved against the current directory to ${absolute}.`);
    return absolute;
  };

  const explicit = v.config ?? env.CROT_CONFIG;
  let configFile =
    explicit !== undefined ? toAbsolute(v.config !== undefined ? "--config" : "CROT_CONFIG", explicit) : undefined;
  let configSource: ServeCommand["configSource"] =
    explicit === undefined ? undefined : v.config !== undefined ? "flag" : "env";
  if (configFile === undefined) {
    // Optional per-user configuration in the OS-conventional location.
    const candidate = path.join((options.directories ?? hostDirectories(env)).config, DEFAULT_CONFIG_FILE_NAME);
    if ((await stat(candidate).catch(() => undefined))?.isFile()) {
      configFile = candidate;
      configSource = "default";
    }
  }
  const base: Partial<CrotConfigInput> = configFile ? await loadConfigFile(configFile) : {};
  const config: Record<string, unknown> = { ...base };

  if (v.workspace !== undefined) {
    config.workspace = { ...(base.workspace ?? {}), root: toAbsolute("--workspace", v.workspace) };
  }
  if (!config.workspace) {
    throw new CrotError(
      "CONFIG_ERROR",
      `A workspace is required: pass --workspace <dir> or --config <file>.\n\n${USAGE}`,
    );
  }
  if (v.mode !== undefined) {
    config.permissions = { ...(base.permissions ?? {}), mode: parseMode(v.mode) };
  }
  if (v["audit-log"] !== undefined && v["no-audit"]) {
    throw new CrotError("CONFIG_ERROR", "--audit-log and --no-audit cannot be combined.");
  }
  if (v["audit-log"] !== undefined) config.audit = { sink: "file", path: toAbsolute("--audit-log", v["audit-log"]) };
  if (v["no-audit"]) config.audit = { sink: "none" };
  if (v.http || v["http-host"] !== undefined || v["http-port"] !== undefined) {
    const http: Record<string, unknown> = { ...(base.http ?? {}) };
    if (v.http) http.enabled = true;
    if (v["http-host"] !== undefined) http.host = v["http-host"];
    if (v["http-port"] !== undefined) http.port = parsePort(v["http-port"]);
    config.http = http;
  }
  return {
    kind: "serve",
    config: config as CrotConfigInput,
    ...(configFile ? { configFile, configSource } : {}),
    warnings,
  };
}

/** `crot-mcp browser <command>`: only `install`, which takes no options besides --help. */
function parseBrowserCommand(argv: readonly string[]): CliCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { help: { type: "boolean", short: "h" } },
    });
  } catch (error) {
    throw new CrotError("CONFIG_ERROR", `${(error as Error).message}\n\n${USAGE}`);
  }
  if (parsed.values.help) return { kind: "help" };
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "install") {
    const given =
      parsed.positionals.length > 0 ? `'browser ${parsed.positionals.join(" ")}'` : "'browser' without a command";
    throw new CrotError("CONFIG_ERROR", `Unknown command ${given}. Use 'crot-mcp browser install'.\n\n${USAGE}`);
  }
  return { kind: "browser-install" };
}

function parsePort(value: string): number {
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CrotError("CONFIG_ERROR", `Invalid --http-port '${value}': expected an integer from 0 to 65535.`);
  }
  return port;
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

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
import { isSecretName, ROTATABLE_SECRET_NAMES, SECRET_NAMES, type SecretName } from "../service/secrets/types.js";

export const USAGE = `Usage: crot-mcp [options]
       crot-mcp app [options]
       crot-mcp service run [options] | service status | service stop
       crot-mcp service autostart install|status|remove
       crot-mcp secrets status | secrets show http-token | secrets rotate <name>... | secrets rotate --all
       crot-mcp browser install|uninstall
       crot-mcp update --package <dir> --public-key <trusted.pem> --install-root <dir> --config <file>

Serves CROT to an MCP client on stdio (default) or, with --http, on loopback HTTP.
All clients of a user share one CROT service: on stdio, crot-mcp connects to it
(and starts it when it is not running); with --http it runs the service itself.

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
  app [options]            Register the browser host, start/reuse the service and open Control Center.
  service run [options]    Run the CROT service in the foreground (for systemd user
                           units, launchd agents, Task Scheduler); same options as above
  service status           Show the state of the running CROT service
  service stop             Stop the running CROT service gracefully
  service autostart ...    Install, inspect or remove per-user OS autostart
  secrets status           Show where CROT keeps its secrets (OS secure storage or
                           owner-only files); never prints a secret
  secrets show http-token  Print the HTTP access token (for configuring an HTTP client)
  secrets rotate <name>... Replace secrets with new random values (service stopped):
                           http-token, browser-token, service-token, control-token, or --all
                           (secrets commands accept -c/--config for http.auth settings)
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

/** `crot-mcp service run`: the service in the foreground (WP-20). */
export interface ServiceRunCommand {
  readonly kind: "service-run";
  readonly serve: ServeCommand;
  /** Started by a stdio shim: stops when the last stdio client has gone (internal flag). */
  readonly onDemand: boolean;
}

export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "browser-install" | "browser-uninstall" }
  | ServeCommand
  | ServiceRunCommand
  | { kind: "service-status" }
  | { kind: "service-stop" }
  | { kind: "service-autostart"; action: "install" | "status" | "remove" }
  | SecretsCommand;

/** `crot-mcp secrets <status|show|rotate>` (WP-21). */
export interface SecretsCommand {
  readonly kind: "secrets";
  readonly action: "status" | "show" | "rotate";
  /** show: exactly one name; rotate: one or more. */
  readonly names: readonly SecretName[];
  /** The configuration file's content, if one is in use (only http.auth is read). */
  readonly config?: CrotConfigInput;
  readonly configFile?: string;
}

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
  if (argv[0] === "service") return parseServiceCommand(argv.slice(1), env, options);
  if (argv[0] === "secrets") return parseSecretsCommand(argv.slice(1), env, options);
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

  const { configFile, configSource } = await resolveConfigFile(v.config, env, options, toAbsolute);
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

/** The configuration file in use: --config, CROT_CONFIG, or config.json in the default location if present. */
async function resolveConfigFile(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  options: ParseCliOptions,
  toAbsolute: (flag: string, value: string) => string,
): Promise<{ configFile?: string; configSource?: ServeCommand["configSource"] }> {
  const explicit = flag ?? env.CROT_CONFIG;
  if (explicit !== undefined) {
    return {
      configFile: toAbsolute(flag !== undefined ? "--config" : "CROT_CONFIG", explicit),
      configSource: flag !== undefined ? "flag" : "env",
    };
  }
  // Optional per-user configuration in the OS-conventional location.
  const candidate = path.join((options.directories ?? hostDirectories(env)).config, DEFAULT_CONFIG_FILE_NAME);
  if ((await stat(candidate).catch(() => undefined))?.isFile())
    return { configFile: candidate, configSource: "default" };
  return {};
}

/** `crot-mcp secrets <status|show|rotate>`. */
async function parseSecretsCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  options: ParseCliOptions,
): Promise<CliCommand> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string", short: "c" },
        all: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new CrotError("CONFIG_ERROR", `${(error as Error).message}\n\n${USAGE}`);
  }
  if (parsed.values.help) return { kind: "help" };
  const [action, ...rest] = parsed.positionals;
  const usage = (message: string) => new CrotError("CONFIG_ERROR", `${message}\n\n${USAGE}`);
  if (action !== "status" && action !== "show" && action !== "rotate") {
    throw usage(
      `Unknown command ${action === undefined ? "'secrets' without a command" : `'secrets ${action}'`}. Use 'crot-mcp secrets status', 'secrets show http-token' or 'secrets rotate <name>...'.`,
    );
  }
  for (const name of rest) {
    if (!isSecretName(name)) throw usage(`Unknown secret '${name}'. Secrets: ${SECRET_NAMES.join(", ")}.`);
  }
  let names = rest as SecretName[];
  if (parsed.values.all && action !== "rotate") throw usage("--all is only accepted by 'secrets rotate'.");
  if (action === "status" && names.length > 0) throw usage("'crot-mcp secrets status' takes no names.");
  if (action === "show" && (names.length !== 1 || names[0] !== "http-token")) {
    throw usage(
      "Only the HTTP access token can be shown: 'crot-mcp secrets show http-token'. The other secrets never leave the CROT service.",
    );
  }
  if (action === "rotate") {
    if (parsed.values.all) {
      if (names.length > 0) throw usage("Use either --all or names with 'secrets rotate'.");
      names = [...ROTATABLE_SECRET_NAMES];
    }
    if (names.includes("device-key"))
      throw usage(
        "The device key is not rotated with 'secrets rotate': it changes only when the device is paired again (unpair it in the tray, then pair it).",
      );
    if (names.length === 0) throw usage("'crot-mcp secrets rotate' needs secret names or --all.");
    names = [...new Set(names)];
  }
  const { configFile } = await resolveConfigFile(parsed.values.config, env, options, (_flag, value) =>
    path.resolve(expandHome(value)),
  );
  const config = configFile ? await loadConfigFile(configFile) : undefined;
  return {
    kind: "secrets",
    action,
    names,
    ...(config ? { config } : {}),
    ...(configFile ? { configFile } : {}),
  };
}

/** `crot-mcp browser install|uninstall`; no runtime-provided extension IDs. */
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
  if (parsed.positionals.length !== 1 || !["install", "uninstall"].includes(parsed.positionals[0] ?? "")) {
    const given =
      parsed.positionals.length > 0 ? `'browser ${parsed.positionals.join(" ")}'` : "'browser' without a command";
    throw new CrotError(
      "CONFIG_ERROR",
      `Unknown command ${given}. Use 'crot-mcp browser install|uninstall'.\n\n${USAGE}`,
    );
  }
  return { kind: parsed.positionals[0] === "install" ? "browser-install" : "browser-uninstall" };
}

/** `crot-mcp service <run|status|stop>`. */
async function parseServiceCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  options: ParseCliOptions,
): Promise<CliCommand> {
  const [sub, ...rest] = argv;
  if (sub === "run") {
    const onDemand = rest.includes("--on-demand");
    const command = await parseCli(
      rest.filter((a) => a !== "--on-demand"),
      env,
      options,
    );
    if (command.kind !== "serve") return command;
    return { kind: "service-run", serve: command, onDemand };
  }
  if (sub === "autostart") {
    const [action, ...extra] = rest;
    if (action === "--help" || action === "-h") return { kind: "help" };
    if ((action !== "install" && action !== "status" && action !== "remove") || extra.length > 0)
      throw new CrotError("CONFIG_ERROR", "Use 'crot-mcp service autostart install|status|remove'.\n\n" + USAGE);
    return { kind: "service-autostart", action };
  }
  if (sub === "status" || sub === "stop") {
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) return { kind: "help" };
    if (rest.length > 0) throw new CrotError("CONFIG_ERROR", `'crot-mcp service ${sub}' takes no options.\n\n${USAGE}`);
    return { kind: sub === "status" ? "service-status" : "service-stop" };
  }
  if (sub === "--help" || sub === "-h") return { kind: "help" };
  const given = sub === undefined ? "'service' without a command" : `'service ${sub}'`;
  throw new CrotError(
    "CONFIG_ERROR",
    `Unknown command ${given}. Use 'crot-mcp service run', 'service status', 'service stop' or 'service autostart'.\n\n${USAGE}`,
  );
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

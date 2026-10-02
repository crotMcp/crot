import { execFile } from "node:child_process";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../core/errors.js";
import type { OsFamily, PrivateFileProtection } from "../core/platform/types.js";

/**
 * `crot-mcp browser install`: registers the CROT Host with Chromium browsers
 * (Chrome, Edge, Brave) as the native-messaging host of the CROT Browser
 * Extension (ARCHITECTURE.md §7-8, §16).
 *
 * It writes, for the current user only:
 * - a launcher in <state>/native-messaging that starts crot-browser-relay
 *   with this Node.js and `--state-dir <state>`;
 * - the host manifest `com.crot.host`, which lets only the CROT extension
 *   (a fixed id derived from the key in extension/manifest.json) connect:
 *   per browser in its NativeMessagingHosts directory (Linux, macOS), or once
 *   in <state>/native-messaging plus HKCU registry keys (Windows).
 *
 * Installing grants nothing. The relay is a transport only: every browser
 * operation is still authorized by Core's PermissionEngine, and the bridge
 * runs only when `browser.enabled` is set in the CROT configuration.
 */

/** Native-messaging host name; must equal NATIVE_HOST_NAME in extension/src/host-connection.ts. */
export const CROT_NATIVE_HOST_NAME = "com.crot.host";
/** Id of the CROT Browser Extension, derived from the public key in extension/manifest.json. */
export const CROT_EXTENSION_ID = "bllcepanlhojbddfbbpegmnokpaakool";
export const CROT_EXTENSION_ORIGIN = `chrome-extension://${CROT_EXTENSION_ID}/`;

/** Directory below the state directory that holds the launcher (and the Windows manifest). */
export const NATIVE_MESSAGING_DIR_NAME = "native-messaging";
export const MANIFEST_FILE_NAME = `${CROT_NATIVE_HOST_NAME}.json`;

export type BrowserName = "Google Chrome" | "Microsoft Edge" | "Brave";

/** Where one host manifest is installed and which browsers read it. */
export interface HostRegistration {
  readonly browsers: readonly BrowserName[];
  readonly manifestFile: string;
  /** Windows: HKCU key whose default value points to manifestFile. */
  readonly registryKey?: string;
}

export interface HostManifest {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly type: "stdio";
  readonly allowed_origins: readonly string[];
}

export function hostManifest(launcher: string): HostManifest {
  return {
    name: CROT_NATIVE_HOST_NAME,
    description: "CROT Host: connects the CROT Browser Extension to the local CROT bridge",
    path: launcher,
    type: "stdio",
    allowed_origins: [CROT_EXTENSION_ORIGIN],
  };
}

export function launcherFileName(os: OsFamily): string {
  return os === "windows" ? "crot-browser-host.cmd" : "crot-browser-host";
}

/**
 * Manifest locations for the current user.
 * - Linux (and other POSIX): $XDG_CONFIG_HOME (default ~/.config)/<browser>/NativeMessagingHosts.
 * - macOS: ~/Library/Application Support/<browser>/NativeMessagingHosts.
 * - Windows: one manifest in <state>/native-messaging, registered under
 *   HKCU\Software\Google\Chrome\NativeMessagingHosts (read by Chrome and Brave)
 *   and HKCU\Software\Microsoft\Edge\NativeMessagingHosts.
 */
export function hostRegistrations(
  os: OsFamily,
  home: string,
  stateDir: string,
  env: Readonly<Record<string, string | undefined>> = {},
): HostRegistration[] {
  if (os === "windows") {
    const manifestFile = path.win32.join(stateDir, NATIVE_MESSAGING_DIR_NAME, MANIFEST_FILE_NAME);
    return [
      { browsers: ["Google Chrome", "Brave"], manifestFile, registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${CROT_NATIVE_HOST_NAME}` },
      { browsers: ["Microsoft Edge"], manifestFile, registryKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${CROT_NATIVE_HOST_NAME}` },
    ];
  }
  const p = path.posix;
  const xdg = env.XDG_CONFIG_HOME;
  const base = os === "macos" ? p.join(home, "Library", "Application Support") : xdg && p.isAbsolute(xdg) ? xdg : p.join(home, ".config");
  const dirs: [BrowserName, string][] =
    os === "macos"
      ? [
          ["Google Chrome", "Google/Chrome"],
          ["Microsoft Edge", "Microsoft Edge"],
          ["Brave", "BraveSoftware/Brave-Browser"],
        ]
      : [
          ["Google Chrome", "google-chrome"],
          ["Microsoft Edge", "microsoft-edge"],
          ["Brave", "BraveSoftware/Brave-Browser"],
        ];
  return dirs.map(([browser, dir]) => ({ browsers: [browser], manifestFile: p.join(base, dir, "NativeMessagingHosts", MANIFEST_FILE_NAME) }));
}

export interface LauncherTarget {
  /** Node.js executable (process.execPath). */
  readonly nodePath: string;
  /** dist/bin/crot-browser-relay.js */
  readonly relayScript: string;
  readonly stateDir: string;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** POSIX launcher: a /bin/sh script; every path is single-quoted. Browser arguments (origin) are forwarded and ignored by the relay. */
export function posixLauncher(target: LauncherTarget): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  for (const value of [target.nodePath, target.relayScript, target.stateDir]) {
    if (value.includes("\u0000")) throw new CrotError("INVALID_INPUT", "A launcher path contains a NUL character.");
  }
  return [
    "#!/bin/sh",
    "# CROT browser host launcher, written by `crot-mcp browser install`.",
    `exec ${quote(target.nodePath)} ${quote(target.relayScript)} --state-dir ${quote(target.stateDir)} "$@"`,
    "",
  ].join("\n");
}

/**
 * Windows launcher: a .cmd file (Chromium starts .cmd/.bat hosts through
 * cmd.exe). Paths are double-quoted with % doubled; Windows paths cannot
 * contain '"'. A trailing backslash before a closing quote is doubled so the
 * program receives it literally.
 */
export function windowsLauncher(target: LauncherTarget): string {
  const quote = (value: string, argument: boolean) => {
    if (value.includes('"') || CONTROL.test(value)) {
      throw new CrotError("INVALID_INPUT", `Cannot write a launcher for a path containing '"' or control characters: ${value}`);
    }
    const escaped = value.replace(/%/g, "%%");
    return `"${argument ? escaped.replace(/(\\+)$/, "$1$1") : escaped}"`;
  };
  return [
    "@echo off",
    "rem CROT browser host launcher, written by `crot-mcp browser install`.",
    `${quote(target.nodePath, false)} ${quote(target.relayScript, true)} --state-dir ${quote(target.stateDir, true)} %*`,
    "",
  ].join("\r\n");
}

/** Sets the default value of an HKCU registry key (Windows). */
export type RegistryWriter = (key: string, value: string) => Promise<void>;

/** RegistryWriter using %SystemRoot%\System32\reg.exe, started without a shell. */
export function regExeWriter(systemRoot: string): RegistryWriter {
  const reg = path.win32.join(systemRoot, "System32", "reg.exe");
  return (key, value) =>
    new Promise((resolve, reject) => {
      execFile(reg, ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { windowsHide: true, timeout: 10_000 }, (error, _stdout, stderr) => {
        if (!error) return resolve();
        const detail = String(stderr).trim() || error.message;
        reject(new CrotError("OPERATION_FAILED", `Could not write registry key ${key}: ${detail}`, undefined, { cause: error }));
      });
    });
}

export interface BrowserInstallOptions extends LauncherTarget {
  readonly os: OsFamily;
  readonly home: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Creates the private state directory (owner-only where supported). */
  readonly privateFiles: PrivateFileProtection;
  /** Required on Windows. */
  readonly registry?: RegistryWriter | undefined;
}

export interface BrowserInstallResult {
  readonly launcher: string;
  readonly registrations: readonly HostRegistration[];
}

export async function installBrowserHost(options: BrowserInstallOptions): Promise<BrowserInstallResult> {
  const windows = options.os === "windows";
  const paths = windows ? path.win32 : path.posix;
  for (const [name, value] of [
    ["Node.js executable", options.nodePath],
    ["relay script", options.relayScript],
    ["state directory", options.stateDir],
    ["home directory", options.home],
  ] as const) {
    if (!paths.isAbsolute(value)) throw new CrotError("INVALID_INPUT", `The ${name} must be an absolute path: ${value}`);
  }
  if (!(await stat(options.relayScript).catch(() => undefined))?.isFile()) {
    throw new CrotError("NOT_FOUND", `crot-browser-relay not found at ${options.relayScript}. Build CROT first (npm run build).`);
  }
  if (windows && !options.registry) throw new CrotError("INVALID_INPUT", "A registry writer is required on Windows.");

  const target: LauncherTarget = { nodePath: options.nodePath, relayScript: options.relayScript, stateDir: options.stateDir };
  const script = windows ? windowsLauncher(target) : posixLauncher(target);
  const hostDir = paths.join(options.stateDir, NATIVE_MESSAGING_DIR_NAME);
  await options.privateFiles.ensureDirectory(options.stateDir);
  await options.privateFiles.ensureDirectory(hostDir);
  const launcher = paths.join(hostDir, launcherFileName(options.os));
  await writeAtomically(launcher, script, windows ? undefined : 0o700);

  const registrations = hostRegistrations(options.os, options.home, options.stateDir, options.env ?? {});
  const manifest = `${JSON.stringify(hostManifest(launcher), null, 2)}\n`;
  const written = new Set<string>();
  for (const registration of registrations) {
    if (!written.has(registration.manifestFile)) {
      await mkdir(paths.dirname(registration.manifestFile), { recursive: true });
      await writeAtomically(registration.manifestFile, manifest, windows ? undefined : 0o644);
      written.add(registration.manifestFile);
    }
    if (registration.registryKey !== undefined) await options.registry?.(registration.registryKey, registration.manifestFile);
  }
  return { launcher, registrations };
}

/** Replace `file` with `content` (a temporary file renamed over it), so a browser never reads a partial file. */
async function writeAtomically(file: string, content: string, mode: number | undefined): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode });
    // The creation mode is reduced by the umask; set it exactly.
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new CrotError("OPERATION_FAILED", `Could not write ${file}: ${(error as Error).message}`, undefined, { cause: error });
  }
}

/** Human-readable summary printed by `crot-mcp browser install`. */
export function formatInstallResult(result: BrowserInstallResult): string {
  const lines = [`CROT Host registered as native-messaging host ${CROT_NATIVE_HOST_NAME} (current user).`, `Launcher: ${result.launcher}`];
  for (const r of result.registrations) {
    lines.push(`${r.browsers.join(", ")}: ${r.registryKey !== undefined ? `${r.registryKey} -> ${r.manifestFile}` : r.manifestFile}`);
  }
  lines.push(
    `Allowed extension: ${CROT_EXTENSION_ORIGIN}`,
    "",
    "Next steps:",
    '  1. Set "browser": { "enabled": true } in the CROT configuration and restart crot-mcp.',
    "  2. Load the CROT Browser Extension (see docs/BROWSER_EXTENSION.md).",
    "Browser tools still require browser.read / browser.control permissions.",
    "Run this command again after moving CROT or changing the Node.js installation.",
    "",
  );
  return lines.join("\n");
}

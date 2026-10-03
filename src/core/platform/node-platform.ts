import { execFile } from "node:child_process";
import { lstat, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { platformDirectories } from "./directories.js";
import { createEncodingSupport, parseWindowsCodePages } from "./encoding.js";
import { createEnvironmentPolicy } from "./environment.js";
import { createPosixLauncher, createWindowsLauncher, findPosixExecutable } from "./node-launcher.js";
import { pathRulesFor } from "./path-rules.js";
import { createPrivateFileProtection } from "./private-files.js";
import { createShellProvider } from "./shells.js";
import { resolveStartupPath, type LoginShellRunner } from "./startup-path.js";
import type {
  CodePages,
  OsFamily,
  Platform,
  PlatformDirectories,
  ShellId,
  ShellInfo,
  StartupPathMode,
} from "./types.js";
import { comspecFrom, findWindowsExecutable } from "./windows-command.js";

export interface NodePlatformOptions {
  /** Environment used for shell detection (defaults to process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Windows code pages (detected with reg.exe when omitted; ignored elsewhere). */
  readonly codePages?: CodePages | null;
  /** Override the default directories (tests, embedding). */
  readonly directories?: PlatformDirectories;
  /** Startup PATH resolution (default "auto"). */
  readonly startupPath?: StartupPathMode;
  /** Login shell for PATH resolution (defaults to $SHELL). */
  readonly loginShell?: string;
  readonly loginShellTimeoutMs?: number;
  /** Replace the login shell runner (tests). */
  readonly runLoginShell?: LoginShellRunner;
}

export function osFamily(platform: NodeJS.Platform): OsFamily {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "posix";
}

/** Default directories of the host OS for the given environment. */
export function hostDirectories(env: Readonly<Record<string, string | undefined>> = process.env): PlatformDirectories {
  const environment = createEnvironmentPolicy(process.platform === "win32");
  return platformDirectories(osFamily(process.platform), (n) => environment.get(env, n), os.homedir());
}

/** Default platform implementation built on portable Node.js APIs. */
export async function createNodePlatform(options: NodePlatformOptions = {}): Promise<Platform> {
  const hostEnv = options.env ?? process.env;
  const windows = process.platform === "win32";
  const family = osFamily(process.platform);
  const environment = createEnvironmentPolicy(windows);
  const paths = pathRulesFor(windows ? "win32" : "posix");
  const launcher = windows ? createWindowsLauncher(environment, hostEnv) : createPosixLauncher();
  const startup = await resolveStartupPath({
    os: family,
    env: hostEnv,
    environment,
    mode: options.startupPath ?? "auto",
    shell: options.loginShell,
    ...(options.loginShellTimeoutMs !== undefined ? { timeoutMs: options.loginShellTimeoutMs } : {}),
    ...(options.runLoginShell ? { run: options.runLoginShell } : {}),
    isDirectory: async (d) => (await stat(d).catch(() => undefined))?.isDirectory() ?? false,
  });
  // Shells and commands are looked up with the startup PATH.
  const env = startup.env;

  const shells: ShellInfo[] = [];
  const pathValue = environment.get(env, "PATH");
  const isFile = async (p: string) => {
    try {
      return (await stat(p)).isFile();
    } catch {
      return false;
    }
  };
  const find = (name: string) =>
    windows
      ? findWindowsExecutable(name, {
          cwd: os.homedir(),
          path: pathValue,
          pathExt: environment.get(env, "PATHEXT"),
          isFile,
        })
      : findPosixExecutable(name, "/", pathValue);

  let defaultShell: ShellId;
  if (windows) {
    shells.push({ id: "cmd", path: comspecFrom((n) => environment.get(env, n)) });
    defaultShell = "cmd";
    for (const id of ["powershell", "pwsh", "bash"] as const) {
      const found = await find(id);
      if (found) shells.push({ id, path: found });
    }
  } else {
    shells.push({ id: "sh", path: "/bin/sh" });
    defaultShell = "sh";
    for (const id of ["bash", "zsh", "pwsh"] as const) {
      const found = await find(id);
      if (found) shells.push({ id, path: found });
    }
  }

  const codePages = windows
    ? options.codePages !== undefined
      ? options.codePages
      : await detectWindowsCodePages(environment.get(env, "SystemRoot") ?? "C:\\Windows")
    : null;
  const encodings = createEncodingSupport(codePages);
  const privateFiles = createPrivateFileProtection(windows);

  return {
    info: {
      os: family,
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      pathStyle: paths.style,
      pathSeparator: paths.sep,
      pathListDelimiter: windows ? ";" : ":",
      caseInsensitiveEnvironment: environment.caseInsensitive,
      defaultShell,
      shells,
      directories: options.directories ?? hostDirectories(hostEnv),
      privateFiles: { mechanism: privateFiles.mechanism, enforced: privateFiles.enforced },
      processControl: launcher.processControl,
      shutdownSignals: windows ? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"],
      startupPath: startup.info,
      encoding: { codePages: encodings.codePages, fallback: encodings.fallback },
    },
    paths,
    environment,
    baseEnvironment: env,
    shells: createShellProvider(defaultShell, shells),
    launcher,
    encodings,
    privateFiles,
    probeCaseSensitivity: (dir) => probeCaseSensitivity(dir, windows),
  };
}

/** Read the OEM (console) and ANSI code pages from the registry; null when unavailable. */
export function detectWindowsCodePages(systemRoot: string): Promise<CodePages | null> {
  const reg = path.win32.join(systemRoot, "System32", "reg.exe");
  return new Promise((resolve) => {
    execFile(
      reg,
      ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage"],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout) => resolve(error ? null : parseWindowsCodePages(String(stdout))),
    );
  });
}

/**
 * Determine whether the filesystem holding `directory` compares names
 * case-sensitively, by looking up a case-swapped spelling of an existing
 * entry and comparing identities. Windows is treated as case-insensitive.
 */
export async function probeCaseSensitivity(directory: string, windows: boolean): Promise<boolean> {
  if (windows) return false;
  const swap = (s: string) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
  const sameEntry = async (a: string, b: string) => {
    try {
      const [x, y] = await Promise.all([lstat(a), lstat(b)]);
      return x.ino === y.ino && x.dev === y.dev;
    } catch {
      return false;
    }
  };
  // Prefer a name inside the directory itself (same filesystem), then its ancestors.
  try {
    for (const name of await readdir(directory)) {
      if (swap(name) !== name) return !(await sameEntry(path.join(directory, name), path.join(directory, swap(name))));
    }
  } catch {
    // Unreadable directory: fall back to ancestors.
  }
  let current = directory;
  for (;;) {
    const base = path.basename(current);
    if (base && swap(base) !== base) {
      return !(await sameEntry(current, path.join(path.dirname(current), swap(base))));
    }
    const parent = path.dirname(current);
    if (parent === current) return process.platform !== "darwin";
    current = parent;
  }
}

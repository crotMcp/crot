import { lstat, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEnvironmentPolicy } from "./environment.js";
import { createPosixLauncher, createWindowsLauncher, findPosixExecutable } from "./node-launcher.js";
import { pathRulesFor } from "./path-rules.js";
import { createShellProvider } from "./shells.js";
import type { OsFamily, Platform, ShellId, ShellInfo } from "./types.js";
import { comspecFrom, findWindowsExecutable } from "./windows-command.js";

export interface NodePlatformOptions {
  /** Environment used for shell detection (defaults to process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function osFamily(platform: NodeJS.Platform): OsFamily {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "posix";
}

/** Default platform implementation built on portable Node.js APIs. */
export async function createNodePlatform(options: NodePlatformOptions = {}): Promise<Platform> {
  const env = options.env ?? process.env;
  const windows = process.platform === "win32";
  const environment = createEnvironmentPolicy(windows);
  const paths = pathRulesFor(windows ? "win32" : "posix");
  const launcher = windows ? createWindowsLauncher(environment, env) : createPosixLauncher();

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
      ? findWindowsExecutable(name, { cwd: os.homedir(), path: pathValue, pathExt: environment.get(env, "PATHEXT"), isFile })
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

  return {
    info: {
      os: osFamily(process.platform),
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      pathStyle: paths.style,
      pathSeparator: paths.sep,
      pathListDelimiter: windows ? ";" : ":",
      caseInsensitiveEnvironment: environment.caseInsensitive,
      defaultShell,
      shells,
    },
    paths,
    environment,
    shells: createShellProvider(defaultShell, shells),
    launcher,
    probeCaseSensitivity: (dir) => probeCaseSensitivity(dir, windows),
  };
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

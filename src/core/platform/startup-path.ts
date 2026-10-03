import { spawn } from "node:child_process";
import path from "node:path";
import type { EnvironmentPolicy, OsFamily, StartupPathInfo, StartupPathMode } from "./types.js";

/**
 * Startup PATH resolution for macOS and Linux.
 *
 * MCP clients launched from the desktop (Dock, Finder, application menus)
 * inherit a minimal PATH (on macOS: /usr/bin:/bin:/usr/sbin:/sbin), so tools a
 * user installed with Homebrew, nvm, pyenv, cargo, ... are not found. When
 * CROT was not started from a shell, it asks the user's login shell for its
 * PATH once at startup, the same way terminal sessions get it. Only PATH is
 * imported; other variables are inherited unchanged.
 */

const MARKER = "__CROT_PATH_7f3a__";
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "yash"]);

/** Standard binary directories, appended when they exist but are missing from PATH. */
export function standardPathEntries(os: OsFamily): readonly string[] {
  const system = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"];
  if (os === "macos") return ["/opt/homebrew/bin", "/opt/homebrew/sbin", ...system];
  if (os === "linux") return [...system, "/snap/bin"];
  if (os === "posix") return system;
  return [];
}

/** Arguments that make `shell` print its login PATH between markers, or null for unsupported shells. */
export function loginShellPathCommand(shell: string): readonly string[] | null {
  const name = path.posix.basename(shell);
  if (POSIX_SHELLS.has(name)) return ["-l", "-i", "-c", `printf '%s' '${MARKER}'"$PATH"'${MARKER}'`];
  if (name === "fish") return ["-l", "-i", "-c", `printf '%s' '${MARKER}'(string join : -- $PATH)'${MARKER}'`];
  return null;
}

/** Extract the PATH printed between markers (shell startup files may print other text). */
export function parseLoginShellPath(output: string): string | null {
  const start = output.indexOf(MARKER);
  const end = start < 0 ? -1 : output.indexOf(MARKER, start + MARKER.length);
  return end < 0 ? null : output.slice(start + MARKER.length, end);
}

/** Ordered union of PATH lists (first occurrence wins, empty entries dropped). */
export function mergePathLists(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const entry of list) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

export type LoginShellRunner = (
  shell: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
) => Promise<string>;

/** Run the login shell with stdin closed and a hard timeout. */
export const runLoginShell: LoginShellRunner = (shell, args, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(shell, [...args], { env: { ...env }, stdio: ["ignore", "pipe", "ignore"], detached: true });
    let out = "";
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      reject(new Error(`login shell did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      // The marker check decides; some startup files make the shell exit non-zero.
      if (parseLoginShellPath(out) !== null) resolve(out);
      else reject(new Error(`login shell exited with code ${code} without reporting PATH`));
    });
  });

export interface StartupPathOptions {
  readonly os: OsFamily;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly environment: EnvironmentPolicy;
  readonly mode: StartupPathMode;
  /** Login shell; defaults to $SHELL. */
  readonly shell?: string | undefined;
  readonly timeoutMs?: number;
  readonly run?: LoginShellRunner;
  readonly isDirectory: (dir: string) => Promise<boolean>;
}

/**
 * Compute the base environment for child processes and a description of
 * where its PATH came from. Windows: the inherited environment is used as is.
 */
export async function resolveStartupPath(
  options: StartupPathOptions,
): Promise<{ env: Record<string, string>; info: StartupPathInfo }> {
  const { env, environment } = options;
  const base = environment.merge(env, {});
  const inherited = environment.get(env, "PATH") ?? "";
  if (options.os === "windows" || options.mode === "inherited") {
    return { env: base, info: { mode: options.mode, source: "inherited", added: [] } };
  }
  const split = (value: string) => value.split(":").filter(Boolean);
  const inheritedEntries = split(inherited);

  // auto: only when CROT was not started from a shell (SHLVL is set by shells).
  const wantLogin =
    options.mode === "login-shell" || (options.mode === "auto" && environment.get(env, "SHLVL") === undefined);
  let loginEntries: string[] = [];
  let source: StartupPathInfo["source"] = "inherited";
  let note: string | undefined;
  let shellUsed: string | undefined;
  if (wantLogin) {
    const shell = options.shell ?? environment.get(env, "SHELL");
    const args = shell ? loginShellPathCommand(shell) : null;
    if (!shell) note = "no login shell ($SHELL is not set)";
    else if (!args) note = `login shell ${shell} is not supported for PATH resolution`;
    else {
      try {
        const output = await (options.run ?? runLoginShell)(shell, args, env, options.timeoutMs ?? 5_000);
        loginEntries = split(parseLoginShellPath(output) ?? "");
        source = "login-shell";
        shellUsed = shell;
      } catch (error) {
        note = `could not read PATH from ${shell}: ${(error as Error).message}`;
      }
    }
  }

  const standard: string[] = [];
  for (const dir of standardPathEntries(options.os)) if (await options.isDirectory(dir)) standard.push(dir);
  // Login-shell order first (what the user's terminal sees), then anything only the client had.
  const merged = mergePathLists(loginEntries, inheritedEntries, standard);
  const added = merged.filter((e) => !inheritedEntries.includes(e));
  const changed = source === "login-shell" ? merged.join(":") !== inherited : added.length > 0;
  const finalEnv = changed ? environment.merge(base, { PATH: merged.join(":") }) : base;
  return {
    env: finalEnv,
    info: { mode: options.mode, source, added, ...(shellUsed ? { shell: shellUsed } : {}), ...(note ? { note } : {}) },
  };
}

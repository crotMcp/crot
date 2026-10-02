import path from "node:path";
import type { CommandSpec } from "./types.js";

/**
 * Windows command resolution and cmd.exe quoting. Pure functions (filesystem
 * checks are injected), so they are unit-tested on every OS.
 *
 * Node refuses to spawn .cmd/.bat files without a shell, and its argument
 * quoting does not match cmd.exe rules. Batch files are therefore run through
 * cmd.exe with every argument escaped for cmd (the approach used by the
 * widely deployed cross-spawn library).
 */
const w = path.win32;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

export interface WindowsLookup {
  readonly cwd: string;
  /** Value of PATH (any casing) or undefined. */
  readonly path: string | undefined;
  /** Value of PATHEXT or undefined. */
  readonly pathExt: string | undefined;
  readonly isFile: (candidate: string) => Promise<boolean>;
}

/** Find the file Windows would run for `command`, or null. Searches cwd, then PATH. */
export async function findWindowsExecutable(command: string, lookup: WindowsLookup): Promise<string | null> {
  const exts = (lookup.pathExt ?? DEFAULT_PATHEXT)
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith("."));
  const ext = w.extname(command).toLowerCase();
  const names = ext && exts.includes(ext) ? [command] : exts.map((e) => command + e);
  const explicit = /[\\/]/.test(command) || w.isAbsolute(command);
  const dirs = explicit
    ? [lookup.cwd]
    : [lookup.cwd, ...(lookup.path ?? "").split(";").map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = w.resolve(lookup.cwd, dir, name);
      if (await lookup.isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function isBatchFile(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file);
}

function escapeCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

/** Escape one argument for a command line interpreted by cmd.exe and then parsed by the target program. */
export function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  let a = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  a = a.replace(/(?=(\\+?)?)\1$/, "$1$1");
  a = `"${a}"`;
  a = a.replace(CMD_META, "^$1");
  if (doubleEscape) a = a.replace(CMD_META, "^$1");
  return a;
}

/** Invocation running a batch file through cmd.exe with safely escaped arguments. */
export function batchFileCommand(comspec: string, file: string, args: readonly string[]): CommandSpec {
  const doubleEscape = CMD_SHIM.test(file);
  const line = [escapeCommand(w.normalize(file)), ...args.map((a) => escapeCmdArgument(a, doubleEscape))].join(" ");
  return {
    file: comspec,
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
    display: [file, ...args].join(" "),
  };
}

/** Invocation running a cmd.exe script verbatim (same form Node uses for `shell: true`). */
export function cmdScriptCommand(comspec: string, script: string): CommandSpec {
  return { file: comspec, args: ["/d", "/s", "/c", `"${script}"`], windowsVerbatimArguments: true, display: script };
}

/** Default cmd.exe location derived from the environment. */
export function comspecFrom(get: (name: string) => string | undefined): string {
  return get("ComSpec") ?? w.join(get("SystemRoot") ?? "C:\\Windows", "System32", "cmd.exe");
}

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

/** Environment variable carrying a cmd script from the outer to the inner cmd.exe (see cmdScriptCommand). */
export const CMD_SCRIPT_VARIABLE = "CROT_CMD_SCRIPT";
/** Characters a cmd.exe path cannot contain to appear in the outer, delayed-expansion command line. */
const OUTER_LINE_UNSAFE = /[!%^"]/;

/**
 * Invocation running a cmd.exe script verbatim with UTF-8 output.
 *
 * cmd.exe converts the text written by its built-in commands (echo, dir, set,
 * type, ...) to bytes itself. With redirected output (a pipe, as for every CROT
 * command), a `chcp 65001` run by that same cmd process switches the console code
 * page (chcp, and programs started afterwards, report 65001) but not the code page
 * the running cmd uses for its built-ins: they keep writing the OEM code page and
 * every character outside it becomes "?". (Windows CI diagnostic: after a
 * successful chcp 65001, `echo grüße €✓ 日本` wrote 67 72 81 e1 65 20 3f fb 20 3f 3f.)
 *
 * The script therefore runs in a cmd.exe started after the switch. An outer cmd
 * runs chcp 65001 in the child's own hidden console, then starts the inner cmd,
 * which runs the script exactly like `cmd /d /s /c "<script>"` (Node's
 * `shell: true`). The script travels in an environment variable that the outer cmd
 * expands with delayed expansion, after it has parsed its own line, so the outer cmd
 * never interprets the script's quotes, operators, % or !. The inner cmd removes the
 * variable before the script runs and keeps cmd's defaults (delayed expansion off).
 *
 * Output stays bytes decoded by EncodingSupport; nothing here claims an encoding.
 * If the switch fails, built-ins write the OEM code page, which "auto" detects as
 * invalid UTF-8 and reports. A cmd.exe path containing ! % ^ or " cannot appear in
 * the outer line; then a single cmd runs the script and built-in output stays in the
 * OEM code page (detected and reported the same way).
 */
export function cmdScriptCommand(comspec: string, script: string): CommandSpec {
  const chcp = w.join(w.dirname(comspec), "chcp.com");
  const switchConsole = `"${chcp}" 65001 >nul 2>nul`;
  if (OUTER_LINE_UNSAFE.test(comspec)) {
    return { file: comspec, args: ["/d", "/s", "/c", `"${switchConsole} & ${script}"`], windowsVerbatimArguments: true, display: script };
  }
  const outer = `${switchConsole} & "${comspec}" /d /s /c "!${CMD_SCRIPT_VARIABLE}!"`;
  return {
    file: comspec,
    args: ["/d", "/v:on", "/s", "/c", `"${outer}"`],
    env: { [CMD_SCRIPT_VARIABLE]: `set "${CMD_SCRIPT_VARIABLE}=" & ${script}` },
    windowsVerbatimArguments: true,
    display: script,
  };
}

/** Default cmd.exe location derived from the environment. */
export function comspecFrom(get: (name: string) => string | undefined): string {
  return get("ComSpec") ?? w.join(get("SystemRoot") ?? "C:\\Windows", "System32", "cmd.exe");
}

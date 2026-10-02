import type { Readable, Writable } from "node:stream";

/**
 * Platform abstraction of CROT Core.
 *
 * Everything that differs between Linux, macOS and Windows lives behind these
 * interfaces. Core services depend only on the interfaces; the default
 * implementation (createNodePlatform) uses portable Node.js APIs. A stronger
 * implementation (e.g. the CROT Native Host using Windows Job Objects or OS
 * sandboxing) can provide the same interfaces without changes to Core.
 *
 * Platform implementations perform no authorization: every operation is
 * authorized by the PermissionEngine before a platform method is called.
 */
export type OsFamily = "linux" | "macos" | "windows" | "posix";
export type PathStyle = "posix" | "win32";

export const SHELL_IDS = ["sh", "bash", "zsh", "cmd", "powershell", "pwsh"] as const;
export type ShellId = (typeof SHELL_IDS)[number];

export interface ShellInfo {
  readonly id: ShellId;
  /** Resolved executable. */
  readonly path: string;
}

export interface PlatformInfo {
  readonly os: OsFamily;
  /** Node.js platform identifier (linux, darwin, win32, ...). */
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly pathStyle: PathStyle;
  readonly pathSeparator: string;
  /** Separator of PATH-like environment variables. */
  readonly pathListDelimiter: string;
  /** Environment variable names are case-insensitive (Windows). */
  readonly caseInsensitiveEnvironment: boolean;
  readonly defaultShell: ShellId;
  readonly shells: readonly ShellInfo[];
  /** How command output is decoded (see EncodingSupport). */
  readonly encoding: { readonly codePages: CodePages | null; readonly fallback: string | null };
}

/** Platform path syntax rules and comparisons. Pure: no filesystem access. */
export interface PathRules {
  readonly style: PathStyle;
  readonly sep: string;
  /** Throw INVALID_INPUT when `input` uses syntax that is unsafe or ambiguous on this platform. */
  validate(input: string): void;
  isAbsolute(p: string): boolean;
  resolve(...segments: string[]): string;
  dirname(p: string): string;
  basename(p: string): string;
  join(...segments: string[]): string;
  /** Filesystem root of an absolute path (e.g. "/", "C:\\", "\\\\server\\share\\"). */
  root(p: string): string;
  /**
   * Relative segments of `candidate` below `ancestor` (both absolute and
   * normalized), or null when `candidate` is not `ancestor` or inside it.
   */
  relativeSegments(ancestor: string, candidate: string, caseSensitive: boolean): string[] | null;
  equals(a: string, b: string, caseSensitive: boolean): boolean;
}

/** Environment construction for child processes. */
export interface EnvironmentPolicy {
  readonly caseInsensitive: boolean;
  /**
   * Merge `overrides` into `base`. A null override removes the variable.
   * On case-insensitive platforms, an override replaces any differently-cased
   * existing name instead of creating a duplicate.
   */
  merge(base: Readonly<Record<string, string | undefined>>, overrides?: Readonly<Record<string, string | null>>): Record<string, string>;
  /** Look up a variable using the platform's name semantics. */
  get(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined;
}

/** A fully resolved program invocation. */
export interface CommandSpec {
  readonly file: string;
  readonly args: readonly string[];
  /** Pass `args` to the OS untouched (Windows only; required for cmd.exe). */
  readonly windowsVerbatimArguments?: boolean;
  /** Human-readable form for audit/status. */
  readonly display: string;
}

export interface ShellProvider {
  readonly defaultShell: ShellId;
  /** Shells detected on this machine. */
  available(): readonly ShellInfo[];
  /** Build the invocation that runs `script` with `shell` (default shell when omitted). */
  command(script: string, shell?: ShellId): CommandSpec;
}

export interface LaunchOptions {
  readonly cwd: string;
  /** Complete child environment (already merged by the EnvironmentPolicy). */
  readonly env: Readonly<Record<string, string>>;
  /** Provide a writable stdin pipe; otherwise stdin is empty. */
  readonly stdin: boolean;
}

export interface ExitStatus {
  readonly code: number | null;
  readonly signal: string | null;
}

export type TerminationMode = "graceful" | "force";

/** A running child process together with the process tree it owns. */
export interface ManagedProcess {
  readonly pid: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Resolves when the direct child exits. */
  readonly exited: Promise<ExitStatus>;
  readonly hasExited: boolean;
  /**
   * Terminate the process tree. Works after the direct child has exited where
   * the platform allows it (POSIX process groups).
   */
  terminate(mode: TerminationMode): Promise<void>;
}

export interface ProcessLauncher {
  /**
   * Resolve a command name or path into an invocation, honouring platform
   * lookup rules (PATH, PATHEXT, .cmd/.bat wrappers on Windows).
   * Throws NOT_FOUND when the executable cannot be found.
   */
  resolveCommand(command: string, args: readonly string[], options: { cwd: string; env: Readonly<Record<string, string>> }): Promise<CommandSpec>;
  /** Start a process. Throws NOT_FOUND / OPERATION_FAILED when it cannot start. */
  launch(spec: CommandSpec, options: LaunchOptions): Promise<ManagedProcess>;
  /** Whether terminate() can reach descendants after the direct child exited. */
  readonly canTerminateOrphanedDescendants: boolean;
}

/** Windows OEM (console) and ANSI code pages. */
export interface CodePages {
  readonly oem: number;
  readonly ansi: number;
}

export interface TextDecoding {
  /** Canonical name, e.g. "utf-8", "cp850", "windows-1252". */
  readonly name: string;
  /** Decode bytes. With `fatal`, return null instead of replacing invalid input. */
  decode(bytes: Uint8Array, fatal: boolean): string | null;
}

/**
 * auto: UTF-8 (UTF-16 when a UTF-16LE BOM is present); output that is not valid
 * UTF-8 is decoded with `fallback` (the Windows console code page) when there is one.
 */
export type ResolvedEncoding = { readonly mode: "auto"; readonly fallback: TextDecoding | null } | { readonly mode: "fixed"; readonly decoding: TextDecoding };

/** Decoding of command output. */
export interface EncodingSupport {
  /** Windows OEM/ANSI code pages; null where the native output encoding is UTF-8. */
  readonly codePages: CodePages | null;
  /** Encoding used by "auto" for output that is not UTF-8, or null. */
  readonly fallback: string | null;
  /** Resolve a requested encoding ("auto", "utf-8", "utf-16le", "oem", "ansi", "cp850", WHATWG labels). Throws INVALID_INPUT. */
  resolve(requested: string): ResolvedEncoding;
}

export interface Platform {
  readonly info: PlatformInfo;
  readonly paths: PathRules;
  readonly environment: EnvironmentPolicy;
  readonly shells: ShellProvider;
  readonly launcher: ProcessLauncher;
  readonly encodings: EncodingSupport;
  /** Probe whether paths below `directory` compare case-sensitively. */
  probeCaseSensitivity(directory: string): Promise<boolean>;
}

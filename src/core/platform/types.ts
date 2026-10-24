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
  /** OS-conventional default locations (see platformDirectories). */
  readonly directories: PlatformDirectories;
  /** Protection of CROT's private files (see PrivateFileProtection). */
  readonly privateFiles: { readonly mechanism: PrivateFileProtection["mechanism"]; readonly enforced: boolean };
  /** Process-tree guarantees of the launcher. */
  readonly processControl: ProcessControlInfo;
  /** Signals on which a CROT host process should shut down gracefully. */
  readonly shutdownSignals: readonly NodeJS.Signals[];
  /** Where the PATH of child processes came from. */
  readonly startupPath: StartupPathInfo;
  /** How command output is decoded (see EncodingSupport). */
  readonly encoding: { readonly codePages: CodePages | null; readonly fallback: string | null };
}

/** How CROT's private files (audit log, state, HTTP token) are protected from other local users. */
export interface PrivateFileProtection {
  /**
   * posix-mode: owner-only permission bits (Core).
   * inherited-acl: Windows ACLs inherited from the directory, not restricted (Core).
   * windows-acl: explicit owner-only Windows ACLs, inheritance removed (Native Host).
   */
  readonly mechanism: "posix-mode" | "inherited-acl" | "windows-acl";
  /** Whether the platform itself restricts access to the owner. */
  readonly enforced: boolean;
  /** Mode for newly created private files (POSIX), undefined where modes do not apply. */
  readonly fileMode: number | undefined;
  /** Create a directory for private files; new directories are owner-only where supported. */
  ensureDirectory(dir: string): Promise<void>;
  /**
   * Restrict an existing file (or an explicitly owned private-state directory)
   * to the CROT user. Never use this to rewrite an arbitrary workspace parent.
   * Provided where protection is
   * not expressed by a creation mode (Windows ACLs). Callers create the file
   * empty, call protectFile, and only then write secrets into it.
   */
  protectFile?(file: string): Promise<void>;
  inspect(file: string): Promise<PrivateFileStatus>;
}

export interface PrivateFileStatus {
  readonly mechanism: PrivateFileProtection["mechanism"];
  /** true/false where the platform can determine it; null when it cannot (Core on Windows). */
  readonly ownerOnly: boolean | null;
  readonly detail: string;
}

/** Default directories for CROT's configuration, state and logs. */
export interface PlatformDirectories {
  readonly config: string;
  readonly state: string;
  readonly logs: string;
}

/**
 * auto: on macOS/Linux, use the login shell's PATH when CROT was not started
 * from a shell (desktop-launched clients); login-shell: always; inherited: never.
 */
export const STARTUP_PATH_MODES = ["auto", "login-shell", "inherited"] as const;
export type StartupPathMode = (typeof STARTUP_PATH_MODES)[number];

export interface StartupPathInfo {
  readonly mode: StartupPathMode;
  readonly source: "inherited" | "login-shell";
  /** Entries added to the inherited PATH (login shell, standard directories). */
  readonly added: readonly string[];
  /** Login shell that supplied PATH. */
  readonly shell?: string;
  /** Why the login shell PATH could not be used. */
  readonly note?: string;
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
  merge(
    base: Readonly<Record<string, string | undefined>>,
    overrides?: Readonly<Record<string, string | null>>,
  ): Record<string, string>;
  /** Look up a variable using the platform's name semantics. */
  get(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined;
}

/** A fully resolved program invocation. */
export interface CommandSpec {
  readonly file: string;
  readonly args: readonly string[];
  /** Pass `args` to the OS untouched (Windows only; required for cmd.exe). */
  readonly windowsVerbatimArguments?: boolean;
  /**
   * Variables the invocation itself needs (for example a cmd.exe script passed
   * without command-line parsing). The launcher applies them over the launch
   * environment with the platform's name semantics.
   */
  readonly env?: Readonly<Record<string, string>>;
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
  /** Fatal launcher/transport failure, independent of the actual child exit code. */
  readonly failure?: Error | undefined;
  /**
   * Terminate the process tree. Works after the direct child has exited where
   * the platform allows it (POSIX process groups, Windows Job Objects).
   */
  terminate(mode: TerminationMode): Promise<void>;
  /**
   * Forced, synchronous termination of the process tree. Used when CROT itself
   * is exiting and asynchronous work can no longer complete (process 'exit').
   */
  terminateSync(): void;
}

export interface ResolveCommandOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * Search the working directory (default true). When false, only absolute
   * (fully qualified) PATH entries are searched and command names containing
   * a path are refused, so a program can never be taken from the working
   * directory or a relative PATH entry (ARCHITECTURE.md §27, AD-1). Every
   * launcher (Core and Native Host) must honour it.
   */
  readonly searchCurrentDirectory?: boolean;
}

export interface ProcessLauncher {
  /**
   * Resolve a command name or path into an invocation, honouring platform
   * lookup rules (PATH, PATHEXT, .cmd/.bat wrappers on Windows).
   * Throws NOT_FOUND when the executable cannot be found.
   */
  resolveCommand(command: string, args: readonly string[], options: ResolveCommandOptions): Promise<CommandSpec>;
  /** Start a process. Throws NOT_FOUND / OPERATION_FAILED when it cannot start. */
  launch(spec: CommandSpec, options: LaunchOptions): Promise<ManagedProcess>;
  /** Whether terminate() can reach descendants after the direct child exited. */
  readonly canTerminateOrphanedDescendants: boolean;
  /** What the launcher guarantees about process trees (reported in crot_status). */
  readonly processControl: ProcessControlInfo;
}

/**
 * Process-tree guarantees of a ProcessLauncher.
 * - process-group (POSIX): every command leads its own process group.
 * - taskkill-tree (Windows, Core): tree termination by parent-child links via taskkill /T.
 * - job-object (Windows, Native Host): kernel-enforced containment of every descendant
 *   (kill-on-close Job Object per command).
 */
export interface ProcessControlInfo {
  readonly treeTermination: "process-group" | "taskkill-tree" | "job-object";
  /** Descendants are terminated even after their parent exited. */
  readonly orphanedDescendants: boolean;
  /** terminate("graceful") lets console programs clean up (SIGTERM); otherwise graceful requests escalate to forced termination after a grace period. */
  readonly gracefulTermination: boolean;
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
export type ResolvedEncoding =
  | { readonly mode: "auto"; readonly fallback: TextDecoding | null }
  | { readonly mode: "fixed"; readonly decoding: TextDecoding };

/** Decoding of command output. */
export interface EncodingSupport {
  /** Windows OEM/ANSI code pages; null where the native output encoding is UTF-8. */
  readonly codePages: CodePages | null;
  /** Encoding used by "auto" for output that is not UTF-8, or null. */
  readonly fallback: string | null;
  /** Resolve a requested encoding ("auto", "utf-8", "utf-16le", "oem", "ansi", "cp850", WHATWG labels). Throws INVALID_INPUT. */
  resolve(requested: string): ResolvedEncoding;
}

/** Stable reason codes reported when command confinement L1 is not usable (ARCHITECTURE.md §27 AD-20 point 12). */
export const CONFINEMENT_REASON_CODES = [
  "not_implemented",
  "userns_unavailable",
  "components_missing",
  "components_mismatch",
  "apparmor_unavailable",
  "apparmor_profile_not_loaded",
  "apparmor_unix_mediation_unavailable",
  "overlay_unavailable",
  "private_storage_unavailable",
  "self_test_failed",
] as const;
export type ConfinementReason = (typeof CONFINEMENT_REASON_CODES)[number];

/** The owner-configured network mode of L1 (`confinement.network`, AD-20 point 8). */
export const CONFINEMENT_NETWORK_MODES = ["on", "off"] as const;
export type ConfinementNetwork = (typeof CONFINEMENT_NETWORK_MODES)[number];

/**
 * State of command confinement L1 (AD-20 point 12), the same shape in
 * crot_status and the control overview. `reason` is null exactly when
 * `available` is true; `detail` is one line without secrets or CROT-protected
 * paths.
 */
export interface ConfinementStatus {
  readonly mechanism: "linux-bubblewrap" | "windows-appcontainer" | "macos-seatbelt" | "none";
  readonly available: boolean;
  readonly network: ConfinementNetwork;
  readonly reason: ConfinementReason | null;
  readonly detail: string | null;
}

/** A refusal of the L1 Docker endpoint (AD-20 points 9 and 13): request kind and reason, never a payload. */
export interface ConfinementAuditEvent {
  readonly event: "confinement.docker_refused";
  readonly request: string;
  readonly reason: string;
}

/** What one Core hands to the platform to confine the children of its process tools (AD-20 points 6-10). */
export interface ConfinementScope {
  /** Workspace root (read-write in the sandbox). */
  readonly workspace: string;
  /** CROT-protected paths, computed from the resolved configuration (AD-20 point 6). */
  readonly protectedPaths: readonly string[];
  readonly network: ConfinementNetwork;
  /** Environment of the service's Docker CLI, used upstream by the Docker endpoint (AD-20 point 9). */
  readonly dockerEnvironment: Readonly<Record<string, string>>;
  /** Audit of Docker endpoint refusals. */
  readonly audit: (event: ConfinementAuditEvent) => void;
}

/**
 * Confinement of one Core: one sandbox, started with the first confined
 * launch and ended by close() (AD-20 point 10). Performs no authorization:
 * ProcessService calls it only after the PermissionEngine authorized the
 * operation.
 */
export interface CoreConfinement {
  /** Optional sticky post-admission failure guard. Does not run readiness checks. */
  assertAdmission?(): void;
  /** Last reported state (no checks run). */
  status(): ConfinementStatus;
  /** Run the availability checks (AD-20 point 12) and report the result. */
  refresh(): Promise<ConfinementStatus>;
  /**
   * Launches inside the Core's sandbox. A launch that fails for a sandbox
   * reason throws CONFINEMENT_FAILED and never starts the command elsewhere.
   */
  readonly launcher: ProcessLauncher;
  close(): Promise<void>;
  /** Synchronous end of the sandbox (host process 'exit'). */
  closeSync(): void;
}

/** Platform support for command confinement L1. */
export interface CommandConfinement {
  /** State of the machine in a network mode, without a Core. */
  probe(network: ConfinementNetwork): Promise<ConfinementStatus>;
  open(scope: ConfinementScope): Promise<CoreConfinement>;
}

/** Read-only OS evidence; never a network permission or proof of free ports. */
export interface ProjectPort {
  pid: number;
  address: string;
  port: number;
}
export interface ProjectPorts {
  status: "observed" | "partial" | "unavailable";
  scope: "same-user-workspace-cwd";
  listeners: ProjectPort[];
  notes: string[];
}
export interface Platform {
  readonly info: PlatformInfo;
  readonly paths: PathRules;
  readonly environment: EnvironmentPolicy;
  /** Base environment for child processes: the CROT environment with the startup PATH applied. */
  readonly baseEnvironment: Readonly<Record<string, string>>;
  readonly shells: ShellProvider;
  readonly launcher: ProcessLauncher;
  readonly encodings: EncodingSupport;
  readonly privateFiles: PrivateFileProtection;
  /** Probe whether paths below `directory` compare case-sensitively. */
  probeCaseSensitivity(directory: string): Promise<boolean>;
  /**
   * Command confinement L1 (AD-20). Absent: no confinement mechanism on this
   * platform (reported as `not_implemented`).
   */
  readonly confinement?: CommandConfinement;
  /** Caller must authorize process.project_ports through ExecutionGuard first. */
  readonly observeProjectPorts?: (root: string, signal?: AbortSignal) => Promise<ProjectPorts>;
}

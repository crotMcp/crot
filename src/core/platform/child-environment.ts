/**
 * Environment of the children of process tools (shell.execute,
 * process.manage; WP-21, ARCHITECTURE.md §27 AD-18).
 *
 * Children never inherit the CROT process environment as a whole: it is the
 * environment of the supervisor or MCP client that started CROT and can hold
 * API keys, tokens and session addresses that the agent must not get. Only
 * variables on an allowlist are passed: what shells, compilers, package
 * managers and the OS need to run (paths, locale, terminal, temporary
 * directories, proxies, toolchain homes, the Windows system variables), plus
 * the names or prefixes listed in `environment.allow`.
 *
 * Override semantics (the `env` argument of the tools): a string sets a
 * variable to that literal value, null removes it. An override can only add
 * values the caller already knows; it can never copy a withheld variable from
 * the CROT environment into the child (there is no inheritance or expansion).
 *
 * Deliberately not on the list: session bus addresses
 * (DBUS_SESSION_BUS_ADDRESS reaches the user's keyring and desktop services)
 * and PSModulePath (a PowerShell 7 value breaks Windows PowerShell; PowerShell
 * builds its default module path without it). PSModuleAnalysisCachePath, a
 * cache location, is passed: without it module auto-loading re-analyses every
 * installed module. The owner can still allow any name with environment.allow.
 *
 * Git keeps its own rules on top of this base (GIT_* removed, fixed
 * variables; AD-2); Docker keeps its narrower list (AD-3).
 */

/** Built-in allowlist. Entries ending in "*" are prefixes. Compared case-insensitively on Windows. */
export const CHILD_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  // Paths, identity, shell, locale, terminal
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_*",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Desktop session (graphical tools) and the SSH agent socket (Git over SSH)
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_DIRS",
  "SSH_AUTH_SOCK",
  // Proxies (both spellings on POSIX)
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  // Toolchain locations
  "JAVA_HOME",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "NVM_DIR",
  "PYENV_ROOT",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "DEVELOPER_DIR",
  // Docker CLI connection (what docker.use also forwards, AD-3)
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  // macOS
  "__CF_USER_TEXT_ENCODING",
  // Windows system variables
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "NUMBER_OF_PROCESSORS",
  "COMPUTERNAME",
  "DRIVERDATA",
  // PowerShell: location of a prebuilt module analysis cache. Without it PowerShell re-analyses every
  // installed module before it can auto-load a cmdlet such as Write-Output (tens of seconds on hosts
  // with many modules, for example the GitHub Actions Windows images that set it machine-wide).
  "PSMODULEANALYSISCACHEPATH",
]);

export interface ChildEnvironmentSummary {
  readonly policy: "allowlist";
  /** Entries of environment.allow. */
  readonly extraAllowed: readonly string[];
  /** Names passed from the CROT environment (no values). */
  readonly passed: readonly string[];
  /** Number of variables of the CROT environment that children do not get. */
  readonly withheld: number;
}

export interface ChildEnvironment {
  /** The environment children start from (before tool overrides). */
  readonly base: Readonly<Record<string, string>>;
  readonly summary: ChildEnvironmentSummary;
  /** Whether a variable name is passed from the CROT environment. */
  allows(name: string): boolean;
}

/** Filter `env` to the allowlist plus `extra` (environment.allow). */
export function createChildEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  extra: readonly string[],
  caseInsensitive: boolean,
): ChildEnvironment {
  const norm = (s: string) => (caseInsensitive ? s.toUpperCase() : s);
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of [...CHILD_ENV_ALLOWLIST, ...extra]) {
    if (entry.endsWith("*")) prefixes.push(norm(entry.slice(0, -1)));
    else exact.add(norm(entry));
  }
  const allows = (name: string) => {
    const n = norm(name);
    return exact.has(n) || prefixes.some((p) => n.startsWith(p));
  };
  const base: Record<string, string> = {};
  let withheld = 0;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (allows(name)) base[name] = value;
    else withheld++;
  }
  return {
    base: Object.freeze(base),
    allows,
    summary: Object.freeze({
      policy: "allowlist" as const,
      extraAllowed: Object.freeze([...extra]),
      passed: Object.freeze(Object.keys(base).sort()),
      withheld,
    }),
  };
}

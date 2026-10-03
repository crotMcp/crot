/**
 * Git configuration policy of `git.read` (ARCHITECTURE.md §27, AD-1, point 4).
 *
 * Repository configuration (local and worktree scope) may only contain keys
 * that cannot make Git start a program. The list is deny-by-default: a key that
 * is not listed here refuses the operation, including include/includeIf (which
 * would pull in configuration CROT has not inspected). System and global
 * configuration is not loaded at all; only the keys in FORWARDED_GLOBAL_KEYS
 * are carried over from it.
 */

export interface ConfigEntry {
  /** Git scope: system, global, local, worktree, command or unknown. */
  readonly scope: string;
  /** Canonical key as printed by Git (section and variable lower case, subsection verbatim). */
  readonly key: string;
  /** Value, or null for a key without "=" (boolean true). */
  readonly value: string | null;
}

interface SectionRule {
  /** Allowed variables of `section.variable` keys; "*" allows every variable. */
  readonly plain?: readonly string[] | "*";
  /** Allowed variables of `section.<subsection>.variable` keys; "*" allows every variable. */
  readonly sub?: readonly string[] | "*";
}

/** Keys that only describe data, layout or presentation and never name a program to run. */
const SAFE_REPOSITORY_KEYS: Readonly<Record<string, SectionRule>> = {
  core: {
    plain: [
      "repositoryformatversion",
      "filemode",
      "bare",
      "logallrefupdates",
      "ignorecase",
      "precomposeunicode",
      "symlinks",
      "autocrlf",
      "safecrlf",
      "eol",
      "quotepath",
      "abbrev",
      "longpaths",
      "fscache",
      "checkstat",
      "trustctime",
      "splitindex",
      "untrackedcache",
      "commitgraph",
      "multipackindex",
      "compression",
      "loosecompression",
      "whitespace",
      "warnambiguousrefs",
      "sharedrepository",
      "worktree",
      "protecthfs",
      "protectntfs",
      "preloadindex",
    ],
  },
  extensions: { plain: ["objectformat", "worktreeconfig", "refstorage", "preciousobjects", "noop"] },
  remote: {
    sub: [
      "url",
      "pushurl",
      "fetch",
      "push",
      "tagopt",
      "prune",
      "prunetags",
      "mirror",
      "skipfetchall",
      "skipdefaultupdate",
    ],
  },
  branch: {
    plain: ["autosetupmerge", "autosetuprebase", "sort"],
    sub: ["remote", "merge", "rebase", "pushremote", "description"],
  },
  user: { plain: ["name", "email", "signingkey", "useconfigonly"] },
  author: { plain: ["name", "email"] },
  committer: { plain: ["name", "email"] },
  init: { plain: ["defaultbranch"] },
  commit: { plain: ["gpgsign", "verbose", "cleanup", "status"] },
  tag: { plain: ["gpgsign", "sort", "forcesignannotated"] },
  pull: { plain: ["rebase", "ff"] },
  push: { plain: ["default", "autosetupremote", "followtags"] },
  fetch: { plain: ["prune", "prunetags", "writecommitgraph", "parallel"] },
  merge: { plain: ["ff", "conflictstyle", "log", "renames"] },
  rebase: { plain: ["autosquash", "autostash", "updaterefs"] },
  rerere: { plain: ["enabled", "autoupdate"] },
  submodule: { plain: ["recurse"], sub: ["url", "active", "branch", "shallow", "ignore"] },
  diff: {
    plain: [
      "renames",
      "algorithm",
      "context",
      "noprefix",
      "mnemonicprefix",
      "indentheuristic",
      "renamelimit",
      "interhunkcontext",
      "statgraphwidth",
      "suppressblankempty",
      "ignoresubmodules",
      "colormoved",
      "wserrorhighlight",
    ],
  },
  status: {
    plain: [
      "showuntrackedfiles",
      "relativepaths",
      "branch",
      "short",
      "renames",
      "renamelimit",
      "aheadbehind",
      "showstash",
    ],
  },
  log: { plain: ["date", "decorate", "abbrevcommit", "follow", "mailmap", "showroot"] },
  color: { plain: "*", sub: "*" },
  advice: { plain: "*" },
  i18n: { plain: ["commitencoding", "logoutputencoding"] },
  gc: { plain: ["auto", "autopacklimit", "autodetach", "reflogexpire", "reflogexpireunreachable", "pruneexpire"] },
  index: { plain: ["version", "threads", "skiphash", "sparse"] },
  feature: { plain: ["manyfiles", "experimental"] },
  lfs: { plain: ["repositoryformatversion"] },
};

/** Keys carried over from system/global configuration (line endings and rename detection; no programs). */
export const FORWARDED_GLOBAL_KEYS: readonly string[] = [
  "core.autocrlf",
  "core.eol",
  "core.safecrlf",
  "core.precomposeunicode",
  "core.longpaths",
  "core.checkstat",
  "core.trustctime",
  "core.fscache",
  "diff.renames",
  "diff.algorithm",
];

const INHERITED_SCOPES = new Set(["system", "global"]);

/** Parse `git config --list --null --show-scope` output: `scope NUL key [LF value] NUL` per entry. */
export function parseConfigList(output: string): ConfigEntry[] {
  const tokens = output.split("\0");
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const scope = tokens[i]!;
    const keyValue = tokens[i + 1]!;
    if (scope === "" && keyValue === "") break;
    const newline = keyValue.indexOf("\n");
    entries.push(
      newline < 0
        ? { scope, key: keyValue, value: null }
        : { scope, key: keyValue.slice(0, newline), value: keyValue.slice(newline + 1) },
    );
  }
  return entries;
}

/** Whether a repository-scope key is on the allowlist. */
export function isAllowedRepositoryKey(key: string): boolean {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first <= 0 || last === key.length - 1) return false;
  const section = key.slice(0, first).toLowerCase();
  const variable = key.slice(last + 1).toLowerCase();
  const rule = Object.prototype.hasOwnProperty.call(SAFE_REPOSITORY_KEYS, section)
    ? SAFE_REPOSITORY_KEYS[section]
    : undefined;
  if (!rule) return false;
  const allowed = first === last ? rule.plain : rule.sub;
  if (allowed === undefined) return false;
  return allowed === "*" || allowed.includes(variable);
}

export interface ConfigReview {
  /** Repository-scope keys that are not allowed (deduplicated, in order of appearance). */
  readonly unsafeKeys: readonly string[];
  /** `key=value` settings carried over from system/global configuration (passed with -c). */
  readonly forwarded: readonly string[];
}

/**
 * Review a configuration listing. Every key outside the system and global
 * scopes (local, worktree, command, unknown) must be allowed. Forwarded keys
 * are taken from system/global configuration unless the repository sets them itself.
 */
export function reviewConfig(entries: readonly ConfigEntry[]): ConfigReview {
  const unsafe: string[] = [];
  const repositoryKeys = new Set<string>();
  const inherited = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.key.toLowerCase();
    if (INHERITED_SCOPES.has(entry.scope)) {
      if (FORWARDED_GLOBAL_KEYS.includes(key) && entry.value !== null && /^[^\0-\x1f\x7f]*$/.test(entry.value)) {
        inherited.set(key, entry.value);
      }
      continue;
    }
    repositoryKeys.add(key);
    if (!isAllowedRepositoryKey(entry.key) && !unsafe.includes(entry.key)) unsafe.push(entry.key);
  }
  const forwarded = [...inherited.entries()].filter(([k]) => !repositoryKeys.has(k)).map(([k, v]) => `${k}=${v}`);
  return { unsafeKeys: unsafe, forwarded };
}

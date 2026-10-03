/** Parsers for machine-readable Git output used by `git.read`. Pure functions. */

export interface StatusBranch {
  /** Current branch name, or null when HEAD is detached. */
  readonly head: string | null;
  /** Commit of HEAD, or null in a repository without commits. */
  readonly oid: string | null;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
}

export type StatusEntryKind = "changed" | "renamed" | "copied" | "unmerged" | "untracked" | "ignored";

export interface StatusEntry {
  /** Path relative to the repository root, '/' separated. */
  readonly path: string;
  /** Source path of a rename or copy. */
  readonly origPath?: string;
  readonly kind: StatusEntryKind;
  /** Index (staged) status letter: M, T, A, D, R, C, U, '.' (unchanged), '?' or '!'. */
  readonly index: string;
  /** Worktree status letter, same alphabet. */
  readonly worktree: string;
}

export interface ParsedStatus {
  readonly branch: StatusBranch;
  readonly entries: StatusEntry[];
}

/** Drop the trailing token: either empty (complete output) or possibly cut off (truncated output). */
function completeTokens(output: string, separator: string): string[] {
  const tokens = output.split(separator);
  tokens.pop();
  return tokens;
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(output: string): ParsedStatus {
  const tokens = completeTokens(output, "\0");
  let head: string | null = null;
  let oid: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("# ")) {
      const [, name, ...rest] = token.split(" ");
      const value = rest.join(" ");
      if (name === "branch.oid") oid = value === "(initial)" ? null : value;
      else if (name === "branch.head") head = value === "(detached)" ? null : value;
      else if (name === "branch.upstream") upstream = value;
      else if (name === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
      continue;
    }
    const fields = token.split(" ");
    const type = fields[0];
    const xy = fields[1] ?? "..";
    if (type === "1") {
      entries.push({ path: fields.slice(8).join(" "), kind: "changed", index: xy[0]!, worktree: xy[1]! });
    } else if (type === "2") {
      const origPath = tokens[i + 1];
      if (origPath === undefined) break;
      i++;
      const score = fields[8] ?? "R";
      entries.push({
        path: fields.slice(9).join(" "),
        origPath,
        kind: score.startsWith("C") ? "copied" : "renamed",
        index: xy[0]!,
        worktree: xy[1]!,
      });
    } else if (type === "u") {
      entries.push({ path: fields.slice(10).join(" "), kind: "unmerged", index: xy[0]!, worktree: xy[1]! });
    } else if (type === "?") {
      entries.push({ path: token.slice(2), kind: "untracked", index: "?", worktree: "?" });
    } else if (type === "!") {
      entries.push({ path: token.slice(2), kind: "ignored", index: "!", worktree: "!" });
    }
  }
  return { branch: { head, oid, upstream, ahead, behind }, entries };
}

export interface CommitPerson {
  readonly name: string;
  readonly email: string;
  /** ISO 8601 date. */
  readonly date: string;
}

export interface CommitInfo {
  readonly sha: string;
  readonly parents: string[];
  readonly author: CommitPerson;
  readonly committer: CommitPerson;
  readonly subject: string;
  readonly body: string;
}

/** `git log -z --format=` producing the fields parsed by parseLog. */
export const LOG_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B";
const LOG_FIELDS = 9;

/** Parse `git log -z --format=LOG_FORMAT`. A record cut off by truncation is dropped. */
export function parseLog(output: string): CommitInfo[] {
  if (output.length === 0) return [];
  const tokens = output.split("\0");
  const count = Math.floor((tokens.length - 1) / LOG_FIELDS);
  const commits: CommitInfo[] = [];
  for (let c = 0; c < count; c++) {
    const f = tokens.slice(c * LOG_FIELDS, (c + 1) * LOG_FIELDS);
    const message = (f[8] ?? "").replace(/\s+$/, "");
    const newline = message.indexOf("\n");
    commits.push({
      sha: f[0]!,
      parents: f[1] ? f[1].split(" ").filter(Boolean) : [],
      author: { name: f[2]!, email: f[3]!, date: f[4]! },
      committer: { name: f[5]!, email: f[6]!, date: f[7]! },
      subject: newline < 0 ? message : message.slice(0, newline),
      body: newline < 0 ? "" : message.slice(newline + 1).replace(/^\s*\n/, ""),
    });
  }
  return commits;
}

export interface BranchInfo {
  /** Short name (e.g. "main", "origin/main"). */
  readonly name: string;
  /** Full ref name (e.g. "refs/heads/main"). */
  readonly ref: string;
  readonly remote: boolean;
  readonly commit: string;
  readonly current: boolean;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  /** The configured upstream no longer exists. */
  readonly upstreamGone: boolean;
}

/** `git for-each-ref --format=` producing the fields parsed by parseBranches. */
export const BRANCH_FORMAT =
  "%(HEAD)%00%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)";

/** Parse `git for-each-ref --format=BRANCH_FORMAT` (one record per line). */
export function parseBranches(output: string): BranchInfo[] {
  const branches: BranchInfo[] = [];
  for (const line of completeTokens(output, "\n")) {
    const f = line.split("\0");
    if (f.length < 6) continue;
    const track = f[5] ?? "";
    const ahead = /ahead (\d+)/.exec(track);
    const behind = /behind (\d+)/.exec(track);
    branches.push({
      name: f[2]!,
      ref: f[1]!,
      remote: f[1]!.startsWith("refs/remotes/"),
      commit: f[3]!,
      current: f[0] === "*",
      upstream: f[4] ? f[4] : null,
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      upstreamGone: track === "gone",
    });
  }
  return branches;
}

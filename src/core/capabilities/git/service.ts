import { rmSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuthContext } from "../../auth/principal.js";
import type { Limits } from "../../config/schema.js";
import { CrotError, parseInput } from "../../errors.js";
import type { ExecutionGuard } from "../../execution/guard.js";
import type { ManagedProcess, Platform } from "../../platform/types.js";
import { displayPath as display, type ResolvedPath, type Workspace } from "../../workspace/workspace.js";
import { parseConfigList, reviewConfig } from "./config-policy.js";
import { discoverRepository, type DiscoveredRepository } from "./discovery.js";
import type { GitMetadataLock } from "./metadata-lock.js";
import { BRANCH_FORMAT, LOG_FORMAT, parseBranches, parseLog, parseStatus } from "./parse.js";
import {
  GitBranchInputSchema,
  GitDiffInputSchema,
  GitLogInputSchema,
  GitShowInputSchema,
  GitStatusInputSchema,
  type GitBranchInput,
  type GitBranchResult,
  type GitDiffInput,
  type GitLogInput,
  type GitLogResult,
  type GitRepositoryInfo,
  type GitShowInput,
  type GitStatusInput,
  type GitStatusResult,
  type GitTextResult,
} from "./schemas.js";

export interface GitServiceDeps {
  readonly workspace: Workspace;
  readonly guard: ExecutionGuard;
  readonly platform: Pick<Platform, "launcher" | "environment" | "baseEnvironment">;
  readonly limits: Pick<Limits, "defaultCommandTimeoutMs" | "maxCommandTimeoutMs" | "maxOutputBytes">;
  readonly lock: GitMetadataLock;
  /** Base environment for Git (defaults to the platform base environment). */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

/** Oldest Git that honours GIT_CONFIG_GLOBAL (needed to keep global configuration out). */
const MIN_GIT_VERSION: readonly [number, number] = [2, 32];
const STDERR_MAX_BYTES = 64 * 1024;
const STDERR_IN_ERROR_CHARS = 2_000;
const STDIO_CLOSE_GRACE_MS = 500;

/** Settings that keep every git.read command from starting programs or touching the network (AD-1, point 3). */
const FIXED_CONFIG: readonly string[] = [
  "core.fsmonitor=false",
  "core.quotePath=false",
  "color.ui=false",
  "log.showSignature=false",
  "protocol.allow=never",
  "submodule.recurse=false",
  "diff.ignoreSubmodules=all",
  "status.submoduleSummary=false",
];

interface Repository extends DiscoveredRepository {
  /** Pathspecs relative to the worktree root ('/' separated). */
  readonly pathspecs: readonly string[];
  /** `key=value` settings forwarded from system/global configuration (set after the review). */
  readonly forwarded: readonly string[];
}

interface GitEnvironments {
  readonly listing: Record<string, string>;
  readonly command: Record<string, string>;
  /** Like `command`, for Git run outside any repository (repository discovery stops at `dir`). */
  readonly standalone: Record<string, string>;
  /** Private directory holding the empty file used as GIT_CONFIG_GLOBAL. */
  readonly dir: string;
}

interface GitRun {
  readonly stdout: string;
  readonly truncated: boolean;
  readonly exitCode: number | null;
}

interface RunOptions {
  /** Exit codes that are not failures (default: 0). */
  readonly okExitCodes?: readonly number[];
  /** Apply the AD-1 command configuration (false only for the configuration listing itself). */
  readonly hardened?: boolean;
  /** Run outside the repository: cwd is CROT's private directory, no --git-dir/--work-tree, no -c settings. */
  readonly standalone?: boolean;
}

type GitOperation = "git.status" | "git.diff" | "git.log" | "git.branch" | "git.show";

/**
 * Git read capability of CROT Core (ARCHITECTURE.md §27, AD-1).
 *
 * - The repository is located by CROT (discovery.ts), and every path Git is
 *   pointed at — start directory, worktree, Git directory, common directory,
 *   pathspecs — is authorized by the ExecutionGuard with capability `git.read`.
 * - Repository configuration is reviewed before each operation; any key that
 *   could make Git run a program refuses the operation (UNSAFE_REPOSITORY).
 *   System and global configuration is not loaded.
 * - Git is resolved through PATH only (never from the working directory) and
 *   started without a shell, with GIT_* variables removed.
 * - The configuration check and the Git commands run under the GitMetadataLock,
 *   so CROT filesystem writes cannot change the Git directory in between.
 */
export class GitService {
  private readonly running = new Set<ManagedProcess>();
  private closing = false;
  private versionChecked = false;
  private environments: Promise<GitEnvironments> | undefined;
  private environmentDir: string | undefined;

  constructor(private readonly deps: GitServiceDeps) {}

  async status(context: AuthContext, input: GitStatusInput): Promise<GitStatusResult> {
    const args = parseInput(GitStatusInputSchema, input);
    return this.operation(
      context,
      "git.status",
      args.cwd,
      args.paths,
      args.timeoutMs,
      { untracked: args.untracked, ignored: args.ignored },
      async (repo, deadline) => {
        const git = [
          "status",
          "--porcelain=v2",
          "--branch",
          "-z",
          "--ignore-submodules=all",
          `--untracked-files=${args.untracked}`,
        ];
        if (args.ignored) git.push("--ignored=matching");
        git.push("--", ...repo.pathspecs);
        const run = await this.runGit(repo, git, deadline);
        const parsed = parseStatus(run.stdout);
        return {
          repository: info(repo),
          branch: parsed.branch,
          entries: parsed.entries,
          clean: !run.truncated && parsed.entries.every((e) => e.kind === "ignored"),
          truncated: run.truncated,
        };
      },
    );
  }

  async diff(context: AuthContext, input: GitDiffInput): Promise<GitTextResult> {
    const args = parseInput(GitDiffInputSchema, input);
    const details = {
      staged: args.staged,
      from: args.from ?? null,
      to: args.to ?? null,
      stat: args.stat,
      nameOnly: args.nameOnly,
    };
    return this.operation(
      context,
      "git.diff",
      args.cwd,
      args.paths,
      args.timeoutMs,
      details,
      async (repo, deadline) => {
        const git = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all"];
        if (args.staged) git.push("--cached");
        if (args.contextLines !== undefined) git.push(`--unified=${args.contextLines}`);
        if (args.stat) git.push("--stat");
        if (args.nameOnly) git.push("--name-status");
        git.push("--end-of-options");
        if (args.from !== undefined) git.push(args.from);
        if (args.to !== undefined) git.push(args.to);
        git.push("--", ...repo.pathspecs);
        const run = await this.runGit(repo, git, deadline);
        return { repository: info(repo), output: run.stdout, truncated: run.truncated };
      },
    );
  }

  async log(context: AuthContext, input: GitLogInput): Promise<GitLogResult> {
    const args = parseInput(GitLogInputSchema, input);
    const details = { revision: args.revision ?? null, maxCount: args.maxCount, skip: args.skip };
    return this.operation(context, "git.log", args.cwd, args.paths, args.timeoutMs, details, async (repo, deadline) => {
      if (args.revision === undefined && !(await this.hasHeadCommit(repo, deadline))) {
        return { repository: info(repo), commits: [], truncated: false };
      }
      const git = [
        "log",
        "-z",
        `--format=${LOG_FORMAT}`,
        "--no-color",
        `--max-count=${args.maxCount}`,
        `--skip=${args.skip}`,
      ];
      git.push("--end-of-options", args.revision ?? "HEAD", "--", ...repo.pathspecs);
      const run = await this.runGit(repo, git, deadline);
      return { repository: info(repo), commits: parseLog(run.stdout), truncated: run.truncated };
    });
  }

  async branch(context: AuthContext, input: GitBranchInput): Promise<GitBranchResult> {
    const args = parseInput(GitBranchInputSchema, input);
    return this.operation(
      context,
      "git.branch",
      args.cwd,
      [],
      args.timeoutMs,
      { remote: args.remote },
      async (repo, deadline) => {
        const head = await this.runGit(repo, ["symbolic-ref", "-q", "HEAD"], deadline, { okExitCodes: [0, 1] });
        const headRef = head.exitCode === 0 ? head.stdout.trim() : null;
        const refs = ["refs/heads", ...(args.remote ? ["refs/remotes"] : [])];
        const run = await this.runGit(
          repo,
          ["for-each-ref", `--format=${BRANCH_FORMAT}`, "--sort=refname", ...refs],
          deadline,
        );
        const current = headRef?.startsWith("refs/heads/") ? headRef.slice("refs/heads/".length) : null;
        return {
          repository: info(repo),
          current,
          detached: headRef === null,
          branches: parseBranches(run.stdout),
          truncated: run.truncated,
        };
      },
    );
  }

  async show(context: AuthContext, input: GitShowInput): Promise<GitTextResult> {
    const args = parseInput(GitShowInputSchema, input);
    const details = { revision: args.revision, patch: args.patch, stat: args.stat };
    return this.operation(
      context,
      "git.show",
      args.cwd,
      args.paths,
      args.timeoutMs,
      details,
      async (repo, deadline) => {
        const git = [
          "show",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--ignore-submodules=all",
          "--format=fuller",
        ];
        if (args.patch && args.stat) git.push("--patch-with-stat");
        else if (args.stat) git.push("--stat");
        else if (!args.patch) git.push("--no-patch");
        git.push("--end-of-options", args.revision, "--", ...repo.pathspecs);
        const run = await this.runGit(repo, git, deadline);
        return { repository: info(repo), output: run.stdout, truncated: run.truncated };
      },
    );
  }

  /** Stop accepting operations and terminate running Git commands. */
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.running].map((p) => p.terminate("force")));
    const environments = await this.environments?.catch(() => undefined);
    if (environments) await rm(environments.dir, { recursive: true, force: true });
  }

  /** Forced, synchronous termination of running Git commands (host process exit). */
  terminateAllSync(): void {
    this.closing = true;
    for (const p of this.running) p.terminateSync();
    if (this.environmentDir) {
      try {
        rmSync(this.environmentDir, { recursive: true, force: true });
      } catch {
        // Best effort while the host process exits.
      }
    }
  }

  private async operation<T>(
    context: AuthContext,
    operation: GitOperation,
    cwdInput: string,
    pathInputs: readonly string[],
    timeoutMs: number | undefined,
    details: Record<string, unknown>,
    body: (repo: Repository, deadline: number) => Promise<T>,
  ): Promise<T> {
    const timeout = this.timeout(timeoutMs);
    const start = await this.deps.workspace.resolve(cwdInput);
    const discovered = await discoverRepository(this.deps.workspace, start);
    const resolvedPaths: ResolvedPath[] = [];
    for (const p of pathInputs) resolvedPaths.push(await this.deps.workspace.resolve(p));
    const pathspecs = resolvedPaths.map((p) => this.pathspec(discovered.worktree, p));
    const repo: Repository = { ...discovered, pathspecs, forwarded: [] };
    const op = {
      operation,
      capability: "git.read",
      paths: dedupe([start, discovered.worktree, discovered.gitDir, discovered.commonDir, ...resolvedPaths]),
      details: { ...details, cwd: display(start), paths: pathspecs, timeoutMs: timeout },
    } as const;
    return this.deps.guard.run(context, op, () =>
      this.deps.lock.withGitRead([discovered.gitDir.absolute, discovered.commonDir.absolute], async () => {
        this.assertOpen();
        const deadline = Date.now() + timeout;
        await this.checkVersion(repo, deadline);
        const forwarded = await this.reviewRepositoryConfig(repo, deadline);
        return body({ ...repo, forwarded }, deadline);
      }),
    );
  }

  /** Pathspec relative to the worktree; paths outside it are refused. */
  private pathspec(worktree: ResolvedPath, p: ResolvedPath): string {
    const segments = this.deps.workspace.rules.relativeSegments(
      worktree.absolute,
      p.absolute,
      this.deps.workspace.caseSensitive,
    );
    if (segments === null)
      throw new CrotError("INVALID_INPUT", `Path is outside the repository worktree: ${display(p)}`);
    return segments.length === 0 ? "." : segments.join("/");
  }

  /** Run `git config --list` and refuse the operation when repository configuration is not allowed (AD-1, point 4). */
  private async reviewRepositoryConfig(repo: Repository, deadline: number): Promise<readonly string[]> {
    // Inside a repository Git loads its configuration with include/includeIf followed before any command
    // runs, so an included file is read (and may fail to parse) before the listing below can refuse it.
    // The repository's own configuration files are therefore listed first outside any repository with
    // --file, where Git does not follow includes: include keys are refused before Git loads included files.
    for (const file of repositoryConfigFiles(repo)) {
      if (!(await isFile(file))) continue;
      const own = await this.runGit(repo, ["config", `--file=${file}`, "--list", "--null", "--show-scope"], deadline, {
        standalone: true,
      });
      if (own.truncated) throw new CrotError("UNSAFE_REPOSITORY", "Repository configuration is too large to review.");
      refuseUnsafeKeys(reviewConfig(parseConfigList(own.stdout)).unsafeKeys);
    }
    const run = await this.runGit(repo, ["config", "--list", "--null", "--show-scope"], deadline, {
      hardened: false,
      okExitCodes: [0, 1],
    });
    if (run.truncated) throw new CrotError("UNSAFE_REPOSITORY", "Repository configuration is too large to review.");
    const review = reviewConfig(parseConfigList(run.stdout));
    refuseUnsafeKeys(review.unsafeKeys);
    return review.forwarded;
  }

  private async checkVersion(repo: Repository, deadline: number): Promise<void> {
    if (this.versionChecked) return;
    const run = await this.runGit(repo, ["--version"], deadline, { hardened: false });
    const m = /(\d+)\.(\d+)/.exec(run.stdout);
    const version: [number, number] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
    if (version[0] < MIN_GIT_VERSION[0] || (version[0] === MIN_GIT_VERSION[0] && version[1] < MIN_GIT_VERSION[1])) {
      throw new CrotError(
        "OPERATION_FAILED",
        `git.read requires Git ${MIN_GIT_VERSION.join(".")} or newer; found: ${run.stdout.trim() || "unknown"}`,
      );
    }
    this.versionChecked = true;
  }

  private async hasHeadCommit(repo: Repository, deadline: number): Promise<boolean> {
    const run = await this.runGit(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], deadline, {
      okExitCodes: [0, 1, 128],
    });
    return run.exitCode === 0;
  }

  private env(): Promise<GitEnvironments> {
    this.environments ??= this.createEnvironments().catch((error: unknown) => {
      this.environments = undefined;
      throw new CrotError("OPERATION_FAILED", `Failed to prepare the Git environment: ${(error as Error).message}`);
    });
    return this.environments;
  }

  private async createEnvironments(): Promise<GitEnvironments> {
    // GIT_CONFIG_GLOBAL points at an empty file CROT creates itself: os.devNull is \\.\nul on Windows,
    // which Git for Windows cannot access ("Invalid argument"), and "/dev/null" there depends on Git's
    // own path translation. The directory is private to the CROT user and removed on shutdown.
    const dir = await mkdtemp(path.join(os.tmpdir(), "crot-git-"));
    this.environmentDir = dir;
    const emptyConfig = path.join(dir, "empty.gitconfig");
    await writeFile(emptyConfig, "", { flag: "wx", mode: 0o600 });
    const { environment } = this.deps.platform;
    const base = this.deps.baseEnv ?? this.deps.platform.baseEnvironment;
    const removed: Record<string, null> = {};
    for (const name of Object.keys(base)) if (/^GIT_/i.test(name)) removed[name] = null;
    const common = { ...removed, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
    return {
      // The listing reads system and global configuration to find forwardable settings; it starts no programs.
      listing: environment.merge(base, common),
      command: environment.merge(base, {
        ...common,
        GIT_LITERAL_PATHSPECS: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: emptyConfig,
      }),
      standalone: environment.merge(base, {
        ...common,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CEILING_DIRECTORIES: path.dirname(dir),
      }),
      dir,
    };
  }

  private async runGit(
    repo: Repository,
    gitArgs: readonly string[],
    deadline: number,
    options: RunOptions = {},
  ): Promise<GitRun> {
    this.assertOpen();
    const hardened = options.hardened ?? true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CrotError("TIMEOUT", "Git operation timed out.");
    const standalone = options.standalone ?? false;
    const environments = await this.env();
    const env = standalone ? environments.standalone : hardened ? environments.command : environments.listing;
    const args = ["--no-pager"];
    if (!standalone) {
      args.push(`--git-dir=${repo.gitDir.absolute}`, `--work-tree=${repo.worktree.absolute}`);
      if (hardened) for (const c of [...repo.forwarded, ...FIXED_CONFIG]) args.push("-c", c);
    }
    args.push(...gitArgs);
    const cwd = standalone ? environments.dir : repo.worktree.absolute;
    const { launcher } = this.deps.platform;
    // AD-1, point 2: never take git from the repository or the working directory.
    const spec = await launcher.resolveCommand("git", args, { cwd, env, searchCurrentDirectory: false });
    const proc = await launcher.launch(spec, { cwd, env, stdin: false });
    this.running.add(proc);
    try {
      if (this.closing) void proc.terminate("force");
      const max = this.deps.limits.maxOutputBytes;
      const out: Buffer[] = [];
      let outBytes = 0;
      let truncated = false;
      const err: Buffer[] = [];
      let errBytes = 0;
      proc.stdout.on("data", (chunk: Buffer) => {
        if (truncated) return;
        const room = max - outBytes;
        if (chunk.length > room) {
          out.push(chunk.subarray(0, room));
          outBytes = max;
          truncated = true;
          void proc.terminate("force");
          return;
        }
        out.push(chunk);
        outBytes += chunk.length;
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        const room = STDERR_MAX_BYTES - errBytes;
        if (room <= 0) return;
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        err.push(part);
        errBytes += part.length;
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void proc.terminate("force");
      }, remaining);
      const status = await proc.exited;
      clearTimeout(timer);
      await Promise.race([Promise.all([ended(proc.stdout), ended(proc.stderr)]), delay(STDIO_CLOSE_GRACE_MS)]);
      await proc.terminate("force");
      proc.stdout.destroy();
      proc.stderr.destroy();
      if (timedOut) throw new CrotError("TIMEOUT", `Git operation timed out (${gitArgs[0] ?? "git"}).`);
      if (this.closing && !truncated && status.code === null) throw shuttingDown();
      const stdout = new TextDecoder("utf-8").decode(Buffer.concat(out));
      const ok = options.okExitCodes ?? [0];
      if (!truncated && (status.code === null || !ok.includes(status.code))) {
        const stderr = new TextDecoder("utf-8").decode(Buffer.concat(err)).trim();
        throw new CrotError(
          "OPERATION_FAILED",
          `git ${gitArgs[0] ?? ""} failed${status.code === null ? ` (${status.signal ?? "terminated"})` : ` with exit code ${status.code}`}${stderr ? `: ${stderr.slice(-STDERR_IN_ERROR_CHARS)}` : ""}`,
          { exitCode: status.code },
        );
      }
      return { stdout, truncated, exitCode: status.code };
    } finally {
      this.running.delete(proc);
    }
  }

  private timeout(requested: number | undefined): number {
    const max = this.deps.limits.maxCommandTimeoutMs;
    if (requested !== undefined && requested > max) {
      throw new CrotError(
        "LIMIT_EXCEEDED",
        `Requested timeout ${requested}ms exceeds the configured maximum of ${max}ms.`,
      );
    }
    return requested ?? Math.min(this.deps.limits.defaultCommandTimeoutMs, max);
  }

  private assertOpen(): void {
    if (this.closing) throw shuttingDown();
  }
}

function info(repo: DiscoveredRepository): GitRepositoryInfo {
  return { root: display(repo.worktree), gitDir: display(repo.gitDir) };
}

function dedupe(paths: readonly ResolvedPath[]): ResolvedPath[] {
  const seen = new Set<string>();
  return paths.filter((p) => (seen.has(p.absolute) ? false : (seen.add(p.absolute), true)));
}

/** Configuration files of the repository itself: `config` of the common directory, `config.worktree` of the Git directory. */
function repositoryConfigFiles(repo: DiscoveredRepository): string[] {
  const files = [path.join(repo.commonDir.absolute, "config"), path.join(repo.gitDir.absolute, "config.worktree")];
  return files.filter((f, i) => files.indexOf(f) === i);
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function refuseUnsafeKeys(keys: readonly string[]): void {
  if (keys.length === 0) return;
  throw new CrotError(
    "UNSAFE_REPOSITORY",
    `Repository configuration contains settings that git.read does not allow (they could run programs): ${keys.join(", ")}`,
    { keys },
  );
}

function shuttingDown(): CrotError {
  return new CrotError("OPERATION_FAILED", "CROT is shutting down; no new Git commands are started.");
}

function ended(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    if ((stream as { readableEnded?: boolean }).readableEnded) return resolve();
    stream.once("end", () => resolve());
    stream.once("close", () => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

import { z } from "zod";
import type { BranchInfo, CommitInfo, StatusBranch, StatusEntry } from "./parse.js";

/** Input schemas for git.read and git.write operations, owned by Core and reused by adapters. */
const Cwd = z
  .string()
  .min(1)
  .default(".")
  .describe("Directory inside the repository (or its worktree): absolute, or relative to the workspace root.");

/**
 * A revision is passed after --end-of-options, so it can never be read as an
 * option; the leading '-' is refused anyway to keep error messages clear.
 */
const Revision = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^-]/, "A revision must not start with '-'.")
  .regex(/^[^\0\r\n]*$/, "A revision must not contain NUL or line breaks.");

const Pathspec = z
  .string()
  .min(1)
  .describe("Path (absolute, or relative to the workspace root) inside the repository worktree. Matched literally.");
const Paths = z.array(Pathspec).max(100).default([]).describe("Limit the result to these paths.");
const TimeoutMs = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Timeout in milliseconds (bounded by the configured maximum).");

export const GitStatusInputSchema = z
  .object({
    cwd: Cwd,
    paths: Paths,
    untracked: z.enum(["all", "normal", "no"]).default("all").describe("How untracked files are reported."),
    ignored: z.boolean().default(false).describe("Also report ignored files."),
    timeoutMs: TimeoutMs,
  })
  .strict();

export const GitDiffInputSchema = z
  .object({
    cwd: Cwd,
    staged: z
      .boolean()
      .default(false)
      .describe("Compare the index with HEAD (or with 'from') instead of the worktree."),
    from: Revision.optional().describe("Base revision. Without it, the worktree is compared with the index."),
    to: Revision.optional().describe("Target revision (requires 'from'; not allowed with 'staged')."),
    paths: Paths,
    contextLines: z.number().int().min(0).max(1000).optional().describe("Lines of context around changes."),
    stat: z.boolean().default(false).describe("Return a diffstat instead of the patch."),
    nameOnly: z.boolean().default(false).describe("Return only names and change status of changed files."),
    timeoutMs: TimeoutMs,
  })
  .strict()
  .refine((v) => v.to === undefined || v.from !== undefined, { message: "'to' requires 'from'." })
  .refine((v) => !(v.staged && v.to !== undefined), { message: "'staged' cannot be combined with 'to'." })
  .refine((v) => !(v.stat && v.nameOnly), { message: "Use either 'stat' or 'nameOnly'." });

export const GitLogInputSchema = z
  .object({
    cwd: Cwd,
    revision: Revision.optional().describe("Revision or range to list (default HEAD)."),
    maxCount: z.number().int().min(1).max(1000).default(20).describe("Maximum number of commits."),
    skip: z.number().int().min(0).default(0).describe("Skip this many commits first."),
    paths: Paths,
    timeoutMs: TimeoutMs,
  })
  .strict();

export const GitBranchInputSchema = z
  .object({
    cwd: Cwd,
    remote: z.boolean().default(false).describe("Also list remote-tracking branches."),
    timeoutMs: TimeoutMs,
  })
  .strict();

export const GitShowInputSchema = z
  .object({
    cwd: Cwd,
    revision: Revision.default("HEAD").describe("Commit to show, or 'rev:path' to show a file at a revision."),
    patch: z.boolean().default(true).describe("Include the patch of a commit."),
    stat: z.boolean().default(false).describe("Include a diffstat of a commit."),
    paths: Paths,
    timeoutMs: TimeoutMs,
  })
  .strict();

// ---------------------------------------------------------------------------
// git.write (ARCHITECTURE.md §27, AD-2)

/**
 * A branch name. It is always passed after --end-of-options; a leading '-',
 * '@{' (reflog shorthands such as @{-1}) and control characters are refused
 * here, everything else is validated by Git's own ref-name rules.
 */
const BranchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^-]/, "A branch name must not start with '-'.")
  .regex(/^[^\0-\x1f\x7f]*$/, "A branch name must not contain control characters.")
  .refine((v) => !v.includes("@{"), { message: "A branch name must not contain '@{'." })
  .refine((v) => v !== "HEAD" && v !== "@", { message: "'HEAD' is not a branch name." });

export const GIT_COMMIT_MESSAGE_MAX_CHARS = 16_384;

export const GitAddInputSchema = z
  .object({
    cwd: Cwd,
    paths: z
      .array(Pathspec)
      .max(100)
      .default([])
      .describe("Files or directories to stage (new, modified and deleted files). Matched literally."),
    all: z
      .boolean()
      .default(false)
      .describe("Stage every change in the worktree (git add --all). Cannot be combined with 'paths'."),
    timeoutMs: TimeoutMs,
  })
  .strict()
  .refine((v) => v.all !== v.paths.length > 0, { message: "Give either 'paths' or all=true." });

export const GitCommitInputSchema = z
  .object({
    cwd: Cwd,
    message: z
      .string()
      .min(1)
      .max(GIT_COMMIT_MESSAGE_MAX_CHARS)
      .regex(/^[^\0]*$/, "The message must not contain NUL.")
      .refine((v) => v.trim().length > 0, { message: "The message must not be empty." })
      .describe("Commit message (subject line, optionally followed by a blank line and a body)."),
    allowEmpty: z.boolean().default(false).describe("Create the commit even when nothing is staged."),
    timeoutMs: TimeoutMs,
  })
  .strict();

export const GitBranchCreateInputSchema = z
  .object({
    cwd: Cwd,
    name: BranchName.describe("Name of the new branch. Fails if it already exists."),
    startPoint: Revision.optional().describe("Commit the branch starts at (default HEAD)."),
    timeoutMs: TimeoutMs,
  })
  .strict();

export const GitBranchRenameInputSchema = z
  .object({
    cwd: Cwd,
    from: BranchName.describe("Existing branch to rename."),
    to: BranchName.describe("New name. Fails if a branch with this name already exists."),
    timeoutMs: TimeoutMs,
  })
  .strict();

export const GitBranchDeleteInputSchema = z
  .object({
    cwd: Cwd,
    name: BranchName.describe("Branch to delete. Only fully merged branches are deleted (git branch -d)."),
    timeoutMs: TimeoutMs,
  })
  .strict();

export const GitCheckoutInputSchema = z
  .object({
    cwd: Cwd,
    branch: BranchName.optional().describe("Existing local branch to switch to."),
    detach: Revision.optional().describe(
      "Commit to check out with a detached HEAD. Must be given explicitly; cannot be combined with 'branch'.",
    ),
    timeoutMs: TimeoutMs,
  })
  .strict()
  .refine((v) => (v.branch === undefined) !== (v.detach === undefined), {
    message: "Give exactly one of 'branch' or 'detach'.",
  });

export type GitAddInput = z.input<typeof GitAddInputSchema>;
export type GitCommitInput = z.input<typeof GitCommitInputSchema>;
export type GitBranchCreateInput = z.input<typeof GitBranchCreateInputSchema>;
export type GitBranchRenameInput = z.input<typeof GitBranchRenameInputSchema>;
export type GitBranchDeleteInput = z.input<typeof GitBranchDeleteInputSchema>;
export type GitCheckoutInput = z.input<typeof GitCheckoutInputSchema>;

export interface GitAddResult {
  readonly repository: GitRepositoryInfo;
  /** Paths staged in the index after the operation (relative to the worktree root). */
  readonly staged: string[];
  readonly truncated: boolean;
}

export interface GitCommitResult {
  readonly repository: GitRepositoryInfo;
  /** Hash of the new commit. */
  readonly commit: string;
  /** Branch the commit was made on, or null with a detached HEAD. */
  readonly branch: string | null;
}

export interface GitBranchWriteResult {
  readonly repository: GitRepositoryInfo;
  readonly branch: string;
  /** Commit the branch points to (for delete: pointed to before deletion). */
  readonly commit: string;
  /** Previous name (rename only). */
  readonly renamedFrom?: string;
}

export interface GitCheckoutResult {
  readonly repository: GitRepositoryInfo;
  /** Current branch after the checkout, or null with a detached HEAD. */
  readonly branch: string | null;
  readonly detached: boolean;
  /** Commit HEAD points to after the checkout. */
  readonly commit: string;
}

export type GitStatusInput = z.input<typeof GitStatusInputSchema>;
export type GitDiffInput = z.input<typeof GitDiffInputSchema>;
export type GitLogInput = z.input<typeof GitLogInputSchema>;
export type GitBranchInput = z.input<typeof GitBranchInputSchema>;
export type GitShowInput = z.input<typeof GitShowInputSchema>;

/** The repository an operation ran in (workspace-relative when inside the workspace). */
export interface GitRepositoryInfo {
  readonly root: string;
  readonly gitDir: string;
}

export interface GitStatusResult {
  readonly repository: GitRepositoryInfo;
  readonly branch: StatusBranch;
  readonly entries: StatusEntry[];
  readonly clean: boolean;
  readonly truncated: boolean;
}

export interface GitTextResult {
  readonly repository: GitRepositoryInfo;
  readonly output: string;
  /** True when output beyond maxOutputBytes was discarded. */
  readonly truncated: boolean;
}

export interface GitLogResult {
  readonly repository: GitRepositoryInfo;
  readonly commits: CommitInfo[];
  readonly truncated: boolean;
}

export interface GitBranchResult {
  readonly repository: GitRepositoryInfo;
  /** Current branch, or null when HEAD is detached or the repository has no branch yet. */
  readonly current: string | null;
  readonly detached: boolean;
  readonly branches: BranchInfo[];
  readonly truncated: boolean;
}

export type { BranchInfo, CommitInfo, StatusBranch, StatusEntry };

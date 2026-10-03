import { z } from "zod";
import type { BranchInfo, CommitInfo, StatusBranch, StatusEntry } from "./parse.js";

/** Input schemas for git.read operations, owned by Core and reused by adapters. */
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
    staged: z.boolean().default(false).describe("Compare the index with HEAD (or with 'from') instead of the worktree."),
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

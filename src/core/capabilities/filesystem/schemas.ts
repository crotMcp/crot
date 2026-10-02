import { z } from "zod";

/**
 * Input schemas for filesystem operations. They are owned by Core so that
 * every adapter validates identically; adapters reuse them as their wire schemas.
 */
const PathField = z.string().min(1).describe("Path to operate on: absolute, or relative to the workspace root.");
const Encoding = z.enum(["utf8", "base64"]);

export const ReadFileInputSchema = z
  .object({
    path: PathField,
    encoding: Encoding.default("utf8").describe("Content encoding of the returned data."),
    offset: z.number().int().nonnegative().default(0).describe("Byte offset to start reading from."),
    length: z.number().int().positive().optional().describe("Maximum number of bytes to read (bounded by the configured limit)."),
  })
  .strict();

export const WriteFileInputSchema = z
  .object({
    path: PathField,
    content: z.string().describe("Data to write, encoded as specified by 'encoding'."),
    encoding: Encoding.default("utf8"),
    mode: z
      .enum(["overwrite", "create", "append"])
      .default("overwrite")
      .describe("overwrite: replace or create; create: fail if the file exists; append: add to the end."),
    createParents: z.boolean().default(true).describe("Create missing parent directories."),
  })
  .strict();

export const ListDirectoryInputSchema = z
  .object({
    path: PathField.default("."),
    recursive: z.boolean().default(false),
    maxDepth: z.number().int().positive().max(64).default(8).describe("Maximum recursion depth when recursive."),
    maxEntries: z.number().int().positive().max(20_000).default(1_000),
    includeHidden: z.boolean().default(true).describe("Include entries whose name starts with '.'."),
  })
  .strict();

export const StatInputSchema = z.object({ path: PathField }).strict();

export const CreateDirectoryInputSchema = z
  .object({
    path: PathField,
    recursive: z.boolean().default(true).describe("Create missing parents; succeed if it already exists."),
  })
  .strict();

export const DeleteInputSchema = z
  .object({
    path: PathField,
    recursive: z.boolean().default(false).describe("Required to delete a non-empty directory."),
  })
  .strict();

export const MoveInputSchema = z
  .object({
    from: PathField,
    to: PathField,
    overwrite: z.boolean().default(false),
  })
  .strict();

export type ReadFileInput = z.input<typeof ReadFileInputSchema>;
export type WriteFileInput = z.input<typeof WriteFileInputSchema>;
export type ListDirectoryInput = z.input<typeof ListDirectoryInputSchema>;
export type StatInput = z.input<typeof StatInputSchema>;
export type CreateDirectoryInput = z.input<typeof CreateDirectoryInputSchema>;
export type DeleteInput = z.input<typeof DeleteInputSchema>;
export type MoveInput = z.input<typeof MoveInputSchema>;

export type EntryType = "file" | "directory" | "symlink" | "other";

export interface ReadFileResult {
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
  readonly size: number;
  readonly offset: number;
  readonly bytesRead: number;
  /** True when the file continues beyond what was returned. */
  readonly truncated: boolean;
}

export interface WriteFileResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly created: boolean;
}

export interface DirectoryEntry {
  /** Path relative to the listed directory, '/'-separated. */
  readonly path: string;
  readonly type: EntryType;
  readonly size: number;
}

export interface ListDirectoryResult {
  readonly path: string;
  readonly entries: readonly DirectoryEntry[];
  readonly truncated: boolean;
}

export interface StatResult {
  readonly path: string;
  readonly exists: boolean;
  readonly type?: EntryType;
  readonly size?: number;
  readonly modifiedAt?: string;
  readonly symlinkTarget?: string;
}

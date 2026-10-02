import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../errors.js";

/** A path resolved and canonicalized against the workspace. */
export interface ResolvedPath {
  /** Canonical absolute path (symlinks in existing ancestors resolved). */
  readonly absolute: string;
  /** Path relative to the workspace root using '/' separators, or null when outside the workspace. */
  readonly relative: string | null;
  readonly insideWorkspace: boolean;
}

export interface ResolveOptions {
  /**
   * When true (default), a symlink at the final path component is followed, so
   * the resolved path is the link target. Use false for operations on the entry
   * itself (lstat, delete, move), so the link is acted on and not its target.
   */
  readonly followFinalSymlink?: boolean;
}

export interface WorkspaceInfo {
  readonly name: string;
  readonly root: string;
}

/**
 * The user-selected workspace. All relative paths are resolved against its
 * root, and it is the boundary used by the PermissionEngine in sandbox mode.
 *
 * Resolution canonicalizes the longest existing prefix with realpath, so
 * `..` segments and symlinks cannot be used to escape the workspace unnoticed.
 */
export class Workspace {
  private constructor(
    readonly name: string,
    readonly root: string,
  ) {}

  static async open(root: string, name?: string): Promise<Workspace> {
    if (!path.isAbsolute(root)) {
      throw new CrotError("CONFIG_ERROR", `Workspace root must be an absolute path: ${root}`);
    }
    let canonical: string;
    try {
      canonical = await realpath(root);
    } catch {
      throw new CrotError("CONFIG_ERROR", `Workspace root does not exist: ${root}`);
    }
    const info = await stat(canonical);
    if (!info.isDirectory()) {
      throw new CrotError("CONFIG_ERROR", `Workspace root is not a directory: ${root}`);
    }
    return new Workspace(name ?? path.basename(canonical), canonical);
  }

  info(): WorkspaceInfo {
    return { name: this.name, root: this.root };
  }

  /** Resolve a user-supplied path (absolute, or relative to the workspace root). */
  async resolve(input: string, options: ResolveOptions = {}): Promise<ResolvedPath> {
    if (typeof input !== "string" || input.length === 0) {
      throw new CrotError("INVALID_INPUT", "Path must be a non-empty string.");
    }
    if (input.includes("\0")) {
      throw new CrotError("INVALID_INPUT", "Path must not contain NUL bytes.");
    }
    const lexical = path.resolve(this.root, input);
    const follow = options.followFinalSymlink ?? true;

    let canonical: string;
    if (follow || lexical === path.parse(lexical).root) {
      canonical = await canonicalize(lexical);
    } else {
      canonical = path.join(await canonicalize(path.dirname(lexical)), path.basename(lexical));
    }
    return this.describe(canonical);
  }

  /** Classify an already canonical absolute path. */
  describe(canonicalAbsolute: string): ResolvedPath {
    const rel = path.relative(this.root, canonicalAbsolute);
    const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    return {
      absolute: canonicalAbsolute,
      relative: inside ? (rel === "" ? "." : rel.split(path.sep).join("/")) : null,
      insideWorkspace: inside,
    };
  }

  isRoot(p: ResolvedPath): boolean {
    return p.absolute === this.root;
  }
}

/** realpath the longest existing prefix of `absolute`, then re-append the missing tail. */
async function canonicalize(absolute: string): Promise<string> {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

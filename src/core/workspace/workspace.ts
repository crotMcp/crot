import { realpath, stat } from "node:fs/promises";
import { CrotError } from "../errors.js";
import { probeCaseSensitivity } from "../platform/node-platform.js";
import { pathRulesFor } from "../platform/path-rules.js";
import type { PathRules } from "../platform/types.js";

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
  /** Whether paths in the workspace compare case-sensitively (probed on open). */
  readonly caseSensitive: boolean;
}

export interface WorkspaceOptions {
  readonly name?: string;
  /** Platform path rules (defaults to the host's). */
  readonly rules?: PathRules;
  /** Case-sensitivity probe (defaults to the host probe). */
  readonly probeCaseSensitivity?: (directory: string) => Promise<boolean>;
}

/**
 * The user-selected workspace. All relative paths are resolved against its
 * root, and it is the boundary used by the PermissionEngine in sandbox mode.
 *
 * Resolution validates platform path syntax, then canonicalizes the longest
 * existing prefix with realpath, so `..` segments, symlinks and junctions
 * cannot be used to escape the workspace unnoticed. Comparisons honour the
 * filesystem's case sensitivity (case-insensitive on Windows and default macOS).
 */
export class Workspace {
  private constructor(
    readonly name: string,
    readonly root: string,
    readonly rules: PathRules,
    readonly caseSensitive: boolean,
  ) {}

  static async open(root: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    const rules = options.rules ?? pathRulesFor(process.platform === "win32" ? "win32" : "posix");
    try {
      rules.validate(root);
    } catch (error) {
      throw new CrotError("CONFIG_ERROR", `Invalid workspace root: ${(error as Error).message}`);
    }
    if (!rules.isAbsolute(root)) {
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
    const probe = options.probeCaseSensitivity ?? ((d: string) => probeCaseSensitivity(d, process.platform === "win32"));
    const caseSensitive = await probe(canonical);
    return new Workspace(options.name ?? rules.basename(canonical), canonical, rules, caseSensitive);
  }

  info(): WorkspaceInfo {
    return { name: this.name, root: this.root, caseSensitive: this.caseSensitive };
  }

  /** Resolve a user-supplied path (absolute, or relative to the workspace root). */
  async resolve(input: string, options: ResolveOptions = {}): Promise<ResolvedPath> {
    if (typeof input !== "string" || input.length === 0) {
      throw new CrotError("INVALID_INPUT", "Path must be a non-empty string.");
    }
    this.rules.validate(input);
    const lexical = this.rules.resolve(this.root, input);
    const follow = options.followFinalSymlink ?? true;

    let canonical: string;
    if (follow || lexical === this.rules.root(lexical)) {
      canonical = await canonicalize(lexical, this.rules);
    } else {
      canonical = this.rules.join(await canonicalize(this.rules.dirname(lexical), this.rules), this.rules.basename(lexical));
    }
    return this.describe(canonical);
  }

  /** Classify an already canonical absolute path. */
  describe(canonicalAbsolute: string): ResolvedPath {
    const segments = this.rules.relativeSegments(this.root, canonicalAbsolute, this.caseSensitive);
    const inside = segments !== null;
    return {
      absolute: canonicalAbsolute,
      relative: segments === null ? null : segments.length === 0 ? "." : segments.join("/"),
      insideWorkspace: inside,
    };
  }

  isRoot(p: ResolvedPath): boolean {
    return this.rules.equals(this.root, p.absolute, this.caseSensitive);
  }

  /** Whether `candidate` is `ancestor` or inside it, using this workspace's path semantics. */
  contains(ancestor: string, candidate: string): boolean {
    return this.rules.relativeSegments(ancestor, candidate, this.caseSensitive) !== null;
  }
}

/** Workspace-relative path when inside the workspace, absolute otherwise (for user-facing results). */
export function displayPath(p: ResolvedPath): string {
  return p.relative ?? p.absolute;
}

/** realpath the longest existing prefix of `absolute`, then re-append the missing tail. */
async function canonicalize(absolute: string, rules: PathRules): Promise<string> {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : rules.join(real, ...tail.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        if (code === "EINVAL" || code === "ENAMETOOLONG") {
          throw new CrotError("INVALID_INPUT", `Invalid path (${code}): ${absolute}`);
        }
        if (code === "EACCES" || code === "EPERM") {
          throw new CrotError("OPERATION_FAILED", `Operating system denied access while resolving ${absolute} (${code})`);
        }
        throw error;
      }
      const parent = rules.dirname(current);
      if (parent === current) return absolute;
      tail.push(rules.basename(current));
      current = parent;
    }
  }
}

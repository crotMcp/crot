/** Whether `candidate` is `ancestor` or inside it (the workspace's path semantics). */
export type ContainsPath = (ancestor: string, candidate: string) => boolean;

type LockKind = "git-read" | "write";

interface Holder {
  readonly kind: LockKind;
  readonly paths: readonly string[];
}

/**
 * Mutual exclusion between `git.read` operations and CROT filesystem writes
 * into the Git directories they read (ARCHITECTURE.md §27, AD-1, point 6).
 *
 * - A git.read operation holds its Git directories (git dir and common dir)
 *   for the configuration check and every Git command it runs.
 * - A filesystem write holds the paths it modifies.
 * - Two holders conflict only when they are of different kinds and one of
 *   their paths is inside, or contains, a path of the other. git.read
 *   operations never block each other, writes never block each other, and
 *   writes elsewhere are not affected.
 *
 * Waiters are re-checked whenever a holder releases. The lock does not
 * authorize anything; permissions are decided by the PermissionEngine before
 * the lock is taken.
 */
export class GitMetadataLock {
  private readonly holders = new Set<Holder>();
  private waiters: Array<() => void> = [];

  constructor(private readonly contains: ContainsPath) {}

  /** Run a git.read operation on `gitDirs` while no filesystem write touches them. */
  withGitRead<T>(gitDirs: readonly string[], fn: () => Promise<T>): Promise<T> {
    return this.run("git-read", gitDirs, fn);
  }

  /** Run a filesystem write on `paths` while no git.read operation reads an overlapping Git directory. */
  withWrite<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
    return this.run("write", paths, fn);
  }

  /** Number of active holders (diagnostics and tests). */
  get activeHolders(): number {
    return this.holders.size;
  }

  private conflicts(kind: LockKind, paths: readonly string[]): boolean {
    for (const holder of this.holders) {
      if (holder.kind === kind) continue;
      for (const a of holder.paths) {
        for (const b of paths) {
          if (this.contains(a, b) || this.contains(b, a)) return true;
        }
      }
    }
    return false;
  }

  private async acquire(kind: LockKind, paths: readonly string[]): Promise<Holder> {
    while (this.conflicts(kind, paths)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    const holder: Holder = { kind, paths: [...paths] };
    this.holders.add(holder);
    return holder;
  }

  private release(holder: Holder): void {
    this.holders.delete(holder);
    const waiting = this.waiters;
    this.waiters = [];
    for (const wake of waiting) wake();
  }

  private async run<T>(kind: LockKind, paths: readonly string[], fn: () => Promise<T>): Promise<T> {
    const holder = await this.acquire(kind, paths);
    try {
      return await fn();
    } finally {
      this.release(holder);
    }
  }
}

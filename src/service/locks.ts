/**
 * Directory locks of the CROT state directory (service start, secret store).
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, rmdir, stat, utimes } from "node:fs/promises";

const LOCK_STALE_MS = 15_000;

/**
 * Exclusive directory lock (atomic mkdir). A lock older than `staleMs` (its
 * holder crashed) is broken. Breaking is safe against concurrent breakers: the
 * stale lock is first moved aside under a unique name (only one process can
 * move it), and the moved directory must still be the one judged stale (same
 * inode and modification time); a process that moved a lock someone else had
 * just taken puts it back and does not get the lock.
 */
export async function acquireDirectoryLock(lock: string, staleMs = LOCK_STALE_MS): Promise<boolean> {
  try {
    await mkdir(lock, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await stat(lock).catch(() => undefined);
  if (info && Date.now() - info.mtimeMs <= staleMs) return false;
  if (info) {
    const aside = `${lock}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await rename(lock, aside);
    } catch {
      return false; // another process broke it first
    }
    const moved = await stat(aside).catch(() => undefined);
    if (!moved || moved.ino !== info.ino || moved.mtimeMs !== info.mtimeMs) {
      await rename(aside, lock).catch(() => rmdir(aside).catch(() => undefined));
      return false;
    }
    await rmdir(aside).catch(() => undefined);
  }
  try {
    await mkdir(lock, { mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

/** Keep a held lock fresh (its modification time), so it is never judged stale while held. */
export async function refreshDirectoryLock(lock: string): Promise<void> {
  const now = new Date();
  await utimes(lock, now, now).catch(() => undefined);
}

export function releaseDirectoryLock(lock: string): Promise<void> {
  return rmdir(lock).catch(() => undefined);
}

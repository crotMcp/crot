/**
 * Directory locks of the CROT state directory (service start, secret store).
 */
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, rename, rmdir, stat, utimes } from "node:fs/promises";

const LOCK_STALE_MS = 15_000;

/** Generations of break claims tried for one stale lock (a claim is only skipped when its breaker crashed). */
const MAX_BREAK_GENERATIONS = 8;

/** A pending-delete Windows directory can report EPERM instead of EEXIST.
 * Refuse ownership and let the caller's bounded wait retry. NEVER treat this
 * as success, break a possibly live lock, change ACLs, or bypass the lock.
 * A permanent denial therefore still fails closed at the caller's deadline.
 */
export function lockCreateFailure(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): "exists" | "contended" | "fatal" {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EEXIST") return "exists";
  return platform === "win32" && code === "EPERM" ? "contended" : "fatal";
}

/**
 * Exclusive directory lock (atomic mkdir). A lock older than `staleMs` (its
 * holder crashed) is broken by exactly one process: the stale lock is moved
 * aside and checked by the one process that holds the break claim for that
 * lock instance (`<lock>.break-<instance>-<generation>`, atomic mkdir; the
 * instance is the inode and modification time judged stale). Only that
 * process ever moves the lock, and only after re-checking under the claim that
 * the lock is still the stale instance, so a live lock is never moved,
 * removed or left absent; whoever then creates the lock (atomic mkdir) holds
 * it. A claim whose breaker crashed (older than `staleMs`) is skipped by
 * claiming the next generation.
 */
export async function acquireDirectoryLock(lock: string, staleMs = LOCK_STALE_MS): Promise<boolean> {
  try {
    await mkdir(lock, { mode: 0o700 });
    return true;
  } catch (error) {
    const disposition = lockCreateFailure(error);
    if (disposition === "contended") return false;
    if (disposition === "fatal") throw error;
  }
  const info = await stat(lock).catch(() => undefined);
  if (info && Date.now() - info.mtimeMs <= staleMs) return false;
  if (info) await breakStaleLock(lock, info, staleMs);
  try {
    await mkdir(lock, { mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

/** Name of the break claim of one stale lock instance (exported for tests). */
export function breakClaimPath(lock: string, instance: Stats, generation: number): string {
  const id = `${instance.ino.toString(36)}-${Math.round(instance.mtimeMs * 1000).toString(36)}`;
  return `${lock}.break-${id}-${generation}`;
}

/** Remove the stale lock instance `info` if this process wins its break claim; otherwise leave it to the winner. */
async function breakStaleLock(lock: string, info: Stats, staleMs: number): Promise<void> {
  for (let generation = 0; generation < MAX_BREAK_GENERATIONS; generation++) {
    const claim = breakClaimPath(lock, info, generation);
    try {
      await mkdir(claim, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
      const held = await stat(claim).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > staleMs) continue; // its breaker crashed
      return; // another process is breaking this instance (or has just done so)
    }
    try {
      // Under the claim nobody else moves the lock: if it is still the stale instance, it stays so until moved here.
      const current = await stat(lock).catch(() => undefined);
      if (current && current.ino === info.ino && current.mtimeMs === info.mtimeMs) {
        const aside = `${lock}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
        await rename(lock, aside);
        await rmdir(aside).catch(() => undefined);
      }
    } catch {
      // The lock stays; the caller's mkdir then fails and it does not get the lock.
    } finally {
      await rmdir(claim).catch(() => undefined);
    }
    return;
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

import { mkdir, mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireDirectoryLock, breakClaimPath, releaseDirectoryLock } from "../../src/service/locks.js";

/**
 * Regression test for the stale-lock race seen on Windows CI (WP-20 lock, AD-17 point 3): with a
 * few milliseconds of random latency per file-system operation (as on a slow or scanned file
 * system), the former "move aside, then check" breaker moved a lock another process had just
 * taken; a third process then found no lock and created one, and two processes held it.
 */
const jitter = vi.hoisted(() => ({ ms: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fsp = await importOriginal<typeof import("node:fs/promises")>();
  const delay = () => new Promise((r) => setTimeout(r, Math.random() * jitter.ms));
  const slow =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      await delay();
      try {
        return await f(...a);
      } finally {
        await delay();
      }
    };
  const mocked = {
    ...fsp,
    mkdir: slow(fsp.mkdir),
    rename: slow(fsp.rename),
    rmdir: slow(fsp.rmdir),
    stat: slow(fsp.stat),
  };
  return { ...mocked, default: mocked };
});

let dir: string;
beforeEach(async () => {
  jitter.ms = 0;
  dir = await mkdtemp(path.join(os.tmpdir(), "crot-lock-"));
});
afterEach(async () => {
  jitter.ms = 0;
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const old = new Date(Date.now() - 60_000);

describe("stale directory lock with file-system latency (WP-20)", () => {
  it("8 concurrent breakers: exactly one wins, the lock is fresh, nothing is left behind", async () => {
    for (let round = 0; round < 60; round++) {
      const lock = path.join(dir, `stale-${round}.lock`);
      await mkdir(lock);
      await utimes(lock, old, old);
      jitter.ms = 4;
      const results = await Promise.all(Array.from({ length: 8 }, () => acquireDirectoryLock(lock, 10_000)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await acquireDirectoryLock(lock, 10_000)).toBe(false);
      jitter.ms = 0;
      await releaseDirectoryLock(lock);
    }
    expect(await readdir(dir)).toEqual([]);
  }, 60_000);

  it("a break claim left by a crashed breaker does not block the lock forever", async () => {
    const lock = path.join(dir, "crashed.lock");
    await mkdir(lock);
    await utimes(lock, old, old);
    const claim = breakClaimPath(lock, await stat(lock), 0);
    await mkdir(claim);
    await utimes(claim, old, old);
    expect(await acquireDirectoryLock(lock, 10_000)).toBe(true);
    expect(await acquireDirectoryLock(lock, 10_000)).toBe(false);
  });

  it("a fresh break claim means another process is breaking the lock: no second breaker", async () => {
    const lock = path.join(dir, "breaking.lock");
    await mkdir(lock);
    await utimes(lock, old, old);
    const before = await stat(lock);
    await mkdir(breakClaimPath(lock, before, 0));
    expect(await acquireDirectoryLock(lock, 10_000)).toBe(false);
    const after = await stat(lock);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]); // the stale lock was not touched
  });
});

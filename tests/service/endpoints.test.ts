import { mkdir, mkdtemp, rename, rm, stat, utimes } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireDirectoryLock,
  listenExclusive,
  refreshDirectoryLock,
  releaseDirectoryLock,
  serviceEndpoint,
} from "../../src/service/endpoints.js";
import { isWindows } from "../helpers.js";

/** Concurrent startup of services of one user (WP-20, AD-17 point 3): exactly one owner. */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(isWindows ? os.tmpdir() : "/tmp", "crot-ep-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const old = new Date(Date.now() - 60_000);

describe("service locks and endpoint ownership (WP-20)", () => {
  it("concurrent acquisitions of a free lock: exactly one wins", async () => {
    const lock = path.join(dir, "a.lock");
    const results = await Promise.all(Array.from({ length: 16 }, () => acquireDirectoryLock(lock, 10_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("concurrent breakers of a stale lock: exactly one wins, and a live lock is never broken", async () => {
    for (let round = 0; round < 20; round++) {
      const lock = path.join(dir, `stale-${round}.lock`);
      await mkdir(lock);
      await utimes(lock, old, old); // its holder crashed long ago
      const results = await Promise.all(Array.from({ length: 8 }, () => acquireDirectoryLock(lock, 10_000)));
      expect(results.filter(Boolean)).toHaveLength(1);
      // The winner's lock is fresh: nobody else gets it now.
      expect(await acquireDirectoryLock(lock, 10_000)).toBe(false);
      await releaseDirectoryLock(lock);
    }
  });

  it("a refreshed lock stays held beyond its stale age", async () => {
    const lock = path.join(dir, "held.lock");
    expect(await acquireDirectoryLock(lock, 10_000)).toBe(true);
    await utimes(lock, old, old);
    await refreshDirectoryLock(lock);
    expect(Date.now() - (await stat(lock)).mtimeMs).toBeLessThan(10_000);
    expect(await acquireDirectoryLock(lock, 10_000)).toBe(false);
  });

  it.skipIf(isWindows)("a fresh listener cannot bypass a held POSIX stale-recovery lock", async () => {
    const endpoint = serviceEndpoint(dir, "service", "d".repeat(43), false);
    const lock = endpoint.path + ".lock";
    expect(await acquireDirectoryLock(lock, 10_000)).toBe(true);
    try {
      // This used to bind successfully: only the EADDRINUSE path took the lock.
      const contender = await listenExclusive(endpoint, (socket) => socket.destroy());
      if (contender !== "in_use") {
        await new Promise<void>((resolve) => contender.close(() => resolve()));
      }
      expect(contender).toBe("in_use");
      expect(await stat(endpoint.path).catch(() => undefined)).toBeUndefined();
    } finally {
      await releaseDirectoryLock(lock);
    }
    const owner = await listenExclusive(endpoint, (socket) => socket.destroy());
    expect(owner).not.toBe("in_use");
    if (owner !== "in_use") await new Promise<void>((resolve) => owner.close(() => resolve()));
  });

  it("concurrent listeners on one endpoint: exactly one owner, also when taking over a stale socket", async () => {
    const endpoint = serviceEndpoint(dir, "service", "c".repeat(43), isWindows);
    const servers: net.Server[] = [];
    try {
      if (!isWindows) {
        // A crashed owner left its socket file behind.
        const stale = net.createServer();
        const temp = path.join(dir, "leftover.sock");
        await new Promise<void>((r) => stale.listen(temp, r));
        await rename(temp, endpoint.path);
        stale.close();
      }
      const results = await Promise.all(Array.from({ length: 8 }, () => listenExclusive(endpoint, (s) => s.destroy())));
      for (const r of results) if (r !== "in_use") servers.push(r);
      expect(servers).toHaveLength(1);
      if (!isWindows) {
        // The owner is the one listening on the path.
        const owner = servers[0]!;
        let reached = false;
        owner.once("connection", () => (reached = true));
        await new Promise<void>((resolve, reject) => {
          const s = net.connect(endpoint.path, () => {
            s.destroy();
            resolve();
          });
          s.once("error", reject);
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(reached).toBe(true);
      }
    } finally {
      for (const s of servers) s.close();
    }
  });
});

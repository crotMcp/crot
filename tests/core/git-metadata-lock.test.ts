import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitMetadataLock } from "../../src/core/capabilities/git/metadata-lock.js";

const contains = (a: string, c: string) => {
  const rel = path.posix.relative(a, c);
  return rel === "" || (!rel.startsWith("..") && !path.posix.isAbsolute(rel));
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("GitMetadataLock", () => {
  it("makes a write into the Git directory wait for git.read", async () => {
    const lock = new GitMetadataLock(contains);
    const order: string[] = [];
    const gate = deferred();
    const read = lock.withGitRead(["/r/.git"], async () => {
      order.push("read-start");
      await gate.promise;
      order.push("read-end");
    });
    const write = lock.withWrite(["/r/.git/config"], async () => {
      order.push("write");
    });
    const other = lock.withWrite(["/r/src/a.ts"], async () => {
      order.push("other-write");
    });
    await other;
    gate.resolve();
    await Promise.all([read, write]);
    expect(order).toEqual(["read-start", "other-write", "read-end", "write"]);
    expect(lock.activeHolders).toBe(0);
  });

  it("makes git.read wait for a write that contains the Git directory", async () => {
    const lock = new GitMetadataLock(contains);
    const order: string[] = [];
    const gate = deferred();
    const write = lock.withWrite(["/r"], async () => {
      order.push("write-start");
      await gate.promise;
      order.push("write-end");
    });
    const read = lock.withGitRead(["/r/.git"], async () => {
      order.push("read");
    });
    await Promise.resolve();
    gate.resolve();
    await Promise.all([write, read]);
    expect(order).toEqual(["write-start", "write-end", "read"]);
  });

  it("lets git.read operations run together and releases on failure", async () => {
    const lock = new GitMetadataLock(contains);
    const gate = deferred();
    let concurrent = 0;
    let max = 0;
    const op = () =>
      lock.withGitRead(["/r/.git"], async () => {
        concurrent++;
        max = Math.max(max, concurrent);
        await gate.promise;
        concurrent--;
      });
    const all = Promise.all([op(), op()]);
    await Promise.resolve();
    gate.resolve();
    await all;
    expect(max).toBe(2);
    await expect(
      lock.withGitRead(["/r/.git"], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lock.activeHolders).toBe(0);
    await expect(lock.withWrite(["/r/.git/x"], async () => 1)).resolves.toBe(1);
  });
});

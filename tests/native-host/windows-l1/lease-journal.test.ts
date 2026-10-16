import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeLeaseJournal,
  openLeaseJournalStore,
  type LeaseJournalStore,
  type LeaseStoreOptions,
} from "../../../src/native-host/windows-l1/lease-journal.js";
import type { PrivateFileProtection } from "../../../src/core/platform/types.js";
import { currentUserSid, windowsTools } from "../../../src/native-host/windows-acl.js";
import { loadWindowsPrivateState } from "../../../src/native-host/windows-state.js";
import { loadWindowsLeaseLock } from "../../../src/native-host/windows-l1/lease-lock.js";
import { leasePlan } from "./lease-fixture.js";

let windowsPrivate: Promise<PrivateFileProtection> | undefined;
async function protection(): Promise<PrivateFileProtection> {
  if (process.platform === "win32") {
    windowsPrivate ??= currentUserSid(windowsTools(process.env.SystemRoot ?? "C:\\Windows")).then(
      loadWindowsPrivateState,
    );
    return windowsPrivate;
  }
  return {
    mechanism: "posix-mode",
    enforced: true,
    fileMode: 0o600,
    ensureDirectory: async (dir) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    },
    protectFile: (file) => chmod(file, 0o600),
    inspect: async (file) => ({
      mechanism: "posix-mode",
      ownerOnly: ((await lstat(file)).mode & 0o077) === 0,
      detail: "test modes",
    }),
  };
}
describe("durable lease WAL (real filesystem; no native ACL recovery claim)", () => {
  let root: string, privateFiles: PrivateFileProtection, lock: LeaseStoreOptions["lock"];
  const stores: LeaseJournalStore[] = [];
  const start = async (extra: Partial<LeaseStoreOptions> = {}) => {
    const store = await openLeaseJournalStore({ directory: root, privateFiles, lock, ...extra });
    stores.push(store);
    return store;
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "crot-lease-wal-"));
    privateFiles = await protection();
    await privateFiles.protectFile?.(root);
    let locked = false;
    lock =
      process.platform === "win32"
        ? await loadWindowsLeaseLock()
        : async () => {
            if (locked) throw new Error("lock held");
            locked = true;
            return {
              close: () => {
                locked = false;
              },
            };
          };
  });
  afterEach(async () => {
    for (const s of stores.reverse()) await s.close();
    stores.length = 0;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  it("flushes plan/active/job/closed independently, survives reopen and preserves immutable plan", async () => {
    const sync = vi.fn(async (h) => {
      await h.sync();
    });
    const store = await start({ sync }),
      plan = leasePlan();
    await store.create(plan);
    expect(sync).toHaveBeenCalledTimes(1);
    plan.objects[0]!.original = Buffer.alloc(24, 9).toString("base64");
    expect((await store.read(plan.id)).plan.objects[0]!.original).not.toBe(plan.objects[0]!.original);
    await store.append(plan.id, { type: "active" });
    await store.append(plan.id, { type: "job", name: `Local\\crot-l1-job-${"a".repeat(48)}` });
    await store.append(plan.id, { type: "closed" });
    expect(sync).toHaveBeenCalledTimes(4);
    await store.close();
    const reopened = await start(),
      records = await reopened.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ active: true, closed: true, jobs: [`Local\\crot-l1-job-${"a".repeat(48)}`] });
  });
  it("does not steal a live owner lock and reopens without unlinking it", async () => {
    const first = await start();
    await expect(start()).rejects.toThrow();
    await first.close();
    expect(await lstat(path.join(root, "lease.lock"))).toBeDefined();
    await start();
  });
  it.each(["truncate", "checksum", "unknown"])(
    "retains %s corruption and refuses all further operations",
    async (mode) => {
      const store = await start(),
        plan = leasePlan();
      await store.create(plan);
      await store.close();
      const file = path.join(root, `lease-${plan.id}.wal`);
      if (mode === "truncate") await truncate(file, (await lstat(file)).size - 3);
      else if (mode === "checksum") {
        const data = await readFile(file, "utf8");
        await writeFile(file, data.replace("project", "changed"));
      } else {
        const f = path.join(root, "foreign.tmp");
        await writeFile(f, "unknown");
        await privateFiles.protectFile?.(f);
      }
      const reopened = await start();
      await expect(reopened.list()).rejects.toThrow();
      await expect(reopened.create(leasePlan())).rejects.toThrow("poisoned");
      expect(await lstat(file)).toBeDefined();
    },
  );
  it("rejects an aliased journal hardlink without touching the target", async () => {
    const store = await start(),
      plan = leasePlan();
    await store.create(plan);
    await store.close();
    const file = path.join(root, `lease-${plan.id}.wal`),
      alias = path.join(root, "alias");
    await link(file, alias);
    const bytes = await readFile(file),
      reopened = await start();
    await expect(reopened.read(plan.id)).rejects.toThrow("object type");
    expect(await readFile(file)).toEqual(bytes);
  });
  it("retains a failed fsync and never advertises the lease as active", async () => {
    const store = await start({
        sync: async () => {
          throw new Error("injected FlushFileBuffers failure");
        },
      }),
      plan = leasePlan();
    await expect(store.create(plan)).rejects.toThrow("FlushFileBuffers");
    await expect(store.append(plan.id, { type: "active" })).rejects.toThrow("poisoned");
    await store.close();
    const reopened = await start();
    expect((await reopened.read(plan.id)).active).toBe(false);
  });
  it.each(["profile", "duplicate", "path", "base64"])("refuses invalid plan %s before creating WAL", async (mode) => {
    const store = await start(),
      plan = leasePlan();
    if (mode === "profile") plan.profile.name = "crot.l1.foreign";
    if (mode === "duplicate") plan.objects.push(structuredClone(plan.objects[0]!));
    if (mode === "path") plan.workspace = "C:\\project\\..\\state";
    if (mode === "base64") plan.objects[0]!.original = "garbage";
    await expect(store.create(plan)).rejects.toThrow();
    await expect(lstat(path.join(root, `lease-${plan.id}.wal`))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["double-active", "job-before-active", "double-job", "after-close"])(
    "rejects lifecycle %s without appending bytes",
    async (mode) => {
      const store = await start(),
        plan = leasePlan(),
        job = { type: "job" as const, name: `Local\\crot-l1-job-${"b".repeat(48)}` };
      await store.create(plan);
      if (mode !== "job-before-active") await store.append(plan.id, { type: "active" });
      if (mode === "double-job") await store.append(plan.id, job);
      if (mode === "after-close") await store.append(plan.id, { type: "closed" });
      const file = path.join(root, `lease-${plan.id}.wal`),
        before = await readFile(file);
      await expect(store.append(plan.id, mode === "double-active" ? { type: "active" } : job)).rejects.toThrow();
      expect(await readFile(file)).toEqual(before);
    },
  );
  it("serialises concurrent WAL appends with distinct hash-chain sequence numbers", async () => {
    const store = await start(),
      p = leasePlan();
    await store.create(p);
    await store.append(p.id, { type: "active" });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.append(p.id, { type: "job", name: `Local\\crot-l1-job-${i.toString(16).padStart(48, "0")}` }),
      ),
    );
    expect((await store.read(p.id)).jobs).toHaveLength(20);
  });
  it("refuses filename/plan identity substitution", async () => {
    const store = await start(),
      p = leasePlan(),
      other = leasePlan();
    await store.create(p);
    await store.close();
    const file = path.join(root, `lease-${other.id}.wal`);
    await writeFile(file, await readFile(path.join(root, `lease-${p.id}.wal`)));
    await privateFiles.protectFile?.(file);
    const reopened = await start();
    await expect(reopened.read(other.id)).rejects.toThrow("file identity");
  });
  it("requires real enforced owner-only storage, not inherited Windows ACL claims", async () => {
    await expect(
      start({ privateFiles: { ...privateFiles, mechanism: "inherited-acl", enforced: false } }),
    ).rejects.toThrow("admission");
    await expect(
      start({
        privateFiles: {
          ...privateFiles,
          inspect: async () => ({ mechanism: privateFiles.mechanism, ownerOnly: false, detail: "unprotected" }),
        },
      }),
    ).rejects.toThrow("descriptor");
  });
  it("strict decoder refuses empty, invalid UTF8 and oversized frames", () => {
    expect(() => decodeLeaseJournal(Buffer.alloc(0))).toThrow();
    expect(() => decodeLeaseJournal(Buffer.from([255, 10]))).toThrow();
    expect(() => decodeLeaseJournal(Buffer.alloc(32 * 1024 * 1024 + 1))).toThrow();
  });
});

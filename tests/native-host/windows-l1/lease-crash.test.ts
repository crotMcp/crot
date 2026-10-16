/** Real owner process death and flushed WAL; NOT a kernel ACL recovery proof. */
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, inject, it } from "vitest";
import { openLeaseJournalStore } from "../../../src/native-host/windows-l1/lease-journal.js";
import { loadWindowsLeaseLock } from "../../../src/native-host/windows-l1/lease-lock.js";
import { loadWindowsPrivateState } from "../../../src/native-host/windows-state.js";
import { currentUserSid, windowsTools } from "../../../src/native-host/windows-acl.js";
import type { PrivateFileProtection } from "../../../src/core/platform/types.js";

const fixture = fileURLToPath(new URL("./fixtures/lease-journal-owner.mjs", import.meta.url));
const waitReady = (child: ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    let errors = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("WAL owner readiness timed out"));
    }, 10000);
    const message = (v: unknown) => {
      if ((v as { ready?: boolean })?.ready === true) {
        cleanup();
        resolve();
      }
    };
    const exit = () => {
      cleanup();
      reject(new Error(`WAL owner exited before readiness: ${errors.slice(-500)}`));
    };
    const error = (e: Error) => {
      cleanup();
      reject(e);
    };
    const data = (b: Buffer) => {
      errors += b.toString();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", exit);
      child.off("error", error);
      child.stderr?.off("data", data);
    };
    child.on("message", message);
    child.once("exit", exit);
    child.once("error", error);
    child.stderr?.on("data", data);
  });
describe("durable journal after abrupt owner termination", () => {
  it.each(["plan", "active", "job"])("reopens after kill at %s without stale-lock removal", async (stage) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "crot-lease-crash-"));
    let child: ChildProcess | undefined;
    try {
      let privateFiles: PrivateFileProtection;
      if (process.platform === "win32")
        privateFiles = await loadWindowsPrivateState(
          await currentUserSid(windowsTools(process.env.SystemRoot ?? "C:\\Windows")),
        );
      else
        privateFiles = {
          mechanism: "posix-mode",
          enforced: true,
          fileMode: 0o600,
          ensureDirectory: async (d) => {
            await mkdir(d, { recursive: true, mode: 0o700 });
          },
          protectFile: (f) => chmod(f, 0o600),
          inspect: async (f) => ({
            mechanism: "posix-mode",
            ownerOnly: ((await lstat(f)).mode & 0o077) === 0,
            detail: "fixture",
          }),
        };
      await privateFiles.protectFile?.(dir);
      const { leasePlan } = await import("./lease-fixture.js"),
        plan = leasePlan();
      child = fork(
        fixture,
        [path.resolve(path.dirname(inject("crotMcpBin")), ".."), dir, JSON.stringify(plan), stage],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      await waitReady(child);
      const lock = process.platform === "win32" ? await loadWindowsLeaseLock() : async () => ({ close: () => {} });
      if (process.platform === "win32")
        await expect(lock(path.join(dir, "lease.lock"))).rejects.toThrow("exclusive open");
      const exited = once(child, "exit");
      expect(child.kill("SIGKILL")).toBe(true);
      await exited;
      const store = await openLeaseJournalStore({ directory: dir, privateFiles, lock });
      try {
        const records = await store.list();
        expect(records).toHaveLength(1);
        expect(records[0]!.plan).toEqual(plan);
        expect(records[0]!.active).toBe(stage !== "plan");
        expect(records[0]!.jobs).toHaveLength(stage === "job" ? 1 : 0);
        expect(records[0]!.closed).toBe(false);
      } finally {
        await store.close();
      }
      expect((await lstat(path.join(dir, "lease.lock"))).isFile()).toBe(true);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

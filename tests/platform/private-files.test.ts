import { chmod, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlFileAuditSink } from "../../src/core/audit/audit.js";
import { localPrincipal } from "../../src/core/auth/principal.js";
import { CrotCore } from "../../src/core/crot-core.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { isWindows, makeTempDirs, type TempDirs } from "../helpers.js";

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(() => dirs.cleanup());

const event = {
  id: "1",
  timestamp: new Date().toISOString(),
  operation: "test",
  capabilities: [],
  principal: localPrincipal("test"),
  paths: [],
  outcome: "success" as const,
  durationMs: 0,
};

describe("private file protection", () => {
  it("the host platform reports its mechanism honestly", async () => {
    const p = await createNodePlatform({ startupPath: "inherited" });
    expect(p.info.privateFiles).toEqual(
      isWindows ? { mechanism: "inherited-acl", enforced: false } : { mechanism: "posix-mode", enforced: true },
    );
  });

  it("Windows protection never claims owner-only access (pure)", async () => {
    const w = createPrivateFileProtection(true);
    expect(w).toMatchObject({ mechanism: "inherited-acl", enforced: false, fileMode: undefined });
    expect(await w.inspect(path.join(dirs.outside, "x"))).toMatchObject({
      mechanism: "inherited-acl",
      ownerOnly: null,
      detail: expect.stringContaining("Native Host"),
    });
  });

  it("status reports the audit file protection", async () => {
    const file = path.join(dirs.outside, "logs", "audit.jsonl");
    const core = await CrotCore.create({ workspace: { root: dirs.workspace }, audit: { sink: "file", path: file } });
    try {
      expect(core.status().audit.protection).toMatchObject(
        isWindows ? { mechanism: "inherited-acl", ownerOnly: null } : { mechanism: "posix-mode", ownerOnly: true },
      );
    } finally {
      await core.shutdown();
    }
  });
});

describe.runIf(!isWindows)("private file protection (POSIX)", () => {
  it("creates audit directories 0700 and files 0600", async () => {
    const file = path.join(dirs.outside, "new", "logs", "audit.jsonl");
    const sink = new JsonlFileAuditSink(file, createPrivateFileProtection(false));
    await sink.record(event);
    await sink.close();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dirs.outside, "new"))).mode & 0o777).toBe(0o700);
  });

  it("detects an existing audit file that other users can read", async () => {
    const file = path.join(dirs.outside, "audit.jsonl");
    await writeFile(file, "");
    await chmod(file, 0o644);
    const p = createPrivateFileProtection(false);
    expect(await p.inspect(file)).toEqual({
      mechanism: "posix-mode",
      ownerOnly: false,
      detail: expect.stringContaining("mode 0644"),
    });
    await chmod(file, 0o600);
    expect(await p.inspect(file)).toEqual({ mechanism: "posix-mode", ownerOnly: true, detail: "mode 0600" });
  });
});

describe.runIf(isWindows)("private file protection (Windows)", () => {
  it("creates the audit file without pretending a POSIX mode protects it", async () => {
    const file = path.join(dirs.outside, "logs", "audit.jsonl");
    const sink = new JsonlFileAuditSink(file, createPrivateFileProtection(true));
    await sink.record(event);
    await sink.close();
    const info = await stat(file);
    expect(info.isFile()).toBe(true);
    // Writable (no read-only attribute was set by a mode); access is governed by inherited ACLs.
    expect(info.mode & 0o200).toBe(0o200);
  });
});

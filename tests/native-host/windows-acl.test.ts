import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateLocalToken } from "../../src/adapters/http/auth.js";
import { JsonlFileAuditSink } from "../../src/core/audit/audit.js";
import { localPrincipal } from "../../src/core/auth/principal.js";
import { NativeHost } from "../../src/native-host/native-host.js";
import { isWindows, makeTempDirs, type TempDirs } from "../helpers.js";

describe.runIf(isWindows)("native host: owner-only Windows ACLs", () => {
  let dirs: TempDirs;
  let native: NativeHost;

  beforeEach(async () => {
    dirs = await makeTempDirs();
    native = await NativeHost.start({ startupPath: "inherited", jobObjects: false });
  });
  afterEach(async () => {
    await native.close();
    await dirs.cleanup();
  });

  const files = () => native.platform.privateFiles;

  it("reports an enforced ACL mechanism without pretending file modes", () => {
    expect(files().mechanism).toBe("windows-acl");
    expect(files().enforced).toBe(true);
    expect(files().fileMode).toBeUndefined();
    expect(typeof files().protectFile).toBe("function");
  });

  it("restricts an inherited-ACL file and keeps CROT's own access", async () => {
    const file = path.join(dirs.outside, "secret");
    await writeFile(file, "a");
    expect((await files().inspect(file)).ownerOnly).toBe(false);
    await files().protectFile!(file);
    expect(await files().inspect(file)).toMatchObject({ mechanism: "windows-acl", ownerOnly: true });
    await writeFile(file, "b");
    expect(await readFile(file, "utf8")).toBe("b");
  });

  it("creates owner-only directories; files inside inherit the restriction", async () => {
    const dir = path.join(dirs.outside, "new", "state");
    await files().ensureDirectory(dir);
    const child = path.join(dir, "config.json");
    await writeFile(child, "{}");
    expect((await files().inspect(path.join(dirs.outside, "new"))).ownerOnly).toBe(true);
    expect((await files().inspect(child)).ownerOnly).toBe(true);
  });

  it("reports missing files as created owner-only", async () => {
    expect((await files().inspect(path.join(dirs.outside, "missing"))).ownerOnly).toBe(true);
  });

  it("rejects untrusted paths", async () => {
    await expect(files().protectFile!("relative\\file")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(files().protectFile!(`${dirs.outside}\\a"b`)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(files().protectFile!(path.join(dirs.outside, "missing"))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(files().protectFile!(dirs.outside)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("HTTP token file: created owner-only and reused", async () => {
    const file = path.join(dirs.outside, "state", "http-token");
    const first = await loadOrCreateLocalToken(file, files());
    expect(first.created).toBe(true);
    expect((await files().inspect(file)).ownerOnly).toBe(true);
    expect((await readFile(file, "utf8")).trim()).toBe(first.token);
    const second = await loadOrCreateLocalToken(file, files());
    expect(second).toEqual({ token: first.token, created: false });
  });

  it("HTTP token file: an existing inherited-ACL file is restricted on load", async () => {
    const file = path.join(dirs.outside, "http-token");
    await writeFile(file, `${"t".repeat(43)}\n`);
    expect((await files().inspect(file)).ownerOnly).toBe(false);
    await loadOrCreateLocalToken(file, files());
    expect((await files().inspect(file)).ownerOnly).toBe(true);
  });

  it("audit log: restricted before the first event is written", async () => {
    const file = path.join(dirs.outside, "logs", "audit.jsonl");
    const sink = new JsonlFileAuditSink(file, files());
    await sink.record({
      id: "e1",
      timestamp: new Date().toISOString(),
      operation: "test",
      capabilities: [],
      principal: localPrincipal("test"),
      paths: [],
      outcome: "success",
      durationMs: 0,
    });
    await sink.close();
    expect((await files().inspect(file)).ownerOnly).toBe(true);
    expect(JSON.parse((await readFile(file, "utf8")).trim())).toMatchObject({ id: "e1", operation: "test" });
  });
});

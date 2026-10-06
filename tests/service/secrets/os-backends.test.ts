/**
 * The real secret backends of each OS (WP-21): macOS Keychain (a temporary
 * keychain), Windows DPAPI, the Linux Secret Service when a session keyring
 * is available, and the secret-tool protocol through a real process (a
 * stand-in executable) on macOS/Linux.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrivateFileProtection } from "../../../src/core/platform/private-files.js";
import { createKeychainBackend } from "../../../src/service/secrets/backends.js";
import { createDpapiBackend, dpapiDirectory, loadDpapi } from "../../../src/service/secrets/dpapi.js";
import {
  generateSecret,
  openSecretStore,
  prepareSecretStore,
  probeOsBackend,
  readSecretsMarker,
} from "../../../src/service/secrets/store.js";
import { isWindows, makeTempDirs, type TempDirs } from "../../helpers.js";

const privateFiles = createPrivateFileProtection(isWindows);
const exists = async (p: string) => (await stat(p).catch(() => undefined)) !== undefined;

let dirs: TempDirs;
let stateDir: string;
beforeEach(async () => {
  dirs = await makeTempDirs();
  stateDir = path.join(dirs.outside, "state");
});
afterEach(async () => {
  await dirs.cleanup();
});

describe.runIf(process.platform === "darwin")("macOS Keychain (temporary keychain)", () => {
  let keychain: string;
  beforeEach(async () => {
    keychain = path.join(await realpath(dirs.outside), "crot-test.keychain-db");
    execFileSync("/usr/bin/security", ["create-keychain", "-p", "crot-test", keychain]);
    execFileSync("/usr/bin/security", ["unlock-keychain", "-p", "crot-test", keychain]);
    execFileSync("/usr/bin/security", ["set-keychain-settings", keychain]);
  });
  afterEach(() => {
    try {
      execFileSync("/usr/bin/security", ["delete-keychain", keychain]);
    } catch {
      // already gone
    }
  });

  it("stores, replaces, reads and removes generic passwords", async () => {
    const backend = createKeychainBackend(stateDir, { keychain });
    const a = generateSecret();
    const b = generateSecret();
    expect(await backend.get("http-token")).toBeUndefined();
    await backend.set("http-token", a);
    expect(await backend.get("http-token")).toBe(a);
    await backend.set("http-token", b);
    expect(await backend.get("http-token")).toBe(b);
    // Another state directory has its own items.
    expect(
      await createKeychainBackend(path.join(dirs.outside, "other"), { keychain }).get("http-token"),
    ).toBeUndefined();
    await backend.delete("http-token");
    await backend.delete("http-token");
    expect(await backend.get("http-token")).toBeUndefined();
  });

  it("migrates plaintext files into the keychain on first start; readers follow", async () => {
    await mkdir(stateDir, { recursive: true });
    const service = generateSecret();
    await writeFile(path.join(stateDir, "service-token"), `${service}\n`);
    const { store, info } = await prepareSecretStore({
      stateDir,
      privateFiles,
      preference: "auto",
      host: { keychain },
    });
    expect(info.backend).toBe("keychain");
    expect(await store.read("service-token")).toBe(service);
    expect(await exists(path.join(stateDir, "service-token"))).toBe(false);
    expect((await readSecretsMarker(stateDir))?.keychain).toBe(keychain);
    expect(await (await openSecretStore(stateDir, privateFiles)).read("service-token")).toBe(service);
  });
});

describe.runIf(isWindows)("Windows DPAPI", () => {
  it("encrypts per user: files hold no plaintext and decrypt to the value", async () => {
    const dpapi = await loadDpapi();
    const backend = createDpapiBackend(stateDir, privateFiles, dpapi);
    const value = generateSecret();
    await backend.set("browser-token", value);
    const file = path.join(dpapiDirectory(stateDir), "browser-token.dpapi");
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(value);
    expect(Buffer.from(text.trim(), "base64").includes(Buffer.from(value))).toBe(false);
    expect(await backend.get("browser-token")).toBe(value);
    // The entropy binds a blob to its name: a blob copied to another name does not decrypt.
    await writeFile(path.join(dpapiDirectory(stateDir), "http-token.dpapi"), text);
    await expect(backend.get("http-token")).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await backend.delete("browser-token");
    expect(await backend.get("browser-token")).toBeUndefined();
  });

  it("is chosen automatically and receives the plaintext files of earlier versions", async () => {
    await mkdir(stateDir, { recursive: true });
    const control = generateSecret();
    await writeFile(path.join(stateDir, "control-token"), `${control}\n`);
    const { store, info } = await prepareSecretStore({ stateDir, privateFiles, preference: "auto" });
    expect(info.backend).toBe("dpapi");
    expect(await store.read("control-token")).toBe(control);
    expect(await exists(path.join(stateDir, "control-token"))).toBe(false);
    expect(await (await openSecretStore(stateDir, privateFiles)).read("control-token")).toBe(control);
  });
});

describe.runIf(process.platform === "linux")("Linux Secret Service (when a session keyring is available)", () => {
  it("round-trips through secret-tool", async (ctx) => {
    const probe = await probeOsBackend(stateDir, privateFiles);
    if (!("backend" in probe)) ctx.skip();
    const backend = (probe as { backend: Awaited<ReturnType<typeof openSecretStore>>["backend"] }).backend;
    const value = generateSecret();
    await backend.set("http-token", value);
    try {
      expect(await backend.get("http-token")).toBe(value);
    } finally {
      await backend.delete("http-token");
    }
    expect(await backend.get("http-token")).toBeUndefined();
  });
});

/** A secret-tool stand-in: items in a JSON file, every argument vector logged. */
const FAKE_SECRET_TOOL = `
const fs = require("node:fs");
const [db, log] = [process.env.FAKE_DB, process.env.FAKE_LOG];
fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
const items = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, "utf8")) : {};
const [command, ...rest] = process.argv.slice(2);
const key = rest.filter((a) => !a.startsWith("--label=")).join("/");
if (command === "lookup") {
  if (!(key in items)) process.exit(1);
  process.stdout.write(items[key]);
} else if (command === "store") {
  items[key] = fs.readFileSync(0, "utf8");
  fs.writeFileSync(db, JSON.stringify(items));
} else if (command === "clear") {
  delete items[key];
  fs.writeFileSync(db, JSON.stringify(items));
} else process.exit(2);
`;

describe.runIf(!isWindows)("secret-tool protocol through a real process", () => {
  it("passes secrets only on stdin and stdout", async () => {
    const bin = path.join(dirs.outside, "bin");
    await mkdir(bin);
    const script = path.join(bin, "fake-secret-tool.cjs");
    await writeFile(script, FAKE_SECRET_TOOL);
    const tool = path.join(bin, "secret-tool");
    await writeFile(tool, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(tool, 0o755);
    const log = path.join(dirs.outside, "argv.log");
    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
      FAKE_DB: path.join(dirs.outside, "db.json"),
      FAKE_LOG: log,
    };
    await mkdir(stateDir, { recursive: true });
    const http = generateSecret();
    await writeFile(path.join(stateDir, "http-token"), `${http}\n`);
    const host = { platform: "linux" as const, env };
    const { store, info } = await prepareSecretStore({ stateDir, privateFiles, preference: "auto", host });
    expect(info.backend).toBe("libsecret");
    expect(await store.read("http-token")).toBe(http);
    expect(await exists(path.join(stateDir, "http-token"))).toBe(false);
    expect(await (await openSecretStore(stateDir, privateFiles, host)).read("http-token")).toBe(http);
    const argv = await readFile(log, "utf8");
    expect(argv).toContain("lookup");
    expect(argv).not.toContain(http);
  });
});

it("generated secrets are 256-bit base64url values", () => {
  const values = new Set(Array.from({ length: 50 }, () => generateSecret()));
  expect(values.size).toBe(50);
  for (const v of values) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

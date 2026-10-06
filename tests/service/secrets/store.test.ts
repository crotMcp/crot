/**
 * Secret store (WP-21): backend choice, migration of plaintext files into OS
 * secure storage, conflicts and failures, readers following the marker, and
 * rotation. The OS tools are replaced by in-memory stand-ins (fake-tools.ts)
 * so the logic runs on every OS; the real backends are tested in
 * os-backends.test.ts.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrivateFileProtection } from "../../../src/core/platform/private-files.js";
import { secretCredentialStore } from "../../../src/service/endpoints.js";
import { createFileBackend, secretFile, stateKey } from "../../../src/service/secrets/backends.js";
import {
  openSecretStore,
  prepareSecretStore,
  readSecretsMarker,
  secretsMarkerFile,
  type SecretStoreHost,
} from "../../../src/service/secrets/store.js";
import { SECRET_NAMES } from "../../../src/service/secrets/types.js";
import { isWindows, makeTempDirs, type TempDirs } from "../../helpers.js";
import { fakeTools, type FakeTools } from "./fake-tools.js";

// Removal of migrated plaintext files can be made to fail (EPERM), as a file in use on Windows does.
const removal = vi.hoisted(() => ({ failing: new Set<string>() }));
vi.mock(import("../../../src/service/secrets/backends.js"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    removeFile: async (file: string) => {
      if (removal.failing.has(file.split(/[\\/]/).pop()!))
        throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${file}'`), { code: "EPERM" });
      return actual.removeFile(file);
    },
  };
});

const privateFiles = createPrivateFileProtection(isWindows);
const exists = async (p: string) => (await stat(p).catch(() => undefined)) !== undefined;
const token = (c: string) => c.repeat(43);

let dirs: TempDirs;
let stateDir: string;
let tools: FakeTools;
beforeEach(async () => {
  dirs = await makeTempDirs();
  stateDir = path.join(dirs.outside, "state");
  tools = fakeTools();
});
afterEach(async () => {
  await dirs.cleanup();
});

/** A Linux host with a (fake) Secret Service. */
const linux = (): SecretStoreHost => ({
  platform: "linux",
  env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent" },
  secretTool: "/fake/secret-tool",
  run: tools.run,
});
/** A macOS host with a (fake) Keychain. */
const mac = (): SecretStoreHost => ({ platform: "darwin", run: tools.run });

async function legacyFiles(values: Partial<Record<(typeof SECRET_NAMES)[number], string>>): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  for (const [name, value] of Object.entries(values)) await writeFile(path.join(stateDir, name), `${value}\n`);
}

const legacy = {
  "service-token": token("s"),
  "control-token": token("c"),
  "browser-token": token("b"),
  "http-token": token("h"),
};

describe("secret store: backend choice", () => {
  it.each([
    ["Secret Service", linux, "libsecret"],
    ["macOS Keychain", mac, "keychain"],
  ] as const)("auto on first start moves existing plaintext secrets into the %s", async (_label, host, backend) => {
    await legacyFiles(legacy);
    const logs: string[] = [];
    const { store, info } = await prepareSecretStore({
      stateDir,
      privateFiles,
      preference: "auto",
      host: host(),
      log: (m) => logs.push(m),
    });
    expect(info.backend).toBe(backend);
    expect((await readSecretsMarker(stateDir))?.backend).toBe(backend);
    for (const [name, value] of Object.entries(legacy)) {
      expect(await store.read(name as keyof typeof legacy)).toBe(value);
      expect(await exists(path.join(stateDir, name))).toBe(false);
    }
    // Readers follow the marker.
    const reader = await openSecretStore(stateDir, privateFiles, host());
    expect(reader.backend.id).toBe(backend);
    expect(await secretCredentialStore(stateDir, privateFiles, { host: host() }).read("service")).toBe(
      legacy["service-token"],
    );
    // No value ever in an argument vector or in a log line.
    for (const call of tools.calls)
      for (const value of Object.values(legacy)) expect(call.args.join(" ")).not.toContain(value);
    for (const value of Object.values(legacy)) expect(logs.join("\n")).not.toContain(value);
    // Items are keyed by the state directory.
    expect([...tools.items.keys()].every((k) => k.includes(stateKey(stateDir)))).toBe(true);
  });

  it("auto falls back to owner-only files when the OS store is unusable, and records why", async () => {
    tools.fail.add("store");
    await legacyFiles({ "service-token": legacy["service-token"] });
    const logs: string[] = [];
    const { store, info } = await prepareSecretStore({
      stateDir,
      privateFiles,
      preference: "auto",
      host: linux(),
      log: (m) => logs.push(m),
    });
    expect(info.backend).toBe("file");
    expect(info.fallbackReason).toMatch(/locked collection/);
    expect(logs.join("\n")).toMatch(/OS secure storage unavailable/);
    expect(await store.read("service-token")).toBe(legacy["service-token"]);
    const marker = await readSecretsMarker(stateDir);
    expect(marker).toMatchObject({ backend: "file", fallbackReason: expect.stringMatching(/locked/) });
    // The choice is kept: the next start does not probe again.
    tools.fail.clear();
    tools.calls.length = 0;
    expect((await prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: linux() })).info.backend).toBe(
      "file",
    );
    expect(tools.calls).toHaveLength(0);
  });

  it("auto without D-Bus or secret-tool uses files without running anything", async () => {
    const host: SecretStoreHost = { platform: "linux", env: {}, run: tools.run };
    const { info } = await prepareSecretStore({ stateDir, privateFiles, preference: "auto", host });
    expect(info.backend).toBe("file");
    expect(info.fallbackReason).toMatch(/secret-tool|D-Bus/);
    expect(tools.calls).toHaveLength(0);
  });

  it('"os" fails clearly when no OS store is usable; nothing is changed', async () => {
    tools.fail.add("store");
    await legacyFiles({ "http-token": legacy["http-token"] });
    await expect(prepareSecretStore({ stateDir, privateFiles, preference: "os", host: linux() })).rejects.toMatchObject(
      { code: "CONFIG_ERROR", message: expect.stringMatching(/secrets\.store is "os"/) },
    );
    expect(await readFile(path.join(stateDir, "http-token"), "utf8")).toBe(`${legacy["http-token"]}\n`);
    expect(await exists(secretsMarkerFile(stateDir))).toBe(false);
  });

  it('"os" moves a recorded file store into the OS store; "file" moves it back', async () => {
    await legacyFiles(legacy);
    await prepareSecretStore({ stateDir, privateFiles, preference: "file", host: linux() });
    expect((await readSecretsMarker(stateDir))?.backend).toBe("file");
    const os = await prepareSecretStore({ stateDir, privateFiles, preference: "os", host: linux() });
    expect(os.info.backend).toBe("libsecret");
    expect(await os.store.read("control-token")).toBe(legacy["control-token"]);
    expect(await exists(path.join(stateDir, "control-token"))).toBe(false);
    const back = await prepareSecretStore({ stateDir, privateFiles, preference: "file", host: linux() });
    expect(back.info.backend).toBe("file");
    expect(await readFile(path.join(stateDir, "control-token"), "utf8")).toBe(`${legacy["control-token"]}\n`);
    expect(tools.items.size).toBe(0);
  });

  it("rejects an invalid marker instead of guessing", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(secretsMarkerFile(stateDir), '{"version":1,"backend":"cloud"}');
    await expect(openSecretStore(stateDir, privateFiles)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("a recorded OS store that fails later is an error, never a switch to files", async () => {
    await prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: linux() });
    tools.fail.add("lookup");
    const store = await openSecretStore(stateDir, privateFiles, linux());
    await expect(store.read("service-token")).rejects.toMatchObject({
      code: "OPERATION_FAILED",
      message: expect.stringMatching(/Secret Service: cannot read service-token/),
    });
    await expect(secretCredentialStore(stateDir, privateFiles, { host: linux() }).read("service")).rejects.toThrow();
    expect(await exists(path.join(stateDir, "service-token"))).toBe(false);
  });
});

describe("secret store: migration safety", () => {
  it("a failed copy leaves every plaintext file and no marker", async () => {
    await legacyFiles(legacy);
    // The probe succeeds, then storing fails for the real secrets.
    let stores = 0;
    const run: SecretStoreHost["run"] = async (file, args, options) => {
      if (args[0] === "store" && ++stores > 1)
        return { code: 1, stdout: "", stderr: "Cannot create an item", timedOut: false };
      return tools.run(file, args, options);
    };
    await expect(
      prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: { ...linux(), run } }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR", message: expect.stringMatching(/Nothing was changed/) });
    for (const [name, value] of Object.entries(legacy))
      expect(await readFile(path.join(stateDir, name), "utf8")).toBe(`${value}\n`);
    expect(await exists(secretsMarkerFile(stateDir))).toBe(false);
    expect(tools.items.size).toBe(0);
  });

  it("a value that does not read back is never trusted", async () => {
    await legacyFiles({ "service-token": legacy["service-token"] });
    let lookups = 0;
    const run: SecretStoreHost["run"] = async (file, args, options) => {
      // The probe reads back correctly; the migrated secret does not.
      if (args[0] === "lookup" && args.includes("service-token") && ++lookups > 1)
        return { code: 0, stdout: token("x"), stderr: "", timedOut: false };
      return tools.run(file, args, options);
    };
    await expect(
      prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: { ...linux(), run } }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(await readFile(path.join(stateDir, "service-token"), "utf8")).toBe(`${legacy["service-token"]}\n`);
  });

  it("imports a plaintext file found next to the OS store, and deletes it when the values agree", async () => {
    await prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: linux() });
    // An older CROT version wrote a file again.
    await legacyFiles({ "browser-token": legacy["browser-token"] });
    const first = await prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: linux() });
    expect(await first.store.read("browser-token")).toBe(legacy["browser-token"]);
    expect(await exists(path.join(stateDir, "browser-token"))).toBe(false);
    await legacyFiles({ "browser-token": legacy["browser-token"] });
    await prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: linux() });
    expect(await exists(path.join(stateDir, "browser-token"))).toBe(false);
  });

  it("refuses to start when a plaintext file and the store disagree, and keeps both", async () => {
    const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: linux() });
    await store.write("http-token", legacy["http-token"]);
    await legacyFiles({ "http-token": token("z") });
    await expect(
      prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: linux() }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR", message: expect.stringMatching(/holds a different http-token/) });
    expect(await readFile(path.join(stateDir, "http-token"), "utf8")).toBe(`${token("z")}\n`);
    expect(await store.read("http-token")).toBe(legacy["http-token"]);
  });

  it("refuses an invalid plaintext file instead of importing it", async () => {
    await legacyFiles({ "service-token": "short" });
    await expect(
      prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: linux() }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(await exists(path.join(stateDir, "service-token"))).toBe(true);
  });

  it("refuses to start when a migrated plaintext file cannot be removed", async () => {
    const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: linux() });
    await legacyFiles({ "control-token": legacy["control-token"] });
    removal.failing.add("control-token");
    try {
      await expect(
        prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: linux() }),
      ).rejects.toMatchObject({ code: "CONFIG_ERROR", message: expect.stringMatching(/could not be removed/) });
    } finally {
      removal.failing.clear();
    }
    // The value is safe in the store; the file is reported, not ignored.
    expect(await store.read("control-token")).toBe(legacy["control-token"]);
    expect(await exists(path.join(stateDir, "control-token"))).toBe(true);
    // Once it can be removed, the next start completes.
    await prepareSecretStore({ stateDir, privateFiles, preference: "auto", host: linux() });
    expect(await exists(path.join(stateDir, "control-token"))).toBe(false);
  });
});

describe("secret store: HTTP token file", () => {
  it("migrates a configured http.auth.tokenFile into the store and deletes it", async () => {
    const file = path.join(dirs.outside, "custom", "token.txt");
    await mkdir(path.dirname(file), { recursive: true });
    // Legacy tokens may be any printable token of at least 32 characters.
    const value = "legacy-token-with.symbols~0123456789abcdef";
    await writeFile(file, `${value}\n`);
    const { store } = await prepareSecretStore({
      stateDir,
      privateFiles,
      preference: "auto",
      host: linux(),
      httpToken: { storage: "secret-store", file },
    });
    expect(await store.read("http-token")).toBe(value);
    expect(await exists(file)).toBe(false);
  });

  it("migrates a configured tokenFile into the file store too (owner-only, state directory)", async () => {
    const file = path.join(dirs.outside, "token.txt");
    await writeFile(file, `${legacy["http-token"]}\n`);
    const { store } = await prepareSecretStore({
      stateDir,
      privateFiles,
      preference: "file",
      httpToken: { storage: "secret-store", file },
    });
    expect(await store.read("http-token")).toBe(legacy["http-token"]);
    expect(await exists(file)).toBe(false);
    expect(await readFile(secretFile(stateDir, "http-token"), "utf8")).toBe(`${legacy["http-token"]}\n`);
  });

  it('leaves the token file alone in the "token-file" compatibility mode', async () => {
    await legacyFiles({ "http-token": legacy["http-token"], "service-token": legacy["service-token"] });
    const { store } = await prepareSecretStore({
      stateDir,
      privateFiles,
      preference: "auto",
      host: linux(),
      httpToken: { storage: "token-file" },
    });
    expect(await exists(path.join(stateDir, "http-token"))).toBe(true);
    expect(await store.read("http-token")).toBeUndefined();
    // Every other secret moved.
    expect(await exists(path.join(stateDir, "service-token"))).toBe(false);
  });
});

describe("secret store: file backend", () => {
  it("writes atomically, owner-only, and reads back", async () => {
    const backend = createFileBackend(stateDir, privateFiles);
    await backend.set("service-token", legacy["service-token"]);
    await backend.set("service-token", token("t"));
    expect(await backend.get("service-token")).toBe(token("t"));
    if (!isWindows) expect((await stat(secretFile(stateDir, "service-token"))).mode & 0o777).toBe(0o600);
    await backend.delete("service-token");
    await backend.delete("service-token");
    expect(await backend.get("service-token")).toBeUndefined();
  });

  it("readOrCreate creates one random secret and then keeps it", async () => {
    const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
    const first = await store.readOrCreate("control-token");
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await store.readOrCreate("control-token")).toBe(first);
  });
});

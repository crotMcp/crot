/** `crot-mcp secrets status | show http-token | rotate` (WP-21): parsing and behaviour. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCli } from "../../src/cli/options.js";
import { rotateSecrets, secretsStatus, showHttpToken } from "../../src/cli/secrets.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { prepareSecretStore } from "../../src/service/secrets/store.js";
import { isWindows, makeTempDirs, type TempDirs } from "../helpers.js";

const privateFiles = createPrivateFileProtection(isWindows);
let dirs: TempDirs;
let stateDir: string;
beforeEach(async () => {
  dirs = await makeTempDirs();
  stateDir = path.join(dirs.outside, "state");
});
afterEach(() => dirs.cleanup());

describe("parseCli: secrets", () => {
  const directories = () => ({
    config: path.join(dirs.outside, "no-config"),
    state: stateDir,
    logs: path.join(dirs.outside, "logs"),
    cache: path.join(dirs.outside, "cache"),
  });
  const parse = (argv: string[]) => parseCli(argv, {}, { directories: directories() as never });

  it("parses status, show http-token and rotate", async () => {
    await expect(parse(["secrets", "status"])).resolves.toMatchObject({ kind: "secrets", action: "status", names: [] });
    await expect(parse(["secrets", "show", "http-token"])).resolves.toMatchObject({
      action: "show",
      names: ["http-token"],
    });
    await expect(parse(["secrets", "rotate", "browser-token", "http-token"])).resolves.toMatchObject({
      action: "rotate",
      names: ["browser-token", "http-token"],
    });
    await expect(parse(["secrets", "rotate", "--all"])).resolves.toMatchObject({
      names: ["service-token", "control-token", "browser-token", "http-token"],
    });
  });

  it("only the HTTP token can be shown; unknown names and commands are errors", async () => {
    await expect(parse(["secrets", "show", "service-token"])).rejects.toMatchObject({
      code: "CONFIG_ERROR",
      message: expect.stringMatching(/Only the HTTP access token can be shown/),
    });
    await expect(parse(["secrets", "rotate", "device-key"])).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(parse(["secrets", "rotate"])).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(parse(["secrets", "export"])).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("reads http.auth from --config without requiring a workspace", async () => {
    const file = path.join(dirs.outside, "crot.json");
    await writeFile(file, JSON.stringify({ http: { auth: { storage: "token-file" } } }));
    await expect(parse(["secrets", "status", "--config", file])).resolves.toMatchObject({
      configFile: file,
      config: { http: { auth: { storage: "token-file" } } },
    });
  });
});

describe("secrets commands", () => {
  const options = (config?: unknown) => ({ stateDir, privateFiles, ...(config ? { config: config as never } : {}) });

  it("status names the backend and the secrets but prints no value", async () => {
    const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
    const value = await store.readOrCreate("http-token");
    const text = await secretsStatus(options());
    expect(text).toMatch(/secret store: file/);
    expect(text).toMatch(/http-token: present/);
    expect(text).toMatch(/service-token: not created/);
    expect(text).not.toContain(value);
  });

  it("show prints the HTTP token from the store, or explains that none exists", async () => {
    await expect(showHttpToken(options())).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
    const value = await store.readOrCreate("http-token");
    expect((await showHttpToken(options())).token).toBe(value);
  });

  it("show and rotate use the token file in the compatibility mode", async () => {
    const tokenFile = path.join(dirs.outside, "compat");
    await writeFile(tokenFile, "compat-token-0123456789-0123456789-abcdef\n");
    const config = { http: { auth: { storage: "token-file", tokenFile } } };
    expect(await showHttpToken(options(config))).toMatchObject({
      token: "compat-token-0123456789-0123456789-abcdef",
      note: expect.stringMatching(/compatibility mode/),
    });
    await mkdir(stateDir, { recursive: true });
    await rotateSecrets(options(config), ["http-token"]);
    const rotated = (await readFile(tokenFile, "utf8")).trim();
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await secretsStatus(options(config))).toMatch(/plaintext file .*compatibility mode/);
  });

  it("rotate replaces every secret with a new random value", async () => {
    const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
    const before = await Promise.all(
      (["service-token", "control-token", "browser-token", "http-token"] as const).map((n) => store.readOrCreate(n)),
    );
    await rotateSecrets(options(), ["service-token", "control-token", "browser-token", "http-token"]);
    const after = await Promise.all(
      (["service-token", "control-token", "browser-token", "http-token"] as const).map((n) => store.read(n)),
    );
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).not.toBe(before[i]);
      expect(after[i]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});

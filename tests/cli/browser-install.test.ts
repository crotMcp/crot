import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CROT_EXTENSION_ID,
  CROT_EXTENSION_ORIGIN,
  CROT_NATIVE_HOST_NAME,
  formatInstallResult,
  hostManifest,
  hostRegistrations,
  installBrowserHost,
  posixLauncher,
  regExeWriter,
  windowsLauncher,
  type BrowserInstallOptions,
} from "../../src/cli/browser-install.js";
import { parseCli } from "../../src/cli/options.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";

const windows = process.platform === "win32";
const hostOs = windows ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const repoFile = (relative: string) => new URL(`../../${relative}`, import.meta.url);

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crot-browser-install-"));
  cleanups.push(dir);
  return dir;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** A stand-in for crot-browser-relay.js that prints the arguments it received. */
const FAKE_RELAY = "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n";

async function setup() {
  const root = await tempDir();
  // Quotes, %, $ and spaces exercise the launcher quoting (a lone % is literal on the cmd.exe command line).
  const stateDir = path.join(root, "state 'q' 100% $HOME");
  const relayScript = path.join(root, "fake relay.mjs");
  await writeFile(relayScript, FAKE_RELAY);
  const home = path.join(root, "home");
  const registry: [string, string][] = [];
  const options: BrowserInstallOptions = {
    os: hostOs,
    home,
    env: {},
    stateDir,
    nodePath: process.execPath,
    relayScript,
    privateFiles: createPrivateFileProtection(windows),
    registry: async (key, value) => {
      registry.push([key, value]);
    },
  };
  return { root, stateDir, relayScript, home, registry, options };
}

/** Start the launcher the way Chromium does (cmd.exe for .cmd files on Windows) with the browser's arguments. */
function runLauncher(launcher: string): Promise<string> {
  const browserArgs = [CROT_EXTENSION_ORIGIN, "--parent-window=0"];
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, stdout: string | Buffer) => (error ? reject(error) : resolve(String(stdout)));
    if (windows) {
      const comspec = process.env.ComSpec ?? path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      execFile(comspec, ["/d", "/s", "/c", `""${launcher}" ${browserArgs.join(" ")}"`], { windowsVerbatimArguments: true }, done);
    } else {
      execFile(launcher, browserArgs, done);
    }
  });
}

describe("host manifest", () => {
  it("allows only the CROT extension and uses stdio", () => {
    expect(hostManifest("/opt/crot/launcher")).toEqual({
      name: "com.crot.host",
      description: "CROT Host: connects the CROT Browser Extension to the local CROT bridge",
      path: "/opt/crot/launcher",
      type: "stdio",
      allowed_origins: ["chrome-extension://bllcepanlhojbddfbbpegmnokpaakool/"],
    });
  });

  it("matches the extension: host name and the id derived from the manifest key", async () => {
    const manifest = JSON.parse(await readFile(repoFile("extension/manifest.json"), "utf8")) as { key: string };
    const hex = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
    expect([...hex].map((d) => String.fromCharCode(97 + parseInt(d, 16))).join("")).toBe(CROT_EXTENSION_ID);
    const connection = await readFile(repoFile("extension/src/host-connection.ts"), "utf8");
    expect(connection.includes(`NATIVE_HOST_NAME = "${CROT_NATIVE_HOST_NAME}"`)).toBe(true);
  });
});

describe("hostRegistrations", () => {
  it("Linux: per-browser NativeMessagingHosts directories below XDG_CONFIG_HOME (default ~/.config)", () => {
    expect(hostRegistrations("linux", "/home/u", "/home/u/.local/state/crot")).toEqual([
      { browsers: ["Google Chrome"], manifestFile: "/home/u/.config/google-chrome/NativeMessagingHosts/com.crot.host.json" },
      { browsers: ["Microsoft Edge"], manifestFile: "/home/u/.config/microsoft-edge/NativeMessagingHosts/com.crot.host.json" },
      { browsers: ["Brave"], manifestFile: "/home/u/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.crot.host.json" },
    ]);
    expect(hostRegistrations("linux", "/home/u", "/s", { XDG_CONFIG_HOME: "/xdg" })[0]?.manifestFile).toBe("/xdg/google-chrome/NativeMessagingHosts/com.crot.host.json");
    // A relative XDG_CONFIG_HOME is invalid and ignored.
    expect(hostRegistrations("linux", "/home/u", "/s", { XDG_CONFIG_HOME: "xdg" })[0]?.manifestFile).toBe(
      "/home/u/.config/google-chrome/NativeMessagingHosts/com.crot.host.json",
    );
  });

  it("macOS: per-browser directories in Application Support", () => {
    expect(hostRegistrations("macos", "/Users/u", "/s").map((r) => r.manifestFile)).toEqual([
      "/Users/u/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.crot.host.json",
      "/Users/u/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.crot.host.json",
      "/Users/u/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.crot.host.json",
    ]);
  });

  it("Windows: one manifest in the state directory, registered for Chrome (also read by Brave) and Edge in HKCU", () => {
    const manifestFile = "C:\\Users\\u\\AppData\\Local\\CROT\\native-messaging\\com.crot.host.json";
    expect(hostRegistrations("windows", "C:\\Users\\u", "C:\\Users\\u\\AppData\\Local\\CROT")).toEqual([
      { browsers: ["Google Chrome", "Brave"], manifestFile, registryKey: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.crot.host" },
      { browsers: ["Microsoft Edge"], manifestFile, registryKey: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.crot.host" },
    ]);
  });
});

describe("launchers", () => {
  it("POSIX: single-quotes every path and forwards the browser's arguments", () => {
    expect(posixLauncher({ nodePath: "/usr/bin/node", relayScript: "/opt/it's/relay.js", stateDir: "/home/u/state $x" })).toBe(
      "#!/bin/sh\n# CROT browser host launcher, written by `crot-mcp browser install`.\n" +
        `exec '/usr/bin/node' '/opt/it'\\''s/relay.js' --state-dir '/home/u/state $x' "$@"\n`,
    );
  });

  it("Windows: double-quotes paths, doubles % and protects a trailing backslash", () => {
    expect(windowsLauncher({ nodePath: "C:\\Program Files\\nodejs\\node.exe", relayScript: "C:\\crot\\relay.js", stateDir: "C:\\Users\\a%b%\\CROT" })).toBe(
      "@echo off\r\nrem CROT browser host launcher, written by `crot-mcp browser install`.\r\n" +
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\crot\\relay.js" --state-dir "C:\\Users\\a%%b%%\\CROT" %*\r\n',
    );
    expect(windowsLauncher({ nodePath: "C:\\node.exe", relayScript: "C:\\relay.js", stateDir: "D:\\" }).includes('--state-dir "D:\\\\" %*')).toBe(true);
    expect(() => windowsLauncher({ nodePath: "C:\\node.exe", relayScript: "C:\\relay.js", stateDir: 'C:\\a"b' })).toThrow();
  });
});

describe("installBrowserHost", () => {
  it("writes the launcher and the host manifests; the launcher starts the relay with --state-dir", async () => {
    const { stateDir, home, registry, options } = await setup();
    const result = await installBrowserHost(options);

    const launcher = path.join(stateDir, "native-messaging", windows ? "crot-browser-host.cmd" : "crot-browser-host");
    expect(result.launcher).toBe(launcher);
    expect(result.registrations).toEqual(hostRegistrations(hostOs, home, stateDir, {}));
    for (const registration of result.registrations) {
      expect(JSON.parse(await readFile(registration.manifestFile, "utf8"))).toEqual(hostManifest(launcher));
    }
    if (windows) {
      expect(registry).toEqual(result.registrations.map((r) => [r.registryKey, r.manifestFile]));
    } else {
      expect(registry).toEqual([]);
      expect((await stat(launcher)).mode & 0o777).toBe(0o700);
      expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
      expect((await stat(result.registrations[0]!.manifestFile)).mode & 0o777).toBe(0o644);
    }

    // The browser passes the extension origin (and on Windows --parent-window); the relay ignores them.
    expect(JSON.parse(await runLauncher(launcher))).toEqual(["--state-dir", stateDir, CROT_EXTENSION_ORIGIN, "--parent-window=0"]);
  });

  it("is idempotent and replaces earlier files", async () => {
    const { options } = await setup();
    const first = await installBrowserHost(options);
    const moved = path.join(path.dirname(options.relayScript), "moved relay.mjs");
    await writeFile(moved, FAKE_RELAY);
    const second = await installBrowserHost({ ...options, relayScript: moved });
    expect(second).toEqual(first);
    expect((await readFile(second.launcher, "utf8")).includes("moved relay.mjs")).toBe(true);
    expect(formatInstallResult(second).includes(CROT_EXTENSION_ORIGIN)).toBe(true);
  });

  it("refuses relative paths, a missing relay script and Windows without a registry writer", async () => {
    const { options, root } = await setup();
    expect(await rejection(installBrowserHost({ ...options, stateDir: "state" }))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await rejection(installBrowserHost({ ...options, relayScript: path.join(root, "missing.js") }))).toMatchObject({ code: "NOT_FOUND" });
    const noRegistry: BrowserInstallOptions = { ...options, os: "windows", registry: undefined };
    expect(await rejection(installBrowserHost(noRegistry))).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("reports a registry failure as OPERATION_FAILED", async () => {
    const root = await tempDir();
    expect(await rejection(regExeWriter(path.join(root, "no-windows"))("HKCU\\Software\\CROT-test", "x"))).toMatchObject({ code: "OPERATION_FAILED" });
  });
});

describe("crot-mcp browser install (command line)", () => {
  it("parses the subcommand without requiring a configuration", async () => {
    expect(await parseCli(["browser", "install"], {})).toEqual({ kind: "browser-install" });
    expect(await parseCli(["browser", "install", "--help"], {})).toEqual({ kind: "help" });
  });

  it("rejects unknown browser commands and options", async () => {
    for (const argv of [["browser"], ["browser", "uninstall"], ["browser", "install", "extra"], ["browser", "install", "--workspace", "/w"]]) {
      expect(await rejection(parseCli(argv, {}))).toMatchObject({ code: "CONFIG_ERROR" });
    }
  });
});

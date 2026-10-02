import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeTokenFile, readBridgeToken } from "../../src/browser-bridge/endpoint.js";
import { browserProtectedPaths, startBrowserBridge } from "../../src/cli/browser.js";
import { CrotError } from "../../src/core/errors.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";

const windows = process.platform === "win32";
const privateFiles = createPrivateFileProtection(windows);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempState(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crot-cli-browser-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "state");
}

async function start(enabled: boolean, stateDir: string) {
  const logs: string[] = [];
  const bridge = await startBrowserBridge({ enabled, stateDir, privateFiles, log: (m) => logs.push(m) });
  if (bridge) cleanups.push(() => bridge.close());
  return { bridge, logs };
}

describe("browser bridge wiring", () => {
  it("is off by default: no bridge, nothing created, nothing protected", async () => {
    const stateDir = await tempState();
    let called = false;
    const bridge = await startBrowserBridge({
      enabled: false,
      stateDir,
      privateFiles,
      log: () => undefined,
      start: async () => {
        called = true;
        throw new Error("must not start");
      },
    });
    expect(bridge).toBeUndefined();
    expect(called).toBe(false);
    expect(browserProtectedPaths(false, stateDir)).toEqual([]);
    await expect(readFile(bridgeTokenFile(stateDir), "utf8")).rejects.toThrow();
  });

  it("protects the bridge token file when enabled", async () => {
    const stateDir = await tempState();
    expect(browserProtectedPaths(true, stateDir)).toEqual([bridgeTokenFile(stateDir)]);
  });

  it("starts a waiting bridge and never logs the token", async () => {
    const stateDir = await tempState();
    const { bridge, logs } = await start(true, stateDir);
    expect(bridge).toBeDefined();
    expect(bridge!.state().kind).toBe("waiting");
    expect(bridge!.tokenFile).toBe(bridgeTokenFile(stateDir));
    const token = (await readBridgeToken(bridge!.tokenFile)) ?? "";
    expect(token.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("waiting"))).toBe(true);
    expect(logs.some((l) => l.includes(token))).toBe(false);
  });

  it("a second instance stays in_use instead of failing", async () => {
    const stateDir = await tempState();
    const first = await start(true, stateDir);
    const second = await start(true, stateDir);
    expect(first.bridge!.state().kind).toBe("waiting");
    expect(second.bridge!.state().kind).toBe("in_use");
    expect(second.logs.some((l) => l.includes("BROWSER_BRIDGE_IN_USE"))).toBe(true);
  });

  it("a start error does not throw: warning logged, CROT continues without a bridge", async () => {
    const stateDir = await tempState();
    const logs: string[] = [];
    const bridge = await startBrowserBridge({
      enabled: true,
      stateDir,
      privateFiles,
      log: (m) => logs.push(m),
      start: async () => {
        throw new CrotError("CONFIG_ERROR", "boom");
      },
    });
    expect(bridge).toBeUndefined();
    expect(logs).toEqual(["warning: browser bridge unavailable: boom; continuing without browser tools"]);
  });

  it("an invalid token file does not throw", async () => {
    const stateDir = await tempState();
    await mkdir(stateDir, { recursive: true });
    await writeFile(bridgeTokenFile(stateDir), "short\n");
    const { bridge, logs } = await start(true, stateDir);
    expect(bridge).toBeUndefined();
    expect(logs.some((l) => l.startsWith("warning: browser bridge unavailable:"))).toBe(true);
  });

  it.skipIf(windows)("a non-socket file at the socket path does not throw and is kept", async () => {
    const stateDir = await tempState();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const socketPath = path.join(stateDir, "browser.sock");
    await writeFile(socketPath, "keep me");
    const { bridge, logs } = await start(true, stateDir);
    expect(bridge).toBeUndefined();
    expect(logs.some((l) => l.startsWith("warning: browser bridge unavailable:"))).toBe(true);
    expect(await readFile(socketPath, "utf8")).toBe("keep me");
  });

  it.skipIf(windows)("a socket path that is too long does not throw", async () => {
    const stateDir = path.join(await tempState(), "x".repeat(120));
    const { bridge, logs } = await start(true, stateDir);
    expect(bridge).toBeUndefined();
    expect(logs.some((l) => l.includes("too long"))).toBe(true);
  });
});

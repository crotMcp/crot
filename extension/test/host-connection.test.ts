import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_COMMANDS, type BrowserCommand } from "../../src/core/capabilities/browser/connection.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  CHUNK_DATA_UNITS,
  MAX_BROWSER_TO_HOST_FRAME_BYTES,
  encodeHostMessage,
  parseBrowserMessage,
  type HostRequest,
} from "../../src/browser-bridge/protocol.js";
import type { CommandHandler, CommandHandlers } from "../src/commands.js";
import { ExtensionError } from "../src/errors.js";
import { HostConnection, NATIVE_HOST_NAME, fitResponse, type HostConnectionOptions } from "../src/host-connection.js";
import { FakeRuntime, flush, type FakePort } from "./fake-chrome.js";

const BROWSER = { name: "Google Chrome", version: "130.0.6723.92", extensionVersion: "0.1.0" };
const WELCOME = { type: "welcome", protocol: BRIDGE_PROTOCOL_VERSION };

const connections: HostConnection[] = [];

afterEach(() => {
  for (const connection of connections) connection.stop();
  connections.length = 0;
});

function handlers(overrides: Partial<Record<BrowserCommand, CommandHandler>> = {}): CommandHandlers {
  const all = {} as Record<BrowserCommand, CommandHandler>;
  for (const command of BROWSER_COMMANDS) all[command] = overrides[command] ?? (async () => ({ command }));
  return all;
}

function setup(options: Partial<HostConnectionOptions> = {}) {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const connection = new HostConnection({
    runtime,
    browser: BROWSER,
    handlers: handlers(),
    log: (message) => logs.push(message),
    reconnectMinMs: 5,
    reconnectMaxMs: 40,
    welcomeTimeoutMs: 200,
    ...options,
  });
  connections.push(connection);
  return { runtime, connection, logs };
}

function connect(options: Partial<HostConnectionOptions> = {}) {
  const ctx = setup(options);
  ctx.connection.ensureConnected();
  const port = ctx.runtime.lastPort;
  port.deliver(WELCOME);
  return { ...ctx, port };
}

const request = (id: string, command: BrowserCommand, params: Record<string, unknown> = {}): HostRequest => ({ type: "request", id, command, params });

/** What the host would receive, validated with the host's own parser. */
const received = (port: FakePort) => port.sent.map((message) => parseBrowserMessage(message));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("HostConnection", () => {
  it("connects to the CROT native host and sends hello first", () => {
    const { runtime, connection } = setup();
    expect(connection.state).toBe("disconnected");
    connection.ensureConnected();
    expect(runtime.hosts).toEqual([NATIVE_HOST_NAME]);
    expect(connection.state).toBe("connecting");
    expect(received(runtime.lastPort)).toEqual([{ type: "hello", protocol: BRIDGE_PROTOCOL_VERSION, browser: BROWSER }]);
    runtime.lastPort.deliver(WELCOME);
    expect(connection.state).toBe("connected");
    connection.ensureConnected();
    expect(runtime.ports.length).toBe(1);
  });

  it("answers each request with one response", async () => {
    const { port } = connect({
      handlers: handlers({ "tabs.list": async (params) => ({ tabs: [], echo: params }) }),
    });
    port.deliver(request("r1", "tabs.list"));
    port.deliver(request("r2", "page.read", { format: "text", maxBytes: 5 }));
    await flush();
    expect(received(port).slice(1)).toEqual([
      { type: "response", id: "r1", ok: true, result: { tabs: [], echo: {} } },
      { type: "response", id: "r2", ok: true, result: { command: "page.read" } },
    ]);
  });

  it("reports command failures as error responses with allowed codes", async () => {
    const { port } = connect({
      handlers: handlers({
        "tabs.close": async () => {
          throw new ExtensionError("NOT_FOUND", "No tab with id 9.");
        },
        "tabs.open": async () => {
          throw new TypeError("boom\nsecond line");
        },
      }),
    });
    port.deliver(request("a", "tabs.close", { tabId: 9 }));
    port.deliver(request("b", "tabs.open", { url: "https://e.com/", active: true }));
    await flush();
    expect(received(port).slice(1)).toEqual([
      { type: "response", id: "a", ok: false, error: { code: "NOT_FOUND", message: "No tab with id 9." } },
      { type: "response", id: "b", ok: false, error: { code: "OPERATION_FAILED", message: "Browser operation failed: boom second line" } },
    ]);
  });

  it("reassembles chunked requests", async () => {
    let seen: unknown;
    const { port } = connect({
      handlers: handlers({
        "page.type": async (params) => {
          seen = params;
          return { tabId: 1, url: "https://e.com/" };
        },
      }),
    });
    const text = "é".repeat(CHUNK_DATA_UNITS * 2);
    const frames = encodeHostMessage(request("big", "page.type", { selector: "#t", text, clear: false }));
    expect(frames.length).toBeGreaterThan(1);
    const decoder = new TextDecoder();
    for (const frame of frames) port.deliver(JSON.parse(decoder.decode(frame.subarray(4))));
    await flush();
    expect((seen as { text: string }).text).toBe(text);
    expect(received(port)[1]).toEqual({ type: "response", id: "big", ok: true, result: { tabId: 1, url: "https://e.com/" } });
  });

  it("closes the port on protocol violations", () => {
    const violations: unknown[] = [
      { type: "request", id: "x", command: "eval", params: {} },
      { type: "request", id: "bad id!", command: "tabs.list", params: {} },
      { type: "response", id: "x", ok: true, result: {} },
      WELCOME,
      "not an object",
      { type: "chunk", id: "c", index: 1, count: 2, data: "x" },
    ];
    for (const violation of violations) {
      const { port, connection } = connect();
      port.deliver(violation);
      expect(port.disconnected).toBe(true);
      expect(connection.state).toBe("disconnected");
    }
  });

  it("refuses requests before welcome and an unsupported protocol", () => {
    const early = setup();
    early.connection.ensureConnected();
    early.runtime.lastPort.deliver(request("r", "tabs.list"));
    expect(early.runtime.lastPort.disconnected).toBe(true);
    const future = setup();
    future.connection.ensureConnected();
    future.runtime.lastPort.deliver({ type: "welcome", protocol: BRIDGE_PROTOCOL_VERSION + 1 });
    expect(future.runtime.lastPort.disconnected).toBe(true);
    expect(future.connection.state).toBe("disconnected");
  });

  it("refuses duplicate in-flight request ids", async () => {
    let release: () => void = () => undefined;
    const { port } = connect({
      handlers: handlers({ "tabs.list": () => new Promise((resolve) => (release = () => resolve({ tabs: [] }))) }),
    });
    port.deliver(request("same", "tabs.list"));
    port.deliver(request("same", "tabs.list"));
    expect(port.disconnected).toBe(true);
    release();
    await flush();
    expect(port.sent.length).toBe(1);
  });

  it("discards answers for a connection that has gone away", async () => {
    let release: () => void = () => undefined;
    const { port, runtime } = connect({
      handlers: handlers({ "tabs.list": () => new Promise((resolve) => (release = () => resolve({ tabs: [] }))) }),
    });
    port.deliver(request("r", "tabs.list"));
    port.hostDisconnect();
    release();
    await flush();
    expect(port.sent.length).toBe(1);
    expect(runtime.lastError).toBeUndefined();
  });

  it("reconnects with backoff after the host goes away", async () => {
    const { runtime, connection, logs } = connect();
    runtime.lastPort.hostDisconnect("Native host has exited.");
    expect(connection.state).toBe("disconnected");
    expect(logs[logs.length - 1]).toBe("disconnected from the CROT Host: Native host has exited.");
    await sleep(60);
    expect(runtime.ports.length).toBe(2);
    expect(connection.state).toBe("connecting");
    // Failing attempts back off (10, 20, 40 ms here); each new port waits up to 200 ms for welcome.
    for (let i = 0; i < 3; i++) {
      runtime.lastPort.hostDisconnect("Specified native messaging host not found.");
      await sleep(100);
    }
    expect(runtime.ports.length).toBe(5);
    runtime.lastPort.deliver(WELCOME);
    expect(connection.state).toBe("connected");
    runtime.lastPort.hostDisconnect();
    connection.ensureConnected();
    expect(runtime.ports.length).toBe(6);
  });

  it("keeps retrying when the native host cannot be started", async () => {
    const { runtime, connection } = setup();
    runtime.failConnect = true;
    connection.ensureConnected();
    expect(connection.state).toBe("disconnected");
    await sleep(30);
    expect(runtime.hosts.length).toBeGreaterThan(1);
    runtime.failConnect = false;
    await sleep(100);
    expect(connection.state).toBe("connecting");
  });

  it("gives up on a host that never sends welcome", async () => {
    const { runtime, connection } = setup({ welcomeTimeoutMs: 10 });
    connection.ensureConnected();
    const port = runtime.lastPort;
    await sleep(60);
    expect(port.disconnected).toBe(true);
    expect(runtime.ports.length).toBeGreaterThan(1);
  });

  it("replaces results too large for the host with LIMIT_EXCEEDED", () => {
    const big = "x".repeat(MAX_BROWSER_TO_HOST_FRAME_BYTES);
    expect(fitResponse({ type: "response", id: "r", ok: true, result: { content: big } })).toEqual({
      type: "response",
      id: "r",
      ok: false,
      error: { code: "LIMIT_EXCEEDED", message: "The result exceeds " + MAX_BROWSER_TO_HOST_FRAME_BYTES + " bytes." },
    });
    const fits = { type: "response", id: "r", ok: true, result: { content: "x".repeat(1000) } } as const;
    expect(fitResponse(fits)).toBe(fits);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(fitResponse({ type: "response", id: "r", ok: true, result: cyclic })).toMatchObject({ ok: false, error: { code: "OPERATION_FAILED" } });
  });
});

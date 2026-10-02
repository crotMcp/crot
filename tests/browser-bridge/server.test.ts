import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeEndpoint, readBridgeToken } from "../../src/browser-bridge/endpoint.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  ChunkReassembler,
  MAX_BROWSER_TO_HOST_FRAME_BYTES,
  MAX_HOST_TO_BROWSER_FRAME_BYTES,
  MessageReader,
  encodeMessage,
  parseHostMessage,
  type HostRequest,
} from "../../src/browser-bridge/protocol.js";
import { BrowserBridge, type BrowserBridgeOptions } from "../../src/browser-bridge/server.js";
import { CrotError } from "../../src/core/errors.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";

const windows = process.platform === "win32";
const privateFiles = createPrivateFileProtection(windows);
const BROWSER = { name: "Chrome", version: "130.0.0.0", extensionVersion: "0.1.0" };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempState(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crot-bridge-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "state");
}

async function startBridge(stateDir?: string, options: Partial<BrowserBridgeOptions> = {}) {
  const dir = stateDir ?? (await tempState());
  const logs: string[] = [];
  const bridge = await BrowserBridge.start({
    stateDir: dir,
    privateFiles,
    log: (message) => logs.push(message),
    handshakeTimeoutMs: 2_000,
    ...options,
  });
  cleanups.push(() => bridge.close());
  const token = await readBridgeToken(bridge.tokenFile);
  if (token === undefined) throw new Error("token file missing");
  return { bridge, dir, token, logs };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

async function rejection(promise: Promise<unknown>): Promise<CrotError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CrotError);
    return error as CrotError;
  }
  throw new Error("expected a rejection");
}

const options = (timeoutMs = 5_000, signal: AbortSignal = new AbortController().signal) => ({ timeoutMs, signal });

/** Plays crot-browser-relay and the extension: raw frames over the bridge endpoint. */
class FakeClient {
  private readonly reader = new MessageReader(MAX_HOST_TO_BROWSER_FRAME_BYTES);
  private readonly queue: unknown[] = [];
  readonly closed: Promise<void>;

  private constructor(readonly socket: net.Socket) {
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => this.queue.push(...this.reader.push(chunk)));
    this.closed = new Promise((resolve) => socket.once("close", () => resolve()));
  }

  static connect(endpoint: string): Promise<FakeClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(endpoint);
      socket.once("connect", () => {
        const client = new FakeClient(socket);
        cleanups.push(async () => client.close());
        resolve(client);
      });
      socket.once("error", reject);
    });
  }

  send(message: unknown): void {
    this.socket.write(encodeMessage(message, MAX_BROWSER_TO_HOST_FRAME_BYTES));
  }

  async next(timeoutMs = 5_000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length === 0) {
      if (this.socket.destroyed) throw new Error("connection closed");
      if (Date.now() > deadline) throw new Error("no message in time");
      await sleep(5);
    }
    return this.queue.shift();
  }

  async nextRequest(): Promise<HostRequest> {
    const message = parseHostMessage(await this.next());
    if (message.type !== "request") throw new Error("expected a request, got " + message.type);
    return message;
  }

  close(): void {
    this.socket.destroy();
  }
}

async function connectExtension(bridge: BrowserBridge, token: string): Promise<FakeClient> {
  const client = await FakeClient.connect(bridge.endpoint.path);
  client.send({ type: "auth", protocol: BRIDGE_PROTOCOL_VERSION, token });
  client.send({ type: "hello", protocol: BRIDGE_PROTOCOL_VERSION, browser: BROWSER });
  expect(await client.next()).toEqual({ type: "welcome", protocol: BRIDGE_PROTOCOL_VERSION });
  return client;
}

/** One request/response round trip on a connected extension. */
async function roundTrip(bridge: BrowserBridge, client: FakeClient): Promise<void> {
  const pending = bridge.request("tabs.list", {}, options());
  const request = await client.nextRequest();
  client.send({ type: "response", id: request.id, ok: true, result: { tabs: [] } });
  expect(await pending).toEqual({ tabs: [] });
}

describe("browser bridge endpoint", () => {
  it("derives the Windows pipe name from the token without revealing it", () => {
    const a = bridgeEndpoint("/s", "a".repeat(43), true);
    const b = bridgeEndpoint("/s", "b".repeat(43), true);
    expect(a.kind).toBe("named-pipe");
    expect(/^\\\\\.\\pipe\\crot-browser-[0-9a-f]{32}$/.test(a.path)).toBe(true);
    expect(a.path === b.path).toBe(false);
    expect(a.path.includes("a".repeat(43))).toBe(false);
    expect(bridgeEndpoint("/s", "a".repeat(43), true)).toEqual(a);
  });

  it("places the POSIX socket in the state directory and rejects paths that are too long", () => {
    expect(bridgeEndpoint("/s", "a".repeat(43), false)).toEqual({ kind: "unix-socket", path: path.join("/s", "browser.sock") });
    expect(() => bridgeEndpoint("/" + "x".repeat(100), "a".repeat(43), false)).toThrow(CrotError);
  });
});

describe("BrowserBridge", () => {
  it("creates a private token file and waits for the extension", async () => {
    const { bridge, token, logs } = await startBridge();
    expect(/^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    expect(bridge.state()).toEqual({ kind: "waiting" });
    expect(bridge.status()).toMatchObject({ state: "waiting", endpoint: { kind: windows ? "named-pipe" : "unix-socket" } });
    if (!windows) {
      expect((await stat(bridge.tokenFile)).mode & 0o777).toBe(0o600);
      expect((await stat(bridge.endpoint.path)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(bridge.endpoint.path))).mode & 0o777).toBe(0o700);
    }
    expect(logs).toEqual([]);
  });

  it("keeps the token across restarts", async () => {
    const first = await startBridge();
    await first.bridge.close();
    const second = await startBridge(first.dir);
    expect(second.token).toBe(first.token);
    expect(second.bridge.endpoint).toEqual(first.bridge.endpoint);
    expect(second.bridge.state()).toEqual({ kind: "waiting" });
  });

  it("refuses a token file without a valid token", async () => {
    const dir = await tempState();
    await privateFiles.ensureDirectory(dir);
    await writeFile(path.join(dir, "browser-token"), "short\n");
    expect((await rejection(BrowserBridge.start({ stateDir: dir, privateFiles }))).code).toBe("CONFIG_ERROR");
  });

  it("completes the handshake and carries requests and responses", async () => {
    const { bridge, token, logs } = await startBridge();
    const client = await connectExtension(bridge, token);
    expect(bridge.state()).toEqual({ kind: "connected", browser: BROWSER });
    expect(bridge.status()).toMatchObject({ state: "connected", browser: BROWSER });

    const pending = bridge.request("tabs.close", { tabId: 7 }, options());
    const request = await client.nextRequest();
    expect(request).toMatchObject({ type: "request", command: "tabs.close", params: { tabId: 7 } });
    client.send({ type: "response", id: request.id, ok: true, result: { tabId: 7, closed: true } });
    expect(await pending).toEqual({ tabId: 7, closed: true });

    // Concurrent requests are matched by id, in any order.
    const one = bridge.request("tabs.activate", { tabId: 1 }, options());
    const two = bridge.request("tabs.activate", { tabId: 2 }, options());
    const r1 = await client.nextRequest();
    const r2 = await client.nextRequest();
    expect(r1.id === r2.id).toBe(false);
    client.send({ type: "response", id: r2.id, ok: true, result: "second" });
    client.send({ type: "response", id: r1.id, ok: true, result: "first" });
    expect(await one).toBe("first");
    expect(await two).toBe("second");

    expect(logs.join("\n").includes(token)).toBe(false);
  });

  it("maps extension errors to sanitized CrotErrors with allowlisted codes", async () => {
    const { bridge, token } = await startBridge();
    const client = await connectExtension(bridge, token);
    const fail = async (code: string, message: string): Promise<CrotError> => {
      const pending = bridge.request("tabs.list", {}, options());
      const request = await client.nextRequest();
      client.send({ type: "response", id: request.id, ok: false, error: { code, message } });
      return rejection(pending);
    };

    const restricted = await fail("BROWSER_PAGE_RESTRICTED", "no\u0000\n\u001b[31mway " + "x".repeat(1500));
    expect(restricted.code).toBe("BROWSER_PAGE_RESTRICTED");
    expect(restricted.message.startsWith("no [31mway x")).toBe(true);
    expect(restricted.message.length).toBeLessThanOrEqual(500);
    expect(/[\u0000-\u001f]/.test(restricted.message)).toBe(false);
    expect(restricted.details).toBeUndefined();

    const unknown = await fail("EXTENSION_CRASHED", "");
    expect(unknown.code).toBe("OPERATION_FAILED");
    expect(unknown.message).toBe("Browser error EXTENSION_CRASHED: unknown error");

    // The extension cannot claim authorization or bridge-state errors.
    for (const code of ["PERMISSION_DENIED", "BROWSER_BRIDGE_IN_USE", "CONFIG_ERROR"]) {
      expect((await fail(code, "m")).code).toBe("OPERATION_FAILED");
    }
    expect((await fail("NOT_FOUND", "No tab with id 9.")).code).toBe("NOT_FOUND");
  });

  it("closes connections that fail the handshake", async () => {
    const { bridge, token, logs } = await startBridge(undefined, { handshakeTimeoutMs: 200 });
    const hello = { type: "hello", protocol: BRIDGE_PROTOCOL_VERSION, browser: BROWSER };
    const cases: unknown[][] = [
      [{ type: "auth", protocol: 1, token: "x".repeat(43) }, hello],
      [hello],
      [{ type: "auth", protocol: 2, token }, hello],
      [{ type: "auth", protocol: 1, token }, { ...hello, protocol: 2 }],
      [{ type: "auth", protocol: 1, token }, { type: "response", id: "a", ok: true, result: 1 }],
      [{ type: "auth", protocol: 1, token }],
      [],
    ];
    for (const messages of cases) {
      const client = await FakeClient.connect(bridge.endpoint.path);
      for (const message of messages) client.send(message);
      await client.closed;
      expect(client.socket.bytesRead).toBe(0);
      expect(bridge.state()).toEqual({ kind: "waiting" });
    }
    // A handshake frame larger than MAX_HANDSHAKE_FRAME_BYTES is refused from its header.
    const big = await FakeClient.connect(bridge.endpoint.path);
    big.socket.write(Uint8Array.of(0x01, 0x10, 0x00, 0x00));
    await big.closed;
    expect(logs.some((line) => line.includes("invalid bridge token"))).toBe(true);
    expect(logs.join("\n").includes(token)).toBe(false);
    // The bridge still accepts a valid extension.
    await connectExtension(bridge, token);
  });

  it("accepts one extension at a time", async () => {
    const { bridge, token } = await startBridge();
    const first = await connectExtension(bridge, token);
    const second = await FakeClient.connect(bridge.endpoint.path);
    second.send({ type: "auth", protocol: 1, token });
    second.send({ type: "hello", protocol: 1, browser: { ...BROWSER, name: "Edge" } });
    await second.closed;
    expect(bridge.state()).toEqual({ kind: "connected", browser: BROWSER });
    await roundTrip(bridge, first);
  });

  it("closes the connection on anything but a response to a pending request", async () => {
    const { bridge, token } = await startBridge();
    const violations: unknown[] = [
      { type: "response", id: "not-pending", ok: true, result: {} },
      { type: "hello", protocol: 1, browser: BROWSER },
      { type: "request", id: "x", command: "tabs.list", params: {} },
      { type: "response", id: "bad id!", ok: true, result: {} },
    ];
    for (const violation of violations) {
      const client = await connectExtension(bridge, token);
      const pending = bridge.request("tabs.list", {}, options());
      await client.nextRequest();
      client.send(violation);
      expect((await rejection(pending)).code).toBe("BROWSER_NOT_CONNECTED");
      await client.closed;
      expect(bridge.state()).toEqual({ kind: "waiting" });
    }
  });

  it("discards late answers to requests Core gave up on", async () => {
    const { bridge, token } = await startBridge();
    const client = await connectExtension(bridge, token);

    const controller = new AbortController();
    const aborted = bridge.request("tabs.list", {}, options(5_000, controller.signal));
    const r1 = await client.nextRequest();
    controller.abort();
    expect((await rejection(aborted)).code).toBe("OPERATION_FAILED");

    const timedOut = bridge.request("tabs.list", {}, options(50));
    const r2 = await client.nextRequest();
    expect((await rejection(timedOut)).code).toBe("TIMEOUT");

    client.send({ type: "response", id: r1.id, ok: true, result: "late" });
    client.send({ type: "response", id: r2.id, ok: false, error: { code: "TIMEOUT", message: "late" } });
    await roundTrip(bridge, client);
    expect(bridge.state().kind).toBe("connected");

    // An already aborted signal never reaches the browser.
    const done = new AbortController();
    done.abort();
    expect((await rejection(bridge.request("tabs.list", {}, options(5_000, done.signal)))).code).toBe("OPERATION_FAILED");
    await roundTrip(bridge, client);
  });

  it("fails pending requests when the extension disconnects", async () => {
    const { bridge, token } = await startBridge();
    expect((await rejection(bridge.request("tabs.list", {}, options()))).code).toBe("BROWSER_NOT_CONNECTED");
    const client = await connectExtension(bridge, token);
    const pending = bridge.request("tabs.list", {}, options());
    await client.nextRequest();
    client.close();
    expect((await rejection(pending)).code).toBe("BROWSER_NOT_CONNECTED");
    await waitFor(() => bridge.state().kind === "waiting");
    expect((await rejection(bridge.request("tabs.list", {}, options()))).code).toBe("BROWSER_NOT_CONNECTED");
    // The extension can reconnect.
    await roundTrip(bridge, await connectExtension(bridge, token));
  });

  it("limits the requests in flight", async () => {
    const { bridge, token } = await startBridge(undefined, { maxPendingRequests: 2 });
    const client = await connectExtension(bridge, token);
    const a = bridge.request("tabs.list", {}, options());
    const b = bridge.request("tabs.list", {}, options());
    expect((await rejection(bridge.request("tabs.list", {}, options()))).code).toBe("RESOURCE_BUSY");
    for (const pending of [a, b]) {
      const request = await client.nextRequest();
      client.send({ type: "response", id: request.id, ok: true, result: null });
      expect(await pending).toBeNull();
    }
    await roundTrip(bridge, client);
  });

  it("sends requests larger than the browser frame limit as consecutive chunks", async () => {
    const { bridge, token } = await startBridge();
    const client = await connectExtension(bridge, token);
    const text = "\u00e9\ud83d\ude00".repeat(400_000);
    const pending = bridge.request("page.type", { selector: "#q", text, clear: false }, options());
    const reassembler = new ChunkReassembler();
    let frames = 0;
    let request: ReturnType<ChunkReassembler["accept"]>;
    do {
      request = reassembler.accept(parseHostMessage(await client.next()));
      frames++;
    } while (request === undefined);
    expect(frames).toBeGreaterThan(1);
    if (request.type !== "request") throw new Error("expected a request");
    expect(request.command).toBe("page.type");
    expect(request.params.text === text).toBe(true);
    client.send({ type: "response", id: request.id, ok: true, result: { tabId: 1, url: "https://example.com/" } });
    expect(await pending).toEqual({ tabId: 1, url: "https://example.com/" });
  });

  it("reports in_use in a second instance without failing, and never takes over", async () => {
    const owner = await startBridge();
    const other = await startBridge(owner.dir);
    expect(other.bridge.state()).toEqual({ kind: "in_use" });
    expect(other.bridge.status().state).toBe("in_use");
    expect((await rejection(other.bridge.request("tabs.list", {}, options()))).code).toBe("BROWSER_BRIDGE_IN_USE");
    expect(other.logs.some((line) => line.includes("another CROT instance owns"))).toBe(true);
    // Ownership stays with the first instance, which keeps working.
    const client = await connectExtension(owner.bridge, owner.token);
    await roundTrip(owner.bridge, client);

    // No arbitration: when the owner exits, the second instance stays in_use.
    await owner.bridge.close();
    await sleep(300);
    expect(other.bridge.state()).toEqual({ kind: "in_use" });
    expect((await rejection(other.bridge.request("tabs.list", {}, options()))).code).toBe("BROWSER_BRIDGE_IN_USE");
    expect(other.logs.length).toBe(1);
    // The endpoint is free: an instance started now owns it.
    const next = await startBridge(owner.dir);
    expect(next.bridge.state()).toEqual({ kind: "waiting" });
    await roundTrip(next.bridge, await connectExtension(next.bridge, next.token));
    expect(other.bridge.state()).toEqual({ kind: "in_use" });
  });

  it("close fails pending requests, disconnects and is idempotent", async () => {
    const { bridge, token } = await startBridge();
    const client = await connectExtension(bridge, token);
    const pending = bridge.request("tabs.list", {}, options());
    await client.nextRequest();
    await Promise.all([bridge.close(), bridge.close()]);
    await bridge.close();
    expect((await rejection(pending)).code).toBe("BROWSER_NOT_CONNECTED");
    await client.closed;
    expect(bridge.status().state).toBe("closed");
    expect((await rejection(bridge.request("tabs.list", {}, options()))).code).toBe("BROWSER_NOT_CONNECTED");
  });

  it.skipIf(windows)("removes a socket left behind by a crashed instance", async () => {
    const dir = await tempState();
    await privateFiles.ensureDirectory(dir);
    const socketPath = path.join(dir, "browser.sock");
    const script = "require('node:net').createServer().listen(process.argv[1], () => console.log('ready'))";
    const child = spawn(process.execPath, ["-e", script, socketPath], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    expect((await stat(socketPath)).isSocket()).toBe(true);

    const { bridge, token } = await startBridge(dir);
    expect(bridge.state()).toEqual({ kind: "waiting" });
    await roundTrip(bridge, await connectExtension(bridge, token));
  });

  it.skipIf(windows)("never removes a file at the socket path that is not a socket", async () => {
    const dir = await tempState();
    await privateFiles.ensureDirectory(dir);
    const socketPath = path.join(dir, "browser.sock");
    await writeFile(socketPath, "keep me");
    expect((await rejection(BrowserBridge.start({ stateDir: dir, privateFiles }))).code).toBe("CONFIG_ERROR");
    expect((await stat(socketPath)).isFile()).toBe(true);
    // The takeover lock was released.
    expect(await stat(socketPath + ".lock").catch(() => undefined)).toBeUndefined();
  });
});

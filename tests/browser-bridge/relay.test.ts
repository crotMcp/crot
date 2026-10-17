import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeEndpoint, generateBridgeToken, readBridgeToken } from "../../src/browser-bridge/endpoint.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  MAX_BROWSER_TO_HOST_FRAME_BYTES,
  MAX_HANDSHAKE_FRAME_BYTES,
  MAX_HOST_TO_BROWSER_FRAME_BYTES,
  MessageReader,
  encodeFrame,
  encodeMessage,
  parseHostMessage,
  type HostRequest,
} from "../../src/browser-bridge/protocol.js";
import { parseRelayArgs, runRelay } from "../../src/browser-bridge/relay.js";
import { BrowserBridge } from "../../src/browser-bridge/server.js";
import { CrotError } from "../../src/core/errors.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";

const windows = process.platform === "win32";
const privateFiles = createPrivateFileProtection(windows);
const BROWSER = { name: "Chrome", version: "130.0.0.0", extensionVersion: "0.1.0" };
const HELLO = { type: "hello", protocol: BRIDGE_PROTOCOL_VERSION, browser: BROWSER };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

async function tempState(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crot-relay-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "state");
}

const frame = (body: string | Uint8Array): Buffer =>
  Buffer.from(encodeFrame(typeof body === "string" ? Buffer.from(body, "utf8") : body));

function header(length: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(length, 0);
  return bytes;
}

const options = () => ({ timeoutMs: 5_000, signal: new AbortController().signal });

/** The browser side of the relay: its stdin and stdout. */
class Browser {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  private readonly chunks: Buffer[] = [];
  private readonly reader = new MessageReader(MAX_HOST_TO_BROWSER_FRAME_BYTES);
  private readonly queue: unknown[] = [];
  private decoding = true;

  /** Start reading stdout (immediately unless `paused`). */
  constructor(paused = false) {
    if (!paused) this.read();
  }

  read(): void {
    this.output.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
      // Framing tests carry bodies that are not JSON: those are only compared as bytes.
      if (this.decoding) {
        try {
          this.queue.push(...this.reader.push(chunk));
        } catch {
          this.decoding = false;
        }
      }
    });
  }

  get bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  send(message: unknown): void {
    this.input.write(encodeMessage(message, MAX_BROWSER_TO_HOST_FRAME_BYTES));
  }

  async next(timeoutMs = 5_000): Promise<unknown> {
    await waitFor(() => this.queue.length > 0, timeoutMs);
    return this.queue.shift();
  }

  async nextRequest(): Promise<HostRequest> {
    const message = parseHostMessage(await this.next());
    if (message.type !== "request") throw new Error("expected a request, got " + message.type);
    return message;
  }
}

function startRelay(stateDir: string, browser = new Browser()) {
  const logs: string[] = [];
  const exit = runRelay({
    stateDir,
    input: browser.input,
    output: browser.output,
    log: (message) => logs.push(message),
  });
  cleanups.push(async () => {
    browser.input.destroy();
    await exit;
  });
  return { browser, exit, logs };
}

async function startBridge() {
  const dir = await tempState();
  const logs: string[] = [];
  const bridge = await BrowserBridge.start({
    stateDir: dir,
    privateFiles,
    log: (message) => logs.push(message),
    handshakeTimeoutMs: 2_000,
  });
  cleanups.push(() => bridge.close());
  const token = await readBridgeToken(bridge.tokenFile);
  if (token === undefined) throw new Error("token file missing");
  return { bridge, dir, token, logs };
}

/** A state directory with a token and a raw server on its endpoint, playing the bridge. */
async function startFakeHost() {
  const dir = await tempState();
  await privateFiles.ensureDirectory(dir);
  const token = generateBridgeToken();
  await writeFile(path.join(dir, "browser-token"), token + "\n", { mode: 0o600 });
  const connections: net.Socket[] = [];
  const received: Buffer[] = [];
  let closed = 0;
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("close", () => closed++);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(bridgeEndpoint(dir, token).path, () => resolve());
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of connections) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const authFrame = Buffer.from(
    encodeMessage({ type: "auth", protocol: BRIDGE_PROTOCOL_VERSION, token }, MAX_HANDSHAKE_FRAME_BYTES),
  );
  return {
    dir,
    token,
    authFrame,
    received: () => Buffer.concat(received),
    closed: () => closed,
    /** The relay's connection, once it has sent its auth frame. */
    connection: async (): Promise<net.Socket> => {
      await waitFor(() => connections.length === 1 && Buffer.concat(received).length >= authFrame.length);
      return connections[0]!;
    },
  };
}

const same = (a: Buffer, b: Buffer) => Buffer.compare(a, b) === 0;

describe("parseRelayArgs", () => {
  const dir = path.resolve(os.tmpdir(), "crot-state");

  it("reads --state-dir and ignores the arguments added by the browser", () => {
    expect(parseRelayArgs(["--state-dir", dir, "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"])).toEqual({
      stateDir: dir,
    });
    expect(
      parseRelayArgs([
        "--state-dir=" + dir,
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        "--parent-window=1234",
      ]),
    ).toEqual({
      stateDir: dir,
    });
    expect(parseRelayArgs(["chrome-extension://abcdefghijklmnopabcdefghijklmnop/", "--state-dir", dir])).toEqual({
      stateDir: dir,
    });
  });

  it("requires exactly one absolute --state-dir", () => {
    const code = (args: string[]): string => {
      try {
        parseRelayArgs(args);
      } catch (error) {
        expect(error).toBeInstanceOf(CrotError);
        return (error as CrotError).code;
      }
      throw new Error("expected an error");
    };
    expect(code([])).toBe("CONFIG_ERROR");
    expect(code(["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"])).toBe("CONFIG_ERROR");
    expect(code(["--state-dir"])).toBe("CONFIG_ERROR");
    expect(code(["--state-dir="])).toBe("CONFIG_ERROR");
    expect(code(["--state-dir", "relative/state"])).toBe("CONFIG_ERROR");
    expect(code(["--state-dir", dir, "--state-dir=" + dir])).toBe("CONFIG_ERROR");
  });
});

describe("crot-browser-relay with the BrowserBridge", () => {
  it("carries the handshake, requests and responses between the browser and the bridge", async () => {
    const { bridge, dir, token, logs: bridgeLogs } = await startBridge();
    const { browser, exit, logs } = startRelay(dir);
    browser.send(HELLO);
    expect(await browser.next()).toEqual({
      type: "welcome",
      protocol: BRIDGE_PROTOCOL_VERSION,
      connectionId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(bridge.state()).toEqual({
      kind: "connected",
      browser: BROWSER,
      cdp: { available: false, reason: "not_probed" },
      connectionId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });

    const pending = bridge.request("tabs.close", { tabId: 7 }, options());
    const request = await browser.nextRequest();
    expect(request).toMatchObject({ type: "request", command: "tabs.close", params: { tabId: 7 } });
    browser.send({ type: "response", id: request.id, ok: true, result: { tabId: 7, closed: true } });
    expect(await pending).toEqual({ tabId: 7, closed: true });

    // The browser closes the port: the relay exits and the bridge waits for the next extension.
    browser.input.end();
    expect(await exit).toBe(0);
    await waitFor(() => bridge.state().kind === "waiting");
    expect([...logs, ...bridgeLogs].join("\n").includes(token)).toBe(false);
  });

  it("exits when the bridge closes and lets a new relay connect afterwards", async () => {
    const { bridge, dir } = await startBridge();
    const first = startRelay(dir);
    first.browser.send(HELLO);
    await first.browser.next();
    await bridge.close();
    expect(await first.exit).toBe(0);

    const restarted = await BrowserBridge.start({ stateDir: dir, privateFiles, handshakeTimeoutMs: 2_000 });
    cleanups.push(() => restarted.close());
    const second = startRelay(dir);
    second.browser.send(HELLO);
    expect(await second.browser.next()).toEqual({
      type: "welcome",
      protocol: BRIDGE_PROTOCOL_VERSION,
      connectionId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(restarted.state().kind).toBe("connected");
  });

  it("exits with an error when the bridge refuses the handshake", async () => {
    const { bridge, dir } = await startBridge();
    const { browser, exit, logs } = startRelay(dir);
    browser.send({ type: "response", id: "a", ok: true, result: 1 });
    expect(await exit).toBe(1);
    expect(browser.bytes.length).toBe(0);
    expect(logs.join("\n").includes("during the handshake")).toBe(true);
    expect(bridge.state()).toEqual({ kind: "waiting" });
  });

  it("exits with an error when CROT is not set up or not running", async () => {
    const missing = await tempState();
    const notSetUp = startRelay(missing);
    expect(await notSetUp.exit).toBe(1);
    expect(notSetUp.logs.join("\n").includes("not set up")).toBe(true);

    const invalid = await tempState();
    await privateFiles.ensureDirectory(invalid);
    await writeFile(path.join(invalid, "browser-token"), "short\n");
    const bad = startRelay(invalid);
    expect(await bad.exit).toBe(1);
    expect(bad.logs.join("\n")).toMatch(/browser-token .* is not valid/);

    // A token but nobody listening: no retry, an immediate error exit.
    const { bridge, dir, token } = await startBridge();
    await bridge.close();
    const notRunning = startRelay(dir);
    expect(await notRunning.exit).toBe(1);
    expect(notRunning.logs.join("\n").includes("No CROT instance is listening")).toBe(true);
    expect(notRunning.logs.join("\n").includes(token)).toBe(false);
    expect(notRunning.browser.bytes.length).toBe(0);
  });
});

describe("crot-browser-relay framing", () => {
  it("sends the auth frame first and forwards frames byte for byte without interpreting them", async () => {
    const host = await startFakeHost();
    const { browser, exit, logs } = startRelay(host.dir);
    const socket = await host.connection();
    expect(same(host.received(), host.authFrame)).toBe(true);

    // Browser -> host: frames split across writes and several frames per write; bodies need not be JSON.
    const toHost = Buffer.concat([
      frame("not json"),
      frame('{"type":"hello"}'),
      frame(new Uint8Array([0xff, 0x00, 0x01])),
    ]);
    browser.input.write(toHost.subarray(0, 3));
    browser.input.write(toHost.subarray(3, 15));
    browser.input.write(toHost.subarray(15));
    await waitFor(() => host.received().length === host.authFrame.length + toHost.length);
    expect(same(host.received(), Buffer.concat([host.authFrame, toHost]))).toBe(true);

    // Host -> browser, including a frame of exactly the 1 MiB limit.
    const toBrowser = Buffer.concat([
      frame("x"),
      frame("[1,2"),
      frame(Buffer.alloc(MAX_HOST_TO_BROWSER_FRAME_BYTES, 0x61)),
    ]);
    socket.write(toBrowser.subarray(0, 2));
    socket.write(toBrowser.subarray(2, 11));
    socket.write(toBrowser.subarray(11));
    await waitFor(() => browser.bytes.length === toBrowser.length);
    expect(same(browser.bytes, toBrowser)).toBe(true);

    socket.end();
    expect(await exit).toBe(0);
    expect(logs.join("\n").includes(host.token)).toBe(false);
  });

  it("applies backpressure without losing frames when the browser reads slowly", async () => {
    const host = await startFakeHost();
    const browser = new Browser(true);
    const { exit } = startRelay(host.dir, browser);
    const socket = await host.connection();
    const toBrowser = Buffer.concat(
      [1, 2, 3].map((n) => frame(Buffer.alloc(MAX_HOST_TO_BROWSER_FRAME_BYTES, 0x60 + n))),
    );
    socket.write(toBrowser);
    await sleep(100);
    browser.read();
    await waitFor(() => browser.bytes.length === toBrowser.length);
    expect(same(browser.bytes, toBrowser)).toBe(true);
    browser.input.end();
    expect(await exit).toBe(0);
  });

  it("refuses empty and oversized frames from the browser without forwarding them", async () => {
    for (const bad of [header(0), header(MAX_BROWSER_TO_HOST_FRAME_BYTES + 1)]) {
      const host = await startFakeHost();
      const { browser, exit, logs } = startRelay(host.dir);
      await host.connection();
      browser.input.write(Buffer.concat([frame("ok"), bad, Buffer.from("payload")]));
      expect(await exit).toBe(1);
      expect(logs.join("\n").includes("Invalid frame from the browser")).toBe(true);
      await waitFor(() => host.closed() === 1);
      // A chunk containing a bad frame is refused as a whole; nothing after the auth frame was forwarded.
      expect(same(host.received(), host.authFrame)).toBe(true);
    }
  });

  it("refuses empty and oversized frames from CROT without forwarding them", async () => {
    for (const bad of [header(0), header(MAX_HOST_TO_BROWSER_FRAME_BYTES + 1)]) {
      const host = await startFakeHost();
      const { browser, exit, logs } = startRelay(host.dir);
      const socket = await host.connection();
      socket.write(Buffer.concat([frame("ok"), bad, Buffer.from("payload")]));
      expect(await exit).toBe(1);
      expect(logs.join("\n").includes("Invalid frame from CROT")).toBe(true);
      // The valid frame is forwarded only if it arrived in an earlier chunk than the bad one; the bad frame never is.
      expect(browser.bytes.length === 0 || same(browser.bytes, frame("ok"))).toBe(true);
      await waitFor(() => host.closed() === 1);
    }
  });

  it("exits with an error on a truncated frame from either side", async () => {
    const fromBrowser = await startFakeHost();
    const one = startRelay(fromBrowser.dir);
    await fromBrowser.connection();
    one.browser.input.end(frame("truncated").subarray(0, 6));
    expect(await one.exit).toBe(1);
    expect(same(fromBrowser.received(), fromBrowser.authFrame)).toBe(true);

    const fromHost = await startFakeHost();
    const two = startRelay(fromHost.dir);
    const socket = await fromHost.connection();
    socket.end(Buffer.concat([frame("ok"), frame("truncated").subarray(0, 6)]));
    expect(await two.exit).toBe(1);
    expect(same(two.browser.bytes, frame("ok"))).toBe(true);
  });
});

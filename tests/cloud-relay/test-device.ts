/**
 * A test device for the Cloud Relay (WP-29): the device side of the AD-22
 * tunnel at protocol level, with knobs to misbehave. It is a test fixture,
 * not the WP-30 adapter.
 */
import type { KeyObject } from "node:crypto";
import { request as httpRequest } from "node:http";
import { signTunnelProof } from "../../src/identity/device-credential.js";
import {
  decodeFrame,
  encodeFrame,
  encodeJsonFrame,
  encodeWindow,
  FLAG_END_STREAM,
  FrameType,
  INITIAL_CONNECTION_WINDOW,
  INITIAL_STREAM_WINDOW,
  MAX_DATA_PAYLOAD,
  MAX_FRAME_BYTES,
  parseJsonPayload,
  TUNNEL_PATH,
  type Frame,
  type HeaderList,
} from "../../src/tunnel/protocol.js";
import { connectWebSocket, type WebSocketConnection } from "../../src/tunnel/websocket.js";

export interface OpenRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: HeaderList;
  readonly deadlineMs: number;
}

export class DeviceStream {
  readonly chunks: Buffer[] = [];
  bodyEnded = false;
  resetCode: string | undefined;
  sendWindow = INITIAL_STREAM_WINDOW;
  private bodyWaiters: (() => void)[] = [];
  private resetWaiters: ((code: string) => void)[] = [];
  private windowWaiters: (() => void)[] = [];

  constructor(
    readonly device: TestDevice,
    readonly id: number,
    readonly head: OpenRequest,
  ) {}

  header(name: string): string | undefined {
    return this.head.headers.find(([n]) => n === name)?.[1];
  }

  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Resolves with the request body once END_STREAM arrived. */
  bodyDone(): Promise<Buffer> {
    if (this.bodyEnded) return Promise.resolve(this.body);
    return new Promise((r) => this.bodyWaiters.push(() => r(this.body)));
  }

  /** Resolves with the RESET code the relay sent. */
  reset(): Promise<string> {
    if (this.resetCode) return Promise.resolve(this.resetCode);
    return new Promise((r) => this.resetWaiters.push(r));
  }

  respond(status: number, headers: [string, string][] = [], end = false): void {
    this.device.send(encodeJsonFrame(FrameType.RESPONSE, this.id, { status, headers }, end ? FLAG_END_STREAM : 0));
  }

  /** Send body bytes within the relay's windows (waits for credit). */
  async write(data: Buffer, end = false): Promise<void> {
    let offset = 0;
    while (offset < data.length) {
      if (this.resetCode) return;
      const n = Math.min(MAX_DATA_PAYLOAD, this.sendWindow, this.device.sendConnWindow, data.length - offset);
      if (n <= 0) {
        await new Promise<void>((r) => this.windowWaiters.push(r));
        continue;
      }
      this.sendWindow -= n;
      this.device.sendConnWindow -= n;
      const last = end && offset + n === data.length;
      this.device.send(
        encodeFrame(FrameType.DATA, this.id, data.subarray(offset, offset + n), last ? FLAG_END_STREAM : 0),
      );
      offset += n;
    }
    if (end && data.length === 0)
      this.device.send(encodeFrame(FrameType.DATA, this.id, Buffer.alloc(0), FLAG_END_STREAM));
  }

  sendReset(code: string): void {
    this.device.send(encodeJsonFrame(FrameType.RESET, this.id, { code }));
  }

  /** @internal */
  onData(frame: Frame): void {
    this.chunks.push(Buffer.from(frame.payload));
    if ((frame.flags & FLAG_END_STREAM) !== 0) this.endBody();
  }
  /** @internal */
  endBody(): void {
    this.bodyEnded = true;
    for (const w of this.bodyWaiters.splice(0)) w();
  }
  /** @internal */
  onReset(code: string): void {
    this.resetCode = code;
    for (const w of this.resetWaiters.splice(0)) w(code);
    this.wake();
  }
  /** @internal */
  wake(): void {
    for (const w of this.windowWaiters.splice(0)) w();
  }
}

export interface TestDeviceOptions {
  readonly url: string;
  readonly deviceId: string;
  readonly key: KeyObject;
  readonly relayHost: string;
  readonly protocols?: readonly string[];
  readonly maxStreams?: number;
  /** Return credit for request bytes at once (default true). */
  readonly autoCredit?: boolean;
  /** Answer PING (default true). */
  readonly autoPong?: boolean;
  /** Sign for this relay host instead of the CHALLENGE's (wrong-host tests). */
  readonly signHost?: string;
  /** Do not send HELLO (handshake timeout tests). */
  readonly noHello?: boolean;
  readonly software?: string;
  readonly onOpen?: (stream: DeviceStream) => void;
}

export class TestDevice {
  readonly frames: Frame[] = [];
  readonly streams = new Map<number, DeviceStream>();
  readonly opened: DeviceStream[] = [];
  sendConnWindow = INITIAL_CONNECTION_WINDOW;
  ready: Record<string, unknown> | undefined;
  challenge: Record<string, unknown> | undefined;
  closed: { code: number; reason: string } | undefined;
  private readonly closeWaiters: ((c: { code: number; reason: string }) => void)[] = [];
  private readonly frameWaiters: { type: number; resolve: (f: Frame) => void }[] = [];
  private readonly openWaiters: ((s: DeviceStream) => void)[] = [];
  private readyResolve: ((v: Record<string, unknown>) => void) | undefined;
  readonly readyPromise: Promise<Record<string, unknown>>;
  onOpen: ((stream: DeviceStream) => void) | undefined;

  private constructor(
    readonly ws: WebSocketConnection,
    private readonly options: TestDeviceOptions,
  ) {
    this.onOpen = options.onOpen;
    this.readyPromise = new Promise((r) => (this.readyResolve = r));
    ws.attach({
      onMessage: (data, binary) => this.onMessage(data, binary),
      onClose: (code, reason) => {
        this.closed = { code, reason };
        for (const w of this.closeWaiters.splice(0)) w(this.closed);
      },
    });
  }

  static async connect(options: TestDeviceOptions): Promise<TestDevice> {
    const ws = await connectWebSocket(options.url.replace(/^http/, "ws") + TUNNEL_PATH, {
      protocols: options.protocols ?? ["crot-tunnel.v1"],
      maxMessageBytes: MAX_FRAME_BYTES * 4,
    });
    return new TestDevice(ws, options);
  }

  /** Connect and wait for READY. */
  static async online(options: TestDeviceOptions): Promise<TestDevice> {
    const device = await TestDevice.connect(options);
    await Promise.race([
      device.readyPromise,
      device.whenClosed().then((c) => {
        throw new Error(`tunnel closed ${c.code} ${c.reason}`);
      }),
    ]);
    return device;
  }

  send(frame: Buffer): void {
    this.ws.send(frame);
  }

  whenClosed(): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((r) => this.closeWaiters.push(r));
  }

  /** The next frame of a type (or one already received). */
  frame(type: number): Promise<Frame> {
    const seen = this.frames.find((f) => f.type === type);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.frameWaiters.push({ type, resolve }));
  }

  nextOpen(): Promise<DeviceStream> {
    return new Promise((r) => this.openWaiters.push(r));
  }

  close(code = 1000): void {
    this.ws.close(code);
  }

  goAway(code: string, lastStream?: number): void {
    const last = lastStream ?? Math.max(0, ...this.streams.keys());
    this.send(encodeJsonFrame(FrameType.GOAWAY, 0, { lastStream: last, code }));
  }

  /** Forward every stream to a local HTTP server (stand-in for the WP-30 adapter's HTTP pipeline). */
  proxyTo(origin: string, rewrite: { readonly path: string; readonly host: string }): void {
    this.onOpen = (stream) => {
      const headers: [string, string][] = stream.head.headers.map(([n, v]) => [n, n === "host" ? rewrite.host : v]);
      const flat = headers.flat();
      const u = new URL(origin);
      const req = httpRequest({
        host: u.hostname,
        port: u.port,
        method: stream.head.method,
        path: rewrite.path,
        headers: flat,
      });
      req.on("response", (res) => {
        const out: [string, string][] = [];
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          const name = res.rawHeaders[i]!.toLowerCase();
          if (["connection", "keep-alive", "transfer-encoding"].includes(name)) continue;
          out.push([name, res.rawHeaders[i + 1]!]);
        }
        stream.respond(res.statusCode ?? 502, out);
        res.on("data", (chunk: Buffer) => {
          res.pause();
          stream.write(chunk).then(() => res.resume());
        });
        res.on("end", () => void stream.write(Buffer.alloc(0), true));
      });
      req.on("error", () => stream.sendReset("internal_error"));
      void stream.reset().then(() => req.destroy());
      const pump = async () => {
        let sent = 0;
        for (;;) {
          while (sent < stream.chunks.length) req.write(stream.chunks[sent++]!);
          if (stream.bodyEnded) break;
          await new Promise((r) => setTimeout(r, 5));
        }
        req.end();
      };
      void pump();
    };
  }

  private onMessage(data: Buffer, binary: boolean): void {
    if (!binary) return;
    const frame = decodeFrame(data);
    this.frames.push(frame);
    for (const w of [...this.frameWaiters])
      if (w.type === frame.type) {
        this.frameWaiters.splice(this.frameWaiters.indexOf(w), 1);
        w.resolve(frame);
      }
    switch (frame.type) {
      case FrameType.CHALLENGE: {
        const c = parseJsonPayload(frame.payload);
        this.challenge = c;
        if (this.options.noHello) return;
        const proof = signTunnelProof(
          this.options.key,
          this.options.deviceId,
          this.options.signHost ?? String(c.relayHost),
          Buffer.from(String(c.challenge), "base64url"),
        );
        this.send(
          encodeJsonFrame(FrameType.HELLO, 0, {
            deviceId: this.options.deviceId,
            proof: proof.toString("base64url"),
            software: this.options.software ?? "crot-test/0.1.0",
            maxStreams: this.options.maxStreams ?? 48,
            features: [],
          }),
        );
        return;
      }
      case FrameType.READY:
        this.ready = parseJsonPayload(frame.payload);
        this.readyResolve?.(this.ready);
        return;
      case FrameType.OPEN: {
        const head = parseJsonPayload(frame.payload) as unknown as OpenRequest;
        const stream = new DeviceStream(this, frame.stream, head);
        this.streams.set(frame.stream, stream);
        this.opened.push(stream);
        if ((frame.flags & FLAG_END_STREAM) !== 0) stream.endBody();
        this.onOpen?.(stream);
        for (const w of this.openWaiters.splice(0)) w(stream);
        return;
      }
      case FrameType.DATA: {
        const s = this.streams.get(frame.stream);
        if (!s) return;
        s.onData(frame);
        if (this.options.autoCredit !== false && frame.payload.length > 0)
          this.credit(frame.stream, frame.payload.length);
        return;
      }
      case FrameType.RESET:
        this.streams.get(frame.stream)?.onReset(String(parseJsonPayload(frame.payload).code));
        return;
      case FrameType.WINDOW: {
        const inc = frame.payload.readUInt32BE(0);
        if (frame.stream === 0) {
          this.sendConnWindow += inc;
          for (const s of this.streams.values()) s.wake();
        } else {
          const s = this.streams.get(frame.stream);
          if (s) {
            s.sendWindow += inc;
            s.wake();
          }
        }
        return;
      }
      case FrameType.PING:
        if (this.options.autoPong !== false) this.send(encodeFrame(FrameType.PONG, 0, frame.payload));
        return;
      default:
        return;
    }
  }

  /** Return credit for request bytes (stream and connection). */
  credit(stream: number, n: number): void {
    this.send(encodeWindow(stream, n));
    this.send(encodeWindow(0, n));
  }
}

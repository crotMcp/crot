/**
 * Authenticated local channel of the CROT service (WP-20, AD-17).
 *
 * Used by both service endpoints: the shim channel (stdio MCP) and the
 * control channel. Frames are the bridge framing (4-byte little-endian length
 * + UTF-8 JSON). The credential itself is never sent.
 *
 * Handshake (label = "crot-service-v1" or "crot-control-v1", K = credential):
 *   server -> { t: "challenge", v: 1, c: label, n: S }          S: 32 random bytes
 *   client -> { t: "auth", n: C, p: HMAC(K, label|client|S|C) }  C: 32 random bytes
 *   server -> { t: "ok", p: HMAC(K, label|server|S|C) }  or { t: "denied" } and close
 * The server verifies the client proof in constant time; the client verifies
 * the server proof, so both sides know the peer holds K. A captured
 * handshake cannot be replayed: every connection gets a fresh S (and C).
 *
 * After the handshake every message is
 *   { t: "m", s: seq, b: "<JSON>", h: HMAC(KS, dir|seq|b) },  KS = HMAC(K, label|session|S|C)
 * with a per-direction sequence number that must be exactly the previous one
 * plus one. A replayed, reordered, tampered or foreign (other connection)
 * frame fails the check and closes the connection.
 *
 * The channel authenticates the peer as "a process of the CROT user that can
 * read the credential"; it makes no permission decision.
 */
import { createHmac, randomBytes } from "node:crypto";
import net from "node:net";
import { BrowserProtocolError, encodeFrame, FrameReader } from "../browser-bridge/protocol.js";
import { constantTimeEqual, type ServiceChannel } from "./endpoints.js";

export const CHANNEL_PROTOCOL_VERSION = 1;
export const CHANNEL_HANDSHAKE_TIMEOUT_MS = 5_000;
export const MAX_CHANNEL_HANDSHAKE_FRAME_BYTES = 4096;
/** Shim -> service: one stdio MCP line is at most 10 MiB (SDK read buffer); JSON escaping adds overhead. */
export const MAX_CLIENT_FRAME_BYTES = 32 * 1024 * 1024;
/** Service -> shim: results can carry screenshots and file contents. */
export const MAX_SERVER_FRAME_BYTES = 128 * 1024 * 1024;

const NONCE = /^[A-Za-z0-9_-]{43}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function channelLabel(channel: ServiceChannel): string {
  return `crot-${channel}-v${CHANNEL_PROTOCOL_VERSION}`;
}

/** Why a channel failed: reported to callers, never containing the credential. */
export class ChannelError extends Error {
  constructor(
    readonly reason: "unauthenticated" | "protocol" | "timeout" | "closed" | "unreachable",
    message: string,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

const hmac = (key: Buffer | string, text: string) => createHmac("sha256", key).update(text, "utf8").digest();
const b64 = (bytes: Buffer) => bytes.toString("base64url");
const proof = (credential: string, label: string, role: "client" | "server", s: string, c: string) =>
  b64(hmac(credential, `${label}\n${role}\n${s}\n${c}`));
const sessionKey = (credential: string, label: string, s: string, c: string) =>
  hmac(credential, `${label}\nsession\n${s}\n${c}`);

function frame(message: unknown): Uint8Array {
  return encodeFrame(utf8.encode(JSON.stringify(message)));
}

function decode(body: Uint8Array): unknown {
  try {
    return JSON.parse(strictUtf8.decode(body)) as unknown;
  } catch {
    throw new ChannelError("protocol", "Invalid frame.");
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * One authenticated connection. Messages are JSON values; `onmessage` receives
 * them in order. Any integrity failure closes the channel.
 */
export class AuthenticatedChannel {
  onmessage?: (message: unknown) => void;
  onclose?: (error?: ChannelError) => void;
  private sendSeq = 0;
  private recvSeq = 0;
  private closed = false;

  constructor(
    private readonly socket: net.Socket,
    private readonly reader: FrameReader,
    private readonly key: Buffer,
    private readonly role: "client" | "server",
    private buffered: Uint8Array[],
  ) {
    socket.on("error", () => this.fail(new ChannelError("closed", "Connection error.")));
    socket.on("close", () => this.fail(undefined));
  }

  private started = false;
  private paused = false;

  /** Start delivering messages (after onmessage/onclose are set). The socket is paused until then. */
  start(): void {
    if (this.started) return this.resume();
    this.started = true;
    this.socket.on("data", (chunk: Buffer) => this.receive(chunk));
    this.resume();
  }

  /** Hold further messages (they are queued, in order) until resume(). */
  pause(): void {
    this.paused = true;
    this.socket.pause();
  }

  resume(): void {
    this.paused = false;
    // Frames that arrived together with the end of the handshake or while paused.
    while (!this.paused && !this.closed && this.buffered.length > 0) this.handle(this.buffered.shift()!);
    if (!this.paused && !this.closed) this.socket.resume();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Send one message. Returns false when the socket buffer is full (backpressure). */
  send(message: unknown): boolean {
    if (this.closed) return false;
    const body = JSON.stringify(message);
    const seq = ++this.sendSeq;
    const dir = this.role === "client" ? "c" : "s";
    const h = b64(hmac(this.key, `${dir}\n${seq}\n${body}`));
    return this.socket.write(frame({ t: "m", s: seq, b: body, h }));
  }

  /** Wait until the socket accepts more data. */
  drained(): Promise<void> {
    if (this.closed || !this.socket.writableNeedDrain) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.socket.off("drain", done);
        this.socket.off("close", done);
        resolve();
      };
      this.socket.once("drain", done);
      this.socket.once("close", done);
    });
  }

  /** Flush what was sent and close. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        resolve();
      }, 1_000);
      timer.unref();
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.end();
    });
  }

  destroy(): void {
    this.socket.destroy();
    this.fail(undefined);
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    let bodies: Uint8Array[];
    try {
      bodies = this.reader.push(chunk);
    } catch (error) {
      return this.violation(error instanceof BrowserProtocolError ? error.message : "Invalid frame.");
    }
    for (const body of bodies) {
      if (this.closed) return;
      if (this.paused) this.buffered.push(body);
      else this.handle(body);
    }
  }

  private handle(body: Uint8Array): void {
    if (this.closed) return;
    let value: unknown;
    try {
      value = decode(body);
    } catch {
      return this.violation("Invalid frame.");
    }
    if (
      !isRecord(value) ||
      value.t !== "m" ||
      typeof value.s !== "number" ||
      typeof value.b !== "string" ||
      typeof value.h !== "string"
    )
      return this.violation("Unexpected frame.");
    if (value.s !== this.recvSeq + 1) return this.violation("Out-of-sequence or replayed frame.");
    const dir = this.role === "client" ? "s" : "c";
    const expected = hmac(this.key, `${dir}\n${value.s}\n${value.b}`);
    if (!constantTimeEqual(expected, Buffer.from(value.h, "base64url")))
      return this.violation("Frame integrity check failed.");
    this.recvSeq = value.s;
    let message: unknown;
    try {
      message = JSON.parse(value.b) as unknown;
    } catch {
      return this.violation("Invalid message.");
    }
    this.onmessage?.(message);
  }

  private violation(message: string): void {
    this.socket.destroy();
    this.fail(new ChannelError("protocol", message));
  }

  private fail(error: ChannelError | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(error);
  }
}

interface HandshakeOptions {
  readonly channel: ServiceChannel;
  readonly credential: string;
  readonly timeoutMs?: number;
  /** Largest frame accepted from the peer after the handshake. */
  readonly maxFrameBytes: number;
}

/** Read handshake frames until `step` returns a result; fails on timeout, close or oversized frames. */
function handshakeReader(socket: net.Socket, timeoutMs: number) {
  const reader = new FrameReader(MAX_CHANNEL_HANDSHAKE_FRAME_BYTES);
  const queue: Uint8Array[] = [];
  let waiter: ((body: Uint8Array | ChannelError) => void) | undefined;
  let failure: ChannelError | undefined;
  const fail = (error: ChannelError) => {
    failure ??= error;
    waiter?.(failure);
  };
  const onData = (chunk: Buffer) => {
    try {
      for (const body of reader.push(chunk)) queue.push(body);
    } catch {
      return fail(new ChannelError("protocol", "Invalid handshake frame."));
    }
    if (waiter && queue.length > 0) waiter(queue.shift()!);
  };
  const onClose = () => fail(new ChannelError("closed", "The peer closed the connection during the handshake."));
  socket.on("data", onData);
  socket.on("close", onClose);
  socket.on("error", onClose);
  const timer = setTimeout(() => fail(new ChannelError("timeout", "Handshake timed out.")), timeoutMs);
  timer.unref();
  return {
    reader,
    next(): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const take = (item: Uint8Array | ChannelError) => {
          waiter = undefined;
          if (item instanceof ChannelError) return reject(item);
          try {
            const value = decode(item);
            if (!isRecord(value)) throw new ChannelError("protocol", "Unexpected handshake frame.");
            resolve(value);
          } catch (error) {
            reject(error instanceof ChannelError ? error : new ChannelError("protocol", "Invalid handshake frame."));
          }
        };
        if (failure) return take(failure);
        if (queue.length > 0) return take(queue.shift()!);
        waiter = take;
      });
    },
    /** Stop handshake handling; returns frames already received after the last handshake frame. */
    finish(): Uint8Array[] {
      clearTimeout(timer);
      socket.pause();
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onClose);
      return queue.splice(0);
    },
  };
}

/**
 * Server side: authenticate a freshly accepted connection. Resolves with the
 * channel, rejects with ChannelError (the socket is then destroyed).
 */
export async function acceptChannel(socket: net.Socket, options: HandshakeOptions): Promise<AuthenticatedChannel> {
  const label = channelLabel(options.channel);
  const hs = handshakeReader(socket, options.timeoutMs ?? CHANNEL_HANDSHAKE_TIMEOUT_MS);
  try {
    const s = b64(randomBytes(32));
    socket.write(frame({ t: "challenge", v: CHANNEL_PROTOCOL_VERSION, c: label, n: s }));
    const auth = await hs.next();
    const c = auth.n;
    const p = auth.p;
    if (auth.t !== "auth" || typeof c !== "string" || !NONCE.test(c) || typeof p !== "string" || !PROOF.test(p)) {
      throw new ChannelError("unauthenticated", "The peer did not authenticate.");
    }
    const expected = Buffer.from(proof(options.credential, label, "client", s, c), "base64url");
    if (!constantTimeEqual(expected, Buffer.from(p, "base64url"))) {
      socket.write(frame({ t: "denied" }));
      throw new ChannelError("unauthenticated", "The peer presented an invalid credential proof.");
    }
    socket.write(frame({ t: "ok", p: proof(options.credential, label, "server", s, c) }));
    const buffered = hs.finish();
    hs.reader.maxFrameBytes = options.maxFrameBytes;
    return new AuthenticatedChannel(socket, hs.reader, sessionKey(options.credential, label, s, c), "server", buffered);
  } catch (error) {
    hs.finish();
    socket.end();
    setTimeout(() => socket.destroy(), 200).unref();
    throw error instanceof ChannelError ? error : new ChannelError("protocol", "Handshake failed.");
  }
}

/** Client side: connect to an endpoint and authenticate. */
export function connectChannel(endpointPath: string, options: HandshakeOptions): Promise<AuthenticatedChannel> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpointPath);
    const onConnectError = (error: NodeJS.ErrnoException) =>
      reject(
        Object.assign(new ChannelError("unreachable", `Cannot connect: ${error.code ?? error.message}`), {
          code: error.code,
        }),
      );
    socket.once("error", onConnectError);
    socket.once("connect", () => {
      socket.off("error", onConnectError);
      clientHandshake(socket, options).then(resolve, (error: unknown) => {
        socket.destroy();
        reject(error);
      });
    });
  });
}

/** Client handshake on an already connected socket (exported for tests). */
export async function clientHandshake(socket: net.Socket, options: HandshakeOptions): Promise<AuthenticatedChannel> {
  const label = channelLabel(options.channel);
  const hs = handshakeReader(socket, options.timeoutMs ?? CHANNEL_HANDSHAKE_TIMEOUT_MS);
  try {
    const challenge = await hs.next();
    const s = challenge.n;
    if (challenge.t !== "challenge" || challenge.c !== label || typeof s !== "string" || !NONCE.test(s))
      throw new ChannelError("protocol", "The endpoint is not a CROT " + options.channel + " endpoint.");
    const c = b64(randomBytes(32));
    socket.write(frame({ t: "auth", n: c, p: proof(options.credential, label, "client", s, c) }));
    const answer = await hs.next();
    if (answer.t === "denied") throw new ChannelError("unauthenticated", "The CROT service rejected the credential.");
    const p = answer.p;
    if (answer.t !== "ok" || typeof p !== "string" || !PROOF.test(p))
      throw new ChannelError("protocol", "Unexpected handshake answer.");
    const expected = Buffer.from(proof(options.credential, label, "server", s, c), "base64url");
    if (!constantTimeEqual(expected, Buffer.from(p, "base64url")))
      throw new ChannelError("unauthenticated", "The endpoint could not prove the CROT credential.");
    const buffered = hs.finish();
    hs.reader.maxFrameBytes = options.maxFrameBytes;
    return new AuthenticatedChannel(socket, hs.reader, sessionKey(options.credential, label, s, c), "client", buffered);
  } catch (error) {
    hs.finish();
    throw error instanceof ChannelError ? error : new ChannelError("protocol", "Handshake failed.");
  }
}

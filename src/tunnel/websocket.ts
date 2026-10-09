/**
 * A minimal RFC 6455 WebSocket endpoint for the relay–device tunnel
 * (ARCHITECTURE.md §27 AD-22 point 2).
 *
 * Only what the tunnel needs: binary and text messages (text is reported so
 * the tunnel can treat it as a protocol error), fragmentation, ping/pong,
 * close. No extensions are ever negotiated (`permessage-deflate` offers are
 * ignored), so RSV bits are a protocol error. Messages are bounded by
 * `maxMessageBytes` before they are buffered. The server side requires
 * masked frames, the client side unmasked ones (RFC 6455 section 5.1).
 *
 * Memory a peer can make one connection retain is bounded independently of
 * how it sends: received bytes are queued as received and copied once per
 * complete frame (no re-copy per TCP segment), the fragments of a message
 * are copied into one buffer of at most `maxMessageBytes` (no per-fragment
 * objects, so any number of empty fragments costs nothing), and pongs are
 * not queued behind an output backlog the peer does not read (only the
 * most recent ping is answered then, RFC 6455 section 5.5.3). This holds
 * before the tunnel handshake, when the peer is not yet authenticated.
 *
 * The server side is used by the Cloud Relay (WP-29). The client side exists
 * for tests on every supported Node version (the built-in WebSocket client
 * starts with Node 22); the device adapter is WP-30.
 */
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export const WS_PROTOCOL_ERROR = 1002;
export const WS_TOO_BIG = 1009;
/** Output backlog above which pongs wait for `drain` (only the latest ping is answered). */
export const CONTROL_BACKLOG_BYTES = 64 * 1024;

export function acceptKey(key: string): string {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

export interface WebSocketHandlers {
  onMessage(data: Buffer, binary: boolean): void;
  /** A message exceeded `maxMessageBytes`; when given, the handler closes the connection (else close 1009). */
  onTooLarge?(): void;
  /** Called once, when the TCP connection is gone. `code` 1006 when no close frame was received. */
  onClose(code: number, reason: string): void;
}

export class WebSocketConnection {
  /** Received bytes not yet parsed, in arrival order. */
  private input: Buffer[] = [];
  private inputBytes = 0;
  /** The fragments of the current message, copied into one buffer (grown up to `maxMessageBytes`). */
  private fragment: Buffer | undefined;
  private fragmentBytes = 0;
  private fragmentBinary = false;
  private fragmenting = false;
  /** Payload of the latest ping not answered yet because of an output backlog. */
  private pendingPong: Buffer | undefined;
  private closeSent = false;
  private closed = false;
  private failed = false;
  private receivedClose: { code: number; reason: string } | undefined;
  private handlers: WebSocketHandlers | undefined;
  private pending: Buffer[] = [];

  constructor(
    private readonly socket: Duplex,
    private readonly role: "server" | "client",
    private readonly maxMessageBytes: number,
    readonly protocol: string | undefined,
    head: Buffer = Buffer.alloc(0),
  ) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => this.finish());
    // HTTP servers create half-open sockets: the peer's FIN ends the connection.
    socket.on("end", () => this.socket.destroy());
    socket.on("error", () => this.socket.destroy());
    socket.on("drain", () => this.flushPong());
    if (head.length > 0) this.pending.push(head);
  }

  /** Start delivering messages (frames received before are kept). */
  attach(handlers: WebSocketHandlers): void {
    this.handlers = handlers;
    for (const chunk of this.pending.splice(0)) this.receive(chunk);
    if (this.closed) handlers.onClose(this.receivedClose?.code ?? 1006, this.receivedClose?.reason ?? "");
  }

  get isOpen(): boolean {
    return !this.closed && !this.closeSent;
  }

  /** Bytes queued in the socket (backpressure indicator). */
  get bufferedAmount(): number {
    return (this.socket as unknown as { writableLength?: number }).writableLength ?? 0;
  }

  /** Bytes retained for incomplete frames and messages (at most `maxMessageBytes` plus one frame). */
  get retainedBytes(): number {
    return this.inputBytes + (this.fragment?.length ?? 0);
  }

  send(data: Buffer): boolean {
    if (!this.isOpen) return false;
    return this.write(OP_BINARY, data);
  }

  sendText(text: string): boolean {
    if (!this.isOpen) return false;
    return this.write(OP_TEXT, Buffer.from(text, "utf8"));
  }

  ping(data: Buffer = Buffer.alloc(0)): void {
    if (this.isOpen) this.write(OP_PING, data);
  }

  /** Send a close frame and end the connection after a short grace period. */
  close(code = 1000, reason = ""): void {
    if (this.closed || this.closeSent) return;
    this.closeSent = true;
    let r = Buffer.from(reason, "utf8");
    if (r.length > 123) r = r.subarray(0, 123);
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this.write(OP_CLOSE, payload);
    if (this.role === "server" || this.receivedClose) this.socket.end();
    const timer = setTimeout(() => this.socket.destroy(), 2_000);
    timer.unref();
  }

  /** Drop the connection without a close handshake. */
  terminate(): void {
    this.socket.destroy();
  }

  private write(opcode: number, payload: Buffer): boolean {
    const masked = this.role === "client";
    const len = payload.length;
    const lenBytes = len < 126 ? 0 : len < 65536 ? 2 : 8;
    const header = Buffer.alloc(2 + lenBytes + (masked ? 4 : 0));
    header[0] = 0x80 | opcode;
    header[1] = (masked ? 0x80 : 0) | (lenBytes === 0 ? len : lenBytes === 2 ? 126 : 127);
    if (lenBytes === 2) header.writeUInt16BE(len, 2);
    else if (lenBytes === 8) header.writeBigUInt64BE(BigInt(len), 2);
    let body = payload;
    if (masked) {
      const mask = randomBytes(4);
      mask.copy(header, 2 + lenBytes);
      body = Buffer.alloc(len);
      for (let i = 0; i < len; i++) body[i] = payload[i]! ^ mask[i & 3]!;
    }
    return this.socket.write(Buffer.concat([header, body]));
  }

  /** Stop parsing and close; the socket is ended after the close frame (destroyed after a grace period). */
  private fail(code: number): void {
    this.failed = true;
    this.input = [];
    this.inputBytes = 0;
    this.fragment = undefined;
    if (code === WS_TOO_BIG && this.handlers?.onTooLarge) this.handlers.onTooLarge();
    this.close(code, "");
    if (this.role === "client") this.socket.end();
  }

  /** The first `n` queued input bytes as one buffer (coalesces only when they span chunks). */
  private peek(n: number): Buffer {
    if (this.input[0]!.length < n) this.input = [Buffer.concat(this.input, this.inputBytes)];
    return this.input[0]!;
  }

  /** Remove `n` queued input bytes. */
  private consume(n: number): void {
    this.inputBytes -= n;
    while (n > 0) {
      const first = this.input[0]!;
      if (first.length <= n) {
        this.input.shift();
        n -= first.length;
      } else {
        this.input[0] = first.subarray(n);
        n = 0;
      }
    }
  }

  private receive(chunk: Buffer): void {
    if (this.closed || this.failed) return;
    if (!this.handlers) {
      this.pending.push(chunk);
      return;
    }
    if (chunk.length === 0) return;
    this.input.push(chunk);
    this.inputBytes += chunk.length;
    for (;;) {
      if (this.closed || this.failed || this.socket.destroyed) return;
      if (this.inputBytes < 2) return;
      let b = this.peek(2);
      const fin = (b[0]! & 0x80) !== 0;
      const rsv = b[0]! & 0x70;
      const opcode = b[0]! & 0x0f;
      const masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f;
      let offset = 2;
      if (rsv !== 0) return this.fail(WS_PROTOCOL_ERROR);
      if (masked !== (this.role === "server")) return this.fail(WS_PROTOCOL_ERROR);
      if (len === 126) {
        if (this.inputBytes < 4) return;
        b = this.peek(4);
        len = b.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.inputBytes < 10) return;
        b = this.peek(10);
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessageBytes)) return this.fail(WS_TOO_BIG);
        len = Number(big);
        offset = 10;
      }
      const control = opcode >= 0x8;
      if (control && (len > 125 || !fin)) return this.fail(WS_PROTOCOL_ERROR);
      if (!control && this.fragmentBytes + len > this.maxMessageBytes) return this.fail(WS_TOO_BIG);
      const maskBytes = masked ? 4 : 0;
      const total = offset + maskBytes + len;
      // Wait for the whole frame without copying (bounded: the frame fits the message limit).
      if (this.inputBytes < total) return;
      b = this.peek(total);
      const payload = Buffer.from(b.subarray(offset + maskBytes, total));
      if (masked) {
        const mask = b.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
      }
      this.consume(total);
      if (!this.frame(fin, opcode, payload)) return;
    }
  }

  /** Append a fragment to the message buffer (grown by doubling, never above `maxMessageBytes`). */
  private appendFragment(payload: Buffer): void {
    const needed = this.fragmentBytes + payload.length;
    if (!this.fragment || this.fragment.length < needed) {
      const capacity = Math.min(this.maxMessageBytes, Math.max(needed, 2 * (this.fragment?.length ?? 0), 1024));
      const grown = Buffer.allocUnsafe(capacity);
      if (this.fragment) this.fragment.copy(grown, 0, 0, this.fragmentBytes);
      this.fragment = grown;
    }
    payload.copy(this.fragment, this.fragmentBytes);
    this.fragmentBytes = needed;
  }

  /** Answer a ping, or keep only the latest one while the peer does not read our output. */
  private pong(payload: Buffer): void {
    if (!this.isOpen) return;
    if (this.bufferedAmount > CONTROL_BACKLOG_BYTES) {
      this.pendingPong = payload;
      return;
    }
    this.write(OP_PONG, payload);
  }

  private flushPong(): void {
    const payload = this.pendingPong;
    this.pendingPong = undefined;
    if (payload) this.pong(payload);
  }

  /** Handle one frame; false stops parsing. */
  private frame(fin: boolean, opcode: number, payload: Buffer): boolean {
    switch (opcode) {
      case OP_PING:
        this.pong(payload);
        return true;
      case OP_PONG:
        return true;
      case OP_CLOSE: {
        if (payload.length === 1) {
          this.fail(WS_PROTOCOL_ERROR);
          return false;
        }
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.receivedClose = { code, reason: payload.subarray(2).toString("utf8") };
        if (!this.closeSent) {
          this.closeSent = true;
          const echo = payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0);
          this.write(OP_CLOSE, echo);
        }
        this.socket.end();
        return false;
      }
      case OP_TEXT:
      case OP_BINARY:
        if (this.fragmenting) {
          this.fail(WS_PROTOCOL_ERROR);
          return false;
        }
        if (fin) {
          this.handlers!.onMessage(payload, opcode === OP_BINARY);
          return true;
        }
        this.fragmenting = true;
        this.fragmentBinary = opcode === OP_BINARY;
        this.fragmentBytes = 0;
        this.appendFragment(payload);
        return true;
      case OP_CONTINUATION:
        if (!this.fragmenting) {
          this.fail(WS_PROTOCOL_ERROR);
          return false;
        }
        if (payload.length > 0) this.appendFragment(payload);
        if (fin) {
          const message = Buffer.from(this.fragment!.subarray(0, this.fragmentBytes));
          this.fragment = undefined;
          this.fragmentBytes = 0;
          this.fragmenting = false;
          this.handlers!.onMessage(message, this.fragmentBinary);
        }
        return true;
      default:
        this.fail(WS_PROTOCOL_ERROR);
        return false;
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handlers) this.handlers.onClose(this.receivedClose?.code ?? 1006, this.receivedClose?.reason ?? "");
  }
}

/**
 * Accept a WebSocket upgrade (server side). Returns undefined after answering
 * 400 when the request is not a valid RFC 6455 opening handshake.
 */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: { readonly protocol?: string; readonly maxMessageBytes: number },
): WebSocketConnection | undefined {
  const key = req.headers["sec-websocket-key"];
  const valid =
    req.method === "GET" &&
    (req.headers.upgrade ?? "").toLowerCase() === "websocket" &&
    (req.headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .some((t) => t.trim() === "upgrade") &&
    req.headers["sec-websocket-version"] === "13" &&
    typeof key === "string" &&
    Buffer.from(key, "base64").length === 16;
  if (!valid) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return undefined;
  }
  const lines = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ];
  if (options.protocol) lines.push(`Sec-WebSocket-Protocol: ${options.protocol}`);
  socket.write(lines.join("\r\n") + "\r\n\r\n");
  return new WebSocketConnection(socket, "server", options.maxMessageBytes, options.protocol, head);
}

/** Open a WebSocket (client side). Rejects when the upgrade is refused. */
export function connectWebSocket(
  url: string,
  options: {
    readonly protocols?: readonly string[];
    readonly headers?: Record<string, string>;
    readonly maxMessageBytes: number;
    readonly timeoutMs?: number;
  },
): Promise<WebSocketConnection> {
  const u = new URL(url);
  const secure = u.protocol === "wss:";
  if (!secure && u.protocol !== "ws:") return Promise.reject(new Error("not a WebSocket URL"));
  const key = randomBytes(16).toString("base64");
  const headers: Record<string, string> = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": key,
    ...options.headers,
  };
  if (options.protocols && options.protocols.length > 0)
    headers["Sec-WebSocket-Protocol"] = options.protocols.join(", ");
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)({
      host: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      timeout: options.timeoutMs ?? 10_000,
    });
    req.on("upgrade", (res, socket, head) => {
      if (res.headers["sec-websocket-accept"] !== acceptKey(key)) {
        socket.destroy();
        reject(new Error("invalid Sec-WebSocket-Accept"));
        return;
      }
      const protocol = res.headers["sec-websocket-protocol"];
      resolve(new WebSocketConnection(socket, "client", options.maxMessageBytes, protocol, head));
    });
    req.on("response", (res) => {
      res.resume();
      reject(new Error(`upgrade refused: ${res.statusCode}`));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

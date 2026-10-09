/**
 * Device side of the relay–device tunnel (ARCHITECTURE.md §27 AD-22, WP-30).
 *
 * `DeviceTunnel` is one outbound WebSocket connection to the Cloud Relay:
 * handshake with the device credential (point 3), then every stream the
 * relay opens is one HTTP exchange forwarded, unmodified, into the relay
 * entry point of the existing HTTP pipeline (AD-15, AD-21). The only checks
 * this module replaces are the two AD-22 point 7 names: the loopback Host
 * check (the request must name the pinned relay host) and the `/mcp` path
 * check (the request must name `/d/<own deviceId>/mcp`). Everything else —
 * OAuth token verification, device/account binding, admission, sessions,
 * ExecutionGuard, PermissionEngine, approvals, audit — runs unchanged in the
 * pipeline behind the loopback hop. Nothing here reads a JSON-RPC body or
 * names a tool.
 *
 * Safety properties:
 * - A stream the device refuses before forwarding is reset `refused`, so the
 *   relay reports `not_executed`; once forwarded, any stream that does not end
 *   with a complete response is reported by the relay as `unknown`.
 * - Tunnel loss aborts every forwarded request (the pipeline's AbortSignal:
 *   pending approvals and not-started operations are cancelled). Nothing is
 *   ever replayed: a new tunnel starts with no streams (point 9, 13).
 * - Memory is bounded: at most `maxStreams` streams, request bodies at most
 *   4 MiB, response bytes buffered at most one stream window per stream,
 *   frames at most 64 KiB (points 5, 6, 8, 11).
 * - Logs carry only the tunnel id, stream ids and codes: never tokens,
 *   headers, paths or bodies.
 *
 * `DeviceTunnelManager` keeps one tunnel up while remote mode is on and the
 * device is paired: reconnect with exponential backoff and full jitter,
 * retry-after hints, hourly retries after an authentication or version
 * refusal, and a clean GOAWAY when remote mode is turned off or the device
 * is unpaired (point 9).
 */
import { randomBytes } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import {
  CHALLENGE_BYTES,
  CloseCode,
  DEAD_AFTER_SILENCE_MS,
  DEFAULT_EXCHANGE_DEADLINE_MS,
  DRAIN_LIMIT_MS,
  EXTENSION_TYPE_MIN,
  FLAG_END_STREAM,
  FrameType,
  HANDSHAKE_TIMEOUT_MS,
  INITIAL_CONNECTION_WINDOW,
  INITIAL_STREAM_WINDOW,
  MAX_DATA_PAYLOAD,
  MAX_FRAME_BYTES,
  MAX_HEADER_COUNT,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  MAX_STREAMS_CAP,
  MAX_WINDOW,
  PING_AFTER_IDLE_MS,
  TUNNEL_PATH,
  TUNNEL_SUBPROTOCOL_PREFIX,
  TUNNEL_V1,
  TunnelProtocolError,
  decodeFrame,
  encodeFrame,
  encodeJsonFrame,
  encodeWindow,
  endToEndHeaders,
  isGoAwayCode,
  isHopByHop,
  isResetCode,
  parseHeaderList,
  parseJsonPayload,
  parseWindowIncrement,
  type GoAwayCode,
  type ResetCode,
} from "./protocol.js";
import { connectWebSocket, type WebSocketConnection } from "./websocket.js";

/** What the tunnel needs of the device credential (`TunnelCredential` of the device binding). */
export interface DeviceTunnelCredential {
  readonly deviceId: string;
  readonly relayHost: string;
  prove(challenge: Uint8Array): Buffer;
}

/** Timing knobs; production uses the AD-22 values, tests shorten them. */
export interface DeviceTunnelTiming {
  readonly handshakeTimeoutMs: number;
  readonly pingAfterIdleMs: number;
  readonly deadAfterSilenceMs: number;
  readonly drainLimitMs: number;
  /** The device aborts a stream this long before the relay's deadline (point 12). */
  readonly deadlineMarginMs: number;
}

export const DEFAULT_TUNNEL_TIMING: DeviceTunnelTiming = {
  handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
  pingAfterIdleMs: PING_AFTER_IDLE_MS,
  deadAfterSilenceMs: DEAD_AFTER_SILENCE_MS,
  drainLimitMs: DRAIN_LIMIT_MS,
  deadlineMarginMs: 5_000,
};

export interface DeviceTunnelOptions {
  /** `wss://<relayHost>/.crot/tunnel` in production. */
  readonly url: string;
  readonly credential: DeviceTunnelCredential;
  /** The loopback relay entry point of the HTTP pipeline (`http://127.0.0.1:<port>`). */
  readonly target: { readonly host: string; readonly port: number; readonly path?: string };
  /** Announced in HELLO; capped at 1024 (point 6). */
  readonly maxStreams: number;
  readonly software?: string;
  readonly timing?: Partial<DeviceTunnelTiming>;
  readonly log?: (message: string) => void;
}

/** How a tunnel ended. */
export interface TunnelEnd {
  /** WebSocket close code (1006 when the connection dropped without one). */
  readonly closeCode: number;
  readonly reason: string;
  /** Whether READY was received. */
  readonly ready: boolean;
  /** When READY was received (ms since epoch). */
  readonly readyAt?: number;
  /** The relay's GOAWAY, when one was received. */
  readonly goAway?: { readonly code: GoAwayCode; readonly retryAfterMs?: number };
  /** A retry hint from GOAWAY or close 4429. */
  readonly retryAfterMs?: number;
  /** Set when this side ended the tunnel (stop, protocol error, dead peer). */
  readonly local?: string;
}

const ALLOWED_METHODS = new Set(["POST", "GET", "DELETE"]);
/** Headers that must appear at most once in a forwarded request (no ambiguity for the pipeline). */
const SINGLETON_HEADERS = new Set([
  "host",
  "authorization",
  "content-length",
  "content-type",
  "origin",
  "mcp-session-id",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
]);
/** Response bytes queued per stream above which the local response is paused. */
const RESPONSE_HIGH_WATER = 256 * 1024;

type StreamState = "forwarding" | "done";

interface Stream {
  readonly id: number;
  state: StreamState;
  /** The local request into the pipeline (absent for locally answered streams). */
  req?: ClientRequest;
  res?: IncomingMessage;
  /** Request side: whether END_STREAM was received from the relay. */
  requestEnded: boolean;
  requestBytes: number;
  declaredLength?: number;
  /** Credits the relay may still use for request DATA on this stream. */
  recvWindow: number;
  /** Credits this side may still use for response DATA on this stream. */
  sendWindow: number;
  /** Response frames waiting for credit. */
  queue: Buffer[];
  queued: number;
  responseBytes: number;
  responseEnded: boolean;
  responseSent: boolean;
  deadline?: NodeJS.Timeout;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64url(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  return Buffer.from(value, "base64url");
}

/** Only short, printable identifiers are ever logged. */
function safeId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : "?";
}

function retryHint(reason: string): number | undefined {
  const m = /retry[_-]?after(?:ms)?[=:](\d{1,9})/i.exec(reason);
  return m ? Number(m[1]) : undefined;
}

export class DeviceTunnel {
  private ws: WebSocketConnection | undefined;
  private readonly timing: DeviceTunnelTiming;
  private readonly streams = new Map<number, Stream>();
  private lastStream = 0;
  private ready = false;
  private readyAt: number | undefined;
  private tunnelId = "?";
  private draining = false;
  private goAway: TunnelEnd["goAway"];
  private local: string | undefined;
  private ended = false;
  private recvConnWindow = INITIAL_CONNECTION_WINDOW;
  private sendConnWindow = INITIAL_CONNECTION_WINDOW;
  private lastReceived = Date.now();
  private lastSent = Date.now();
  private timers = new Set<NodeJS.Timeout>();
  private liveness: NodeJS.Timeout | undefined;
  private drainTimer: NodeJS.Timeout | undefined;
  private readonly endPromise: Promise<TunnelEnd>;
  private resolveEnd!: (end: TunnelEnd) => void;
  private readyWaiter: { resolve: () => void; reject: (end: TunnelEnd) => void } | undefined;
  private readonly maxStreams: number;

  constructor(private readonly options: DeviceTunnelOptions) {
    this.timing = { ...DEFAULT_TUNNEL_TIMING, ...options.timing };
    this.maxStreams = Math.max(1, Math.min(MAX_STREAMS_CAP, Math.floor(options.maxStreams)));
    this.endPromise = new Promise((resolve) => (this.resolveEnd = resolve));
  }

  /** The production tunnel URL for a relay host. */
  static urlFor(relayHost: string): string {
    return `wss://${relayHost}${TUNNEL_PATH}`;
  }

  /** Resolves with the tunnel's end (also when `open` failed). */
  get closed(): Promise<TunnelEnd> {
    return this.endPromise;
  }

  get id(): string {
    return this.tunnelId;
  }

  get isReady(): boolean {
    return this.ready && !this.ended;
  }

  /** Open streams (forwarded or being answered). */
  get activeStreams(): number {
    return this.streams.size;
  }

  /**
   * Connect and complete the handshake. Resolves at READY; rejects with the
   * `TunnelEnd` when the relay refuses or the handshake fails.
   */
  async open(): Promise<void> {
    const subprotocol = TUNNEL_SUBPROTOCOL_PREFIX + TUNNEL_V1;
    let ws: WebSocketConnection;
    try {
      ws = await connectWebSocket(this.options.url, {
        protocols: [subprotocol],
        maxMessageBytes: MAX_FRAME_BYTES,
        timeoutMs: this.timing.handshakeTimeoutMs,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "connect failed";
      const status = /upgrade refused: (\d+)/.exec(message);
      const end: TunnelEnd = {
        closeCode: 1006,
        reason: status ? `upgrade_refused_${status[1]}` : "connect_failed",
        ready: false,
        local: "connect_failed",
      };
      this.ended = true;
      this.resolveEnd(end);
      throw end;
    }
    this.ws = ws;
    const waiting = new Promise<void>((resolve, reject) => (this.readyWaiter = { resolve, reject }));
    ws.attach({
      onMessage: (data, binary) => this.onMessage(data, binary),
      onTooLarge: () => this.connectionError("frame_too_large"),
      onClose: (code, reason) => this.onClose(code, reason),
    });
    if (ws.protocol !== subprotocol) {
      this.fail("unsupported_subprotocol", CloseCode.PROTOCOL_ERROR);
    } else {
      this.timer(() => {
        if (!this.ready) this.fail("handshake_timeout", CloseCode.HANDSHAKE_TIMEOUT);
      }, this.timing.handshakeTimeoutMs);
    }
    await waiting;
  }

  /**
   * End the tunnel from this side: GOAWAY with `code`, every stream aborted
   * (no replay), close 1000. Used for remote off, unpair and shutdown.
   */
  stop(code: GoAwayCode = "shutting_down"): Promise<TunnelEnd> {
    if (!this.ended && this.ws) {
      this.local ??= `stop_${code}`;
      if (this.ready) this.sendFrame(encodeJsonFrame(FrameType.GOAWAY, 0, { lastStream: this.lastStream, code }));
      for (const s of [...this.streams.values()]) this.abortStream(s, "device_terminated", true);
      this.ws.close(CloseCode.NORMAL, code);
    }
    return this.endPromise;
  }

  /** Drop the connection without a close handshake (tests: simulated network loss). */
  terminate(): void {
    this.ws?.terminate();
  }

  // ---------------------------------------------------------------- frames

  private log(message: string): void {
    this.options.log?.(`tunnel ${this.tunnelId}: ${message}`);
  }

  private timer(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref();
    this.timers.add(t);
    return t;
  }

  private sendFrame(frame: Buffer): void {
    if (!this.ws || this.ended) return;
    this.ws.send(frame);
    this.lastSent = Date.now();
  }

  private onMessage(data: Buffer, binary: boolean): void {
    if (this.ended) return;
    this.lastReceived = Date.now();
    if (!binary) return this.connectionError("text_message");
    try {
      this.onFrame(decodeFrame(data));
    } catch (e) {
      this.connectionError(e instanceof TunnelProtocolError ? e.code : "internal_error");
    }
  }

  private onFrame(frame: { type: number; flags: number; stream: number; payload: Buffer }): void {
    if (!this.ready) return this.handshakeFrame(frame);
    if (frame.type >= EXTENSION_TYPE_MIN) return; // not negotiated: ignored (point 5)
    switch (frame.type) {
      case FrameType.PING:
        if (frame.stream !== 0 || frame.payload.length !== 8) throw new TunnelProtocolError("invalid_ping");
        this.sendFrame(encodeFrame(FrameType.PONG, 0, frame.payload));
        return;
      case FrameType.PONG:
        if (frame.stream !== 0 || frame.payload.length !== 8) throw new TunnelProtocolError("invalid_pong");
        return;
      case FrameType.GOAWAY:
        if (frame.stream !== 0) throw new TunnelProtocolError("invalid_goaway");
        return this.onGoAway(parseJsonPayload(frame.payload));
      case FrameType.WINDOW:
        return this.onWindow(frame.stream, parseWindowIncrement(frame.payload));
      case FrameType.OPEN:
        return this.onOpen(frame.stream, frame.flags, frame.payload);
      case FrameType.DATA:
        return this.onData(frame.stream, frame.flags, frame.payload);
      case FrameType.RESET:
        return this.onReset(frame.stream, frame.payload);
      default:
        // CHALLENGE/HELLO/READY after the handshake, RESPONSE in the wrong direction, unknown types.
        throw new TunnelProtocolError("unexpected_frame");
    }
  }

  private handshakeFrame(frame: { type: number; stream: number; payload: Buffer }): void {
    if (frame.stream !== 0) throw new TunnelProtocolError("unexpected_frame");
    if (frame.type === FrameType.CHALLENGE && !this.challenged) {
      this.challenged = true;
      const body = parseJsonPayload(frame.payload);
      // Point 3: a relay that does not name the pinned host gets no proof.
      if (body.relayHost !== this.options.credential.relayHost) {
        this.fail("relay_host_mismatch", CloseCode.PROTOCOL_ERROR);
        return;
      }
      const challenge = fromB64url(body.challenge);
      if (!challenge || challenge.length < 16 || challenge.length > 1024)
        throw new TunnelProtocolError("invalid_challenge");
      if (challenge.length !== CHALLENGE_BYTES) this.log("challenge length differs from 32");
      let proof: Buffer;
      try {
        proof = this.options.credential.prove(challenge);
      } catch {
        // The credential is gone (unpaired): no proof, a normal close.
        this.fail("credential_unavailable", CloseCode.NORMAL);
        return;
      }
      this.sendFrame(
        encodeJsonFrame(FrameType.HELLO, 0, {
          deviceId: this.options.credential.deviceId,
          proof: b64url(proof),
          software: this.options.software ?? "crot",
          maxStreams: this.maxStreams,
          features: [],
        }),
      );
      return;
    }
    if (frame.type === FrameType.READY && this.challenged) {
      const body = parseJsonPayload(frame.payload);
      this.tunnelId = safeId(body.tunnelId);
      this.ready = true;
      this.readyAt = Date.now();
      this.lastReceived = this.lastSent = Date.now();
      this.startLiveness();
      this.log("ready");
      this.readyWaiter?.resolve();
      this.readyWaiter = undefined;
      return;
    }
    if (frame.type === FrameType.GOAWAY) return this.onGoAway(parseJsonPayload(frame.payload));
    throw new TunnelProtocolError("unexpected_frame");
  }

  private challenged = false;

  private startLiveness(): void {
    const tick = Math.max(10, Math.floor(Math.min(this.timing.pingAfterIdleMs, this.timing.deadAfterSilenceMs) / 4));
    this.liveness = setInterval(() => {
      const now = Date.now();
      if (now - this.lastReceived >= this.timing.deadAfterSilenceMs) {
        this.local ??= "peer_silent";
        this.log("relay silent, dropping tunnel");
        this.ws?.terminate();
        return;
      }
      if (now - this.lastSent >= this.timing.pingAfterIdleMs)
        this.sendFrame(encodeFrame(FrameType.PING, 0, randomBytes(8)));
    }, tick);
    this.liveness.unref();
  }

  private onGoAway(body: Record<string, unknown>): void {
    const code = isGoAwayCode(body.code) ? body.code : "shutting_down";
    const retryAfterMs =
      typeof body.retryAfterMs === "number" && Number.isInteger(body.retryAfterMs) && body.retryAfterMs >= 0
        ? body.retryAfterMs
        : undefined;
    this.goAway = retryAfterMs === undefined ? { code } : { code, retryAfterMs };
    this.log(`goaway ${code}`);
    this.draining = true;
    if (!this.ready) return;
    this.maybeFinishDrain();
    this.drainTimer ??= this.timer(() => {
      for (const s of [...this.streams.values()]) this.abortStream(s, "shutting_down", true);
      this.ws?.close(CloseCode.NORMAL, "drained");
    }, this.timing.drainLimitMs);
  }

  private maybeFinishDrain(): void {
    if (this.draining && this.streams.size === 0 && this.ws?.isOpen) this.ws.close(CloseCode.NORMAL, "drained");
  }

  private onWindow(id: number, increment: number): void {
    if (id === 0) {
      this.sendConnWindow += increment;
      if (this.sendConnWindow > MAX_WINDOW) throw new TunnelProtocolError("flow_control_error");
      for (const s of this.streams.values()) this.pump(s);
      return;
    }
    const s = this.streams.get(id);
    if (!s) {
      if (id > this.lastStream) throw new TunnelProtocolError("unknown_stream");
      return;
    }
    s.sendWindow += increment;
    if (s.sendWindow > MAX_WINDOW) throw new TunnelProtocolError("flow_control_error");
    this.pump(s);
  }

  // --------------------------------------------------------------- streams

  private onOpen(id: number, flags: number, payload: Buffer): void {
    if (id === 0 || id <= this.lastStream) throw new TunnelProtocolError("invalid_stream_id");
    this.lastStream = id;
    let head: Record<string, unknown>;
    try {
      head = parseJsonPayload(payload);
    } catch {
      this.sendFrame(encodeJsonFrame(FrameType.RESET, id, { code: "protocol_error" }));
      return;
    }
    // Point 6: refused before anything is forwarded, so the outcome is `not_executed`.
    if (this.draining || this.streams.size >= this.maxStreams) {
      this.sendFrame(encodeJsonFrame(FrameType.RESET, id, { code: "refused" }));
      return;
    }
    const s: Stream = {
      id,
      state: "forwarding",
      requestEnded: (flags & FLAG_END_STREAM) !== 0,
      requestBytes: 0,
      recvWindow: INITIAL_STREAM_WINDOW,
      sendWindow: INITIAL_STREAM_WINDOW,
      queue: [],
      queued: 0,
      responseBytes: 0,
      responseEnded: false,
      responseSent: false,
    };
    this.streams.set(id, s);
    const deadlineMs =
      typeof head.deadlineMs === "number" && Number.isFinite(head.deadlineMs) && head.deadlineMs > 0
        ? head.deadlineMs
        : DEFAULT_EXCHANGE_DEADLINE_MS;
    // Point 12: the device gives up shortly before the relay does, so the reset is its own.
    s.deadline = this.timer(
      () => {
        if (s.state === "done") return;
        this.log(`stream ${id} deadline_exceeded`);
        this.abortStream(s, "deadline_exceeded", true);
      },
      Math.max(0, deadlineMs - this.timing.deadlineMarginMs),
    );
    const checked = this.checkHead(head);
    if ("error" in checked) {
      this.answerLocally(s, checked.status, checked.error);
      return;
    }
    this.forward(s, checked.method, checked.query, checked.headers);
  }

  /** AD-22 point 7, the two checks that replace the loopback ones, plus well-formedness. */
  private checkHead(
    head: Record<string, unknown>,
  ):
    | { method: string; query: string; headers: OutgoingHttpHeaders; length?: number }
    | { status: number; error: string } {
    const method = head.method;
    if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) return { status: 405, error: "method_not_allowed" };
    const headers = parseHeaderList(head.headers, MAX_HEADER_COUNT);
    if (!headers) return { status: 400, error: "invalid_headers" };
    const target = typeof head.path === "string" ? head.path : "";
    const q = target.indexOf("?");
    const pathname = q < 0 ? target : target.slice(0, q);
    if (pathname !== `/d/${this.options.credential.deviceId}/mcp`) return { status: 404, error: "not_found" };
    const counts = new Map<string, number>();
    for (const [name] of headers) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const name of SINGLETON_HEADERS)
      if ((counts.get(name) ?? 0) > 1) return { status: 400, error: "invalid_headers" };
    const host = headers.find(([n]) => n === "host")?.[1];
    if (!host || host.toLowerCase() !== this.options.credential.relayHost.toLowerCase())
      return { status: 403, error: "invalid_host" };
    if (headers.some(([n]) => n === "transfer-encoding")) return { status: 400, error: "invalid_headers" };
    const out: OutgoingHttpHeaders = {};
    let length: number | undefined;
    for (const [name, value] of headers) {
      if (name === "host" || isHopByHop(name)) continue;
      if (name === "content-length") {
        if (!/^\d{1,10}$/.test(value)) return { status: 400, error: "invalid_content_length" };
        length = Number(value);
        if (length > MAX_REQUEST_BODY_BYTES) return { status: 413, error: "request_too_large" };
      }
      const prev = out[name];
      out[name] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [String(prev), value];
    }
    out.host = `${this.options.target.host}:${this.options.target.port}`;
    return length === undefined
      ? { method, query: q < 0 ? "" : target.slice(q), headers: out }
      : { method, query: q < 0 ? "" : target.slice(q), headers: out, length };
  }

  /** An ordinary HTTP error for a request that never reached the pipeline. */
  private answerLocally(s: Stream, status: number, error: string): void {
    const body = Buffer.from(JSON.stringify({ error }), "utf8");
    s.responseSent = true;
    this.sendFrame(
      encodeJsonFrame(FrameType.RESPONSE, s.id, {
        status,
        headers: [
          ["content-type", "application/json"],
          ["content-length", String(body.length)],
        ],
      }),
    );
    s.responseEnded = true;
    this.enqueue(s, body);
    this.pump(s);
  }

  private forward(s: Stream, method: string, query: string, headers: OutgoingHttpHeaders): void {
    const length = headers["content-length"];
    if (typeof length === "string") s.declaredLength = Number(length);
    const req = httpRequest({
      host: this.options.target.host,
      port: this.options.target.port,
      method,
      path: (this.options.target.path ?? "/mcp") + query,
      headers,
      agent: false,
    });
    s.req = req;
    req.on("response", (res) => this.onLocalResponse(s, res));
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (s.state === "done") return;
      // Nothing reached the pipeline when the loopback connection was refused.
      const code: ResetCode = e.code === "ECONNREFUSED" ? "refused" : "internal_error";
      this.log(`stream ${s.id} ${code}`);
      this.abortStream(s, code, true);
    });
    if (s.requestEnded) this.endRequest(s);
  }

  private endRequest(s: Stream): void {
    if (!s.req) return;
    if (s.declaredLength !== undefined && s.requestBytes !== s.declaredLength) {
      this.abortStream(s, "protocol_error", true);
      return;
    }
    s.req.end();
  }

  private onData(id: number, flags: number, payload: Buffer): void {
    const s = this.streams.get(id);
    if (!s) {
      if (id === 0 || id > this.lastStream) throw new TunnelProtocolError("unknown_stream");
      return; // a stream this side already ended
    }
    if (s.requestEnded) throw new TunnelProtocolError("data_after_end");
    s.recvWindow -= payload.length;
    this.recvConnWindow -= payload.length;
    if (s.recvWindow < 0 || this.recvConnWindow < 0) throw new TunnelProtocolError("flow_control_error");
    s.requestBytes += payload.length;
    if ((flags & FLAG_END_STREAM) !== 0) s.requestEnded = true;
    if (!s.req) {
      // Answered locally: the body is discarded, credits returned at once.
      this.credit(s, payload.length);
      return;
    }
    if (
      s.requestBytes > MAX_REQUEST_BODY_BYTES ||
      (s.declaredLength !== undefined && s.requestBytes > s.declaredLength)
    ) {
      this.abortStream(s, "protocol_error", true);
      return;
    }
    if (payload.length > 0) {
      const n = payload.length;
      // Point 8: credits come back once the pipeline's socket took the bytes.
      s.req.write(payload, () => this.credit(s, n));
    }
    if (s.requestEnded) this.endRequest(s);
  }

  private credit(s: Stream, n: number): void {
    if (n <= 0 || this.ended) return;
    this.recvConnWindow += n;
    this.sendFrame(encodeWindow(0, n));
    if (s.state !== "done" && !s.requestEnded) {
      s.recvWindow += n;
      this.sendFrame(encodeWindow(s.id, n));
    }
  }

  private onReset(id: number, payload: Buffer): void {
    const s = this.streams.get(id);
    if (!s) {
      if (id === 0 || id > this.lastStream) throw new TunnelProtocolError("unknown_stream");
      return; // the stream already ended: ignored
    }
    let code = "cancel";
    try {
      const body = parseJsonPayload(payload);
      if (isResetCode(body.code)) code = body.code;
    } catch {
      // a malformed reset still ends the stream
    }
    this.log(`stream ${id} reset by relay (${code})`);
    // Point 13: the relay's cancel aborts the local request (the pipeline's AbortSignal).
    this.abortStream(s, "cancel", false);
  }

  private onLocalResponse(s: Stream, res: IncomingMessage): void {
    if (s.state === "done") {
      res.destroy();
      return;
    }
    s.res = res;
    const headers = endToEndHeaders(res.rawHeaders).slice(0, MAX_HEADER_COUNT);
    s.responseSent = true;
    this.sendFrame(encodeJsonFrame(FrameType.RESPONSE, s.id, { status: res.statusCode ?? 502, headers }));
    res.on("data", (chunk: Buffer) => {
      if (s.state === "done") return;
      s.responseBytes += chunk.length;
      if (s.responseBytes > MAX_RESPONSE_BODY_BYTES) {
        // Point 11: too large; the relay reports `unknown` (the tool may have run).
        this.log(`stream ${s.id} response_too_large`);
        this.abortStream(s, "response_too_large", true);
        return;
      }
      this.enqueue(s, chunk);
      this.pump(s);
      if (s.queued > RESPONSE_HIGH_WATER) res.pause();
    });
    res.on("end", () => {
      if (s.state === "done") return;
      s.responseEnded = true;
      this.pump(s);
    });
    res.on("error", () => {
      if (s.state !== "done") this.abortStream(s, "internal_error", true);
    });
  }

  private enqueue(s: Stream, chunk: Buffer): void {
    for (let i = 0; i < chunk.length; i += MAX_DATA_PAYLOAD) {
      const part = chunk.subarray(i, i + MAX_DATA_PAYLOAD);
      s.queue.push(part);
      s.queued += part.length;
    }
  }

  /** Send queued response bytes within the relay's windows; END_STREAM when all is sent. */
  private pump(s: Stream): void {
    if (s.state === "done" || !s.responseSent) return;
    while (s.queue.length > 0) {
      const budget = Math.min(s.sendWindow, this.sendConnWindow);
      if (budget <= 0) return;
      let chunk = s.queue[0]!;
      if (chunk.length > budget) {
        s.queue[0] = chunk.subarray(budget);
        chunk = chunk.subarray(0, budget);
      } else s.queue.shift();
      s.queued -= chunk.length;
      s.sendWindow -= chunk.length;
      this.sendConnWindow -= chunk.length;
      const last = s.queue.length === 0 && s.responseEnded;
      this.sendFrame(encodeFrame(FrameType.DATA, s.id, chunk, last ? FLAG_END_STREAM : 0));
      if (last) return this.finishStream(s);
    }
    if (s.res && s.queued <= RESPONSE_HIGH_WATER / 2 && s.res.isPaused()) s.res.resume();
    if (s.responseEnded && s.queue.length === 0) {
      this.sendFrame(encodeFrame(FrameType.DATA, s.id, Buffer.alloc(0), FLAG_END_STREAM));
      this.finishStream(s);
    }
  }

  private finishStream(s: Stream): void {
    s.state = "done";
    if (s.deadline) clearTimeout(s.deadline);
    if (s.deadline) this.timers.delete(s.deadline);
    this.streams.delete(s.id);
    // A request body still arriving after the response is complete is not needed.
    if (!s.requestEnded) s.req?.destroy();
    this.maybeFinishDrain();
  }

  /**
   * End a stream early: destroy the local request (the pipeline sees the
   * client disconnect and aborts), release its memory and, when `notify`,
   * tell the relay with RESET.
   */
  private abortStream(s: Stream, code: ResetCode, notify: boolean): void {
    if (s.state === "done") return;
    s.state = "done";
    if (s.deadline) {
      clearTimeout(s.deadline);
      this.timers.delete(s.deadline);
    }
    s.queue = [];
    s.queued = 0;
    s.res?.destroy();
    s.req?.destroy();
    this.streams.delete(s.id);
    if (notify) this.sendFrame(encodeJsonFrame(FrameType.RESET, s.id, { code }));
    this.maybeFinishDrain();
  }

  // ------------------------------------------------------------ lifecycle

  /** A connection error (point 14): GOAWAY protocol_error, close 4400. */
  private connectionError(code: string): void {
    if (this.ended) return;
    this.log(`protocol error ${safeId(code)}`);
    if (this.ready)
      this.sendFrame(encodeJsonFrame(FrameType.GOAWAY, 0, { lastStream: this.lastStream, code: "protocol_error" }));
    this.fail(`protocol_error:${safeId(code)}`, CloseCode.PROTOCOL_ERROR);
  }

  private fail(local: string, closeCode: number): void {
    this.local ??= local;
    for (const s of [...this.streams.values()]) this.abortStream(s, "device_terminated", false);
    if (this.ws?.isOpen) this.ws.close(closeCode, local.split(":")[0]);
    else this.ws?.terminate();
  }

  private onClose(code: number, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    // Tunnel loss: every forwarded request is aborted, never replayed (point 13).
    for (const s of [...this.streams.values()]) this.abortStream(s, "device_terminated", false);
    if (this.liveness) clearInterval(this.liveness);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const hint = this.goAway?.retryAfterMs ?? (code === CloseCode.RATE_LIMITED ? retryHint(reason) : undefined);
    const end: TunnelEnd = {
      closeCode: code,
      reason: safeId(reason.split(";")[0]) === "?" ? "" : reason.split(";")[0]!,
      ready: this.ready,
      ...(this.readyAt !== undefined ? { readyAt: this.readyAt } : {}),
      ...(this.goAway ? { goAway: this.goAway } : {}),
      ...(hint !== undefined ? { retryAfterMs: hint } : {}),
      ...(this.local ? { local: this.local } : {}),
    };
    this.log(`closed ${code}`);
    this.resolveEnd(end);
    if (this.readyWaiter) {
      this.readyWaiter.reject(end);
      this.readyWaiter = undefined;
    }
  }
}

// ------------------------------------------------------------------ manager

export type TunnelManagerState = "stopped" | "connecting" | "ready" | "waiting" | "blocked";

export interface TunnelManagerStatus {
  readonly state: TunnelManagerState;
  /** Why the tunnel is not ready (a short code, never a secret). */
  readonly reason?: string;
  /** When the next attempt is due (ms since epoch). */
  readonly nextAttemptAt?: number;
  readonly tunnelId?: string;
}

export interface DeviceTunnelManagerOptions {
  /** A fresh credential per attempt; `undefined` when the device is no longer paired. */
  readonly credential: () => DeviceTunnelCredential | undefined;
  readonly url: (credential: DeviceTunnelCredential) => string;
  readonly target: DeviceTunnelOptions["target"];
  readonly maxStreams: number;
  readonly software?: string;
  readonly timing?: Partial<DeviceTunnelTiming>;
  readonly backoff?: {
    readonly baseMs?: number;
    readonly capMs?: number;
    readonly resetAfterMs?: number;
    readonly blockedRetryMs?: number;
  };
  readonly random?: () => number;
  readonly log?: (message: string) => void;
  readonly onStatus?: (status: TunnelManagerStatus) => void;
}

/** Close codes after which the device does not retry quickly (point 9). */
const BLOCKING_CLOSE = new Map<number, string>([
  [CloseCode.UNAUTHORIZED, "unauthorized"],
  [CloseCode.FORBIDDEN, "forbidden"],
  [CloseCode.UNSUPPORTED_VERSION, "unsupported_version"],
]);

export class DeviceTunnelManager {
  private current: DeviceTunnel | undefined;
  private running = false;
  private attempt = 0;
  private wake: NodeJS.Timeout | undefined;
  private statusValue: TunnelManagerStatus = { state: "stopped" };
  private loop: Promise<void> | undefined;
  private nudgeWaiter: (() => void) | undefined;
  private readonly base: number;
  private readonly cap: number;
  private readonly resetAfter: number;
  private readonly blockedRetry: number;

  constructor(private readonly options: DeviceTunnelManagerOptions) {
    this.base = options.backoff?.baseMs ?? 1_000;
    this.cap = options.backoff?.capMs ?? 60_000;
    this.resetAfter = options.backoff?.resetAfterMs ?? 60_000;
    this.blockedRetry = options.backoff?.blockedRetryMs ?? 60 * 60_000;
  }

  get status(): TunnelManagerStatus {
    return this.statusValue;
  }

  get tunnel(): DeviceTunnel | undefined {
    return this.current;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.loop = this.run();
  }

  /** Retry now (network change, wake, re-pairing): skips a pending wait. */
  nudge(): void {
    this.nudgeWaiter?.();
  }

  /** Stop: GOAWAY `code`, abort streams, close 1000; no further attempts. */
  async stop(code: GoAwayCode = "shutting_down"): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.nudgeWaiter?.();
    const t = this.current;
    if (t) await t.stop(code);
    await this.loop;
    this.setStatus({ state: "stopped", reason: code });
  }

  private setStatus(status: TunnelManagerStatus): void {
    this.statusValue = status;
    this.options.onStatus?.(status);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private async run(): Promise<void> {
    while (this.running) {
      const credential = this.options.credential();
      if (!credential) {
        this.setStatus({ state: "blocked", reason: "not_paired" });
        await this.wait(this.blockedRetry);
        continue;
      }
      this.setStatus({ state: "connecting" });
      const tunnel = new DeviceTunnel({
        url: this.options.url(credential),
        credential,
        target: this.options.target,
        maxStreams: this.options.maxStreams,
        ...(this.options.software ? { software: this.options.software } : {}),
        ...(this.options.timing ? { timing: this.options.timing } : {}),
        ...(this.options.log ? { log: this.options.log } : {}),
      });
      this.current = tunnel;
      try {
        await tunnel.open();
        if (this.running) this.setStatus({ state: "ready", tunnelId: tunnel.id });
        else await tunnel.stop("shutting_down");
      } catch {
        // the end is classified below
      }
      const end = await tunnel.closed;
      this.current = undefined;
      if (!this.running) return;
      if (end.ready && end.readyAt !== undefined && Date.now() - end.readyAt >= this.resetAfter) this.attempt = 0;
      const blocked = BLOCKING_CLOSE.get(end.closeCode);
      if (blocked) {
        this.log(`tunnel refused (${end.closeCode}); next attempt in ${this.blockedRetry} ms or on a state change`);
        this.setStatus({ state: "blocked", reason: blocked, nextAttemptAt: Date.now() + this.blockedRetry });
        await this.wait(this.blockedRetry);
        continue;
      }
      let delay = this.backoff();
      if (end.retryAfterMs !== undefined) delay = Math.max(delay, Math.min(end.retryAfterMs, 24 * 60 * 60_000));
      const reason =
        end.closeCode === CloseCode.SUPERSEDED_TOO_OFTEN
          ? "superseded_too_often"
          : end.goAway
            ? `goaway_${end.goAway.code}`
            : (end.local ?? `closed_${end.closeCode}`);
      this.setStatus({ state: "waiting", reason, nextAttemptAt: Date.now() + delay });
      await this.wait(delay);
    }
  }

  /** Full jitter: uniform in [0, min(cap, base·2^attempt)]. */
  private backoff(): number {
    const ceiling = Math.min(this.cap, this.base * 2 ** Math.min(this.attempt, 30));
    this.attempt++;
    return Math.floor((this.options.random ?? Math.random)() * ceiling);
  }

  private wait(ms: number): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (this.wake) clearTimeout(this.wake);
        this.wake = undefined;
        this.nudgeWaiter = undefined;
        resolve();
      };
      this.nudgeWaiter = done;
      this.wake = setTimeout(done, ms);
      this.wake.unref();
    });
  }
}

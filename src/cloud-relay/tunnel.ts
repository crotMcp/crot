/**
 * The relay side of one tunnel connection (ARCHITECTURE.md §27 AD-22
 * points 3, 5, 6, 8, 9, 13 and 14).
 *
 * One `RelayTunnel` per WebSocket: the handshake (CHALLENGE → HELLO →
 * READY, authentication delegated to the relay), stream ids and limits,
 * credit-based flow control in both directions, keep-alive, GOAWAY and
 * draining, connection errors. It knows nothing about HTTP clients: an
 * exchange is attached as a `StreamSink`. It never interprets bodies and has
 * no frame by which it could run, authorize or approve anything.
 */
import { randomBytes } from "node:crypto";
import {
  CHALLENGE_BYTES,
  CloseCode,
  DEAD_AFTER_SILENCE_MS,
  decodeFrame,
  DRAIN_LIMIT_MS,
  encodeFrame,
  encodeJsonFrame,
  encodeWindow,
  EXTENSION_TYPE_MIN,
  FLAG_END_STREAM,
  FrameType,
  HANDSHAKE_TIMEOUT_MS,
  INITIAL_CONNECTION_WINDOW,
  INITIAL_STREAM_WINDOW,
  isGoAwayCode,
  isResetCode,
  MAX_DATA_PAYLOAD,
  MAX_JSON_PAYLOAD,
  MAX_STREAM_ID,
  MAX_WINDOW,
  parseHeaderList,
  parseJsonPayload,
  parseWindowIncrement,
  PING_AFTER_IDLE_MS,
  TunnelProtocolError,
  type Frame,
  type GoAwayCode,
  type HeaderList,
  type ResetCode,
} from "../tunnel/protocol.js";
import type { WebSocketConnection } from "../tunnel/websocket.js";
import type { RelayLogger } from "./log.js";

export interface TunnelTiming {
  readonly handshakeMs: number;
  readonly pingAfterIdleMs: number;
  readonly deadAfterMs: number;
  readonly drainMs: number;
}

export const DEFAULT_TUNNEL_TIMING: TunnelTiming = {
  handshakeMs: HANDSHAKE_TIMEOUT_MS,
  pingAfterIdleMs: PING_AFTER_IDLE_MS,
  deadAfterMs: DEAD_AFTER_SILENCE_MS,
  drainMs: DRAIN_LIMIT_MS,
};

export interface Hello {
  readonly deviceId: string;
  readonly proof: Buffer;
  readonly software: string;
  readonly maxStreams: number;
  readonly features: readonly string[];
}

export type HandshakeDecision =
  | { readonly ok: true; readonly features: readonly string[] }
  | { readonly ok: false; readonly closeCode: number; readonly reason: string };

/** Why a stream ended without a complete response (seen by the exchange). */
export type StreamEnd = ResetCode | "tunnel_lost" | "not_processed";

export interface StreamSink {
  onResponse(status: number, headers: HeaderList): void;
  /** Body bytes; `credit` must be called once the bytes were delivered to the client. */
  onData(chunk: Buffer, credit: () => void): void;
  onEnd(): void;
  /** The stream ended abnormally (device RESET, tunnel loss, refused by the device's GOAWAY). */
  onAbort(reason: StreamEnd): void;
  /** Queued request bytes went below the resume mark. */
  onWritable?(): void;
}

export interface OpenHead {
  readonly method: string;
  readonly path: string;
  readonly headers: HeaderList;
  readonly deadlineMs: number;
}

/** Resume reading a client body when less than this is queued for a stream. */
export const REQUEST_QUEUE_LOW_MARK = 256 * 1024;

class Stream {
  /** Device's window for our DATA. */
  sendWindow = INITIAL_STREAM_WINDOW;
  /** Our grant for the device's DATA. */
  recvWindow = INITIAL_STREAM_WINDOW;
  queue: Buffer[] = [];
  queued = 0;
  endQueued = false;
  localEnded = false;
  remoteEnded = false;
  responded = false;
  closed = false;
  /** Bytes received but not yet credited at connection level. */
  uncredited = 0;
  constructor(
    readonly id: number,
    readonly sink: StreamSink,
  ) {}
}

export class TunnelStream {
  constructor(
    private readonly tunnel: RelayTunnel,
    readonly id: number,
  ) {}
  /** Queue request body bytes (sent as the device's windows allow). */
  write(chunk: Buffer): void {
    this.tunnel.queueData(this.id, chunk);
  }
  end(): void {
    this.tunnel.queueEnd(this.id);
  }
  reset(code: ResetCode): void {
    this.tunnel.resetStream(this.id, code);
  }
  get queuedBytes(): number {
    return this.tunnel.queued(this.id);
  }
}

export type OpenResult =
  | { readonly ok: true; readonly stream: TunnelStream }
  | { readonly ok: false; readonly reason: "unavailable" | "busy" | "headers_too_large" };

export interface RelayTunnelOptions {
  readonly relayHost: string;
  readonly versions: readonly string[];
  readonly limits: Record<string, number>;
  readonly timing: TunnelTiming;
  readonly log: RelayLogger;
  readonly now: () => number;
  readonly authenticate: (hello: Hello, challenge: Buffer, tunnel: RelayTunnel) => Promise<HandshakeDecision>;
  readonly onReady: (tunnel: RelayTunnel) => void;
  /** The tunnel stopped accepting streams (peer or local GOAWAY) or closed. */
  readonly onUnroutable: (tunnel: RelayTunnel) => void;
  readonly onClosed: (tunnel: RelayTunnel) => void;
}

type State = "handshake" | "authenticating" | "ready" | "closed";

const validString = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && /^[\x20-\x7e]+$/.test(v);

export class RelayTunnel {
  readonly tunnelId = randomBytes(12).toString("base64url");
  readonly openedAt: number;
  private state: State = "handshake";
  private readonly challenge = randomBytes(CHALLENGE_BYTES);
  private hello: Hello | undefined;
  private lastStreamId = 0;
  private readonly streams = new Map<number, Stream>();
  private sendConnWindow = INITIAL_CONNECTION_WINDOW;
  private recvConnWindow = INITIAL_CONNECTION_WINDOW;
  private lastSent: number;
  private lastReceived: number;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private keepAlive: NodeJS.Timeout | undefined;
  private drainTimer: NodeJS.Timeout | undefined;
  private localGoAway: GoAwayCode | undefined;
  private peerGoAway: { readonly lastStream: number; readonly code: string } | undefined;
  private closing = false;
  private pumping = false;
  /** Every stream ever opened in this tunnel (diagnostics). */
  streamsOpened = 0;

  constructor(
    private readonly ws: WebSocketConnection,
    private readonly options: RelayTunnelOptions,
  ) {
    this.openedAt = options.now();
    this.lastSent = this.openedAt;
    this.lastReceived = this.openedAt;
    ws.attach({
      onMessage: (data, binary) => this.onMessage(data, binary),
      onTooLarge: () => this.protocolError("frame_too_large"),
      onClose: (code) => this.onSocketClosed(code),
    });
    this.handshakeTimer = setTimeout(
      () => this.fatal(CloseCode.HANDSHAKE_TIMEOUT, "handshake_timeout"),
      options.timing.handshakeMs,
    );
    this.handshakeTimer.unref();
    this.send(
      encodeJsonFrame(FrameType.CHALLENGE, 0, {
        versions: options.versions,
        relayHost: options.relayHost,
        challenge: this.challenge.toString("base64url"),
      }),
    );
  }

  get deviceId(): string | undefined {
    return this.state === "ready" || this.state === "closed" ? this.hello?.deviceId : undefined;
  }

  get software(): string | undefined {
    return this.hello?.software;
  }

  get isReady(): boolean {
    return this.state === "ready";
  }

  /** Accepts new streams: ready, no GOAWAY in either direction. */
  get routable(): boolean {
    return this.state === "ready" && !this.localGoAway && !this.peerGoAway && !this.closing;
  }

  get openStreams(): number {
    return this.streams.size;
  }

  get maxStreams(): number {
    return this.hello?.maxStreams ?? 0;
  }

  get phase(): "handshake" | "ready" | "draining" | "closed" {
    if (this.state === "closed") return "closed";
    if (this.state !== "ready") return "handshake";
    return this.routable ? "ready" : "draining";
  }

  // ---- streams -------------------------------------------------------------

  open(head: OpenHead, endStream: boolean, sink: StreamSink): OpenResult {
    if (!this.routable) return { ok: false, reason: "unavailable" };
    if (this.streams.size >= this.maxStreams) return { ok: false, reason: "busy" };
    if (this.lastStreamId >= MAX_STREAM_ID) return { ok: false, reason: "unavailable" };
    const id = this.lastStreamId + 1;
    let frame: Buffer;
    try {
      frame = encodeJsonFrame(
        FrameType.OPEN,
        id,
        {
          method: head.method,
          path: head.path,
          headers: head.headers,
          deadlineMs: Math.max(1, Math.floor(head.deadlineMs)),
        },
        endStream ? FLAG_END_STREAM : 0,
      );
    } catch {
      return { ok: false, reason: "headers_too_large" };
    }
    this.lastStreamId = id;
    this.streamsOpened++;
    const stream = new Stream(id, sink);
    stream.localEnded = endStream;
    stream.endQueued = endStream;
    this.streams.set(id, stream);
    this.send(frame);
    return { ok: true, stream: new TunnelStream(this, id) };
  }

  queued(id: number): number {
    return this.streams.get(id)?.queued ?? 0;
  }

  queueData(id: number, chunk: Buffer): void {
    const s = this.streams.get(id);
    if (!s || s.endQueued || chunk.length === 0) return;
    s.queue.push(chunk);
    s.queued += chunk.length;
    this.pump();
  }

  queueEnd(id: number): void {
    const s = this.streams.get(id);
    if (!s || s.endQueued) return;
    s.endQueued = true;
    this.pump();
  }

  /** A relay-initiated reset (client gone, deadline, limits); the sink is not called. */
  resetStream(id: number, code: ResetCode): void {
    const s = this.streams.get(id);
    if (!s) return;
    this.send(encodeJsonFrame(FrameType.RESET, id, { code }));
    this.closeStream(s);
  }

  // ---- flow control (relay → device) ---------------------------------------

  private pump(): void {
    if (this.pumping || this.state === "closed") return;
    this.pumping = true;
    try {
      let progress = true;
      while (progress) {
        progress = false;
        for (const s of this.streams.values()) {
          if (s.localEnded) continue;
          if (s.queue.length > 0) {
            const n = Math.min(MAX_DATA_PAYLOAD, s.sendWindow, this.sendConnWindow, s.queue[0]!.length);
            if (n <= 0) continue;
            const head = s.queue[0]!;
            const chunk = head.subarray(0, n);
            if (n === head.length) s.queue.shift();
            else s.queue[0] = head.subarray(n);
            s.queued -= n;
            s.sendWindow -= n;
            this.sendConnWindow -= n;
            const last = s.endQueued && s.queue.length === 0;
            if (last) s.localEnded = true;
            this.send(encodeFrame(FrameType.DATA, s.id, chunk, last ? FLAG_END_STREAM : 0));
            if (s.queued < REQUEST_QUEUE_LOW_MARK) s.sink.onWritable?.();
            progress = true;
            if (last) this.maybeComplete(s);
          } else if (s.endQueued) {
            s.localEnded = true;
            this.send(encodeFrame(FrameType.DATA, s.id, Buffer.alloc(0), FLAG_END_STREAM));
            this.maybeComplete(s);
            progress = true;
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Stop accepting streams; in-flight streams continue up to the drain limit, then are reset. */
  goAway(code: GoAwayCode): void {
    if (this.state === "closed" || this.localGoAway) return;
    if (this.state !== "ready") {
      this.fatal(code === "shutting_down" ? CloseCode.GOING_AWAY : CloseCode.NORMAL, code);
      return;
    }
    this.localGoAway = code;
    this.send(encodeJsonFrame(FrameType.GOAWAY, 0, { lastStream: this.lastStreamId, code }));
    this.options.log({ event: "tunnel.goaway_sent", tunnelId: this.tunnelId, deviceId: this.deviceId, code });
    this.options.onUnroutable(this);
    this.startDrain();
  }

  /** Close now: every open stream is lost. */
  terminate(code: number = CloseCode.GOING_AWAY, reason = ""): void {
    this.fatal(code, reason);
  }

  private startDrain(): void {
    if (this.drainTimer) return;
    this.closeIfDrained();
    if (this.state === "closed") return;
    this.drainTimer = setTimeout(() => {
      for (const s of [...this.streams.values()]) {
        this.resetStream(s.id, "shutting_down");
        s.sink.onAbort("shutting_down");
      }
      this.closeIfDrained();
    }, this.options.timing.drainMs);
    this.drainTimer.unref();
  }

  private closeIfDrained(): void {
    if (this.streams.size > 0 || this.state === "closed" || this.closing) return;
    if (!this.localGoAway && !this.peerGoAway) return;
    this.closing = true;
    const code = this.localGoAway === "shutting_down" ? CloseCode.GOING_AWAY : CloseCode.NORMAL;
    this.ws.close(code, this.localGoAway ?? "");
  }

  private send(frame: Buffer): void {
    if (this.state === "closed") return;
    this.lastSent = this.options.now();
    this.ws.send(frame);
  }

  /** Connection error: GOAWAY protocol_error (after READY) and close 4400. */
  private protocolError(code: string): void {
    if (this.state === "closed") return;
    this.options.log({ event: "tunnel.protocol_error", tunnelId: this.tunnelId, deviceId: this.deviceId, code });
    if (this.state === "ready")
      this.send(encodeJsonFrame(FrameType.GOAWAY, 0, { lastStream: this.lastStreamId, code: "protocol_error" }));
    this.fatal(CloseCode.PROTOCOL_ERROR, "protocol_error");
  }

  private fatal(closeCode: number, reason: string): void {
    if (this.state === "closed") return;
    this.closing = true;
    this.ws.close(closeCode, reason);
    this.shutdown(closeCode);
  }

  private onSocketClosed(code: number): void {
    this.shutdown(code);
  }

  private shutdown(closeCode: number): void {
    if (this.state === "closed") return;
    const wasReady = this.state === "ready";
    this.state = "closed";
    clearTimeout(this.handshakeTimer);
    clearInterval(this.keepAlive);
    clearTimeout(this.drainTimer);
    const lost = [...this.streams.values()];
    this.streams.clear();
    for (const s of lost) {
      s.closed = true;
      s.sink.onAbort("tunnel_lost");
    }
    this.options.log({
      event: "tunnel.closed",
      tunnelId: this.tunnelId,
      deviceId: wasReady ? this.hello?.deviceId : undefined,
      closeCode,
      durationMs: this.options.now() - this.openedAt,
      count: lost.length,
    });
    this.options.onClosed(this);
  }

  private startKeepAlive(): void {
    const t = this.options.timing;
    const tick = Math.max(10, Math.min(t.pingAfterIdleMs, t.deadAfterMs) / 4);
    this.keepAlive = setInterval(() => {
      const now = this.options.now();
      if (now - this.lastReceived >= t.deadAfterMs) {
        this.options.log({ event: "tunnel.dead", tunnelId: this.tunnelId, deviceId: this.deviceId });
        this.ws.terminate();
        this.shutdown(1006);
        return;
      }
      if (now - this.lastSent >= t.pingAfterIdleMs) this.send(encodeFrame(FrameType.PING, 0, randomBytes(8)));
    }, tick);
    this.keepAlive.unref();
  }

  // ---- receiving -------------------------------------------------------------

  private onMessage(data: Buffer, binary: boolean): void {
    if (this.state === "closed") return;
    this.lastReceived = this.options.now();
    if (!binary) return this.protocolError("text_message");
    let frame: Frame;
    try {
      frame = decodeFrame(data);
    } catch (error) {
      return this.protocolError(error instanceof TunnelProtocolError ? error.code : "malformed_frame");
    }
    try {
      if (this.state === "handshake") return this.onHandshakeFrame(frame);
      if (this.state === "authenticating") return this.protocolError("frame_before_ready");
      this.onFrame(frame);
    } catch (error) {
      this.protocolError(error instanceof TunnelProtocolError ? error.code : "internal");
    }
  }

  private onHandshakeFrame(frame: Frame): void {
    if (frame.type !== FrameType.HELLO || frame.stream !== 0 || frame.flags !== 0)
      return this.protocolError("expected_hello");
    const v = parseJsonPayload(frame.payload);
    const features = v.features ?? [];
    const proof = typeof v.proof === "string" && v.proof.length <= 128 ? Buffer.from(v.proof, "base64url") : undefined;
    if (
      !validString(v.deviceId, 64) ||
      !proof ||
      proof.length !== 64 ||
      proof.toString("base64url") !== v.proof ||
      !validString(v.software, 64) ||
      typeof v.maxStreams !== "number" ||
      !Number.isInteger(v.maxStreams) ||
      v.maxStreams < 1 ||
      v.maxStreams > 1024 ||
      !Array.isArray(features) ||
      features.length > 32 ||
      !features.every((f) => validString(f, 64))
    )
      return this.protocolError("invalid_hello");
    this.hello = {
      deviceId: v.deviceId,
      proof,
      software: v.software,
      maxStreams: v.maxStreams,
      features: features as string[],
    };
    this.state = "authenticating";
    this.options.authenticate(this.hello, this.challenge, this).then(
      (decision) => this.onDecision(decision),
      () => this.onDecision({ ok: false, closeCode: CloseCode.GOING_AWAY, reason: "internal_error" }),
    );
  }

  private onDecision(decision: HandshakeDecision): void {
    if (this.state !== "authenticating") return;
    if (!decision.ok) {
      this.options.log({
        event: "tunnel.refused",
        tunnelId: this.tunnelId,
        deviceId: this.hello?.deviceId,
        closeCode: decision.closeCode,
        code: decision.reason.split(";")[0],
      });
      this.fatal(decision.closeCode, decision.reason);
      return;
    }
    clearTimeout(this.handshakeTimer);
    this.state = "ready";
    this.send(
      encodeJsonFrame(FrameType.READY, 0, {
        tunnelId: this.tunnelId,
        limits: this.options.limits,
        features: decision.features,
      }),
    );
    this.startKeepAlive();
    this.options.log({
      event: "tunnel.ready",
      tunnelId: this.tunnelId,
      deviceId: this.hello!.deviceId,
      software: this.hello!.software,
      count: this.hello!.maxStreams,
    });
    this.options.onReady(this);
  }

  /** A frame for a stream id: the open stream, undefined when closed (ignore), error when never opened. */
  private streamFor(frame: Frame): Stream | undefined {
    if (frame.stream === 0) throw new TunnelProtocolError("stream_zero");
    if (frame.stream > this.lastStreamId) throw new TunnelProtocolError("unknown_stream");
    return this.streams.get(frame.stream);
  }

  private onFrame(frame: Frame): void {
    const end = (frame.flags & FLAG_END_STREAM) !== 0;
    if (end && frame.type !== FrameType.RESPONSE && frame.type !== FrameType.DATA)
      throw new TunnelProtocolError("reserved_flags");
    switch (frame.type) {
      case FrameType.RESPONSE:
        return this.onResponse(frame, end);
      case FrameType.DATA:
        return this.onData(frame, end);
      case FrameType.RESET:
        return this.onReset(frame);
      case FrameType.WINDOW:
        return this.onWindow(frame);
      case FrameType.PING:
        if (frame.stream !== 0 || frame.payload.length !== 8) throw new TunnelProtocolError("invalid_ping");
        this.send(encodeFrame(FrameType.PONG, 0, frame.payload));
        return;
      case FrameType.PONG:
        if (frame.stream !== 0 || frame.payload.length !== 8) throw new TunnelProtocolError("invalid_pong");
        return;
      case FrameType.GOAWAY:
        return this.onGoAway(frame);
      default:
        if (frame.type >= EXTENSION_TYPE_MIN) return; // no extension negotiated in v1
        throw new TunnelProtocolError(
          frame.type === FrameType.CHALLENGE ||
            frame.type === FrameType.HELLO ||
            frame.type === FrameType.READY ||
            frame.type === FrameType.OPEN
            ? "wrong_direction"
            : "unknown_type",
        );
    }
  }

  private onResponse(frame: Frame, end: boolean): void {
    if (frame.payload.length > MAX_JSON_PAYLOAD) throw new TunnelProtocolError("json_too_large");
    const s = this.streamFor(frame);
    if (!s) return;
    if (s.responded) throw new TunnelProtocolError("duplicate_response");
    let status: unknown;
    let headers: HeaderList | undefined;
    try {
      const v = parseJsonPayload(frame.payload);
      status = v.status;
      headers = parseHeaderList(v.headers);
    } catch {
      headers = undefined;
    }
    if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599 || !headers) {
      // Invalid head content: a stream error, the exchange's outcome is unknown.
      this.resetStream(s.id, "protocol_error");
      s.sink.onAbort("protocol_error");
      return;
    }
    s.responded = true;
    s.sink.onResponse(status, headers);
    if (end) this.remoteEnd(s);
  }

  private onData(frame: Frame, end: boolean): void {
    const n = frame.payload.length;
    if (n > MAX_DATA_PAYLOAD) throw new TunnelProtocolError("frame_too_large");
    if (n > this.recvConnWindow) throw new TunnelProtocolError("flow_control_error");
    const s = this.streamFor(frame);
    this.recvConnWindow -= n;
    if (!s) {
      // Crossed a RESET: ignored, but the connection credit is returned.
      if (n > 0) this.creditConnection(n);
      return;
    }
    if (!s.responded || s.remoteEnded) throw new TunnelProtocolError("unexpected_data");
    if (n > s.recvWindow) throw new TunnelProtocolError("flow_control_error");
    s.recvWindow -= n;
    if (n > 0) {
      s.uncredited += n;
      let credited = false;
      s.sink.onData(frame.payload, () => {
        if (credited || s.closed) return;
        credited = true;
        s.uncredited -= n;
        s.recvWindow += n;
        this.send(encodeWindow(s.id, n));
        this.creditConnection(n);
      });
    }
    if (end && !s.closed) this.remoteEnd(s);
  }

  private creditConnection(n: number): void {
    this.recvConnWindow += n;
    this.send(encodeWindow(0, n));
  }

  private onReset(frame: Frame): void {
    const s = this.streamFor(frame);
    if (!s) return;
    let code: ResetCode = "internal_error";
    try {
      const v = parseJsonPayload(frame.payload);
      if (isResetCode(v.code)) code = v.code;
    } catch {
      // A RESET with an unreadable payload still ends the stream.
    }
    this.closeStream(s);
    s.sink.onAbort(code);
  }

  private onWindow(frame: Frame): void {
    const increment = parseWindowIncrement(frame.payload);
    if (frame.stream === 0) {
      if (this.sendConnWindow + increment > MAX_WINDOW) throw new TunnelProtocolError("flow_control_error");
      this.sendConnWindow += increment;
    } else {
      const s = this.streamFor(frame);
      if (!s) return;
      if (s.sendWindow + increment > MAX_WINDOW) throw new TunnelProtocolError("flow_control_error");
      s.sendWindow += increment;
    }
    this.pump();
  }

  private onGoAway(frame: Frame): void {
    if (frame.stream !== 0) throw new TunnelProtocolError("invalid_goaway");
    const v = parseJsonPayload(frame.payload);
    const lastStream = v.lastStream;
    if (typeof lastStream !== "number" || !Number.isInteger(lastStream) || lastStream < 0)
      throw new TunnelProtocolError("invalid_goaway");
    const code = isGoAwayCode(v.code) ? v.code : "protocol_error";
    if (this.peerGoAway) return;
    this.peerGoAway = { lastStream, code };
    this.options.log({ event: "tunnel.goaway_received", tunnelId: this.tunnelId, deviceId: this.deviceId, code });
    this.options.onUnroutable(this);
    // Streams above lastStream were not processed by the device (AD-22 point 9).
    for (const s of [...this.streams.values()])
      if (s.id > lastStream) {
        this.closeStream(s);
        s.sink.onAbort("not_processed");
      }
    this.startDrain();
  }

  private remoteEnd(s: Stream): void {
    s.remoteEnded = true;
    s.sink.onEnd();
    this.maybeComplete(s);
  }

  private maybeComplete(s: Stream): void {
    if (s.localEnded && s.remoteEnded) this.closeStream(s);
  }

  private closeStream(s: Stream): void {
    if (s.closed) return;
    s.closed = true;
    this.streams.delete(s.id);
    if (s.uncredited > 0) {
      const n = s.uncredited;
      s.uncredited = 0;
      this.creditConnection(n);
    }
    s.queue = [];
    s.queued = 0;
    if (this.localGoAway || this.peerGoAway) this.closeIfDrained();
  }
}

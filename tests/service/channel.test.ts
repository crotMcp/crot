import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameReader } from "../../src/browser-bridge/protocol.js";
import { acceptChannel, ChannelError, connectChannel, type AuthenticatedChannel } from "../../src/service/channel.js";
import { listenExclusive, serviceEndpoint, type ServiceEndpoint } from "../../src/service/endpoints.js";
import { isWindows, waitFor } from "../helpers.js";

const credential = () => randomBytes(32).toString("base64url");

let dir: string;
let servers: net.Server[];
beforeEach(async () => {
  // Short base: Unix socket paths are limited to 103 bytes (macOS tmpdir is long).
  dir = await mkdtemp(path.join(isWindows ? os.tmpdir() : "/tmp", "crot-ch-"));
  servers = [];
});
afterEach(async () => {
  for (const s of servers) s.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Accepted {
  readonly channel: AuthenticatedChannel;
  readonly messages: unknown[];
  closed: boolean;
}

/** A server endpoint that authenticates with `secret` and records accepted channels and rejections. */
async function serve(secret: string, channel: "service" | "control" = "control") {
  const endpoint: ServiceEndpoint = serviceEndpoint(dir, channel, secret);
  const accepted: Accepted[] = [];
  const rejected: ChannelError[] = [];
  const server = await listenExclusive(endpoint, (socket) => {
    acceptChannel(socket, { channel, credential: secret, maxFrameBytes: 1 << 20, timeoutMs: 1_000 }).then(
      (c) => {
        const entry: Accepted = { channel: c, messages: [], closed: false };
        c.onmessage = (m) => {
          entry.messages.push(m);
          c.send({ echo: m });
        };
        c.onclose = () => (entry.closed = true);
        c.start();
        accepted.push(entry);
      },
      (e: ChannelError) => rejected.push(e),
    );
  });
  if (server === "in_use") throw new Error("in use");
  servers.push(server);
  return { endpoint, accepted, rejected };
}

function connectRaw(endpoint: ServiceEndpoint): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(endpoint.path);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

/** Read frames from a raw socket. */
function frames(socket: net.Socket) {
  const reader = new FrameReader(1 << 20);
  const got: unknown[] = [];
  let closed = false;
  socket.on("data", (c: Buffer) => {
    for (const body of reader.push(c)) got.push(JSON.parse(Buffer.from(body).toString("utf8")));
  });
  socket.on("close", () => (closed = true));
  socket.on("error", () => undefined);
  return { got, closed: () => closed };
}

const send = (socket: net.Socket, value: unknown) =>
  socket.write(encodeFrame(new TextEncoder().encode(JSON.stringify(value))));

/**
 * A man-in-the-middle relay between a client and the endpoint that can
 * record, replay, duplicate or modify the client's frames.
 */
async function relay(target: ServiceEndpoint, edit: (frames: Uint8Array[], index: number) => Uint8Array[]) {
  const name = `relay-${randomBytes(4).toString("hex")}`;
  const relayPath = isWindows ? `\\\\.\\pipe\\crot-test-${name}` : path.join(dir, `${name}.sock`);
  const recorded: Uint8Array[] = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(target.path);
    const reader = new FrameReader(1 << 20);
    let index = 0;
    upstream.on("data", (c) => client.write(c));
    client.on("data", (c: Buffer) => {
      for (const body of reader.push(c)) {
        recorded.push(body);
        for (const out of edit([body], index++)) upstream.write(encodeFrame(out));
      }
    });
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("close", end);
    upstream.on("close", end);
    client.on("error", end);
    upstream.on("error", end);
  });
  await new Promise<void>((r) => server.listen(relayPath, r));
  servers.push(server);
  return { path: relayPath, recorded };
}

describe("authenticated local channel (WP-20)", () => {
  it("authenticates both sides and carries messages in order", async () => {
    const secret = credential();
    const s = await serve(secret);
    const client = await connectChannel(s.endpoint.path, {
      channel: "control",
      credential: secret,
      maxFrameBytes: 1 << 20,
    });
    const answers: unknown[] = [];
    client.onmessage = (m) => answers.push(m);
    client.start();
    for (let i = 0; i < 5; i++) client.send({ i });
    await waitFor(() => answers.length === 5);
    expect(answers).toEqual([0, 1, 2, 3, 4].map((i) => ({ echo: { i } })));
    client.close();
  });

  it("rejects a peer with a wrong credential; the credential is never sent", async () => {
    const secret = credential();
    const s = await serve(secret);
    const wrong = credential();
    const r = await relay(s.endpoint, (f) => f);
    await expect(
      connectChannel(r.path, { channel: "control", credential: wrong, maxFrameBytes: 1 << 20 }),
    ).rejects.toMatchObject({ reason: "unauthenticated" });
    await waitFor(() => s.rejected.length === 1);
    expect(s.rejected[0]?.reason).toBe("unauthenticated");
    expect(s.accepted).toHaveLength(0);
    const wire = r.recorded.map((b) => Buffer.from(b).toString("utf8")).join("\n");
    expect(wire).not.toContain(wrong);
    expect(wire).not.toContain(secret);
  });

  it("rejects a peer without a credential (no handshake, garbage, a message without authentication)", async () => {
    const s = await serve(credential());
    // 1. Connects and sends nothing: the handshake times out.
    const silent = frames(await connectRaw(s.endpoint));
    await waitFor(() => silent.closed(), 5_000);
    // 2. Not the channel framing at all.
    const garbageSocket = await connectRaw(s.endpoint);
    const garbage = frames(garbageSocket);
    garbageSocket.write("GET / HTTP/1.1\r\n\r\n");
    await waitFor(() => garbage.closed(), 5_000);
    // 3. Skips the handshake and sends an application frame.
    const skipSocket = await connectRaw(s.endpoint);
    const skip = frames(skipSocket);
    send(skipSocket, { t: "m", s: 1, b: JSON.stringify({ t: "request", id: 1, method: "shutdown" }), h: "x" });
    await waitFor(() => skip.closed(), 5_000);
    // 4. An auth answer with a made-up proof.
    const forgedSocket = await connectRaw(s.endpoint);
    const forged = frames(forgedSocket);
    await waitFor(() => forged.got.length === 1);
    send(forgedSocket, {
      t: "auth",
      n: randomBytes(32).toString("base64url"),
      p: randomBytes(32).toString("base64url"),
    });
    await waitFor(() => forged.closed(), 5_000);
    expect(forged.got.at(-1)).toEqual({ t: "denied" });
    expect(s.accepted).toHaveLength(0);
    expect(s.rejected.length).toBeGreaterThanOrEqual(4);
  });

  it("a recorded handshake and session cannot be replayed on a new connection", async () => {
    const secret = credential();
    const s = await serve(secret);
    const r = await relay(s.endpoint, (f) => f);
    const client = await connectChannel(r.path, { channel: "control", credential: secret, maxFrameBytes: 1 << 20 });
    client.start();
    client.send({ t: "request", id: 1, method: "shutdown" });
    await waitFor(() => s.accepted[0]?.messages.length === 1);
    client.close();

    // Replay the client's recorded frames (auth + message) to a fresh connection.
    const replaySocket = await connectRaw(s.endpoint);
    const replay = frames(replaySocket);
    await waitFor(() => replay.got.length === 1); // a fresh challenge
    for (const body of r.recorded) replaySocket.write(encodeFrame(body));
    await waitFor(() => replay.closed(), 5_000);
    expect(replay.got).toContainEqual({ t: "denied" });
    expect(s.accepted).toHaveLength(1);
    expect(s.accepted[0]?.messages).toHaveLength(1);
  });

  it("a replayed, reordered or modified frame inside a connection closes it", async () => {
    const secret = credential();
    for (const attack of ["duplicate", "drop", "modify"] as const) {
      const s = await serve(secret);
      // Frame 0 is the auth answer; frames 1.. are messages.
      const r = await relay(s.endpoint, (f, index) => {
        if (index !== 2) return f;
        const body = f[0]!;
        if (attack === "duplicate") return [body, body];
        if (attack === "drop") return [];
        const frame = JSON.parse(Buffer.from(body).toString("utf8")) as { b: string };
        frame.b = JSON.stringify({ t: "request", id: 2, method: "shutdown" });
        return [new TextEncoder().encode(JSON.stringify(frame))];
      });
      const client = await connectChannel(r.path, { channel: "control", credential: secret, maxFrameBytes: 1 << 20 });
      client.start();
      client.send({ n: 1 });
      client.send({ n: 2 });
      client.send({ n: 3 });
      await waitFor(() => s.accepted[0]?.closed === true, 5_000);
      // Nothing after the attacked frame is delivered; a duplicate is not delivered twice.
      expect(s.accepted[0]?.messages, attack).toEqual(attack === "duplicate" ? [{ n: 1 }, { n: 2 }] : [{ n: 1 }]);
      for (const server of servers.splice(0)) server.close();
    }
  });

  it("the client rejects an endpoint that cannot prove the credential (no impersonation)", async () => {
    const s = await serve(credential());
    await expect(
      connectChannel(s.endpoint.path, { channel: "control", credential: credential(), maxFrameBytes: 1 << 20 }),
    ).rejects.toBeInstanceOf(ChannelError);
    // A fake endpoint that answers "ok" with a made-up proof.
    const fakePath = isWindows ? `\\\\.\\pipe\\crot-test-fake-${process.pid}` : path.join(dir, "fake.sock");
    const fake = net.createServer((socket) => {
      const reader = new FrameReader(1 << 20);
      send(socket, { t: "challenge", v: 1, c: "crot-control-v1", n: randomBytes(32).toString("base64url") });
      socket.on("data", (c: Buffer) => {
        if (reader.push(c).length > 0) send(socket, { t: "ok", p: randomBytes(32).toString("base64url") });
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((r) => fake.listen(fakePath, r));
    servers.push(fake);
    await expect(
      connectChannel(fakePath, { channel: "control", credential: credential(), maxFrameBytes: 1 << 20 }),
    ).rejects.toMatchObject({ reason: "unauthenticated" });
  });

  it("the shim and control endpoints use different labels: a shim credential never opens the control channel", async () => {
    const secret = credential();
    const s = await serve(secret, "control");
    await expect(
      connectChannel(s.endpoint.path, { channel: "service", credential: secret, maxFrameBytes: 1 << 20 }),
    ).rejects.toBeInstanceOf(ChannelError);
    expect(s.accepted).toHaveLength(0);
  });

  it.runIf(!isWindows)("POSIX endpoints are owner-only sockets (0600)", async () => {
    const s = await serve(credential());
    expect((await stat(s.endpoint.path)).mode & 0o777).toBe(0o600);
  });

  it("a second listener on the same endpoint gets in_use; a stale socket file is taken over", async () => {
    const secret = credential();
    const s = await serve(secret);
    expect(await listenExclusive(s.endpoint, () => undefined)).toBe("in_use");
    if (!isWindows) {
      // A crashed owner leaves its socket file behind.
      for (const server of servers.splice(0)) server.close();
      await waitFor(async () => (await stat(s.endpoint.path).catch(() => undefined)) === undefined);
      const stale = net.createServer();
      await new Promise<void>((r) => stale.listen(path.join(dir, "stale.sock"), r));
      // Simulate the leftover: a socket file nobody listens on.
      const { rename } = await import("node:fs/promises");
      await rename(path.join(dir, "stale.sock"), s.endpoint.path);
      stale.close();
      const taken = await listenExclusive(s.endpoint, () => undefined);
      expect(taken).not.toBe("in_use");
      if (taken !== "in_use") taken.close();
    }
  });
});

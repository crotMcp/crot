/**
 * The L1 Docker endpoint as a proxy (AD-20 point 9) against a MOCK daemon: a
 * Node HTTP server on a Unix socket that answers like the Docker API for the
 * routes used here. Covers forwarding (bodies, chunked bodies, keep-alive,
 * streaming), HTTP upgrades and hijacked streams, the 403 refusals with
 * their audit callback, the checks on existing containers and the container
 * profile. The real daemon over every transport is covered by
 * l1-docker-integration.test.ts (CROT_L1_REQUIRED=1).
 */
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerEndpoint, type DockerUpstream } from "../../../src/native-host/linux-l1/docker-endpoint.js";
import type { DockerBoundary } from "../../../src/native-host/linux-l1/docker-policy.js";

const posix = process.platform !== "win32";

interface Seen {
  method: string;
  url: string;
  body: string;
}

let dir: string;
let daemon: http.Server;
let daemonSocket: string;
let endpoint: DockerEndpoint | undefined;
let seen: Seen[];
let refusals: { request: string; reason: string }[];
/** Upgraded sockets leave the HTTP server: closed by the test. */
const hijacked = new Set<net.Socket>();

const CONTAINERS: Record<string, unknown> = {
  ok: { HostConfig: { Binds: [] }, Mounts: [] },
  priv: { HostConfig: { Privileged: true }, Mounts: [] },
  homebind: { HostConfig: {}, Mounts: [{ Type: "bind", Source: "/srv/data", RW: true }] },
};

function mockDaemon(socketPath: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, body });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const inspect = /^\/(?:v[\d.]+\/)?containers\/([^/]+)\/json$/.exec(url);
      if (url.endsWith("/info"))
        return json(200, { SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin"] });
      if (inspect?.[1] === "slow") return void setTimeout(() => json(200, CONTAINERS.ok), 150);
      if (inspect)
        return CONTAINERS[inspect[1]!]
          ? json(200, CONTAINERS[inspect[1]!])
          : json(404, { message: "No such container" });
      if (url.includes("/containers/create")) return json(201, { Id: "c1", received: JSON.parse(body) });
      if (/\/containers\/[^/]+\/exec$/.test(url)) return json(201, { Id: "e1" });
      if (url.includes("/logs")) {
        // A streamed response in several writes.
        res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
        res.write("line1\n");
        setTimeout(() => res.end("line2\n"), 20);
        return;
      }
      return json(200, { method: req.method, url });
    });
  });
  // Docker's hijack: 101 Switching Protocols, then raw bytes in both directions.
  server.on("upgrade", (req, socket: net.Socket, head: Buffer) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", body: "" });
    hijacked.add(socket);
    socket.on("close", () => hijacked.delete(socket));
    socket.on("error", () => socket.destroy()); // the client may already be gone
    // Like a container whose stdin was closed: it still writes its last output, then the stream ends.
    socket.on("end", () => socket.end("[stdin closed]"));
    socket.write(
      "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );
    if (head.length) socket.write(head.toString("latin1").toUpperCase());
    socket.on("data", (d: Buffer) => socket.write(d.toString("latin1").toUpperCase()));
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

function upstream(local: boolean): DockerUpstream {
  return {
    local,
    transport: "unix",
    connect: async () => {
      const { connect } = await import("node:net");
      return await new Promise((resolve, reject) => {
        const s = connect(daemonSocket);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
    },
  };
}

async function startEndpoint(local = true): Promise<DockerEndpoint> {
  const socketPath = path.join(dir, "ep.sock");
  const boundary: DockerBoundary = {
    writable: ["/home/u/ws"],
    protectedPaths: ["/home/u/.config/crot"],
    unreadable: ["/tmp"],
    daemonSockets: ["/var/run/docker.sock", daemonSocket],
    endpointSocket: socketPath,
  };
  endpoint = await DockerEndpoint.start({
    socketPath,
    upstream: upstream(local),
    boundary,
    containerProfile: "crot-l1-container-1",
    onRefusal: (request, reason) => refusals.push({ request, reason }),
  });
  return endpoint;
}

function request(
  method: string,
  url: string,
  body?: unknown,
  options: { chunked?: boolean; agent?: http.Agent } = {},
): Promise<{ status: number; json: unknown; text: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath: endpoint!.socketPath,
        method,
        path: url,
        headers: data
          ? options.chunked
            ? { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }
            : { "Content-Type": "application/json", "Content-Length": data.length }
          : {},
        ...(options.agent ? { agent: options.agent } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on("error", reject);
    if (data && options.chunked) {
      // Split the body over several chunks and writes.
      const mid = Math.floor(data.length / 2);
      req.write(data.subarray(0, mid));
      setTimeout(() => req.end(data.subarray(mid)), 10);
    } else req.end(data);
  });
}

/** An upgraded (hijacked) exchange: send `payload` after the 101 and collect the echo. */
function upgrade(url: string, payload: string, upgradeTo = "tcp"): Promise<{ status: number; echoed: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: endpoint!.socketPath,
      method: "POST",
      path: url,
      headers: { Connection: "Upgrade", Upgrade: upgradeTo, "Content-Type": "application/json" },
    });
    req.on("upgrade", (res, socket) => {
      let echoed = "";
      socket.on("data", (d: Buffer) => {
        echoed += d.toString("latin1");
        if (echoed.length >= payload.length) {
          socket.destroy();
          resolve({ status: res.statusCode ?? 0, echoed });
        }
      });
      socket.write(payload);
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, echoed: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

beforeEach(async () => {
  if (!posix) return;
  dir = await mkdtemp(path.join(os.tmpdir(), "crot-ep-"));
  daemonSocket = path.join(dir, "daemon.sock");
  seen = [];
  refusals = [];
  daemon = await mockDaemon(daemonSocket);
});
afterEach(async () => {
  if (!posix) return;
  await endpoint?.close();
  endpoint = undefined;
  for (const s of hijacked) s.destroy();
  await new Promise<void>((r) => {
    daemon.closeAllConnections();
    daemon.close(() => r());
  });
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)("Docker endpoint against a mock daemon", () => {
  it("forwards ordinary requests unchanged, including streamed responses", async () => {
    await startEndpoint();
    expect(await request("GET", "/v1.45/containers/json?all=1")).toMatchObject({
      status: 200,
      json: { method: "GET", url: "/v1.45/containers/json?all=1" },
    });
    expect(await request("POST", "/v1.45/images/create?fromImage=alpine")).toMatchObject({ status: 200 });
    expect((await request("GET", "/v1.45/containers/ok/logs?stdout=1")).text).toBe("line1\nline2\n");
  });

  it("keeps a keep-alive connection usable for several requests", async () => {
    await startEndpoint();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let i = 0; i < 3; i++) {
        expect((await request("GET", `/_ping?i=${i}`, undefined, { agent })).status).toBe(200);
        expect((await request("POST", "/containers/create", { Image: "x" }, { agent })).status).toBe(201);
      }
    } finally {
      agent.destroy();
    }
  });

  it("adds crot-l1-container-<v> for a local AppArmor daemon, also for chunked bodies", async () => {
    await startEndpoint(true);
    const r = await request("POST", "/v1.45/containers/create?name=a", {
      Image: "x",
      HostConfig: { NetworkMode: "host" },
    });
    expect(r.status).toBe(201);
    expect((r.json as { received: { HostConfig: unknown } }).received.HostConfig).toEqual({
      NetworkMode: "host",
      SecurityOpt: ["apparmor=crot-l1-container-1"],
    });
    const c = await request("POST", "/containers/create", { Image: "x" }, { chunked: true });
    expect((c.json as { received: { HostConfig: unknown } }).received.HostConfig).toEqual({
      SecurityOpt: ["apparmor=crot-l1-container-1"],
    });
  });

  it("never sets the profile for a daemon on another host", async () => {
    await startEndpoint(false);
    const r = await request("POST", "/containers/create", { Image: "x" });
    expect((r.json as { received: unknown }).received).toEqual({ Image: "x" });
  });

  it("refuses rule a-d requests with 403, a CROT reason and an audit callback, without contacting the daemon", async () => {
    await startEndpoint();
    const cases: [string, string, unknown, RegExp, string][] = [
      [
        "POST",
        "/containers/create",
        { HostConfig: { Binds: ["/etc:/e"] } },
        /inside the workspace/,
        "container.create",
      ],
      ["POST", "/containers/create", { HostConfig: { Privileged: true } }, /privileged/, "container.create"],
      ["POST", "/containers/create", { HostConfig: { PidMode: "host" } }, /host PID/, "container.create"],
      [
        "POST",
        "/containers/create",
        { HostConfig: { Binds: [`${daemonSocket}:/d.sock`] } },
        /daemon endpoint/,
        "container.create",
      ],
      ["POST", "/volumes/create", { DriverOpts: { o: "bind", device: "/etc" } }, /volume driver/, "volume.create"],
      ["POST", "/plugins/pull?remote=evil", [], /plugin installation/, "plugin.install"],
      ["POST", "/containers/ok/exec", { Cmd: ["sh"], Privileged: true }, /privileged/, "container.exec"],
      ["POST", "/build?securityopt=seccomp%3Dunconfined", undefined, /security option/, "build"],
    ];
    for (const [method, url, body, reason, kind] of cases) {
      seen = [];
      const r = await request(method, url, body);
      expect(r.status).toBe(403);
      expect((r.json as { message: string }).message).toMatch(/^CROT L1 Docker endpoint refused the request: /);
      expect((r.json as { message: string }).message).toMatch(reason);
      expect(refusals.at(-1)).toEqual({ request: kind, reason: expect.stringMatching(reason) });
      // Nothing of a refused request reaches the daemon (an inspect of an existing container may).
      expect(seen.filter((s) => !s.url.endsWith("/json"))).toEqual([]);
    }
    // The audit callback carries the request kind and reason only, never the payload.
    expect(JSON.stringify(refusals)).not.toContain("evil");
  });

  it("checks existing containers for exec, attach, archive and commit; list/inspect/logs stay allowed", async () => {
    await startEndpoint();
    expect((await request("POST", "/containers/ok/exec", { Cmd: ["ls"] })).status).toBe(201);
    for (const [method, url] of [
      ["POST", "/containers/priv/exec"],
      ["PUT", "/containers/priv/archive?path=/"],
      ["GET", "/containers/homebind/archive?path=/"],
      ["POST", "/commit?container=priv&repo=r"],
    ] as const) {
      const r = await request(method, url, method === "POST" && url.endsWith("exec") ? { Cmd: ["sh"] } : undefined);
      expect(r.status).toBe(403);
    }
    const attach = await upgrade("/containers/priv/attach?stream=1&stdin=1", "x");
    expect(attach.status).toBe(403);
    expect((await request("GET", "/containers/priv/json")).status).toBe(200);
    expect((await request("GET", "/containers/priv/logs")).status).toBe(200);
    expect((await request("GET", "/containers/json")).status).toBe(200);
    // VolumesFrom a container that does not pass.
    expect((await request("POST", "/containers/create", { HostConfig: { VolumesFrom: ["priv"] } })).status).toBe(403);
    expect(refusals.map((r) => r.request)).toEqual([
      "container.exec",
      "container.archive",
      "container.archive",
      "container.commit",
      "container.attach",
      "container.create",
    ]);
  });

  it("carries hijacked exec and attach streams in both directions", async () => {
    await startEndpoint();
    const exec = await upgrade("/v1.45/exec/e1/start", "hello exec");
    expect(exec).toEqual({ status: 101, echoed: "HELLO EXEC" });
    const attach = await upgrade("/containers/ok/attach?stream=1&stdin=1&stdout=1", "typed input");
    expect(attach).toEqual({ status: 101, echoed: "TYPED INPUT" });
  });

  it("keeps delivering the output after the client half-closes a hijacked stream (docker CLI CloseWrite)", async () => {
    // The docker CLI ends its write side once stdin is done (docker run -i, docker exec -i, at once without -i)
    // and keeps reading: the output that follows must still reach it (L1 workflow #14: attach output was empty).
    await startEndpoint();
    for (const url of ["/containers/ok/attach?stream=1&stdin=1&stdout=1", "/v1.45/exec/e1/start"]) {
      const out = await new Promise<string>((resolve, reject) => {
        const s = net.connect({ path: endpoint!.socketPath, allowHalfOpen: true });
        let text = "";
        s.on("data", (d: Buffer) => {
          text += d.toString("latin1");
          if (text.includes("\r\n\r\n") && !s.writableEnded) s.end(); // after the 101, like CloseWrite
        });
        s.on("end", () => resolve(text));
        s.on("error", reject);
        s.write(
          `POST ${url} HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n`,
        );
      });
      expect(out).toMatch(/^HTTP\/1\.1 101 /);
      expect(out.endsWith("[stdin closed]")).toBe(true);
    }
  });

  it("forwards the data that arrives while a container check is still waiting for the daemon", async () => {
    // docker cp sends the head of PUT .../archive and streams the tar right after it; the stdin of
    // docker exec/attach follows its head too. Nothing of it may be lost while the endpoint inspects
    // the container (L1 workflow #14: docker cp into a container hung, its body never completed).
    await startEndpoint();
    const archive = await new Promise<string>((resolve, reject) => {
      const s = net.connect({ path: endpoint!.socketPath, allowHalfOpen: true });
      let text = "";
      s.on("data", (d: Buffer) => (text += d.toString("latin1")));
      s.on("end", () => resolve(text));
      s.on("error", reject);
      s.write(
        "PUT /v1.44/containers/slow/archive?path=%2Ftmp HTTP/1.1\r\nHost: docker\r\nTransfer-Encoding: chunked\r\nContent-Type: application/x-tar\r\n\r\n5\r\nfirst\r\n",
      );
      setTimeout(() => s.end("6\r\nsecond\r\n0\r\n\r\n"), 30); // during the check
    });
    expect(archive).toMatch(/^HTTP\/1\.1 200 /);
    expect(seen.find((r) => r.method === "PUT")).toMatchObject({ body: "firstsecond" });
    const attach = await new Promise<string>((resolve, reject) => {
      const s = net.connect({ path: endpoint!.socketPath, allowHalfOpen: true });
      let text = "";
      s.on("data", (d: Buffer) => (text += d.toString("latin1")));
      s.on("end", () => resolve(text));
      s.on("error", reject);
      s.write(
        "POST /containers/slow/attach?stream=1&stdin=1&stdout=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\nearly-",
      );
      setTimeout(() => s.end("stdin"), 30); // during the check
    });
    expect(attach).toMatch(/^HTTP\/1\.1 101 /);
    expect(attach.endsWith("EARLY-STDIN[stdin closed]")).toBe(true);
  });

  it("ends a connection that the client half-closes before sending a request", async () => {
    await startEndpoint();
    const ended = await new Promise<boolean>((resolve) => {
      const s = net.connect({ path: endpoint!.socketPath, allowHalfOpen: true }, () => s.end());
      s.on("end", () => resolve(true));
      s.on("error", () => resolve(false));
    });
    expect(ended).toBe(true);
  });

  it("carries BuildKit /session and /grpc streams and closes a /grpc stream that requests security.insecure", async () => {
    await startEndpoint();
    expect(await upgrade("/session", "filesync payload security.insecure in a file", "h2c")).toMatchObject({
      status: 101,
    });
    expect(await upgrade("/grpc", "solve request", "h2c")).toEqual({ status: 101, echoed: "SOLVE REQUEST" });
    expect(refusals).toEqual([]);
    const insecure = new Promise<string>((resolve) => {
      const req = http.request({
        socketPath: endpoint!.socketPath,
        method: "POST",
        path: "/grpc",
        headers: { Connection: "Upgrade", Upgrade: "h2c" },
      });
      req.on("upgrade", (_res, socket) => {
        // The endpoint ends the stream (the client side may stay half-open).
        socket.on("end", () => resolve("closed"));
        socket.on("close", () => resolve("closed"));
        socket.resume();
        // The entitlement split across two writes.
        socket.write("entitlements: security.ins");
        setTimeout(() => socket.write("ecure"), 20);
      });
      req.end();
    });
    expect(await insecure).toBe("closed");
    expect(refusals).toEqual([
      { request: "grpc", reason: "the BuildKit entitlement security.insecure is not allowed" },
    ]);
  });

  it("creates its socket owner-only and removes it on close", async () => {
    const ep = await startEndpoint();
    const { stat } = await import("node:fs/promises");
    expect((await stat(ep.socketPath)).mode & 0o777).toBe(0o600);
    await ep.close();
    endpoint = undefined;
    await expect(stat(ep.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

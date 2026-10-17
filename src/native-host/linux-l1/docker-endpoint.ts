/**
 * The L1 Docker endpoint (ARCHITECTURE.md §27 AD-20 point 9).
 *
 * A Unix socket per Core in the L1 private storage, with the same path inside
 * and outside the sandbox. Confined Docker clients (CLI, Compose, Buildx,
 * Testcontainers, ...) reach the daemon only through it. Upstream it reaches
 * the daemon exactly as the service's Docker CLI does: a local Unix socket
 * directly, every other transport (TCP, TCP with TLS, SSH, contexts) through
 * `docker system dial-stdio` with the service's Docker environment, so TLS
 * keys and SSH connections stay in the service.
 *
 * Every request is forwarded, including streaming, attach, exec, logs and
 * build sessions (HTTP upgrades and hijacked connections). Refused, with HTTP
 * 403 and a CROT reason, are only the requests of rules a-d (docker-policy.ts);
 * each refusal is audited as confinement.docker_refused (request kind and
 * reason, no payload). On a daemon on this host that supports AppArmor,
 * containers are created under crot-l1-container-<v>.
 *
 * No configuration, no per-request choice, no PermissionEngine: docker.use
 * and AD-3 are unchanged.
 */
import { spawn, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import net from "node:net";
import { Duplex, type Readable, type Writable } from "node:stream";
import {
  checkBuildQuery,
  checkContainerCreate,
  checkExecCreate,
  checkHostConfig,
  checkInspectedMounts,
  checkServiceSpec,
  checkVolumeCreate,
  classify,
  INSECURE_ENTITLEMENT,
  Refusal,
  withContainerProfile,
  type ClassifiedRequest,
  type DockerBoundary,
} from "./docker-policy.js";
import { BodyReader, bodyFraming, header, parseHead, serializeHead, type RequestHead } from "./http-framing.js";

/** How the endpoint reaches the daemon. */
export interface DockerUpstream {
  /** A fresh byte stream to the daemon's API. */
  connect(): Promise<Duplex>;
  /** The daemon runs on this host (local Unix socket or loopback address). */
  readonly local: boolean;
  /** Upstream transport, for the host-network notes (AD-20 point 14). */
  readonly transport: "unix" | "tcp" | "tls" | "ssh" | "other";
  /** TCP port of a tcp:// daemon, for the notes. */
  readonly port?: number;
}

export interface DockerEndpointOptions {
  readonly socketPath: string;
  readonly upstream: DockerUpstream;
  readonly boundary: DockerBoundary;
  /** crot-l1-container-<v>. */
  readonly containerProfile: string;
  readonly onRefusal: (request: string, reason: string) => void;
}

const BODY_INSPECTED = new Set([
  "container.create",
  "container.exec",
  "volume.create",
  "service.create",
  "service.update",
]);
const CONTAINER_CHECKED = new Set(["container.exec", "container.attach", "container.archive", "container.commit"]);

function forbidden(reason: string): Buffer {
  const body = JSON.stringify({ message: `CROT L1 Docker endpoint refused the request: ${reason}` });
  return Buffer.from(
    `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    "latin1",
  );
}

/** Whether the request takes over the connection after its response (upgrade or Docker hijack). */
function hijacks(head: RequestHead, kind: ClassifiedRequest["kind"]): boolean {
  if (header(head, "upgrade")) return true;
  if (kind === "container.attach" || kind === "session" || kind === "grpc") return true;
  return /^\/(v\d+(\.\d+)?\/)?exec\/[^/]+\/start(\?|$)/.test(head.target);
}

/** One request/response on a fresh upstream connection (inspect calls). */
async function upstreamGetJson(upstream: DockerUpstream, target: string): Promise<{ status: number; json: unknown }> {
  const conn = await upstream.connect();
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("the daemon did not answer"));
    }, 15_000);
    conn.on("data", (c: Buffer) => chunks.push(c));
    conn.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    conn.on("end", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks);
      const sep = text.indexOf("\r\n\r\n");
      const headText = text.subarray(0, Math.max(0, sep)).toString("latin1");
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(headText)?.[1] ?? 0);
      let body: Buffer = text.subarray(sep + 4);
      if (/\r\ntransfer-encoding:\s*chunked/i.test(headText)) {
        const reader = new BodyReader({ kind: "chunked" }, true);
        reader.feed(body);
        body = reader.body();
      }
      let json: unknown = null;
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        json = null;
      }
      resolve({ status, json });
    });
    conn.write(`GET ${target} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`);
  });
}

export interface DockerEndpointTransport {
  close(): Promise<void>;
  closeSync(): void;
}

export class DockerEndpoint {
  private readonly connections = new Set<Duplex>();
  private apparmorDaemon: boolean | undefined;

  private constructor(
    private readonly transport: DockerEndpointTransport,
    private readonly options: DockerEndpointOptions,
  ) {}

  static async start(options: DockerEndpointOptions): Promise<DockerEndpoint> {
    await rm(options.socketPath, { force: true });
    // Half-open: the Docker CLI closes its write side of a hijacked attach/exec stream once its stdin
    // is done (at once without -i) and keeps reading the output; Node would otherwise end our side too.
    const server = net.createServer({ allowHalfOpen: true });
    const endpoint = new DockerEndpoint(
      {
        close: async () => {
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rm(options.socketPath, { force: true });
        },
        closeSync: () => {
          server.close();
        },
      },
      options,
    );
    server.on("connection", (socket) => endpoint.handle(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(options.socketPath, 0o600);
    return endpoint;
  }

  /** Attach an already-owned transport. This never removes/chmods its address. */
  static async startOwned(
    options: DockerEndpointOptions,
    listen: (accept: (connection: Duplex) => void) => Promise<DockerEndpointTransport>,
  ): Promise<DockerEndpoint> {
    const waiting: Duplex[] = [];
    let accept = (stream: Duplex) => {
      stream.pause();
      waiting.push(stream);
    };
    const transport = await listen((stream) => accept(stream));
    const endpoint = new DockerEndpoint(transport, options);
    accept = (stream) => endpoint.handle(stream);
    for (const stream of waiting) {
      endpoint.handle(stream);
      stream.resume();
    }
    return endpoint;
  }

  get socketPath(): string {
    return this.options.socketPath;
  }

  async close(): Promise<void> {
    for (const c of this.connections) c.destroy();
    await this.transport.close();
  }

  closeSync(): void {
    for (const c of this.connections) c.destroy();
    this.transport.closeSync();
  }

  /** Whether the daemon reports AppArmor support (cached after the first answer). */
  async daemonSupportsAppArmor(): Promise<boolean> {
    if (this.apparmorDaemon !== undefined) return this.apparmorDaemon;
    try {
      const { status, json } = await upstreamGetJson(this.options.upstream, "/info");
      if (status !== 200) return false;
      const opts = (json as { SecurityOptions?: unknown }).SecurityOptions;
      this.apparmorDaemon =
        Array.isArray(opts) && opts.some((o) => typeof o === "string" && /(^|,)name=apparmor(,|$)/.test(o));
      return this.apparmorDaemon;
    } catch {
      return false;
    }
  }

  private refuse(socket: Duplex, kind: string, reason: string): void {
    this.options.onRefusal(kind, reason);
    socket.end(forbidden(reason));
  }

  /** Rules a-d on an existing container (exec, attach, archive, commit, VolumesFrom). */
  private async checkExisting(container: string, where: string): Promise<void> {
    const { status, json } = await upstreamGetJson(
      this.options.upstream,
      `/containers/${encodeURIComponent(container)}/json`,
    );
    if (status !== 200 || !json || typeof json !== "object") return; // the daemon answers the request itself (404, ...)
    const c = json as { HostConfig?: Record<string, unknown>; Mounts?: unknown };
    checkHostConfig(this.options.boundary, c.HostConfig, where);
    checkInspectedMounts(this.options.boundary, c.Mounts, where);
  }

  private handle(socket: Duplex): void {
    this.connections.add(socket);
    socket.on("close", () => this.connections.delete(socket));
    socket.on("error", () => socket.destroy());
    let upstream: Duplex | undefined;
    let buffer: Buffer = Buffer.alloc(0);
    let busy = false;
    let raw = false;
    /** Body of the current request being streamed through (not inspected). */
    let streaming: BodyReader | undefined;
    let scanInsecure = false;
    let scanTail = Buffer.alloc(0);

    let ended = false;
    /** The client has ended its side (FIN): passed on to the daemon, the answer still flows back. */
    let clientEnded = false;
    /** Refuse and end the connection: nothing after a refused request on it is processed. */
    const refuse = (kind: string, reason: string) => {
      ended = true;
      buffer = Buffer.alloc(0);
      this.refuse(socket, kind, reason);
    };

    const closeAll = () => {
      socket.destroy();
      upstream?.destroy();
    };

    const ensureUpstream = async (): Promise<Duplex> => {
      if (upstream) return upstream;
      const u = await this.options.upstream.connect();
      upstream = u;
      u.on("data", (chunk: Buffer) => {
        if (!socket.write(chunk)) {
          u.pause();
          socket.once("drain", () => u.resume());
        }
      });
      u.on("end", () => socket.end());
      u.on("error", () => closeAll());
      u.on("close", () => socket.end());
      socket.on("close", () => u.destroy());
      return u;
    };

    const toUpstream = (data: Buffer) => {
      if (!upstream || data.length === 0) return;
      if (scanInsecure) {
        const window = Buffer.concat([scanTail, data]);
        if (window.includes(INSECURE_ENTITLEMENT)) {
          this.options.onRefusal("grpc", "the BuildKit entitlement security.insecure is not allowed");
          closeAll();
          return;
        }
        scanTail = window.subarray(Math.max(0, window.length - INSECURE_ENTITLEMENT.length));
      }
      if (!upstream.write(data)) {
        socket.pause();
        upstream.once("drain", () => socket.resume());
      }
    };

    const process = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        while (buffer.length > 0) {
          if (raw) {
            toUpstream(buffer);
            buffer = Buffer.alloc(0);
            return;
          }
          if (streaming) {
            const n = streaming.feed(buffer);
            toUpstream(buffer.subarray(0, n));
            buffer = buffer.subarray(n);
            if (streaming.done) streaming = undefined;
            continue;
          }
          const parsed = parseHead(buffer);
          if (!parsed) return;
          const { head } = parsed;
          // Data that arrives while a check or the daemon connection is awaited is appended to
          // `buffer`; what follows the head is therefore taken from `buffer` after each await, not
          // from `parsed.rest` (a view of the buffer as it was before).
          const headLength = buffer.length - parsed.rest.length;
          const request = classify(head.method, head.target);
          const framing = bodyFraming(head);
          if (request.kind === "plugin.install") {
            refuse(request.kind, "plugin installation is not allowed");
            return;
          }
          try {
            if (request.kind === "build") checkBuildQuery(request.query);
            if (CONTAINER_CHECKED.has(request.kind) && request.container)
              await this.checkExisting(request.container, `container ${request.container}`);
          } catch (error) {
            if (error instanceof Refusal) {
              refuse(request.kind, error.message);
              return;
            }
            throw error;
          }
          if (BODY_INSPECTED.has(request.kind)) {
            const reader = new BodyReader(framing, true);
            const n = reader.feed(buffer.subarray(headLength));
            if (!reader.done) return; // wait for the whole body (buffer still holds head + partial body)
            let body: Buffer = reader.body();
            try {
              const json = body.length > 0 ? (JSON.parse(body.toString("utf8")) as Record<string, unknown>) : {};
              if (request.kind === "container.create") {
                const { volumesFrom } = checkContainerCreate(this.options.boundary, json);
                for (const other of volumesFrom) await this.checkExisting(other, `volumes from ${other}`);
                if (
                  this.options.containerProfile &&
                  this.options.upstream.local &&
                  (await this.daemonSupportsAppArmor())
                ) {
                  body = Buffer.from(JSON.stringify(withContainerProfile(json, this.options.containerProfile)), "utf8");
                }
              } else if (request.kind === "container.exec") checkExecCreate(json);
              else if (request.kind === "volume.create") checkVolumeCreate(this.options.boundary, json);
              else checkServiceSpec(this.options.boundary, json);
            } catch (error) {
              if (error instanceof Refusal) {
                refuse(request.kind, error.message);
                return;
              }
              if (!(error instanceof SyntaxError)) throw error;
              // Not JSON: the daemon rejects it itself.
            }
            const u = await ensureUpstream();
            u.write(serializeHead(head, { "Content-Length": String(body.length), "Transfer-Encoding": null }));
            u.write(body);
            buffer = buffer.subarray(headLength + n);
            continue;
          }
          const u = await ensureUpstream();
          u.write(head.raw);
          buffer = buffer.subarray(headLength);
          if (hijacks(head, request.kind)) {
            // After the request (and its body, if any) the connection carries raw streams.
            // BuildKit entitlements travel in the Solve request of the control API (/grpc); /session
            // carries the build context and is not scanned (it would match file contents).
            scanInsecure = request.kind === "grpc";
            if (framing.kind !== "none") {
              const reader = new BodyReader(framing, false);
              const n = reader.feed(buffer);
              toUpstream(buffer.subarray(0, n));
              buffer = buffer.subarray(n);
            }
            raw = true;
            continue;
          }
          streaming = new BodyReader(framing, false);
          if (streaming.done) streaming = undefined;
        }
      } catch {
        closeAll();
      } finally {
        busy = false;
        if (clientEnded) passEnd();
      }
    };

    /** After the client's FIN: end the daemon connection once everything before it was forwarded, or our side if there is none. */
    const passEnd = () => {
      if (upstream) {
        if (!upstream.writableEnded) upstream.end();
      } else if (!socket.writableEnded) socket.end();
    };

    socket.on("data", (chunk: Buffer) => {
      if (ended) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      void process().then(() => {
        // Data that arrived while a check was waiting for the daemon.
        if (buffer.length > 0 && !busy) void process();
      });
    });
    socket.on("end", () => {
      clientEnded = true;
      if (!busy) passEnd();
    });
  }
}

/** Parse the upstream host of the service's Docker CLI into a transport. */
export function upstreamTransport(host: string): {
  transport: DockerUpstream["transport"];
  local: boolean;
  unixPath?: string;
  port?: number;
} {
  if (host.startsWith("unix://")) return { transport: "unix", local: true, unixPath: host.slice(7) };
  if (host.startsWith("ssh://")) return { transport: "ssh", local: false };
  const m = /^(tcp|https?):\/\/(\[[^\]]+\]|[^:/]+)(?::(\d+))?/.exec(host);
  if (m) {
    const name = m[2]!.replace(/^\[|\]$/g, "");
    const loopback = name === "localhost" || /^127\./.test(name) || name === "::1";
    return { transport: "tcp", local: loopback, ...(m[3] ? { port: Number(m[3]) } : {}) };
  }
  return { transport: "other", local: false };
}

/**
 * The upstream of the service's Docker CLI. `host` is the resolved daemon host
 * (DOCKER_HOST, else the current context's host, else the default socket);
 * `tls` whether the CLI would use TLS (DOCKER_TLS_VERIFY / context TLS data).
 */
export function createUpstream(options: {
  readonly host: string;
  readonly tls: boolean;
  /** The service's Docker environment (DOCKER_HOST, DOCKER_CONTEXT, DOCKER_CONFIG, DOCKER_CERT_PATH, ...). */
  readonly env: Readonly<Record<string, string>>;
  /** docker executable (resolved on the service's PATH). */
  readonly docker: string;
}): DockerUpstream {
  const parsed = upstreamTransport(options.host);
  const transport = parsed.transport === "tcp" && options.tls ? "tls" : parsed.transport;
  if (parsed.transport === "unix" && parsed.unixPath) {
    const unixPath = parsed.unixPath;
    return {
      local: true,
      transport,
      connect: () =>
        new Promise((resolve, reject) => {
          const s = net.connect(unixPath);
          s.once("connect", () => {
            s.off("error", reject);
            resolve(s);
          });
          s.once("error", reject);
        }),
    };
  }
  return {
    local: parsed.local,
    transport,
    ...(parsed.port !== undefined ? { port: parsed.port } : {}),
    connect: async () => {
      // Exactly the CLI's own connection (TCP, TLS, SSH, contexts): docker system dial-stdio.
      const child = spawn(options.docker, ["system", "dial-stdio"], {
        env: { ...options.env },
        stdio: ["pipe", "pipe", "ignore"],
      });
      return dialStdioStream(child);
    },
  };
}

/**
 * The byte stream of one `docker system dial-stdio` process. The connection
 * ends when dial-stdio closes its stdout (the CLI does that when the daemon
 * closes the connection, and then exits): the readable side ends after every
 * byte it wrote has been delivered. Its stdin closing with the exit is that
 * same end, not an error (Duplex.from reported it as ERR_STREAM_PREMATURE_CLOSE
 * and could discard the unread answer). A write after the exit fails as on a
 * closed socket. The stream closes once dial-stdio has exited and its output
 * has been read.
 */
function dialStdioStream(
  child: ChildProcessWithoutNullStreams | ChildProcessByStdio<Writable, Readable, null>,
): Duplex {
  const { stdin, stdout } = child;
  const duplex = new Duplex({
    read() {
      stdout.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      if (!stdin.writable) {
        callback(Object.assign(new Error("docker system dial-stdio has exited"), { code: "EPIPE" }));
        return;
      }
      stdin.write(chunk, (error) => callback(error ?? null));
    },
    final(callback) {
      stdin.end();
      callback();
    },
    destroy(error, callback) {
      stdout.destroy();
      stdin.destroy();
      child.kill();
      callback(error);
    },
  });
  stdout.on("data", (chunk: Buffer) => {
    if (!duplex.push(chunk)) stdout.pause();
  });
  stdout.on("end", () => duplex.push(null));
  stdout.on("error", (error) => duplex.destroy(error));
  // EPIPE when dial-stdio exits while a write is pending: that write's callback reports it.
  stdin.on("error", () => undefined);
  child.on("error", (error) => duplex.destroy(error));
  // Closed once dial-stdio has exited and every byte it wrote has been read.
  let exited = false;
  let delivered = false;
  const done = () => {
    if (exited && delivered) duplex.destroy();
  };
  child.on("close", () => {
    exited = true;
    done();
  });
  duplex.on("end", () => {
    delivered = true;
    done();
  });
  return duplex;
}

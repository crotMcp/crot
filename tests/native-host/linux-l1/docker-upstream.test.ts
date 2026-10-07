/**
 * Upstream transports of the Docker endpoint (AD-20 point 9). A local Unix
 * socket is connected directly; every other transport (TCP, TLS, SSH,
 * contexts) goes through `docker system dial-stdio` with the service's Docker
 * environment. FIXTURE: a fake `docker` executable that implements
 * dial-stdio against a local HTTP server and records its arguments and
 * environment. The real CLI and daemon: l1-docker-integration.test.ts.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUpstream, upstreamTransport } from "../../../src/native-host/linux-l1/docker-endpoint.js";
import { currentContextHost, dockerHiddenPaths, unixSocketOf } from "../../../src/native-host/linux-l1/layout.js";

const posix = process.platform !== "win32";

describe("upstreamTransport", () => {
  it("recognises every transport and whether the daemon is on this host", () => {
    expect(upstreamTransport("unix:///var/run/docker.sock")).toEqual({
      transport: "unix",
      local: true,
      unixPath: "/var/run/docker.sock",
    });
    expect(upstreamTransport("tcp://127.0.0.1:2375")).toEqual({ transport: "tcp", local: true, port: 2375 });
    expect(upstreamTransport("tcp://localhost:2376")).toMatchObject({ local: true });
    expect(upstreamTransport("tcp://[::1]:2375")).toMatchObject({ local: true });
    expect(upstreamTransport("tcp://10.0.0.5:2376")).toEqual({ transport: "tcp", local: false, port: 2376 });
    expect(upstreamTransport("ssh://me@build-host")).toEqual({ transport: "ssh", local: false });
    expect(upstreamTransport("npipe:////./pipe/docker_engine")).toEqual({ transport: "other", local: false });
  });

  it("labels TCP with TLS as tls", () => {
    const tls = createUpstream({ host: "tcp://10.0.0.5:2376", tls: true, env: {}, docker: "docker" });
    expect(tls).toMatchObject({ transport: "tls", local: false, port: 2376 });
    expect(createUpstream({ host: "unix:///x.sock", tls: false, env: {}, docker: "docker" })).toMatchObject({
      transport: "unix",
      local: true,
    });
  });
});

let dir: string;
let server: http.Server;
let daemonSocket: string;

beforeEach(async () => {
  if (!posix) return;
  dir = await mkdtemp(path.join(os.tmpdir(), "crot-up-"));
  daemonSocket = path.join(dir, "d.sock");
  server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ url: req.url }));
  });
  await new Promise<void>((r) => server.listen(daemonSocket, () => r()));
});
afterEach(async () => {
  if (!posix) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

const roundTrip = (conn: Duplex, target: string) =>
  new Promise<string>((resolve, reject) => {
    let out = "";
    conn.on("data", (d: Buffer) => (out += d.toString()));
    conn.on("end", () => resolve(out));
    conn.on("error", reject);
    conn.write(`GET ${target} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`);
  });

describe.skipIf(!posix)("createUpstream", () => {
  it("connects a local Unix socket directly", async () => {
    const up = createUpstream({ host: `unix://${daemonSocket}`, tls: false, env: {}, docker: "/nonexistent/docker" });
    expect(await roundTrip(await up.connect(), "/_ping")).toContain('{"url":"/_ping"}');
  });

  for (const host of ["ssh://me@build-host", "tcp://10.0.0.5:2376", "tcp://127.0.0.1:2375"]) {
    it(`reaches ${host} through docker system dial-stdio with the service's Docker environment (fixture CLI)`, async () => {
      const record = path.join(dir, "record.json");
      const fake = path.join(dir, "docker");
      await writeFile(
        fake,
        `#!${process.execPath}
const net = require("node:net");
require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
if (process.argv[2] !== "system" || process.argv[3] !== "dial-stdio") process.exit(2);
const s = net.connect(${JSON.stringify(daemonSocket)});
process.stdin.pipe(s);
s.pipe(process.stdout);
`,
      );
      await chmod(fake, 0o755);
      const env = {
        DOCKER_HOST: host,
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "/home/u/.docker/certs",
        SSH_AUTH_SOCK: "/run/user/1000/ssh.sock",
        PATH: process.env.PATH ?? "",
      };
      const up = createUpstream({ host, tls: host.includes("2376"), env, docker: fake });
      expect(await roundTrip(await up.connect(), "/v1.45/info")).toContain('{"url":"/v1.45/info"}');
      const seen = JSON.parse(await readFile(record, "utf8")) as { argv: string[]; env: Record<string, string> };
      expect(seen.argv).toEqual(["system", "dial-stdio"]);
      // The TLS material and SSH agent stay with the service: dial-stdio runs with its environment.
      expect(seen.env).toMatchObject({
        DOCKER_HOST: host,
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "/home/u/.docker/certs",
        SSH_AUTH_SOCK: "/run/user/1000/ssh.sock",
      });
    });
  }
});

describe.skipIf(!posix)("createUpstream: the end of a dial-stdio connection", () => {
  /** A fixture CLI like the one above that also records when it has exited. */
  async function fixtureCli(exited: string): Promise<string> {
    const fake = path.join(dir, "docker-exits");
    await writeFile(
      fake,
      `#!${process.execPath}
const net = require("node:net");
process.on("exit", () => require("node:fs").writeFileSync(${JSON.stringify(exited)}, "1"));
if (process.argv[2] !== "system" || process.argv[3] !== "dial-stdio") process.exit(2);
const s = net.connect(${JSON.stringify(daemonSocket)});
process.stdin.pipe(s);
s.pipe(process.stdout);
`,
    );
    await chmod(fake, 0o755);
    return fake;
  }

  it("delivers the whole answer and ends without an error when it is read after dial-stdio exited", async () => {
    // The daemon closes the connection (Connection: close), dial-stdio exits, and only then is the answer
    // read (a busy event loop, or the endpoint waiting for a slow client). Duplex.from reported the exit as
    // ERR_STREAM_PREMATURE_CLOSE and discarded the unread answer.
    for (const host of ["ssh://me@build-host", "tcp://10.0.0.5:2376", "tcp://127.0.0.1:2375"]) {
      const exited = path.join(dir, "exited");
      await rm(exited, { force: true });
      const fake = await fixtureCli(exited);
      const conn = await createUpstream({
        host,
        tls: host.includes("2376"),
        env: { PATH: process.env.PATH ?? "" },
        docker: fake,
      }).connect();
      const errors: Error[] = [];
      conn.on("error", (e: Error) => errors.push(e));
      conn.pause();
      conn.write("GET /v1.45/info HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n");
      const deadline = Date.now() + 10_000;
      while (!(await readFile(exited, "utf8").catch(() => ""))) {
        if (Date.now() > deadline) throw new Error("the fixture CLI did not exit");
        await new Promise((r) => setTimeout(r, 10));
      }
      // Let the service side see the exit (stdin and stdout of the child closed) before reading.
      await new Promise((r) => setTimeout(r, 100));
      let out = "";
      const ended = new Promise<void>((resolve, reject) => {
        conn.on("data", (d: Buffer) => (out += d.toString()));
        conn.on("end", () => resolve());
        conn.on("error", reject);
      });
      conn.resume();
      await ended;
      expect(out, host).toMatch(/^HTTP\/1\.1 200 /);
      expect(out, host).toContain('{"url":"/v1.45/info"}');
      await new Promise<void>((resolve) => (conn.closed ? resolve() : conn.once("close", () => resolve())));
      expect(errors, host).toEqual([]);
    }
  });

  it("still reports a dial-stdio that cannot be started", async () => {
    const conn = await createUpstream({
      host: "tcp://10.0.0.5:2376",
      tls: true,
      env: { PATH: process.env.PATH ?? "" },
      docker: path.join(dir, "no-such-docker"),
    }).connect();
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => conn.once("error", resolve));
    expect(error.code).toBe("ENOENT");
  });
});

describe.skipIf(!posix)("Docker contexts (fixture context store)", () => {
  it("reads the current context's host from DOCKER_CONTEXT or config.json, and hides its socket", async () => {
    const home = path.join(dir, "home");
    const store = path.join(home, ".docker");
    const id = createHash("sha256").update("rootless").digest("hex");
    await mkdir(path.join(store, "contexts", "meta", id), { recursive: true });
    await writeFile(
      path.join(store, "contexts", "meta", id, "meta.json"),
      JSON.stringify({ Name: "rootless", Endpoints: { docker: { Host: "unix:///run/user/1000/docker.sock" } } }),
    );
    await writeFile(path.join(store, "config.json"), JSON.stringify({ currentContext: "rootless" }));
    expect(await currentContextHost({}, home)).toBe("unix:///run/user/1000/docker.sock");
    expect(await currentContextHost({ DOCKER_CONTEXT: "default" }, home)).toBeUndefined();
    expect(await currentContextHost({ DOCKER_CONTEXT: "missing" }, home)).toBeUndefined();
    expect(unixSocketOf("unix:///run/user/1000/docker.sock")).toBe("/run/user/1000/docker.sock");
    const hidden = await dockerHiddenPaths({ DOCKER_HOST: "unix:///srv/d.sock", DOCKER_CERT_PATH: "/certs" }, home);
    expect(hidden).toEqual(
      expect.arrayContaining([
        "/var/run/docker.sock",
        "/run/podman/podman.sock",
        "/run/containerd/containerd.sock",
        "/srv/d.sock",
        "/run/user/1000/docker.sock",
        "/certs",
        path.join(store, "key.pem"),
        path.join(store, "contexts", "tls"),
      ]),
    );
  });
});

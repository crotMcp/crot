/**
 * REAL integration tests of the L1 Docker endpoint (AD-20 point 9) against
 * the runner's Docker daemon, run by the L1 workflow with CROT_L1_REQUIRED=1.
 * Every daemon transport the service's Docker CLI can use is exercised end to
 * end: the default Unix socket, TCP on loopback, TLS (client certificates),
 * SSH (sshd on localhost, set up by the workflow: CROT_L1_DOCKER_SSH) and a
 * Docker context. For each one a confined command runs the real docker CLI
 * inside L1: an allowed operation succeeds (including attach, i.e. the
 * upgrade/hijack path), a non-compliant one is refused with HTTP 403 and
 * audited as confinement.docker_refused, and the daemon's own socket or
 * credentials are not reachable. The TCP and TLS daemons are Node proxies in
 * this process in front of the real daemon socket (the runner's dockerd
 * listens only on Unix); the daemon, CLI, containers and AppArmor are real.
 * Mocked daemon: docker-endpoint.test.ts; fake CLI: docker-upstream.test.ts.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profileNames } from "../../../src/native-host/linux-l1/components.js";
import { readHostFacts } from "../../../src/native-host/linux-l1/host.js";
import { assertAvailable, l1Fixture, type L1Fixture } from "./l1-harness.js";
import { isLinux, l1Required } from "./l1-support.js";

const run = isLinux && l1Required;
const IMAGE = "alpine:3.20";
const REFUSED = "CROT L1 Docker endpoint refused";
const { container: containerProfile } = profileNames();
const DAEMON_SOCKET = "/var/run/docker.sock";

function hostDocker(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("docker", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * A TCP (optionally TLS) listener on loopback that forwards every connection to the real daemon socket.
 * Half-open like a daemon: the docker CLI closes its write side of attach/exec streams and keeps reading.
 */
async function proxy(tlsOptions?: tls.TlsOptions): Promise<{ port: number; close(): void }> {
  const forward = (client: net.Socket) => {
    const upstream = net.connect({ path: DAEMON_SOCKET, allowHalfOpen: true });
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
  };
  const server = tlsOptions
    ? tls.createServer({ ...tlsOptions, allowHalfOpen: true }, forward)
    : net.createServer({ allowHalfOpen: true }, forward);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

/** CA, server (127.0.0.1/localhost) and client certificates in the layout DOCKER_CERT_PATH expects. */
function makeCerts(dir: string): void {
  const o = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  o([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=crot-it-ca",
    "-keyout",
    "ca-key.pem",
    "-out",
    "ca.pem",
  ]);
  for (const [name, ext] of [
    ["server", "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n"],
    ["client", "extendedKeyUsage=clientAuth\n"],
  ] as const) {
    const key = name === "client" ? "key.pem" : "server-key.pem";
    const cert = name === "client" ? "cert.pem" : "server-cert.pem";
    o(["req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=crot-it-${name}`, "-keyout", key, "-out", `${name}.csr`]);
    execFileSync("sh", ["-c", `printf '${ext}' > ${name}.ext`], { cwd: dir });
    o([
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca-key.pem",
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      `${name}.ext`,
      "-out",
      cert,
    ]);
  }
}

interface Scenario {
  readonly name: string;
  /** The service's Docker environment for this transport. */
  env(): Record<string, string | undefined>;
  /** The daemon is on this host: containers get the L1 container profile (when the daemon supports AppArmor). */
  readonly local: boolean;
  /** Paths of daemon credentials that must not be readable inside L1. */
  secrets(): string[];
}

let dockerOk = false;
let apparmor = false;
let tcp: { port: number; close(): void } | undefined;
let tlsProxy: { port: number; close(): void } | undefined;
let certDir = "";
let contextName = "";
const sshHost = process.env.CROT_L1_DOCKER_SSH;

beforeAll(async () => {
  if (!run) return;
  dockerOk = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
  if (!dockerOk) throw new Error("the L1 Docker tests are mandatory here but no Docker daemon is reachable");
  apparmor = (await readHostFacts("1")).apparmorEnabled;
  hostDocker(["pull", "-q", IMAGE]);
  tcp = await proxy();
  certDir = await mkdtemp(path.join(os.homedir(), "crot-it-certs-"));
  makeCerts(certDir);
  tlsProxy = await proxy({
    key: await readFile(path.join(certDir, "server-key.pem")),
    cert: await readFile(path.join(certDir, "server-cert.pem")),
    ca: await readFile(path.join(certDir, "ca.pem")),
    requestCert: true,
    rejectUnauthorized: true,
  });
  contextName = `crot-it-${process.pid}`;
  hostDocker(["context", "create", contextName, "--docker", `host=tcp://127.0.0.1:${tcp.port}`]);
}, 300_000);

afterAll(async () => {
  tcp?.close();
  tlsProxy?.close();
  if (certDir) await rm(certDir, { recursive: true, force: true });
  if (contextName) spawnSync("docker", ["context", "rm", "-f", contextName], { stdio: "ignore" });
});

const scenarios: Scenario[] = [
  {
    name: "unix (default socket)",
    env: () => ({ DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined }),
    local: true,
    secrets: () => [],
  },
  {
    name: "tcp (loopback)",
    env: () => ({ DOCKER_HOST: `tcp://127.0.0.1:${tcp!.port}`, DOCKER_CONTEXT: undefined }),
    local: true,
    secrets: () => [],
  },
  {
    name: "tls (client certificates)",
    env: () => ({
      DOCKER_HOST: `tcp://127.0.0.1:${tlsProxy!.port}`,
      DOCKER_TLS_VERIFY: "1",
      DOCKER_CERT_PATH: certDir,
      DOCKER_CONTEXT: undefined,
    }),
    local: true,
    secrets: () => [path.join(certDir, "key.pem"), path.join(certDir, "ca.pem")],
  },
  {
    name: "docker context",
    env: () => ({ DOCKER_HOST: undefined, DOCKER_CONTEXT: contextName }),
    local: true,
    secrets: () => [],
  },
  {
    name: "ssh (localhost sshd)",
    env: () => ({ DOCKER_HOST: sshHost, DOCKER_CONTEXT: undefined }),
    // AD-20 point 14: an SSH daemon is treated as not local, so no host profile is attached.
    local: false,
    // The home layer shows ~/.ssh (AD-20 point 6); the SSH connection itself is made outside L1.
    secrets: () => [],
  },
];

for (const scenario of scenarios) {
  const enabled = run && (scenario.name.startsWith("ssh") ? Boolean(sshHost) || l1Required : true);
  describe.skipIf(!enabled)(`L1 Docker endpoint over ${scenario.name}`, () => {
    let f: L1Fixture;

    beforeAll(async () => {
      if (scenario.name.startsWith("ssh") && !sshHost)
        throw new Error("CROT_L1_DOCKER_SSH (ssh://user@localhost) is required for the SSH scenario");
      f = await l1Fixture({ env: scenario.env() });
      assertAvailable(f);
    }, 120_000);
    afterAll(async () => {
      await f?.close();
    });

    const refusals = () => f.audit.confinementEvents.filter((e) => e.event === "confinement.docker_refused");

    it("routes the CLI to the CROT endpoint; the daemon and its credentials are not reachable", async () => {
      const r = await f.sh(
        [
          'echo "HOST=$DOCKER_HOST CTX=${DOCKER_CONTEXT:-none} TLS=${DOCKER_TLS_VERIFY:-none}"',
          "docker version --format '{{.Server.Version}}'",
          `docker -H unix://${DAEMON_SOCKET} version --format '{{.Server.Version}}' >/dev/null 2>&1 && echo DAEMON-REACHED || echo daemon-hidden`,
          ...scenario.secrets().map((s) => `cat '${s}' >/dev/null 2>&1 && echo SECRET-READ || echo secret-hidden`),
        ].join("\n"),
      );
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/HOST=unix:\/\/\S+docker-[0-9a-f]+\.sock CTX=none TLS=none/);
      expect(r.stdout).toMatch(/^\d+\.\d+/m);
      expect(r.stdout).toContain("daemon-hidden");
      expect(r.stdout).not.toContain("DAEMON-REACHED");
      expect(r.stdout).not.toContain("SECRET-READ");
    });

    it("allows a container with a workspace bind; writes land in the workspace", async () => {
      const r = await f.sh(`docker run --rm -v "${f.workspace}:/w" ${IMAGE} sh -c 'echo from-container > /w/out.txt'`);
      expect(r.exitCode, r.stderr).toBe(0);
      expect((await readFile(path.join(f.workspace, "out.txt"), "utf8")).trim()).toBe("from-container");
    });

    it("attaches stdin/stdout through the upgraded (hijacked) connection", async () => {
      const r = await f.sh(`printf 'ping-%s' crot | docker run --rm -i ${IMAGE} cat`);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toBe("ping-crot");
    });

    it("attaches the L1 container profile only for a daemon on this host", async () => {
      const r = await f.sh(`docker run --rm ${IMAGE} cat /proc/self/attr/current`);
      expect(r.exitCode, r.stderr).toBe(0);
      if (scenario.local && apparmor) expect(r.stdout.trim()).toBe(`${containerProfile} (enforce)`);
      else expect(r.stdout).not.toContain(containerProfile);
    });

    it("refuses a host bind outside the boundary and a privileged container (403, audited)", async () => {
      const before = refusals().length;
      const bind = await f.sh(`docker run --rm -v /etc:/e ${IMAGE} true`);
      expect(bind.exitCode).not.toBe(0);
      expect(bind.stderr).toContain(REFUSED);
      const priv = await f.sh(`docker run --rm --privileged ${IMAGE} true`);
      expect(priv.exitCode).not.toBe(0);
      expect(priv.stderr).toContain(REFUSED);
      const events = refusals().slice(before);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.every((e) => e.request === "container.create")).toBe(true);
    });
  });
}

describe.skipIf(!run)("L1 Docker endpoint: exec, cp, compose and build (default socket)", () => {
  let f: L1Fixture;
  const name = `crot-it-${process.pid}`;

  beforeAll(async () => {
    f = await l1Fixture({ env: { DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined } });
    assertAvailable(f);
  }, 120_000);
  afterAll(async () => {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    spawnSync("docker", ["compose", "-p", `${name}-c`, "down", "-v"], { stdio: "ignore", cwd: f?.workspace });
    spawnSync("docker", ["rmi", "-f", `${name}-img:1`], { stdio: "ignore" });
    await f?.close();
  });

  const refusals = () => f.audit.confinementEvents.filter((e) => e.event === "confinement.docker_refused");

  it("runs exec (hijacked) and cp both ways; a privileged exec is refused", async () => {
    await writeFile(path.join(f.workspace, "in.txt"), "copied-in");
    const r = await f.sh(
      [
        "set -e",
        `docker run -d --name ${name} ${IMAGE} sleep 120 >/dev/null`,
        `printf exec-ok | docker exec -i ${name} cat`,
        "echo",
        `docker cp "${f.workspace}/in.txt" ${name}:/tmp/in.txt`,
        `docker exec ${name} cat /tmp/in.txt`,
        "echo",
        `docker cp ${name}:/etc/alpine-release "${f.workspace}/release.txt"`,
      ].join("\n"),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("exec-ok");
    expect(r.stdout).toContain("copied-in");
    expect((await readFile(path.join(f.workspace, "release.txt"), "utf8")).trim()).toMatch(/^3\.20/);
    const before = refusals().length;
    const priv = await f.sh(`docker exec --privileged ${name} true`);
    expect(priv.exitCode).not.toBe(0);
    expect(priv.stderr).toContain(REFUSED);
    expect(
      refusals()
        .slice(before)
        .map((e) => e.request),
    ).toContain("container.exec");
  });

  it("runs docker compose with a workspace-relative bind; a privileged service is refused", async () => {
    await writeFile(
      path.join(f.workspace, "compose.yaml"),
      `services:\n  app:\n    image: ${IMAGE}\n    command: ["sh", "-c", "echo composed > /w/compose.txt"]\n    volumes: ["./:/w"]\n`,
    );
    const ok = await f.sh(
      `cd "${f.workspace}" && docker compose -p ${name}-c up --exit-code-from app && docker compose -p ${name}-c down`,
      120_000,
    );
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect((await readFile(path.join(f.workspace, "compose.txt"), "utf8")).trim()).toBe("composed");
    await writeFile(
      path.join(f.workspace, "compose.yaml"),
      `services:\n  app:\n    image: ${IMAGE}\n    privileged: true\n    command: ["true"]\n`,
    );
    const bad = await f.sh(`cd "${f.workspace}" && docker compose -p ${name}-c up --exit-code-from app`, 120_000);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stdout + bad.stderr).toContain(REFUSED);
  });

  it("builds an image with BuildKit; the security.insecure entitlement is refused", async () => {
    const ctxDir = path.join(f.workspace, "img");
    await rm(ctxDir, { recursive: true, force: true });
    execFileSync("mkdir", ["-p", ctxDir]);
    await writeFile(path.join(ctxDir, "Dockerfile"), `FROM ${IMAGE}\nRUN echo built > /built.txt\n`);
    const ok = await f.sh(
      `docker buildx build -q -t ${name}-img:1 "${ctxDir}" >/dev/null && docker run --rm ${name}-img:1 cat /built.txt`,
      180_000,
    );
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect(ok.stdout.trim()).toBe("built");
    const before = refusals().length;
    const bad = await f.sh(`docker buildx build --allow security.insecure -t ${name}-img:2 "${ctxDir}"`, 180_000);
    expect(bad.exitCode).not.toBe(0);
    const events = refusals().slice(before);
    expect(events.some((e) => /security\.insecure/.test(e.reason))).toBe(true);
  });

  it("does not leave a path to the daemon socket in the confined mount view", async () => {
    const r = await f.sh(
      "grep -c docker.sock /proc/self/mountinfo || true; [ -S /var/run/docker.sock ] && echo SOCKET || echo none",
    );
    expect(r.stdout).toContain("none");
  });

  it("hides the daemon socket under both of its names with one mount at its real path (/var/run -> /run)", async () => {
    const r = await f.sh(
      "for p in /run/docker.sock /var/run/docker.sock; do [ -S $p ] && echo $p:SOCKET || echo $p:none; done; " +
        'awk \'$5 == "/run/docker.sock" || $5 == "/var/run/docker.sock" { print "mount:" $5 }\' /proc/self/mountinfo',
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("/run/docker.sock:none");
    expect(r.stdout).toContain("/var/run/docker.sock:none");
    // Where the host has /run/docker.sock (the GitHub runners), it is hidden by exactly one mount, and none at the alias.
    expect(r.stdout.match(/^mount:\/var\/run\/docker\.sock$/gm) ?? []).toHaveLength(0);
    expect((r.stdout.match(/^mount:\/run\/docker\.sock$/gm) ?? []).length).toBeLessThanOrEqual(1);
  });
});

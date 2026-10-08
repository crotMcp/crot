/**
 * REAL L1 integration tests (AD-20 points 5-12), run by the L1 workflow on
 * Ubuntu 22.04 and 24.04 (x64 and arm64) with CROT_L1_REQUIRED=1 after
 * `sudo scripts/l1-install.sh install`. Every check observes the confined
 * process itself (mount view, AppArmor label, canaries, process tree), not
 * the command line. Without CROT_L1_REQUIRED=1 the suite is skipped; with it
 * an unavailable L1 fails every test with the reason code.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remotePrincipal } from "../../../src/core/auth/principal.js";
import { profileNames } from "../../../src/native-host/linux-l1/components.js";
import { readHostFacts } from "../../../src/native-host/linux-l1/host.js";
import { apparmorDenials, assertAvailable, ctx, l1Fixture, type L1Fixture } from "./l1-harness.js";
import { isLinux, l1Required } from "./l1-support.js";

const run = isLinux && l1Required;
const { label } = profileNames();

describe.skipIf(!run)("L1 on this host (network on)", () => {
  let f: L1Fixture;
  let runtimeDir: string;
  let abstract: net.Server;
  const abstractName = `crot-it-${process.pid}`;
  let agent: { pid: number; sock: string } | undefined;
  let hostTmpCanary: string;
  let keyringCanary: string;
  let apparmor = false;

  beforeAll(async () => {
    apparmor = (await readHostFacts("1")).apparmorEnabled;
    // A runtime directory with a session-bus-like socket and an SSH agent (AD-20 point 6).
    runtimeDir = process.env.XDG_RUNTIME_DIR ?? (await mkdtemp(path.join(os.tmpdir(), "crot-rt-")));
    await chmod(runtimeDir, 0o700).catch(() => undefined);
    await new Promise<void>((r) =>
      net.createServer().listen(path.join(runtimeDir, `crot-it-bus-${process.pid}`), () => r()),
    );
    const sock = path.join(runtimeDir, `crot-it-ssh-${process.pid}.sock`);
    const out = spawnSync("ssh-agent", ["-a", sock, "-s"], { encoding: "utf8" });
    const pid = /SSH_AGENT_PID=(\d+)/.exec(out.stdout ?? "")?.[1];
    if (pid) agent = { pid: Number(pid), sock };
    abstract = net.createServer((s) => s.end("HOST-ABSTRACT"));
    await new Promise<void>((r) => abstract.listen(`\0${abstractName}`, () => r()));
    hostTmpCanary = path.join("/tmp", `crot-it-host-${process.pid}`);
    await writeFile(hostTmpCanary, "HOST-TMP");
    keyringCanary = path.join(os.homedir(), ".local/share/keyrings", `crot-it-${process.pid}`);
    await mkdir(path.dirname(keyringCanary), { recursive: true });
    await writeFile(keyringCanary, "KEYRING");
    f = await l1Fixture({
      env: { XDG_RUNTIME_DIR: runtimeDir, ...(agent ? { SSH_AUTH_SOCK: agent.sock } : {}) },
    });
    assertAvailable(f);
  }, 120_000);

  afterAll(async () => {
    await f?.close();
    abstract?.close();
    if (agent) process.kill(agent.pid);
    await rm(hostTmpCanary, { force: true });
    await rm(keyringCanary, { force: true });
  });

  it("reports L1 available with the same shape in crot_status", async () => {
    expect(await f.core.refreshConfinement()).toMatchObject({
      mechanism: "linux-bubblewrap",
      available: true,
      network: "on",
      reason: null,
    });
    expect(f.log.some((l) => l.includes("L1 available (network on)"))).toBe(true);
  });

  it("runs under the stacked AppArmor label, no-new-privileges, as PID-1-child of crot-l1-init", async () => {
    const r = await f.sh(
      "cat /proc/self/attr/current 2>/dev/null || echo none; grep NoNewPrivs /proc/self/status; tr '\\0' ' ' < /proc/1/cmdline; echo; ls /proc | grep -c '^[0-9]'",
    );
    const [attr, nnp, init, count] = r.stdout.trim().split("\n");
    if (apparmor) expect(attr).toBe(`${label} (enforce)`);
    expect(nnp).toMatch(/NoNewPrivs:\s+1/);
    expect(init).toMatch(/crot-l1-init/);
    // Its own PID namespace: only the sandbox's processes, the service is not visible.
    expect(Number(count)).toBeLessThan(15);
    const svc = await f.sh(
      `test -e /proc/${process.pid}/environ && grep -c CROT /proc/${process.pid}/environ || echo invisible`,
    );
    expect(svc.stdout.trim()).toBe("invisible");
  });

  it("presents the home as an overlay and the workspace read-write (mount view)", async () => {
    const r = await f.sh("cat /proc/self/mountinfo");
    const lines = r.stdout.split("\n");
    expect(lines.some((l) => l.split(" ")[4] === f.home && l.includes(" - overlay "))).toBe(true);
    const ws = lines.find((l) => l.split(" ")[4] === f.workspace);
    expect(ws).toBeDefined();
    expect(ws!.split(" ")[5]).toMatch(/^rw/);
    const root = lines.find((l) => l.split(" ")[4] === "/");
    expect(root!.split(" ")[5]).toMatch(/^ro/);
  });

  it("cannot read CROT-protected paths, the secret stores, the host /tmp or the session runtime directory", async () => {
    const r = await f.sh(
      [
        `cat ${f.canary} 2>/dev/null && echo LEAK-canary`,
        `ls ${f.stateDir} 2>/dev/null && echo LEAK-state`,
        `cat ${keyringCanary} 2>/dev/null && echo LEAK-keyring`,
        `cat ${hostTmpCanary} 2>/dev/null && echo LEAK-tmp`,
        `ls -A ${runtimeDir}`,
        "echo done",
      ].join("; "),
    );
    expect(r.stdout).not.toMatch(/LEAK|CANARY-SECRET|KEYRING|HOST-TMP/);
    // $XDG_RUNTIME_DIR is private: only the SSH agent socket (and GnuPG sockets) are bound back.
    const listed = r.stdout.trim().split("\n").slice(0, -1).filter(Boolean);
    expect(listed).not.toContain(`crot-it-bus-${process.pid}`);
    if (agent) expect(listed).toContain(path.basename(agent.sock));
  });

  it("reaches the SSH agent through its bound-back socket", async () => {
    if (!agent) return;
    const r = await f.sh("ssh-add -l; echo exit=$?");
    // 1: the agent answered "no identities"; 2 would be "cannot connect".
    expect(r.stdout).toMatch(/exit=1/);
  });

  it("writes the workspace for real, the home into the private layer, never the real home; the rest is read-only", async () => {
    const name = `crot-it-${process.pid}`;
    const r = await f.sh(
      [
        `echo ws > ${f.workspace}/${name}`,
        `echo home > ${f.home}/.${name}`,
        `cat ${f.home}/.${name}`,
        `echo x > /usr/${name} 2>/dev/null && echo LEAK-usr`,
        `echo x > /etc/${name} 2>/dev/null && echo LEAK-etc`,
        `echo t > /tmp/${name} && echo tmp-ok`,
        `echo t > /var/tmp/${name} && echo vartmp-ok`,
        `echo t > /dev/shm/${name} && echo shm-ok`,
      ].join("; "),
    );
    expect(r.stdout).not.toMatch(/LEAK/);
    expect(r.stdout).toMatch(/home\ntmp-ok\nvartmp-ok\nshm-ok/);
    expect(await readFile(path.join(f.workspace, name), "utf8")).toBe("ws\n");
    expect(existsSync(path.join(f.home, `.${name}`))).toBe(false);
    expect(existsSync(path.join("/tmp", name))).toBe(false);
    // Confined home writes stay visible to later confined commands.
    expect((await f.sh(`cat ${f.home}/.${name}`)).stdout).toBe("home\n");
  });

  it("cannot connect to an abstract socket of the host; abstract sockets between confined processes work", async () => {
    const node = process.execPath;
    const connect = (name: string) =>
      `${node} -e "require('net').connect('\\0${name}').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(1)})"`;
    const host = await f.sh(connect(abstractName));
    expect(host.stdout).not.toMatch(/CONNECTED/);
    if (!apparmor) return;
    const inner = `crot-inner-${process.pid}`;
    const server = await f.core.processes.start(ctx, {
      command: node,
      args: ["-e", `require('net').createServer(s=>s.end('x')).listen('\\0${inner}');setTimeout(()=>{},30000)`],
    });
    await new Promise((r) => setTimeout(r, 500));
    expect((await f.sh(connect(inner))).stdout).toMatch(/CONNECTED/);
    await f.core.processes.stop(ctx, { id: server.id });
  });

  it("cannot create a nested user namespace", async () => {
    const r = await f.sh("unshare -U true 2>&1; echo exit=$?");
    expect(r.stdout).not.toMatch(/exit=0/);
  });

  it("ends a command's whole tree on timeout, including setsid and double-forked descendants", async () => {
    const pidFile = `/tmp/crot-tree-${process.pid}`;
    await f.sh(
      `setsid sh -c 'sleep 300 & echo $! >> ${pidFile}; wait' & ( sleep 300 & echo $! >> ${pidFile} ) & sleep 300 & echo $! >> ${pidFile}; wait`,
      1_500,
    );
    const check = await f.sh(
      `for p in $(cat ${pidFile}); do kill -0 $p 2>/dev/null && echo alive-$p; done; echo checked`,
    );
    expect(check.stdout.trim()).toBe("checked");
  });

  it("process.manage stop ends a detached tree; it stays confined for its lifetime", async () => {
    const info = await f.core.processes.start(ctx, {
      command: "/bin/sh",
      args: [
        "-c",
        "nohup sleep 300 >/dev/null 2>&1 & echo $! > /tmp/crot-bg; cat /proc/self/attr/current 2>/dev/null; wait",
      ],
    });
    await new Promise((r) => setTimeout(r, 500));
    const out = await f.core.processes.readOutput(ctx, { id: info.id });
    if (apparmor) expect(out.stdout).toContain(label);
    await f.core.processes.stop(ctx, { id: info.id });
    expect((await f.sh("kill -0 $(cat /tmp/crot-bg) 2>/dev/null && echo alive || echo gone")).stdout.trim()).toBe(
      "gone",
    );
  });

  it("gains no privilege through setuid programs", async () => {
    const r = await f.sh("sudo -n true 2>/dev/null && echo ROOT; id -u");
    expect(r.stdout).not.toMatch(/ROOT/);
    expect(r.stdout.trim()).toBe(String(process.getuid!()));
  });

  it("confines remote principals the same way", async () => {
    const remote = {
      principal: remotePrincipal({
        id: "r",
        transport: "http",
        authMethod: "test",
        accountId: "a",
        deviceId: "d",
        clientId: "c",
      }),
    };
    const r = await f.core.processes.shell(remote, {
      script: "cat /proc/self/attr/current 2>/dev/null; cat /proc/1/cmdline | tr '\\0' ' '",
    });
    expect(r.stdout).toMatch(/crot-l1-init/);
    if (apparmor) expect(r.stdout).toContain(label);
  });

  it("runs headless Chromium with --no-sandbox (smoke)", async () => {
    const browser = ["google-chrome", "chromium", "chromium-browser"].find(
      (b) => spawnSync("sh", ["-c", `command -v ${b}`]).status === 0,
    );
    if (!browser) return; // recorded by the workflow: the runner image has Chrome
    const r = await f.sh(
      `${browser} --headless=new --no-sandbox --disable-gpu --dump-dom 'data:text/html,<p id=x>crot-l1</p>'`,
      90_000,
    );
    // Chromium's own stderr (and how it ended) names the cause when it prints nothing; without
    // the repeated crash handler lines.
    const stderr = r.stderr
      .split("\n")
      .filter((l) => !l.includes("crashpad"))
      .join("\n");
    const denials = r.stdout.includes("crot-l1</p>")
      ? ""
      : [
          ...new Set(
            apparmorDenials().map((l) =>
              l.replace(/^.*?apparmor=/, "apparmor=").replace(/ pid=\d+| peer_pid=\d+/g, ""),
            ),
          ),
        ]
          .slice(-25)
          .join("\n");
    expect(r.stdout, `exit ${r.exitCode}; AppArmor denials:\n${denials}\nstderr: ${stderr.slice(0, 2500)}`).toContain(
      '<p id="x">crot-l1</p>',
    );
  }, 120_000);
});

describe.skipIf(!run)("L1 on this host (network off)", () => {
  let f: L1Fixture;
  beforeAll(async () => {
    f = await l1Fixture({ network: "off" });
    assertAvailable(f);
  }, 120_000);
  afterAll(async () => f?.close());

  it("has only a loopback network, shared by the Core's confined processes", async () => {
    const node = process.execPath;
    // The interfaces of the sandbox's own network namespace: /proc/net is per network namespace,
    // /sys/class/net is not (sysfs is the host's, read-only, so it lists the host's interfaces).
    expect((await f.sh("sed -n 's/^ *\\([^:]*\\):.*/\\1/p' /proc/net/dev")).stdout.trim()).toBe("lo");
    const server = await f.core.processes.start(ctx, {
      command: node,
      args: [
        "-e",
        "require('http').createServer((q,s)=>s.end('local-ok')).listen(18765,'127.0.0.1');setTimeout(()=>{},30000)",
      ],
    });
    await new Promise((r) => setTimeout(r, 700));
    const r = await f.sh(
      `${node} -e "require('http').get('http://127.0.0.1:18765',r=>r.on('data',d=>process.stdout.write(d)))"`,
    );
    expect(r.stdout).toBe("local-ok");
    await f.core.processes.stop(ctx, { id: server.id });
  });
});

describe.skipIf(!run)("CONFINEMENT_FAILED after admission (real sandbox set-up failure)", () => {
  // L1 workflow #14: the broken storage surfaced as a raw EACCES (endpoint socket, private temp), not as
  // CONFINEMENT_FAILED. Network off needs no AppArmor, so that case also runs on hosts without it.
  it.each(["on", "off"] as const)(
    "fails the operation, launches nothing outside L1 and reports the new state (network %s)",
    async (network) => {
      const f = await l1Fixture({ network });
      try {
        assertAvailable(f);
        // L1 was available when the operation was admitted. Break the private storage before the
        // first confined launch so the sandbox cannot be set up.
        const uid = process.getuid!();
        const base = `/var/tmp/crot-l1-${uid}`;
        await chmod(base, 0o000);
        try {
          const marker = path.join(f.workspace, "ran-unconfined");
          await expect(f.sh(`touch ${marker}`)).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
          expect(existsSync(marker)).toBe(false);
          expect(f.audit.events.at(-1)?.error?.code).toBe("CONFINEMENT_FAILED");
          expect(f.core.status().confinement).toMatchObject({
            available: false,
            reason: "private_storage_unavailable",
          });
          // Local principals keep their behaviour only once L1 is reported unavailable (AD-20 point 11).
        } finally {
          await chmod(base, 0o700);
        }
        expect(await f.core.refreshConfinement()).toMatchObject({ available: true });
        expect((await f.sh("echo again")).stdout).toBe("again\n");
      } finally {
        await f.close();
      }
    },
    120_000,
  );
});

describe.skipIf(!run)("reason codes on this host", () => {
  it("components_missing and components_mismatch for another component root", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "crot-comp-"));
    try {
      const missing = await l1Fixture({ env: {} });
      await missing.close();
      const { LinuxConfinement } = await import("../../../src/native-host/linux-l1/confinement.js");
      const base = missing.native.platform.launcher;
      const probe = (componentsRoot: string) =>
        new LinuxConfinement({ stateDir: dir, base, env: process.env, componentsRoot }).probe("on");
      expect(await probe(path.join(dir, "absent"))).toMatchObject({ reason: "components_missing" });
      // A user-owned copy of the installed components: not owned by root.
      execFileSync("cp", ["-r", "/usr/lib/crot/l1", path.join(dir, "copy")]);
      expect(await probe(path.join(dir, "copy"))).toMatchObject({ reason: "components_mismatch" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

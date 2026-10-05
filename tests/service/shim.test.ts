import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { REMOTE_EXPOSURE_FILE_NAME } from "../../src/core/approvals/remote-exposure.js";
import type { ServiceStatus } from "../../src/core/service-status.js";
import { credentialFile, serviceEndpoint } from "../../src/service/endpoints.js";
import { isAlive, makeServiceHost, makeTempDirs, waitFor, type ServiceHost, type TempDirs } from "../helpers.js";

/**
 * WP-20 end to end with the built crot-mcp: stdio clients attach through the
 * thin shim to one CROT service per user (ARCHITECTURE.md §27 AD-17).
 */
const bin = inject("crotMcpBin");
const TIMEOUT = 60_000;

let dirs: TempDirs;
let host: ServiceHost;
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  dirs = await makeTempDirs();
  host = await makeServiceHost(dirs.outside);
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
  await host.cleanup(bin);
  await dirs.cleanup();
});

interface Shim {
  readonly client: Client;
  readonly pid: number;
  stderr(): string;
  status(): Promise<{ service: ServiceStatus; workspace: { root: string } }>;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
  closed: Promise<void>;
}

async function shim(
  args: readonly string[] = ["--workspace", dirs.workspace, "--no-audit"],
  cwd?: string,
): Promise<Shim> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, ...args],
    env: host.env,
    ...(cwd ? { cwd } : {}),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
  const closed = new Promise<void>((resolve) => {
    const previous = transport.onclose;
    transport.onclose = () => {
      previous?.();
      resolve();
    };
  });
  const client = new Client({ name: "shim-e2e", version: "0" });
  await client.connect(transport);
  const pid = transport.pid!;
  const s: Shim = {
    client,
    pid,
    closed,
    stderr: () => stderr,
    call: async (name, a = {}) => (await client.callTool({ name, arguments: a })) as CallToolResult,
    status: async () => {
      const r = await s.call("crot_status");
      const first = r.content[0];
      return JSON.parse(first?.type === "text" ? first.text : "{}");
    },
    close: () => client.close(),
  };
  cleanups.push(() => client.close());
  return s;
}

function run(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { env: host.env, timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

/** A managed service in the foreground (what an OS supervisor runs). */
function managed(args: readonly string[]): {
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<number | null>;
} {
  const child = spawn(process.execPath, [bin, "service", "run", ...args], {
    env: host.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return { child, stderr: () => stderr, exited };
}

const text = (r: CallToolResult) => {
  const first = r.content[0];
  return first?.type === "text" ? first.text : "";
};

describe("stdio shim and CROT service (built, WP-20)", () => {
  it(
    "several stdio clients start at the same time and work concurrently through one service",
    async () => {
      const shims = await Promise.all([shim(), shim(), shim(), shim()]);
      const statuses = await Promise.all(shims.map((s) => s.status()));
      const pids = new Set(statuses.map((s) => s.service.pid));
      expect(pids.size).toBe(1);
      const servicePid = [...pids][0]!;
      for (const s of shims) expect(s.pid).not.toBe(servicePid);
      expect((await shims[0]!.status()).service).toMatchObject({
        state: "running",
        launch: "on-demand",
        clients: { stdio: 4 },
      });

      // Concurrent tool calls of all clients, including commands.
      const results = await Promise.all(
        shims.flatMap((s, i) => [
          s.call("fs_write_file", { path: `client-${i}.txt`, content: `c${i}` }),
          s.call("process_exec", {
            command: process.execPath,
            args: ["-e", `setTimeout(() => console.log("done ${i}"), 300)`],
          }),
        ]),
      );
      for (const r of results) expect(r.isError).toBeFalsy();
      for (let i = 0; i < 4; i++) {
        expect(await readFile(path.join(dirs.workspace, `client-${i}.txt`), "utf8")).toBe(`c${i}`);
        expect(text(results[i * 2 + 1]!)).toContain(`done ${i}`);
      }
      // Credentials never reach child processes (environment or arguments) or client output.
      const env = await shims[0]!.call("process_exec", {
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify({ env: process.env, argv: process.argv }))"],
      });
      for (const channel of ["service", "control"] as const) {
        const secret = (await readFile(credentialFile(host.stateDir, channel), "utf8")).trim();
        expect(text(env)).not.toContain(secret);
        for (const s of shims) expect(s.stderr()).not.toContain(secret);
      }
      // The startup banner of the service reaches every client's stderr; nothing is "in use".
      for (const s of shims) {
        expect(s.stderr()).toContain("CROT 0.1.0");
        expect(s.stderr()).not.toContain("in use");
      }

      // Clients come and go independently; the service stops after the last one.
      await shims[0]!.close();
      expect((await shims[1]!.call("fs_read_file", { path: "client-0.txt" })).isError).toBeFalsy();
      for (const s of shims.slice(1)) await s.close();
      await waitFor(() => !isAlive(servicePid), 10_000);
    },
    TIMEOUT,
  );

  it(
    "`service status` and `service stop` work over the control channel",
    async () => {
      const none = await run(["service", "status"]);
      expect(none.code).toBe(3);
      expect(none.stdout).toContain("not running");

      const s = await shim();
      const status = await run(["service", "status"]);
      expect(status.code).toBe(0);
      const servicePid = (await s.status()).service.pid;
      expect(status.stdout).toContain(`running (pid ${servicePid}, on-demand`);
      expect(status.stdout).toContain("1 stdio");

      const stop = await run(["service", "stop"]);
      expect(stop.code).toBe(0);
      expect(stop.stdout).toContain(`stopped (pid ${servicePid})`);
      await waitFor(() => !isAlive(servicePid));
      // The shim learns that the service stopped and exits.
      await s.closed;
      expect(s.stderr()).toContain("the CROT service stopped");
    },
    TIMEOUT,
  );

  it(
    "a client with another configuration gets a clear error while the service is in use",
    async () => {
      const first = await shim();
      const other = await run(["--workspace", dirs.outside, "--no-audit"]);
      expect(other.code).toBe(1);
      expect(other.stderr).toMatch(/different configuration/);
      expect(other.stderr).toMatch(/service stop/);
      expect((await first.status()).service.clients.stdio).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "an idle on-demand service is replaced for a new configuration",
    async () => {
      const first = await shim();
      const firstPid = (await first.status()).service.pid;
      await first.close();
      const second = await shim(["--workspace", dirs.outside, "--no-audit"]);
      const status = await second.status();
      expect(status.workspace.root).toBe(dirs.outside);
      expect(status.service.pid).not.toBe(firstPid);
    },
    TIMEOUT,
  );

  it(
    "graceful shutdown keeps AD-7: in-flight and background operations are audited before the audit log closes",
    async () => {
      const auditFile = path.join(dirs.outside, "audit.jsonl");
      const service = managed(["--workspace", dirs.workspace, "--audit-log", auditFile]);
      await waitFor(() => service.stderr().includes("service: managed"), 30_000);
      const s = await shim(["--workspace", dirs.workspace, "--audit-log", auditFile]);
      const bg = await s.call("process_start", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
      const bgPid = (JSON.parse(text(bg)) as { pid: number }).pid;
      const inflight = s
        .call("process_exec", {
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          timeoutMs: 60_000,
        })
        .catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
      const stop = await run(["service", "stop"]);
      expect(stop.code).toBe(0);
      expect(await service.exited).toBe(0);
      await inflight;
      await waitFor(() => !isAlive(bgPid), 5_000);
      const lines = (await readFile(auditFile, "utf8")).trim().split("\n");
      const operations = lines.map((l) => (JSON.parse(l) as { operation: string }).operation);
      expect(operations).toContain("process.start");
      expect(operations).toContain("process.exec");
      expect(service.stderr()).toContain("shutting down (control: shutdown requested)");
    },
    TIMEOUT,
  );

  it(
    "after a crash the shim exits with status 1, a new service takes over, and persisted remote exposure is intact",
    async () => {
      const exposureFile = path.join(host.stateDir, REMOTE_EXPOSURE_FILE_NAME);
      const httpArgs = ["--workspace", dirs.workspace, "--no-audit", "--http", "--http-port", "0"];
      const first = managed(httpArgs);
      await waitFor(() => first.stderr().includes("http: listening"), 30_000);
      // An earlier remote exposure (only digests are stored).
      const exposed = JSON.stringify({ version: 1, exposed: ["a".repeat(64)] }) + "\n";
      await writeFile(exposureFile, exposed);
      const s = await shim();
      expect((await s.status()).service.http.enabled).toBe(true);

      first.child.kill("SIGKILL");
      await first.exited;
      await s.closed;
      expect(s.stderr()).toContain("lost the connection to the CROT service");

      // Restart (what the OS supervisor does): the stale endpoint is taken over, the exposure file is untouched.
      const second = managed(httpArgs);
      await waitFor(() => second.stderr().includes("http: listening"), 30_000);
      expect(await readFile(exposureFile, "utf8")).toBe(exposed);
      expect(second.stderr()).not.toContain("remote exposure state");
      const again = await shim();
      expect((await again.status()).service.pid).toBe(second.child.pid);
      await again.close();
      second.child.kill("SIGKILL");
      await second.exited;

      // A damaged state fails closed and is left as it is.
      await writeFile(exposureFile, "garbage");
      const third = managed(httpArgs);
      await waitFor(() => third.stderr().includes("http: listening"), 30_000);
      expect(third.stderr()).toMatch(/remote exposure state: .*malformed; every remote client is treated as exposed/);
      expect(await readFile(exposureFile, "utf8")).toBe("garbage");
    },
    TIMEOUT,
  );

  it(
    "concurrent service starts of one user leave exactly one owner, also when taking over after a crash",
    async () => {
      const args = ["--on-demand", "--workspace", dirs.workspace, "--no-audit"];
      // A crashed service (kill -9) leaves its endpoint behind (POSIX: a stale socket file).
      const crashed = managed(["--workspace", dirs.workspace, "--no-audit"]);
      await waitFor(() => crashed.stderr().includes("service: managed"), 30_000);
      crashed.child.kill("SIGKILL");
      await crashed.exited;
      // Several services start at the same moment, bypassing the shims' start lock.
      const starts = Array.from({ length: 4 }, () => managed(args));
      let stdout = "";
      await waitFor(async () => {
        const r = await run(["service", "status"]);
        stdout = r.stdout;
        return r.code === 0;
      }, 30_000);
      const owner = Number(/pid (\d+)/.exec(stdout)?.[1]);
      // Every other one gave up silently before touching the bridge or Core.
      const exits = await Promise.all(starts.filter((p) => p.child.pid !== owner).map((p) => p.exited));
      expect(exits).toEqual([0, 0, 0]);
      expect(starts.some((p) => p.child.pid === owner)).toBe(true);
      expect(isAlive(owner)).toBe(true);
      // Clients reach that owner.
      const s = await shim();
      expect((await s.status()).service.pid).toBe(owner);
      await s.close();
    },
    TIMEOUT,
  );

  it(
    "clients started in different working directories share the service; it does not keep the first one's",
    async () => {
      const a = await shim(undefined, dirs.workspace);
      const b = await shim(undefined, dirs.outside);
      const [sa, sb] = await Promise.all([a.status(), b.status()]);
      expect(sb.service.pid).toBe(sa.service.pid);
      if (process.platform === "linux") {
        const { readlink } = await import("node:fs/promises");
        expect(await readlink(`/proc/${sa.service.pid}/cwd`)).not.toBe(dirs.workspace);
      }
    },
    TIMEOUT,
  );

  it(
    "a managed service refuses to start twice",
    async () => {
      const first = managed(["--workspace", dirs.workspace, "--no-audit"]);
      await waitFor(() => first.stderr().includes("service: managed"), 30_000);
      const second = await run(["service", "run", "--workspace", dirs.workspace, "--no-audit"]);
      expect(second.code).toBe(1);
      expect(second.stderr).toContain("already running");
    },
    TIMEOUT,
  );
});

/**
 * Another OS user must not reach the endpoints, even when given the endpoint
 * name and the credential. The test runs when CROT_TEST_OTHER_USER names a
 * second account (on Windows also CROT_TEST_OTHER_PASSWORD; on POSIX the
 * current user needs passwordless sudo to that account), as set up by the CI
 * step for a second OS account; otherwise it is skipped.
 */
const otherUser = process.env.CROT_TEST_OTHER_USER;

// The roadmap requires this test in CI on every OS: in GitHub Actions a missing second account is an error, not a skip.
describe.runIf(process.env.GITHUB_ACTIONS === "true" && !otherUser)("CI setup (WP-20)", () => {
  it("CI provides a second OS account for the endpoint test", () => {
    expect.fail(
      "CROT_TEST_OTHER_USER is not set: add the step 'node scripts/ci-other-user.mjs' before 'npm test' in .github/workflows/ci.yml (STATUS.md, WP-20).",
    );
  });
});
describe.runIf(Boolean(otherUser))("endpoints and another OS user (WP-20)", () => {
  it(
    "another OS user cannot connect to the shim or control endpoint",
    async () => {
      const s = await shim();
      await s.status();
      const results: string[] = [];
      for (const channel of ["service", "control"] as const) {
        const credential = (await readFile(credentialFile(host.stateDir, channel), "utf8")).trim();
        const endpoint = serviceEndpoint(host.stateDir, channel, credential).path;
        results.push(await probeAsOtherUser(endpoint));
      }
      // Either the OS refuses the connection, or the peer cannot complete an authenticated handshake.
      for (const r of results) expect(r).not.toBe("connected");
      // POSIX: the private state directory and the 0600 sockets stop the connection in the kernel.
      if (process.platform !== "win32") {
        expect(results).toEqual(["EACCES", "EACCES"]);
        // Defence in depth: with every directory traversable, the 0600 sockets alone still refuse the other user.
        for (let dir = host.stateDir; ; dir = path.dirname(dir)) {
          await chmod(dir, 0o711);
          if (/^crot-(test|h)-/.test(path.basename(dir))) break;
        }
        const again: string[] = [];
        for (const channel of ["service", "control"] as const) {
          const credential = (await readFile(credentialFile(host.stateDir, channel), "utf8")).trim();
          again.push(await probeAsOtherUser(serviceEndpoint(host.stateDir, channel, credential).path));
        }
        expect(again).toEqual(["EACCES", "EACCES"]);
      }
    },
    TIMEOUT,
  );
});

/** Try to open `endpoint` as CROT_TEST_OTHER_USER; returns "connected" or the error code. */
async function probeAsOtherUser(endpoint: string): Promise<string> {
  const script = [
    "const net = require('net');",
    `const s = net.connect(${JSON.stringify(endpoint)});`,
    "s.on('connect', () => { s.write('x'); setTimeout(() => { console.log(s.destroyed ? 'closed' : 'connected'); process.exit(0); }, 300); });",
    "s.on('error', (e) => { console.log(e.code || 'error'); process.exit(0); });",
  ].join("");
  if (process.platform === "win32") {
    // The probe reports through its exit code: no output handle or file has to cross into the other
    // account's logon session.
    const outcomes = ["connected", "closed", "EPERM", "EACCES", "ENOENT", "ECONNREFUSED", "EPIPE", "ECONNRESET"];
    const probe = [
      "const net = require('net');",
      `const outcomes = ${JSON.stringify(outcomes)};`,
      "const report = (r) => process.exit(outcomes.includes(r) ? 10 + outcomes.indexOf(r) : 99);",
      `const s = net.connect(${JSON.stringify(endpoint)});`,
      "s.on('connect', () => { s.write('x'); setTimeout(() => report(s.destroyed ? 'closed' : 'connected'), 300); });",
      "s.on('error', (e) => report(e.code || 'error'));",
    ].join("");
    // Files the other account can read and run (C:\Users\Public); PowerShell single-quoted strings.
    const base = path.join(process.env.PUBLIC ?? "C:\\Users\\Public", `crot-probe-${process.pid}`);
    await writeFile(`${base}.js`, probe);
    // A copy of Node the other account can certainly read and run.
    await copyFile(process.execPath, `${base}.exe`);
    const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
    // Only .NET types and language constructs, no cmdlets: nothing depends on loading a PowerShell
    // module. Process.Start with a user name and password is CreateProcessWithLogonW, i.e. a real logon
    // of the other account. The password comes from the environment, not the command line.
    const ps = [
      "$ErrorActionPreference = 'Stop';",
      "$password = [System.Security.SecureString]::new();",
      "foreach ($ch in $env:CROT_TEST_OTHER_PASSWORD.ToCharArray()) { $password.AppendChar($ch) };",
      "$info = [System.Diagnostics.ProcessStartInfo]::new();",
      `$info.FileName = ${q(`${base}.exe`)};`,
      `$info.Arguments = ${q(`"${base}.js"`)};`,
      `$info.WorkingDirectory = ${q(path.dirname(base))};`,
      `$info.UserName = ${q(otherUser!)};`,
      "$info.Domain = $env:COMPUTERNAME;",
      "$info.Password = $password;",
      "$info.LoadUserProfile = $true;",
      "$info.UseShellExecute = $false;",
      "$info.CreateNoWindow = $true;",
      "$p = [System.Diagnostics.Process]::Start($info);",
      "if (-not $p.WaitForExit(20000)) { $p.Kill(); throw 'the probe did not finish' };",
      "[Console]::Out.Write($p.ExitCode)",
    ].join(" ");
    // Windows PowerShell must not inherit the module path of a PowerShell 7 parent (the GitHub Actions
    // default shell): with it, Windows PowerShell finds PowerShell 7's modules and cannot load them.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PSMODULEPATH"));
    try {
      const code = await new Promise<number>((resolve, reject) =>
        execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", ps],
          { timeout: 30_000, env },
          (e, stdout, stderr) => (e ? reject(new Error(`${e.message}\n${stderr}`)) : resolve(Number(stdout.trim()))),
        ),
      );
      return outcomes[code - 10] ?? `exit ${code}`;
    } finally {
      await rm(`${base}.js`, { force: true });
      await rm(`${base}.exe`, { force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  // The other account may not be able to reach this user's Node installation (macOS homes are not
  // world-readable): it runs a copy in a world-readable directory.
  const nodeDir = await mkdtemp(path.join("/tmp", "crot-node-"));
  try {
    await chmod(nodeDir, 0o755);
    const node = path.join(nodeDir, "node");
    await copyFile(process.execPath, node);
    await chmod(node, 0o755);
    return await new Promise<string>((resolve, reject) =>
      execFile("sudo", ["-n", "-u", otherUser!, node, "-e", script], { timeout: 30_000, cwd: "/" }, (e, stdout) =>
        e ? reject(e) : resolve(stdout.trim()),
      ),
    );
  } finally {
    await rm(nodeDir, { recursive: true, force: true });
  }
}

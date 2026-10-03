import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Harness of the real-browser E2E (docs/BROWSER_E2E.md).
 *
 * Everything here is test infrastructure around the REAL components: it never
 * replaces Chromium, the extension, crot-browser-relay, native messaging or
 * the BrowserBridge, and it does not touch CROT's permission model. The only
 * environment manipulation is pointing HOME / XDG_* at a throw-away directory,
 * so that `crot-mcp browser install`, the CROT state directory and the browser
 * profile are isolated from the developer's own.
 */

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, "..", "..");
export const CROT_MCP_BIN = path.join(REPO_ROOT, "dist", "bin", "crot-mcp.js");
export const RELAY_BIN = path.join(REPO_ROOT, "dist", "bin", "crot-browser-relay.js");
export const EXTENSION_DIR = path.join(REPO_ROOT, "extension");
export const EXTENSION_WORKER = path.join(EXTENSION_DIR, "dist", "extension", "src", "background.js");
export const FIXTURES_DIR = path.join(here, "fixtures");
export const NATIVE_HOST_NAME = "com.crot.host";
export const EXTENSION_ID = "bllcepanlhojbddfbbpegmnokpaakool";

export async function assertBuilt(): Promise<void> {
  const required: ReadonlyArray<readonly [string, string]> = [
    [CROT_MCP_BIN, "npm run build"],
    [RELAY_BIN, "npm run build"],
    [EXTENSION_WORKER, "npm run build:extension"],
  ];
  for (const [file, hint] of required) {
    try {
      await access(file);
    } catch {
      throw new Error(`Missing ${path.relative(REPO_ROOT, file)}: run '${hint}' first ('npm run test:e2e:browser' builds both).`);
    }
  }
}

/** Browser binary under test. Required: without a real browser the E2E fails instead of pretending to pass. */
export function chromeExecutable(): string {
  const value = process.env.CROT_E2E_CHROME;
  if (!value) {
    throw new Error(
      "CROT_E2E_CHROME is not set. Point it at a Chromium or Chrome for Testing binary (see docs/BROWSER_E2E.md). " +
        "The real-browser E2E cannot run without a real browser and is NOT reported as passed.",
    );
  }
  return value;
}

export interface Sandbox {
  readonly base: string;
  readonly home: string;
  readonly configHome: string;
  readonly stateHome: string;
  readonly profileDir: string;
  readonly workspace: string;
  readonly env: Record<string, string>;
}

export async function createSandbox(): Promise<Sandbox> {
  // Short base path: the bridge socket path is limited to 103 bytes.
  const base = await mkdtemp(path.join("/tmp", "crot-e2e-"));
  const home = path.join(base, "home");
  const configHome = path.join(home, ".config");
  const stateHome = path.join(base, "state");
  const dataHome = path.join(home, ".local", "share");
  const cacheHome = path.join(home, ".cache");
  const profileDir = path.join(base, "profile");
  const workspace = path.join(base, "ws");
  for (const dir of [home, configHome, stateHome, dataHome, cacheHome, profileDir, workspace]) await mkdir(dir, { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.CROT_CONFIG;
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, XDG_DATA_HOME: dataHome, XDG_CACHE_HOME: cacheHome });
  return { base, home, configHome, stateHome, profileDir, workspace, env };
}

export interface NativeHostManifest {
  readonly name: string;
  readonly description?: string;
  readonly path: string;
  readonly type: string;
  readonly allowed_origins: readonly string[];
}

export interface InstalledHost {
  readonly manifest: NativeHostManifest;
  readonly launcher: string;
  /** --state-dir passed by the installed launcher to crot-browser-relay. */
  readonly stateDir: string;
  readonly output: string;
}

/**
 * Register the native-messaging host with the real `crot-mcp browser install`
 * (inside the sandbox HOME), then make the generated manifest visible to the
 * browser under test. `browser install` targets Chrome, Edge and Brave; a
 * Chromium / Chrome for Testing build reads user-level hosts from
 * <user-data-dir>/NativeMessagingHosts (and its default config directory),
 * so the very same manifest is copied there. Nothing in it is changed.
 */
export async function installNativeHost(sb: Sandbox): Promise<InstalledHost> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CROT_MCP_BIN, "browser", "install"], { env: sb.env, cwd: REPO_ROOT });
  const fileName = `${NATIVE_HOST_NAME}.json`;
  const source = path.join(sb.configHome, "google-chrome", "NativeMessagingHosts", fileName);
  const manifest = JSON.parse(await readFile(source, "utf8")) as NativeHostManifest;
  const targets = [
    path.join(sb.profileDir, "NativeMessagingHosts"),
    path.join(sb.configHome, "chromium", "NativeMessagingHosts"),
    path.join(sb.configHome, "google-chrome-for-testing", "NativeMessagingHosts"),
  ];
  for (const dir of targets) {
    await mkdir(dir, { recursive: true });
    await copyFile(source, path.join(dir, fileName));
  }
  const launcher = await readFile(manifest.path, "utf8");
  const match = /--state-dir\s+(?:'([^']+)'|"([^"]+)"|(\S+))/.exec(launcher);
  const stateDir = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!stateDir) throw new Error(`Cannot find --state-dir in the installed launcher ${manifest.path}:\n${launcher}`);
  return { manifest, launcher, stateDir, output: stdout + stderr };
}

export interface RecordedRequest {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly userAgent: string;
}

export interface FixtureServer {
  readonly origin: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Local HTTP server (127.0.0.1, ephemeral port) for the controlled test pages. CROT only allows http:/https: URLs. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const pages = new Map<string, string>([
    ["/start.html", await readFile(path.join(FIXTURES_DIR, "start.html"), "utf8")],
    ["/fixture.html", await readFile(path.join(FIXTURES_DIR, "fixture.html"), "utf8")],
  ]);
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ path: url.pathname, query: url.searchParams, userAgent: String(req.headers["user-agent"] ?? "") });
    const page = pages.get(url.pathname);
    if (page !== undefined) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page);
    } else if (url.pathname === "/event") {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface ChromeInstance {
  readonly pid: number;
  readonly args: readonly string[];
  output(): string;
  stop(): Promise<void>;
}

/**
 * Launch the browser under test with a separate, empty profile and only the
 * unpacked CROT extension loaded. CROT_E2E_HEADLESS=1 adds --headless=new;
 * CROT_E2E_CHROME_ARGS adds extra flags (whitespace separated).
 */
export function launchChrome(executable: string, sb: Sandbox): ChromeInstance {
  const extra = (process.env.CROT_E2E_CHROME_ARGS ?? "").split(/\s+/).filter((a) => a.length > 0);
  const headless = process.env.CROT_E2E_HEADLESS === "1" ? ["--headless=new"] : [];
  const args = [
    `--user-data-dir=${sb.profileDir}`,
    `--load-extension=${EXTENSION_DIR}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--password-store=basic",
    "--use-mock-keychain",
    ...headless,
    ...extra,
    "about:blank",
  ];
  const child: ChildProcess = spawn(executable, args, { env: sb.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const collect = (chunk: Buffer | string) => {
    output += chunk.toString();
    if (output.length > 400_000) output = output.slice(-200_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error) => collect(`\n[spawn error] ${error.message}\n`));
  child.on("exit", (code, signal) => collect(`\n[browser exited] code=${code} signal=${signal}\n`));
  if (child.pid === undefined) throw new Error(`Cannot start the browser ${executable}`);
  const pid = child.pid;
  return {
    pid,
    args,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

async function parentPid(pid: number): Promise<number | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    return Number.isInteger(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
}

async function hasAncestor(pid: number, ancestor: number): Promise<boolean> {
  let current: number | undefined = pid;
  for (let i = 0; i < 64 && current !== undefined && current > 1; i++) {
    current = await parentPid(current);
    if (current === ancestor) return true;
  }
  return false;
}

/** crot-browser-relay processes (for this state dir) that descend from the browser process: proof that the browser started them through native messaging. Linux /proc only. */
export async function relayProcessesUnder(browserPid: number, stateDir: string): Promise<Array<{ pid: number; cmdline: string }>> {
  const found: Array<{ pid: number; cmdline: string }> = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      cmdline = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\u0000").join(" ").trim();
    } catch {
      continue;
    }
    if (!cmdline.includes("crot-browser-relay") || !cmdline.includes(stateDir)) continue;
    const pid = Number(entry);
    if (await hasAncestor(pid, browserPid)) found.push({ pid, cmdline });
  }
  return found;
}

export interface CrotSession {
  readonly client: Client;
  stderr(): string;
  close(): Promise<void>;
}

/** Start the real CROT MCP server (dist/bin/crot-mcp.js) on stdio, as an MCP client / AI agent would. */
export async function startCrot(sb: Sandbox, configFile: string, auditFile: string): Promise<CrotSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CROT_MCP_BIN, "--config", configFile, "--audit-log", auditFile],
    env: sb.env,
    cwd: sb.workspace,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "crot-browser-e2e", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

export interface ToolOutcome {
  readonly isError: boolean;
  readonly body: unknown;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const result = (await client.callTool({ name, arguments: args })) as { content?: unknown; isError?: unknown };
  const content = Array.isArray(result.content) ? (result.content as Array<{ type?: unknown; text?: unknown }>) : [];
  const text = content.find((c) => c.type === "text" && typeof c.text === "string")?.text;
  if (typeof text !== "string") throw new Error(`${name}: the tool result has no text content`);
  return { isError: result.isError === true, body: JSON.parse(text) as unknown };
}

/** Call a tool that must succeed. */
export async function ok<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const outcome = await callTool(client, name, args);
  if (outcome.isError) throw new Error(`${name} failed: ${JSON.stringify(outcome.body)}`);
  return outcome.body as T;
}

/** Call a tool that must fail; returns the CROT error. */
export async function fails(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ code: string; message: string }> {
  const outcome = await callTool(client, name, args);
  if (!outcome.isError) throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(outcome.body)}`);
  return (outcome.body as { error: { code: string; message: string } }).error;
}

export interface AuditRecord {
  readonly operation: string;
  readonly outcome: string;
  readonly capabilities?: readonly string[];
  readonly error?: { readonly code: string; readonly message: string };
  readonly details?: Record<string, unknown>;
}

export async function readAudit(file: string): Promise<{ text: string; records: AuditRecord[] }> {
  const text = await readFile(file, "utf8").catch(() => "");
  const records = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
  return { text, records };
}

export async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

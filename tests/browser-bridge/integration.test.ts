import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  MAX_BROWSER_TO_HOST_FRAME_BYTES,
  MAX_HOST_TO_BROWSER_FRAME_BYTES,
  MessageReader,
  encodeMessage,
  parseHostMessage,
  type HostRequest,
} from "../../src/browser-bridge/protocol.js";
import { CROT_EXTENSION_ORIGIN, CROT_NATIVE_HOST_NAME } from "../../src/cli/browser-install.js";
import { isWindows, makeTempDirs, waitFor, type TempDirs } from "../helpers.js";

/**
 * End-to-end tests of the browser chain with the built CROT (ARCHITECTURE.md §16):
 *
 *   MCP client -> crot-mcp (Core, PermissionEngine, BrowserBridge) <-IPC-> crot-browser-relay <-native messaging-> fake extension
 *
 * The relay is the built executable, started the way the browser starts it.
 * The test plays the CROT Browser Extension on the relay's stdin/stdout. The
 * real extension is covered by its own tests (npm run test:extension).
 */

// Built from the current sources by tests/global-setup.ts; the relay is built next to it.
const bin = inject("crotMcpBin");
const relayScript = path.join(path.dirname(bin), "crot-browser-relay.js");

const TIMEOUT = 60_000;
const BROWSER = { name: "Chrome", version: "130.0.0.0", extensionVersion: "0.1.0" };
const TABS = [
  {
    tabId: 7,
    windowId: 1,
    url: "https://example.com/private/path?q=secret",
    title: "Private Title",
    active: true,
    status: "complete",
  },
  { tabId: 9, windowId: 1, url: "https://example.org/", title: "Other", active: false },
];

/** Sandbox defaults (src/core/permissions/policy.ts); browser capabilities are never among them. */
const SANDBOX_DEFAULTS = [
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "process.manage",
  "git.read",
  "git.write",
];

/** JSON body of a tool result. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped tool result bodies in a test helper
type Json = any;

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

function defaultReply(request: HostRequest): Reply {
  const params = request.params;
  switch (request.command) {
    case "tabs.list":
      return { ok: true, result: { tabs: TABS } };
    case "tabs.open":
      return { ok: true, result: { tabId: 11, url: String(params.url) } };
    case "page.read":
      // Ignores maxBytes: Core must enforce it regardless.
      return {
        ok: true,
        result: {
          tabId: 7,
          url: TABS[0]!.url,
          title: "Private Title",
          format: params.format,
          content: "x".repeat(100),
          truncated: false,
        },
      };
    default:
      return {
        ok: false,
        error: { code: "BROWSER_PAGE_RESTRICTED", message: "The browser does not allow this on the page." },
      };
  }
}

/** The CROT Browser Extension side of a relay process started like the browser starts it. */
class FakeExtension {
  /** Every request that reached the extension. */
  readonly requests: HostRequest[] = [];
  /** Messages that are neither welcome nor request (none are expected). */
  readonly unexpected: unknown[] = [];
  readonly exited: Promise<number | null>;
  reply: (request: HostRequest) => Reply = defaultReply;
  welcomed = false;
  private stderrText = "";
  private readonly reader = new MessageReader(MAX_HOST_TO_BROWSER_FRAME_BYTES);

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => {
      for (const value of this.reader.push(chunk)) this.onMessage(value);
    });
    child.stderr.on("data", (chunk: Buffer) => (this.stderrText += chunk.toString()));
    child.stdin.on("error", () => undefined);
    this.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  }

  get stderr(): string {
    return this.stderrText;
  }

  send(message: unknown): void {
    this.child.stdin.write(encodeMessage(message, MAX_BROWSER_TO_HOST_FRAME_BYTES));
  }

  /** hello -> welcome, as the extension does after connectNative. */
  async handshake(): Promise<void> {
    this.send({ type: "hello", protocol: BRIDGE_PROTOCOL_VERSION, browser: BROWSER });
    await waitFor(() => this.welcomed, 10_000).catch(() => {
      throw new Error(`no welcome from the relay; relay stderr: ${this.stderr}`);
    });
  }

  /** The browser closes the port: stdin ends. */
  disconnect(): void {
    this.child.stdin.end();
  }

  private onMessage(value: unknown): void {
    let message;
    try {
      message = parseHostMessage(value);
    } catch {
      this.unexpected.push(value);
      return;
    }
    if (message.type === "welcome") {
      this.welcomed = true;
    } else if (message.type === "request") {
      this.requests.push(message);
      this.send({ type: "response", id: message.id, ...this.reply(message) });
    } else {
      this.unexpected.push(value);
    }
  }
}

interface Host {
  /** Environment that points CROT's platform directories into the test directory. */
  readonly env: Record<string, string>;
  /** The CROT state directory crot-mcp derives from `env`. */
  readonly stateDir: string;
  readonly home: string;
}

let dirs: TempDirs;
let host: Host;
const cleanups: (() => Promise<unknown> | void)[] = [];

beforeEach(async () => {
  dirs = await makeTempDirs();
  host = await hostEnvironment();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
  await dirs.cleanup();
});

/**
 * Per-platform state directory (src/core/platform/directories.ts):
 * Linux $XDG_STATE_HOME/crot, macOS ~/Library/Application Support/CROT/State,
 * Windows %LOCALAPPDATA%\CROT.
 */
async function hostEnvironment(): Promise<Host> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  if (isWindows) {
    const local = path.join(dirs.outside, "local");
    const env = { ...inherited, LOCALAPPDATA: local, APPDATA: path.join(dirs.outside, "roaming") };
    return { env, stateDir: path.join(local, "CROT"), home: os.homedir() };
  }
  if (process.platform === "darwin") {
    // A short HOME: the bridge socket lives below it and Unix socket paths are limited to 103 bytes.
    const home = await realpath(await mkdtemp("/tmp/crot-h-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    return {
      env: { ...inherited, HOME: home },
      stateDir: path.join(home, "Library", "Application Support", "CROT", "State"),
      home,
    };
  }
  const home = path.join(dirs.outside, "home");
  const env = {
    ...inherited,
    HOME: home,
    XDG_STATE_HOME: path.join(dirs.outside, "state"),
    XDG_CONFIG_HOME: path.join(dirs.outside, "config"),
  };
  return { env, stateDir: path.join(dirs.outside, "state", "crot"), home };
}

interface ServeOptions {
  readonly mode: "sandbox" | "full_control";
  readonly capabilities?: readonly string[];
  readonly auditFile?: string;
  readonly name?: string;
}

/** Tool results are JSON; errors raised by the MCP SDK itself (input validation) may be plain text. */
function parseJson(text: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Start the built crot-mcp with the browser bridge enabled and connect an MCP client to it. */
async function serve(options: ServeOptions) {
  const configFile = path.join(dirs.outside, `${options.name ?? "crot"}.json`);
  const permissions = { mode: options.mode, ...(options.capabilities ? { capabilities: options.capabilities } : {}) };
  await writeFile(
    configFile,
    JSON.stringify({
      workspace: { root: dirs.workspace },
      permissions,
      environment: { path: "inherited" },
      browser: { enabled: true },
    }),
  );
  const audit = options.auditFile ? ["--audit-log", options.auditFile] : ["--no-audit"];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--config", configFile, ...audit],
    env: host.env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: "browser-e2e-test", version: "0.0.0" });
  await client.connect(transport);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
  };
  cleanups.push(close);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: Json }> => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content.find((c) => c.type === "text");
    return { isError: result.isError === true, body: text?.type === "text" ? parseJson(text.text) : undefined };
  };
  const errorCode = async (name: string, args: Record<string, unknown> = {}): Promise<string | undefined> => {
    const result = await call(name, args);
    return result.isError ? (result.body?.error?.code as string) : undefined;
  };
  const bridgeState = async (): Promise<string> => (await call("crot_status")).body?.browser?.state as string;
  return { client, call, errorCode, bridgeState, close, stderr: () => stderr };
}

/** Start the built relay the way the browser starts a native-messaging host. */
function startRelay(command: string, args: readonly string[]): FakeExtension {
  const child = spawn(command, [...args], { env: host.env, stdio: "pipe" });
  const extension = new FakeExtension(child);
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await extension.exited;
  });
  return extension;
}

const startBuiltRelay = () =>
  startRelay(process.execPath, [relayScript, "--state-dir", host.stateDir, CROT_EXTENSION_ORIGIN]);

describe("browser extension chain (built crot-mcp + crot-browser-relay)", () => {
  it(
    "full_control: tool calls reach the extension through the relay and validated results come back",
    async () => {
      const crot = await serve({ mode: "full_control" });
      expect(await crot.bridgeState()).toBe("waiting");
      expect(await crot.errorCode("browser_tabs_list")).toBe("BROWSER_NOT_CONNECTED");

      const extension = startBuiltRelay();
      await extension.handshake();
      await waitFor(async () => (await crot.bridgeState()) === "connected", 10_000);
      const status = await crot.call("browser_status");
      expect(status.body).toMatchObject({ state: "connected", browser: BROWSER });

      const tabs = await crot.call("browser_tabs_list");
      expect(tabs.isError).toBe(false);
      expect(tabs.body).toEqual({ tabs: TABS });

      const opened = await crot.call("browser_tab_open", { url: "https://example.com/docs" });
      expect(opened.body).toEqual({ tabId: 11, url: "https://example.com/docs" });

      // Core bounds page content even when the browser ignores maxBytes.
      const page = await crot.call("browser_page_read", { maxBytes: 10 });
      expect(page.body).toMatchObject({ tabId: 7, format: "text", content: "x".repeat(10), truncated: true });

      // Browser errors are mapped to allowlisted codes.
      expect(await crot.errorCode("browser_click", { selector: "#go" })).toBe("BROWSER_PAGE_RESTRICTED");

      // Responses are untrusted: one that fails Core's result schema is rejected.
      extension.reply = (request) =>
        request.command === "tabs.list"
          ? { ok: true, result: { tabs: [{ tabId: "7", url: 1 }] } }
          : defaultReply(request);
      expect(await crot.errorCode("browser_tabs_list")).toBe("OPERATION_FAILED");

      // Input is validated before anything is sent: javascript: URLs never reach the browser.
      const rejected = await crot.call("browser_tab_open", { url: "javascript:alert(1)" }).then(
        (result) => result.isError,
        () => true,
      );
      expect(rejected).toBe(true);

      expect(extension.requests.map((r) => [r.command, r.params])).toEqual([
        ["tabs.list", {}],
        ["tabs.open", { url: "https://example.com/docs", active: true }],
        ["page.read", { format: "text", maxBytes: 10 }],
        ["page.click", { selector: "#go" }],
        ["tabs.list", {}],
      ]);
      expect(extension.unexpected).toEqual([]);

      // The browser closes the port: the relay exits and the bridge waits for the next connection.
      extension.disconnect();
      expect(await extension.exited).toBe(0);
      await waitFor(async () => (await crot.bridgeState()) === "waiting", 10_000);
      expect(await crot.errorCode("browser_tabs_list")).toBe("BROWSER_NOT_CONNECTED");

      // The extension reconnects.
      const again = startBuiltRelay();
      await again.handshake();
      await waitFor(async () => (await crot.bridgeState()) === "connected", 10_000);
      expect((await crot.call("browser_tabs_list")).body).toEqual({ tabs: TABS });
    },
    TIMEOUT,
  );

  it(
    "sandbox: the PermissionEngine denies every browser tool and nothing reaches the extension",
    async () => {
      const crot = await serve({ mode: "sandbox" });
      const extension = startBuiltRelay();
      await extension.handshake();
      // The bridge state needs no authorization; it carries no browser data.
      await waitFor(async () => (await crot.bridgeState()) === "connected", 10_000);

      const calls: [string, Record<string, unknown>][] = [
        ["browser_status", {}],
        ["browser_tabs_list", {}],
        ["browser_page_read", {}],
        ["browser_screenshot", {}],
        ["browser_tab_open", { url: "https://example.com/" }],
        ["browser_navigate", { url: "https://example.com/" }],
        ["browser_tab_activate", { tabId: 7 }],
        ["browser_tab_close", { tabId: 7 }],
        ["browser_click", { selector: "#go" }],
        ["browser_type", { selector: "#q", text: "hello" }],
      ];
      for (const [name, args] of calls) expect(await crot.errorCode(name, args), name).toBe("PERMISSION_DENIED");

      // Give a (wrongly) forwarded request time to arrive before asserting none did.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(extension.requests).toEqual([]);
      expect(extension.unexpected).toEqual([]);
      // Other capabilities work normally.
      expect((await crot.call("fs_write_file", { path: "ok.txt", content: "ok" })).isError).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "sandbox with browser.read listed: reads are forwarded, control stays denied and denials are audited without page data",
    async () => {
      const auditFile = path.join(dirs.outside, "audit.jsonl");
      const crot = await serve({ mode: "sandbox", capabilities: [...SANDBOX_DEFAULTS, "browser.read"], auditFile });
      const extension = startBuiltRelay();
      await extension.handshake();
      await waitFor(async () => (await crot.bridgeState()) === "connected", 10_000);

      expect((await crot.call("browser_tabs_list")).body).toEqual({ tabs: TABS });
      expect(await crot.errorCode("browser_tab_open", { url: "https://example.com/private/path?q=secret" })).toBe(
        "PERMISSION_DENIED",
      );
      expect(await crot.errorCode("browser_navigate", { tabId: 7, url: "https://example.com/" })).toBe(
        "PERMISSION_DENIED",
      );
      expect(await crot.errorCode("browser_click", { selector: "#go" })).toBe("PERMISSION_DENIED");
      expect(await crot.errorCode("browser_type", { selector: "#q", text: "typed-secret" })).toBe("PERMISSION_DENIED");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(extension.requests.map((r) => r.command)).toEqual(["tabs.list"]);

      await crot.close();
      let audit = "";
      await waitFor(async () => {
        audit = await readFile(auditFile, "utf8").catch(() => "");
        return audit.includes("browser.type");
      }, 10_000);
      const records = audit
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { operation: string; outcome: string; details?: Record<string, unknown> });
      const outcome = (operation: string) => records.find((r) => r.operation === operation)?.outcome;
      expect(outcome("browser.tabs_list")).toBe("success");
      for (const operation of ["browser.tab_open", "browser.navigate", "browser.click", "browser.type"]) {
        expect(outcome(operation), operation).toBe("denied");
      }
      expect(records.find((r) => r.operation === "browser.tab_open")?.details).toMatchObject({
        origin: "https://example.com",
      });
      // Audit records hold origins and lengths only: no full URLs, typed text or page data.
      expect(audit).not.toContain("/private/path");
      expect(audit).not.toContain("typed-secret");
      expect(audit).not.toContain("Private Title");
    },
    TIMEOUT,
  );

  it(
    "the extension cannot initiate operations: a request from the browser side closes the connection",
    async () => {
      const crot = await serve({ mode: "full_control" });
      const extension = startBuiltRelay();
      await extension.handshake();
      await waitFor(async () => (await crot.bridgeState()) === "connected", 10_000);

      extension.send({ type: "request", id: "from-browser", command: "tabs.close", params: { tabId: 7 } });
      await extension.exited;
      await waitFor(async () => (await crot.bridgeState()) === "waiting", 10_000);
      expect(extension.requests).toEqual([]);
      expect(await crot.errorCode("browser_tabs_list")).toBe("BROWSER_NOT_CONNECTED");
    },
    TIMEOUT,
  );

  it(
    "a relay without a running CROT exits with an explanation",
    async () => {
      const extension = startBuiltRelay();
      expect(await extension.exited).toBe(1);
      expect(extension.stderr).toMatch(/browser bridge is not set up|No CROT instance is listening/);
      expect(extension.welcomed).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "a second CROT instance stays in_use for its lifetime; only its browser operations fail",
    async () => {
      const owner = await serve({ mode: "full_control", name: "owner" });
      const second = await serve({ mode: "full_control", name: "second" });
      expect(await owner.bridgeState()).toBe("waiting");
      expect(await second.bridgeState()).toBe("in_use");
      expect(await second.errorCode("browser_tabs_list")).toBe("BROWSER_BRIDGE_IN_USE");
      expect((await second.call("browser_status")).body).toMatchObject({ state: "in_use" });
      expect((await second.call("fs_write_file", { path: "second.txt", content: "ok" })).isError).toBe(false);

      // The extension connects to the owner.
      const extension = startBuiltRelay();
      await extension.handshake();
      await waitFor(async () => (await owner.bridgeState()) === "connected", 10_000);
      expect((await owner.call("browser_tabs_list")).body).toEqual({ tabs: TABS });
      expect(await second.errorCode("browser_tabs_list")).toBe("BROWSER_BRIDGE_IN_USE");
      expect(extension.requests).toHaveLength(1);

      // No takeover: the second instance stays in_use after the owner has exited.
      await owner.close();
      await extension.exited;
      expect(await second.bridgeState()).toBe("in_use");
      expect(await second.errorCode("browser_tabs_list")).toBe("BROWSER_BRIDGE_IN_USE");
    },
    TIMEOUT,
  );

  // Windows registration writes HKCU registry keys, which a test must not touch; the launcher logic is covered in tests/cli.
  it.runIf(!isWindows)(
    "`crot-mcp browser install` registers a launcher the browser can start",
    async () => {
      const installed = await promisify(execFile)(process.execPath, [bin, "browser", "install"], { env: host.env });
      expect(installed.stdout).toContain(CROT_NATIVE_HOST_NAME);

      const chrome =
        process.platform === "darwin"
          ? path.join(host.home, "Library", "Application Support", "Google", "Chrome")
          : path.join(dirs.outside, "config", "google-chrome");
      const manifest = JSON.parse(
        await readFile(path.join(chrome, "NativeMessagingHosts", `${CROT_NATIVE_HOST_NAME}.json`), "utf8"),
      ) as {
        name: string;
        type: string;
        path: string;
        allowed_origins: string[];
      };
      expect(manifest).toMatchObject({
        name: CROT_NATIVE_HOST_NAME,
        type: "stdio",
        allowed_origins: [CROT_EXTENSION_ORIGIN],
      });
      expect(manifest.path).toBe(path.join(host.stateDir, "native-messaging", "crot-browser-host"));

      const crot = await serve({ mode: "full_control" });
      // Chromium starts the host with the calling extension's origin as its only argument.
      const extension = startRelay(manifest.path, [CROT_EXTENSION_ORIGIN]);
      await extension.handshake();
      await waitFor(async () => (await crot.bridgeState()) === "connected", 10_000);
      expect((await crot.call("browser_tabs_list")).body).toEqual({ tabs: TABS });
      extension.disconnect();
      expect(await extension.exited).toBe(0);
    },
    TIMEOUT,
  );
});

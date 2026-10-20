import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localContextResolver } from "../../src/adapters/mcp/context.js";
import { createCrotMcpServer } from "../../src/adapters/mcp/server.js";
import { TOOLS } from "../../src/adapters/mcp/tools.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import type {
  BrowserCommand,
  BrowserConnection,
  BrowserConnectionState,
} from "../../src/core/capabilities/browser/connection.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { createTestCore, makeTempDirs, type TempDirs } from "../helpers.js";

const PAGE_URL = "https://example.com/page";
const IMAGE_DATA = "iVBORw0KGgo=";

const CONNECTED: BrowserConnectionState = {
  kind: "connected",
  browser: { name: "Chrome", version: "130.0.0.0", extensionVersion: "0.1.0" },
  connectionId: "c0ffee00c0ffee00c0ffee00c0ffee00",
};

/** Valid arguments for each browser tool, and the Core operation it maps to. */
const READ_TOOLS: Record<string, Record<string, unknown>> = {
  browser_status: {},
  browser_tabs_list: {},
  browser_page_read: { tabId: 7 },
  browser_screenshot: { tabId: 7 },
  browser_snapshot: { tabId: 7 },
  browser_wait: { tabId: 7, text: "Ready" },
};
const CONTROL_TOOLS: Record<string, Record<string, unknown>> = {
  browser_dialog_handle: { tabId: 7, accept: false },
  browser_tab_open: { url: PAGE_URL },
  browser_navigate: { tabId: 7, url: PAGE_URL },
  browser_tab_activate: { tabId: 7 },
  browser_tab_close: { tabId: 7 },
  browser_click: { tabId: 7, selector: "#go" },
  browser_type: { tabId: 7, selector: "#q", text: "hello" },
  browser_hover: { tabId: 7, ref: "e1" },
  browser_scroll: { tabId: 7, deltaY: 200 },
  browser_drag: { tabId: 7, ref: "e1", to: { ref: "e2" } },
  browser_press_key: { tabId: 7, keys: ["Enter"] },
  browser_select_option: { tabId: 7, ref: "e3", values: ["b"] },
  browser_set_checked: { tabId: 7, ref: "e4", checked: true },
  browser_history: { tabId: 7, action: "back" },
};
const FILE_TOOLS: Record<string, Record<string, unknown>> = {
  browser_file_upload: { tabId: 7, ref: "e1", paths: ["fixture.txt"] },
  browser_download: { tabId: 7, url: PAGE_URL, savePath: "result.bin" },
};
const ALL_TOOLS: Record<string, Record<string, unknown>> = { ...READ_TOOLS, ...CONTROL_TOOLS };
const OPERATIONS: Record<string, string> = {
  browser_file_upload: "browser.file_upload",
  browser_download: "browser.download",
  browser_dialog_handle: "browser.dialog_handle",
  browser_status: "browser.status",
  browser_tabs_list: "browser.tabs_list",
  browser_page_read: "browser.page_read",
  browser_screenshot: "browser.screenshot",
  browser_tab_open: "browser.tab_open",
  browser_navigate: "browser.navigate",
  browser_tab_activate: "browser.tab_activate",
  browser_tab_close: "browser.tab_close",
  browser_click: "browser.click",
  browser_type: "browser.type",
  browser_snapshot: "browser.snapshot",
  browser_wait: "browser.wait",
  browser_hover: "browser.hover",
  browser_scroll: "browser.scroll",
  browser_drag: "browser.drag",
  browser_press_key: "browser.press_key",
  browser_select_option: "browser.select_option",
  browser_set_checked: "browser.set_checked",
  browser_history: "browser.history",
};

/** Stands in for the browser bridge: answers every command with a valid result. */
class FakeBrowser implements BrowserConnection {
  readonly commands: BrowserCommand[] = [];
  constructor(public current: BrowserConnectionState = CONNECTED) {}
  state(): BrowserConnectionState {
    return this.current;
  }
  async request(command: BrowserCommand, params: unknown): Promise<unknown> {
    this.commands.push(command);
    const p = params as { tabId?: number; format?: string };
    const tabId = p.tabId ?? 1;
    switch (command) {
      case "tabs.list":
        return { tabs: [{ tabId: 7, windowId: 1, url: PAGE_URL, title: "Example", active: true }] };
      case "page.read":
        return { tabId, url: PAGE_URL, title: "Example", format: p.format, content: "Hello page", truncated: false };
      case "page.screenshot":
        return { tabId, url: PAGE_URL, mimeType: "image/" + String(p.format), data: IMAGE_DATA };
      case "tabs.close":
        return { tabId, closed: true };
      case "page.snapshot":
        return {
          tabId,
          url: PAGE_URL,
          title: "Example",
          frames: [
            { frameRef: "f1", parentFrameRef: null, url: PAGE_URL, origin: "https://example.com", restricted: false },
          ],
          elements: [
            {
              ref: "e1",
              frameRef: "f1",
              role: "button",
              name: "Go",
              states: {},
              bounds: { x: 1, y: 2, width: 3, height: 4 },
              inViewport: true,
            },
          ],
          truncated: false,
        };
      case "page.wait":
        return { satisfied: true, url: PAGE_URL };
      case "page.select_option":
        return { tabId, url: PAGE_URL, navigated: false, newTabs: [], selected: ["b"] };
      case "page.set_checked":
        return { tabId, url: PAGE_URL, navigated: false, newTabs: [], checked: true, changed: true };
      default:
        return { tabId, url: PAGE_URL };
    }
  }
}

let dirs: TempDirs;
let core: CrotCore | undefined;
let client: Client | undefined;
let audit: MemoryAuditSink;

async function connect(config: Record<string, unknown>, browser?: BrowserConnection): Promise<void> {
  audit = new MemoryAuditSink();
  core = await createTestCore({ workspace: { root: dirs.workspace }, ...config }, audit, browser ? { browser } : {});
  const server = createCrotMcpServer(core, { resolveContext: localContextResolver("in-memory") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "browser-test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

async function callRaw(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client!.callTool({ name, arguments: args })) as CallToolResult;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await callRaw(name, args);
  const first = result.content[0];
  const body = first && first.type === "text" ? JSON.parse(first.text) : undefined;
  return { isError: result.isError === true, body };
}

beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await client?.close();
  await core?.shutdown();
  client = undefined;
  core = undefined;
  await dirs.cleanup();
});

describe("MCP browser tools", () => {
  it("registers exactly the agreed browser tools with matching annotations", async () => {
    await connect({});
    const { tools } = await client!.listTools();
    const names = tools.map((t) => t.name).filter((n) => n.startsWith("browser_"));
    expect(names.sort()).toEqual(Object.keys({ ...ALL_TOOLS, ...FILE_TOOLS }).sort());
    expect(TOOLS.filter((t) => t.name.startsWith("browser_"))).toHaveLength(22);
    for (const t of tools.filter((x) => x.name.startsWith("browser_"))) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description).toContain(t.name in READ_TOOLS ? "browser.read" : "browser.control");
      expect(t.annotations?.readOnlyHint).toBe(t.name in READ_TOOLS);
    }
    expect(client!.getInstructions()).toContain("browser_status");
  });

  it("denies every browser tool in SANDBOX by default, before the bridge is used", async () => {
    const browser = new FakeBrowser();
    await connect({}, browser);
    for (const [name, args] of Object.entries({ ...ALL_TOOLS, ...FILE_TOOLS })) {
      const { isError, body } = await call(name, args);
      expect(isError, name).toBe(true);
      expect(body.error.code, name).toBe("PERMISSION_DENIED");
      const event = audit.events.at(-1)!;
      expect(event.operation).toBe(OPERATIONS[name]);
      expect(event.outcome).toBe("denied");
    }
    expect(browser.commands).toEqual([]);
  });

  it("browser.read alone allows the read tools only", async () => {
    const browser = new FakeBrowser();
    await connect({ permissions: { mode: "sandbox", capabilities: ["browser.read"] } }, browser);
    for (const [name, args] of Object.entries(READ_TOOLS)) {
      expect((await callRaw(name, args)).isError, name).toBeFalsy();
    }
    for (const [name, args] of Object.entries({ ...CONTROL_TOOLS, ...FILE_TOOLS })) {
      const { isError, body } = await call(name, args);
      expect(isError, name).toBe(true);
      expect(body.error.code, name).toBe("PERMISSION_DENIED");
    }
    expect(browser.commands).toEqual(["tabs.list", "page.read", "page.screenshot", "page.snapshot", "page.wait"]);
  });

  it("delegates every browser tool to Core and audits its operation (FULL_CONTROL)", async () => {
    const browser = new FakeBrowser();
    // Reads and actions in one session: the untrusted-content rule (AD-12) is off here.
    await connect({ permissions: { mode: "full_control", approvals: { untrustedContent: "off" } } }, browser);
    for (const [name, args] of Object.entries(ALL_TOOLS)) {
      expect((await callRaw(name, args)).isError, name).toBeFalsy();
      const event = audit.events.at(-1)!;
      expect(event.operation).toBe(OPERATIONS[name]);
      expect(event.outcome).toBe("success");
    }
    expect((await call("browser_status")).body).toMatchObject({ state: "connected", browser: { name: "Chrome" } });
    expect((await call("browser_tabs_list")).body.tabs[0]).toMatchObject({ tabId: 7, url: PAGE_URL });
    expect((await call("browser_page_read", { tabId: 7 })).body).toMatchObject({
      tabId: 7,
      format: "text",
      content: "Hello page",
    });
    expect((await call("browser_tab_close", { tabId: 7 })).body).toEqual({ tabId: 7, closed: true });
    // Typed text never reaches the audit log.
    await call("browser_type", { tabId: 7, selector: "#q", text: "secret-typed-text" });
    expect(JSON.stringify(audit.events)).not.toContain("secret-typed-text");
    // Key sequences are audited as a count only.
    await call("browser_press_key", { tabId: 7, keys: ["s", "e", "c", "r", "e", "t", "ControlOrMeta+Q"] });
    expect(audit.events.at(-1)!.details).toMatchObject({ keyCount: 7 });
    expect(JSON.stringify(audit.events.at(-1))).not.toContain("ControlOrMeta+Q");
    expect((await call("browser_snapshot", { tabId: 7 })).body.elements[0]).toMatchObject({
      ref: "e1",
      role: "button",
    });
  });

  it("returns screenshots as MCP image content followed by metadata", async () => {
    await connect({ permissions: { mode: "full_control" } }, new FakeBrowser());
    const result = await callRaw("browser_screenshot", { tabId: 7, format: "jpeg", quality: 80 });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "image", data: IMAGE_DATA, mimeType: "image/jpeg" });
    const meta = result.content[1];
    expect(meta?.type === "text" ? JSON.parse(meta.text) : undefined).toEqual({
      tabId: 7,
      url: PAGE_URL,
      mimeType: "image/jpeg",
    });
  });

  it("keeps other tools working when another instance owns the bridge (decision B)", async () => {
    const browser = new FakeBrowser({ kind: "in_use" });
    await connect(
      {
        permissions: {
          mode: "sandbox",
          capabilities: ["filesystem.read", "filesystem.write", "browser.read", "browser.control"],
        },
      },
      browser,
    );
    for (const name of ["browser_tabs_list", "browser_click"]) {
      const { isError, body } = await call(name, ALL_TOOLS[name]);
      expect(isError, name).toBe(true);
      expect(body.error.code, name).toBe("BROWSER_BRIDGE_IN_USE");
    }
    expect((await call("browser_status")).body.state).toBe("in_use");
    expect((await call("crot_status")).body.browser).toEqual({ state: "in_use" });
    expect((await call("fs_write_file", { path: "note.txt", content: "still working" })).isError).toBe(false);
    expect((await call("fs_read_file", { path: "note.txt" })).body.content).toBe("still working");
    expect(browser.commands).toEqual([]);
  });

  it("reports a disabled bridge without failing browser_status", async () => {
    await connect({ permissions: { mode: "full_control" } });
    expect((await call("browser_status")).body.state).toBe("disabled");
    expect((await call("crot_status")).body.browser).toEqual({ state: "disabled" });
    const { isError, body } = await call("browser_tabs_list");
    expect(isError).toBe(true);
    expect(body.error.code).toBe("BROWSER_NOT_CONNECTED");
  });

  it("rejects disallowed URLs and unknown arguments before the bridge", async () => {
    const browser = new FakeBrowser();
    await connect({ permissions: { mode: "full_control" } }, browser);
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "chrome://settings",
      "data:text/html,x",
      "relative/path",
    ]) {
      expect((await callRaw("browser_tab_open", { url })).isError, url).toBe(true);
      expect((await callRaw("browser_navigate", { url })).isError, url).toBe(true);
    }
    expect((await callRaw("browser_click", { selector: "#a", script: "alert(1)" })).isError).toBe(true);
    expect((await callRaw("browser_screenshot", { format: "png", quality: 50 })).isError).toBe(true);
    expect(browser.commands).toEqual([]);
  });
});

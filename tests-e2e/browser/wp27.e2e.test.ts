import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCrotMcpServer, localContextResolver } from "../../src/adapters/mcp/index.js";
import { BrowserBridge } from "../../src/browser-bridge/server.js";
import { CrotCore } from "../../src/core/crot-core.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { newLocalExposureScope, remoteExposureScope, type AuthContext } from "../../src/core/auth/principal.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import type { ApprovalTicket, PresentedApproval } from "../../src/core/approvals/types.js";
import { TestProvider } from "../../tests/approval-provider.js";
import * as h from "./harness.js";
class UI extends TestProvider {
  auto = true;
  override present(request: PresentedApproval, ticket: ApprovalTicket): void {
    super.present(request, ticket);
    if (this.auto) queueMicrotask(() => ticket.approve(request.subjectDigest));
  }
}
interface Tabs {
  tabs: { tabId: number; openerTabId?: number; openedBy: string }[];
}
const remote: AuthContext = {
  principal: { kind: "remote", id: "r", transport: "tunnel", accountId: "a", deviceId: "d", clientId: "c" },
  exposureScope: remoteExposureScope("a", "d", "c"),
};
describe.runIf(process.platform === "linux")("WP-27 real MCP / two contexts / Chromium", () => {
  let sb: h.Sandbox, fixture: h.FixtureServer, chrome: h.ChromeInstance, bridge: BrowserBridge, core: CrotCore;
  const clients: Client[] = [],
    servers: ReturnType<typeof createCrotMcpServer>[] = [],
    ui = new UI(),
    audit = new MemoryAuditSink();
  let a: Client, b: Client, r: Client, tabA: number, tabB: number;
  const contextA: AuthContext = {
    principal: { kind: "local", id: "local", transport: "e2e" },
    exposureScope: newLocalExposureScope(),
  };
  const contextB: AuthContext = { ...contextA, exposureScope: newLocalExposureScope() };
  const page = () => fixture.origin + "/wp27.html";
  async function connect(context?: AuthContext): Promise<Client> {
    const mcp = createCrotMcpServer(core, { resolveContext: context ? () => context : localContextResolver("e2e") });
    const [x, y] = InMemoryTransport.createLinkedPair();
    await mcp.connect(x);
    const client = new Client({ name: "wp27-agent", version: "1" });
    await client.connect(y);
    clients.push(client);
    servers.push(mcp);
    return client;
  }
  beforeAll(async () => {
    await h.assertBuilt();
    sb = await h.createSandbox();
    fixture = await h.startFixtureServer();
    const host = await h.installNativeHost(sb);
    const platform = await createNodePlatform({ env: sb.env, startupPath: "inherited" });
    bridge = await BrowserBridge.start({ stateDir: host.stateDir, privateFiles: platform.privateFiles });
    core = await CrotCore.create(
      {
        workspace: { root: sb.workspace },
        environment: { path: "inherited" },
        browser: { enabled: true },
        permissions: {
          mode: "sandbox",
          capabilities: ["browser.read", "browser.control", "filesystem.read", "filesystem.write"],
          approvals: {
            untrustedContent: "off",
            rules: [{ id: "control", match: { capabilities: ["browser.control"] } }],
          },
        },
      },
      { platform, browser: bridge, auditSink: audit, approvalProviders: [ui] },
    );
    a = await connect(contextA);
    b = await connect(contextB);
    r = await connect(remote);
    chrome = h.launchChrome(h.chromeExecutable(), sb, { remoteDebugging: true });
    await h.waitFor(
      async () => ((await h.ok<{ state: string }>(a, "browser_status")).state === "connected" ? true : undefined),
      60_000,
      "extension",
    );
    tabA = (await h.ok<{ tabId: number }>(a, "browser_tab_open", { url: page() })).tabId;
    tabB = (await h.ok<{ tabId: number }>(b, "browser_tab_open", { url: page() })).tabId;
  });
  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    for (const server of servers) await server.close().catch(() => undefined);
    await core?.shutdown();
    await bridge?.close();
    await chrome?.stop();
    await fixture?.close();
    if (sb && process.env.CROT_E2E_KEEP !== "1")
      await rm(sb.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  it("remote implicit targets are INVALID_INPUT before approvals; explicit targets work", async () => {
    const count = audit.events.length,
      presented = ui.shown.length;
    const tools: [string, Record<string, unknown>][] = [
      ["browser_page_read", {}],
      ["browser_snapshot", {}],
      ["browser_screenshot", {}],
      ["browser_wait", { text: "never" }],
      ["browser_navigate", { url: page() }],
      ["browser_history", { action: "reload" }],
      ["browser_tab_activate", {}],
      ["browser_tab_close", {}],
      ["browser_click", { selector: "button" }],
      ["browser_type", { selector: "input", text: "x" }],
      ["browser_hover", { selector: "button" }],
      ["browser_scroll", { deltaY: 1 }],
      ["browser_drag", { selector: "a", to: { selector: "b" } }],
      ["browser_press_key", { keys: ["Enter"] }],
      ["browser_select_option", { selector: "select", values: ["x"] }],
      ["browser_set_checked", { selector: "input", checked: true }],
      ["browser_dialog_handle", { accept: false }],
      ["browser_file_upload", { paths: ["fixture"] }],
      ["browser_download", { url: page(), savePath: "file" }],
    ];
    for (const [name, args] of tools) {
      const result = await h.callTool(r, name, args);
      expect(result.body, name).toMatchObject({ error: { code: "INVALID_INPUT" } });
    }
    expect(audit.events.length).toBe(count);
    expect(ui.shown.length).toBe(presented);
    await h.ok(r, "browser_snapshot", { tabId: tabA });
  });
  it("two contexts see direct tabs and popup ownership without taking ownership of user tabs", async () => {
    const openedA = await h.ok<Tabs>(a, "browser_tabs_list"),
      openedB = await h.ok<Tabs>(b, "browser_tabs_list");
    expect(openedA.tabs.find((t) => t.tabId === tabA)?.openedBy).toBe("this-context");
    expect(openedA.tabs.find((t) => t.tabId === tabB)?.openedBy).toBe("crot");
    expect(openedB.tabs.find((t) => t.tabId === tabB)?.openedBy).toBe("this-context");
    expect(openedA.tabs.some((t) => t.openedBy === "other")).toBe(true);
    const result = await h.ok<{ newTabs: number[] }>(a, "browser_click", {
      tabId: tabA,
      selector: "#popup",
      waitUntil: "commit",
    });
    expect(result.newTabs.length).toBe(1);
    const id = result.newTabs[0]!;
    const child = (await h.ok<Tabs>(a, "browser_tabs_list")).tabs.find((t) => t.tabId === id);
    expect(child).toMatchObject({ openerTabId: tabA, openedBy: "this-context" });
    expect((await h.ok<Tabs>(b, "browser_tabs_list")).tabs.find((t) => t.tabId === id)?.openedBy).toBe("crot");
    await h.ok(b, "browser_tab_close", { tabId: id });
  });
  it("wait/settle on one tab does not block another; a same-tab read waits FIFO", async () => {
    let ended = false;
    const waiting = h.callTool(a, "browser_wait", { tabId: tabA, text: "WP27_NEVER", timeoutMs: 1500 }).then((v) => {
      ended = true;
      return v;
    });
    await h.sleep(100);
    await h.ok(b, "browser_snapshot", { tabId: tabB });
    expect(ended).toBe(false);
    await h.ok(b, "browser_click", { tabId: tabB, selector: "#three", waitUntil: "commit" });
    expect(ended).toBe(false);
    const read = h.ok<{ content: string }>(b, "browser_page_read", { tabId: tabA }).then((v) => {
      expect(ended).toBe(true);
      return v;
    });
    expect((await waiting).body).toMatchObject({ error: { code: "TIMEOUT" } });
    await read;
    const calls = [
      h.ok(a, "browser_click", { tabId: tabA, selector: "#one", waitUntil: "commit" }),
      h.ok(b, "browser_click", { tabId: tabA, selector: "#two", waitUntil: "commit" }),
      h.ok(a, "browser_click", { tabId: tabA, selector: "#three", waitUntil: "commit" }),
    ];
    await Promise.all(calls);
    expect((await h.ok<{ content: string }>(a, "browser_page_read", { tabId: tabA })).content).toContain("ORDER:123");
  });
  it("sixteen waiters fit; overflow fails; AbortSignal cancellation frees a slot and never clicks", async () => {
    const waiting = core.browser
      .wait(contextA, { tabId: tabA, text: "WP27_NEVER", timeoutMs: 1200 })
      .catch((e: unknown) => e);
    await h.sleep(100);
    const abort = new AbortController();
    const cancelled = core.browser
      .click({ ...contextA, signal: abort.signal }, { tabId: tabA, selector: "#one" })
      .catch((e: unknown) => e);
    const reads = Array.from({ length: 15 }, () => core.browser.readPage(contextB, { tabId: tabA }));
    await h.sleep(100); // approval must have completed before queue capacity is checked
    await expect(core.browser.readPage(contextB, { tabId: tabA })).rejects.toMatchObject({ code: "RESOURCE_BUSY" });
    abort.abort();
    expect(await cancelled).toMatchObject({ code: "OPERATION_FAILED" });
    const replacement = core.browser.snapshot(contextB, { tabId: tabA });
    await Promise.all([waiting, ...reads, replacement]);
    expect((await h.ok<{ content: string }>(a, "browser_page_read", { tabId: tabA })).content).toContain("ORDER:123");
  });
  it("approval waiting never locks a tab; queued approval fails at head after a preceding origin change", async () => {
    ui.auto = false;
    const shownBefore = ui.shown.length;
    const click = h.callTool(b, "browser_click", { tabId: tabA, selector: "#one" });
    await h.waitFor(
      async () =>
        ui.shown.length > shownBefore && ui.shown.at(-1)?.request.subject.operation === "browser.click"
          ? true
          : undefined,
      5000,
      "pending approval",
    );
    const held = ui.last();
    await h.ok(a, "browser_snapshot", { tabId: tabA }); // no queue held by approval
    ui.auto = true;
    const waiting = core.browser
      .wait(contextA, { tabId: tabA, text: "WP27_NEVER", timeoutMs: 1000 })
      .catch((e: unknown) => e);
    await h.sleep(100);
    const nav = h.ok(a, "browser_navigate", {
      tabId: tabA,
      url: fixture.crossOrigin + "/wp27.html",
      waitUntil: "load",
    });
    await h.sleep(100);
    held.ticket.approve(held.request.subjectDigest);
    await waiting;
    await nav;
    expect((await click).body).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
    expect((await h.ok<{ content: string }>(a, "browser_page_read", { tabId: tabA })).content).toContain("ORDER:");
    expect((await h.ok<{ content: string }>(a, "browser_page_read", { tabId: tabA })).content).not.toContain("ORDER:1");
  });
});

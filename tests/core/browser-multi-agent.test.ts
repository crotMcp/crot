import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/core/auth/principal.js";
import { newLocalExposureScope, remoteExposureScope } from "../../src/core/auth/principal.js";
import type {
  BrowserCommand,
  BrowserConnection,
  BrowserConnectionState,
} from "../../src/core/capabilities/browser/connection.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { CrotError } from "../../src/core/errors.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { TestProvider } from "../approval-provider.js";
import { createTestCore, makeTempDirs, testContext, waitFor, type TempDirs } from "../helpers.js";

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
const local = (): AuthContext => ({ ...testContext, exposureScope: newLocalExposureScope() });
const remote: AuthContext = {
  principal: { kind: "remote", id: "r", transport: "tunnel", accountId: "a", deviceId: "d", clientId: "c" },
  exposureScope: remoteExposureScope("a", "d", "c"),
};
class Browser implements BrowserConnection {
  id = "a".repeat(32);
  tabs = new Map([
    [1, "https://example.com/"],
    [2, "https://example.com/"],
  ]);
  calls: { command: BrowserCommand; tabId?: number; selector?: string }[] = [];
  action: (command: BrowserCommand, params: Record<string, unknown>) => Promise<void> = async () => {};
  state(): BrowserConnectionState {
    return {
      kind: "connected",
      connectionId: this.id,
      browser: { name: "Chrome", version: "153", extensionVersion: "1" },
    };
  }
  async request(command: BrowserCommand, input: unknown): Promise<unknown> {
    const p = input as { tabId?: number; selector?: string; url?: string; format?: string };
    const tabId = p.tabId ?? 1;
    this.calls.push({
      command,
      ...(p.tabId === undefined ? {} : { tabId }),
      ...(p.selector ? { selector: p.selector } : {}),
    });
    if (command === "tabs.resolve") {
      if (!this.tabs.has(tabId)) throw new CrotError("NOT_FOUND", "closed");
      return { tabId, url: this.tabs.get(tabId) };
    }
    if (command === "tabs.list")
      return {
        tabs: [...this.tabs].map(([id, url]) => ({
          tabId: id,
          url,
          windowId: 1,
          title: "",
          active: id === 1,
          ...(id === 4 ? { openerTabId: 3 } : {}),
        })),
      };
    await this.action(command, p);
    if (command === "tabs.open") {
      this.tabs.set(3, p.url!);
      return { tabId: 3, url: p.url };
    }
    if (command === "tabs.navigate") this.tabs.set(tabId, p.url!);
    if (command === "tabs.close") {
      this.tabs.delete(tabId);
      return { tabId, closed: true };
    }
    if (command === "page.read")
      return { tabId, url: this.tabs.get(tabId), format: p.format, title: "", content: "", truncated: false };
    if (command === "page.click" && p.selector === "#popup") {
      this.tabs.set(4, "https://example.com/popup");
      return { tabId, url: this.tabs.get(tabId), newTabs: [4] };
    }
    return { tabId, url: this.tabs.get(tabId) };
  }
}
let dirs: TempDirs, core: CrotCore, browser: Browser, audit: MemoryAuditSink;
async function setup(gated = false) {
  core = await createTestCore(
    {
      workspace: { root: dirs.workspace },
      permissions: {
        mode: "sandbox",
        capabilities: ["browser.read", "browser.control", "filesystem.read", "filesystem.write"],
        approvals: {
          untrustedContent: "off",
          ...(gated ? { rules: [{ id: "control", match: { capabilities: ["browser.control"] } }] } : {}),
        },
      },
    },
    audit,
    { browser, approvalProviders: gated ? [ui] : [] },
  );
}
let ui: TestProvider;
beforeEach(async () => {
  dirs = await makeTempDirs();
  browser = new Browser();
  audit = new MemoryAuditSink();
  ui = new TestProvider();
});
afterEach(async () => {
  await core?.shutdown();
  await dirs.cleanup();
});

describe("WP-27 Core multi-agent contract", () => {
  it("rejects remote implicit targets on every tab tool before authorization or bridge traffic", async () => {
    core = await createTestCore({ workspace: { root: dirs.workspace } }, audit, { browser });
    const b = core.browser;
    const cases = [
      () => b.readPage(remote),
      () => b.screenshot(remote),
      () => b.snapshot(remote),
      () => b.wait(remote, { text: "x" }),
      () => b.navigate(remote, { url: "https://example.com/" }),
      () => b.history(remote, { action: "reload" }),
      () => b.click(remote, { selector: "button" }),
      () => b.type(remote, { selector: "input", text: "x" }),
      () => b.hover(remote, { selector: "button" }),
      () => b.scroll(remote, { deltaY: 1 }),
      () => b.drag(remote, { selector: "a", to: { selector: "b" } }),
      () => b.pressKey(remote, { keys: ["Enter"] }),
      () => b.selectOption(remote, { selector: "select", values: ["a"] }),
      () => b.setChecked(remote, { selector: "input", checked: true }),
      () => b.handleDialog(remote, { accept: false }),
      () => b.fileUpload(remote, { paths: ["a.txt"] }),
      () => b.download(remote, { url: "https://example.com/file", savePath: "a" }),
      () => b.closeTab(remote, {} as never),
      () => b.activateTab(remote, {} as never),
    ];
    for (const run of cases) await expect(run()).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(browser.calls).toEqual([]);
    expect(audit.events).toEqual([]);
  });
  it("allows explicit remote tabs and local defaults, without an implicit remote resolve", async () => {
    await setup(true);
    const clicking = core.browser.click(remote, { tabId: 1, selector: "button" });
    await ui.next();
    ui.approveLast();
    await clicking;
    expect(browser.calls.filter((c) => c.command !== "tabs.resolve")).toEqual([
      { command: "page.click", tabId: 1, selector: "button" },
    ]);
    expect(browser.calls.filter((c) => c.command === "tabs.resolve").every((c) => c.tabId === 1)).toBe(true);
    await core.browser.readPage(local());
    expect(browser.calls.at(-2)).toEqual({ command: "tabs.resolve" });
    expect(browser.calls.at(-1)).toMatchObject({ command: "page.read", tabId: 1 });
  });
  it("serializes the entire operation FIFO across agents; other tabs and untargeted tools are concurrent", async () => {
    await setup();
    const a = local(),
      b = local(),
      gate = deferred();
    browser.action = async (c, p) => {
      if (c === "page.click" && p.selector === "#first") await gate.promise;
    };
    const first = core.browser.click(a, { tabId: 1, selector: "#first" });
    await waitFor(() => browser.calls.some((c) => c.selector === "#first"));
    const second = core.browser.click(b, { tabId: 1, selector: "#second" });
    const third = core.browser.readPage(a, { tabId: 1 });
    await core.browser.click(b, { tabId: 2, selector: "#parallel" });
    await core.browser.listTabs(b);
    await core.browser.status(a);
    await core.browser.openTab(b, { url: "https://example.com/" });
    expect(browser.calls.some((c) => c.selector === "#second")).toBe(false);
    expect(browser.calls.some((c) => c.command === "page.read")).toBe(false);
    gate.release();
    await Promise.all([first, second, third]);
    expect(browser.calls.filter((c) => c.tabId === 1).map((c) => c.selector ?? c.command)).toEqual([
      "#first",
      "#second",
      "page.read",
    ]);
  });
  it("accepts sixteen waiters, rejects the seventeenth and frees a cancelled slot without side effects", async () => {
    await setup();
    const gate = deferred();
    browser.action = async () => gate.promise;
    const first = core.browser.click(local(), { tabId: 1, selector: "#running" });
    await waitFor(() => browser.calls.length === 1);
    const abort = new AbortController();
    const cancelled = core.browser
      .click({ ...local(), signal: abort.signal }, { tabId: 1, selector: "#cancelled" })
      .catch((e: unknown) => e);
    const waiting = Array.from({ length: 15 }, (_, i) => core.browser.click(local(), { tabId: 1, selector: `#${i}` }));
    await expect(core.browser.click(local(), { tabId: 1, selector: "#overflow" })).rejects.toMatchObject({
      code: "RESOURCE_BUSY",
    });
    abort.abort();
    expect(await cancelled).toMatchObject({ code: "OPERATION_FAILED" });
    const replacement = core.browser.click(local(), { tabId: 1, selector: "#replacement" });
    gate.release();
    await Promise.all([first, ...waiting, replacement]);
    expect(browser.calls.some((c) => ["#cancelled", "#overflow"].includes(c.selector ?? ""))).toBe(false);
  });
  it.each(["navigate", "close"] as const)(
    "approval waiting does not hold the queue; approved commands recheck at its head after %s",
    async (action) => {
      await setup(true);
      const a = local(),
        b = local();
      const click = core.browser.click(b, { tabId: 1, selector: "#approved" }).catch((e: unknown) => e);
      await ui.next();
      await core.browser.readPage(a, { tabId: 1 }); // read runs while approval waits
      const gate = deferred();
      browser.action = async (c) => {
        if (c === `tabs.${action}`) await gate.promise;
      };
      const nav =
        action === "navigate"
          ? core.browser.navigate(a, { tabId: 1, url: "https://other.example/" })
          : core.browser.closeTab(a, { tabId: 1 });
      await ui.next();
      ui.approveLast();
      await waitFor(() => browser.calls.some((c) => c.command === `tabs.${action}`));
      const ticket = ui.shown[0]!;
      ticket.ticket.approve(ticket.request.subjectDigest);
      await new Promise((r) => setTimeout(r, 20));
      gate.release();
      await nav;
      expect(await click).toMatchObject({ code: "PERMISSION_DENIED" });
      expect(browser.calls.some((c) => c.command === "page.click")).toBe(false);
      expect(audit.events.some((e) => e.operation === "browser.click" && e.outcome === "denied")).toBe(true);
    },
  );
  it("attributes direct and verified opener popups by exposure scope, prunes closed tabs and resets connection", async () => {
    await setup();
    const a = local(),
      b = local();
    await core.browser.openTab(a, { url: "https://example.com/" });
    await core.browser.click(a, { tabId: 3, selector: "#popup" });
    const listed = await core.browser.listTabs(a);
    expect(listed.tabs.map((t) => t.openedBy)).toEqual(["other", "other", "this-context", "this-context"]);
    expect((await core.browser.listTabs(b)).tabs.slice(2).map((t) => t.openedBy)).toEqual(["crot", "crot"]);
    await core.browser.closeTab(b, { tabId: 3 });
    browser.tabs.set(3, "https://example.com/user-created");
    expect((await core.browser.listTabs(a)).tabs.find((t) => t.tabId === 3)?.openedBy).toBe("other");
    browser.id = "b".repeat(32);
    expect((await core.browser.listTabs(a)).tabs.every((t) => t.openedBy === "other")).toBe(true);
  });
  it("uses remote triple equality, not recreated token/session scope identity", async () => {
    await setup(true);
    const opening = core.browser.openTab(remote, { url: "https://example.com/" });
    await ui.next();
    ui.approveLast();
    await opening;
    const refreshed = { ...remote, exposureScope: remoteExposureScope("a", "d", "c") };
    expect((await core.browser.listTabs(refreshed)).tabs.find((t) => t.tabId === 3)?.openedBy).toBe("this-context");
    const other = { ...remote, exposureScope: remoteExposureScope("a", "d", "other") };
    expect((await core.browser.listTabs(other)).tabs.find((t) => t.tabId === 3)?.openedBy).toBe("crot");
  });
});

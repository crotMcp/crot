import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import type {
  BrowserCommand,
  BrowserConnection,
  BrowserConnectionState,
  BrowserRequestOptions,
} from "../../src/core/capabilities/browser/connection.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { CrotError } from "../../src/core/errors.js";
import { TestProvider } from "../approval-provider.js";
import { createTestCore, makeTempDirs, testContext as ctx, type TempDirs } from "../helpers.js";

const BROWSER = { name: "Chrome", version: "130.0.0.0", extensionVersion: "0.1.0" };
const CONNECTION_A = "a".repeat(32);
const CONNECTION_B = "b".repeat(32);

type Params = Record<string, unknown> & {
  tabId?: number;
  url?: string;
  expect?: { tabId?: number; origin: string; connectionId: string };
};

const originOf = (url: string | undefined): string | undefined => {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Stands in for the bridge and the extension: the bridge's connectionId check
 * before sending, tabs.resolve, and the extension's expected subject check
 * immediately before acting (AD-8, AD-9, AD-11).
 */
class BrowserStub implements BrowserConnection {
  current: BrowserConnectionState = { kind: "connected", browser: BROWSER, connectionId: CONNECTION_A };
  readonly tabs = new Map<number, string>([
    [7, "https://example.com/page"],
    [9, "chrome://settings/"],
  ]);
  active: number | undefined = 7;
  readonly sent: { command: BrowserCommand; params: Params; connectionId?: string }[] = [];
  readonly performed: BrowserCommand[] = [];

  state(): BrowserConnectionState {
    return this.current;
  }

  private get connectionId(): string | undefined {
    return this.current.kind === "connected" ? this.current.connectionId : undefined;
  }

  async request(command: BrowserCommand, raw: unknown, options: BrowserRequestOptions): Promise<unknown> {
    const params = raw as Params;
    if (options.connectionId !== undefined && options.connectionId !== this.connectionId)
      throw new CrotError("PERMISSION_DENIED", "connection changed; not sent");
    this.sent.push({
      command,
      params,
      ...(options.connectionId !== undefined ? { connectionId: options.connectionId } : {}),
    });
    if (command === "tabs.resolve") {
      const tabId = params.tabId ?? this.active;
      const url = tabId === undefined ? undefined : this.tabs.get(tabId);
      if (tabId === undefined || url === undefined) throw new CrotError("NOT_FOUND", "There is no active tab.");
      return { tabId, url };
    }
    const expected = params.expect;
    if (expected) {
      if (expected.connectionId !== this.connectionId) throw new CrotError("PERMISSION_DENIED", "connection");
      if (command !== "tabs.open") {
        if (params.tabId !== expected.tabId || !this.tabs.has(expected.tabId ?? -1))
          throw new CrotError("PERMISSION_DENIED", "tab");
        if (originOf(this.tabs.get(expected.tabId ?? -1)) !== expected.origin)
          throw new CrotError("PERMISSION_DENIED", "origin");
      } else if (originOf(params.url) !== expected.origin) throw new CrotError("PERMISSION_DENIED", "origin");
    }
    this.performed.push(command);
    const tabId = params.tabId ?? this.active ?? 0;
    switch (command) {
      case "tabs.open":
        return { tabId: 100, url: params.url };
      case "page.read":
        return { tabId, url: this.tabs.get(tabId), title: "", format: "text", content: "x", truncated: false };
      default:
        return { tabId, url: this.tabs.get(tabId) ?? "" };
    }
  }
}

let dirs: TempDirs;
let core: CrotCore | undefined;
let stub: BrowserStub;
let ui: TestProvider;
let audit: MemoryAuditSink;

beforeEach(async () => {
  dirs = await makeTempDirs();
  stub = new BrowserStub();
  ui = new TestProvider();
  audit = new MemoryAuditSink();
  core = await createTestCore(
    {
      workspace: { root: dirs.workspace },
      permissions: {
        mode: "sandbox",
        capabilities: ["browser.read", "browser.control"],
        approvals: { rules: [{ id: "browser-control", match: { capabilities: ["browser.control"] } }] },
      },
    },
    audit,
    { browser: stub, approvalProviders: [ui] },
  );
});
afterEach(async () => {
  await core?.shutdown();
  core = undefined;
  await dirs.cleanup();
});

const c = (): CrotCore => {
  if (!core) throw new Error("no core");
  return core;
};

describe("browser approvals (AD-6, AD-8, AD-9, AD-11)", () => {
  it("binds the default active tab with tabs.resolve and sends the expected subject", async () => {
    const clicking = c().browser.click(ctx, { selector: "#buy" });
    const { request } = await ui.next();
    const binding = { tabId: 7, origin: "https://example.com", connectionId: CONNECTION_A };
    expect(request.subject.browser).toEqual(binding);
    expect(request.subject.summary).toBe("Click an element in a browser tab");
    expect(request.subject.effects).toEqual(
      expect.arrayContaining([
        { label: "selector", value: "#buy" },
        { label: "tab URL", value: "https://example.com/page", flag: "page_supplied" },
      ]),
    );
    expect(stub.sent).toEqual([{ command: "tabs.resolve", params: {}, connectionId: CONNECTION_A }]);
    expect(stub.performed).toEqual([]);
    ui.approveLast();
    await expect(clicking).resolves.toEqual({ tabId: 7, url: "https://example.com/page" });
    expect(stub.sent[1]).toEqual({
      command: "page.click",
      params: { tabId: 7, selector: "#buy", expect: binding },
      connectionId: CONNECTION_A,
    });
    const done = audit.events.at(-1);
    expect(done).toMatchObject({ outcome: "success", details: { tabId: "active" }, approval: { status: "approved" } });
    expect(JSON.stringify(audit.events)).not.toContain(CONNECTION_A); // the subject is not audited
  });

  it("denies when the tab's origin changed while pending; the action is not performed", async () => {
    const clicking = c().browser.click(ctx, { tabId: 7, selector: "#buy" });
    await ui.next();
    stub.tabs.set(7, "https://evil.example/phish");
    ui.approveLast();
    await expect(clicking).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { operation: "browser.click", missing: [], approval: { status: "approved" } },
    });
    expect(stub.performed).toEqual([]);
    expect(audit.events.at(-1)).toMatchObject({
      outcome: "denied",
      error: { code: "PERMISSION_DENIED" },
      approval: { status: "approved" },
    });
  });

  it("denies when the tab was closed, and never transfers the approval to another tab", async () => {
    const typing = c().browser.type(ctx, { selector: "#q", text: "secret" });
    await ui.next();
    stub.tabs.delete(7);
    stub.tabs.set(8, "https://example.com/page"); // same origin, other tab
    stub.active = 8;
    ui.approveLast();
    await expect(typing).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(stub.performed).toEqual([]);
    expect(stub.sent.at(-1)?.params).toMatchObject({ tabId: 7 });
  });

  it("denies when the browser connection changed; the command is not sent", async () => {
    const navigating = c().browser.navigate(ctx, { url: "https://example.com/next" });
    await ui.next();
    stub.current = { kind: "connected", browser: BROWSER, connectionId: CONNECTION_B };
    ui.approveLast();
    await expect(navigating).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { approval: { status: "approved" } },
    });
    expect(stub.sent.map((s) => s.command)).toEqual(["tabs.resolve"]);
  });

  it("denies when the connection is lost while pending", async () => {
    const closing = c().browser.closeTab(ctx, { tabId: 7 });
    await ui.next();
    stub.current = { kind: "waiting" };
    ui.approveLast();
    await expect(closing).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(stub.performed).toEqual([]);
  });

  it("binds tab_open to the origin of the URL it opens", async () => {
    const opening = c().browser.openTab(ctx, { url: "HTTPS://Example.ORG/start?x=1" });
    const { request } = await ui.next();
    expect(request.subject.browser).toEqual({ origin: "https://example.org", connectionId: CONNECTION_A });
    expect(request.subject.effects).toContainEqual({ label: "URL", value: "HTTPS://Example.ORG/start?x=1" });
    expect(stub.sent).toEqual([]); // no tabs.resolve for tab_open
    ui.approveLast();
    await opening;
    expect(stub.sent[0]?.params.expect).toEqual({ origin: "https://example.org", connectionId: CONNECTION_A });
  });

  it("denies without a request when the tab cannot be determined", async () => {
    stub.active = undefined;
    await expect(c().browser.click(ctx, { selector: "#a" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { approval: { status: "unavailable" } },
    });
    await expect(c().browser.click(ctx, { tabId: 9, selector: "#a" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { approval: { status: "unavailable" } },
    });
    stub.current = { kind: "waiting" };
    await expect(c().browser.activateTab(ctx, { tabId: 7 })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { approval: { status: "unavailable" } },
    });
    expect(ui.shown).toHaveLength(0);
    expect(stub.performed).toEqual([]);
    expect(audit.events.every((e) => e.outcome === "denied" && e.approval?.status === "unavailable")).toBe(true);
  });

  it("leaves operations without a matching rule unchanged (no tabs.resolve, no expected subject)", async () => {
    await c().browser.readPage(ctx, {});
    expect(stub.sent).toEqual([{ command: "page.read", params: { format: "text", maxBytes: 10 * 1024 * 1024 } }]);
    expect(ui.shown).toHaveLength(0);
  });

  it("does not let the browser claim PERMISSION_DENIED for operations without a binding", async () => {
    const original = stub.request.bind(stub);
    stub.request = async (command, params, options) => {
      if (command === "page.read") throw new CrotError("PERMISSION_DENIED", "nope");
      return original(command, params, options);
    };
    await expect(c().browser.readPage(ctx, {})).rejects.toMatchObject({ code: "OPERATION_FAILED" });
  });
});

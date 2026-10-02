import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import type {
  BrowserCommand,
  BrowserCommandParams,
  BrowserConnection,
  BrowserConnectionState,
  BrowserRequestOptions,
} from "../../src/core/capabilities/browser/connection.js";
import type { BrowserInfo } from "../../src/core/capabilities/browser/schemas.js";
import { BrowserService } from "../../src/core/capabilities/browser/service.js";
import { CrotError } from "../../src/core/errors.js";
import { ExecutionGuard } from "../../src/core/execution/guard.js";
import type { Capability } from "../../src/core/permissions/capabilities.js";
import { PermissionEngine } from "../../src/core/permissions/engine.js";
import { createPermissionPolicy, type PermissionMode } from "../../src/core/permissions/policy.js";
import { testContext as ctx } from "../helpers.js";

const BROWSER: BrowserInfo = { name: "Chrome", version: "130.0.0.0", extensionVersion: "0.1.0" };
const PAGE_URL = "https://example.com/page";
const DEFAULT_MAX_READ = 10 * 1024 * 1024;

type Handler = (params: Record<string, unknown>, options: BrowserRequestOptions) => unknown;

function defaultResponse(command: BrowserCommand, p: Record<string, unknown>): unknown {
  const tabId = typeof p.tabId === "number" ? p.tabId : 1;
  switch (command) {
    case "tabs.list":
      return { tabs: [{ tabId: 1, windowId: 1, url: PAGE_URL, title: "Example", active: true, status: "complete" }] };
    case "tabs.open":
      return { tabId: 7, url: p.url };
    case "tabs.navigate":
      return { tabId, url: p.url };
    case "tabs.activate":
    case "page.click":
    case "page.type":
      return { tabId, url: PAGE_URL };
    case "tabs.close":
      return { tabId, closed: true };
    case "page.read":
      return { tabId, url: PAGE_URL, title: "Example", format: p.format, content: "hello", truncated: false };
    case "page.screenshot":
      return { tabId, url: PAGE_URL, mimeType: `image/${String(p.format)}`, data: Buffer.from("image-bytes").toString("base64") };
  }
}

/** Stands in for the browser bridge. Records every request it receives. */
class FakeConnection implements BrowserConnection {
  current: BrowserConnectionState = { kind: "connected", browser: BROWSER };
  readonly calls: { command: BrowserCommand; params: Record<string, unknown> }[] = [];
  readonly handlers = new Map<BrowserCommand, Handler>();

  state(): BrowserConnectionState {
    return this.current;
  }

  async request<C extends BrowserCommand>(command: C, params: BrowserCommandParams[C], options: BrowserRequestOptions): Promise<unknown> {
    const p = { ...(params as unknown as Record<string, unknown>) };
    this.calls.push({ command, params: p });
    const handler = this.handlers.get(command);
    return handler ? handler(p, options) : defaultResponse(command, p);
  }
}

interface SetupOptions {
  readonly mode?: PermissionMode;
  readonly capabilities?: readonly Capability[];
  /** null: browser support disabled (no connection). */
  readonly connection?: null;
  readonly timeoutMs?: number;
  readonly maxReadBytes?: number;
}

function setup(options: SetupOptions = {}) {
  const mode = options.mode ?? "sandbox";
  const policy = createPermissionPolicy(options.capabilities ? { mode, capabilities: options.capabilities } : { mode });
  const audit = new MemoryAuditSink();
  const guard = new ExecutionGuard(new PermissionEngine(policy), audit);
  const fake = new FakeConnection();
  const service = new BrowserService({
    guard,
    limits: { maxReadBytes: options.maxReadBytes ?? DEFAULT_MAX_READ },
    ...(options.connection === null ? {} : { connection: fake }),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { service, audit, fake };
}

type Op = readonly [operation: string, command: BrowserCommand | undefined, run: (s: BrowserService) => Promise<unknown>];

const READ_OPS: readonly Op[] = [
  ["browser.status", undefined, (s) => s.status(ctx)],
  ["browser.tabs_list", "tabs.list", (s) => s.listTabs(ctx)],
  ["browser.page_read", "page.read", (s) => s.readPage(ctx, {})],
  ["browser.screenshot", "page.screenshot", (s) => s.screenshot(ctx, {})],
];
const CONTROL_OPS: readonly Op[] = [
  ["browser.tab_open", "tabs.open", (s) => s.openTab(ctx, { url: "https://example.com/" })],
  ["browser.navigate", "tabs.navigate", (s) => s.navigate(ctx, { tabId: 1, url: "https://example.com/next" })],
  ["browser.tab_activate", "tabs.activate", (s) => s.activateTab(ctx, { tabId: 1 })],
  ["browser.tab_close", "tabs.close", (s) => s.closeTab(ctx, { tabId: 1 })],
  ["browser.click", "page.click", (s) => s.click(ctx, { tabId: 1, selector: "#go" })],
  ["browser.type", "page.type", (s) => s.type(ctx, { tabId: 1, selector: "#q", text: "hello" })],
];
const ALL_OPS: readonly Op[] = [...READ_OPS, ...CONTROL_OPS];

describe("BrowserService authorization", () => {
  it("denies every browser operation under SANDBOX defaults without contacting the browser", async () => {
    const { service, audit, fake } = setup();
    for (const [operation, , run] of ALL_OPS) {
      await expect(run(service), operation).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
    expect(fake.calls).toEqual([]);
    expect(audit.events.map((e) => [e.operation, e.outcome])).toEqual(ALL_OPS.map(([operation]) => [operation, "denied"]));
  });

  it("authorizes before checking the bridge state", async () => {
    const { service, fake } = setup();
    fake.current = { kind: "in_use" };
    await expect(service.listTabs(ctx)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(service.openTab(ctx, { url: "https://example.com/" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fake.calls).toEqual([]);
  });

  it("allows only read operations when SANDBOX lists browser.read explicitly", async () => {
    const { service, fake } = setup({ capabilities: ["filesystem.read", "browser.read"] });
    for (const [operation, , run] of READ_OPS) await expect(run(service), operation).resolves.toBeDefined();
    for (const [operation, , run] of CONTROL_OPS) {
      await expect(run(service), operation).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
    expect(fake.calls.map((c) => c.command)).toEqual(["tabs.list", "page.read", "page.screenshot"]);
  });

  it("allows browser.control in SANDBOX when listed explicitly", async () => {
    const { service, fake } = setup({ capabilities: ["browser.read", "browser.control"] });
    for (const [operation, , run] of ALL_OPS) await expect(run(service), operation).resolves.toBeDefined();
    expect(fake.calls.map((c) => c.command)).toEqual(ALL_OPS.flatMap(([, command]) => (command ? [command] : [])));
  });

  it("FULL_CONTROL grants every browser operation", async () => {
    const { service } = setup({ mode: "full_control" });
    for (const [operation, , run] of ALL_OPS) await expect(run(service), operation).resolves.toBeDefined();
  });
});

describe("BrowserService bridge state", () => {
  it("fails browser operations with BROWSER_BRIDGE_IN_USE while another instance owns the bridge", async () => {
    const { service, fake, audit } = setup({ mode: "full_control" });
    fake.current = { kind: "in_use" };
    for (const [operation, command, run] of ALL_OPS) {
      if (!command) continue;
      await expect(run(service), operation).rejects.toMatchObject({ code: "BROWSER_BRIDGE_IN_USE" });
    }
    expect(fake.calls).toEqual([]);
    expect(service.state()).toBe("in_use");
    await expect(service.status(ctx)).resolves.toMatchObject({ state: "in_use" });
    const errors = audit.events.filter((e) => e.outcome === "error");
    expect(errors).toHaveLength(9);
    expect(errors.every((e) => e.error?.code === "BROWSER_BRIDGE_IN_USE")).toBe(true);
  });

  it("fails with BROWSER_NOT_CONNECTED while waiting for the extension", async () => {
    const { service, fake } = setup({ mode: "full_control" });
    fake.current = { kind: "waiting" };
    await expect(service.listTabs(ctx)).rejects.toMatchObject({ code: "BROWSER_NOT_CONNECTED" });
    await expect(service.status(ctx)).resolves.toMatchObject({ state: "waiting" });
    expect(fake.calls).toEqual([]);
  });

  it("fails with BROWSER_NOT_CONNECTED when browser support is disabled", async () => {
    const { service } = setup({ mode: "full_control", connection: null });
    expect(service.state()).toBe("disabled");
    await expect(service.status(ctx)).resolves.toMatchObject({ state: "disabled" });
    await expect(service.listTabs(ctx)).rejects.toMatchObject({ code: "BROWSER_NOT_CONNECTED" });
  });

  it("reports the connected browser", async () => {
    const { service } = setup({ mode: "full_control" });
    await expect(service.status(ctx)).resolves.toEqual({ state: "connected", browser: BROWSER, detail: expect.stringContaining("Chrome") });
  });
});

describe("BrowserService input validation", () => {
  const rejectedUrls = [
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    "file:///etc/passwd",
    "chrome://settings",
    "about:blank",
    "ftp://example.com/",
    "example.com",
    "",
    `https://example.com/${"a".repeat(8192)}`,
  ];

  it.each(rejectedUrls)("rejects disallowed URL #%# before authorization and auditing", async (url) => {
    const { service, audit, fake } = setup({ mode: "full_control" });
    await expect(service.openTab(ctx, { url })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.navigate(ctx, { url })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(audit.events).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("rejects invalid selectors, oversized text, bad tab ids and unknown fields", async () => {
    const { service, fake } = setup({ mode: "full_control" });
    const invalid = [
      service.click(ctx, { selector: "" }),
      service.click(ctx, { selector: "a\0b" }),
      service.click(ctx, { selector: "a".repeat(1001) }),
      service.type(ctx, { selector: "#q", text: "x".repeat(100_001) }),
      service.closeTab(ctx, { tabId: -1 }),
      service.activateTab(ctx, { tabId: 1.5 }),
      service.readPage(ctx, { maxBytes: 0 }),
      service.listTabs(ctx, { extra: true } as never),
      service.screenshot(ctx, { format: "png", quality: 50 }),
    ];
    for (const [index, pending] of invalid.entries()) {
      await expect(pending, `case ${index}`).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("passes JPEG quality to the browser", async () => {
    const { service, fake } = setup({ mode: "full_control" });
    await expect(service.screenshot(ctx, { format: "jpeg", quality: 70 })).resolves.toMatchObject({ mimeType: "image/jpeg" });
    expect(fake.calls[0]?.params).toEqual({ format: "jpeg", quality: 70 });
  });
});

describe("BrowserService auditing", () => {
  it("records only audit-safe details", async () => {
    const { service, audit, fake } = setup({ mode: "full_control" });
    fake.handlers.set("page.read", (p) => ({
      tabId: 1,
      url: PAGE_URL,
      title: "Secret",
      format: p.format,
      content: "TOP-SECRET-PAGE-CONTENT",
      truncated: false,
    }));
    await service.navigate(ctx, { tabId: 3, url: "https://user:hunter2@example.com/private/path?token=abc123#frag" });
    await service.type(ctx, { tabId: 3, selector: "#password", text: "my-typed-secret" });
    await service.click(ctx, { selector: "x".repeat(500) });
    await service.readPage(ctx, { tabId: 1 });
    const serialized = JSON.stringify(audit.events);
    for (const secret of ["hunter2", "private/path", "abc123", "frag", "my-typed-secret", "TOP-SECRET-PAGE-CONTENT"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(audit.events.map((e) => e.details)).toEqual([
      { tabId: 3, origin: "https://example.com" },
      { tabId: 3, selector: "#password", textLength: 15, clear: false },
      { tabId: "active", selector: `${"x".repeat(200)}…` },
      { tabId: 1, format: "text", maxBytes: DEFAULT_MAX_READ },
    ]);
    expect(audit.events.every((e) => e.paths.length === 0 && e.outcome === "success")).toBe(true);
  });
});

describe("BrowserService response validation", () => {
  it("rejects malformed responses", async () => {
    const { service, fake } = setup({ mode: "full_control" });
    fake.handlers.set("tabs.list", () => ({ tabs: "nope" }));
    await expect(service.listTabs(ctx)).rejects.toMatchObject({ code: "OPERATION_FAILED", message: expect.stringContaining("invalid response") });
    fake.handlers.set("tabs.close", (p) => ({ tabId: p.tabId, closed: false }));
    await expect(service.closeTab(ctx, { tabId: 1 })).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    fake.handlers.set("page.screenshot", (p) => ({ tabId: 1, url: PAGE_URL, mimeType: `image/${String(p.format)}`, data: "not base64!" }));
    await expect(service.screenshot(ctx, {})).rejects.toMatchObject({ code: "OPERATION_FAILED" });
  });

  it("rejects too many tabs", async () => {
    const { service, fake } = setup({ mode: "full_control" });
    const tabInfo = { tabId: 1, windowId: 1, url: PAGE_URL, title: "t", active: false };
    fake.handlers.set("tabs.list", () => ({ tabs: Array.from({ length: 1001 }, () => tabInfo) }));
    await expect(service.listTabs(ctx)).rejects.toMatchObject({ code: "OPERATION_FAILED" });
  });

  it("rejects results for a different tab", async () => {
    const { service, fake } = setup({ mode: "full_control" });
    fake.handlers.set("page.read", (p) => ({ tabId: 99, url: PAGE_URL, title: "t", format: p.format, content: "", truncated: false }));
    await expect(service.readPage(ctx, { tabId: 1 })).rejects.toMatchObject({ code: "OPERATION_FAILED", message: expect.stringContaining("different tab") });
    fake.handlers.set("page.click", () => ({ tabId: 6, url: PAGE_URL }));
    await expect(service.click(ctx, { tabId: 5, selector: "#a" })).rejects.toMatchObject({ code: "OPERATION_FAILED" });
  });

  it("rejects a screenshot or page in a format other than requested", async () => {
    const { service, fake } = setup({ mode: "full_control" });
    fake.handlers.set("page.screenshot", () => ({ tabId: 1, url: PAGE_URL, mimeType: "image/jpeg", data: "aGk=" }));
    await expect(service.screenshot(ctx, { format: "png" })).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    fake.handlers.set("page.read", () => ({ tabId: 1, url: PAGE_URL, title: "t", format: "html", content: "<p>", truncated: false }));
    await expect(service.readPage(ctx, { format: "text" })).rejects.toMatchObject({ code: "OPERATION_FAILED" });
  });
});

describe("BrowserService error mapping", () => {
  it("passes allowlisted browser errors through without details", async () => {
    const { service, fake } = setup({ mode: "full_control" });
    fake.handlers.set("tabs.close", () => {
      throw new CrotError("NOT_FOUND", "No tab with id 1.", { internal: "x" });
    });
    const error = await service.closeTab(ctx, { tabId: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrotError);
    expect(error).toMatchObject({ code: "NOT_FOUND", message: "No tab with id 1." });
    expect((error as CrotError).details).toBeUndefined();

    fake.handlers.set("page.click", () => {
      throw new CrotError("BROWSER_PAGE_RESTRICTED", "Cannot access a chrome:// URL.");
    });
    await expect(service.click(ctx, { selector: "#a" })).rejects.toMatchObject({ code: "BROWSER_PAGE_RESTRICTED" });
  });

  it("never lets the browser report PERMISSION_DENIED or other codes", async () => {
    const { service, fake } = setup({ mode: "full_control" });
    fake.handlers.set("tabs.list", () => {
      throw new CrotError("PERMISSION_DENIED", "denied by the page");
    });
    await expect(service.listTabs(ctx)).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    fake.handlers.set("tabs.list", () => {
      throw new CrotError("CONFIG_ERROR", "bad");
    });
    await expect(service.listTabs(ctx)).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    fake.handlers.set("tabs.list", () => {
      throw new Error("boom");
    });
    await expect(service.listTabs(ctx)).rejects.toMatchObject({ code: "OPERATION_FAILED", message: expect.stringContaining("boom") });
  });

  it("bounds browser messages and strips control characters", async () => {
    const { service, fake } = setup({ mode: "full_control" });
    fake.handlers.set("tabs.close", () => {
      throw new CrotError("NOT_FOUND", `line1\nline2\u0007${"x".repeat(5000)}`);
    });
    const error = (await service.closeTab(ctx, { tabId: 1 }).catch((e: unknown) => e)) as CrotError;
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message.length).toBeLessThanOrEqual(500);
    expect(error.message).not.toMatch(/[\u0000-\u001f]/);
  });

  it("times out, aborts the request and records TIMEOUT", async () => {
    const { service, fake, audit } = setup({ mode: "full_control", timeoutMs: 50 });
    let aborted = false;
    fake.handlers.set(
      "tabs.list",
      (_p, options) =>
        new Promise(() => {
          options.signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    await expect(service.listTabs(ctx)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(aborted).toBe(true);
    expect(audit.events.at(-1)).toMatchObject({ operation: "browser.tabs_list", outcome: "error", error: { code: "TIMEOUT" } });
  });
});

describe("BrowserService page reading", () => {
  it("caps maxBytes at limits.maxReadBytes and truncates on UTF-8 boundaries", async () => {
    const { service, fake } = setup({ mode: "full_control", maxReadBytes: 5 });
    fake.handlers.set("page.read", (p) => ({ tabId: 1, url: PAGE_URL, title: "t", format: p.format, content: "aéééé", truncated: false }));
    await expect(service.readPage(ctx, { maxBytes: 1000 })).resolves.toMatchObject({ content: "aéé", truncated: true });
    expect(fake.calls[0]?.params).toMatchObject({ maxBytes: 5 });
    await expect(service.readPage(ctx, { maxBytes: 2 })).resolves.toMatchObject({ content: "a", truncated: true });
  });

  it("keeps the browser's truncated flag", async () => {
    const { service, fake } = setup({ mode: "full_control" });
    fake.handlers.set("page.read", (p) => ({ tabId: 1, url: PAGE_URL, title: "t", format: p.format, content: "abc", truncated: true }));
    await expect(service.readPage(ctx, {})).resolves.toMatchObject({ content: "abc", truncated: true });
  });
});

describe("BrowserService shutdown", () => {
  it("cancels requests in flight and refuses new ones", async () => {
    const { service, fake } = setup({ mode: "full_control" });
    let aborted = false;
    fake.handlers.set(
      "tabs.list",
      (_p, options) =>
        new Promise(() => {
          options.signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const pending = service.listTabs(ctx);
    await new Promise((r) => setTimeout(r, 10));
    service.shutdown();
    await expect(pending).rejects.toMatchObject({ code: "OPERATION_FAILED", message: expect.stringContaining("shutting down") });
    expect(aborted).toBe(true);
    await expect(service.click(ctx, { selector: "#a" })).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    await expect(service.status(ctx)).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    expect(fake.calls).toHaveLength(1);
  });
});

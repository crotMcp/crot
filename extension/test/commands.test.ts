import { describe, expect, it } from "vitest";
import {
  BROWSER_MAX_TABS,
  BROWSER_SCREENSHOT_MAX_BYTES,
  BROWSER_SELECTOR_MAX_LENGTH,
  BROWSER_TITLE_MAX_LENGTH,
  BROWSER_TYPE_TEXT_MAX_LENGTH,
  BROWSER_URL_MAX_LENGTH,
  BrowserPageReadResultSchema,
  BrowserScreenshotResultSchema,
  BrowserTabActionResultSchema,
  BrowserTabCloseResultSchema,
  BrowserTabsListResultSchema,
} from "../../src/core/capabilities/browser/schemas.js";
import { BROWSER_COMMANDS } from "../../src/core/capabilities/browser/connection.js";
import {
  MAX_TABS,
  SCREENSHOT_MAX_BYTES,
  SELECTOR_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  TYPE_TEXT_MAX_LENGTH,
  URL_MAX_LENGTH,
  createCommandHandlers,
  isHttpUrl,
} from "../src/commands.js";
import { ExtensionError } from "../src/errors.js";
import { clickElement, readPageContent, typeIntoElement } from "../src/page-functions.js";
import { FakeChrome, flush } from "./fake-chrome.js";

function setup(options: { loadWaitMs?: number } = {}) {
  const fake = new FakeChrome();
  fake.addTab({ id: 1, windowId: 1, active: true, url: "https://example.com/a", title: "A" });
  fake.addTab({ id: 2, windowId: 1, active: false, url: "https://example.org/b", title: "B" });
  fake.addTab({ id: 3, windowId: 2, active: true, url: "chrome://settings/", title: "Settings" });
  const handlers = createCommandHandlers(fake.api, { loadWaitMs: options.loadWaitMs ?? 1000 });
  return { fake, handlers };
}

async function failure(promise: Promise<unknown>): Promise<ExtensionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExtensionError) return error;
    throw error;
  }
  throw new Error("expected the command to fail");
}

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success).toBe(true);

describe("extension commands", () => {
  it("implements exactly the protocol's commands", () => {
    const { handlers } = setup();
    expect(Object.keys(handlers).sort()).toEqual([...BROWSER_COMMANDS].sort());
  });

  it("uses Core's limits", () => {
    expect(URL_MAX_LENGTH).toBe(BROWSER_URL_MAX_LENGTH);
    expect(TITLE_MAX_LENGTH).toBe(BROWSER_TITLE_MAX_LENGTH);
    expect(MAX_TABS).toBe(BROWSER_MAX_TABS);
    expect(SELECTOR_MAX_LENGTH).toBe(BROWSER_SELECTOR_MAX_LENGTH);
    expect(TYPE_TEXT_MAX_LENGTH).toBe(BROWSER_TYPE_TEXT_MAX_LENGTH);
    expect(SCREENSHOT_MAX_BYTES).toBe(BROWSER_SCREENSHOT_MAX_BYTES);
  });

  it("accepts only http and https URLs", () => {
    expect(isHttpUrl("https://example.com/")).toBe(true);
    expect(isHttpUrl("http://localhost:8080/x")).toBe(true);
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "chrome://settings",
      "about:blank",
      "/relative",
      "",
      42,
    ]) {
      expect(isHttpUrl(url)).toBe(false);
    }
    expect(isHttpUrl("https://e.com/" + "a".repeat(URL_MAX_LENGTH))).toBe(false);
  });

  it("lists tabs in Core's result shape", async () => {
    const { fake, handlers } = setup();
    fake.addTab({
      id: 4,
      windowId: 1,
      url: undefined,
      pendingUrl: "https://pending.example/",
      title: undefined,
      status: "weird",
    });
    const result = (await handlers["tabs.list"]({})) as { tabs: Record<string, unknown>[] };
    ok(BrowserTabsListResultSchema, result);
    expect(result.tabs.length).toBe(4);
    expect(result.tabs[0]).toEqual({
      tabId: 1,
      windowId: 1,
      url: "https://example.com/a",
      title: "A",
      active: true,
      discarded: false,
      groupedByCrot: false,
      status: "complete",
    });
    expect(result.tabs[3]).toEqual({
      tabId: 4,
      windowId: 1,
      url: "https://pending.example/",
      title: "",
      active: false,
      discarded: false,
      groupedByCrot: false,
    });
  });

  it("bounds tab lists, titles and URLs", async () => {
    const fake = new FakeChrome();
    for (let id = 0; id < MAX_TABS + 5; id++)
      fake.addTab({ id, title: "t".repeat(TITLE_MAX_LENGTH + 10), url: "https://e.com/" + "u".repeat(URL_MAX_LENGTH) });
    fake.addTab({ id: -1 });
    const result = (await createCommandHandlers(fake.api)["tabs.list"]({})) as { tabs: unknown[] };
    expect(result.tabs.length).toBe(MAX_TABS);
    ok(BrowserTabsListResultSchema, result);
  });

  it("rejects unexpected or invalid parameters", async () => {
    const { handlers } = setup();
    expect((await failure(handlers["tabs.list"]({ extra: 1 }))).code).toBe("INVALID_INPUT");
    expect((await failure(handlers["tabs.open"]({ url: "javascript:alert(1)", active: true }))).code).toBe(
      "INVALID_INPUT",
    );
    expect((await failure(handlers["tabs.open"]({ url: "https://e.com/" }))).code).toBe("INVALID_INPUT");
    expect((await failure(handlers["tabs.navigate"]({ url: "file:///etc/passwd" }))).code).toBe("INVALID_INPUT");
    expect((await failure(handlers["tabs.activate"]({ tabId: -1 }))).code).toBe("INVALID_INPUT");
    expect((await failure(handlers["tabs.close"]({ tabId: 1.5 }))).code).toBe("INVALID_INPUT");
    expect((await failure(handlers["page.read"]({ format: "pdf", maxBytes: 10 }))).code).toBe("INVALID_INPUT");
    expect((await failure(handlers["page.read"]({ format: "text", maxBytes: 0 }))).code).toBe("INVALID_INPUT");
    expect((await failure(handlers["page.screenshot"]({ format: "png", quality: 50 }))).code).toBe("INVALID_INPUT");
    expect((await failure(handlers["page.screenshot"]({ format: "jpeg", quality: 101 }))).code).toBe("INVALID_INPUT");
    expect((await failure(handlers["page.click"]({ selector: "" }))).code).toBe("INVALID_INPUT");
    expect((await failure(handlers["page.click"]({ selector: "a\0b" }))).code).toBe("INVALID_INPUT");
    expect((await failure(handlers["page.click"]({ selector: "a", code: "alert(1)" }))).code).toBe("INVALID_INPUT");
    expect(
      (
        await failure(
          handlers["page.type"]({ selector: "a", text: "x".repeat(TYPE_TEXT_MAX_LENGTH + 1), clear: false }),
        )
      ).code,
    ).toBe("INVALID_INPUT");
    expect((await failure(handlers["page.type"]({ selector: "a", text: "x", clear: "yes" }))).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("opens a tab and reports it after loading", async () => {
    const { fake, handlers } = setup();
    fake.loadStatus = "loading";
    const pending = handlers["tabs.open"]({ url: "https://new.example/", active: false });
    await flush();
    const [created] = [...fake.tabsById.values()].filter((t) => t.id === 100);
    expect(created?.active).toBe(false);
    fake.complete(100, "https://new.example/landing");
    const result = await pending;
    expect(result).toEqual({ tabId: 100, url: "https://new.example/landing" });
    ok(BrowserTabActionResultSchema, result);
    expect(fake.tabsOnUpdated.listeners.size).toBe(0);
    expect(fake.tabsOnRemoved.listeners.size).toBe(1); // persistent queue lifecycle listener
  });

  it("default tab_open reports loadTimedOut when the http document has not committed", async () => {
    const { fake, handlers } = setup({ loadWaitMs: 20 });
    fake.loadStatus = "loading";
    const opened = await handlers["tabs.open"]({ url: "https://slow.example/", active: true });
    expect(opened).toEqual({ tabId: 100, url: "https://slow.example/", loadTimedOut: true });
    expect((await failure(handlers["page.snapshot"]({ tabId: 100 }))).code).toBe("BROWSER_PAGE_RESTRICTED");
    expect(fake.tabsOnUpdated.listeners.size).toBe(0);
    expect(fake.tabsOnRemoved.listeners.size).toBe(1); // persistent queue lifecycle listener
  });

  it("answers anyway when the page does not finish loading in time", async () => {
    const { fake, handlers } = setup({ loadWaitMs: 20 });
    fake.loadStatus = "loading";
    const result = await handlers["tabs.navigate"]({ tabId: 2, url: "https://slow.example/" });
    expect(result).toEqual({ tabId: 2, url: "https://slow.example/", loadTimedOut: true });
    expect(fake.tabsOnUpdated.listeners.size).toBe(0);
  });

  it("navigates the active tab of the last focused window by default", async () => {
    const { fake, handlers } = setup();
    const result = await handlers["tabs.navigate"]({ url: "https://next.example/" });
    expect(result).toEqual({ tabId: 1, url: "https://next.example/" });
    expect(fake.tabsById.get(1)?.url).toBe("https://next.example/");
  });

  it("reports a tab closed while loading as NOT_FOUND", async () => {
    const { fake, handlers } = setup();
    fake.loadStatus = "loading";
    const pending = handlers["tabs.navigate"]({ tabId: 2, url: "https://gone.example/" });
    await flush();
    await fake.api.tabs.remove(2);
    expect((await failure(pending)).code).toBe("NOT_FOUND");
  });

  it("activates and closes tabs", async () => {
    const { fake, handlers } = setup();
    const activated = await handlers["tabs.activate"]({ tabId: 2 });
    expect(activated).toEqual({ tabId: 2, url: "https://example.org/b" });
    expect(fake.tabsById.get(2)?.active).toBe(true);
    expect(fake.tabsById.get(1)?.active).toBe(false);
    expect(fake.focused).toEqual([1]);
    const closed = await handlers["tabs.close"]({ tabId: 2 });
    expect(closed).toEqual({ tabId: 2, closed: true });
    ok(BrowserTabCloseResultSchema, closed);
    expect(fake.tabsById.has(2)).toBe(false);
  });

  it("reports unknown tabs as NOT_FOUND", async () => {
    const { handlers } = setup();
    expect((await failure(handlers["tabs.activate"]({ tabId: 99 }))).code).toBe("NOT_FOUND");
    expect((await failure(handlers["tabs.close"]({ tabId: 99 }))).code).toBe("NOT_FOUND");
    expect((await failure(handlers["page.read"]({ tabId: 99, format: "text", maxBytes: 10 }))).code).toBe("NOT_FOUND");
    const empty = new FakeChrome();
    expect((await failure(createCommandHandlers(empty.api)["page.click"]({ selector: "a" }))).code).toBe("NOT_FOUND");
  });

  it("refuses non-http(s) pages before touching them", async () => {
    const { fake, handlers } = setup();
    expect((await failure(handlers["page.read"]({ tabId: 3, format: "text", maxBytes: 10 }))).code).toBe(
      "BROWSER_PAGE_RESTRICTED",
    );
    expect((await failure(handlers["page.screenshot"]({ tabId: 3, format: "png" }))).code).toBe(
      "BROWSER_PAGE_RESTRICTED",
    );
    expect((await failure(handlers["page.click"]({ tabId: 3, selector: "a" }))).code).toBe("BROWSER_PAGE_RESTRICTED");
    expect((await failure(handlers["page.type"]({ tabId: 3, selector: "a", text: "x", clear: false }))).code).toBe(
      "BROWSER_PAGE_RESTRICTED",
    );
    expect(fake.injections.length).toBe(0);
    expect(fake.captures.length).toBe(0);
  });

  it("maps browser refusals to BROWSER_PAGE_RESTRICTED", async () => {
    const { fake, handlers } = setup();
    fake.scriptError = new Error(
      "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
    );
    expect((await failure(handlers["page.click"]({ tabId: 1, selector: "a" }))).code).toBe("BROWSER_PAGE_RESTRICTED");
    fake.scriptError = new Error("The extensions gallery cannot be scripted.");
    expect((await failure(handlers["page.read"]({ tabId: 1, format: "text", maxBytes: 5 }))).code).toBe(
      "BROWSER_PAGE_RESTRICTED",
    );
    fake.scriptError = new Error("Something else");
    const other = await failure(handlers["page.read"]({ tabId: 1, format: "text", maxBytes: 5 }));
    expect(other.code).toBe("OPERATION_FAILED");
  });

  it("injects only the fixed page functions, in the isolated world", async () => {
    const { fake, handlers } = setup();
    fake.scriptResult = () => ({ ok: true, value: { content: "hello", truncated: false } });
    const read = await handlers["page.read"]({ format: "html", maxBytes: 100 });
    expect(read).toEqual({
      tabId: 1,
      url: "https://example.com/a",
      title: "A",
      format: "html",
      content: "hello",
      truncated: false,
    });
    ok(BrowserPageReadResultSchema, read);
    fake.scriptResult = () => ({ ok: true, value: null });
    expect(await handlers["page.click"]({ tabId: 2, selector: "#go" })).toEqual({
      tabId: 2,
      url: "https://example.org/b",
    });
    expect(await handlers["page.type"]({ selector: "input", text: "hi", clear: true })).toEqual({
      tabId: 1,
      url: "https://example.com/a",
    });
    const funcs = fake.injections.map((i) => i.func);
    expect(funcs.length).toBe(3);
    expect(funcs[0]).toBe(readPageContent);
    expect(funcs[1]).toBe(clickElement);
    expect(funcs[2]).toBe(typeIntoElement);
    expect(fake.injections.map((i) => i.world)).toEqual(["ISOLATED", "ISOLATED", "ISOLATED"]);
    expect(fake.injections.map((i) => i.args)).toEqual([["html", 100], ["#go"], ["input", "hi", true]]);
    expect(fake.injections.map((i) => i.target)).toEqual([{ tabId: 1 }, { tabId: 2 }, { tabId: 1 }]);
  });

  it("passes page errors through and treats malformed page results as failures", async () => {
    const { fake, handlers } = setup();
    fake.scriptResult = () => ({ ok: false, code: "NOT_FOUND", message: "No element matches the selector." });
    const notFound = await failure(handlers["page.click"]({ selector: "#missing" }));
    expect(notFound.code).toBe("NOT_FOUND");
    expect(notFound.message).toBe("No element matches the selector.");
    fake.scriptResult = () => ({ ok: false, code: "BROWSER_NOT_CONNECTED", message: "x" });
    expect((await failure(handlers["page.click"]({ selector: "a" }))).code).toBe("OPERATION_FAILED");
    fake.scriptResult = () => undefined;
    expect((await failure(handlers["page.click"]({ selector: "a" }))).code).toBe("OPERATION_FAILED");
    fake.scriptResult = () => ({ ok: true, value: { content: 5 } });
    expect((await failure(handlers["page.read"]({ format: "text", maxBytes: 5 }))).code).toBe("OPERATION_FAILED");
  });

  it("captures background tabs through CDP without activation, and reports viewport/dpr", async () => {
    const { fake, handlers } = setup();
    screenshotFake(fake);
    const image = await handlers["page.screenshot"]({ tabId: 2, format: "png" });
    ok(BrowserScreenshotResultSchema, image);
    expect(image).toMatchObject({
      tabId: 2,
      mimeType: "image/png",
      viewport: { width: 800, height: 600 },
      devicePixelRatio: 1,
    });
    expect(fake.tabsById.get(2)?.active).toBe(false);
    expect(fake.focused).toEqual([]);
    expect(fake.captures).toEqual([]);
  });

  it("captures fullPage, refuses discarded tabs without loading, bounds size and times out", async () => {
    const { fake } = setup();
    screenshotFake(fake);
    const handlers = createCommandHandlers(fake.api, { screenshotTimeoutMs: 25 });
    await handlers["page.screenshot"]({ tabId: 1, format: "jpeg", quality: 70, fullPage: true });
    expect(fake.debugger.sent.find((c) => c.method === "Page.captureScreenshot")?.params).toMatchObject({
      format: "jpeg",
      quality: 70,
      clip: { width: 800, height: 1200 },
    });
    fake.tabsById.get(1)!.discarded = true;
    expect((await failure(handlers["page.screenshot"]({ tabId: 1, format: "png" }))).code).toBe("INVALID_INPUT");
    fake.tabsById.get(1)!.discarded = false;
    const respond = fake.debugger.respond;
    fake.debugger.respond = (id, method, params) =>
      method === "Page.captureScreenshot"
        ? { data: "A".repeat(Math.ceil(SCREENSHOT_MAX_BYTES / 3) * 4 + 4) }
        : respond(id, method, params);
    expect((await failure(handlers["page.screenshot"]({ tabId: 1, format: "png" }))).code).toBe("LIMIT_EXCEEDED");
    fake.debugger.respond = (id, method, params) =>
      method === "Page.captureScreenshot" ? new Promise(() => undefined) : respond(id, method, params);
    expect((await failure(handlers["page.screenshot"]({ tabId: 1, format: "png" }))).code).toBe("TIMEOUT");
  });
});

function screenshotFake(fake: FakeChrome): void {
  // Image decoding is a browser platform primitive; real pixels are checked in Chromium E2E.
  globalThis.createImageBitmap = (async () => ({ width: 800, close() {} })) as unknown as typeof createImageBitmap;
  fake.debugger.respond = (_id, method) => {
    if (method === "Page.getLayoutMetrics")
      return {
        cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
        cssContentSize: { x: 0, y: 0, width: 800, height: 1200 },
      };
    if (method === "Page.captureScreenshot") return { data: "iVBORw0KGgo=" };
    return {};
  };
}

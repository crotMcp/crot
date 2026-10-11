import { describe, expect, it } from "vitest";
import { CdpSessions } from "../src/cdp.js";
import { createCommandHandlers, TAB_QUEUE_MAX } from "../src/commands.js";
import {
  TabObserver,
  settle,
  timeoutParam,
  waitConditionParam,
  waitUntilParam,
  WAIT_TIMEOUT_MAX_MS,
  type Timing,
} from "../src/control.js";
import { ExtensionError } from "../src/errors.js";
import { FakeChrome } from "./fake-chrome.js";

const FAST: Timing = { quietMs: 5, networkIdleMs: 5, pollMs: 2 };
const context = { connectionId: () => "c1" };

async function rejects(promise: Promise<unknown>): Promise<ExtensionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionError);
    return error as ExtensionError;
  }
  throw new Error("expected a rejection");
}

/** A fake page: main frame f0 / loader L1, a document with one button (backend 10) at (50,20). */
type Answer = (params: never) => unknown;

/** Per-method answers over the fake debugger's single respond function. */
function answers(fake: FakeChrome) {
  const table = new Map<string, Answer>();
  fake.debugger.respond = (_tabId, method, params) => {
    const answer = table.get(method);
    return answer ? answer((params ?? {}) as never) : {};
  };
  return { respond: (_tabId: number, method: string, answer: Answer) => void table.set(method, answer) };
}

function page(fake: FakeChrome, tabId: number) {
  const d = answers(fake);
  let loader = "L1";
  d.respond(tabId, "Page.enable", () => ({}));
  d.respond(tabId, "Page.setLifecycleEventsEnabled", () => ({}));
  d.respond(tabId, "Network.enable", () => ({}));
  d.respond(tabId, "DOM.enable", () => ({}));
  d.respond(tabId, "Page.getFrameTree", () => ({ frameTree: { frame: { id: "f0", loaderId: loader } } }));
  const doc = {
    nodeId: 1,
    backendNodeId: 1,
    frameId: "f0",
    nodeName: "#document",
    children: [
      {
        nodeId: 2,
        backendNodeId: 10,
        nodeName: "BUTTON",
        localName: "button",
        children: [{ nodeType: 3, backendNodeId: 11, nodeValue: "Send now" }],
      },
    ],
  };
  d.respond(tabId, "DOM.getDocument", () => ({ root: doc }));
  d.respond(tabId, "DOM.querySelector", (p: { selector: string }) => ({ nodeId: p.selector === "button" ? 2 : 0 }));
  d.respond(tabId, "DOM.describeNode", () => ({ node: { nodeId: 2, backendNodeId: 10, localName: "button" } }));
  d.respond(tabId, "DOM.scrollIntoViewIfNeeded", () => ({}));
  d.respond(tabId, "DOM.getContentQuads", () => ({ quads: [[40, 10, 60, 10, 60, 30, 40, 30]] }));
  d.respond(tabId, "Page.getLayoutMetrics", () => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }));
  d.respond(tabId, "Accessibility.getPartialAXTree", () => ({
    nodes: [{ nodeId: "a", role: { value: "button" }, properties: [] }],
  }));
  d.respond(tabId, "DOM.getNodeForLocation", () => ({ backendNodeId: 10 }));
  d.respond(tabId, "Input.dispatchMouseEvent", () => ({}));
  d.respond(tabId, "Page.getNavigationHistory", () => ({
    currentIndex: 1,
    entries: [
      { id: 1, url: "chrome://newtab/" },
      { id: 2, url: "https://example.com/" },
      { id: 3, url: "https://example.com/next" },
    ],
  }));
  d.respond(tabId, "Page.navigateToHistoryEntry", () => ({}));
  d.respond(tabId, "Page.reload", () => ({}));
  return { d, setLoader: (l: string) => (loader = l) };
}

function setup() {
  const fake = new FakeChrome();
  fake.addTab({ id: 1, active: true, url: "https://example.com/" });
  const cdp = new CdpSessions(fake.api);
  const handlers = createCommandHandlers(fake.api, { cdp, timing: FAST });
  const p = page(fake, 1);
  return { fake, cdp, handlers, p };
}

describe("settle and wait parameters", () => {
  it("validates waitUntil and timeoutMs", () => {
    expect(waitUntilParam(undefined)).toBe("load");
    expect(waitUntilParam("networkidle")).toBe("networkidle");
    expect(() => waitUntilParam("idle")).toThrow(/waitUntil/);
    expect(timeoutParam(undefined)).toBe(20_000);
    expect(() => timeoutParam(WAIT_TIMEOUT_MAX_MS + 1)).toThrow(/timeoutMs/);
    expect(() => timeoutParam(0)).toThrow(/timeoutMs/);
  });

  it("accepts exactly one wait condition", () => {
    expect(waitConditionParam({ selector: "#a", state: "hidden" }, 100)).toEqual({
      kind: "element",
      selector: "#a",
      state: "hidden",
    });
    expect(waitConditionParam({ textGone: "Loading" }, 100)).toEqual({ kind: "text", text: "Loading", present: false });
    expect(waitConditionParam({ newTab: true }, 100)).toEqual({ kind: "newTab" });
    expect(() => waitConditionParam({}, 100)).toThrow(/exactly one/);
    expect(() => waitConditionParam({ text: "a", urlPrefix: "https://" }, 100)).toThrow(/exactly one/);
    expect(() => waitConditionParam({ text: "a", state: "visible" }, 100)).toThrow(/state/);
    expect(() => waitConditionParam({ ref: "x1" }, 100)).toThrow(/ref/);
  });
});

describe("settle phase", () => {
  it("reports no navigation and no new tabs for a quiet action", async () => {
    const fake = new FakeChrome();
    fake.addTab({ id: 1, url: "https://example.com/a" });
    const observer = new TabObserver(fake.api, undefined, 1);
    const result = await settle(fake.api, observer, "load", 1000, FAST, 8192);
    expect(result).toEqual({ tabId: 1, url: "https://example.com/a", navigated: false, newTabs: [] });
    expect(fake.tabsOnUpdated.listeners.size).toBe(0);
    expect(fake.tabsOnCreated.listeners.size).toBe(0);
  });

  it("waits for a navigation the action started and reports popups by openerTabId", async () => {
    const fake = new FakeChrome();
    fake.addTab({ id: 1, url: "https://example.com/a" });
    const observer = new TabObserver(fake.api, undefined, 1);
    fake.startLoading(1, "https://example.com/b");
    const popup = fake.openPopup(1, "https://other.example/");
    fake.openPopup(99, "https://unrelated.example/");
    const pending = settle(fake.api, observer, "load", 1000, FAST, 8192);
    setTimeout(() => fake.complete(1), 20);
    const result = await pending;
    expect(result).toEqual({ tabId: 1, url: "https://example.com/b", navigated: true, newTabs: [popup.id] });
  });

  it("answers after timeoutMs when the navigation does not finish, without retrying", async () => {
    const fake = new FakeChrome();
    fake.addTab({ id: 1, url: "https://example.com/a" });
    const observer = new TabObserver(fake.api, undefined, 1);
    fake.startLoading(1, "https://example.com/slow");
    const started = Date.now();
    const result = await settle(fake.api, observer, "load", 50, FAST, 8192);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.navigated).toBe(true);
    expect(result.url).toBe("https://example.com/a");
  });

  it("uses CDP lifecycle events of the main frame for domcontentloaded", async () => {
    const fake = new FakeChrome();
    fake.addTab({ id: 1, url: "https://example.com/a" });
    const cdp = new CdpSessions(fake.api);
    await cdp.send(1, "Page.enable");
    const observer = new TabObserver(fake.api, cdp, 1, "f0");
    fake.startLoading(1, "https://example.com/b");
    const pending = settle(fake.api, observer, "domcontentloaded", 1000, FAST, 8192);
    setTimeout(() => {
      fake.debugger.event(1, "Page.lifecycleEvent", { frameId: "child", name: "DOMContentLoaded" });
      fake.debugger.event(1, "Page.lifecycleEvent", { frameId: "f0", name: "DOMContentLoaded" });
    }, 15);
    const result = await pending;
    expect(result.navigated).toBe(true);
  });
});

describe("Browser v1 commands", () => {
  it("clicks by selector with trusted CDP input and returns a control result without page text", async () => {
    const { fake, handlers } = setup();
    const result = (await handlers["page.click"]({ tabId: 1, selector: "button", clickCount: 1 }, context)) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ tabId: 1, url: "https://example.com/", navigated: false, newTabs: [] });
    const mouse = fake.debugger.sent
      .filter((s) => s.method === "Input.dispatchMouseEvent")
      .map((s) => (s.params as { type: string }).type);
    expect(mouse).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(fake.injections).toHaveLength(0);
  });

  it("keeps the legacy selector form on the page function", async () => {
    const { fake, handlers } = setup();
    fake.scriptResult = () => ({ ok: true, value: null });
    await handlers["page.click"]({ tabId: 1, selector: "button" }, context);
    expect(fake.injections).toHaveLength(1);
    expect(fake.debugger.sent.filter((s) => s.method === "Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("refuses both or neither of ref and selector, and unknown refs as stale", async () => {
    const { handlers } = setup();
    expect((await rejects(handlers["page.hover"]({ tabId: 1 }, context))).code).toBe("INVALID_INPUT");
    expect((await rejects(handlers["page.hover"]({ tabId: 1, ref: "e1", selector: "b" }, context))).code).toBe(
      "INVALID_INPUT",
    );
    expect((await rejects(handlers["page.hover"]({ tabId: 1, ref: "e7" }, context))).code).toBe("BROWSER_STALE_REF");
    expect((await rejects(handlers["page.hover"]({ tabId: 1, selector: "#none" }, context))).code).toBe("NOT_FOUND");
  });

  it("refuses a changed subject before acting", async () => {
    const { fake, handlers } = setup();
    const error = await rejects(
      handlers["page.click"](
        {
          tabId: 1,
          selector: "button",
          clickCount: 1,
          expect: { tabId: 1, origin: "https://other.example", connectionId: "c1" },
        },
        context,
      ),
    );
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(fake.debugger.sent.filter((s) => s.method === "Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("goes back only to http(s) history entries and reports the navigation", async () => {
    const { fake, handlers, p } = setup();
    const forward = (await handlers["tabs.history"](
      { tabId: 1, action: "forward", timeoutMs: 100 },
      context,
    )) as Record<string, unknown>;
    expect(forward.navigated).toBe(true);
    expect(fake.debugger.sent.find((s) => s.method === "Page.navigateToHistoryEntry")?.params).toEqual({ entryId: 3 });
    p.d.respond(1, "Page.getNavigationHistory", () => ({
      currentIndex: 1,
      entries: [
        { id: 1, url: "chrome://newtab/" },
        { id: 2, url: "https://example.com/" },
      ],
    }));
    expect((await rejects(handlers["tabs.history"]({ tabId: 1, action: "back" }, context))).code).toBe(
      "BROWSER_PAGE_RESTRICTED",
    );
    expect((await rejects(handlers["tabs.history"]({ tabId: 1, action: "forward" }, context))).code).toBe(
      "INVALID_INPUT",
    );
    await handlers["tabs.history"]({ tabId: 1, action: "reload", timeoutMs: 100 }, context);
    expect(fake.debugger.sent.some((s) => s.method === "Page.reload")).toBe(true);
  });

  it("waits for text without returning it, and times out with TIMEOUT", async () => {
    const { handlers } = setup();
    const ok = await handlers["page.wait"]({ tabId: 1, text: "Send  now", timeoutMs: 200 }, context);
    expect(ok).toEqual({ satisfied: true, url: "https://example.com/" });
    const error = await rejects(handlers["page.wait"]({ tabId: 1, text: "Missing", timeoutMs: 30 }, context));
    expect(error.code).toBe("TIMEOUT");
  });

  it("waits for element states and a new tab from this tab", async () => {
    const { fake, handlers } = setup();
    expect(
      await handlers["page.wait"]({ tabId: 1, selector: "button", state: "visible", timeoutMs: 100 }, context),
    ).toMatchObject({ satisfied: true });
    expect(
      await handlers["page.wait"]({ tabId: 1, selector: "#gone", state: "detached", timeoutMs: 100 }, context),
    ).toMatchObject({ satisfied: true });
    const pending = handlers["page.wait"]({ tabId: 1, newTab: true, timeoutMs: 500 }, context);
    setTimeout(() => fake.openPopup(1, "https://example.com/popup"), 10);
    const result = (await pending) as { newTabs: number[] };
    expect(result.newTabs).toHaveLength(1);
  });

  it("bounds the per-tab queue with RESOURCE_BUSY", async () => {
    const { handlers, p } = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    p.d.respond(1, "DOM.querySelector", async () => {
      await gate;
      return { nodeId: 2 };
    });
    const running = Array.from({ length: TAB_QUEUE_MAX }, () =>
      handlers["page.hover"]({ tabId: 1, selector: "button" }, context).catch((e: unknown) => e),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect((await rejects(handlers["page.hover"]({ tabId: 1, selector: "button" }, context))).code).toBe(
      "RESOURCE_BUSY",
    );
    release();
    const results = await Promise.all(running);
    expect(results.every((r) => !(r instanceof Error))).toBe(true);
  });

  it("refs of an earlier host connection are unknown", async () => {
    const { handlers } = setup();
    const err = await rejects(handlers["page.hover"]({ tabId: 1, ref: "e1" }, { connectionId: () => "c2" }));
    expect(err.code).toBe("BROWSER_STALE_REF");
  });
});

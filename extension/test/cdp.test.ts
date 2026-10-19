import { describe, expect, it } from "vitest";
import { CDP_ALLOWED_METHODS, CDP_UNAVAILABLE_MESSAGE, CdpSessions } from "../src/cdp.js";
import { ExtensionError } from "../src/errors.js";
import { FakeChrome, flush } from "./fake-chrome.js";

interface Timer {
  callback: () => void;
  ms: number;
  cleared: boolean;
}

function setup() {
  const chrome = new FakeChrome();
  chrome.addTab({ id: 1 });
  chrome.addTab({ id: 2 });
  const timers: Timer[] = [];
  const cdp = new CdpSessions(chrome.api, {
    idleDetachMs: 1000,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as Timer).cleared = true;
    },
  });
  return { chrome, cdp, timers };
}

async function failure(promise: Promise<unknown>): Promise<ExtensionError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ExtensionError);
  return error as ExtensionError;
}

/** Methods AD-16 point 3 forbids in every case. */
const FORBIDDEN = [
  "Runtime.evaluate",
  "Runtime.compileScript",
  "Runtime.callFunctionOn",
  "Runtime.enable",
  "Page.addScriptToEvaluateOnNewDocument",
  "Debugger.enable",
  "Fetch.getResponseBody",
  "Storage.getCookies",
  "Browser.grantPermissions",
  "SystemInfo.getInfo",
  "Emulation.setGeolocationOverride",
  "Network.getCookies",
  "Network.getResponseBody",
  "Network.setRequestInterception",
  "Target.createTarget",
  "Target.createBrowserContext",
  "Target.attachToTarget",
  "Page.navigate",
];

describe("CDP allowlist (AD-16 point 3)", () => {
  it("contains only methods of the allowed domains", () => {
    const domains = new Set([
      "Accessibility",
      "DOM",
      "DOMSnapshot",
      "Emulation",
      "Input",
      "Page",
      "Target",
      "Network",
      "Fetch",
    ]);
    for (const method of CDP_ALLOWED_METHODS) expect(domains.has(method.split(".")[0] as string)).toBe(true);
    expect([...CDP_ALLOWED_METHODS].filter((m) => m.startsWith("Network."))).toEqual(["Network.enable"]);
    expect([...CDP_ALLOWED_METHODS].filter((m) => m.startsWith("Target."))).toEqual(["Target.setAutoAttach"]);
    expect([...CDP_ALLOWED_METHODS].filter((m) => m.startsWith("Fetch."))).toEqual([
      "Fetch.enable",
      "Fetch.continueResponse",
      "Fetch.continueRequest",
      "Fetch.disable",
    ]);
    // Focus emulation only: no device, network, script or timezone emulation.
    expect([...CDP_ALLOWED_METHODS].filter((m) => m.startsWith("Emulation."))).toEqual([
      "Emulation.setFocusEmulationEnabled",
    ]);
  });

  it("never contains a forbidden method", () => {
    for (const method of FORBIDDEN) expect(CDP_ALLOWED_METHODS.has(method)).toBe(false);
    expect([...CDP_ALLOWED_METHODS].some((m) => m.startsWith("Runtime."))).toBe(false);
  });

  it("refuses a forbidden method before anything reaches the browser", async () => {
    const { chrome, cdp } = setup();
    for (const method of FORBIDDEN) {
      const error = await failure(cdp.send(1, method, { expression: "1" }));
      expect(error.code).toBe("OPERATION_FAILED");
      expect(error.message).toContain("not allowed");
    }
    expect(chrome.debugger.attachCalls).toEqual([]);
    expect(chrome.debugger.sent).toEqual([]);
  });
});

describe("CDP attach lifecycle", () => {
  it("attaches on the first command only, with protocol 1.3, and reuses the session", async () => {
    const { chrome, cdp } = setup();
    expect(chrome.debugger.attachCalls).toEqual([]);
    await cdp.send(1, "DOM.getDocument");
    await cdp.send(1, "Page.getFrameTree");
    expect(chrome.debugger.attachCalls).toEqual([1]);
    expect(chrome.debugger.sent.map((s) => s.method)).toEqual([
      "Page.enable",
      "Page.setInterceptFileChooserDialog",
      "DOM.getDocument",
      "Page.getFrameTree",
    ]);
    expect(cdp.isAttached(1)).toBe(true);
    expect(cdp.isAttached(2)).toBe(false);
  });

  it("attaches once for concurrent first commands", async () => {
    const { chrome, cdp } = setup();
    await Promise.all([cdp.send(1, "DOM.getDocument"), cdp.send(1, "Page.getFrameTree")]);
    expect(chrome.debugger.attachCalls).toEqual([1]);
  });

  it("reports an unavailable debugger with a fixed message and no fallback", async () => {
    const { chrome, cdp } = setup();
    chrome.debugger.attachError = new Error("Cannot access a chrome:// URL");
    const error = await failure(cdp.send(1, "DOM.getDocument"));
    expect(error.code).toBe("OPERATION_FAILED");
    expect(error.message).toBe(CDP_UNAVAILABLE_MESSAGE);
    expect(chrome.debugger.sent).toEqual([]);
    chrome.debugger.attachError = undefined;
    await cdp.send(1, "DOM.getDocument");
    expect(chrome.debugger.attachCalls).toEqual([1, 1]);
  });

  it("fails in-flight commands and advances the generation when the user detaches; the next command re-attaches", async () => {
    const { chrome, cdp } = setup();
    await cdp.send(1, "DOM.getDocument");
    const before = cdp.generation(1);
    chrome.debugger.respond = (tabId) => {
      chrome.debugger.userDetach(tabId);
      throw new Error("Debugger is not attached");
    };
    const error = await failure(cdp.send(1, "DOM.getDocument"));
    expect(error.code).toBe("OPERATION_FAILED");
    expect(error.message).toContain("detached");
    expect(cdp.generation(1)).toBe(before + 1);
    expect(cdp.isAttached(1)).toBe(false);
    chrome.debugger.respond = () => ({});
    await cdp.send(1, "DOM.getDocument");
    expect(chrome.debugger.attachCalls).toEqual([1, 1]);
  });

  it("forgets a closed tab", async () => {
    const { chrome, cdp } = setup();
    await cdp.send(1, "DOM.getDocument");
    await chrome.api.tabs.remove(1);
    expect(cdp.isAttached(1)).toBe(false);
    expect(cdp.generation(1)).toBe(1);
  });

  it("detaches after the idle period and on detachAll", async () => {
    const { chrome, cdp, timers } = setup();
    await cdp.send(1, "DOM.getDocument");
    await cdp.send(2, "DOM.getDocument");
    const live = timers.filter((t) => !t.cleared);
    expect(live.every((t) => t.ms === 1000)).toBe(true);
    live.find((t) => t === live[0])?.callback();
    await flush();
    expect(chrome.debugger.attached.has(1)).toBe(false);
    await cdp.detachAll();
    expect(chrome.debugger.attached.size).toBe(0);
  });

  it("delivers events only of attached tabs", async () => {
    const { chrome, cdp } = setup();
    const events: string[] = [];
    cdp.onEvent((tabId, method) => events.push(tabId + ":" + method));
    chrome.debugger.event(1, "Page.frameNavigated");
    await cdp.send(1, "Page.enable");
    chrome.debugger.event(1, "Page.frameNavigated");
    expect(events).toEqual(["1:Page.frameNavigated"]);
  });
});

describe("JavaScript dialogs", () => {
  it("fails a command at once when it opens a dialog, and every command while one is open; answering clears it", async () => {
    const { chrome, cdp } = setup();
    await cdp.send(1, "Page.enable");
    // The click's mouseReleased does not return while the alert blocks the page.
    chrome.debugger.respond = (_tab, method) => {
      if (method === "Input.dispatchMouseEvent") {
        setTimeout(() => chrome.debugger.event(1, "Page.javascriptDialogOpening", { type: "alert" }), 0);
        return new Promise(() => undefined);
      }
      return {};
    };
    const opened = await failure(cdp.send(1, "Input.dispatchMouseEvent", { type: "mouseReleased" }));
    expect(opened.code).toBe("BROWSER_DIALOG_OPEN");
    const blocked = await failure(cdp.send(1, "DOM.getDocument"));
    expect(blocked.code).toBe("BROWSER_DIALOG_OPEN");
    expect(() => cdp.assertNoDialog(1)).toThrow(ExtensionError);
    // Page.enable still answers; another tab is not affected.
    await cdp.send(1, "Page.enable");
    await cdp.send(2, "DOM.getDocument");
    chrome.debugger.event(1, "Page.javascriptDialogClosed", { result: true });
    await cdp.send(1, "DOM.getDocument");
    cdp.assertNoDialog(1);
  });
});

describe("WP-26 upload lease lifecycle", () => {
  it("releases a child frame's copies only on that frame's document replacement", async () => {
    const chrome = new FakeChrome(),
      notices: unknown[] = [];
    chrome.addTab({ id: 1 });
    const cdp = new CdpSessions(chrome.api, {
      onNotice: (n) => {
        if (n.event === "upload_released") notices.push(n);
      },
    });
    await cdp.send(1, "Page.enable");
    cdp.retainUpload(1, "a1".repeat(24), "main");
    cdp.retainUpload(1, "b2".repeat(24), "child");
    chrome.debugger.event(1, "Page.frameNavigated", { frame: { id: "child", parentId: "main" } });
    expect(notices).toEqual([{ type: "browser_notice", event: "upload_released", token: "b2".repeat(24) }]);
    chrome.debugger.event(1, "Page.frameNavigated", { frame: { id: "main" } });
    expect(notices).toHaveLength(2);
    await cdp.detachAll();
  });
  it("does not discard lazy-read copies on manual debugger detach", async () => {
    const chrome = new FakeChrome(),
      notices: unknown[] = [];
    chrome.addTab({ id: 1 });
    const cdp = new CdpSessions(chrome.api, {
      onNotice: (n) => {
        if (n.event === "upload_released") notices.push(n);
      },
    });
    await cdp.send(1, "Page.enable");
    cdp.retainUpload(1, "a1".repeat(24), "main");
    chrome.debugger.userDetach(1);
    expect(notices).toEqual([]);
    await chrome.api.tabs.remove(1);
    expect(notices).toEqual([{ type: "browser_notice", event: "upload_released", token: "a1".repeat(24) }]);
  });
});

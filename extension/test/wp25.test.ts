import { describe, expect, it } from "vitest";
import { CdpSessions, CDP_UNAVAILABLE_MESSAGE } from "../src/cdp.js";
import { createCommandHandlers } from "../src/commands.js";
import { FakeChrome, flush } from "./fake-chrome.js";

function setup() {
  const chrome = new FakeChrome();
  chrome.addTab({ id: 1, active: true });
  const notices: unknown[] = [];
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const cdp = new CdpSessions(chrome.api, {
    onNotice: (n) => notices.push(n),
    setTimer: (callback, ms) => {
      const t = { callback, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  const handlers = createCommandHandlers(chrome.api, { cdp });
  return { chrome, cdp, notices, timers, handlers };
}

describe("WP-25 lifecycle", () => {
  it.each(["alert", "confirm", "prompt", "beforeunload"])(
    "tracks bounded %s, hides content in controls, permits exposure reads and answers",
    async (type) => {
      const { chrome, cdp, handlers } = setup();
      await cdp.attach(1);
      chrome.debugger.event(1, "Page.javascriptDialogOpening", {
        type,
        message: "secret".repeat(3000),
        defaultPrompt: "initial",
      });
      expect(cdp.dialog(1)?.message).toHaveLength(10000);
      const snapshot = (await handlers["page.snapshot"]({ tabId: 1 })) as {
        dialog: { message: string };
        elements: unknown[];
      };
      expect(snapshot.dialog.message).toHaveLength(10000);
      expect(snapshot.elements).toEqual([]);
      for (const command of [
        "page.read",
        "page.click",
        "page.screenshot",
        "page.wait",
        "tabs.navigate",
        "tabs.activate",
        "tabs.history",
      ] as const)
        await expect(handlers[command]({ tabId: 1 })).rejects.toMatchObject({ code: "BROWSER_DIALOG_OPEN" });
      const listed = (await handlers["tabs.list"]({})) as { tabs: { dialog: { type: string } }[] };
      expect(listed.tabs[0]?.dialog.type).toBe(type);
      if (type !== "prompt")
        await expect(
          handlers["dialog.handle"]({ tabId: 1, accept: true, promptText: "not permitted" }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      const result = await handlers["dialog.handle"]({
        tabId: 1,
        accept: false,
        ...(type === "prompt" ? { promptText: "answer" } : {}),
      });
      expect(JSON.stringify(result)).not.toMatch(/secret|initial|answer/);
      expect(cdp.dialog(1)).toBeUndefined();
      expect(chrome.debugger.sent.at(-1)).toMatchObject({
        method: "Page.handleJavaScriptDialog",
        params: { accept: false },
      });
    },
  );
  it("production 60s timer dismisses exactly once and emits only content-free telemetry", async () => {
    const { chrome, cdp, notices, timers } = setup();
    await cdp.attach(1);
    notices.length = 0;
    chrome.debugger.event(1, "Page.javascriptDialogOpening", { type: "confirm", message: "private page text" });
    const timer = timers.find((t) => t.ms === 60000)!;
    expect(timer).toBeDefined();
    timer.callback();
    await flush();
    expect(cdp.dialog(1)).toBeUndefined();
    expect(notices).toEqual([
      { type: "browser_notice", event: "dialog_auto_dismissed", tabId: 1, dialogType: "confirm" },
    ]);
    timer.callback();
    await flush();
    expect(notices).toHaveLength(1);
  });
  it("clears timers on manual response, tab close and detach; file chooser cannot be accepted before WP-26", async () => {
    const { chrome, cdp, handlers, timers } = setup();
    await cdp.attach(1);
    chrome.debugger.event(1, "Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 123 });
    expect(cdp.dialog(1)).toEqual({ type: "file_chooser", message: "" });
    await expect(handlers["dialog.handle"]({ tabId: 1, accept: true })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await handlers["dialog.handle"]({ tabId: 1, accept: false });
    expect(timers.filter((t) => t.ms === 60000).every((t) => t.cleared)).toBe(true);
    chrome.debugger.event(1, "Page.javascriptDialogOpening", { type: "alert" });
    await handlers["tabs.close"]({ tabId: 1 });
    expect(cdp.dialog(1)).toBeUndefined();
    expect(timers.filter((t) => t.ms === 60000).every((t) => t.cleared)).toBe(true);
  });
  it("cancels a truly unanswered CDP promise immediately on external detach, then reattaches", async () => {
    const { chrome, cdp } = setup();
    await cdp.attach(1);
    chrome.debugger.respond = () => new Promise(() => undefined);
    const pending = cdp.send(1, "DOM.getDocument");
    await flush();
    chrome.debugger.userDetach(1);
    await expect(pending).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    chrome.debugger.respond = () => ({});
    await cdp.send(1, "DOM.getDocument");
    expect(chrome.debugger.attachCalls).toEqual([1, 1]);
  });
  it("reports policy attach refusal without synthetic fallback", async () => {
    const { chrome, cdp, notices } = setup();
    chrome.debugger.attachError = new Error("policy");
    await expect(cdp.send(1, "DOM.getDocument")).rejects.toMatchObject({
      code: "OPERATION_FAILED",
      message: CDP_UNAVAILABLE_MESSAGE,
    });
    expect(notices).toContainEqual({ type: "browser_notice", event: "cdp_status", available: false });
    expect(chrome.injections).toEqual([]);
  });
  it("serializes CROT group creation per window and groups descendants without activating them", async () => {
    const { chrome, handlers } = setup();
    const [a, b] = (await Promise.all([
      handlers["tabs.open"]({ url: "https://a.test/", active: false }),
      handlers["tabs.open"]({ url: "https://b.test/", active: false }),
    ])) as { tabId: number }[];
    expect(chrome.groups.size).toBe(1);
    expect(chrome.tabsById.get(a!.tabId)?.groupId).toBe(chrome.tabsById.get(b!.tabId)?.groupId);
    const popup = chrome.openPopup(a!.tabId, "https://a.test/popup");
    await flush();
    expect(chrome.tabsById.get(popup.id!)?.groupId).toBe(chrome.tabsById.get(a!.tabId)?.groupId);
    expect(chrome.focused).toEqual([]);
    expect(chrome.tabsById.get(1)?.active).toBe(true);
  });
});

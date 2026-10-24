import { randomBytes } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as h from "./harness.js";

/**
 * REAL end-to-end test of browser contract v1 (ARCHITECTURE.md §27 AD-16,
 * docs/BROWSER_E2E.md): snapshot refs, trusted input, stale refs, a
 * cross-origin frame, an open shadow root, a pop-up and the fixed CDP surface,
 * through the same unmocked chain as real-browser.e2e.test.ts:
 *
 *   MCP client -> crot-mcp -> BrowserService -> ExecutionGuard/PermissionEngine
 *   -> BrowserBridge -> crot-browser-relay (native messaging) -> extension
 *   (chrome.debugger) -> real Chromium tab.
 */

interface Frame {
  frameRef: string;
  parentFrameRef: string | null;
  url: string;
  origin: string | null;
  restricted: boolean;
}
interface Element {
  ref: string;
  frameRef: string;
  role: string;
  name: string;
  value?: string;
  hasValue?: boolean;
  states: Record<string, boolean | "mixed">;
  bounds: { x: number; y: number; width: number; height: number } | null;
  inViewport: boolean;
}
interface Snapshot {
  tabId: number;
  url: string;
  title: string;
  frames: Frame[];
  elements: Element[];
  truncated: boolean;
}
interface ControlResult {
  tabId: number;
  url: string;
  navigated?: boolean;
  newTabs?: number[];
}

const linux = process.platform === "linux";

describe.skipIf(linux)("browser v1 layout E2E", () => {
  it.skip(`is implemented for Linux only (current platform: ${process.platform}); see docs/BROWSER_E2E.md`, () =>
    undefined);
});

describe.runIf(linux)("browser v1 E2E: layout and frames (manual run 2)", () => {
  let sb: h.Sandbox;
  let server: h.FixtureServer;
  let chrome: h.ChromeInstance | undefined;
  let crot: h.CrotSession | undefined;
  let witness: h.CdpWitness | undefined;
  let auditFile: string;
  let configFile: string;
  let tabId = -1;
  const nonce = randomBytes(8).toString("hex");

  const formUrl = () => `${server.origin}/layout.html?nonce=${nonce}&frame=${encodeURIComponent(server.crossOrigin)}`;
  const events = (type: string) =>
    server.requests.filter(
      (r) => r.path === "/event" && r.query.get("type") === type && r.query.get("nonce") === nonce,
    );
  const client = () => crot!.client;
  const snapshot = (args: Record<string, unknown> = {}) =>
    h.ok<Snapshot>(client(), "browser_snapshot", { tabId, ...args });
  const find = (snap: Snapshot, role: string, name: string): Element => {
    const element = snap.elements.find((e) => e.role === role && e.name === name);
    if (!element)
      throw new Error(
        `no ${role} "${name}" in the snapshot: ${JSON.stringify(snap.elements.map((e) => [e.role, e.name]))}`,
      );
    return element;
  };
  const waitEvent = (type: string, count = 1) =>
    h.waitFor(async () => (events(type).length >= count ? events(type) : undefined), 10_000, `the ${type} event`);
  /** Fresh form page; its child frame loaded. */
  async function openLayout(): Promise<Snapshot> {
    await h.ok<ControlResult>(client(), "browser_navigate", { tabId, url: formUrl(), waitUntil: "load" });
    let last: Snapshot | undefined;
    try {
      return await h.waitFor(
        async () => {
          last = await snapshot();
          return last.elements.some((e) => e.name === "Written button") &&
            last.elements.filter((e) => e.name === "Frame button").length === 2
            ? last
            : undefined;
        },
        15_000,
        "the layout page with its frames",
      );
    } catch (error) {
      throw new Error(
        `${String(error)}; requests: ${server.requests.map((r) => r.path).join(",")}; last snapshot: ${JSON.stringify(last)}`,
      );
    }
  }

  beforeAll(async () => {
    await h.assertBuilt();
    const executable = h.chromeExecutable();
    sb = await h.createSandbox();
    auditFile = path.join(sb.base, "audit-layout.jsonl");
    server = await h.startFixtureServer();
    await h.installNativeHost(sb);
    configFile = path.join(sb.base, "config-layout.json");
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        workspace: { root: sb.workspace },
        // No approval UI in this run: the untrusted-content rule (AD-12) is off, as in real-browser.e2e.test.ts.
        permissions: {
          mode: "sandbox",
          capabilities: ["browser.read", "browser.control"],
          approvals: { untrustedContent: "off" },
        },
        environment: { path: "inherited" },
        browser: { enabled: true },
      }),
    );
    crot = await h.startCrot(sb, configFile, auditFile);
    chrome = h.launchChrome(executable, sb, { remoteDebugging: true });
    await h.waitFor(
      async () => {
        const status = await h.ok<{ state: string }>(client(), "browser_status");
        return status.state === "connected" ? true : undefined;
      },
      60_000,
      "the extension to connect",
    );
    witness = await h.watchExtensionCdp(sb);
    const opened = await h.ok<ControlResult>(client(), "browser_tab_open", { url: formUrl(), waitUntil: "load" });
    tabId = opened.tabId;
  });

  afterEach(({ task }) => {
    if (task.result?.state !== "fail") return;
    process.stderr.write(`\n--- browser output (tail) ---\n${chrome?.output().slice(-8_000) ?? "(not started)"}\n`);
    process.stderr.write(`--- crot stderr ---\n${crot?.stderr().slice(-8_000) ?? "(not started)"}\n`);
  });

  afterAll(async () => {
    witness?.close();
    await crot?.close().catch(() => undefined);
    await chrome?.stop().catch(() => undefined);
    await server?.close().catch(() => undefined);
    if (!sb) return;
    const artifacts = process.env.CROT_E2E_ARTIFACTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(path.join(artifacts, "layout-browser.log"), chrome?.output() ?? "");
      await writeFile(path.join(artifacts, "layout-crot.stderr.log"), crot?.stderr() ?? "");
      await cp(auditFile, path.join(artifacts, path.basename(auditFile))).catch(() => undefined);
    }
    if (process.env.CROT_E2E_KEEP !== "1")
      await rm(sb.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const frameOf = (snap: Snapshot, element: Element): Frame =>
    snap.frames.find((f) => f.frameRef === element.frameRef)!;
  const frameButtons = (snap: Snapshot) =>
    snap.elements.filter((e) => e.role === "button" && e.name === "Frame button");

  it("same-origin frame: refs act (no false BROWSER_STALE_REF); selector + frameRef resolves in that frame", async () => {
    const snap = await openLayout();
    const same = frameButtons(snap).find((e) => frameOf(snap, e).origin === server.origin)!;
    expect(same).toBeDefined();
    await h.ok<ControlResult>(client(), "browser_click", { tabId, ref: same.ref });
    await waitEvent("frame-click", 1);
    await h.ok<ControlResult>(client(), "browser_type", {
      tabId,
      selector: "#frame-input",
      frameRef: same.frameRef,
      text: "x",
    });
    await waitEvent("frame-input", 1);
    await h.ok<ControlResult>(client(), "browser_click", { tabId, selector: "#frame-button", frameRef: same.frameRef });
    await waitEvent("frame-click", 2);
    expect(events("frame-click").every((r) => r.query.get("trusted") === "1")).toBe(true);
    // Drag inside the frame: from a ref onto a selector of the same frame.
    await h.ok<ControlResult>(client(), "browser_drag", {
      tabId,
      ref: same.ref,
      to: { selector: "#frame-input", frameRef: same.frameRef },
    });
    // A wait by selector in that frame; a ref with another frame's frameRef is refused.
    await h.ok(client(), "browser_wait", {
      tabId,
      selector: "#frame-status",
      frameRef: same.frameRef,
      timeoutMs: 5_000,
    });
    const top = snap.frames.find((f) => f.parentFrameRef === null)!;
    const mismatch = await h.fails(client(), "browser_click", { tabId, ref: same.ref, frameRef: top.frameRef });
    expect(mismatch.code).toBe("INVALID_INPUT");
    // Without frameRef a selector is resolved in the top-level document only.
    expect((await h.fails(client(), "browser_click", { tabId, selector: "#frame-button" })).code).toBe("NOT_FOUND");
  });

  it("frame whose document is written by script: click and set_checked by ref", async () => {
    const snap = await openLayout();
    const button = find(snap, "button", "Written button");
    await h.ok<ControlResult>(client(), "browser_click", { tabId, ref: button.ref });
    await waitEvent("written-click");
    const check = find(snap, "checkbox", "Written check");
    const result = await h.ok<{ checked: boolean }>(client(), "browser_set_checked", {
      tabId,
      ref: check.ref,
      checked: true,
    });
    expect(result.checked).toBe(true);
    await waitEvent("written-check");
  });

  it("cross-origin frame inside an open shadow root: click by ref (no false obscured)", async () => {
    const snap = await openLayout();
    const shadowed = frameButtons(snap).find((e) => frameOf(snap, e).origin === server.crossOrigin)!;
    expect(shadowed).toBeDefined();
    const before = events("frame-click").length;
    await witness!.inputEvidence(tabId, true);
    await h.ok<ControlResult>(client(), "browser_click", { tabId, ref: shadowed.ref });
    try {
      await waitEvent("frame-click", before + 1);
      expect(events("frame-click").at(-1)!.query.get("trusted")).toBe("1");
      const evidence = (await witness!.inputEvidence(tabId)) as {
        result: { url: string; events: { type: string; target: string; trusted: boolean }[] };
      }[];
      const target = evidence.find((f) => f.result.url.includes("shadow=1"))!;
      for (const type of ["pointerdown", "pointerup", "click"])
        expect(target.result.events).toContainEqual(
          expect.objectContaining({ type, target: "frame-button", trusted: true }),
        );
    } catch (error) {
      throw new Error(String(error) + "; input evidence: " + JSON.stringify(await witness!.inputEvidence(tabId)));
    }
  });

  it("text ref (includeText) can be hovered; a wrapped link is clicked", async () => {
    const snap = await openLayout();
    const withText = await snapshot({ includeText: true });
    const text = withText.elements.find((e) => e.name === "Plain text target");
    expect(text, JSON.stringify(withText.elements.map((e) => [e.role, e.name]))).toBeDefined();
    await h.ok<ControlResult>(client(), "browser_hover", { tabId, ref: text!.ref });
    await waitEvent("text-hover");
    await h.ok<ControlResult>(client(), "browser_click", {
      tabId,
      ref: find(snap, "link", "a link that wraps over several lines").ref,
    });
    await waitEvent("wrap-click");
  });

  it("an element scrolled under a fixed header is scrolled clear and clicked", async () => {
    await openLayout();
    let snap = await snapshot();
    const low = find(snap, "button", "Low button");
    await h.ok<ControlResult>(client(), "browser_scroll", { tabId, deltaY: Math.round(low.bounds!.y - 30) });
    snap = await snapshot();
    const moved = find(snap, "button", "Low button");
    expect(moved.bounds!.y).toBeLessThan(80);
    expect(moved.bounds!.y).toBeGreaterThanOrEqual(0);
    await h.ok<ControlResult>(client(), "browser_click", { tabId, ref: moved.ref });
    await waitEvent("low-click");
  });

  it("number input: typed value and ArrowUp are reported; an open dialog comes first in a cut snapshot", async () => {
    let snap = await openLayout();
    const quantity = find(snap, "spinbutton", "Quantity");
    await h.ok(client(), "browser_type", { tabId, ref: quantity.ref, text: "456", clear: true });
    await h.ok(client(), "browser_press_key", { tabId, ref: quantity.ref, keys: ["ArrowUp"] });
    snap = await snapshot();
    expect(find(snap, "spinbutton", "Quantity").value).toBe("457");
    const cut = await snapshot({ maxElements: 3 });
    expect(cut.truncated).toBe(true);
    expect(cut.elements.map((e) => e.name)).toContain("Dialog button");
  });

  it("reports a dialog without content in controls, exposes it only in snapshots, and handles it", async () => {
    const snap = await openLayout();
    const started = Date.now();
    const opened = await h.ok<{ dialog: { type: string } }>(client(), "browser_click", {
      tabId,
      ref: find(snap, "button", "Open alert").ref,
    });
    expect(opened.dialog).toEqual({ type: "alert" });
    const exposed = await h.ok<{ dialog: { type: string; message: string } }>(client(), "browser_snapshot", { tabId });
    expect(exposed.dialog).toEqual({ type: "alert", message: "CROT E2E alert", defaultPrompt: "" });
    expect((await h.fails(client(), "browser_page_read", { tabId })).code).toBe("BROWSER_DIALOG_OPEN");
    expect(Date.now() - started).toBeLessThan(10000);
    await h.ok(client(), "browser_dialog_handle", { tabId, accept: false });
    await snapshot();
  });
  it("clicks own and descendant pseudo-elements with trusted input", async () => {
    const snap = await openLayout();
    await h.ok(client(), "browser_click", { tabId, ref: find(snap, "button", "Pseudo button").ref });
    await waitEvent("pseudo-click");
    await h.ok(client(), "browser_click", { tabId, ref: find(snap, "button", "Descendant pseudo").ref });
    await waitEvent("descendant-pseudo-click");
    expect(events("pseudo-click")[0].query.get("trusted")).toBe("1");
    expect(events("descendant-pseudo-click")[0].query.get("trusted")).toBe("1");
  });

  it("wait terminates promptly when the user closes the tab during the wait", async () => {
    const opened = await h.ok<ControlResult>(client(), "browser_tab_open", {
      url: server.origin + "/layout.html",
      waitUntil: "load",
    });
    const started = Date.now();
    const pending = h.fails(client(), "browser_wait", { tabId: opened.tabId, text: "___NEVER___", timeoutMs: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await witness!.closeTab(opened.tabId);
    const error = await pending;
    expect(error.code).toBe("NOT_FOUND");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports distinct native windowIds and targets the tab in the second window", async () => {
    const opened = await witness!.openWindow(formUrl());
    try {
      const listed = await h.ok<{ tabs: { tabId: number; windowId: number }[] }>(client(), "browser_tabs_list");
      const first = listed.tabs.find((t) => t.tabId === tabId)!;
      const second = listed.tabs.find((t) => t.tabId === opened.tabId)!;
      expect(second.windowId).toBe(opened.windowId);
      expect(second.windowId).not.toBe(first.windowId);
      await h.ok(client(), "browser_click", { tabId: opened.tabId, selector: "#pseudo-button" });
      await waitEvent("pseudo-click", 2);
    } finally {
      await witness!.closeWindow(opened.windowId);
    }
  });
  it("frame form submission and history.back keep snapshots responsive over three cycles", async () => {
    const opened = await h.ok<ControlResult>(client(), "browser_tab_open", {
      url: server.origin + "/history.html",
      waitUntil: "load",
    });
    const snapOf = () => h.ok<Snapshot>(client(), "browser_snapshot", { tabId: opened.tabId });
    const ready = async (name: string) =>
      h.waitFor(
        async () => {
          const snap = await snapOf();
          return snap.elements.some((e) => e.name === name) ? snap : undefined;
        },
        10000,
        name,
      );
    try {
      for (let i = 0; i < 3; i++) {
        let snap = await ready("History submit");
        await h.ok(client(), "browser_type", {
          tabId: opened.tabId,
          ref: find(snap, "textbox", "Email").ref,
          text: "history@example.test",
          clear: true,
        });
        await h.ok(client(), "browser_click", { tabId: opened.tabId, ref: find(snap, "button", "History submit").ref });
        snap = await ready("History back");
        await h.ok(client(), "browser_click", { tabId: opened.tabId, ref: find(snap, "button", "History back").ref });
        await ready("History submit");
      }
    } finally {
      await witness!.closeTab(opened.tabId);
    }
  });

  it("a scrolled link can be clicked after back restores the document", async () => {
    for (let i = 0; i < 3; i++) {
      await openLayout();
      await h.ok(client(), "browser_scroll", { tabId, deltaY: 900 });
      await h.ok(client(), "browser_navigate", { tabId, url: server.origin + "/history-echo.html", waitUntil: "load" });
      await h.ok(client(), "browser_history", { tabId, action: "back", waitUntil: "load" });
      const snap = await snapshot();
      const before = events("wrap-click").length;
      await h.ok(client(), "browser_click", {
        tabId,
        ref: find(snap, "link", "a link that wraps over several lines").ref,
      });
      await waitEvent("wrap-click", before + 1);
    }
  });
  it("default tab_open timeout before commit is explicit; snapshot stays restricted until the same tab loads", async () => {
    const started = Date.now();
    const opened = await h.ok<ControlResult & { loadTimedOut?: boolean }>(client(), "browser_tab_open", {
      url: server.origin + "/delayed-commit.html",
    });
    const elapsed = Date.now() - started;
    try {
      const before = await h.fails(client(), "browser_snapshot", { tabId: opened.tabId });
      expect(before.code).toBe("BROWSER_PAGE_RESTRICTED");
      expect(before.message).toContain("http: and https:");
      const completed = await h.waitFor(
        async () => {
          const tabs = await h.ok<{ tabs: { tabId: number; url: string; status?: string }[] }>(
            client(),
            "browser_tabs_list",
          );
          return tabs.tabs.find((t) => t.tabId === opened.tabId && t.status === "complete" && t.url === opened.url);
        },
        10000,
        "the same delayed tab to commit and finish loading",
      );
      const after = await h.ok<Snapshot>(client(), "browser_snapshot", { tabId: opened.tabId });
      expect(after.title).toBe("Delayed commit");
      expect(after.elements.some((e) => e.name === "Delayed button")).toBe(true);
      console.info(
        "delayed-commit probe",
        JSON.stringify({
          opened,
          elapsedMs: elapsed,
          before,
          completedTabId: completed.tabId,
          afterTitle: after.title,
        }),
      );
      expect(elapsed).toBeGreaterThanOrEqual(19000);
      expect(elapsed).toBeLessThan(30000);
      expect(opened.loadTimedOut).toBe(true);
    } finally {
      await witness!.closeTab(opened.tabId);
    }
  });
});

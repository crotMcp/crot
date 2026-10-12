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
    await h.ok<ControlResult>(client(), "browser_click", { tabId, ref: shadowed.ref });
    await waitEvent("frame-click", before + 1);
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

  it("a JavaScript dialog fails commands at once (not after their timeout) until the user answers it", async () => {
    const snap = await openLayout();
    const dialogs = await witness!.watchDialogs(server.origin + "/layout.html");
    const started = Date.now();
    const opened = await h.fails(client(), "browser_click", { tabId, ref: find(snap, "button", "Open alert").ref });
    expect(opened.code).toBe("OPERATION_FAILED");
    expect(opened.message).toContain("opened a JavaScript alert dialog");
    const blocked = await h.fails(client(), "browser_snapshot", { tabId });
    expect(blocked.message).toContain("JavaScript alert dialog is open");
    expect(Date.now() - started).toBeLessThan(10_000);
    await dialogs.answer();
    const after = await h.waitFor(
      async () => {
        const outcome = await h.callTool(client(), "browser_snapshot", { tabId });
        return outcome.isError ? undefined : outcome;
      },
      10_000,
      "commands to work again after the dialog was answered",
    );
    expect(after.isError).toBe(false);
  });
});

import { randomBytes } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CDP_ALLOWED_METHODS } from "../../extension/src/cdp.js";
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
interface TabInfo {
  tabId: number;
  url: string;
  openerTabId?: number;
}

const linux = process.platform === "linux";

describe.skipIf(linux)("browser v1 E2E", () => {
  it.skip(`is implemented for Linux only (current platform: ${process.platform}); see docs/BROWSER_E2E.md`, () =>
    undefined);
});

describe.runIf(linux)("browser v1 E2E (AD-16): refs, trusted input, frames, shadow DOM, pop-ups, CDP surface", () => {
  let sb: h.Sandbox;
  let server: h.FixtureServer;
  let chrome: h.ChromeInstance | undefined;
  let crot: h.CrotSession | undefined;
  let witness: h.CdpWitness | undefined;
  let auditFile: string;
  let configFile: string;
  let tabId = -1;
  const nonce = randomBytes(8).toString("hex");

  const formUrl = () => `${server.origin}/form.html?nonce=${nonce}&frame=${encodeURIComponent(server.crossOrigin)}`;
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
  async function openForm(): Promise<Snapshot> {
    await h.ok<ControlResult>(client(), "browser_navigate", { tabId, url: formUrl(), waitUntil: "load" });
    let last: Snapshot | undefined;
    try {
      return await h.waitFor(
        async () => {
          last = await snapshot();
          return last.elements.some((e) => e.name === "Frame button") ? last : undefined;
        },
        15_000,
        "the form page with its cross-origin frame",
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
    auditFile = path.join(sb.base, "audit-v1.jsonl");
    server = await h.startFixtureServer();
    await h.installNativeHost(sb);
    configFile = path.join(sb.base, "config-v1.json");
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
      await writeFile(path.join(artifacts, "v1-browser.log"), chrome?.output() ?? "");
      await writeFile(path.join(artifacts, "v1-crot.stderr.log"), crot?.stderr() ?? "");
      await cp(auditFile, path.join(artifacts, path.basename(auditFile))).catch(() => undefined);
    }
    if (process.env.CROT_E2E_KEEP !== "1")
      await rm(sb.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("snapshot: frames with origins, refs for top-level, cross-origin frame and open shadow root; no password value", async () => {
    const snap = await openForm();
    expect(snap.tabId).toBe(tabId);
    const top = snap.frames.find((f) => f.parentFrameRef === null);
    const child = snap.frames.find((f) => f.parentFrameRef !== null);
    expect(top?.origin).toBe(server.origin);
    expect(child?.origin).toBe(server.crossOrigin);
    expect(child?.restricted).toBe(false);
    expect(find(snap, "button", "Sign up").frameRef).toBe(top!.frameRef);
    expect(find(snap, "button", "Frame button").frameRef).toBe(child!.frameRef);
    expect(find(snap, "button", "Shadow button").frameRef).toBe(top!.frameRef);
    for (const e of snap.elements) expect(e.ref).toMatch(/^e[1-9][0-9]*$/);
    // The same element of the same document keeps its ref across snapshots.
    const again = await snapshot();
    expect(find(again, "button", "Sign up").ref).toBe(find(snap, "button", "Sign up").ref);
    // A frame-limited snapshot covers only that frame.
    const frameOnly = await snapshot({ frameRef: child!.frameRef });
    expect(frameOnly.elements.length).toBeGreaterThan(0);
    expect(frameOnly.elements.every((e) => e.frameRef === child!.frameRef)).toBe(true);
  });

  it("multi-step form by refs with trusted events: type, password, select, checkbox, Enter-free submit", async () => {
    const snap = await openForm();
    const name = find(snap, "textbox", "Full name");
    const password = find(snap, "textbox", "Password");
    const plan = find(snap, "combobox", "Plan");
    const terms = find(snap, "checkbox", "Accept terms");
    await h.ok<ControlResult>(client(), "browser_type", { tabId, ref: name.ref, text: "Ada Lovelace" });
    await h.ok<ControlResult>(client(), "browser_type", { tabId, ref: password.ref, text: "s3cret-pass" });
    const selected = await h.ok<ControlResult & { selected: string[] }>(client(), "browser_select_option", {
      tabId,
      ref: plan.ref,
      values: ["pro"],
    });
    expect(selected.selected).toEqual(["pro"]);
    await h.ok<ControlResult>(client(), "browser_set_checked", { tabId, ref: terms.ref, checked: true });
    await h.ok<ControlResult>(client(), "browser_press_key", { tabId, ref: name.ref, keys: ["End"] });

    // The snapshot reflects the state; the password value is never returned.
    const filled = await snapshot();
    expect(find(filled, "textbox", "Full name").value).toBe("Ada Lovelace");
    const pw = find(filled, "textbox", "Password");
    expect(pw.value).toBeUndefined();
    expect(pw.hasValue).toBe(true);
    expect(JSON.stringify(filled)).not.toContain("s3cret-pass");
    expect(find(filled, "checkbox", "Accept terms").states.checked).toBe(true);

    // Events reached the page as trusted input (isTrusted), not synthetic DOM events.
    const keydowns = await waitEvent("keydown");
    const inputs = await waitEvent("input");
    expect(keydowns.every((r) => r.query.get("trusted") === "1")).toBe(true);
    expect(inputs.every((r) => r.query.get("trusted") === "1")).toBe(true);

    const submitted = await h.ok<ControlResult>(client(), "browser_click", {
      tabId,
      ref: find(filled, "button", "Sign up").ref,
      waitUntil: "load",
    });
    expect((await waitEvent("submit-click"))[0]!.query.get("trusted")).toBe("1");
    expect(submitted.navigated).toBe(true);
    expect(submitted.url).toContain("/done.html");
    const done = server.requests.find((r) => r.path === "/done.html");
    expect(done?.query.get("name")).toBe("Ada Lovelace");
    expect(done?.query.get("plan")).toBe("pro");
    expect(done?.query.get("terms")).toBe("on");
  });

  it("stale refs after navigation, reload and element removal: BROWSER_STALE_REF, nothing done", async () => {
    // Navigation: a ref of the form page used on the next document.
    let snap = await openForm();
    const submitRef = find(snap, "button", "Sign up").ref;
    await h.ok<ControlResult>(client(), "browser_navigate", {
      tabId,
      url: `${server.origin}/done.html`,
      waitUntil: "load",
    });
    await expect(h.fails(client(), "browser_click", { tabId, ref: submitRef })).resolves.toMatchObject({
      code: "BROWSER_STALE_REF",
    });

    // Reload: same URL, new document.
    snap = await openForm();
    const nameRef = find(snap, "textbox", "Full name").ref;
    await h.ok<ControlResult>(client(), "browser_history", { tabId, action: "reload", waitUntil: "load" });
    const before = events("input").length;
    await expect(h.fails(client(), "browser_type", { tabId, ref: nameRef, text: "x" })).resolves.toMatchObject({
      code: "BROWSER_STALE_REF",
    });
    await h.sleep(500);
    expect(events("input").length).toBe(before);
    const fresh = await snapshot();
    expect(find(fresh, "textbox", "Full name").ref).not.toBe(nameRef); // never re-resolved

    // Element removal: the doomed button is removed by the page.
    const doomed = find(fresh, "button", "Doomed button").ref;
    await h.ok<ControlResult>(client(), "browser_click", {
      tabId,
      ref: find(fresh, "button", "Remove the doomed button").ref,
    });
    await waitEvent("remove-click");
    await expect(h.fails(client(), "browser_click", { tabId, ref: doomed })).resolves.toMatchObject({
      code: "BROWSER_STALE_REF",
    });
  });

  it("cross-origin frame: a trusted click by ref, audited with the frame origin and role (no names)", async () => {
    const snap = await openForm();
    const button = find(snap, "button", "Frame button");
    await h.ok<ControlResult>(client(), "browser_click", { tabId, ref: button.ref });
    const clicks = await waitEvent("frame-click");
    expect(clicks[0]!.query.get("trusted")).toBe("1");
    // Bounds are in top-level viewport coordinates: the frame sits right of the pop-up link on its line,
    // so untranslated frame-local coordinates (about 8, 8) would be left of the link's end.
    const link = find(snap, "link", "Open popup").bounds!;
    expect(button.bounds).not.toBeNull();
    expect(button.bounds!.x).toBeGreaterThan(link.x + link.width);
    expect(button.inViewport).toBe(true);

    // Text input into the out-of-process frame: focused there, trusted events, value visible in the next snapshot.
    const input = find(snap, "textbox", "Frame input");
    await h.ok<ControlResult>(client(), "browser_type", { tabId, ref: input.ref, text: "inside the frame" });
    expect((await waitEvent("frame-input"))[0]!.query.get("trusted")).toBe("1");
    const after = await snapshot();
    expect(find(after, "textbox", "Frame input").value).toBe("inside the frame");
    const { records, text } = await h.readAudit(auditFile);
    const record = records.filter((r) => r.operation === "browser.click" && r.details?.ref === button.ref).at(-1);
    expect(record).toMatchObject({
      outcome: "success",
      details: { tabId, ref: button.ref, elementRole: "button", frameOrigin: server.crossOrigin },
    });
    expect(text).not.toContain("Frame button");
  });

  it("open shadow root: a trusted click on an element inside it by ref", async () => {
    const snap = await openForm();
    await h.ok<ControlResult>(client(), "browser_click", { tabId, ref: find(snap, "button", "Shadow button").ref });
    expect((await waitEvent("shadow-click"))[0]!.query.get("trusted")).toBe("1");
    const page = await h.ok<{ content: string }>(client(), "browser_page_read", { tabId });
    expect(page.content).toContain("SHADOW: clicked");
  });

  it("pop-up: the click reports newTabs, and the new tab names its opener", async () => {
    const snap = await openForm();
    const result = await h.ok<ControlResult>(client(), "browser_click", {
      tabId,
      ref: find(snap, "link", "Open popup").ref,
      waitUntil: "load",
    });
    expect(result.newTabs?.length).toBe(1);
    const popup = result.newTabs![0]!;
    const { tabs } = await h.ok<{ tabs: TabInfo[] }>(client(), "browser_tabs_list");
    const info = tabs.find((t) => t.tabId === popup);
    expect(info?.openerTabId).toBe(tabId);
    expect(info?.url).toContain("/start.html?popup=1");
    await h.ok(client(), "browser_tab_close", { tabId: popup });
  });

  it("CDP surface: every command the extension sent is on the fixed allowlist; no Runtime.* at all", async () => {
    const methods = await witness!.methods();
    expect(methods.length).toBeGreaterThan(0);
    const forbidden = methods.filter((m) => !CDP_ALLOWED_METHODS.has(m));
    expect(forbidden).toEqual([]);
    expect(methods.some((m) => m.startsWith("Runtime."))).toBe(false);
    // Input really went through CDP (trusted events), not through page scripts.
    expect(methods).toContain("Input.dispatchMouseEvent");
    expect(methods).toContain("Input.dispatchKeyEvent");
  });

  it("stale refs after the debugger detaches: the CROT connection ends, every session is detached, old refs fail", async () => {
    const snap = await openForm();
    const submitRef = find(snap, "button", "Sign up").ref;
    expect(await witness!.pageAttached(`${server.origin}/form.html`)).toBe(true);

    await crot!.close();
    crot = undefined;
    // The extension detaches every debugger session when the host connection ends.
    await h.waitFor(
      async () => ((await witness!.pageAttached(`${server.origin}/form.html`)) === false ? true : undefined),
      15_000,
      "the extension to detach from the tab",
    );

    crot = await h.startCrot(sb, configFile, auditFile);
    await h.waitFor(
      async () => {
        const status = await h.ok<{ state: string }>(client(), "browser_status");
        return status.state === "connected" ? true : undefined;
      },
      60_000,
      "the extension to reconnect",
    );
    const clicksBefore = events("submit-click").length;
    await expect(h.fails(client(), "browser_click", { tabId, ref: submitRef })).resolves.toMatchObject({
      code: "BROWSER_STALE_REF",
    });
    await h.sleep(500);
    expect(events("submit-click").length).toBe(clicksBefore);
  });
});

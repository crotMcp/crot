import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as h from "./harness.js";

interface ControlResult {
  tabId: number;
  url: string;
  dialog?: { type: string };
}
interface Snapshot {
  elements: { ref: string; role: string; name: string; bounds: { width: number; height: number } | null }[];
  dialog?: { type: string; message: string; defaultPrompt?: string };
}
interface Tab {
  tabId: number;
  active: boolean;
  groupedByCrot: boolean;
  discarded: boolean;
  openerTabId?: number;
  dialog?: { type: string; message: string };
}

describe.runIf(process.platform === "linux")("WP-25 real Chromium: dialogs, screenshot, debugger, groups", () => {
  let sb: h.Sandbox, server: h.FixtureServer, auditFile: string, configFile: string;
  let chrome: h.ChromeInstance | undefined, crot: h.CrotSession | undefined, witness: h.CdpWitness | undefined;
  let tabId = -1;
  const client = () => crot!.client;
  const fixture = () => server.origin + "/wp25.html";
  const snap = () => h.ok<Snapshot>(client(), "browser_snapshot", { tabId });
  const tabs = () => h.ok<{ tabs: Tab[] }>(client(), "browser_tabs_list");
  const fresh = async () => {
    await h.ok(client(), "browser_navigate", { tabId, url: fixture() });
    return snap();
  };
  const click = async (name: string) => {
    const s = await snap();
    const e = s.elements.find((e) => e.name === name);
    if (!e) throw new Error("missing " + name);
    return h.ok<ControlResult>(client(), "browser_click", { tabId, ref: e.ref });
  };
  beforeAll(async () => {
    await h.assertBuilt();
    const executable = h.chromeExecutable();
    sb = await h.createSandbox();
    auditFile = path.join(sb.base, "audit-wp25.jsonl");
    server = await h.startFixtureServer();
    await h.installNativeHost(sb);
    configFile = path.join(sb.base, "config-wp25.json");
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
    const opened = await h.ok<ControlResult>(client(), "browser_tab_open", { url: fixture(), waitUntil: "load" });
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
      await writeFile(path.join(artifacts, "wp25-browser.log"), chrome?.output() ?? "");
      await writeFile(path.join(artifacts, "wp25-crot.stderr.log"), crot?.stderr() ?? "");
      await cp(auditFile, path.join(artifacts, path.basename(auditFile))).catch(() => undefined);
    }
    if (process.env.CROT_E2E_KEEP !== "1")
      await rm(sb.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("alert/confirm/prompt expose text only through snapshot/tabs; handle accept/dismiss and promptText", async () => {
    await fresh();
    for (const [name, type] of [
      ["Alert", "alert"],
      ["Confirm", "confirm"],
      ["Prompt", "prompt"],
    ]) {
      const opened = await click(name!);
      expect(opened.dialog).toEqual({ type });
      expect(JSON.stringify(opened)).not.toContain("private");
      const s = await snap();
      expect(s.dialog?.type).toBe(type);
      expect(s.dialog?.message).toContain("private");
      expect((await tabs()).tabs.find((t) => t.tabId === tabId)?.dialog?.message).toBe(s.dialog?.message);
      expect((await h.fails(client(), "browser_page_read", { tabId })).code).toBe("BROWSER_DIALOG_OPEN");
      expect((await h.fails(client(), "browser_screenshot", { tabId })).code).toBe("BROWSER_DIALOG_OPEN");
      await h.ok(client(), "browser_dialog_handle", {
        tabId,
        accept: type === "prompt",
        ...(type === "prompt" ? { promptText: "typed answer" } : {}),
      });
      expect((await snap()).dialog).toBeUndefined();
    }
    const read = await h.ok<{ content: string }>(client(), "browser_page_read", { tabId });
    expect(read.content).toContain("typed answer");
  });

  it("intercepts file chooser and safely dismisses without a native OS picker", async () => {
    await fresh();
    const result = await click("Upload");
    expect(result.dialog).toEqual({ type: "file_chooser" });
    expect((await snap()).dialog?.type).toBe("file_chooser");
    expect((await h.fails(client(), "browser_dialog_handle", { tabId, accept: true })).code).toBe("INVALID_INPUT");
    await h.ok(client(), "browser_dialog_handle", { tabId, accept: false });
    expect((await snap()).dialog).toBeUndefined();
    expect(await witness!.methods()).toContain("Page.setInterceptFileChooserDialog");
  });

  it("beforeunload dismissal retains the document; tab close remains possible with a pending alert", async () => {
    await fresh();
    await click("Arm beforeunload");
    const result = await h.ok<ControlResult>(client(), "browser_navigate", {
      tabId,
      url: server.origin + "/fixture.html",
    });
    expect(result.dialog).toEqual({ type: "beforeunload" });
    await h.ok(client(), "browser_dialog_handle", { tabId, accept: false });
    expect((await tabs()).tabs.find((t) => t.tabId === tabId)).toMatchObject({ url: fixture() });
    // A separate tab avoids leaving the beforeunload handler on the main test tab.
    const opened = await h.ok<ControlResult>(client(), "browser_tab_open", { url: fixture() });
    const keep = tabId;
    tabId = opened.tabId;
    await click("Alert");
    await h.ok(client(), "browser_tab_close", { tabId });
    tabId = keep;
    // Close itself may open beforeunload. Report it, never implicitly accept.
    const closing = await h.ok<{ closed: boolean; dialog: { type: string } }>(client(), "browser_tab_close", { tabId });
    expect(closing).toMatchObject({ closed: false, dialog: { type: "beforeunload" } });
    await h.ok(client(), "browser_dialog_handle", { tabId, accept: false });
    // Explicit navigation and explicit acceptance leave the armed document.
    await h.ok(client(), "browser_navigate", { tabId, url: fixture() + "?after=1" });
    await h.ok(client(), "browser_dialog_handle", { tabId, accept: true });
    await h.waitFor(
      async () =>
        (await tabs()).tabs.find((t) => t.tabId === tabId && "url" in t && String(t.url).includes("?after=1")),
      10000,
      "accepted unload navigation",
    );
  });

  it("captures background/ref/fullPage without activation or focus change; discarded refuses without reload", async () => {
    const s = await fresh();
    const background = tabId;
    const foreground = await h.ok<ControlResult>(client(), "browser_tab_open", { url: fixture() + "?foreground=1" });
    const before = await witness!.tabState();
    const capture = async (args: Record<string, unknown> = {}) => {
      const result = await client().callTool({ name: "browser_screenshot", arguments: { tabId: background, ...args } });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; data?: string; text?: string }[];
      const image = content.find((c) => c.type === "image")!;
      const bytes = Buffer.from(image.data!, "base64");
      const metadata = JSON.parse(content.find((c) => c.type === "text")!.text!) as {
        viewport: { width: number; height: number };
        devicePixelRatio: number;
      };
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), metadata };
    };
    const view = await capture();
    expect(view.metadata.devicePixelRatio).toBeGreaterThan(0);
    expect(view.metadata.viewport.width).toBeGreaterThan(0);
    const full = await capture({ fullPage: true });
    expect(full.height).toBeGreaterThan(view.height);
    const ref = s.elements.find((e) => e.name === "Red clip")!.ref;
    const crop = await capture({ ref });
    expect(crop.width).toBe(Math.round(120 * crop.metadata.devicePixelRatio));
    expect(crop.height).toBe(Math.round(80 * crop.metadata.devicePixelRatio));
    expect(await witness!.tabState()).toEqual(before);
    await witness!.detachTab(background);
    await witness!.discardTab(background);
    expect((await h.fails(client(), "browser_screenshot", { tabId: background })).code).toBe("INVALID_INPUT");
    expect((await tabs()).tabs.find((t) => t.tabId === background)?.discarded).toBe(true);
    await h.ok(client(), "browser_tab_close", { tabId: background });
    tabId = foreground.tabId;
  });

  it("real external detach invalidates refs, reconnects; simulated enterprise attach refusal reports status without fallback", async () => {
    const s = await fresh();
    const ref = s.elements.find((e) => e.name === "Red clip")!.ref;
    await witness!.detachTab(tabId);
    expect((await h.fails(client(), "browser_screenshot", { tabId, ref })).code).toBe("BROWSER_STALE_REF");
    await snap();
    expect(await witness!.pageAttached(fixture())).toBe(true);
    await witness!.detachTab(tabId);
    // chrome.debugger.detach itself emits no onDetach. First failed command
    // detects that missing session; only the next command attempts an attach.
    expect((await h.fails(client(), "browser_snapshot", { tabId })).code).toBe("OPERATION_FAILED");
    await witness!.blockDebugger(true);
    try {
      const error = await h.fails(client(), "browser_snapshot", { tabId });
      expect(error.code).toBe("OPERATION_FAILED");
      expect(error.message).toContain("debugger interface is not available");
      const status = await h.ok<{ cdp: { available: boolean; reason: string } }>(client(), "browser_status");
      expect(status.cdp.available).toBe(false);
      expect(status.cdp.reason).toBe("debugger_unavailable");
    } finally {
      await witness!.blockDebugger(false);
    }
    await snap();
    expect((await h.ok<{ cdp: { available: boolean; reason: null } }>(client(), "browser_status")).cdp).toEqual({
      available: true,
      reason: null,
    });
  });

  it("groups opened tabs and real popups in CROT per window", async () => {
    await fresh();
    expect((await tabs()).tabs.find((t) => t.tabId === tabId)?.groupedByCrot).toBe(true);
    await click("Popup");
    const popup = await h.waitFor(
      async () => (await tabs()).tabs.find((t) => t.openerTabId === tabId && t.groupedByCrot),
      10000,
      "CROT popup group",
    );
    await h.ok(client(), "browser_tab_close", { tabId: popup.tabId });
  });

  it("dismisses an unanswered confirm after the real 60s production timeout and audits without page text", async () => {
    await fresh();
    const start = Date.now();
    await click("Confirm");
    await h.waitFor(
      async () => ((await snap()).dialog === undefined ? true : undefined),
      70000,
      "automatic dialog dismissal",
    );
    expect(Date.now() - start).toBeGreaterThanOrEqual(59000);
    const audit = await h.waitFor(
      async () => {
        const lines = (await readFile(auditFile, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        return lines.find((l) => l.event === "browser.dialog_auto_dismissed");
      },
      5000,
      "dialog audit",
    );
    expect(audit).toMatchObject({ kind: "browser", tabId, dialogType: "confirm" });
    expect(audit.connectionId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(audit)).not.toMatch(/private|promptText|message/);
    expect((await h.ok<{ content: string }>(client(), "browser_page_read", { tabId })).content).toContain("false");
  });
});

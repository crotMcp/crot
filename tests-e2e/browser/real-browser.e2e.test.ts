import { randomBytes } from "node:crypto";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as h from "./harness.js";

/**
 * REAL end-to-end test of the CROT browser chain (docs/BROWSER_E2E.md):
 *
 *   MCP client (agent) -> crot-mcp (MCP adapter) -> Core BrowserService ->
 *   ExecutionGuard + PermissionEngine -> BrowserBridge -> Unix socket ->
 *   crot-browser-relay (started BY CHROMIUM via native messaging) ->
 *   CROT Browser Extension -> real Chromium tab -> and all the way back.
 *
 * Nothing in that chain is mocked. The test uses only the public MCP tools and
 * the normal CLI/config of CROT; permissions come from an ordinary config file.
 */

interface TabInfo {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  status?: string;
}
interface PageRead {
  tabId: number;
  url: string;
  title: string;
  format: string;
  content: string;
  truncated: boolean;
}
interface BrowserStatus {
  state: string;
  detail: string;
  browser?: { name: string; version: string; extensionVersion: string };
}

const linux = process.platform === "linux";

describe.skipIf(linux)("real browser E2E", () => {
  it.skip(`is implemented for Linux only (current platform: ${process.platform}); see docs/BROWSER_E2E.md`, () =>
    undefined);
});

describe.runIf(linux)(
  "real browser E2E: CROT -> BrowserBridge -> relay -> native messaging -> extension -> Chromium",
  () => {
    let sb: h.Sandbox;
    let server: h.FixtureServer;
    let host: h.InstalledHost;
    let chrome: h.ChromeInstance | undefined;
    let full: h.CrotSession | undefined;
    let readOnly: h.CrotSession | undefined;
    let executable: string;
    let extensionVersion: string;
    let auditFull: string;
    let auditReadOnly: string;
    let tabId = -1;
    const nonce = randomBytes(8).toString("hex");
    const reversed = nonce.split("").reverse().join("");

    const startUrl = () => `${server.origin}/start.html?nonce=${nonce}`;
    const fixtureUrl = () => `${server.origin}/fixture.html?nonce=${nonce}`;
    const clickEvents = () =>
      server.requests.filter(
        (r) => r.path === "/event" && r.query.get("type") === "click" && r.query.get("nonce") === nonce,
      );

    async function writeConfig(name: string, capabilities: string[]): Promise<string> {
      const file = path.join(sb.base, `config-${name}.json`);
      const config = {
        version: 1,
        workspace: { root: sb.workspace },
        // Ordinary CROT configuration: sandbox mode with an explicit capability list.
        permissions: { mode: "sandbox", capabilities },
        environment: { path: "inherited" },
        browser: { enabled: true },
      };
      await writeFile(file, JSON.stringify(config, null, 2));
      return file;
    }

    async function findTab(session: h.CrotSession, id: number): Promise<TabInfo | undefined> {
      const { tabs } = await h.ok<{ tabs: TabInfo[] }>(session.client, "browser_tabs_list");
      return tabs.find((t) => t.tabId === id);
    }

    async function waitConnected(session: h.CrotSession): Promise<BrowserStatus> {
      return h.waitFor(
        async () => {
          const status = await h.ok<BrowserStatus>(session.client, "browser_status");
          return status.state === "connected" ? status : undefined;
        },
        60_000,
        "the CROT Browser Extension to connect through crot-browser-relay",
      );
    }

    beforeAll(async () => {
      await h.assertBuilt();
      executable = h.chromeExecutable();
      sb = await h.createSandbox();
      auditFull = path.join(sb.base, "audit-full.jsonl");
      auditReadOnly = path.join(sb.base, "audit-readonly.jsonl");
      server = await h.startFixtureServer();
      extensionVersion = (
        JSON.parse(await readFile(path.join(h.EXTENSION_DIR, "manifest.json"), "utf8")) as { version: string }
      ).version;
    });

    afterEach(({ task }) => {
      if (task.result?.state !== "fail") return;
      process.stderr.write(`\n--- browser output (tail) ---\n${chrome?.output().slice(-8_000) ?? "(not started)"}\n`);
      process.stderr.write(
        `--- crot (browser.control) stderr ---\n${full?.stderr().slice(-8_000) ?? "(not started)"}\n`,
      );
      process.stderr.write(
        `--- crot (browser.read only) stderr ---\n${readOnly?.stderr().slice(-8_000) ?? "(not started)"}\n`,
      );
    });

    afterAll(async () => {
      await full?.close().catch(() => undefined);
      await readOnly?.close().catch(() => undefined);
      await chrome?.stop().catch(() => undefined);
      await server?.close().catch(() => undefined);
      if (!sb) return;
      const artifacts = process.env.CROT_E2E_ARTIFACTS;
      if (artifacts) {
        await mkdir(artifacts, { recursive: true });
        await writeFile(path.join(artifacts, "browser.log"), chrome?.output() ?? "");
        await writeFile(path.join(artifacts, "crot-full.stderr.log"), full?.stderr() ?? "");
        await writeFile(path.join(artifacts, "crot-readonly.stderr.log"), readOnly?.stderr() ?? "");
        await writeFile(
          path.join(artifacts, "http-requests.log"),
          (server?.requests ?? []).map((r) => `${r.path}?${r.query.toString()}  UA=${r.userAgent}`).join("\n"),
        );
        for (const file of [auditFull, auditReadOnly])
          await cp(file, path.join(artifacts, path.basename(file))).catch(() => undefined);
      }
      if (process.env.CROT_E2E_KEEP !== "1")
        await rm(sb.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    it("registers the native-messaging host with `crot-mcp browser install` (isolated HOME)", async () => {
      host = await h.installNativeHost(sb);
      expect(host.manifest.name).toBe(h.NATIVE_HOST_NAME);
      expect(host.manifest.type).toBe("stdio");
      expect(host.manifest.allowed_origins).toEqual([`chrome-extension://${h.EXTENSION_ID}/`]);
      expect(host.launcher).toContain("crot-browser-relay");
      expect(host.stateDir.startsWith(sb.stateHome)).toBe(true);
    });

    it("starts CROT (MCP stdio, browser.read + browser.control): bridge waiting, no browser yet", async () => {
      full = await h.startCrot(sb, await writeConfig("full", ["browser.read", "browser.control"]), auditFull);
      const status = await h.ok<BrowserStatus>(full.client, "browser_status");
      expect(status.state).toBe("waiting");
      await expect(h.fails(full.client, "browser_tabs_list")).resolves.toMatchObject({ code: "BROWSER_NOT_CONNECTED" });
    });

    it("1. real Chromium with the real extension connects: relay started via native messaging, bridge connected", async () => {
      chrome = h.launchChrome(executable, sb);
      const status = await waitConnected(full!);
      expect(status.browser?.extensionVersion).toBe(extensionVersion);
      expect(status.browser?.name.length).toBeGreaterThan(0);
      expect(status.browser?.version).toMatch(/^\d+\./);

      // crot-browser-relay really runs, as a descendant of the browser process (native messaging).
      const relays = await h.waitFor(
        async () => {
          const found = await h.relayProcessesUnder(chrome!.pid, host.stateDir);
          return found.length > 0 ? found : undefined;
        },
        10_000,
        "a crot-browser-relay process started by the browser",
      );
      expect(relays[0]!.cmdline).toContain(h.RELAY_BIN);

      // The real bridge endpoint (Unix socket in the CROT state directory).
      await access(path.join(host.stateDir, "browser.sock"));

      // crot_status (no capability needed) reports the connected bridge too.
      const crotStatus = await h.ok<unknown>(full!.client, "crot_status");
      expect(JSON.stringify(crotStatus)).toContain("connected");
    });

    it("2-3. tabs: list, open, navigate, tab info - in the real browser", async () => {
      const before = await h.ok<{ tabs: TabInfo[] }>(full!.client, "browser_tabs_list");
      expect(before.tabs.length).toBeGreaterThan(0);

      const opened = await h.ok<{ tabId: number; url: string }>(full!.client, "browser_tab_open", { url: startUrl() });
      tabId = opened.tabId;
      expect(before.tabs.some((t) => t.tabId === tabId)).toBe(false);
      expect(server.requests.some((r) => r.path === "/start.html" && r.query.get("nonce") === nonce)).toBe(true);

      const startTab = await h.waitFor(
        async () => {
          const t = await findTab(full!, tabId);
          return t && t.title === "CROT E2E Start" ? t : undefined;
        },
        10_000,
        "the new tab in browser_tabs_list",
      );
      expect(startTab.url).toBe(startUrl());
      expect(startTab.active).toBe(true);

      const navigated = await h.ok<{ tabId: number; url: string }>(full!.client, "browser_navigate", {
        tabId,
        url: fixtureUrl(),
      });
      expect(navigated.tabId).toBe(tabId);
      expect(server.requests.some((r) => r.path === "/fixture.html" && r.query.get("nonce") === nonce)).toBe(true);

      // The title is set by the page's script, so it only exists in a real browser.
      const fixtureTab = await h.waitFor(
        async () => {
          const t = await findTab(full!, tabId);
          return t && t.title === `CROT E2E Fixture ${nonce}` ? t : undefined;
        },
        10_000,
        "tab info after navigation",
      );
      expect(fixtureTab.url).toBe(fixtureUrl());
      const after = await h.ok<{ tabs: TabInfo[] }>(full!.client, "browser_tabs_list");
      expect(after.tabs.length).toBe(before.tabs.length + 1);
    });

    it("4. reads the live page content back through the whole chain", async () => {
      const text = await h.ok<PageRead>(full!.client, "browser_page_read", { tabId });
      expect(text.tabId).toBe(tabId);
      expect(text.format).toBe("text");
      expect(text.url).toBe(fixtureUrl());
      expect(text.title).toBe(`CROT E2E Fixture ${nonce}`);
      expect(text.truncated).toBe(false);
      expect(text.content).toContain("CROT-E2E-STATIC-TEXT: the mole reads this page");
      // Computed by the page script in the browser; the served HTML says "pending".
      expect(text.content).toContain(`JS-RENDERED: ${reversed}`);
      expect(text.content).not.toContain("JS-RENDERED: pending");
      expect(text.content).toContain("STATUS: idle; clicks=0");

      const html = await h.ok<PageRead>(full!.client, "browser_page_read", { tabId, format: "html" });
      expect(html.format).toBe("html");
      expect(html.content).toContain('id="action-button"');
      expect(html.content).toContain(`JS-RENDERED: ${reversed}`); // live DOM, not the served source

      // Core enforces maxBytes on the browser's answer.
      const small = await h.ok<PageRead>(full!.client, "browser_page_read", { tabId, maxBytes: 16 });
      expect(small.truncated).toBe(true);
      expect(Buffer.byteLength(small.content, "utf8")).toBeLessThanOrEqual(16);
    });

    it("5. performs a real click and verifies the changed page state", async () => {
      const clicked = await h.ok<{ tabId: number; url: string }>(full!.client, "browser_click", {
        tabId,
        selector: "#action-button",
      });
      expect(clicked.tabId).toBe(tabId);

      const page = await h.ok<PageRead>(full!.client, "browser_page_read", { tabId });
      expect(page.content).toContain(`STATUS: clicked; clicks=1; nonce=${nonce}`);
      expect(page.content).not.toContain("STATUS: idle");

      // Independent witness: the page's click handler reported to the test server.
      await h.waitFor(
        async () => (clickEvents().length === 1 ? true : undefined),
        10_000,
        "the click event at the test server",
      );
      expect(clickEvents()[0]!.query.get("clicks")).toBe("1");

      // A selector that matches nothing fails and changes nothing.
      const missing = await h.fails(full!.client, "browser_click", { tabId, selector: "#does-not-exist" });
      expect(missing.code.length).toBeGreaterThan(0);
    });

    it("rejects URLs outside http:/https: (input validation) without touching the tab", async () => {
      await expect(
        h.fails(full!.client, "browser_navigate", { tabId, url: "file:///etc/hostname" }),
      ).resolves.toMatchObject({ code: "INVALID_INPUT" });
      await expect(h.fails(full!.client, "browser_tab_open", { url: "javascript:alert(1)" })).resolves.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect((await findTab(full!, tabId))?.url).toBe(fixtureUrl());
    });

    it("6. audits every browser operation (origins only, no page content or query strings)", async () => {
      const { text, records } = await h.readAudit(auditFull);
      const succeeded = new Set(records.filter((r) => r.outcome === "success").map((r) => r.operation));
      for (const op of [
        "browser.status",
        "browser.tabs_list",
        "browser.tab_open",
        "browser.navigate",
        "browser.page_read",
        "browser.click",
      ]) {
        expect(succeeded.has(op), `audit has a successful ${op}`).toBe(true);
      }
      expect(text).not.toContain(nonce);
      expect(text).not.toContain("CROT-E2E-STATIC-TEXT");
    });

    it("NEGATIVE: with browser.read only, CROT denies browser.control operations and the browser is not touched", async () => {
      await full!.close();
      full = undefined;
      readOnly = await h.startCrot(sb, await writeConfig("readonly", ["browser.read"]), auditReadOnly);
      // Same real browser: the extension reconnects to the new CROT instance through a new relay.
      await waitConnected(readOnly);
      const requestsBefore = server.requests.length;
      const tabsBefore = (await h.ok<{ tabs: TabInfo[] }>(readOnly.client, "browser_tabs_list")).tabs.length;

      await expect(
        h.fails(readOnly.client, "browser_click", { tabId, selector: "#action-button" }),
      ).resolves.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(h.fails(readOnly.client, "browser_navigate", { tabId, url: startUrl() })).resolves.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(h.fails(readOnly.client, "browser_tab_open", { url: startUrl() })).resolves.toMatchObject({
        code: "PERMISSION_DENIED",
      });

      await h.sleep(1_500);
      // Nothing happened in the browser: same state, no new click, no navigation, no new tab.
      const page = await h.ok<PageRead>(readOnly.client, "browser_page_read", { tabId });
      expect(page.url).toBe(fixtureUrl());
      expect(page.content).toContain(`STATUS: clicked; clicks=1; nonce=${nonce}`);
      expect(clickEvents().length).toBe(1);
      expect(server.requests.slice(requestsBefore).filter((r) => r.path !== "/favicon.ico")).toEqual([]);
      expect((await h.ok<{ tabs: TabInfo[] }>(readOnly.client, "browser_tabs_list")).tabs.length).toBe(tabsBefore);

      const { records } = await h.readAudit(auditReadOnly);
      for (const op of ["browser.click", "browser.navigate", "browser.tab_open"]) {
        expect(
          records.some((r) => r.operation === op && r.outcome === "denied"),
          `audit has a denied ${op}`,
        ).toBe(true);
      }
    });
  },
);

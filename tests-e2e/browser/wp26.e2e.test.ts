import { mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCrotMcpServer, localContextResolver } from "../../src/adapters/mcp/index.js";
import { BrowserBridge } from "../../src/browser-bridge/server.js";
import { CrotCore, type CoreCompositionHandle } from "../../src/core/crot-core.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import type { ApprovalTicket, PresentedApproval } from "../../src/core/approvals/types.js";
import { TestProvider } from "../../tests/approval-provider.js";
import * as h from "./harness.js";

class UI extends TestProvider {
  auto = true;
  override present(request: PresentedApproval, ticket: ApprovalTicket): void {
    super.present(request, ticket);
    if (this.auto) queueMicrotask(() => ticket.approve(request.subjectDigest));
  }
}
interface Snapshot {
  elements: { ref: string; name: string }[];
}
const content = "WP26_UPLOAD_BYTES_MUST_NOT_BE_AUDITED";

describe.runIf(process.platform === "linux")("WP-26 real MCP → guard → native bridge → Chromium files", () => {
  let sb: h.Sandbox, fixture: h.FixtureServer, chrome: h.ChromeInstance, bridge: BrowserBridge, core: CrotCore;
  let client: Client, mcp: ReturnType<typeof createCrotMcpServer>, witness: h.CdpWitness;
  let tabId: number, downloads: string, uploadRoot: string, registration: CoreCompositionHandle;
  let unregister: () => void;
  const ui = new UI(),
    audit = new MemoryAuditSink();
  const page = () => fixture.origin + "/wp26.html";
  const call = <T>(name: string, args: Record<string, unknown> = {}) => h.ok<T>(client, name, args);
  const snap = () => call<Snapshot>("browser_snapshot", { tabId });
  const fresh = async () => {
    await call("browser_navigate", { tabId, url: page() });
    return snap();
  };
  const ref = (s: Snapshot, name: string) => {
    const e = s.elements.find((e) => e.name === name);
    if (!e) throw Error("Missing fixture element: " + name);
    return e.ref;
  };
  beforeAll(async () => {
    await h.assertBuilt();
    sb = await h.createSandbox();
    fixture = await h.startFixtureServer();
    const installed = await h.installNativeHost(sb);
    const platform = await createNodePlatform({ env: sb.env, startupPath: "inherited" });
    downloads = path.join(sb.home, "Downloads");
    uploadRoot = path.join(platform.info.directories.state, "browser-files");
    await mkdir(downloads, { recursive: true });
    await mkdir(path.join(sb.profileDir, "Default"), { recursive: true });
    await writeFile(
      path.join(sb.profileDir, "Default/Preferences"),
      JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
    );
    bridge = await BrowserBridge.start({ stateDir: installed.stateDir, privateFiles: platform.privateFiles });
    await writeFile(path.join(sb.workspace, "upload.txt"), content);
    await writeFile(path.join(sb.workspace, "protected.txt"), "protected");
    core = await CrotCore.create(
      {
        workspace: { root: sb.workspace },
        environment: { path: "inherited" },
        permissions: {
          mode: "sandbox",
          capabilities: ["browser.read", "browser.control", "filesystem.read", "filesystem.write"],
          approvals: { untrustedContent: "autonomous-browser" },
        },
        browser: { enabled: true, downloadsDirectory: downloads },
      },
      {
        platform,
        browser: bridge,
        auditSink: audit,
        protectedPaths: [path.join(sb.workspace, "protected.txt")],
        composition: (c) => {
          registration = c;
          unregister = c.registerApprovalProvider(ui);
        },
      },
    );
    mcp = createCrotMcpServer(core, { resolveContext: localContextResolver("e2e") });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(a);
    client = new Client({ name: "wp26-real-e2e", version: "1" });
    await client.connect(b);
    chrome = h.launchChrome(h.chromeExecutable(), sb, { remoteDebugging: true });
    await h.waitFor(
      async () => ((await call<{ state: string }>("browser_status")).state === "connected" ? true : undefined),
      60_000,
      "browser connection",
    );
    witness = await h.watchExtensionCdp(sb);
    tabId = (await call<{ tabId: number }>("browser_tab_open", { url: page() })).tabId;
  });
  afterAll(async () => {
    witness?.close();
    await client?.close();
    await mcp?.close();
    await core?.shutdown();
    await bridge?.close();
    await chrome?.stop();
    await fixture?.close();
    if (sb && process.env.CROT_E2E_KEEP !== "1")
      await rm(sb.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  it("uploads by snapshot ref, keeps an immutable lazy-read copy, releases it on navigation", async () => {
    const s = await fresh();
    const result = await call<{ files: { name: string; size: number }[] }>("browser_file_upload", {
      tabId,
      ref: ref(s, "Upload fixture"),
      paths: ["upload.txt"],
    });
    expect(result.files).toEqual([{ name: "upload.txt", size: Buffer.byteLength(content) }]);
    expect((await readdir(uploadRoot)).length).toBeGreaterThan(0);
    await writeFile(path.join(sb.workspace, "upload.txt"), "CHANGED AFTER AUTHORIZED UPLOAD");
    await call("browser_click", { tabId, selector: "#read", waitUntil: "commit" });
    await h.waitFor(
      async () => fixture.requests.find((r) => r.path === "/event" && r.query.get("data") === content),
      10_000,
      "lazy read of original staged bytes",
    );
    await fresh();
    await h.waitFor(
      async () => ((await readdir(uploadRoot)).length === 0 ? true : undefined),
      10_000,
      "upload lifecycle cleanup",
    );
    await writeFile(path.join(sb.workspace, "upload.txt"), content);
  });
  it("answers an intercepted file chooser and permits an authorized in-workspace symlink", async () => {
    const s = await fresh();
    await symlink("upload.txt", path.join(sb.workspace, "link.txt"));
    await call("browser_click", { tabId, ref: ref(s, "Choose fixture") });
    await call("browser_file_upload", { tabId, paths: ["link.txt"] });
    await call("browser_click", { tabId, selector: "#read" });
    await fresh();
  });
  it("denies outside-workspace, protected and secret sources without handing them to Chromium", async () => {
    const s = await fresh(),
      target = ref(s, "Upload fixture");
    for (const file of [path.join(sb.base, "outside.txt"), "protected.txt", path.join(uploadRoot, "missing")]) {
      const result = await h.callTool(client, "browser_file_upload", { tabId, ref: target, paths: [file] });
      expect(result.isError).toBe(true);
      expect(result.body).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
    }
  });
  it("rejects unsafe download destinations and releases a definite invalid upload target", async () => {
    const s = await fresh();
    for (const savePath of [path.join(sb.base, "outside.bin"), "protected.txt", path.join(uploadRoot, "no.bin")]) {
      const result = await h.callTool(client, "browser_download", {
        tabId,
        url: fixture.origin + "/wp26-file",
        savePath,
      });
      expect(result.isError).toBe(true);
      expect(result.body).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
    }
    const failed = await h.callTool(client, "browser_file_upload", {
      tabId,
      ref: ref(s, "Choose fixture"),
      paths: ["upload.txt"],
    });
    expect(failed.isError).toBe(true);
    expect(failed.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(await readdir(uploadRoot)).toEqual([]);
    const multiple = await h.callTool(client, "browser_file_upload", {
      tabId,
      ref: ref(s, "Single fixture"),
      paths: ["upload.txt", "upload.txt"],
    });
    expect(multiple.isError).toBe(true);
    expect(multiple.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(await readdir(uploadRoot)).toEqual([]);
  });
  it("downloads by click and URL; atomically publishes and never overwrites by default", async () => {
    const s = await fresh();
    const output = path.join(sb.workspace, "clicked.bin");
    const pending = call<{ size: number; mimeType: string }>("browser_download", {
      tabId,
      ref: ref(s, "Download fixture"),
      savePath: "clicked.bin",
    });
    await h.sleep(100);
    await expect(readFile(output)).rejects.toThrow();
    const result = await pending;
    const expected = Buffer.from("WP26_FIXTURE_FILE_CONTENT_NOT_FOR_AUDIT\0binary");
    expect(result).toEqual({ size: expected.length, mimeType: "application/octet-stream" });
    expect(await readFile(output)).toEqual(expected);
    const duplicate = await h.callTool(client, "browser_download", {
      tabId,
      url: fixture.origin + "/wp26-file",
      savePath: "clicked.bin",
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.body).toMatchObject({ error: { code: "ALREADY_EXISTS" } });
    expect(await readFile(output)).toEqual(expected);
    await call("browser_download", { tabId, url: fixture.origin + "/wp26-redirect", savePath: "url.bin" });
    expect(await readFile(path.join(sb.workspace, "url.bin"))).toEqual(expected);
    await writeFile(path.join(sb.workspace, "url.bin"), "old");
    await call("browser_download", { tabId, url: fixture.origin + "/wp26-file", savePath: "url.bin", overwrite: true });
    expect(await readFile(path.join(sb.workspace, "url.bin"))).toEqual(expected);
  });
  it("ignores a concurrent identical-URL download in another tab", async () => {
    const s = await fresh();
    const foreign = (await call<{ tabId: number }>("browser_tab_open", { url: page(), active: false })).tabId;
    const existing = new Set((await witness.downloads()).map((item) => item.id));
    await witness.foreignDownload(foreign, fixture.origin + "/wp26-file");
    await call("browser_download", { tabId, ref: ref(s, "Download fixture"), savePath: "race.bin" });
    // Chromium may finish the unrelated disk write after our captured stream has completed.
    // Observe browser metadata only; neither wait by reading the file nor touch its lifecycle.
    let items = await witness.downloads();
    const unrelated = () =>
      items.filter(
        (i) =>
          !existing.has(i.id) &&
          i.url === fixture.origin + "/wp26-file" &&
          !i.filename.includes("CROT-private-staging"),
      );
    for (let attempt = 0; attempt < 100 && !unrelated().some((i) => i.state === "complete"); attempt++) {
      await h.sleep(50);
      items = await witness.downloads();
    }
    expect(unrelated()).toHaveLength(1);
    expect(unrelated()[0]).toMatchObject({ state: "complete" });
    expect(path.basename(unrelated()[0]!.filename)).toMatch(/^fixture(?: \(\d+\))?\.bin$/);
    expect(items.filter((i) => i.filename.includes("CROT-private-staging")).length).toBeGreaterThan(0);
    // Deliberately never open, move, cancel or read the foreign file.
    await call("browser_tab_close", { tabId: foreign });
  });
  it("leaves no workspace or staging artifact after interruption", async () => {
    await fresh();
    const result = await h.callTool(client, "browser_download", {
      tabId,
      url: fixture.origin + "/wp26-interrupted",
      savePath: "partial.bin",
      timeoutMs: 5000,
    });
    expect(result.isError).toBe(true);
    await expect(readFile(path.join(sb.workspace, "partial.bin"))).rejects.toThrow();
    expect(await readdir(path.join(downloads, "CROT-private-staging"))).toEqual([]);
  });
  it("fails closed on an unsafe native classification (fault injection on real Chromium)", async () => {
    await fresh();
    await witness.unsafeDownloadClassification(true);
    try {
      const result = await h.callTool(client, "browser_download", {
        tabId,
        url: fixture.origin + "/wp26-file",
        savePath: "danger.bin",
      });
      expect(result.isError).toBe(true);
      await expect(readFile(path.join(sb.workspace, "danger.bin"))).rejects.toThrow();
      expect(await readdir(path.join(downloads, "CROT-private-staging"))).toEqual([]);
    } finally {
      await witness.unsafeDownloadClassification(false);
    }
  });
  it("uploads and captures a download in a verified cross-site OOP frame", async () => {
    await call("browser_navigate", {
      tabId,
      url: page() + "?frame=" + encodeURIComponent(fixture.crossOrigin),
      waitUntil: "load",
    });
    const s = await h.waitFor(
      async () => {
        const current = await snap();
        return current.elements.filter((e) => e.name === "Upload fixture").length === 2 ? current : undefined;
      },
      10_000,
      "OOP frame document",
    );
    const inputs = s.elements.filter((e) => e.name === "Upload fixture");
    await call("browser_file_upload", { tabId, ref: inputs[1]!.ref, paths: ["upload.txt"] });
    const links = s.elements.filter((e) => e.name === "Download fixture");
    const result = await call<{ size: number }>("browser_download", {
      tabId,
      ref: links[1]!.ref,
      savePath: "frame.bin",
    });
    expect(result.size).toBeGreaterThan(0);
    await h.waitFor(
      async () => (fixture.requests.some((r) => r.query.get("type") === "wp26-parent-retained") ? true : undefined),
      10_000,
      "parent retaining child File",
    );
    await call("browser_click", { tabId, selector: "#replace" });
    await h.sleep(300);
    expect((await readdir(uploadRoot)).length).toBeGreaterThan(0);
    const before = fixture.requests.filter((r) => r.query.get("type") === "wp26-upload").length;
    await call("browser_click", { tabId, selector: "#read" });
    await h.waitFor(
      async () =>
        fixture.requests.filter((r) => r.query.get("type") === "wp26-upload" && r.query.get("data") === content)
          .length > before
          ? true
          : undefined,
      10_000,
      "retained File read after child document replacement",
    );
    await fresh();
    await h.waitFor(
      async () => ((await readdir(uploadRoot)).length === 0 ? true : undefined),
      10_000,
      "frame upload release",
    );
  });
  it("releases retained upload files when its tab is closed", async () => {
    const extra = (await call<{ tabId: number }>("browser_tab_open", { url: page() })).tabId;
    const s = await call<Snapshot>("browser_snapshot", { tabId: extra });
    await call("browser_file_upload", { tabId: extra, ref: ref(s, "Upload fixture"), paths: ["upload.txt"] });
    expect((await readdir(uploadRoot)).length).toBeGreaterThan(0);
    await call("browser_tab_close", { tabId: extra });
    await h.waitFor(
      async () => ((await readdir(uploadRoot)).length === 0 ? true : undefined),
      10_000,
      "tab upload release",
    );
  });
  it("AD-23.8: exposed autonomous-browser denies both real tools without provider, executes only after approval", async () => {
    const s = await fresh();
    unregister();
    const uploadArgs = { tabId, ref: ref(s, "Upload fixture"), paths: ["upload.txt"] };
    const downloadArgs = { tabId, url: fixture.origin + "/wp26-file", savePath: "approved.bin" };
    for (const [tool, args] of [
      ["browser_file_upload", uploadArgs],
      ["browser_download", downloadArgs],
    ] as const) {
      const denied = await h.callTool(client, tool, args);
      expect(denied.isError).toBe(true);
      expect(denied.body).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
    }
    unregister = registration.registerApprovalProvider(ui);
    ui.auto = false;
    for (const [tool, args] of [
      ["browser_file_upload", uploadArgs],
      ["browser_download", downloadArgs],
    ] as const) {
      const before = ui.shown.length,
        pending = call(tool, args);
      await h.waitFor(async () => (ui.shown.length > before ? true : undefined), 10_000, "real file approval request");
      let finished = false;
      void pending.then(() => {
        finished = true;
      });
      await h.sleep(100);
      expect(finished).toBe(false);
      ui.approveLast();
      await pending;
    }
    ui.auto = true;
    const records = audit.events.filter(
      (r) => r.operation === "browser.file_upload" || r.operation === "browser.download",
    );
    for (const op of ["browser.file_upload", "browser.download"]) {
      expect(records.some((r) => r.operation === op && r.outcome === "denied")).toBe(true);
      expect(records.some((r) => r.operation === op && r.outcome === "success")).toBe(true);
    }
    const text = JSON.stringify(records);
    expect(text).not.toContain(content);
    expect(text).not.toContain("WP26_FIXTURE_FILE_CONTENT_NOT_FOR_AUDIT");
    expect(text).not.toContain("CROT-private-staging");
    expect(text).not.toContain(sb.workspace);
  });
});

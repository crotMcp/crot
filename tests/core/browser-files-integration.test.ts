/** Native filesystem qualification. Intentionally NO OS runIf/skip or mocked filesystem. */
import { mkdir, writeFile, readFile, readdir, lstat, link, unlink, symlink, stat } from "node:fs/promises";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import { browserPrivateProtection } from "../../src/native-host/browser-files.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { newSession, localPrincipal, type AuthContext } from "../../src/core/auth/principal.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { CrotError } from "../../src/core/errors.js";
import type {
  BrowserConnection,
  BrowserCommand,
  BrowserCommandParams,
  BrowserConnectionState,
} from "../../src/core/capabilities/browser/connection.js";
import { createTestCore, makeTempDirs, linkDirectory, type TempDirs } from "../helpers.js";
import { TestProvider } from "../approval-provider.js";

const CONTENT = "PRIVATE_BROWSER_NATIVE_FILE_PAYLOAD";
const ORIGIN = "https://files.example.test";
class ControlledBrowser implements BrowserConnection {
  uploads: BrowserCommandParams["files.upload"][] = [];
  downloads = 0;
  constructor(readonly downloadsDirectory: string) {}
  onDownload?: (file: string) => Promise<void>;
  state(): BrowserConnectionState {
    return {
      kind: "connected",
      browser: { name: "Controlled bridge", version: "1", extensionVersion: "1" },
      connectionId: "a".repeat(32),
    };
  }
  async request(command: BrowserCommand, raw: unknown): Promise<unknown> {
    if (command === "tabs.resolve") return { tabId: 7, url: ORIGIN + "/page" };
    if (command === "page.read")
      return { tabId: 7, url: ORIGIN + "/page", title: "", format: "text", content: "untrusted", truncated: false };
    if (command === "files.upload") {
      this.uploads.push(raw as BrowserCommandParams["files.upload"]);
      return { tabId: 7 };
    }
    if (command === "files.download_release") return {};
    if (command !== "files.download") throw new Error("Unexpected test command: " + command);
    this.downloads++;
    const p = raw as BrowserCommandParams["files.download"];
    const file = path.join(this.downloadsDirectory, p.prefix, p.stem + "-file.bin");
    await writeFile(file, CONTENT, { mode: 0o600 });
    await this.onDownload?.(file);
    return {
      tabId: 7,
      originalName: "file.bin",
      size: Buffer.byteLength(CONTENT),
      mimeType: "application/octet-stream",
    };
  }
}

describe("WP-26 native Core file contour (Linux/macOS/Windows, no OS skips)", () => {
  let dirs: TempDirs,
    core: CrotCore,
    browser: ControlledBrowser,
    audit: MemoryAuditSink,
    ui: TestProvider,
    ctx: AuthContext;
  let downloads: string, uploadRoot: string, downloadRoot: string;
  const upload = (paths = ["fixture.txt"]) => core.browser.fileUpload(ctx, { tabId: 7, ref: "e1", paths });
  const download = (savePath = "result.bin", overwrite = false) =>
    core.browser.download(ctx, { tabId: 7, url: ORIGIN + "/file", savePath, overwrite });
  async function start(provider = true) {
    const platform = await createNodePlatform({
      startupPath: "inherited",
      directories: {
        state: path.join(dirs.outside, "state"),
        config: path.join(dirs.outside, "config"),
        logs: path.join(dirs.outside, "logs"),
      },
    });
    core = await createTestCore(
      {
        workspace: { root: dirs.workspace },
        browser: { enabled: true, downloadsDirectory: downloads },
        permissions: {
          mode: "sandbox",
          capabilities: ["browser.read", "browser.control", "filesystem.read", "filesystem.write"],
          approvals: { untrustedContent: "autonomous-browser" },
        },
      },
      audit,
      {
        platform,
        browser,
        protectedPaths: [path.join(dirs.workspace, "protected.txt")],
        secretPaths: [path.join(dirs.workspace, "secret.txt")],
        approvalProviders: provider ? [ui] : [],
      },
    );
  }
  beforeEach(async () => {
    dirs = await makeTempDirs();
    downloads = path.join(dirs.outside, "Downloads");
    await mkdir(downloads);
    uploadRoot = path.join(dirs.outside, "state", "browser-files");
    downloadRoot = path.join(downloads, "CROT-private-staging");
    browser = new ControlledBrowser(downloads);
    audit = new MemoryAuditSink();
    ui = new TestProvider();
    ctx = { principal: localPrincipal("native-integration"), session: newSession() };
    await writeFile(path.join(dirs.workspace, "fixture.txt"), CONTENT);
    await start();
  });
  afterEach(async () => {
    await core?.shutdown();
    await dirs?.cleanup();
  });
  async function cleanDownloads() {
    expect(await readdir(downloadRoot)).toEqual([]);
    expect(await readdir(dirs.workspace)).not.toContain("result.bin");
  }
  it("uploads a private independent copy, keeps it after source mutation, releases it on shutdown", async () => {
    const pending = upload();
    await ui.next();
    ui.approveLast();
    const r = await pending;
    const staged = browser.uploads[0]!.paths[0]!;
    expect(r.files).toEqual([{ name: "fixture.txt", size: Buffer.byteLength(CONTENT) }]);
    expect(staged).not.toBe(path.join(dirs.workspace, "fixture.txt"));
    await writeFile(path.join(dirs.workspace, "fixture.txt"), "mutated");
    expect(await readFile(staged, "utf8")).toBe(CONTENT);
    const protection = await browserPrivateProtection((await createNodePlatform()).privateFiles);
    expect((await protection.inspect(staged)).ownerOnly).toBe(true);
    if (process.platform !== "win32") expect((await stat(staged)).mode & 0o777).toBe(0o400);
    await core.shutdown();
    await expect(lstat(staged)).rejects.toThrow();
    expect(await readdir(uploadRoot)).toEqual([]);
  });
  it.each(["outside", "protected", "secret", "external-link"])(
    "guard denies upload %s before browser hand-over",
    async (kind) => {
      let source = kind + ".txt";
      if (kind === "outside") {
        source = path.join(dirs.outside, "outside.txt");
        await writeFile(source, CONTENT);
      } else if (kind === "external-link") {
        await writeFile(path.join(dirs.outside, "outside.txt"), CONTENT);
        await linkDirectory(dirs.outside, path.join(dirs.workspace, "external"));
        source = "external/outside.txt";
      } else await writeFile(path.join(dirs.workspace, source), CONTENT);
      await expect(upload([source])).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(browser.uploads).toEqual([]);
    },
  );
  it("atomically publishes exact bytes; rejects no-overwrite; permits explicit replacement", async () => {
    browser.onDownload = async () => {
      await expect(lstat(path.join(dirs.workspace, "result.bin"))).rejects.toThrow();
    };
    expect(await download()).toEqual({ size: Buffer.byteLength(CONTENT), mimeType: "application/octet-stream" });
    expect(await readFile(path.join(dirs.workspace, "result.bin"), "utf8")).toBe(CONTENT);
    browser.onDownload = undefined;
    await expect(download()).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await writeFile(path.join(dirs.workspace, "result.bin"), "old");
    await download("result.bin", true);
    expect(await readFile(path.join(dirs.workspace, "result.bin"), "utf8")).toBe(CONTENT);
    expect((await readdir(dirs.workspace)).filter((n) => n.startsWith(".crot-publish"))).toEqual([]);
    expect(await readdir(downloadRoot)).toEqual([]);
  });
  it.each(["outside", "protected", "secret", "external-link"])(
    "guard denies download %s before capture",
    async (kind) => {
      let savePath = kind + ".txt";
      if (kind === "outside") savePath = path.join(dirs.outside, "outside.bin");
      if (kind === "external-link") {
        await linkDirectory(dirs.outside, path.join(dirs.workspace, "external"));
        savePath = "external/outside.bin";
      }
      await expect(download(savePath)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(browser.downloads).toBe(0);
    },
  );
  it.each(["link", "hardlink", "size", "lease-junction"])(
    "rejects staging substitution: %s without following links or publishing bytes",
    async (kind) => {
      browser.onDownload = async (file) => {
        if (kind === "hardlink") await link(file, path.join(dirs.workspace, "other-link"));
        if (kind === "size") await writeFile(file, "short");
        if (kind === "link") {
          await unlink(file);
          if (process.platform === "win32") await linkDirectory(dirs.outside, file);
          else await symlink(path.join(dirs.workspace, "fixture.txt"), file);
        }
        if (kind === "lease-junction") {
          const { rename } = await import("node:fs/promises");
          const directory = path.dirname(file);
          await rename(directory, directory + "-old");
          await linkDirectory(directory + "-old", directory);
        }
      };
      await expect(download()).rejects.toMatchObject({ code: "OPERATION_FAILED" });
      // A moved private directory remains Core-owned and close/restart cleanup must not follow its junction.
      await expect(lstat(path.join(dirs.workspace, "result.bin"))).rejects.toThrow();
      if (kind !== "lease-junction") await cleanDownloads();
    },
  );
  it.each(["interrupted", "dangerous"])("cleans partial staging after %s bridge refusal", async (kind) => {
    browser.onDownload = async () => {
      throw new CrotError("OPERATION_FAILED", kind);
    };
    await expect(download()).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    await cleanDownloads();
  });
  it("AD-23.8: exposed autonomous-browser denies both actual service calls without a provider", async () => {
    await core.shutdown();
    await start(false);
    await core.browser.readPage(ctx, { tabId: 7 });
    await expect(upload()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(download()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(browser.uploads).toEqual([]);
    expect(browser.downloads).toBe(0);
  });
  it("AD-23.8: both exposed calls wait for matching user approval; audit has paths/sizes, never bytes", async () => {
    await core.browser.readPage(ctx, { tabId: 7 });
    const uploading = upload();
    await ui.next();
    expect(browser.uploads).toEqual([]);
    ui.approveLast();
    await uploading;
    const downloading = download();
    await ui.next();
    expect(browser.downloads).toBe(0);
    ui.approveLast();
    await downloading;
    const events = audit.events.filter(
      (e) => e.operation === "browser.file_upload" || e.operation === "browser.download",
    );
    expect(events.filter((e) => e.outcome === "success")).toHaveLength(2);
    const text = JSON.stringify(events);
    expect(text).not.toContain(CONTENT);
    expect(text).not.toContain("CROT-private-staging");
    expect(text).not.toContain(dirs.workspace);
    expect(text).toContain("fixture.txt");
    expect(text).toContain("result.bin");
    expect(text).toContain(String(Buffer.byteLength(CONTENT)));
  });
});

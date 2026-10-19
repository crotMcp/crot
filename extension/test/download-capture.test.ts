import { describe, expect, it, vi } from "vitest";
import { DownloadCapture } from "../src/download-capture.js";
import { CdpSessions } from "../src/cdp.js";
import type { ChromeDownloadItem, ChromeDownloads } from "../src/chrome-api.js";
import { FakeChrome, FakeEvent, flush } from "./fake-chrome.js";

const stem = "a1".repeat(24),
  prefix = "CROT-private-staging/123-" + stem;
function setup() {
  const fake = new FakeChrome();
  fake.addTab({ id: 1, url: "https://example.com" });
  fake.debugger.respond = (_tab, method) =>
    method === "Page.getFrameTree"
      ? { frameTree: { frame: { id: "frame", url: "https://example.com", loaderId: "loader" } } }
      : {};
  const filename = new FakeEvent<Parameters<ChromeDownloads["onDeterminingFilename"]["addListener"]>[0]>();
  const changed = new FakeEvent<Parameters<ChromeDownloads["onChanged"]["addListener"]>[0]>();
  let item: ChromeDownloadItem = {
    id: 2,
    filename: "file.bin",
    url: "https://example.com/file",
    state: "in_progress",
    danger: "safe",
    fileSize: -1,
    totalBytes: 5,
    bytesReceived: 0,
    mime: "application/octet-stream",
  };
  const downloads: ChromeDownloads = {
    onDeterminingFilename: filename,
    onChanged: changed,
    search: vi.fn(async () => [item]),
    cancel: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
  };
  const api = { ...fake.api, downloads },
    cdp = new CdpSessions(api),
    capture = new DownloadCapture(api, cdp);
  const event = (method: string, params: object) => fake.debugger.event(1, method, params);
  async function mark() {
    event("Fetch.requestPaused", {
      requestId: "request",
      frameId: "frame",
      request: { url: item.url },
      responseStatusCode: 200,
      resourceType: "Document",
      responseHeaders: [{ name: "Content-Disposition", value: 'attachment; filename="file.bin"' }],
    });
    await flush();
    const sent = fake.debugger.sent.find((s) => s.method === "Fetch.continueResponse");
    const headers = (sent?.params as { responseHeaders: { name: string; value: string }[] }).responseHeaders;
    const marked = /filename="([^"]+)"/.exec(headers.find((h) => h.name === "Content-Disposition")!.value)![1]!;
    return marked;
  }
  function begin(marked: string) {
    event("Page.downloadWillBegin", { guid: "guid", frameId: "frame", suggestedFilename: marked });
  }
  function progress(state = "completed") {
    event("Page.downloadProgress", { guid: "guid", state });
  }
  const own = (marked: string) => {
    const suggest = vi.fn();
    filename.emit({ ...item, filename: marked }, suggest);
    return suggest;
  };
  function complete(danger = "safe", state = "complete") {
    item = { ...item, state: state as ChromeDownloadItem["state"], fileSize: 5, bytesReceived: 5, danger };
    changed.emit({ id: item.id });
  }
  const run = (trigger: () => Promise<void>, timeout = 1000) =>
    capture.run(1, prefix, stem, Date.now() + timeout, 100, trigger);
  return { fake, cdp, capture, downloads, filename, changed, mark, begin, progress, own, complete, run };
}

describe("production AD-33 download capture", () => {
  it("leaves same-URL foreign items untouched and ACK cleans only the proved id", async () => {
    const s = setup();
    const foreign = vi.fn();
    const result = await s.run(async () => {
      s.filename.emit({ id: 99, filename: "file.bin", url: "https://example.com/file" } as ChromeDownloadItem, foreign);
      const marked = await s.mark();
      s.begin(marked);
      const own = s.own(marked);
      expect(own).toHaveBeenCalledWith({ filename: prefix + "/" + stem + "-file.bin", conflictAction: "uniquify" });
      s.complete();
      s.progress();
    });
    expect(result).toEqual({ tabId: 1, originalName: "file.bin", size: 5, mimeType: "application/octet-stream" });
    expect(foreign).toHaveBeenCalledWith();
    expect(s.downloads.cancel).not.toHaveBeenCalled();
    await s.capture.release("b2".repeat(24));
    expect(s.downloads.removeFile).not.toHaveBeenCalled();
    await s.capture.release(stem);
    expect(s.downloads.removeFile).toHaveBeenCalledExactlyOnceWith(2);
    expect(s.filename.listeners.size).toBe(0);
    await s.cdp.detachAll();
  });
  it("supports progress before numeric-id and filename before CDP-begin", async () => {
    const s = setup();
    await s.run(async () => {
      const marked = await s.mark();
      const held = s.own(marked);
      expect(held).not.toHaveBeenCalled();
      s.progress();
      s.complete();
      s.begin(marked);
    });
    await s.capture.release(stem);
    await s.cdp.detachAll();
  });
  it.each(["dangerous", "canceled", "interrupted"])(
    "fails closed for %s and removes only owned bytes",
    async (kind) => {
      const s = setup();
      await expect(
        s.run(async () => {
          const marked = await s.mark();
          s.begin(marked);
          s.own(marked);
          if (kind === "dangerous") s.complete("dangerous");
          else s.progress("canceled");
        }),
      ).rejects.toThrow();
      expect(s.downloads.cancel).toHaveBeenCalledExactlyOnceWith(2);
      expect(s.downloads.removeFile).toHaveBeenCalledExactlyOnceWith(2);
      await s.cdp.detachAll();
    },
  );
  it("times out without ever canceling or removing an unproved item", async () => {
    const s = setup(),
      unknown = vi.fn();
    await expect(
      s.run(async () => {
        s.filename.emit({ id: 99, filename: "foreign.bin" } as ChromeDownloadItem, unknown);
      }, 30),
    ).rejects.toThrow(/timed out/);
    expect(unknown).toHaveBeenCalledWith();
    expect(s.downloads.search).not.toHaveBeenCalled();
    expect(s.downloads.cancel).not.toHaveBeenCalled();
    expect(s.downloads.removeFile).not.toHaveBeenCalled();
    await s.cdp.detachAll();
  });
  it("does not rename or touch a marked candidate without the matching CDP frame/GUID", async () => {
    const s = setup();
    let held = vi.fn();
    await expect(
      s.run(async () => {
        held = s.own(await s.mark());
      }, 30),
    ).rejects.toThrow();
    expect(held).toHaveBeenCalledWith();
    expect(s.downloads.cancel).not.toHaveBeenCalled();
    expect(s.downloads.removeFile).not.toHaveBeenCalled();
    await s.cdp.detachAll();
  });
});

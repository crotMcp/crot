import { describe, expect, it } from "vitest";
import { CdpSessions } from "../src/cdp.js";
import { createCommandHandlers } from "../src/commands.js";
import { FakeChrome } from "./fake-chrome.js";

async function setup() {
  const fake = new FakeChrome();
  fake.addTab({ id: 1, url: "https://example.com", active: true, windowId: 1 });
  const cdp = new CdpSessions(fake.api),
    handlers = createCommandHandlers(fake.api, { cdp });
  fake.debugger.respond = (_tab, method) =>
    method === "Page.getFrameTree" ? { frameTree: { frame: { id: "frame", url: "https://example.com" } } } : {};
  await cdp.attach(1);
  const chooser = () =>
    fake.debugger.event(1, "Page.fileChooserOpened", { backendNodeId: 20, frameId: "frame", mode: "selectSingle" });
  const upload = (nonce: string) =>
    handlers["files.upload"]({
      tabId: 1,
      token: "a1".repeat(24),
      paths: ["/private/staged/file"],
      chooserNonce: nonce,
    });
  return { fake, cdp, handlers, chooser, upload };
}
describe("WP-26 chooser identity binding", () => {
  it("pins the chooser before approval and rejects a replacement without applying files", async () => {
    const s = await setup();
    s.chooser();
    const first = (await s.handlers["files.chooser"]({ tabId: 1 })) as { nonce: string; frameOrigin: string };
    expect(first.frameOrigin).toBe("https://example.com");
    s.chooser();
    await expect(s.upload(first.nonce)).rejects.toMatchObject({ code: "BROWSER_STALE_REF" });
    expect(s.fake.debugger.sent.some((c) => c.method === "DOM.setFileInputFiles")).toBe(false);
    await s.cdp.detachAll();
  });
  it("accepts only the same live chooser and does not clear a JS dialog opened by change", async () => {
    const s = await setup();
    s.chooser();
    const nonce = s.cdp.fileChooser(1)!.nonce;
    s.fake.debugger.respond = (_tab, method) => {
      if (method === "DOM.setFileInputFiles")
        s.fake.debugger.event(1, "Page.javascriptDialogOpening", { type: "alert", message: "changed" });
      return {};
    };
    await s.upload(nonce);
    expect(s.cdp.dialog(1)?.type).toBe("alert");
    await s.cdp.detachAll();
  });
  it("invalidates pending chooser identity when its document is replaced", async () => {
    const s = await setup();
    s.chooser();
    const nonce = s.cdp.fileChooser(1)!.nonce;
    s.fake.debugger.event(1, "Page.frameNavigated", { frame: { id: "frame" } });
    await expect(s.upload(nonce)).rejects.toMatchObject({ code: "BROWSER_STALE_REF" });
    expect(s.fake.debugger.sent.some((c) => c.method === "DOM.setFileInputFiles")).toBe(false);
    await s.cdp.detachAll();
  });
});

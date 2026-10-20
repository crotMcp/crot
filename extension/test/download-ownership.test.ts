import { describe, expect, it } from "vitest";
import { DownloadOwnership, markedDisposition } from "../src/download-ownership.js";

const token = "a1".repeat(24);
const create = () => new DownloadOwnership(() => token);

describe("AD-33 exact response capability", () => {
  it("never chooses an unrelated same-URL/same-name item, even when it arrives first", () => {
    const ledger = create();
    const { response } = ledger.mark("target-frame", undefined, "request", 'attachment; filename="same.exe"');
    expect(ledger.item(1, "same.exe")).toBe("unrelated");
    expect(ledger.proved()).toBeUndefined();
    expect(ledger.begin("target-frame", undefined, "guid", response.filename)).toBe(true);
    expect(ledger.item(1, "same.exe")).toBe("unrelated");
    expect(ledger.item(2, response.filename)).toBe("owned");
    expect(ledger.proved()?.downloadId).toBe(2);
  });

  it("holds a marked item until its exact CDP frame/GUID event, independent of event order", () => {
    const ledger = create();
    const { response } = ledger.mark("oop-frame", "child-session", "request", 'attachment; filename="video.mp4"');
    expect(ledger.item(20, response.filename)).toBe("pending");
    expect(ledger.proved()).toBeUndefined();
    expect(ledger.begin("oop-frame", "child-session", "guid", response.filename)).toBe(true);
    expect(ledger.proved()?.downloadId).toBe(20);
  });

  it("invalidates rather than accepts a capability coming from another frame/session", () => {
    const ledger = create();
    const { response } = ledger.mark("frame", "child", "request", 'attachment; filename="file.bin"');
    expect(() => ledger.begin("frame", undefined, "guid", response.filename)).toThrow(/mismatch/);
    expect(() => ledger.proved()).toThrow(/invalidated/);
  });

  it("rejects capability reuse across ids and multiple responses", () => {
    const ledger = create();
    const { response } = ledger.mark("frame", undefined, "request", 'attachment; filename="same.bin"');
    ledger.item(1, response.filename);
    expect(() => ledger.item(2, response.filename)).toThrow(/Reused/);
    const another = create();
    another.mark("frame", undefined, "one", 'attachment; filename="same.bin"');
    expect(() => another.mark("frame", undefined, "two", 'attachment; filename="same.bin"')).toThrow(/More than one/);
  });

  it.each(["setup.exe", "document.pdf.exe", "shortcut.lnk", "video.mp4", "archive.tar.gz"])(
    "preserves the complete original filename and dangerous suffix: %s",
    (original) => {
      const result = markedDisposition('attachment; filename="' + original + '"', token);
      expect(result.name.endsWith("-" + original)).toBe(true);
      expect(result.original).toBe(original);
    },
  );

  it.each([
    "attachment; filename*=UTF-8''setup.exe",
    "attachment; filename=\"safe.txt\"; filename*=UTF-8''setup.exe",
    'attachment; filename="../setup.exe"',
    'attachment; filename="setup.exe "',
    'attachment; filename="setup.exe."',
    'attachment; filename="a.txt"; filename="b.exe"',
    'attachment; filename="a\r\nX-Test: bad"',
  ])("fails closed instead of inventing a benign extension for %s", (header) => {
    expect(() => markedDisposition(header, token)).toThrow();
  });
});

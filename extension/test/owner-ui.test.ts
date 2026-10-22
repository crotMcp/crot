import { describe, expect, it } from "vitest";
import { ownerUiAction } from "../src/owner-ui.js";
const origin = "chrome-extension://test-extension/";
describe("extension owner UI boundary", () => {
  it("accepts only the packaged popup/welcome, including the local installation anchor", () => {
    for (const path of ["popup.html", "welcome.html", "welcome.html#install"]) {
      expect(ownerUiAction({ type: "crot.ui.status" }, origin + path, origin)).toBe("status");
      expect(ownerUiAction({ type: "crot.ui.openApp" }, origin + path, origin)).toBe("open");
    }
  });
  it("rejects web content, unrelated extension pages and missing sender metadata", () => {
    for (const url of [
      undefined,
      "https://example.com/popup.html",
      "chrome-extension://other/popup.html",
      origin + "other.html",
      origin + "popup.html?untrusted=1",
    ])
      expect(ownerUiAction({ type: "crot.ui.openApp" }, url, origin)).toBeUndefined();
    expect(ownerUiAction({ type: "crot.ui.openApp" }, origin + "popup.html", undefined)).toBeUndefined();
  });
  it("does not accept arguments, arbitrary methods, arrays or malformed messages", () => {
    for (const message of [
      null,
      [],
      {},
      "crot.ui.openApp",
      { type: "eval" },
      { type: "crot.ui.openApp", command: "anything" },
      { type: "crot.ui.openApp", url: "https://example.com" },
    ])
      expect(ownerUiAction(message, origin + "popup.html", origin)).toBeUndefined();
  });
});

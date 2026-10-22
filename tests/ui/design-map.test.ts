import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CROT_CSS } from "../../src/ui/theme.js";
import { UI_MESSAGES_JSON, I18N_SCRIPT } from "../../src/ui/i18n.js";
import { TRAY_ASSETS, TRAY_CSP } from "../../src/tray/assets.js";
import { LANDING_HTML, PORTAL_HTML } from "../../src/account-service/portal.js";
import { parseBrowserMessage, parseHostMessage } from "../../src/browser-bridge/protocol.js";

describe("strict product UI contract", () => {
  it("uses the curator's Zinc tokens and compact component geometry", () => {
    for (const token of [
      "--bg-app:#09090B",
      "--bg-card:#121215",
      "--bg-elevated:#18181B",
      "--border-subtle:#27272A",
      "--text-primary:#FAFAFA",
      "--text-secondary:#A1A1AA",
      "--text-muted:#71717A",
      "--accent-primary:#6366F1",
    ])
      expect(CROT_CSS).toContain(token);
    expect(CROT_CSS).toContain("height:32px");
    expect(CROT_CSS).toContain("height:36px");
    expect(CROT_CSS).toContain("font-size:32px");
    expect(CROT_CSS).not.toContain("clamp(");
  });
  it("ships one offline, complete five-language dictionary, not extension-only copies", () => {
    const messages = JSON.parse(UI_MESSAGES_JSON) as Record<string, string[]>;
    expect(Object.keys(messages).length).toBeGreaterThan(200);
    for (const [source, values] of Object.entries(messages)) {
      expect(values).toHaveLength(5);
      expect(values[0]).toBe(source);
      for (const value of values) expect(value.length).toBeGreaterThan(0);
    }
    expect(I18N_SCRIPT).toContain("navigator.language");
    expect(I18N_SCRIPT).toContain("localStorage");
    expect(TRAY_ASSETS["/i18n.js"]?.body).toBe(I18N_SCRIPT);
    expect(LANDING_HTML).toContain('src="/i18n.js"');
    expect(PORTAL_HTML).toContain('src="/i18n.js"');
    expect(TRAY_CSP).not.toMatch(/unsafe-inline|unsafe-eval|https:/);
  });
  it("reserves popup dimensions before any script and ships a real static shell", async () => {
    const html = await readFile("extension/popup.html", "utf8");
    const css = (await readFile("extension/popup-geometry.css", "utf8")).replace(/\s/g, "");
    expect(html.indexOf("popup-geometry.css")).toBeLessThan(html.indexOf("ui.css"));
    for (const value of [
      "width:380px",
      "min-width:380px",
      "max-width:380px",
      "height:520px",
      "min-height:520px",
      "background-color:#09090B",
    ])
      expect(css.replace(/\s/g, "").toLowerCase()).toContain(value.toLowerCase());
    expect(html).toContain('id="connection"');
    expect(html).toContain('id="open-app"');
    expect(html).not.toMatch(/href="\/(portal|download)/);
  });
  it("does not accept any command/path/URL in the new owner-UI bridge message", () => {
    expect(parseBrowserMessage({ type: "ui_open", id: "ui_1" })).toEqual({ type: "ui_open", id: "ui_1" });
    for (const field of ["command", "url", "path", "params"])
      expect(() => parseBrowserMessage({ type: "ui_open", id: "ui_1", [field]: "untrusted" })).toThrow();
    expect(() => parseBrowserMessage({ type: "ui_open", id: "bad id" })).toThrow();
    expect(parseHostMessage({ type: "ui_result", id: "ui_1", ok: false })).toEqual({
      type: "ui_result",
      id: "ui_1",
      ok: false,
    });
    expect(() => parseHostMessage({ type: "ui_result", id: "ui_1", ok: true, url: "https://evil.example" })).toThrow();
  });
});

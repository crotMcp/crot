import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { TRAY_ASSETS, TRAY_CSP } from "../../src/tray/assets.js";
import { DESIGN_TOKENS_CSS, LOCAL_FONTS_CSS } from "../../src/ui/design-assets.js";
import { MOLE_SVG, MOLE_DARK_SVG, WORDMARK_SVG } from "../../src/ui/mascot.js";
import { UI_ICONS } from "../../src/ui/lucide-icons.js";
import { THEME_BOOTSTRAP } from "../../src/ui/theme-bootstrap.js";
import { PRIMARY_SECTIONS } from "../../src/tray/product.js";

describe("AD-42 owner design system", () => {
  it("has exact owner tokens and offline Latin/Cyrillic variable fonts", () => {
    for (const value of ["#FFC21A", "#1B2236", "#F6F8FC", "#0B1020", "240px", "44px"])
      expect(DESIGN_TOKENS_CSS.toLowerCase()).toContain(value.toLowerCase());
    expect(LOCAL_FONTS_CSS).toContain("Inter Variable");
    expect(LOCAL_FONTS_CSS).toContain("JetBrains Mono Variable");
    expect(LOCAL_FONTS_CSS).toContain("U+0400-045F");
    expect(LOCAL_FONTS_CSS.match(/data:font\/woff2;base64/g)).toHaveLength(8);
    expect(LOCAL_FONTS_CSS).not.toMatch(/https?:|fonts\.google/);
  });
  it("loads theme synchronously before CSS without renderer network or inline code", () => {
    const html = TRAY_ASSETS["/index.html"]!.body;
    expect(html.indexOf("theme.js")).toBeLessThan(html.indexOf("stylesheet"));
    expect(THEME_BOOTSTRAP).toContain("media.addEventListener('change', apply)");
    expect(THEME_BOOTSTRAP).toContain("'system'");
    expect(TRAY_CSP).toContain("font-src data:");
    expect(TRAY_CSP).toContain("connect-src 'none'");
    expect(TRAY_CSP).not.toMatch(/unsafe-inline|unsafe-eval|https:/);
  });
  it("uses actual Lucide nodes for every primary destination", () => {
    for (const section of PRIMARY_SECTIONS) expect(UI_ICONS[section].length).toBeGreaterThan(0);
    expect(TRAY_ASSETS["/renderer.js"]!.body).toContain("'stroke-width':'1.75'");
    expect(TRAY_ASSETS["/renderer.js"]!.body).not.toContain("PRODUCT.brands.github");
  });
  it("derives raster formats and dark/mono variants from one flat master", () => {
    expect(MOLE_SVG).toContain("#FFC21A");
    expect(MOLE_SVG).not.toMatch(/gradient|filter|shadow/i);
    expect(MOLE_DARK_SVG).toContain("#F6F8FC");
    expect(WORDMARK_SVG).not.toContain("<text");
    const icns = readFileSync("assets/brand/desktop/crot.icns");
    expect(icns.subarray(0, 4).toString()).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const ico = readFileSync("assets/brand/desktop/crot.ico");
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(4);
    for (const size of [16, 22, 32]) {
      const png = readFileSync(`assets/brand/tray/${size}.png`);
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
  });
  it("keeps padding transparent in tray and extension PNG exports", async () => {
    for (const file of [
      "assets/brand/extension/icon128.png",
      "assets/brand/tray/32.png",
      "assets/brand/tray/32-on-dark.png",
    ]) {
      const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(4);
      expect(data[3]).toBe(0);
      expect(data[(info.width * info.height - 1) * 4 + 3]).toBe(0);
    }
  });
  it("routes real chat through owner IPC, keeps tools opt-in and renders untrusted output as text", () => {
    const code = TRAY_ASSETS["/renderer.js"]!.body;
    for (const method of ["chat.providers", "chat.configure", "chat.models", "chat.start", "chat.poll", "chat.stop"])
      expect(code).toContain(`rpc('${method}'`);
    expect(code).toContain("enabled.filter(f=>f.input.checked)");
    expect(code).toContain("part.append(pre(b.text))");
    expect(code).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket\(/);
    expect(code).not.toMatch(/innerHTML|insertAdjacentHTML/);
  });
});

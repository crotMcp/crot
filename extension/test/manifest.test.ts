import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectBrowser } from "../src/browser-info.js";

const read = (relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as Record<string, unknown>;

const manifest = read("../manifest.json");

/**
 * Extension id Chromium derives from the manifest key: the first 128 bits of
 * SHA-256 over the DER public key, one letter a-p per hex digit. The host
 * manifest written by `crot-mcp browser install` allows only this origin.
 */
const CROT_EXTENSION_ID = "bllcepanlhojbddfbbpegmnokpaakool";

function extensionId(key: string): string {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

describe("extension manifest", () => {
  it("is a Manifest V3 extension with a module service worker", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: "dist/extension/src/background.js", type: "module" });
    expect(manifest.incognito).toBe("not_allowed");
  });

  it("has the package's version", () => {
    expect(manifest.version).toBe(read("../../package.json").version);
  });

  it("has a fixed key, so the extension id is stable", () => {
    expect(typeof manifest.key).toBe("string");
    expect(extensionId(manifest.key as string)).toBe(CROT_EXTENSION_ID);
  });

  it("requests only the permissions the commands need", () => {
    expect(manifest.permissions).toEqual([
      "nativeMessaging",
      "tabs",
      "scripting",
      "alarms",
      "debugger",
      "tabGroups",
      "downloads",
    ]);
    // downloads is used only by the exact-owned WP-26 capture.
    // Scripting and captureVisibleTab need host access; the extension itself refuses non-http(s) pages.
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
    for (const key of [
      "content_scripts",
      "externally_connectable",
      "web_accessible_resources",
      "optional_permissions",
    ]) {
      expect(key in manifest).toBe(false);
    }
  });

  it("pins a first-party-only extension page CSP instead of forbidding an explicit policy", () => {
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'",
    });
  });

  it("ships a local action popup and icons without inline or remote scripts", () => {
    const icons = {
      "16": "icons/icon16.png",
      "32": "icons/icon32.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png",
    };
    expect(manifest.action).toEqual({
      default_title: "CROT Control Center",
      default_popup: "popup.html",
      default_icon: icons,
    });
    expect(manifest.icons).toEqual(icons);
    const popup = readFileSync(new URL("../popup.html", import.meta.url), "utf8");
    const welcome = readFileSync(new URL("../welcome.html", import.meta.url), "utf8");
    expect(popup).toMatch(/<script src="popup\.js" defer><\/script>/);
    for (const page of [popup, welcome]) {
      const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      for (const [, attributes, body] of scripts) {
        expect(attributes).toMatch(/\bsrc="[A-Za-z0-9_-]+\.js"/);
        expect(body?.trim()).toBe("");
      }
      expect(page).not.toMatch(/\son[a-z]+\s*=/i);
    }
    for (const [size, file] of Object.entries(icons)) {
      const png = readFileSync(new URL("../" + file, import.meta.url));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(Number(size));
      expect(png.readUInt32BE(20)).toBe(Number(size));
    }
  });
});

describe("detectBrowser", () => {
  const chromeUa =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36";

  it("identifies Chrome, Edge, Brave and other Chromium browsers", () => {
    const brands = (...names: string[]) => ({ brands: names.map((brand) => ({ brand, version: "130" })) });
    expect(detectBrowser({ userAgent: chromeUa, userAgentData: brands("Chromium", "Google Chrome") }, "0.1.0")).toEqual(
      {
        name: "Google Chrome",
        version: "130.0.6723.92",
        extensionVersion: "0.1.0",
      },
    );
    expect(
      detectBrowser(
        { userAgent: chromeUa + " Edg/130.0.2849.68", userAgentData: brands("Chromium", "Microsoft Edge") },
        "0.1.0",
      ).name,
    ).toBe("Microsoft Edge");
    expect(detectBrowser({ userAgent: chromeUa + " Edg/130.0.2849.68" }, "0.1.0").version).toBe("130.0.2849.68");
    expect(detectBrowser({ userAgent: chromeUa, userAgentData: brands("Chromium", "Brave") }, "0.1.0").name).toBe(
      "Brave",
    );
    expect(detectBrowser({ userAgent: chromeUa, brave: {} }, "0.1.0").name).toBe("Brave");
    expect(detectBrowser({ userAgent: chromeUa, userAgentData: brands("Chromium") }, "0.1.0").name).toBe("Chromium");
  });

  it("always produces valid hello fields", () => {
    const info = detectBrowser({ userAgent: "" }, "x".repeat(500));
    expect(info).toEqual({ name: "Chromium", version: "unknown", extensionVersion: "x".repeat(200) });
  });
});

import { MAX_BROWSER_INFO_LENGTH, type BrowserInfoMessage } from "../../src/browser-bridge/protocol.js";

/** What the extension can learn about the browser it runs in (the service worker's navigator). */
export interface NavigatorLike {
  readonly userAgent: string;
  readonly userAgentData?: { readonly brands?: ReadonlyArray<{ readonly brand: string; readonly version: string }> };
  /** Present in Brave only. */
  readonly brave?: unknown;
}

const bounded = (text: string): string => text.slice(0, MAX_BROWSER_INFO_LENGTH) || "unknown";

/** Browser name and version for the hello message: Brave, Microsoft Edge, Google Chrome or Chromium. */
export function detectBrowser(nav: NavigatorLike, extensionVersion: string): BrowserInfoMessage {
  const brands = nav.userAgentData?.brands ?? [];
  const brand = (name: string) => brands.find((b) => b.brand === name);
  const ua = (token: string) => new RegExp(token + "/([0-9][0-9.]*)").exec(nav.userAgent)?.[1];

  let name: string;
  let version: string | undefined;
  if (nav.brave !== undefined || brand("Brave")) {
    name = "Brave";
    version = ua("Chrome") ?? brand("Brave")?.version;
  } else if (brand("Microsoft Edge") || ua("Edg")) {
    name = "Microsoft Edge";
    version = ua("Edg") ?? brand("Microsoft Edge")?.version;
  } else if (brand("Google Chrome")) {
    name = "Google Chrome";
    version = ua("Chrome") ?? brand("Google Chrome")?.version;
  } else {
    name = "Chromium";
    version = ua("Chrome") ?? brand("Chromium")?.version;
  }
  return { name, version: bounded(version ?? ""), extensionVersion: bounded(extensionVersion) };
}

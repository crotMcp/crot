import { DESIGN_TOKENS_CSS, LOCAL_FONTS_CSS } from "../ui/design-assets.js";
import { THEME_BOOTSTRAP } from "../ui/theme-bootstrap.js";
import { DESIGN_SYSTEM_CSS } from "./design-system-style.js";
import { WELCOME_HTML, WELCOME_CSS } from "./control-center-welcome.js";
import { mascotData } from "../ui/mascot.js";
import { I18N_SCRIPT } from "../ui/i18n.js";
import { CONTROL_CENTER_CSS } from "./control-center-style.js";
import { CONTROL_CENTER_RENDERER } from "./control-center-renderer.js";
export const TRAY_ORIGIN = "crot-tray://app";
/** No network, Node, inline scripts or remote markup. Screenshots are validated MCP image data. */
export const TRAY_CSP = [
  "default-src 'none'",
  `script-src ${TRAY_ORIGIN}`,
  `style-src ${TRAY_ORIGIN}`,
  "img-src data:",
  "connect-src 'none'",
  "font-src data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${TRAY_CSP}"><script src="crot-tray://app/theme.js"></script><title>CROT Control Center</title><link rel="stylesheet" href="${TRAY_ORIGIN}/app.css"><script src="${TRAY_ORIGIN}/i18n.js" defer></script><script src="${TRAY_ORIGIN}/renderer.js" defer></script></head><body>
${WELCOME_HTML}
<div id="app" class="app-shell" hidden><nav id="navigation" class="sidebar" aria-label="Control Center"><div class="brand"><img class="brand-mark" src="${mascotData()}" alt=""><div>CROT<small>CONTROL CENTER</small></div></div></nav><header class="topbar"><div class="actions"><button id="menu-toggle" class="mobile-menu" aria-label="Open navigation"></button><select id="project-select" class="project-switch" aria-label="Active project"></select></div><label class="search-box"><span class="sr-only">Search</span><input id="global-search" type="search" aria-label="Search projects, agents, connectors" placeholder="Search projects, agents, connectors..."></label><div class="actions"><div id="service-indicators" class="actions service-indicators"></div><button id="notifications" aria-label="Notifications"><span id="notification-count" class="notifications-count">0</span></button><span class="avatar" aria-hidden="true">○</span><button id="plan-badge">Free (Local)</button><span id="top-language"></span></div></header><main class="content"><p id="notice" role="status" aria-live="polite" class="feedback"></p><div id="page"></div><span id="headline" hidden>CROT Control Center</span></main></div><dialog id="action-dialog" aria-label="Action details"></dialog></body></html>`;
const CSS = LOCAL_FONTS_CSS + CONTROL_CENTER_CSS + WELCOME_CSS + DESIGN_TOKENS_CSS + DESIGN_SYSTEM_CSS;
const RENDERER = CONTROL_CENTER_RENDERER;
export interface TrayAsset {
  readonly body: string;
  readonly type: string;
}

export const TRAY_ASSETS: Readonly<Record<string, TrayAsset>> = {
  "/theme.js": { body: THEME_BOOTSTRAP, type: "text/javascript; charset=utf-8" },
  "/index.html": { body: HTML, type: "text/html; charset=utf-8" },
  "/app.css": { body: CSS, type: "text/css; charset=utf-8" },
  "/i18n.js": { body: I18N_SCRIPT, type: "text/javascript; charset=utf-8" },
  "/renderer.js": { body: RENDERER, type: "text/javascript; charset=utf-8" },
};

/** The asset for a tray URL, or undefined for anything else (other hosts, queries, unknown paths). */
export function trayAsset(url: string): TrayAsset | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "crot-tray:" || parsed.host !== "app" || parsed.search || parsed.username) return undefined;
  return Object.hasOwn(TRAY_ASSETS, parsed.pathname) ? TRAY_ASSETS[parsed.pathname] : undefined;
}

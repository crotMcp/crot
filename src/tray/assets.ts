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
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${TRAY_CSP}"><title>CROT Control Center</title><link rel="stylesheet" href="${TRAY_ORIGIN}/app.css"><script src="${TRAY_ORIGIN}/i18n.js" defer></script><script src="${TRAY_ORIGIN}/renderer.js" defer></script></head><body>
<section id="auth-gate" class="auth-screen" aria-labelledby="auth-title"><header id="auth-language" class="auth-header"></header><div class="auth-card"><h1 id="auth-title">CROT</h1><p class="subtitle">Control Center</p><p class="description">Secure control for your local and remote agents.</p><form id="auth-form"><label class="field"><span>Work email</span><input id="work-email" type="email" autocomplete="email" placeholder="Enter your work email" required></label><button class="primary" type="submit">Create account</button></form><p class="account-line"><span>Already have an account?</span><button id="login" class="link">Log in</button></p><div class="divider">or</div><button id="google" class="oauth">Continue with Google</button><button id="github" class="oauth">Continue with GitHub</button><button id="local-mode" class="link local">Continue without an account</button><p id="auth-feedback" class="auth-feedback" role="status"></p></div></section>
<div id="app" class="app-shell" hidden><nav id="navigation" class="sidebar" aria-label="Control Center"><div class="brand"><span class="brand-mark" aria-hidden="true">C</span><div>CROT<small>CONTROL CENTER</small></div></div></nav><header class="topbar"><div class="actions"><button id="menu-toggle" class="mobile-menu" aria-label="Open navigation"></button><select id="project-select" class="project-switch" aria-label="Active project"></select></div><div class="actions"><div id="service-indicators" class="actions service-indicators"></div><button id="notifications" aria-label="Notifications"><span id="notification-count" class="notifications-count">0</span></button><button id="plan-badge">Free (Local)</button><span id="top-language"></span></div></header><main class="content"><p id="notice" role="status" aria-live="polite" class="feedback"></p><div id="page"></div><span id="headline" hidden>CROT Control Center</span></main></div><dialog id="action-dialog" aria-label="Action details"></dialog></body></html>`;
const CSS = CONTROL_CENTER_CSS;
const RENDERER = CONTROL_CENTER_RENDERER;
export interface TrayAsset {
  readonly body: string;
  readonly type: string;
}

export const TRAY_ASSETS: Readonly<Record<string, TrayAsset>> = {
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

import { I18N_SCRIPT } from "../ui/i18n.js";
import { CAPABILITIES, CROT_CSS } from "../ui/theme.js";

/**
 * The tray window's page, served from memory on the privileged
 * `crot-tray://app/` scheme (AD-19 point 1). No remote content, no inline
 * script, no HTML from data: the renderer builds the page with
 * `textContent` only, so nothing from an approval subject or the service can
 * become markup, a link or script.
 */

export const TRAY_ORIGIN = "crot-tray://app";

/** Strict CSP for every tray response: only this origin's script and style, nothing else. */
export const TRAY_CSP = [
  "default-src 'none'",
  `script-src ${TRAY_ORIGIN}`,
  `style-src ${TRAY_ORIGIN}`,
  "img-src 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${TRAY_CSP}"><title>CROT Control Center</title>
<link rel="stylesheet" href="${TRAY_ORIGIN}/app.css"><script src="${TRAY_ORIGIN}/i18n.js" defer></script><script src="${TRAY_ORIGIN}/renderer.js" defer></script></head>
<body><header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">C</span>CROT <span class="muted">/ Control Center</span></div><div class="actions"><span id="connection" class="badge">Connecting</span><button id="plan-badge" aria-label="Account and plan">FREE · LOCAL</button></div></header>
<div class="shell"><nav class="sidebar" role="tablist" aria-label="Control Center"><button id="tab-dashboard" role="tab" aria-controls="dashboard" aria-selected="true">Overview & control</button><button id="tab-capabilities" role="tab" aria-controls="capabilities" aria-selected="false" tabindex="-1">Capabilities & studio</button><button id="tab-queue" role="tab" aria-controls="queue" aria-selected="false" tabindex="-1">Approvals <span id="queue-count" class="badge">0</span></button><button id="tab-account" role="tab" aria-controls="account" aria-selected="false" tabindex="-1">Account & plan</button><p class="note">Your computer. Your rules.<br>Local tools are always free.</p></nav>
<main class="content"><div class="intro"><p class="eyebrow">Your AI, securely connected</p><h1 id="headline">CROT Control Center</h1><p class="muted">One place to manage your computer, browser and agent permissions.</p><p id="notice" role="status" hidden></p></div>
<section id="dashboard" role="tabpanel" aria-labelledby="tab-dashboard"><section class="panel quick-start"><h2>Quick start in 3 steps</h2>
<h3>1. Project workspace</h3><code id="workspace" data-no-i18n>—</code><div class="actions"><button id="open-workspace">Open folder</button><button id="copy-config">Copy Claude / Cursor config</button></div>
<h3>2. Protection &amp; browser</h3><p id="quick-protection" class="note"></p>
<h3>3. Cloud access &amp; plan</h3><div class="actions"><button id="quick-pair">Pair this device</button><button id="quick-copy">Copy MCP connection link</button></div><p id="quick-feedback" role="status" aria-live="polite"></p></section><div id="modules" class="grid"></div><section class="panel" aria-label="Approval preset"><h2>Security & approvals</h2><p class="muted">Control approval-gated effects. Capability and workspace restrictions always apply.</p><div id="presets"></div><p id="preset-blocked" class="banner" hidden></p></section><section class="panel" aria-label="Remote"><h2>Remote access</h2><p class="muted">Connect trusted MCP clients through the cloud relay. Local tools do not need a subscription.</p><div id="remote" class="actions"></div><div id="remote-summary"></div><div id="clients"></div></section></section>
<section id="capabilities" role="tabpanel" aria-labelledby="tab-capabilities" hidden><h2>Capabilities & Studio Hub</h2><p class="muted">A single permission engine across your workspace. Upcoming integrations are labeled Roadmap.</p><div id="capability-grid" class="grid"></div></section>
<section id="queue" role="tabpanel" aria-labelledby="tab-queue" hidden><h2>Approvals queue</h2><p class="muted">Review the complete operation and its effects before allowing an agent to continue.</p><p id="approval-empty" class="empty">All clear. No requests need your approval.</p><div id="approvals" aria-label="Approval requests"></div></section>
<section id="account" role="tabpanel" aria-labelledby="tab-account" hidden><section class="panel"><p class="eyebrow">Account & plan</p><h2 id="account-plan">Free local access</h2><p id="account-status" class="muted">Full local functionality. No account or card required.</p><p id="device-count"></p><div class="actions"><button id="sign-in">Sign in / create account</button><button id="trial" class="primary">Try 7 days free</button><button id="upgrade">Choose Pro / Team</button></div><p class="note">Trial requires a card in hosted Stripe Checkout. Remote access for up to 2 devices. Cancel before the trial ends to avoid a subscription charge. Billing availability depends on the operator.</p></section></section>
<details class="diagnostics"><summary>Developer Diagnostics</summary><button id="copy-diagnostics">Copy diagnostics</button><p id="copy-notice" role="status"></p><dl id="status"></dl><div id="technical-notes"></div></details>
</main></div><dialog id="paywall" aria-labelledby="paywall-title" aria-describedby="paywall-copy"><p class="eyebrow">Unlock remote access</p><h2 id="paywall-title">Your workspace, wherever you are.</h2><p id="paywall-copy">This feature requires Pro or Trial. Start a 7-day trial after adding a card, or choose a paid plan to control your computer and browser remotely.</p><p class="muted">Your local tools remain free. Trial includes up to 2 devices. You can cancel from your account.</p><div class="actions"><button id="paywall-checkout" class="primary">View trial & plans</button><button id="paywall-close">Stay local</button></div></dialog></body></html>
`;

const CSS =
  CROT_CSS +
  `#modules{margin-bottom:12px}.module .badge{align-self:flex-start}#capability-grid{margin-top:12px}.quick-start h3:not(:first-of-type){margin-top:16px}`;

/**
 * The renderer: receives a TrayView (plain strings) and builds the page with
 * createElement/textContent only. It never sees a subject digest — the main
 * process decides with the digest it presented (AD-19 point 4).
 */
const RENDERER = `"use strict";
(() => {
  const api = window.crot;
  const text = (id, value) => {
    const node = document.getElementById(id), source = String(value);
    if (window.CrotI18n) window.CrotI18n.setText(node, source);
    else if (node.textContent !== source) node.textContent = source;
  };
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const rendered = new Map();
  const changed = (key, value) => { const next = JSON.stringify(value); if (rendered.get(key) === next) return false; rendered.set(key, next); return true; };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const button = (text, onClick, disabled) => {
    const b = el("button", text);
    b.type = "button";
    b.disabled = !!disabled;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await onClick(); } finally { if (b.isConnected) b.disabled = !!disabled; }
    });
    return b;
  };
  const rows = (dl, list) => {
    for (const r of list) {
      dl.appendChild(el("dt", r.label));
      const dd = el("dd", r.value);
      for (const m of r.marks) dd.appendChild(el("span", m, "mark " + m.replace(/[^a-z]+/g, "-")));
      if (r.length > 200) dd.appendChild(el("span", r.length + " characters, shown in full", "mark"));
      dl.appendChild(dd);
    }
  };
  const tabs = ["dashboard", "capabilities", "queue", "account"];
  function selectTab(id, focus) {
    for (const key of tabs) {
      const tab = document.getElementById("tab-" + key);
      tab.setAttribute("aria-selected", String(key === id)); tab.tabIndex = key === id ? 0 : -1;
      document.getElementById(key).hidden = key !== id;
      if (key === id && focus) tab.focus();
    }
  }
  for (const [index, key] of tabs.entries()) {
    const tab = document.getElementById("tab-" + key);
    tab.addEventListener("click", () => selectTab(key));
    tab.addEventListener("keydown", e => {
      const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (index + 1) % tabs.length : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (index + tabs.length - 1) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
      if (next >= 0) { e.preventDefault(); selectTab(tabs[next], true); }
    });
  }
  document.getElementById("plan-badge").onclick = () => selectTab("account");
  const dialog = document.getElementById("paywall");
  let returnFocus, firstConnected = true;
  const paywall = () => { returnFocus = document.activeElement; if (!dialog.open) dialog.showModal(); document.getElementById("paywall-checkout").focus(); };
  dialog.addEventListener("close", () => returnFocus?.focus());
  document.getElementById("paywall-close").onclick = () => dialog.close();
  const portal = () => api.action("ui.openPortal", {});
  for (const id of ["sign-in", "trial", "upgrade", "paywall-checkout"]) document.getElementById(id).onclick = portal;
  document.getElementById("copy-diagnostics").onclick = async () => {
    const ok = await api.action("ui.copyDiagnostics", {});
    text("copy-notice", ok ? "Copied to clipboard." : "Copy unavailable. Try again.");
  };
  const iconPaths = {
    files: "M4 4h7l2 3h7v13H4z M8 12h8 M8 16h5",
    terminal: "M4 5h16v14H4z M7 9l3 3-3 3 M13 15h4",
    browser: "M3 4h18v16H3z M3 9h18 M6 6h1 M9 6h1 M12 6h1",
    container: "M12 3l9 5v9l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v9",
    video: "M3 6h13v12H3z M16 10l5-3v10l-5-3",
    audio: "M9 4h6v10H9z M5 11v2a7 7 0 0014 0v-2 M12 20v2 M8 22h8",
    publish: "M12 16V3 M7 8l5-5 5 5 M4 14v7h16v-7",
    shield: "M12 3l8 3v6c0 5-8 10-8 10S4 17 4 12V6z M8 12l3 3 5-6",
    cloud: "M7 18a5 5 0 01-1-10 7 7 0 0113 3 4 4 0 01-1 7z",
  };
  const icon = name => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.7"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", iconPaths[name] || iconPaths.terminal); svg.appendChild(path); return svg;
  };
  for (const feature of ${JSON.stringify(CAPABILITIES)}) {
    const card = el("article", undefined, "capability"); card.append(icon(feature.icon), el("h3", feature.title), el("p", feature.description), el("span", feature.status, "badge"));
    document.getElementById("capability-grid").appendChild(card);
  }
  const descriptions = {"require-approval":"Ask before approval-gated effects. Reads still follow your permissions.","autonomous-browser":"Let browser workflows proceed within the configured policy. Other effects can still require approval.",off:"Disable built-in approval prompts, not capability checks. Use only with trusted agents."};
  const feedback = async name => {
    let ok = false; try { ok = await api.action(name, {}); } catch { /* Show a visible failure, never an unhandled rejection. */ }
    text("quick-feedback", ok ? (name.startsWith("ui.copy") ? "Copied to clipboard." : "") : "Action failed. Check the desktop service and try again.");
  };
  document.getElementById("open-workspace").onclick = () => feedback("ui.openWorkspace");
  document.getElementById("copy-config").onclick = () => feedback("ui.copyConfig");
  document.getElementById("quick-copy").onclick = () => feedback("ui.copyConnection");
  document.getElementById("quick-pair").onclick = () => feedback("pairing.start");
  const render = (view) => {
    text("workspace", view.workspace || "—");
    for (const id of ["open-workspace", "copy-config"]) document.getElementById(id).disabled = !view.workspace;
    document.getElementById("quick-copy").disabled = !view.resourceUri;
    document.getElementById("quick-pair").disabled = !view.pairing.available || view.pairing.action !== "pair";
    if (changed("quick-protection", view.modules)) {
      const protection = document.getElementById("quick-protection"); clear(protection);
      for (const m of (view.modules || []).filter(m => ["Browser & CDP", "L1 sandbox"].includes(m.title))) {
        protection.append(el("span", m.title), document.createTextNode(": "), el("span", m.value), document.createTextNode(" · "));
      }
    }
    text("headline", view.connection === "error" ? "Unable to connect to CROT" : view.headline);
    if (view.connection === "connected" && firstConnected) { firstConnected = false; if (view.cards.length) selectTab("queue"); }
    const connected = view.connection === "connected";
    const known = view.commercial?.state === "current";
    const plan = known ? view.commercial.plan : undefined;
    text("connection", connected ? (view.remoteMode ? "Remote Active" : "Local Mode") : "Offline");
    document.getElementById("connection").className = "badge " + (connected ? "ready" : "warning");
    text("plan-badge", plan ? (plan === "trial" ? "TRIAL · 7 DAYS" : plan.toUpperCase()) : view.pairing.state === "paired" ? "PLAN UNKNOWN" : "FREE · LOCAL");
    const accountPlan = document.getElementById("account-plan");
    if (changed("account-plan", [plan,view.commercial?.status])) {
      clear(accountPlan);
      if (plan) accountPlan.append(document.createTextNode(plan.toUpperCase() + " · "), el("span", view.commercial.status));
      else accountPlan.textContent = "Free local access";
    }
    text("account-status", known ? (view.commercial.entitled ? "Remote access is included in your active plan." : "Local tools are free. Upgrade to enable cloud relay access.") : view.pairing.state === "paired" ? "Cloud plan could not be refreshed. Local tools are unaffected." : "This device is not paired. Local tools are free without an account.");
    text("device-count", known ? "Remote devices: " + view.commercial.deviceCount + " / " + view.commercial.maxDevices : "Remote device quota: not available offline");
    text("queue-count", String(view.cards.length));
    document.getElementById("approval-empty").hidden = view.cards.length > 0;
    if (changed("modules", view.modules)) {
    const modules = document.getElementById("modules"); clear(modules);
    for (const m of view.modules || []) {
      const box = el("article", undefined, "module"); box.append(icon(["terminal", "browser", "shield", "cloud"][(view.modules || []).indexOf(m)]), el("h3", m.title), el("span", m.value, "badge " + (m.ready ? "ready" : "warning")));
      if (m.note) box.appendChild(el("p", m.note, "note"));
      if (m.repair) box.appendChild(button("Installation & repair guide", () => api.action("ui.openInstall", {})));
      modules.appendChild(box);
    }
    }
    const notice = document.getElementById("notice");
    notice.hidden = !view.notice;
    notice.textContent = view.notice ? "The action needs attention. See Developer Diagnostics for details; local tools are unaffected." : "";
    if (changed("approvals", view.cards)) {
    const approvals = document.getElementById("approvals");
    clear(approvals);
    for (const card of view.cards) {
      const box = el("article", undefined, "card");
      box.dataset.requestId = card.requestId;
      box.appendChild(el("h3", card.title));
      for (const b of card.banners) box.appendChild(el("p", b, "banner"));
      const dl = el("dl");
      rows(dl, card.rows);
      rows(dl, [{ label: "Expires", value: card.expiresAt, marks: [], length: 0 }]);
      box.appendChild(dl);
      const actions = el("div", undefined, "actions");
      actions.appendChild(button("Approve", () => api.decide(card.requestId, "approve")));
      actions.appendChild(button("Reject", () => api.decide(card.requestId, "reject")));
      box.appendChild(actions);
      approvals.appendChild(box);
    }
    }
    if (changed("presets", view.presets)) {
    const presets = document.getElementById("presets");
    clear(presets);
    for (const p of view.presets) {
      const line = el("div", undefined, "preset");
      const b = button((p.selected ? "● " : "○ ") + p.label, () => api.action("preset.set", { value: p.value }), p.selected || !p.available);
      b.setAttribute("aria-pressed", String(p.selected));
      line.appendChild(b);
      line.appendChild(el("p", descriptions[p.value], "note"));
      if (p.note) line.appendChild(el("span", "Unavailable in the current configuration.", "note"));
      presets.appendChild(line);
    }
    }
    const blocked = document.getElementById("preset-blocked");
    blocked.hidden = !view.presetBlockedBy;
    blocked.textContent = view.presetBlockedBy ? "Wait for running actions to finish before changing the security preset." : "";
    if (changed("remote", [view.connection,view.remoteMode,view.fullControl,view.pairing.action,view.pairing.available,view.resourceUri,view.commercial?.state,view.commercial?.entitled,view.pairing.state])) {
    const remote = document.getElementById("remote");
    clear(remote);
    if (view.connection === "connected") {
      remote.appendChild(button(view.remoteMode ? "Turn remote mode off" : "Turn remote mode on", () => { if (!view.remoteMode && (view.commercial?.state === "current" && !view.commercial.entitled || view.pairing.state === "unpaired")) { paywall(); return; } return api.action("remote.setMode", { enabled: !view.remoteMode }); }));
      remote.appendChild(button(view.fullControl ? "Withdraw remote full control opt-in" : "Opt in to remote full control", () => api.action("remote.setFullControl", { enabled: !view.fullControl })));
      const pairing = view.pairing;
      if (pairing.action === "pair") remote.appendChild(button("Pair this device", () => api.action("pairing.start", {}), !pairing.available));
      if (pairing.action === "cancel") remote.appendChild(button("Cancel pairing", () => api.action("pairing.cancel", {})));
      if (pairing.action === "unpair") remote.appendChild(button("Unpair this device", () => api.action("device.unpair", {})));
    }
    if (view.resourceUri) remote.appendChild(button("Copy MCP connection link", () => api.action("ui.copyConnection", {})));
    }
    text("remote-summary", view.pairing.state === "paired" ? "Device paired. Remote requests still follow the security profile and permissions." : "Pair this device after activating a remote plan in your account.");
    if (changed("clients", [view.notice,view.fullControlNote,view.pairing.lines,view.remoteNotes,view.clients])) {
    const technical = document.getElementById("technical-notes"); clear(technical);
    for (const n of [view.notice, view.fullControlNote, ...view.pairing.lines, ...view.remoteNotes]) if (n) technical.appendChild(el("p", n, "note"));
    const clients = document.getElementById("clients");
    clear(clients);
    for (const c of view.clients) {
      const line = el("div", undefined, "client");
      line.appendChild(el("div", "MCP client " + (view.clients.indexOf(c) + 1) + (c.revoked ? " · revoked" : " · connected previously") + " · exposure: " + c.exposure));
      technical.appendChild(el("p", c.text, "note"));
      const key = { accountId: c.accountId, deviceId: c.deviceId, clientId: c.clientId };
      const actions = el("div", undefined, "actions");
      actions.appendChild(button("Reset exposure", () => api.action("remote.resetExposure", key), c.exposure !== "exposed"));
      if (c.revoked) actions.appendChild(button("Re-grant", () => api.action("remote.regrantClient", key)));
      else actions.appendChild(button("Revoke", () => api.action("remote.revokeClient", key)));
      line.appendChild(actions);
      clients.appendChild(line);
    }
    }
    if (changed("status", view.status)) {
    const status = document.getElementById("status");
    clear(status);
    rows(status, view.status);
    }
  };
  api.onView(render);
  api.ready();
})();
`;

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

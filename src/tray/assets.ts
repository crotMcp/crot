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
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${TRAY_CSP}">
<title>CROT</title>
<link rel="stylesheet" href="${TRAY_ORIGIN}/app.css">
<script src="${TRAY_ORIGIN}/renderer.js" defer></script>
</head>
<body>
<header><h1 id="headline">CROT</h1><p id="notice" hidden></p></header>
<section id="approvals" aria-label="Approval requests"></section>
<section aria-label="Approval preset"><h2>Approval preset</h2><div id="presets"></div><p id="preset-blocked" class="note" hidden></p></section>
<section aria-label="Remote"><h2>Remote access</h2><div id="remote"></div><div id="clients"></div></section>
<section aria-label="Status"><h2>Status</h2><dl id="status"></dl></section>
</body>
</html>
`;

const CSS = `
:root { color-scheme: light dark; font: 13px system-ui, sans-serif; }
body { margin: 0; padding: 12px 16px; }
h1 { font-size: 16px; margin: 0 0 8px; }
h2 { font-size: 13px; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
#notice { padding: 6px 8px; border-radius: 4px; background: #8884; }
.card { border: 2px solid #c80; border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
.card h3 { font-size: 14px; margin: 0 0 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.banner { background: #b00; color: #fff; font-weight: 700; padding: 4px 6px; margin: 4px 0; border-radius: 3px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 0; }
dt { font-weight: 600; }
dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, monospace; }
.mark { display: inline-block; margin-left: 6px; padding: 0 4px; border-radius: 3px; background: #c80; color: #000; font: 600 11px system-ui, sans-serif; }
.mark.remote, .mark.full-control, .mark.outside-workspace { background: #b00; color: #fff; }
.actions { margin-top: 8px; display: flex; gap: 8px; }
button { font: inherit; padding: 4px 12px; }
.note { opacity: .75; }
.client { border-top: 1px solid #8884; padding: 6px 0; }
`;

/**
 * The renderer: receives a TrayView (plain strings) and builds the page with
 * createElement/textContent only. It never sees a subject digest — the main
 * process decides with the digest it presented (AD-19 point 4).
 */
const RENDERER = `"use strict";
(() => {
  const api = window.crot;
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const button = (text, onClick, disabled) => {
    const b = el("button", text);
    b.type = "button";
    b.disabled = !!disabled;
    b.addEventListener("click", () => { b.disabled = true; onClick(); });
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
  const render = (view) => {
    document.getElementById("headline").textContent = view.headline;
    const notice = document.getElementById("notice");
    notice.hidden = !view.notice;
    notice.textContent = view.notice || "";
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
    const presets = document.getElementById("presets");
    clear(presets);
    for (const p of view.presets) {
      const line = el("div");
      const b = button((p.selected ? "● " : "○ ") + p.label, () => api.action("preset.set", { value: p.value }), p.selected || !p.available);
      line.appendChild(b);
      if (p.note) line.appendChild(el("span", " " + p.note, "note"));
      presets.appendChild(line);
    }
    const blocked = document.getElementById("preset-blocked");
    blocked.hidden = !view.presetBlockedBy;
    blocked.textContent = view.presetBlockedBy ? "Changes wait until CROT is idle: " + view.presetBlockedBy : "";
    const remote = document.getElementById("remote");
    clear(remote);
    if (view.connection === "connected") {
      remote.appendChild(button(view.remoteMode ? "Turn remote mode off" : "Turn remote mode on", () => api.action("remote.setMode", { enabled: !view.remoteMode })));
      remote.appendChild(button(view.fullControl ? "Withdraw remote full control opt-in" : "Opt in to remote full control", () => api.action("remote.setFullControl", { enabled: !view.fullControl })));
      const pairing = view.pairing;
      if (pairing.action === "pair") remote.appendChild(button("Pair this device", () => api.action("pairing.start", {}), !pairing.available));
      if (pairing.action === "cancel") remote.appendChild(button("Cancel pairing", () => api.action("pairing.cancel", {})));
      if (pairing.action === "unpair") remote.appendChild(button("Unpair this device", () => api.action("device.unpair", {})));
    }
    for (const n of [view.fullControlNote, ...view.pairing.lines, ...view.remoteNotes]) if (n) remote.appendChild(el("p", n, "note"));
    const clients = document.getElementById("clients");
    clear(clients);
    for (const c of view.clients) {
      const line = el("div", undefined, "client");
      line.appendChild(el("div", c.text + (c.revoked ? " — revoked" : "") + " — exposure: " + c.exposure));
      const key = { accountId: c.accountId, deviceId: c.deviceId, clientId: c.clientId };
      const actions = el("div", undefined, "actions");
      actions.appendChild(button("Reset exposure", () => api.action("remote.resetExposure", key), c.exposure !== "exposed"));
      if (c.revoked) actions.appendChild(button("Re-grant", () => api.action("remote.regrantClient", key)));
      else actions.appendChild(button("Revoke", () => api.action("remote.revokeClient", key)));
      line.appendChild(actions);
      clients.appendChild(line);
    }
    const status = document.getElementById("status");
    clear(status);
    rows(status, view.status);
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

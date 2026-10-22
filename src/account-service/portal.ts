/** Public, static account portal. Tokens live only in this page's memory; no analytics or third-party scripts. */
import { CAPABILITIES, CROT_CSS } from "../ui/theme.js";

const BRAND = `<header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">C</span>CROT</div><nav class="actions" aria-label="Website"><a class="button" href="/">Product</a><a class="button" href="/welcome#install">Installation</a><a class="button primary" href="/portal">Account</a></nav></header>`;
const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/portal.css">`;
const INSTALL = `<section id="install" class="section"><p class="eyebrow">Start on your computer</p><h2>Install. Connect. Stay in control.</h2><p class="muted">The browser extension needs the desktop service and native bridge. Use only a qualified package for your operating system.</p><div class="feature-grid"><article class="panel"><h3>Windows</h3><p class="note">Unified installer qualification is pending. Do not treat a source bundle as a signed MSI.</p><a href="/portal">Account & availability</a></article><article class="panel"><h3>macOS</h3><p class="note">Unified installer qualification is pending. Vendor signing and notarization remain release gates.</p><a href="/portal">Account & availability</a></article><article class="panel"><h3>Linux</h3><p class="note">Unified installer qualification is pending. L1 needs installed native components and platform verification.</p><a href="/portal">Account & availability</a></article></div></section>`;
export const LANDING_HTML = `<!doctype html><html lang="en"><head>${HEAD}<title>CROT · Your computer. Your rules.</title></head><body>${BRAND}<main class="wrap"><section class="hero"><p class="eyebrow">The secure bridge between AI and your computer</p><h1>Powerful agents.<br>Boundaries you control.</h1><p>Connect compatible AI clients to your files, terminal and browser. One permission engine. Explicit approvals. Free local access, with no account or card.</p><div class="actions"><a class="button primary" href="#install">Get started locally</a><a class="button" href="/portal">Explore remote access</a></div><p class="note">Pre-release · Platform and live-service qualification remain separate gates.</p></section><section class="section"><h2>A workspace, not a collection of workarounds.</h2><div class="feature-grid">${CAPABILITIES.map((f) => `<article class="capability"><h3>${f.title}</h3><p>${f.description}</p><span class="badge">${f.status}</span></article>`).join("")}</div></section>${INSTALL}<section class="panel"><h2>Local by default. Remote when you choose.</h2><p class="muted">Free local tools need no card. A 7-day remote trial requires a card in hosted Stripe Checkout and supports up to 2 devices. Paid billing starts after the trial unless canceled.</p><a class="button primary" href="/portal">View trial & plans</a></section><footer>No hidden telemetry. No remote code in your Control Center. Every operation follows the same security policy.</footer></main></body></html>`;
export const PORTAL_HTML = `<!doctype html><html lang="en"><head>${HEAD}<title>CROT · Account & plan</title><script src="/portal.js" defer></script></head><body>${BRAND}<main class="wrap"><section class="hero"><p class="eyebrow">Your CROT account</p><h1>Start local.<br>Go remote on your terms.</h1><p>Local mode is always free, offline and accountless. Cloud plans add remote access without changing your local security permissions.</p><div class="actions"><button id="signin" class="primary">Sign in / create account</button><button id="signout" hidden>Sign out</button></div><p id="notice" role="status"></p></section><section id="account" hidden><div class="panel"><p class="eyebrow">Current plan</p><h2 id="plan"></h2><p id="limits" class="muted"></p><div class="actions"><button id="refresh">Refresh status</button><button id="billing">Manage billing / cancel</button></div></div><div class="plans"><article class="panel"><h3>Free</h3><p>Full local functionality.</p><p class="note">No account or card needed. No cloud relay.</p><span class="badge">Always free locally</span></article><article class="panel plan-featured"><h3>7-day Trial</h3><p>Remote access · 2 devices.</p><p class="note">Card required. Automatically becomes a Pro subscription after 7 days unless canceled. Price is shown in Checkout before confirmation.</p><button id="trial" class="primary">Try 7 days free</button></article><article class="panel"><h3>Pro</h3><p>Remote access · 5 devices.</p><p class="note">Current recurring price and billing period are shown in Stripe Checkout.</p><button id="pro">Choose Pro</button></article><article class="panel"><h3>Team</h3><p>Remote access · 20 devices.</p><p class="note">One account per user in v1. This is not a shared multi-user workspace subscription.</p><button id="team">Choose Team</button></article></div><section class="section"><h2>Devices & clients</h2><p class="muted">Revoke remote access to a lost device without affecting local files.</p><ul id="devices"></ul></section></section>${INSTALL}<footer>Cards and subscription management use hosted Stripe pages. Tokens stay only in this page's memory.</footer></main></body></html>`;
export const PORTAL_CSS = CROT_CSS;
export const PORTAL_SCRIPT = String.raw`"use strict";
(async () => {
  const el = id => document.getElementById(id);
  let token, config;
  el("signin").disabled = true;
  const say = text => { el("notice").textContent = text; };
  const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
  async function api(path, body) {
    const r = await fetch(path, { method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "omit", redirect: "error",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!r.ok) throw new Error(r.status === 401 ? "Sign in again." : r.status === 409 ? "Trial is unavailable for this account." : "Request refused. Refresh your account and try again.");
    return r.json();
  }
  async function refresh() {
    const a = await api("/account");
    el("account").hidden = false; el("signin").hidden = true; el("signout").hidden = false;
    el("plan").textContent = a.plan + " · " + a.status;
    el("limits").textContent = "Remote access: " + (a.entitled ? "enabled" : "not entitled") + ". Devices: " + a.deviceCount + "/" + a.maxDevices + ".";
    el("trial").disabled = a.plan !== "free";
    el("devices").replaceChildren();
    for (const d of a.devices) {
      const row = document.createElement("li"), label = document.createElement("p");
      label.textContent = "Device " + (a.devices.indexOf(d) + 1) + " · " + (d.revoked ? "revoked" : d.online ? "online" : "offline"); row.append(label);
      const details = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "Developer Diagnostics"; details.append(summary);
      const technical = document.createElement("p"); technical.textContent = "Device: " + d.deviceId; details.append(technical);
      for (const c of d.clients) { const client = document.createElement("p"); client.textContent = "Client: " + c.clientId; details.append(client); }
      row.append(details);
      if (!d.revoked) { const revoke = document.createElement("button"); revoke.textContent = "Revoke this device";
        revoke.onclick = () => run(async () => { if (!confirm("Revoke this device? Remote access ends immediately. Local files and local mode are unaffected.")) return;
          await api("/account/devices/" + encodeURIComponent(d.deviceId) + "/revoke", {}); await refresh(); say("Device revoked."); }); row.append(revoke); }
      el("devices").append(row);
    }
  }
  async function run(fn) { try { await fn(); } catch (e) { say(e instanceof Error ? e.message : "Request failed."); } }
  el("signin").onclick = () => run(async () => {
    const verifier = random(), state = random(), redirect = location.origin + "/portal/callback";
    sessionStorage.setItem("crot-oauth", JSON.stringify({ verifier, state, created: Date.now() }));
    const u = new URL(config.authorizationEndpoint);
    for (const [k,v] of Object.entries({ response_type: "code", client_id: config.clientId, redirect_uri: redirect,
      scope: "openid", resource: config.resource, state, code_challenge_method: "S256", code_challenge: b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))) })) u.searchParams.set(k,v);
    location.assign(u.href);
  });
  el("signout").onclick = () => { token = undefined; sessionStorage.removeItem("crot-oauth"); el("account").hidden = true; el("signout").hidden = true; el("signin").hidden = false; say("Signed out of this portal. Provider SSO may remain signed in."); };
  el("refresh").onclick = () => run(refresh);
  function redirectHosted(result, origin) {
    const url = new URL(result.url); if (url.origin !== origin) throw new Error("Invalid billing destination."); location.assign(url.href);
  }
  el("trial").onclick = () => run(async () => { redirectHosted(await api("/account/trial", {}), "https://checkout.stripe.com"); });
  el("billing").onclick = () => run(async () => { redirectHosted(await api("/account/billing-portal", {}), "https://billing.stripe.com"); });
  for (const plan of ["pro", "team"]) el(plan).onclick = () => run(async () => { const result = await api("/account/checkout", { plan });
    const url = new URL(result.url); if (url.origin !== "https://checkout.stripe.com") throw new Error("Invalid checkout."); location.assign(url.href); });
  const params = new URLSearchParams(location.search);
  if (location.pathname === "/portal/callback") history.replaceState(null, "", "/portal");
  try {
    const r = await fetch("/portal/config", { cache: "no-store", credentials: "omit", redirect: "error" });
    if (!r.ok) throw new Error("Account sign-in is not configured. Contact the operator."); config = await r.json(); el("signin").disabled = false;
    if (params.has("code") || params.has("error")) {
      const saved = JSON.parse(sessionStorage.getItem("crot-oauth") || "null"); sessionStorage.removeItem("crot-oauth");
      if (!saved || params.get("state") !== saved.state || Date.now() - saved.created > 600000 || (params.has("iss") && params.get("iss") !== config.issuer) || params.has("error")) throw new Error("Sign-in could not be verified. Please try again.");
      const response = await fetch(config.tokenEndpoint, { method: "POST", credentials: "omit", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, code: params.get("code"), code_verifier: saved.verifier, redirect_uri: location.origin + "/portal/callback", resource: config.resource }) });
      if (!response.ok) throw new Error("Sign-in failed."); const result = await response.json();
      if (result.token_type?.toLowerCase() !== "bearer" || typeof result.access_token !== "string") throw new Error("Sign-in failed."); token = result.access_token; await refresh();
    }
  } catch (e) { say(e instanceof Error ? e.message : "Sign-in unavailable."); }
})();`;

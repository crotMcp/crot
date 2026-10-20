/** Public, static account portal. Tokens live only in this page's memory; no analytics or third-party scripts. */
export const PORTAL_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CROT account</title><link rel="stylesheet" href="/portal.css"><script src="/portal.js" defer></script></head><body><main><p>CROT · Account</p><h1>Your remote access</h1><p>Local mode is always free, offline and accountless. Plans apply only to the cloud relay.</p><button id="signin">Sign in / create account</button><button id="signout" hidden>Sign out</button><p id="notice" role="status"></p><section id="account" hidden><h2 id="plan"></h2><p id="limits"></p><button id="trial">Start 14-day trial</button><button id="pro">Choose Pro · 5 devices</button><button id="team">Choose Team · 20 devices</button><button id="refresh">Refresh</button><h2>Devices and clients</h2><ul id="devices"></ul></section></main></body></html>`;
export const PORTAL_CSS = `body{font:17px/1.6 system-ui,sans-serif;background:#f7f6f2;color:#162825;margin:0}main{max-width:820px;margin:5vh auto;padding:28px}h1{font-size:clamp(30px,5vw,48px);line-height:1.1}button{font:inherit;padding:9px 14px;margin:5px;border:1px solid #36594e;border-radius:7px;background:white;color:#162825;cursor:pointer}button:focus-visible{outline:3px solid #188265}button:disabled{opacity:.5}li{margin:18px 0;overflow-wrap:anywhere}section{margin-top:30px}#notice{min-height:1.6em}`;
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
      label.textContent = d.deviceId + " · " + (d.revoked ? "revoked" : d.online ? "online" : "offline"); row.append(label);
      for (const c of d.clients) { const client = document.createElement("p"); client.textContent = "Client: " + c.clientId; row.append(client); }
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
  el("trial").onclick = () => run(async () => { await api("/account/trial", {}); await refresh(); });
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

/* global chrome, document, URL, window, setTimeout */
"use strict";
const byId = (id) => document.getElementById(id);
const FALLBACK_PORTAL = "https://relay-staging.crot.network/portal";
let portal = FALLBACK_PORTAL;
function destination(path) {
  const url = new URL(portal);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.href;
}
async function openTab(url) {
  await chrome.tabs.create({ url, active: true });
}
async function run(action) {
  try {
    await action();
  } catch {
    byId("error").textContent = "Action failed. Check the desktop service and try again.";
  }
}
async function refreshStatus() {
  const refresh = byId("refresh");
  refresh.disabled = true;
  byId("error").textContent = "";
  try {
    let state = await chrome.runtime.sendMessage({ type: "crot.ui.status" });
    for (let attempt = 0; state?.connection === "connecting" && attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await chrome.runtime.sendMessage({ type: "crot.ui.status" });
    }
    const connected = state?.connection === "connected";
    if (typeof state?.portalUrl === "string") {
      const url = new URL(state.portalUrl);
      if (url.protocol === "https:" && !url.username && !url.password) portal = url.href;
    }
    byId("connection").textContent = connected
      ? "Connected"
      : state?.connection === "connecting"
        ? "Connecting…"
        : "Desktop App Not Detected";
    byId("connection").className = "badge " + (connected ? "ready" : "warning");
    // Preserve the reserved space: native connection updates must not resize the popup.
    byId("install").classList.toggle("connected", connected);
  } catch {
    byId("connection").textContent = "Desktop App Not Detected";
    byId("install").classList.remove("connected");
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    byId("tab").textContent = tab
      ? "Active tab: " + (tab.status === "complete" ? "loaded" : "loading")
      : "No active tab";
    const groups = tab ? await chrome.tabGroups.query({ title: "CROT", windowId: tab.windowId }) : [];
    byId("group").textContent = groups.some((g) => g.id === tab.groupId)
      ? "Active tab is in the CROT group"
      : groups.length
        ? "CROT group is ready in this window"
        : "No CROT group in this window";
  } catch {
    byId("tab").textContent = "Tab status is unavailable";
  } finally {
    refresh.disabled = false;
    window.CrotI18n?.apply();
  }
}
byId("refresh").addEventListener("click", () => void refreshStatus());
byId("open-app").addEventListener(
  "click",
  () =>
    void run(async () => {
      const result = await chrome.runtime.sendMessage({ type: "crot.ui.openApp" });
      if (!result?.ok) {
        byId("install").classList.remove("connected");
        byId("error").textContent = "Start the desktop service with npm start, then refresh the connection.";
      }
    }),
);
byId("account").addEventListener("click", () => void run(() => openTab(destination("/portal"))));
byId("download").addEventListener(
  "click",
  () => void run(() => openTab(chrome.runtime.getURL("welcome.html") + "#install")),
);
byId("guide").addEventListener("click", () => void run(() => openTab(chrome.runtime.getURL("welcome.html"))));
void refreshStatus();

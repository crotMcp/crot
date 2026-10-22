/* global chrome, document, navigator, window */
"use strict";
const byId = (id) => document.getElementById(id);
const feedback = (text) => {
  byId("feedback").textContent = text;
  window.CrotI18n?.apply();
};
const os = /Win/i.test(navigator.platform) ? "windows" : /Mac/i.test(navigator.platform) ? "macos" : "linux";
for (const link of document.querySelectorAll("a[href*='/download/']"))
  link.href = "https://relay-staging.crot.network/download/" + os;
// All external navigation happens in a browser tab, never under chrome-extension://.
for (const link of document.querySelectorAll("a[href^='https://']"))
  link.addEventListener("click", (event) => {
    event.preventDefault();
    void chrome.tabs
      .create({ url: link.href, active: true })
      .catch(() => feedback("Action failed. Check the desktop service and try again."));
  });
async function refresh() {
  byId("refresh").disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: "crot.ui.status" });
    byId("connection").textContent = state?.connection === "connected" ? "Connected" : "Desktop App Not Detected";
    byId("connection").className = "badge " + (state?.connection === "connected" ? "ready" : "warning");
  } catch {
    byId("connection").textContent = "Desktop App Not Detected";
  } finally {
    byId("refresh").disabled = false;
    window.CrotI18n?.apply();
  }
}
byId("refresh").onclick = () => void refresh();
byId("open-app").onclick = async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: "crot.ui.openApp" });
    if (!result?.ok) feedback("Start the desktop service with npm start, then refresh the connection.");
  } catch {
    feedback("Start the desktop service with npm start, then refresh the connection.");
  }
};
byId("copy-launch").onclick = async () => {
  try {
    await navigator.clipboard.writeText("npm start");
    feedback("Copied to clipboard.");
  } catch {
    feedback("Copy unavailable. Try again.");
  }
};
void refresh();

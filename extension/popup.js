/* global chrome, document */
"use strict";
const byId = (id) => document.getElementById(id);
async function refreshStatus() {
  const refresh = byId("refresh");
  refresh.disabled = true;
  byId("error").textContent = "";
  try {
    const state = await chrome.runtime.sendMessage({ type: "crot.ui.status" });
    const connected = state?.connection === "connected";
    byId("connection").textContent = connected
      ? "Connected"
      : state?.connection === "connecting"
        ? "Connecting…"
        : "Desktop App Not Detected";
    byId("connection").className = "badge " + (connected ? "ready" : "warning");
    byId("install").hidden = connected;
  } catch {
    byId("connection").textContent = "Desktop App Not Detected";
    byId("install").hidden = false;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // A page title/URL can contain secrets or hostile text. Show neither in this compact status UI.
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
  }
}
byId("refresh").addEventListener("click", () => void refreshStatus());
byId("control-guide").addEventListener("click", () => {
  byId("open-help").hidden = !byId("open-help").hidden;
});
void refreshStatus();

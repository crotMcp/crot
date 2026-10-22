/**
 * Service worker of the CROT Browser Extension (Manifest V3, Chromium:
 * Chrome, Edge, Brave).
 *
 * The extension is the browser end of CROT's browser bridge. It connects to
 * the CROT Host through native messaging and executes the fixed set of
 * browser commands the host sends; the host only sends commands that Core's
 * PermissionEngine has authorized. The popup reports connection state; the bridge takes no tool action
 * on its own and runs no code in pages other than the fixed functions in
 * page-functions.ts.
 *
 * Event listeners are registered synchronously at startup, as Manifest V3
 * requires for a suspended service worker to be woken by them.
 */
import { detectBrowser } from "./browser-info.js";
import { CdpSessions } from "./cdp.js";
import { createCommandHandlers } from "./commands.js";
import { ownerUiAction } from "./owner-ui.js";
import { HostConnection } from "./host-connection.js";

/** Wakes the service worker to reconnect while CROT is not reachable. 30 s is the shortest period Chrome allows. */
const RECONNECT_ALARM = "crot-reconnect";

/** ControlOrMeta of browser_press_key and click modifiers is Meta on macOS. */
const platform =
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
const mac = /mac/i.test(platform);

/** Debugger sessions (Browser v1, AD-16 point 3); detached when the CROT connection ends. */
const cdp = new CdpSessions(chrome, { onNotice: (notice) => connection.notify(notice) });

let resetQueues = (): void => undefined;
const connection = new HostConnection({
  runtime: chrome.runtime,
  browser: detectBrowser(navigator, chrome.runtime.getManifest().version),
  handlers: createCommandHandlers(chrome, {
    cdp,
    mac,
    onQueueReset: (reset) => {
      resetQueues = reset;
    },
  }),
  log: (message) => console.info("CROT: " + message),
  onDisconnected: () => {
    resetQueues();
    void cdp.detachAll();
  },
});

// Fixed owner UI channel. Only exact packaged UI pages; never content scripts or browser tools.
const uiRuntime = chrome.runtime as typeof chrome.runtime & {
  getURL?: (path: string) => string;
  onMessage?: {
    addListener(
      listener: (message: unknown, sender: { url?: string }, reply: (value: unknown) => void) => boolean | void,
    ): void;
  };
};
uiRuntime.onMessage?.addListener((message, sender, reply) => {
  const action = ownerUiAction(message, sender.url, uiRuntime.getURL?.(""));
  if (!action) return;
  if (action === "open") {
    void connection.openControlCenter().then((ok) => reply({ ok }));
    return true;
  }
  reply({ connection: connection.state });
});

chrome.runtime.onStartup.addListener(() => connection.ensureConnected());
chrome.runtime.onInstalled.addListener((details?: { reason?: string }) => {
  connection.ensureConnected();
  if (details?.reason === "install") {
    const welcome = uiRuntime.getURL?.("welcome.html");
    if (welcome) void chrome.tabs.create({ url: welcome, active: true }).catch(() => undefined);
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connection.ensureConnected();
});
void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
connection.ensureConnected();

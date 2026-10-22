/**
 * CROT tray (WP-22, AD-19 point 1): an Electron process that is only a
 * client of the service's authenticated control channel. It has no MCP
 * connection, no tools and no approval authority of its own; the service
 * checks every decision against the request id and the subject digest shown.
 *
 * Run with `npm run tray` (after `npm run build`) or
 * `electron dist/tray/main.js [--state-dir=<dir>]`.
 * `--smoke-test=<file>` renders once, writes a JSON report and quits; it
 * never decides anything.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  session,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type NativeImage,
} from "electron";
import { hostDirectories } from "../core/platform/node-platform.js";
import { createPrivateFileProtection } from "../core/platform/private-files.js";
import { PRESET_VALUES, type PresetValue } from "../service/protocol.js";
import { TRAY_CSP, TRAY_ORIGIN, trayAsset } from "./assets.js";
import { TrayController } from "./controller.js";
import { trayView, type TrayView } from "./view-model.js";

// Linux compatibility: the launcher also passes this before Electron bootstrap.
// Deliberately documented sandbox trade-off; context isolation and Node/network denial remain.
if (process.platform === "linux") app.commandLine.appendSwitch("no-sandbox");

const ORIGIN_PREFIX = `${TRAY_ORIGIN}/`;
const MAX_ID = 512;

function argValue(name: string): string | undefined {
  const args = process.argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === `--${name}`) return args[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

const stateDir = path.resolve(argValue("state-dir") ?? hostDirectories(process.env).state);
const smokeReport = argValue("smoke-test");

protocol.registerSchemesAsPrivileged([
  { scheme: "crot-tray", privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } },
]);

// One tray per state directory.
app.setPath("userData", path.join(stateDir, "tray"));
if (!smokeReport && !app.requestSingleInstanceLock()) app.exit(0);

/** A small round icon drawn in memory (BGRA), so no image file is loaded. */
function icon(rgb: readonly [number, number, number]): NativeImage {
  const size = 16;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      const alpha = d <= 6.5 ? 255 : d <= 7.5 ? Math.round(255 * (7.5 - d)) : 0;
      const i = (y * size + x) * 4;
      data[i] = rgb[2];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[0];
      data[i + 3] = alpha;
    }
  return nativeImage.createFromBitmap(data, { width: size, height: size });
}

const ICON_COLORS: Readonly<Record<TrayView["icon"], readonly [number, number, number]>> = {
  idle: [40, 150, 70],
  remote: [40, 100, 200],
  attention: [220, 130, 0],
  offline: [128, 128, 128],
};

const fromTray = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  event.senderFrame?.url.startsWith(ORIGIN_PREFIX) === true &&
  window !== undefined &&
  event.sender === window.webContents;

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let rendererReady = false;
let view: TrayView = trayView({ connection: "connecting", pending: [] });

const controller = new TrayController({
  stateDir,
  privateFiles: createPrivateFileProtection(process.platform === "win32"),
  onUpdate: (state) => {
    view = trayView(state);
    publish();
  },
  // Pairing sign-in (WP-28): only HTTPS URLs, re-checked here, open in the user's browser.
  openSignIn: (url) => {
    if (!smokeReport && new URL(url).protocol === "https:") void shell.openExternal(url);
  },
  onNewApproval: () => {
    if (!smokeReport) showWindow();
  },
});

function publish(): void {
  if (window && rendererReady && !window.isDestroyed()) window.webContents.send("view", view);
  if (tray && !tray.isDestroyed()) {
    tray.setImage(icon(ICON_COLORS[view.icon]));
    tray.setToolTip(view.tooltip);
    tray.setContextMenu(menu());
  }
}

function menu(): Menu {
  return Menu.buildFromTemplate([
    { label: view.headline, enabled: false },
    { type: "separator" },
    { label: "Open CROT", click: () => showWindow() },
    { label: "Quit tray", click: () => quit() },
  ]);
}

function showWindow(): void {
  if (!window || window.isDestroyed()) createWindow();
  window!.show();
  window!.focus();
}

function createWindow(): void {
  rendererReady = false;
  window = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: "#09090B",
    show: false,
    title: "CROT Control Center",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  window.on("close", (event) => {
    if (quitting || smokeReport) return;
    event.preventDefault();
    window?.hide();
  });
  void window.loadURL(`${ORIGIN_PREFIX}index.html`);
}

function quit(): void {
  quitting = true;
  controller.stop();
  app.quit();
}

function harden(): void {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith(ORIGIN_PREFIX) && !details.url.startsWith("devtools:") }),
  );
  protocol.handle("crot-tray", (request) => {
    const asset = trayAsset(request.url);
    if (!asset) return new Response("Not found", { status: 404 });
    return new Response(asset.body, {
      headers: {
        "content-type": asset.type,
        "content-security-policy": TRAY_CSP,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
}

const ACTIONS = new Set([
  "preset.set",
  "remote.setMode",
  "remote.setFullControl",
  "remote.resetExposure",
  "remote.revokeClient",
  "remote.regrantClient",
  "pairing.start",
  "pairing.cancel",
  "device.unpair",
]);

function clientKey(p: Record<string, unknown>): { accountId: string; deviceId: string; clientId: string } | undefined {
  return isId(p.accountId) && isId(p.deviceId) && isId(p.clientId)
    ? { accountId: p.accountId, deviceId: p.deviceId, clientId: p.clientId }
    : undefined;
}

async function runAction(name: unknown, params: unknown): Promise<boolean> {
  // Fixed owner-UI actions only. Renderer never supplies an external URL or clipboard bytes.
  if (typeof name === "string" && name.startsWith("ui.") && isRecord(params) && Object.keys(params).length === 0) {
    if (name === "ui.openWorkspace") {
      if (!view.workspace || !path.isAbsolute(view.workspace)) return false;
      return (await shell.openPath(view.workspace)) === "";
    }
    if (name === "ui.copyConfig") {
      if (!view.workspace || !path.isAbsolute(view.workspace)) return false;
      const bin = fileURLToPath(new URL("../bin/crot-mcp.js", import.meta.url));
      // Electron can run the Node entry without relying on a user's PATH or guessing a Node binary.
      clipboard.writeText(
        JSON.stringify(
          {
            mcpServers: {
              crot: {
                command: process.execPath,
                args: [bin, ...(view.mcpArgs ?? ["--workspace", view.workspace])],
                env: { ELECTRON_RUN_AS_NODE: "1" },
              },
            },
          },
          null,
          2,
        ),
      );
      return true;
    }
    if (name === "ui.copyDiagnostics") {
      clipboard.writeText(JSON.stringify({ status: view.status, notes: view.remoteNotes }, null, 2));
      return true;
    }
    if (name === "ui.copyConnection") {
      if (!view.resourceUri || new URL(view.resourceUri).protocol !== "https:") return false;
      clipboard.writeText(view.resourceUri);
      return true;
    }
    if (name === "ui.openPortal" || name === "ui.openInstall") {
      const target = new URL(view.portalUrl ?? "https://relay-staging.crot.network/portal");
      if (target.protocol !== "https:" || target.username || target.password) return false;
      target.pathname = "/portal";
      target.search = "";
      target.hash = name === "ui.openInstall" ? "install" : "";
      await shell.openExternal(target.href);
      return true;
    }
    return false;
  }
  if (typeof name !== "string" || !ACTIONS.has(name) || !isRecord(params)) return false;
  switch (name) {
    case "preset.set":
      return PRESET_VALUES.includes(params.value as PresetValue)
        ? controller.setPreset(params.value as PresetValue)
        : false;
    case "remote.setMode":
      return typeof params.enabled === "boolean" ? controller.setRemoteMode(params.enabled) : false;
    case "remote.setFullControl":
      return typeof params.enabled === "boolean" ? controller.setFullControl(params.enabled) : false;
    case "remote.resetExposure": {
      const key = clientKey(params);
      return key ? controller.resetExposure(key) : false;
    }
    case "remote.revokeClient": {
      const key = clientKey(params);
      return key ? controller.revokeClient(key) : false;
    }
    case "remote.regrantClient": {
      const key = clientKey(params);
      return key ? controller.regrantClient(key) : false;
    }
    case "pairing.start":
      return controller.startPairing();
    case "pairing.cancel":
      return controller.cancelPairing();
    case "device.unpair":
      return controller.unpair();
  }
  return false;
}

function registerIpc(): void {
  ipcMain.on("ready", (event) => {
    if (!fromTray(event)) return;
    rendererReady = true;
    publish();
  });
  ipcMain.handle("decide", (event, requestId: unknown, decision: unknown) => {
    if (smokeReport || !fromTray(event) || !isId(requestId) || (decision !== "approve" && decision !== "reject"))
      return false;
    return controller.decide(requestId, decision);
  });
  ipcMain.handle("action", (event, name: unknown, params: unknown) => {
    if (smokeReport || !fromTray(event)) return false;
    return runAction(name, params);
  });
}

/** --smoke-test: wait for the service and the first render, report what the page shows, quit. */
async function smoke(file: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (Date.now() < deadline && !(rendererReady && view.connection === "connected" && view.cards.length > 0))
    await wait(100);
  await wait(300);
  const page = window
    ? ((await window.webContents.executeJavaScript(
        `({
          headline: document.getElementById("headline").textContent,
          cards: document.querySelectorAll(".card").length,
          banners: [...document.querySelectorAll(".banner")].map((b) => b.textContent),
          text: document.body.innerText,
          nodeVisible: typeof require !== "undefined" || typeof process !== "undefined",
          api: Object.keys(window.crot || {}).sort(),
          links: document.querySelectorAll("a, img, iframe, script:not([src])").length,
        })`,
      )) as Record<string, unknown>)
    : undefined;
  const report = {
    electron: process.versions.electron,
    platform: process.platform,
    connection: view.connection,
    viewCards: view.cards.length,
    page,
  };
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
}

app.on("window-all-closed", () => {
  // The tray keeps running without a window.
});
app.on("second-instance", () => showWindow());
app.on("before-quit", () => {
  quitting = true;
});

void app.whenReady().then(async () => {
  harden();
  registerIpc();
  app.dock?.hide();
  if (!smokeReport) {
    try {
      tray = new Tray(icon(ICON_COLORS.offline));
      tray.on("click", () => showWindow());
    } catch {
      // No system tray on this desktop: the window is the only surface.
      tray = undefined;
    }
  }
  createWindow();
  if (!smokeReport) showWindow();
  publish();
  void controller.start();
  if (smokeReport) {
    try {
      await smoke(smokeReport);
      controller.stop();
      app.exit(0);
    } catch (error) {
      await writeFile(smokeReport, JSON.stringify({ error: String(error) })).catch(() => undefined);
      controller.stop();
      app.exit(1);
    }
  }
});

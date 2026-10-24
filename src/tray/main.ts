import { TRAY_MARK } from "../ui/brand-tray.js";
/**
 * CROT tray (WP-22, AD-19 point 1): an Electron process that is only a
 * client of the service's authenticated control channel. Workspace screens
 * use a separate ordinary MCP client (AD-39), never control-channel execution.
 * It has no approval authority of its own; the service
 * checks every decision against the request id and the subject digest shown.
 *
 * Run with `npm run tray` (after `npm run build`) or
 * `electron dist/tray/main.js [--state-dir=<dir>]`.
 * `--smoke-test=<file>` renders once, writes a JSON report and quits; it
 * never decides anything.
 */
import { parseProduct, type ProductMethod } from "../service/product-protocol.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
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
import { TrayToolClient } from "./tool-client.js";
import { repairL1 } from "./l1-repair.js";
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

/** Master-derived template icon; status is available in tooltip and accessible UI. */
function icon(_rgb: readonly [number, number, number]): NativeImage {
  const mark = nativeImage.createFromDataURL(TRAY_MARK);
  mark.setTemplateImage(true);
  return mark;
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
    {
      label: "Emergency stop agents",
      click: () => {
        void controller
          .product("security.kill", {})
          .then((result) => {
            const r = result as { ok?: boolean; message?: string };
            dialog
              .showMessageBox({
                type: r.ok ? "info" : "warning",
                title: "Emergency stop",
                message: r.message ?? "Check the service status.",
              })
              .catch(() => undefined);
          })
          .catch(() =>
            dialog.showErrorBox(
              "Emergency stop unavailable",
              "Could not reach CrotService. Stop the service from the operating system.",
            ),
          );
      },
    },
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
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#F8FAFC",
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
  void toolClient?.close();
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
    if (name === "ui.exportDiagnostics") {
      if (smokeReport || !window) return false;
      const result = await controller.product("monitoring.exportReport", {});
      if (!isRecord(result) || result.ok !== true || !isRecord(result.report)) return false;
      const choice = await dialog.showSaveDialog(window, {
        title: "Export diagnostics",
        defaultPath: "crot-diagnostics.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (choice.canceled || !choice.filePath) return false;
      await writeFile(choice.filePath, JSON.stringify(result.report, null, 2), { mode: 0o600 });
      return true;
    }
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
    if (name === "ui.openPortal" || name === "ui.openInstall" || name === "ui.startTrial") {
      const target = new URL(view.portalUrl ?? "https://relay-staging.crot.network/portal");
      if (target.protocol !== "https:" || target.username || target.password) return false;
      target.pathname = "/portal";
      target.search = name === "ui.startTrial" ? "?intent=trial&provider=authkit" : "";
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
      return controller.startPairing(params);
    case "pairing.cancel":
      return controller.cancelPairing();
    case "device.unpair":
      return controller.unpair();
  }
  return false;
}

let repairingL1 = false;

let toolClient: TrayToolClient | undefined;

function registerIpc(): void {
  ipcMain.handle("product", async (event, method: unknown, input: unknown) => {
    if (
      smokeReport ||
      !fromTray(event) ||
      typeof method !== "string" ||
      JSON.stringify(input ?? {}).length > 256 * 1024
    )
      return { ok: false, message: "Invalid request" };
    const params = parseProduct(method, input);
    if (!params) return { ok: false, message: "Invalid request" };
    try {
      return await controller.product(method as ProductMethod, params);
    } catch {
      return { ok: false, message: "Request refused. Check service policy and connection." };
    }
  });
  ipcMain.handle("tool", async (event, name: unknown, input: unknown) => {
    if (
      smokeReport ||
      !fromTray(event) ||
      !view.workspace ||
      view.connection !== "connected" ||
      path.resolve(hostDirectories(process.env).state) !== stateDir
    )
      return { isError: true, content: [{ type: "text", text: "Service unavailable" }] };
    try {
      toolClient ??= new TrayToolClient({
        command: process.execPath,
        entry: fileURLToPath(new URL("../bin/crot-mcp.js", import.meta.url)),
        args: view.mcpArgs ?? ["--workspace", view.workspace],
      });
      return await toolClient.call(name, input);
    } catch {
      return {
        isError: true,
        content: [
          { type: "text", text: "Operation unavailable or refused. Check permissions and service connection." },
        ],
      };
    }
  });
  ipcMain.handle("repair-l1", async (event, ...args: unknown[]) => {
    if (smokeReport || !fromTray(event) || args.length || repairingL1) return { ok: false };
    repairingL1 = true;
    let completed = false;
    try {
      await repairL1({ platform: process.platform, root: fileURLToPath(new URL("../../", import.meta.url)), stateDir });
      completed = true;
    } catch {
      /* No raw installer output or filesystem details cross into the renderer. */
    }
    try {
      const checked = await controller.refreshL1();
      return {
        ok: completed && checked,
        available: checked && controller.state.overview?.confinement.available === true,
      };
    } finally {
      repairingL1 = false;
    }
  });
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
  // Exercise the same guest onboarding and notification controls as a user.
  // This harness never decides approvals or calls tools; production startup is unchanged.
  const onboarding = window
    ? await window.webContents.executeJavaScript(`(() => {
        const visible = id => !document.getElementById(id).hidden;
        const stages = { auth: visible("auth-gate") };
        if (!stages.auth) throw new Error("Smoke test must start at Auth");
        document.getElementById("local-mode").click();
        stages.plans = visible("plan-gate") && !visible("app");
        if (!stages.plans) throw new Error("Guest continuation must open Plans");
        document.getElementById("choose-free").click();
        stages.home = visible("app") && !visible("plan-gate") && !visible("auth-gate");
        if (!stages.home) throw new Error("Choosing Free must open Home");
        document.getElementById("notifications").click();
        stages.approvals = document.getElementById("action-dialog").open;
        if (!stages.approvals) throw new Error("Notifications must open the approvals dialog");
        return stages;
      })()`)
    : undefined;
  const page = window
    ? ((await window.webContents.executeJavaScript(
        `({
          headline: document.getElementById("headline").textContent,
          cards: document.querySelectorAll(".card").length,
          banners: [...document.querySelectorAll(".banner")].map((b) => b.textContent),
          text: document.body.innerText,
          nodeVisible: typeof require !== "undefined" || typeof process !== "undefined",
          api: Object.keys(window.crot || {}).sort(),
          links: document.querySelectorAll("a, iframe, script:not([src])").length,
          images: [...document.querySelectorAll("img")].map(image => image.getAttribute("src")),
        })`,
      )) as Record<string, unknown>)
    : undefined;
  const report = {
    electron: process.versions.electron,
    platform: process.platform,
    connection: view.connection,
    viewCards: view.cards.length,
    onboarding,
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

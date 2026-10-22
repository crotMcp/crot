/** Real Chromium rendering of shipped UI assets with an owner-IPC fixture.
 * Existing Electron/service and browser-bridge suites remain the integration gates.
 * No live Stripe/native installer qualification is claimed by this visual suite.
 */
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { TRAY_ASSETS } from "../dist/tray/assets.js";
import { PORTAL_HTML, PORTAL_CSS, PORTAL_SCRIPT, LANDING_HTML } from "../dist/account-service/portal.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(process.env.CROT_E2E_ARTIFACTS ?? path.join(repo, "artifacts"), "flagship-ui");
await mkdir(artifacts, { recursive: true });
const fixture = {
  connection: "connected",
  headline: "CROT is running",
  cards: [],
  status: [
    { label: "Service", value: "running, pid 4242", marks: [], length: 0 },
    { label: "Account", value: "user_01CANARY", marks: [], length: 0 },
  ],
  presets: [
    { value: "require-approval", label: "Ask for every action", selected: true, available: true },
    { value: "autonomous-browser", label: "Autonomous browser", selected: false, available: true },
    { value: "off", label: "Off (no built-in approvals)", selected: false, available: true },
  ],
  remoteMode: false,
  fullControl: false,
  fullControlNote: "RFC 9207 not advertised",
  remoteNotes: [],
  clients: [],
  pairing: { state: "unpaired", available: true, action: "pair", lines: ["user_01CANARY"] },
  commercial: { state: "current", plan: "free", status: "active", entitled: false, maxDevices: 0, deviceCount: 0 },
  modules: [
    { title: "Local service", value: "Online", ready: true },
    { title: "Browser & CDP", value: "Chrome connected", ready: true },
    { title: "L1 sandbox", value: "Setup required", ready: false, repair: true },
    { title: "Cloud tunnel", value: "Local mode", ready: false },
  ],
};
const shim = `window.fixture=${JSON.stringify(fixture)};window.actions=[];window.crot={onView(fn){window.render=fn},ready(){window.render(window.fixture)},decide:async(...args)=>{window.actions.push(args);return true},action:async(...args)=>{window.actions.push(args);return true}};window.chrome={runtime:{sendMessage:async()=>({connection:'disconnected'})},tabs:{query:async()=>[{status:'complete',windowId:1,groupId:-1}]},tabGroups:{query:async()=>[]}};`;
const inject = (html) => html.replace("<head>", '<head><script src="/ui-fixture.js"></script>');
let origin;
const server = createServer((req, res) => {
  void (async () => {
    const pathname = new URL(req.url, origin).pathname;
    let body, type;
    const key = pathname === "/control-center" ? "/index.html" : pathname;
    if (Object.hasOwn(TRAY_ASSETS, key)) {
      body = TRAY_ASSETS[key].body.replaceAll("crot-tray://app", origin);
      type = TRAY_ASSETS[key].type;
    } else if (pathname === "/ui-fixture.js") {
      body = shim;
      type = "text/javascript";
    } else if (pathname === "/portal.css") {
      body = PORTAL_CSS;
      type = "text/css";
    } else if (pathname === "/portal.js") {
      body = PORTAL_SCRIPT;
      type = "text/javascript";
    } else if (pathname === "/portal") {
      body = PORTAL_HTML;
      type = "text/html";
    } else if (pathname === "/welcome") {
      body = LANDING_HTML;
      type = "text/html";
    } else if (pathname === "/portal/config") {
      res.writeHead(503).end();
      return;
    } else if (
      [
        "/extension/popup.html",
        "/extension/popup.js",
        "/extension/welcome.html",
        "/extension/ui.css",
        "/extension/popup.css",
      ].includes(pathname)
    ) {
      body = await readFile(path.join(repo, pathname.slice(1)), "utf8");
      type = pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html";
    } else {
      res.writeHead(404).end();
      return;
    }
    if (type.startsWith("text/html")) body = inject(body);
    res
      .writeHead(200, {
        "content-type": type,
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      })
      .end(body);
  })().catch(() => res.writeHead(500).end());
});
const profile = await mkdtemp(path.join(os.tmpdir(), "crot-ui-e2e-"));
let browser, socket;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const executable = process.env.CROT_E2E_CHROME;
  if (!executable) throw new Error("CROT_E2E_CHROME must identify the qualified Chromium binary");
  browser = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      ...(process.env.CROT_E2E_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let port, route;
  const deadline = Date.now() + 15000;
  while (!port) {
    try {
      [port, route] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
    } catch {
      if (Date.now() > deadline) throw new Error("Chromium did not start");
      await delay(50);
    }
  }
  socket = new globalThis.WebSocket(`ws://127.0.0.1:${port}${route}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const m = JSON.parse(String(event.data)),
      p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    }
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      socket.send(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params = {}) => send(method, params, sessionId);
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error("UI evaluation failed: " + expression);
    return result.result.value;
  }
  async function until(expression) {
    const end = Date.now() + 15000;
    for (;;) {
      try {
        if (await evaluate(expression)) return;
      } catch {
        /* navigation changes the context */
      }
      if (Date.now() > end) throw new Error("UI condition timed out: " + expression);
      await delay(50);
    }
  }
  function assert(value, message) {
    if (!value) throw new Error(message);
  }
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const size = (width, height) =>
    call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  async function screenshot(name) {
    assert(await evaluate("document.documentElement.scrollWidth <= innerWidth"), name + " overflows");
    const { cssContentSize } = await call("Page.getLayoutMetrics");
    const { data } = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 },
    });
    await writeFile(path.join(artifacts, name + ".png"), Buffer.from(data, "base64"));
  }
  const navigate = async (pathname) => {
    await call("Page.navigate", { url: origin + pathname });
    await until("document.readyState === 'complete'");
    await delay(100);
  };
  await size(1280, 960);
  await navigate("/control-center");
  await until("document.querySelectorAll('#modules article').length === 4");
  const text = await evaluate("document.body.innerText");
  for (const value of ["user_01CANARY", "pid 4242", "RFC 9207"])
    assert(!text.includes(value), "technical details leaked: " + value);
  await screenshot("dashboard");
  await evaluate(
    "[...document.querySelectorAll('#remote button')].find(b => b.textContent === 'Turn remote mode on').click()",
  );
  assert(await evaluate("document.getElementById('paywall').open"), "Free remote request did not open paywall");
  assert(!(await evaluate("actions.some(a => a[0] === 'remote.setMode')")), "UI dispatched paid enable before upgrade");
  await screenshot("paywall");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until("!document.getElementById('paywall').open");
  for (const tab of ["capabilities", "account", "queue"]) {
    await click("tab-" + tab);
    assert(await evaluate(`!document.getElementById('${tab}').hidden`), tab + " did not open");
    await screenshot(tab);
  }
  await evaluate(
    "fixture.cards=[{requestId:'test-approval',title:'Write project file',banners:['OUTSIDE THE WORKSPACE'],rows:[{label:'Path',value:'/workspace/evil[U+202E]txt.exe',marks:['outside workspace'],length:32}],expiresAt:'2026-10-22T05:00:00Z'}];render(fixture)",
  );
  await screenshot("approval-request");
  await evaluate("document.querySelector('#approvals button').click()");
  assert(
    await evaluate("actions.some(a => a[0] === 'test-approval' && a[1] === 'approve')"),
    "approval was not delegated",
  );
  await click("tab-dashboard");
  await size(390, 844);
  await screenshot("dashboard-mobile");
  for (const [name, pathname] of [
    ["welcome", "/welcome"],
    ["portal", "/portal"],
    ["extension-welcome", "/extension/welcome.html"],
  ]) {
    await size(1280, 960);
    await navigate(pathname);
    await screenshot(name);
    await size(390, 844);
    await screenshot(name + "-mobile");
  }
  await size(380, 800);
  await navigate("/extension/popup.html");
  await until("document.getElementById('connection').textContent === 'Desktop App Not Detected'");
  await screenshot("popup");
  await writeFile(
    path.join(artifacts, "verification.json"),
    JSON.stringify(
      {
        status: "passed",
        scope:
          "real Chromium rendering with owner IPC and extension status fixtures; not live provider or native installer qualification",
      },
      null,
      2,
    ),
  );
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    const done = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill("SIGTERM");
    await done;
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

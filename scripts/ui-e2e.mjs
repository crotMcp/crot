/** Real Chromium rendering of shipped UI assets with an owner-IPC fixture.
 * Existing Electron/service and browser-bridge suites remain the integration gates.
 * No live Stripe/native installer qualification is claimed by this visual suite.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ReleaseDownloads } from "../dist/cloud-relay/downloads.js";
import { TRAY_ASSETS } from "../dist/tray/assets.js";
import { PORTAL_HTML, PORTAL_CSS, PORTAL_SCRIPT, LANDING_HTML } from "../dist/account-service/portal.js";

const serviceMode = process.argv.includes("--service");
const real = serviceMode ? await (await import("./ui-service-harness.mjs")).serviceHarness() : undefined;
const repo = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(
  process.env.CROT_E2E_ARTIFACTS ?? path.join(repo, "artifacts"),
  serviceMode ? "service-ui" : "flagship-ui",
);
await mkdir(artifacts, { recursive: true });
const fixture = {
  workspace: "/workspace/project",
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
  agents: { stdio: 1, httpSessions: 0, remoteClients: 0 },
  browser: { state: "connected", name: "Chromium" },
  modules: [
    { title: "Local service", value: "Online", ready: true },
    { title: "Browser & CDP", value: "Chrome connected", ready: true },
    { title: "L1 sandbox", value: "Setup required", ready: false, repair: true },
    { title: "Cloud tunnel", value: "Local mode", ready: false },
  ],
};
const shim = `window.fixture=${JSON.stringify(fixture)};window.actions=[];window.crot={product:async(name,input={})=>{window.actions.push([name,input]);const p={id:'fixture-project',name:'project',path:'/workspace/project',favorite:false,tools:[],agents:[],connectors:[]};return {ok:true,...(name==='projects.list'?{projects:[p],active:p.id}:name==='connectors.list'?{connectors:[]}:name==='mcpServers.list'?{servers:[]}:name==='agents.list'?{agents:[],calls:[]}:name==='tasks.list'?{tasks:[]}:name==='monitoring.queryAudit'?{events:[]}:name==='monitoring.metrics'?{tasks:{running:0,total:0},workspace:p.id,connectedServers:0}:{})}},tool:async(name,input)=>{window.actions.push([name,input]);return {content:[{type:"text",text:JSON.stringify(name==="fs_list_directory"?{entries:[{path:"README.md",type:"file"}]}:name==="fs_stat"?{exists:true,type:"directory"}:name==="fs_read_file"?{content:"# Test project"}:name==="browser_tabs_list"?{tabs:[{id:42,title:"Test tab",url:"https://example.test"}]}:{ok:true})}]}},repairL1:async()=>{window.actions.push(["repair-l1"]);return {ok:true,available:false}},onView(fn){window.render=fn},ready(){window.render(window.fixture)},decide:async(...args)=>{window.actions.push(args);return true},action:async(...args)=>{window.actions.push(args);return true}};window.chrome={runtime:{getURL:p=>'/extension/'+p,sendMessage:async(m)=>{window.actions.push(['extension',m.type]);return m.type==='crot.ui.openApp'?{ok:true}:{connection:'disconnected'}}},tabs:{create:async(o)=>{window.actions.push(['tab',o.url]);return o},query:async()=>[{status:'complete',windowId:1,groupId:-1}]},tabGroups:{query:async()=>[]}};`;
const inject = (html) => html.replace("<head>", '<head><script src="/ui-fixture.js"></script>');
let origin;
const downloads = new ReleaseDownloads({ origin: "https://relay-staging.crot.network" });
const server = createServer((req, res) => {
  void (async () => {
    const pathname = new URL(req.url, origin).pathname;
    if (real && (await real.handle(req, res, pathname))) return;
    if (await downloads.handle(req, res, pathname)) return;
    let body, type;
    const key = pathname === "/control-center" ? "/index.html" : pathname;
    if (Object.hasOwn(TRAY_ASSETS, key)) {
      body = TRAY_ASSETS[key].body.replaceAll("crot-tray://app", origin);
      if (real) body = body.replace("connect-src 'none'", "connect-src 'self'"); // Test IPC bridge only; production keeps network denied.
      type = TRAY_ASSETS[key].type;
    } else if (pathname === "/ui-fixture.js") {
      body = real ? real.shim : shim;
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
        "/extension/popup-geometry.css",
        "/extension/i18n.js",
        "/extension/welcome.js",
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
        "content-security-policy": `default-src 'none'; script-src 'self'; img-src data:; style-src 'self' 'sha256-${createHash("sha256").update(PORTAL_CSS).digest("base64")}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      })
      .end(body);
  })().catch(() => res.writeHead(500).end());
});
const profile = await mkdtemp(path.join(os.tmpdir(), "crot-ui-e2e-"));
let browser, socket;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  if (real) await real.start(origin);
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
  const runtimeErrors = [];
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const m = JSON.parse(String(event.data)),
      p = pending.get(m.id);
    if (m.method === "Runtime.exceptionThrown") runtimeErrors.push(m.params.exceptionDetails.text);
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
  await call("Runtime.enable");
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
      if (Date.now() > end)
        throw new Error(
          "UI condition timed out: " +
            expression +
            "\n" +
            JSON.stringify(
              await evaluate("({text:document.body.innerText,errors:" + JSON.stringify(runtimeErrors) + "})"),
            ),
        );
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
  if (real) {
    await (
      await import("./ui-service-scenarios.mjs")
    ).runServiceScenarios({ real, call, evaluate, until, size, screenshot, navigate, artifacts });
  } else if (process.argv.includes("--onboarding")) {
    await (
      await import("./ui-onboarding-scenarios.mjs")
    ).runOnboardingScenarios({ evaluate, until, size, screenshot, navigate, assert });
    if (runtimeErrors.length) throw new Error(JSON.stringify(runtimeErrors));
  } else {
    await (
      await import("./ui-onboarding-scenarios.mjs")
    ).runOnboardingScenarios({ evaluate, until, size, screenshot, navigate, assert });
    const route = async (name) => {
      const slug = name.toLowerCase().replaceAll(" ", "-");
      if (
        !(await evaluate(`!!document.getElementById('nav-${slug}')&&!document.getElementById('nav-${slug}').hidden`))
      ) {
        if (!(await evaluate(`!!document.getElementById('tool-${slug}')`))) await click("nav-projects");
        await click("tool-" + slug);
      } else await click("nav-" + slug);
    };
    await evaluate(
      "window.CrotI18n.setLanguage('en');const s=document.getElementById('global-search');s.value='GitHub';s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))",
    );
    await until("document.querySelector('#action-dialog .search-result')?.textContent.includes('GitHub')");
    await evaluate("document.getElementById('action-dialog').close()");
    const sections = [
      "Home",
      "Projects",
      "Agents",
      "Connectors",
      "MCP Servers",
      "Browser",
      "Files",
      "Terminal",
      "Git",
      "Docker",
      "Tasks",
      "Monitoring",
      "Settings",
    ];
    for (const lang of ["en", "ru"]) {
      await evaluate(`window.CrotI18n.setLanguage('${lang}')`);
      for (const section of sections) {
        const slug = section.toLowerCase().replaceAll(" ", "-");
        await route(section);
        assert(
          await evaluate(
            `(document.getElementById('tool-${slug}')||document.getElementById('nav-${slug}')).getAttribute('aria-current')==='page'`,
          ),
          section + " not active",
        );
        assert(await evaluate("document.querySelector('#page h1')!==null"), "missing page heading: " + section);
        if (section === "Projects") {
          assert(
            await evaluate("document.querySelectorAll('[data-project-tab]').length===7"),
            "project must have seven tabs",
          );
          for (const tab of ["Overview", "Files", "Git", "Tasks", "Agents", "Connectors", "Settings"]) {
            await evaluate(`document.querySelector('[data-project-tab="${tab}"]').click()`);
            assert(
              await evaluate(
                `document.querySelector('[data-project-tab="${tab}"]').getAttribute('aria-selected')==='true'`,
              ),
              "project tab failed: " + tab,
            );
          }
          await evaluate("document.querySelector('[data-project-tab=Overview]').click()");
        }
        if (section === "Browser")
          assert(
            await evaluate("document.querySelectorAll('#browser-workspace>.panel').length===3"),
            "browser must have three columns",
          );
        if (section === "Settings") {
          assert(
            await evaluate("document.querySelectorAll('[data-setting]').length===11"),
            "settings must have eleven sections",
          );
          for (const setting of [
            "General",
            "Device & Account",
            "Remote Access",
            "Security",
            "Permissions",
            "Browser",
            "Network",
            "Integrations",
            "MCP",
            "Updates & Diagnostics",
            "About",
          ]) {
            await evaluate(`document.querySelector('[data-setting="${setting}"]').click()`);
            assert(
              await evaluate(
                `document.querySelector('[data-setting="${setting}"]').getAttribute('aria-selected')==='true'`,
              ),
              "settings navigation failed: " + setting,
            );
          }
          await evaluate("document.querySelector('[data-setting=General]').click()");
        }
        await delay(80);
        if (lang === "en" || ["Home", "Projects", "Connectors", "Browser", "Settings"].includes(section))
          await screenshot(slug + "-" + lang);
      }
    }
    await evaluate("window.CrotI18n.setLanguage('en')");
    await click("nav-agents");
    await evaluate(
      "[...document.querySelectorAll('#page button')].find(b=>b.textContent==='Copy configuration').click()",
    );
    assert(await evaluate("actions.some(a=>a[0]==='ui.copyConfig')"), "config copy not delegated");
    await click("nav-home");
    await evaluate(
      "fixture.cards=[{requestId:'test-approval',title:'Write project file',banners:['OUTSIDE THE WORKSPACE'],rows:[{label:'Path',value:'/workspace/evil[U+202E]txt.exe',marks:['outside workspace'],length:32}],expiresAt:'2026-10-22T05:00:00Z'}];render(fixture)",
    );
    await click("notifications");
    await screenshot("approval-request");
    await evaluate(
      "window.approvalButton=document.querySelector('#approvals button');approvalButton.focus();render(fixture);render(fixture)",
    );
    assert(
      await evaluate(
        "approvalButton===document.querySelector('#approvals button')&&document.activeElement===approvalButton",
      ),
      "polling replaced approval focus",
    );
    await evaluate("document.querySelector('#approvals button').click()");
    assert(await evaluate("actions.some(a=>a[0]==='test-approval'&&a[1]==='approve')"), "approval not delegated");
    await evaluate("document.getElementById('action-dialog').close()");
    await route("Settings");
    await evaluate("document.querySelector('[data-setting=Security]').click()");
    await evaluate(
      "[...document.querySelectorAll('#page button')].find(b=>b.textContent==='Enable Full Control').click()",
    );
    assert(
      await evaluate("document.getElementById('action-dialog').open"),
      "dangerous change must require confirmation",
    );
    assert(
      !(await evaluate("actions.some(a=>a[0]==='remote.setFullControl')")),
      "dangerous change dispatched before confirmation",
    );
    await evaluate("[...document.querySelectorAll('#action-dialog button')].find(b=>b.textContent==='Cancel').click()");
    await click("nav-home");
    await size(1180, 780);
    await screenshot("home-minimum-desktop");
    assert(
      await evaluate(
        "document.documentElement.scrollHeight<=document.documentElement.clientHeight&&document.querySelectorAll('#navigation>[data-section]').length===5",
      ),
      "minimum desktop viewport failed",
    );
    await route("Browser");
    await screenshot("browser-minimum-desktop");
    await size(1280, 820);
    for (const [name, pathname] of [
      ["welcome", "/welcome"],
      ["portal", "/portal"],
      ["extension-welcome", "/extension/welcome.html"],
    ]) {
      await size(1280, 960);
      await navigate(pathname);
      assert(
        await evaluate("getComputedStyle(document.documentElement).backgroundColor === 'rgb(9, 9, 11)'"),
        name + " must render the shipped Zinc theme under CSP",
      );
      await screenshot(name);
      for (const language of ["ru", "es", "de", "zh", "en"]) {
        await evaluate(`window.CrotI18n.setLanguage(${JSON.stringify(language)})`);
        assert(
          await evaluate(`document.documentElement.lang===${JSON.stringify(language)}`),
          "language not applied: " + language,
        );
      }
      if (name === "extension-welcome") {
        await click("open-app");
        await click("refresh");
        assert(
          await evaluate("actions.some(a=>a[0]==='extension'&&a[1]==='crot.ui.openApp')"),
          "welcome did not open native app",
        );
        await evaluate("document.querySelector('a[href*=portal]').click()");
        assert(
          await evaluate("actions.some(a=>a[0]==='tab'&&a[1]==='https://relay-staging.crot.network/portal')"),
          "welcome portal target is not absolute",
        );
      }
      await size(390, 844);
      await screenshot(name + "-mobile");
    }
    const attachment = await globalThis.fetch(origin + "/download/linux");
    assert(
      attachment.status === 200 && attachment.headers.get("content-disposition").includes("attachment"),
      "download endpoint must return an installer attachment",
    );
    const installer = await attachment.text();
    assert(
      installer.includes("/download/bundle/linux") && installer.includes("checksum mismatch"),
      "bootstrap must verify a real release bundle",
    );
    await size(380, 520);
    await navigate("/extension/popup.html");
    await until("document.getElementById('connection').textContent === 'Desktop App Not Detected'");
    assert(
      await evaluate(
        "[document.documentElement,document.body].every(e=>e.getBoundingClientRect().width===380&&e.getBoundingClientRect().height===520)",
      ),
      "popup geometry differs from 380x520",
    );
    await evaluate("window.popupNode=document.getElementById('connection')");
    await click("refresh");
    await delay(100);
    assert(
      await evaluate(
        "popupNode===document.getElementById('connection')&&document.body.getBoundingClientRect().height===520",
      ),
      "popup refresh replaced skeleton or size",
    );
    for (const id of ["open-app", "account", "download", "guide"]) await click(id);
    await delay(100);
    assert(
      await evaluate("actions.some(a=>a[0]==='extension'&&a[1]==='crot.ui.openApp')"),
      "popup native app action missing",
    );
    assert(
      await evaluate("actions.some(a=>a[0]==='tab'&&a[1]==='https://relay-staging.crot.network/portal')"),
      "popup account target missing",
    );
    assert(
      await evaluate("actions.some(a=>a[0]==='tab'&&a[1]==='https://relay-staging.crot.network/download/linux')"),
      "installer button must target the real absolute OS download route",
    );
    await screenshot("popup");
    await evaluate("window.CrotI18n.setLanguage('ru')");
    assert(
      await evaluate("document.getElementById('open-app').textContent==='Открыть приложение CROT'"),
      "Russian popup action missing",
    );
    await screenshot("popup-ru");
    await evaluate("window.CrotI18n.setLanguage('en')");
    assert(runtimeErrors.length === 0, "browser exceptions: " + runtimeErrors.join(", "));
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
  }
} finally {
  await real?.close();
  socket?.close();
  if (browser && browser.exitCode === null) {
    const done = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill("SIGTERM");
    await done;
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

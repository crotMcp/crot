/* global Buffer, WebSocket, console, process, setTimeout, clearTimeout */
/**
 * Isolated AD-33 feasibility witness, NOT the production BrowserService E2E.
 * Node >=24 (stripTypeScriptTypes), CROT_E2E_CHROME or chromium on PATH.
 * Only a local HTTP fixture and an empty throw-away browser profile are used.
 * No Browser.setDownloadBehavior, global filename override or network replay.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = await readFile(path.join(root, "extension/src/download-ownership.ts"), "utf8");
const compiled = stripTypeScriptTypes(source, { mode: "transform" });
const sourceHash = createHash("sha256").update(source).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const body = Buffer.from("WP26 exact ownership local binary fixture\0\xff", "latin1");

const background = `
import { DownloadOwnership } from './download-ownership.js';
const ledger = new DownloadOwnership();
const events = [];
const ready = [];
let capture;
let pending;
const patterns = [{urlPattern:'http://*',resourceType:'Document',requestStage:'Response'}];
const send = (target,method,params={}) => chrome.debugger.sendCommand(target,method,params);
const recordError = e => events.push({kind:'error',message:String(e)});
function finishSuggestion() {
  const owned = ledger.proved();
  if (!owned || !pending || owned.downloadId !== pending.id) return;
  const current = pending;
  pending = undefined;
  events.push({kind:'override',id:current.id});
  current.suggest({filename:capture.prefix+'-'+owned.originalName,conflictAction:'uniquify'});
}
chrome.debugger.onEvent.addListener((target,method,p) => {
  if (!capture || target.tabId !== capture.tabId) return;
  void (async () => {
    if (method === 'Target.attachedToTarget' && p.targetInfo.type === 'iframe') {
      const child = {tabId:target.tabId,sessionId:p.sessionId};
      const initialized = (async () => {await send(child,'Page.enable');await send(child,'Fetch.enable',{patterns});})();
      ready.push(initialized);
      await initialized;
    }
    if (method === 'Fetch.requestPaused') {
      const disposition=(p.responseHeaders||[]).filter(h=>h.name.toLowerCase()==='content-disposition');
      if (disposition.length !== 1 || p.responseStatusCode !== 200) {
        await send(target,'Fetch.continueRequest',{requestId:p.requestId});
        return;
      }
      const marked=ledger.mark(p.frameId,target.sessionId,p.requestId,disposition[0].value);
      events.push({kind:'marked',frameId:p.frameId,sessionId:target.sessionId});
      const headers=p.responseHeaders.filter(h=>h.name.toLowerCase()!=='content-disposition');
      headers.push({name:'Content-Disposition',value:marked.header});
      await send(target,'Fetch.continueResponse',{requestId:p.requestId,responseCode:p.responseStatusCode,responseHeaders:headers});
    }
    if (method === 'Page.downloadWillBegin') {
      if (ledger.begin(p.frameId,target.sessionId,p.guid,p.suggestedFilename)) {
        events.push({kind:'begin',guid:p.guid,frameId:p.frameId,sessionId:target.sessionId});
        finishSuggestion();
      }
    }
    if (method === 'Page.downloadProgress') events.push({kind:'progress',guid:p.guid,state:p.state});
  })().catch(recordError);
});
chrome.downloads.onDeterminingFilename.addListener((item,suggest) => {
  try {
    const status=ledger.item(item.id,item.filename);
    events.push({kind:'filename',id:item.id,status});
    if (status === 'unrelated') {suggest();return;}
    pending={id:item.id,suggest};
    finishSuggestion();
    return true;
  } catch (e) {recordError(e);suggest();}
});
globalThis.arm=async (tabId,prefix) => {
  capture={tabId,prefix};
  await chrome.debugger.attach({tabId},'1.3');
  await send({tabId},'Page.enable');
  await send({tabId},'Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  await Promise.all(ready);
  await send({tabId},'Fetch.enable',{patterns});
};
globalThis.witness=async () => ({events,proved:ledger.proved(),items:await chrome.downloads.search({})});
`;

async function scenario(oop, trigger = "click", redirect = false) {
  const base = await mkdtemp(path.join(tmpdir(), "crot-od8-witness-"));
  const profile = path.join(base, "profile");
  const extension = path.join(base, "extension");
  const downloads = path.join(base, "downloads");
  for (const p of [extension, downloads, path.join(profile, "Default")]) await mkdir(p, { recursive: true });
  await writeFile(
    path.join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "CROT OD8 isolated witness",
      version: "1.0",
      permissions: ["debugger", "downloads", "tabs"],
      host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
      background: { service_worker: "background.js", type: "module" },
    }),
  );
  await writeFile(path.join(extension, "background.js"), background);
  await writeFile(path.join(extension, "download-ownership.js"), compiled);
  await writeFile(
    path.join(profile, "Default/Preferences"),
    JSON.stringify({
      download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
    }),
  );
  let fixtureOrigin;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/file", "Cache-Control": "no-store" });
      res.end();
    } else if (req.url === "/file") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="same.bin"',
        "Cache-Control": "no-store",
      });
      res.write(body.subarray(0, 8));
      setTimeout(() => res.end(body.subarray(8)), 500);
    } else {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(
        oop && req.url === "/owned"
          ? '<iframe style="width:400px;height:200px" src="' +
              fixtureOrigin.replace("127.0.0.1", "localhost") +
              '/frame"></iframe>'
          : '<a style="display:block;width:250px;height:60px" href="/file">Download fixture</a>',
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixtureOrigin = "http://127.0.0.1:" + server.address().port;
  let browser;
  let ws;
  let diagnostic = "";
  const waiting = new Map();
  try {
    browser = spawn(
      process.env.CROT_E2E_CHROME || "chromium",
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--site-per-process",
        "--host-resolver-rules=MAP localhost 127.0.0.1",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--user-data-dir=" + profile,
        "--load-extension=" + extension,
        "--disable-extensions-except=" + extension,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    browser.on("error", (e) => {
      diagnostic += String(e);
    });
    browser.stderr.on("data", (data) => {
      diagnostic = (diagnostic + data).slice(-12000);
    });
    let endpoint;
    for (let n = 0; n < 100; n++) {
      try {
        endpoint = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
        break;
      } catch {
        /* Browser startup is polled with a fixed deadline. */
      }
      await delay(100);
    }
    assert.ok(endpoint, "Chromium failed to start: " + diagnostic);
    ws = new WebSocket("ws://127.0.0.1:" + endpoint[0] + endpoint[1]);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let next = 0;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const promise = waiting.get(message.id);
      if (!promise) return;
      waiting.delete(message.id);
      clearTimeout(promise.timer);
      if (message.error) promise.reject(Error(message.error.message));
      else promise.resolve(message.result);
    };
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(Error("CDP deadline: " + method));
        }, 10000);
        waiting.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      });
    const evaluate = async (sessionId, expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    let session;
    const inspected = new Set();
    for (let n = 0; n < 60 && !session; n++) {
      const targets = (await send("Target.getTargets")).targetInfos;
      for (const worker of targets.filter(
        (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && !inspected.has(t.targetId),
      )) {
        const { sessionId } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
        await delay(250);
        const name = await evaluate(
          sessionId,
          "typeof chrome==='undefined' ? null : chrome.runtime.getManifest().name",
        ).catch(() => null);
        if (name === "CROT OD8 isolated witness") {
          session = sessionId;
          break;
        }
        if (name !== null) inspected.add(worker.targetId);
        await send("Target.detachFromTarget", { sessionId });
      }
      if (!session) await delay(150);
    }
    assert.ok(session, "Witness extension was not loaded: " + diagnostic);
    const evaluateWorker = (expression) => evaluate(session, expression);
    const tabs = await evaluateWorker(
      `Promise.all([chrome.tabs.create({url:${JSON.stringify(fixtureOrigin + "/owned")},active:true}),chrome.tabs.create({url:${JSON.stringify(fixtureOrigin + "/foreign")},active:false})]).then(ts=>ts.map(t=>t.id))`,
    );
    await delay(1000);
    const prefix = "staging-" + randomBytes(24).toString("hex");
    await evaluateWorker(`arm(${tabs[0]},${JSON.stringify(prefix)})`);
    const downloadUrl =
      (oop ? fixtureOrigin.replace("127.0.0.1", "localhost") : fixtureOrigin) + (redirect ? "/redirect" : "/file");
    // Foreign candidate is deliberately created first, with the IDENTICAL URL.
    await evaluateWorker(`chrome.tabs.update(${tabs[1]},{url:${JSON.stringify(downloadUrl)}})`);
    await evaluateWorker(`chrome.tabs.update(${tabs[0]},{active:true})`);
    await delay(100);
    const click = { x: 40, y: 35 };
    if (trigger === "url") {
      await evaluateWorker(`chrome.tabs.update(${tabs[0]},{url:${JSON.stringify(downloadUrl)}})`);
    } else
      await evaluateWorker(
        `chrome.debugger.sendCommand({tabId:${tabs[0]}},'Input.dispatchMouseEvent',{type:'mousePressed',x:${click.x},y:${click.y},button:'left',clickCount:1}).then(()=>chrome.debugger.sendCommand({tabId:${tabs[0]}},'Input.dispatchMouseEvent',{type:'mouseReleased',x:${click.x},y:${click.y},button:'left',clickCount:1}))`,
      );
    let result;
    for (let n = 0; n < 100; n++) {
      result = await evaluateWorker("witness()");
      if (result.events.some((e) => e.kind === "error"))
        throw Error(JSON.stringify(result.events.filter((e) => e.kind === "error")));
      if (result.items.length === 2 && result.items.every((i) => i.state === "complete")) break;
      await delay(100);
    }
    assert.equal(result.items.length, 2, "Expected two real browser downloads");
    assert.ok(result.items.every((i) => i.state === "complete" && i.danger === "safe"));
    assert.equal(result.items[0].url, result.items[1].url, "URLs must be identical even for OOP frames");
    const overrides = result.events.filter((e) => e.kind === "override");
    assert.equal(overrides.length, 1, "Only one filename callback may receive a filename override");
    assert.ok(result.proved?.guid);
    assert.equal(overrides[0].id, result.proved.downloadId);
    const owned = result.items.find((i) => i.id === result.proved.downloadId);
    const foreign = result.items.find((i) => i.id !== result.proved.downloadId);
    assert.equal(path.basename(owned.filename), prefix + "-same.bin");
    assert.equal(path.basename(foreign.filename), "same.bin");
    assert.ok(result.events.some((e) => e.kind === "filename" && e.id === foreign.id && e.status === "unrelated"));
    assert.ok(
      result.events.some((e) => e.kind === "progress" && e.guid === result.proved.guid && e.state === "completed"),
    );
    const begin = result.events.find((e) => e.kind === "begin");
    assert.equal(Boolean(begin.sessionId), oop, "OOP witness must actually use a child debugger session");
    assert.equal(requests.filter((p) => p === "/file").length, 2, "No replay/re-fetch of either response is allowed");
    // Only read the proved item. The foreign item's bytes are intentionally NOT read.
    assert.deepEqual(await readFile(owned.filename), body);
    console.log(
      JSON.stringify({
        case: oop ? "oop-frame-click" : "top-frame-" + trigger + (redirect ? "-redirect" : ""),
        sameUrl: true,
        foreignOverride: false,
        exactGuidAndId: true,
        bodyVerified: true,
        sourceHash,
      }),
    );
  } finally {
    for (const promise of waiting.values()) {
      clearTimeout(promise.timer);
      promise.reject(Error("Witness shutting down"));
    }
    waiting.clear();
    ws?.close();
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const ended = new Promise((resolve) => browser.once("exit", resolve));
      browser.kill("SIGTERM");
      const force = setTimeout(() => browser.kill("SIGKILL"), 4000);
      await ended;
      clearTimeout(force);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // Whole profile is owned by this TEST, never a user's browser profile.
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
await scenario(false);
await scenario(true);

await scenario(false, "url");
await scenario(false, "url", true);

/* global process, console, setTimeout, clearTimeout, Buffer, URL */
// Drives a real Chromium-family browser over the DevTools protocol (--remote-debugging-pipe),
// with no dependency: run INSIDE the L1 sandbox by l1-integration.test.ts. Serves two pages on
// 127.0.0.1, then: a new page, navigation, typing, a mouse click that navigates, the DOM, and
// Browser.close with the browser's exit status. Prints one JSON line with the results.
//   node browser-cdp.mjs <browser> <user-data-dir> [extra browser flags...]
import { spawn } from "node:child_process";
import http from "node:http";

const [browser, profile, ...extra] = process.argv.slice(2);
const pages = {
  "/": "<!doctype html><title>one</title><input id=i><button id=b style='width:200px;height:80px' onclick=\"location.href='/two?v='+encodeURIComponent(i.value)\">go</button>",
  "/two": "<!doctype html><title>two</title><p id=x>crot-l1</p>",
};
const server = http.createServer((req, res) => {
  const page = pages[new URL(req.url, "http://x").pathname];
  res.writeHead(page ? 200 : 404, { "content-type": "text/html" }).end(page ?? "");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const child = spawn(
  browser,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    ...extra,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
);
let stderr = "";
child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));

let id = 0;
const waiting = new Map();
const listeners = [];
let buffer = Buffer.alloc(0);
child.stdio[4].on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (let end; (end = buffer.indexOf(0)) >= 0;) {
    const msg = JSON.parse(buffer.subarray(0, end).toString("utf8"));
    buffer = buffer.subarray(end + 1);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else for (const l of listeners.splice(0)) l(msg);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, { resolve, reject });
    child.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
const event = (method, sessionId) =>
  new Promise((resolve) => {
    const listen = (msg) => {
      if (msg.method === method && msg.sessionId === sessionId) resolve(msg.params);
      else listeners.push(listen);
    };
    listeners.push(listen);
  });

const result = { origin };
const timer = setTimeout(() => {
  console.log(JSON.stringify({ ...result, error: "timeout", stderr }));
  child.kill("SIGKILL");
  process.exit(2);
}, 90_000);
try {
  result.version = (await send("Browser.getVersion")).product;
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, s);
  const evaluate = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true }, s)).result.value;
  // Navigation.
  let loaded = event("Page.loadEventFired", s);
  await send("Page.navigate", { url: `${origin}/` }, s);
  await loaded;
  result.firstTitle = await evaluate("document.title");
  // Typing (the browser's input pipeline).
  await evaluate("document.getElementById('i').focus()");
  await send("Input.insertText", { text: "typed" }, s);
  result.typed = await evaluate("document.getElementById('i').value");
  // A real mouse click on the button navigates to the second page.
  const box = await evaluate("JSON.stringify(document.getElementById('b').getBoundingClientRect())");
  const { x, y, width, height } = JSON.parse(box);
  loaded = event("Page.loadEventFired", s);
  for (const type of ["mousePressed", "mouseReleased"])
    await send(
      "Input.dispatchMouseEvent",
      { type, x: x + width / 2, y: y + height / 2, button: "left", clickCount: 1 },
      s,
    );
  await loaded;
  result.url = await evaluate("location.pathname + location.search");
  // The DOM.
  const { root } = await send("DOM.getDocument", {}, s);
  result.dom = (await send("DOM.getOuterHTML", { nodeId: root.nodeId }, s)).outerHTML;
  await send("Browser.close");
  result.exit = await exited;
} catch (error) {
  result.error = String(error);
  result.stderr = stderr;
  child.kill("SIGKILL");
  result.exit = await exited;
}
clearTimeout(timer);
server.close();
console.log(JSON.stringify(result));
process.exit(0);

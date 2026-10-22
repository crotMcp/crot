/** Real Chromium executes the shipped portal script, OAuth PKCE and owner revocation (no DOM mock). */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { AccountService } from "../../src/account-service/service.js";
import { RelayHarness } from "../../tests/cloud-relay/harness.js";
import { TEST_RELAY } from "../../tests/identity/test-authorization-server.js";
import { chromeExecutable } from "./harness.js";

it("WP-36 real Chromium portal: PKCE login, checkout failure stays Free, verified fixture trial, device/client list, remote revoke and no token persistence", async () => {
  const profile = await mkdtemp("/tmp/crot-portal-");
  const accounts = new AccountService();
  const h = new RelayHarness();
  const portalClient = "client_portal";
  let origin = "",
    chrome: ChildProcess | undefined,
    ws: WebSocket | undefined;
  const proxy = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url!, h.as.issuer);
      if (u.pathname === "/oauth2/authorize") {
        res.writeHead(302, { location: h.as.authorize(u.href, { sub: "user_01", iss: h.as.issuer }).redirect }).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (u.pathname === "/oauth2/token") {
        const r = await h.as.fetch(u, { method: "POST", body: Buffer.concat(chunks).toString() });
        res.writeHead(r.status, Object.fromEntries(r.headers)).end(await r.text());
        return;
      }
      const r = await fetch(h.origin + req.url, {
        method: req.method,
        headers: {
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
        },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        redirect: "manual",
      });
      res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
    })().catch(() => res.writeHead(500).end());
  });
  try {
    await h.start({
      accounts,
      portalClientIds: [portalClient],
      portalMetadata: async () => ({
        issuer: h.as.issuer,
        authorizationEndpoint: origin + "/oauth2/authorize",
        tokenEndpoint: origin + "/oauth2/token",
        jwksUri: h.as.issuer + "/jwks",
        s256: true,
        issParameterSupported: true,
      }),
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    h.as.registerPortal(portalClient, origin + "/portal/callback");
    chrome = spawn(
      chromeExecutable(),
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
    let port = "",
      route = "";
    const start = Date.now();
    while (!port && Date.now() - start < 10000) {
      try {
        [port, route] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n") as [
          string,
          string,
        ];
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(port).not.toBe("");
    ws = new WebSocket(`ws://127.0.0.1:${port}${route}`);
    await new Promise<void>((resolve, reject) => {
      ws!.addEventListener("open", () => resolve());
      ws!.addEventListener("error", () => reject(new Error("DevTools unavailable")));
    });
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as { id: number; result: unknown; error?: { message: string } };
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      }
    });
    const send = <T>(method: string, params: object = {}, sessionId?: string) =>
      new Promise<T>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async <T>(expression: string) => {
      const r = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      if (r.exceptionDetails) throw new Error("portal script failed");
      return r.result.value;
    };
    const until = async (expression: string) => {
      const deadline = Date.now() + 15000;
      for (;;) {
        try {
          if (await evaluate<boolean>(expression)) return;
        } catch {
          /* navigation invalidates the old execution context */
        }
        if (Date.now() > deadline)
          throw new Error(
            "Portal condition timed out: " + expression + " body=" + (await evaluate("document.body.innerText")),
          );
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await send("Page.navigate", { url: origin + "/portal" }, sessionId);
    await until(
      "!!document.getElementById('signin') && typeof document.getElementById('signin').onclick === 'function'",
    );
    await until("!document.getElementById('signin').disabled");
    expect(await evaluate("getComputedStyle(document.documentElement).backgroundColor")).toBe("rgb(9, 9, 11)");
    await evaluate("document.getElementById('signin').click()");
    await until("document.getElementById('plan')?.textContent === 'free · active'");
    expect(await evaluate("location.search")).toBe("");
    await evaluate("document.getElementById('trial').click()");
    await until("document.getElementById('notice')?.textContent.includes('Request refused')");
    expect(accounts.snapshot("user_01").entitled).toBe(false);
    // No live card flow is claimed: this test uses a trusted provider fixture after checking failure closed.
    await accounts.billing(
      {
        checkout: async () => "https://checkout.stripe.com/test",
        verifyAndResolve: async () => ({
          eventId: "evt_portal_trial",
          accountId: "user_01",
          subscriptionId: "sub_portal_trial",
          plan: "trial",
          status: "active",
          expiresAt: Date.now() + 7 * 86400000,
        }),
      },
      Buffer.from("{}"),
      "fixture",
    );
    await evaluate("document.getElementById('refresh').click()");
    await until("document.getElementById('plan')?.textContent === 'trial · active'");
    const p = h.newDevice();
    await h.register(p);
    const device = await h.online(p);
    await accounts.noteClient("user_01", p.deviceId, "client_portal_test", "session_TEST");
    await evaluate("document.getElementById('refresh').click()");
    await until("document.getElementById('devices')?.textContent.includes('client_portal_test')");
    // Confirm the user action in the browser, not by calling the API from the test.
    await evaluate("window.confirm = () => true; document.querySelector('#devices button').click()");
    await until("document.getElementById('notice')?.textContent === 'Device revoked.'");
    expect(await device.whenClosed()).toMatchObject({ code: 4403 });
    expect(await h.registry.get(p.deviceId)).toBeUndefined();
    expect(await evaluate("JSON.stringify(localStorage) + JSON.stringify(sessionStorage)")).not.toContain(
      "access_token",
    );
    expect(await evaluate("sessionStorage.getItem('crot-oauth')")).toBeNull();
    expect(h.logText()).not.toContain("session_TEST");
    expect(h.logText()).not.toContain("Bearer");
    expect(h.as.requests.token).toBe(1);
    expect(accounts.snapshot("user_01")).toMatchObject({ plan: "trial", deviceCount: 0 });
    expect(TEST_RELAY).toBe(h.as.relayHost);
  } finally {
    ws?.close();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise<void>((r) => chrome!.once("exit", () => r()));
      chrome.kill("SIGTERM");
      const timer = setTimeout(() => chrome!.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    }
    await new Promise<void>((r) => proxy.close(() => r()));
    await h.stop();
    // Chromium helpers may finish profile writes just after the parent exits.
    // Retry only filesystem cleanup; do not retry or mask any portal assertion.
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

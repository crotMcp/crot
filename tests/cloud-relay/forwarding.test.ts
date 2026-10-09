import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OUTCOME_HEADER } from "../../src/tunnel/protocol.js";
import { RelayHarness, sleep, waitFor } from "./harness.js";
import type { DeviceStream } from "./test-device.js";

/**
 * WP-29 / AD-22 points 6, 7, 11–13 and AD-21 point 7: admission, routing to
 * the right device, unchanged forwarding, limits, deadlines, cancellation
 * and explicit outcomes; the relay never retries.
 */

let h: RelayHarness;
afterEach(async () => {
  await h.stop();
});

const start = async (options: Parameters<RelayHarness["start"]>[0] = {}) => {
  h = await new RelayHarness().start(options);
};

const answer =
  (body: string, status = 200) =>
  (s: DeviceStream) => {
    void s.bodyDone().then(() => {
      s.respond(status, [["content-type", "application/json"]]);
      void s.write(Buffer.from(body), true);
    });
  };

async function errorOf(res: Response) {
  const body = (await res.json()) as { id: unknown; error: { data: { crot: string; outcome: string } } };
  return { status: res.status, outcome: res.headers.get(OUTCOME_HEADER), crot: body.error.data.crot, id: body.id };
}

describe("admission (AD-21 point 7)", () => {
  it("routes each request to its own device only", async () => {
    await start();
    const a = await h.ready({ onOpen: answer('{"device":"a"}') });
    const b = await h.ready({ onOpen: answer('{"device":"b"}') });
    expect(await (await h.post(a.paired)).json()).toEqual({ device: "a" });
    expect(await (await h.post(b.paired)).json()).toEqual({ device: "b" });
    expect(a.device.opened.map((s) => s.head.path)).toEqual([`/d/${a.paired.deviceId}/mcp`]);
    expect(b.device.opened.map((s) => s.head.path)).toEqual([`/d/${b.paired.deviceId}/mcp`]);
  });

  it("refuses tokens for another device, another account, expired or absent — nothing reaches the device", async () => {
    await start();
    const a = await h.ready({ onOpen: answer("{}") });
    const b = await h.ready({ onOpen: answer("{}") }, "user_02");
    const send = (token: string | undefined) =>
      fetch(h.url(a.paired), {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: "{}",
      });
    const now = Math.floor(Date.now() / 1000);
    const tokens = [
      h.clientToken(b.paired),
      h.as.token({ resource: a.paired.uri, sub: "user_02" }),
      h.clientToken(a.paired, { iat: now - 400, exp: now - 10 }),
      h.clientToken(a.paired, { iat: now - 20 * 60, exp: now + 60 }),
      h.clientToken(a.paired, { aud: [a.paired.uri, b.paired.uri] }),
      "not-a-jwt",
    ];
    for (const token of tokens) {
      const res = await send(token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect(res.headers.get(OUTCOME_HEADER)).toBe("not_executed");
    }
    const none = await send(undefined);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="https://relay.crot-dev.example/.well-known/oauth-protected-resource/d/${a.paired.deviceId}/mcp"`,
    );
    expect(a.device.opened).toHaveLength(0);
    for (const t of tokens) expect(h.logText()).not.toContain(t);
  });

  it("unknown devices 404, offline devices and remote off 503 not_executed, not entitled 403", async () => {
    let entitled = true;
    await start({ entitlement: () => (entitled ? "entitled" : "not_entitled") });
    const unknown = h.newDevice();
    expect(await errorOf(await h.post(unknown))).toMatchObject({ status: 404, outcome: "not_executed", id: null });
    const offline = h.newDevice();
    await h.register(offline);
    expect(await errorOf(await h.post(offline))).toMatchObject({
      status: 503,
      outcome: "not_executed",
      crot: "device_offline",
    });
    const { paired, device } = await h.ready({ onOpen: answer("{}") });
    entitled = false;
    expect(await errorOf(await h.post(paired))).toMatchObject({ status: 403, outcome: "not_executed" });
    entitled = true;
    device.goAway("remote_disabled", 0);
    await waitFor(() => !h.relay.isOnline(paired.deviceId));
    expect(await errorOf(await h.post(paired))).toMatchObject({ status: 503, crot: "device_offline" });
    expect(device.opened).toHaveLength(0);
  });

  it("allows only POST, GET and DELETE", async () => {
    await start();
    const { paired, device } = await h.ready();
    const res = await fetch(h.url(paired), {
      method: "PUT",
      headers: { authorization: `Bearer ${h.clientToken(paired)}` },
    });
    expect(res.status).toBe(405);
    expect(device.opened).toHaveLength(0);
  });
});

describe("forwarding unchanged (AD-22 point 7)", () => {
  it("forwards end-to-end headers and body, removes hop-by-hop headers, adds nothing", async () => {
    await start();
    const { paired, device } = await h.ready({ onOpen: answer('{"ok":true}') });
    const token = h.clientToken(paired);
    const { res } = await h.raw(paired, {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": "fs_read_file",
        "mcp-session-id": "sess-1",
        "x-crot-principal": "admin",
        "keep-alive": "timeout=5",
        connection: "keep-alive, x-drop-me",
        "x-drop-me": "1",
        "proxy-authorization": "Basic abc",
        te: "trailers",
      },
      body: '{"jsonrpc":"2.0","id":7,"method":"tools/call"}',
    });
    res.resume();
    const s = device.opened[0]!;
    const names = s.head.headers.map(([n]) => n);
    expect(s.head.method).toBe("POST");
    expect(s.header("authorization")).toBe(`Bearer ${token}`);
    expect(s.header("host")).toBe(`127.0.0.1:${h.relay.port}`);
    expect(s.header("mcp-method")).toBe("tools/call");
    expect(s.header("mcp-name")).toBe("fs_read_file");
    expect(s.header("mcp-session-id")).toBe("sess-1");
    expect(s.header("x-crot-principal")).toBe("admin");
    for (const hop of ["connection", "keep-alive", "x-drop-me", "proxy-authorization", "te", "transfer-encoding"])
      expect(names).not.toContain(hop);
    expect(names.filter((n) => n.startsWith("x-forwarded") || n === "forwarded" || n === "via")).toEqual([]);
    expect((await s.bodyDone()).toString()).toBe('{"jsonrpc":"2.0","id":7,"method":"tools/call"}');
    expect(s.head.deadlineMs).toBeGreaterThan(14 * 60_000);
    expect(s.head.deadlineMs).toBeLessThanOrEqual(15 * 60_000);
    expect(res.statusCode).toBe(200);
  });

  it("keeps the query, duplicates and order of headers", async () => {
    await start();
    const { paired, device } = await h.ready({ onOpen: answer("{}") });
    await fetch(`${h.url(paired)}?a=1`, {
      method: "GET",
      headers: [
        ["authorization", `Bearer ${h.clientToken(paired)}`],
        ["accept", "text/event-stream"],
        ["x-multi", "1"],
        ["x-multi", "2"],
      ],
    }).then((r) => r.text());
    const s = device.opened[0]!;
    expect(s.head.path).toBe(`/d/${paired.deviceId}/mcp?a=1`);
    expect(s.bodyEnded).toBe(true);
    expect(
      s.head.headers
        .filter(([n]) => n === "x-multi")
        .map(([, v]) => v)
        .join(","),
    ).toBe("1, 2");
  });

  it("streams responses as received (SSE) and writes the device's status and headers", async () => {
    await start();
    let stream: DeviceStream | undefined;
    const { paired } = await h.ready({
      onOpen: (s) => {
        stream = s;
        s.respond(200, [
          ["content-type", "text/event-stream"],
          ["mcp-session-id", "abc"],
          ["connection", "close"],
        ]);
        void s.write(Buffer.from("event: message\ndata: 1\n\n"));
      },
    });
    const { res } = await h.raw(paired, { body: "{}", headers: { "content-type": "application/json" } });
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["mcp-session-id"]).toBe("abc");
    const first = await new Promise<string>((r) => res.once("data", (c: Buffer) => r(c.toString())));
    expect(first).toBe("event: message\ndata: 1\n\n");
    const rest = new Promise<string>((r) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c.toString()));
      res.on("end", () => r(text));
    });
    await stream!.write(Buffer.from("event: message\ndata: 2\n\n"), true);
    expect(await rest).toBe("event: message\ndata: 2\n\n");
  });
});

describe("a misbehaving device response affects only its stream", () => {
  it("more body than its own Content-Length: the stream ends, the tunnel stays", async () => {
    await start();
    const { paired, device } = await h.ready({
      onOpen: (s) => {
        s.respond(200, [["content-length", "5"]]);
        void s.write(Buffer.from("0123456789"), true);
      },
    });
    const res = await h
      .post(paired)
      .then((r) => r.text())
      .catch(() => "aborted");
    expect(["01234", "aborted"]).toContain(res);
    device.onOpen = answer('{"still":"up"}');
    expect(await (await h.post(paired)).json()).toEqual({ still: "up" });
    expect(device.closed).toBeUndefined();
  });
});

describe("limits (AD-22 points 6 and 11)", () => {
  it("answers 503 busy not_executed beyond the device's maxStreams, without forwarding", async () => {
    await start();
    const { paired, device } = await h.ready({ maxStreams: 1 });
    const pending = h.raw(paired, { body: "{}" });
    await waitFor(() => device.opened.length === 1);
    const res = await h.post(paired);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(await errorOf(res)).toMatchObject({ status: 503, crot: "busy", outcome: "not_executed" });
    expect(device.opened).toHaveLength(1);
    device.opened[0]!.respond(200, [], true);
    (await pending).res.resume();
    await waitFor(() => h.relay.status().openStreams === 0);
    answer("{}")(device.opened[0]!);
    device.onOpen = answer('{"second":true}');
    expect(await (await h.post(paired)).json()).toEqual({ second: true });
  });

  it("a response completed before the client finished its body frees the stream (RESET cancel)", async () => {
    await start();
    const { paired, device } = await h.ready({ maxStreams: 1 });
    device.onOpen = (s) => s.respond(503, [["content-length", "0"]], true);
    const total = 1024 * 1024;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(h.url(paired), {
        method: "POST",
        headers: { authorization: `Bearer ${h.clientToken(paired)}`, "content-length": String(total) },
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode!);
        // The client keeps sending after the complete response.
        setTimeout(() => req.end(Buffer.alloc(total - 65536)), 50);
      });
      req.on("error", reject);
      req.write(Buffer.alloc(65536));
    });
    expect(status).toBe(503);
    expect(await device.opened[0]!.reset()).toBe("cancel");
    await waitFor(() => h.relay.status().openStreams === 0);
    device.onOpen = answer('{"next":true}');
    const next = await h.post(paired);
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ next: true });
    const exchanges = h.logs.filter((l) => l.event === "exchange");
    expect(exchanges[0]).toMatchObject({ status: 503, code: "complete" });
    expect(exchanges[0]!.outcome).toBeUndefined();
  });

  it("refuses request bodies over 4 MiB with 413 not_executed (declared or chunked)", async () => {
    await start();
    const { paired, device } = await h.ready({ onOpen: answer("{}") });
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
    const declared = await h.post(paired, big.toString());
    expect(await errorOf(declared)).toMatchObject({ status: 413, outcome: "not_executed" });
    const chunked = await h.raw(paired, { body: big, chunked: true });
    expect(chunked.res.statusCode).toBe(413);
    expect(chunked.res.headers[OUTCOME_HEADER]).toBe("not_executed");
    chunked.res.resume();
    expect(device.opened).toHaveLength(0);
    const exact = Buffer.alloc(4 * 1024 * 1024, 0x20);
    expect((await h.post(paired, exact.toString())).status).toBe(200);
    expect(device.opened[0]!.body.length).toBe(exact.length);
  });

  it("forwards a chunked body without adding Content-Length", async () => {
    await start();
    const { paired, device } = await h.ready({ onOpen: answer("{}") });
    const { res } = await h.raw(paired, { body: Buffer.from("x".repeat(100_000)), chunked: true });
    res.resume();
    const s = device.opened[0]!;
    expect((await s.bodyDone()).length).toBe(100_000);
    expect(s.head.headers.map(([n]) => n)).not.toContain("content-length");
  });

  it("refuses a header block that does not fit one frame (431)", async () => {
    await start();
    const { paired, device } = await h.ready({ onOpen: answer("{}") });
    const res = await h.post(paired, "{}", { "x-big": "a".repeat(30_000), "x-big2": '"'.repeat(30_000) });
    expect(res.status).toBe(431);
    expect(device.opened).toHaveLength(0);
  });

  it("passes a 22 MiB response and aborts one above 32 MiB (device gets response_too_large)", async () => {
    await start();
    const size = { n: 22 * 1024 * 1024 };
    const { paired, device } = await h.ready({
      onOpen: (s) => {
        s.respond(200, [["content-type", "application/json"]]);
        void s.write(Buffer.alloc(size.n, 0x61), true);
      },
    });
    const ok = await h.post(paired);
    expect((await ok.arrayBuffer()).byteLength).toBe(22 * 1024 * 1024);
    size.n = 32 * 1024 * 1024 + 1;
    const { res } = await h.raw(paired, { body: "{}" });
    const outcome = await new Promise<string>((r) => {
      res.on("data", () => undefined);
      res.on("end", () => r("complete"));
      res.on("error", () => r("aborted"));
      res.on("aborted", () => r("aborted"));
    });
    expect(outcome).toBe("aborted");
    expect(await device.opened[1]!.reset()).toBe("response_too_large");
    expect(h.logs).toContainEqual(
      expect.objectContaining({ event: "exchange", outcome: "unknown", code: "response_too_large" }),
    );
  }, 60_000);
});

describe("bodies the relay does not forward are bounded in time", () => {
  /** A raw HTTP/1.1 request whose body is never completed; resolves with the status line and the close time. */
  function stalled(port: number, head: string, partialBody = "") {
    return new Promise<{ statusLine: string; closedAfterMs: number }>((resolve, reject) => {
      const started = Date.now();
      const sock = connect(port, "127.0.0.1", () => sock.write(head + partialBody));
      let text = "";
      sock.on("data", (d) => (text += d.toString()));
      sock.on("error", reject);
      sock.on("close", () => resolve({ statusLine: text.split("\r\n")[0]!, closedAfterMs: Date.now() - started }));
      setTimeout(() => {
        sock.destroy();
        reject(new Error(`connection still open; received: ${text.split("\r\n")[0]}`));
      }, 3_000).unref();
    });
  }

  it("an unauthenticated request that never finishes its body does not hold the connection", async () => {
    await start({ discardBodyMs: 200 });
    const { paired } = await h.ready();
    for (const path of ["/elsewhere", `/d/${paired.deviceId}/mcp`]) {
      const r = await stalled(h.relay.port, `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n`, "{");
      expect(r.statusLine).toMatch(/^HTTP\/1\.1 (404|401) /);
      expect(r.closedAfterMs).toBeLessThan(2_000);
    }
  });

  it("registration refuses a bad token before reading the body", async () => {
    await start({ discardBodyMs: 200 });
    const d = h.newDevice();
    const r = await stalled(
      h.relay.port,
      `POST /d/${d.deviceId}/register HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer abc.def.ghi\r\nContent-Length: 4000\r\n\r\n`,
    );
    expect(r.statusLine).toMatch(/^HTTP\/1\.1 401 /);
  });

  it("a chunked body that is not complete within the exchange deadline is refused 408 not_executed", async () => {
    await start({ exchangeDeadlineMs: 300 });
    const { paired, device } = await h.ready();
    const res = await new Promise<{ status: number; outcome: unknown }>((resolve, reject) => {
      const req = httpRequest(h.url(paired), {
        method: "POST",
        headers: { authorization: `Bearer ${h.clientToken(paired)}`, "transfer-encoding": "chunked" },
      });
      req.on("response", (r) => {
        r.resume();
        resolve({ status: r.statusCode!, outcome: r.headers[OUTCOME_HEADER] });
      });
      req.on("error", reject);
      req.write("{");
    });
    expect(res).toEqual({ status: 408, outcome: "not_executed" });
    expect(device.opened).toHaveLength(0);
  });
});

describe("outcomes, cancellation, deadline (AD-22 points 12–13)", () => {
  it("device RESET refused → 503 not_executed; other resets → 502 unknown; never retried", async () => {
    await start();
    const { paired, device } = await h.ready({ onOpen: (s) => s.sendReset("refused") });
    const refused = await h.post(paired);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(await errorOf(refused)).toEqual({ status: 503, outcome: "not_executed", crot: "refused", id: null });
    device.onOpen = (s) => s.sendReset("internal_error");
    expect(await errorOf(await h.post(paired))).toMatchObject({ status: 502, outcome: "unknown" });
    device.onOpen = (s) => s.sendReset("some_future_code");
    expect(await errorOf(await h.post(paired))).toMatchObject({ status: 502, outcome: "unknown" });
    await sleep(50);
    expect(device.opened).toHaveLength(3);
  });

  it("tunnel loss mid-request → 502 unknown, nothing replayed on the next tunnel", async () => {
    await start();
    const { paired, device } = await h.ready();
    const pending = h.post(paired);
    await waitFor(() => device.opened.length === 1);
    device.ws.terminate();
    expect(await errorOf(await pending)).toMatchObject({ status: 502, outcome: "unknown", crot: "tunnel_lost" });
    const next = await h.online(paired);
    await sleep(100);
    expect(next.opened).toHaveLength(0);
  });

  it("tunnel loss after the response head aborts the client stream", async () => {
    await start();
    const { paired, device } = await h.ready({
      onOpen: (s) => {
        s.respond(200, [["content-type", "text/event-stream"]]);
        void s.write(Buffer.from("data: 1\n\n"));
      },
    });
    const { res } = await h.raw(paired, { body: "{}" });
    await new Promise((r) => res.once("data", r));
    const ended = new Promise<string>((r) => {
      res.on("end", () => r("complete"));
      res.on("aborted", () => r("aborted"));
      res.on("error", () => r("aborted"));
    });
    device.ws.terminate();
    expect(await ended).toBe("aborted");
  });

  it("client disconnect sends RESET cancel; a cancel after completion is not sent", async () => {
    await start();
    const { paired, device } = await h.ready();
    const { destroy } = await (async () => {
      const r = h.raw(paired, { body: "{}" });
      await waitFor(() => device.opened.length === 1);
      device.opened[0]!.respond(200, [["content-type", "text/event-stream"]]);
      return r;
    })();
    destroy();
    expect(await device.opened[0]!.reset()).toBe("cancel");
    device.onOpen = answer("{}");
    expect((await h.post(paired)).status).toBe(200);
    await sleep(50);
    expect(device.opened[1]!.resetCode).toBeUndefined();
  });

  it("deadline: 504 unknown before the head (device gets deadline_exceeded), abort after it", async () => {
    await start({ exchangeDeadlineMs: 300 });
    const { paired, device } = await h.ready();
    const res = await h.post(paired);
    expect(await errorOf(res)).toMatchObject({ status: 504, outcome: "unknown", crot: "deadline_exceeded" });
    expect(device.opened[0]!.head.deadlineMs).toBeLessThanOrEqual(300);
    expect(await device.opened[0]!.reset()).toBe("deadline_exceeded");
    device.onOpen = (s) => s.respond(200, [["content-type", "text/event-stream"]]);
    const { res: streaming } = await h.raw(paired, { body: "{}" });
    const ended = await new Promise<string>((r) => {
      streaming.on("data", () => undefined);
      streaming.on("end", () => r("complete"));
      streaming.on("aborted", () => r("aborted"));
      streaming.on("error", () => r("aborted"));
    });
    expect(ended).toBe("aborted");
  });

  it("an approval-length wait without bytes is not cut before the deadline", async () => {
    await start({ exchangeDeadlineMs: 2_000, timing: { pingAfterIdleMs: 100, deadAfterMs: 400 } });
    const { paired, device } = await h.ready();
    device.onOpen = (s) => {
      setTimeout(() => answer('{"approved":true}')(s), 900);
    };
    expect(await (await h.post(paired)).json()).toEqual({ approved: true });
  });
});

describe("GOAWAY and draining (AD-22 point 9)", () => {
  it("device GOAWAY: in-flight streams finish, streams above lastStream are not_executed, new requests 503", async () => {
    await start();
    const { paired, device } = await h.ready();
    const first = h.post(paired);
    await waitFor(() => device.opened.length === 1);
    const second = h.post(paired);
    await waitFor(() => device.opened.length === 2);
    device.goAway("remote_disabled", 1);
    expect(await errorOf(await second)).toMatchObject({ status: 503, outcome: "not_executed", crot: "refused" });
    answer('{"first":true}')(device.opened[0]!);
    expect(await (await first).json()).toEqual({ first: true });
    expect(await errorOf(await h.post(paired))).toMatchObject({ status: 503, crot: "device_offline" });
  });

  it("relay shutdown sends GOAWAY shutting_down and drains", async () => {
    await start({ timing: { drainMs: 300 } });
    const { paired, device } = await h.ready();
    const pending = h.post(paired);
    await waitFor(() => device.opened.length === 1);
    const closing = h.relay.close();
    const goaway = await device.frame(0x22);
    expect(JSON.parse(goaway.payload.toString())).toEqual({ lastStream: 1, code: "shutting_down" });
    answer('{"drained":true}')(device.opened[0]!);
    expect(await (await pending).json()).toEqual({ drained: true });
    await closing;
    expect((await device.whenClosed()).code).toBe(1001);
  });

  it("a stream still open at the drain limit is reset shutting_down", async () => {
    await start({ timing: { drainMs: 200 } });
    const { paired, device } = await h.ready();
    const pending = h.post(paired);
    await waitFor(() => device.opened.length === 1);
    const closing = h.relay.close();
    expect(await device.opened[0]!.reset()).toBe("shutting_down");
    expect(await errorOf(await pending)).toMatchObject({ status: 502, outcome: "unknown" });
    await closing;
  });
});

describe("logs (AD-22 points 14–15)", () => {
  it("contain no tokens, bodies, header values or paths", async () => {
    await start();
    const { paired, device } = await h.ready({ onOpen: answer('{"result":"SECRET-RESULT-MARKER"}') });
    const token = h.clientToken(paired);
    const res = await fetch(`${h.url(paired)}?q=SECRET-QUERY`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "x-api-key": "SECRET-HEADER-MARKER",
      },
      body: '{"params":{"content":"SECRET-BODY-MARKER"}}',
    });
    await res.text();
    device.onOpen = (s) => s.sendReset("internal_error");
    await (await h.post(paired)).text();
    const text = h.logText();
    for (const secret of [
      token,
      "SECRET-RESULT-MARKER",
      "SECRET-QUERY",
      "SECRET-HEADER-MARKER",
      "SECRET-BODY-MARKER",
      "/d/",
      "Bearer",
    ])
      expect(text).not.toContain(secret);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        event: "exchange",
        method: "POST",
        mcpMethod: "tools/call",
        status: 200,
        code: "complete",
      }),
    );
  });
});

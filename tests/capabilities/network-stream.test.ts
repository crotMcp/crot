import http from "node:http";
import { expect, it } from "vitest";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { createTestCore, makeTempDirs, testContext } from "../helpers.js";
import { ChatEventStream } from "../../src/service/chat-stream.js";

it("streams before response completion through the existing authorized network path; cancellation and observer errors close it", async () => {
  const dirs = await makeTempDirs();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"text":"first"}\n\n');
    void gate.then(() => res.end("data: [DONE]\n\n"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port,
    url = `http://127.0.0.1:${port}/stream`;
  const audit = new MemoryAuditSink();
  const core = await createTestCore(
    {
      workspace: { root: dirs.workspace },
      permissions: {
        mode: "full_control",
        network: { allow: [`127.0.0.1:${port}`] },
        approvals: { untrustedContent: "off" },
      },
    },
    audit,
  );
  try {
    let received!: () => void;
    const first = new Promise<void>((r) => (received = r));
    const chunks: Buffer[] = [];
    const pending = core.network.request(
      testContext,
      { url },
      {
        data: (chunk) => {
          chunks.push(chunk);
          received();
        },
      },
    );
    await first;
    expect(Buffer.concat(chunks).toString()).toContain("first");
    release();
    expect((await pending).status).toBe(200);
    const controller = new AbortController();
    const aborted = core.network.request(
      { ...testContext, signal: controller.signal },
      { url },
      { data: () => controller.abort() },
    );
    await expect(aborted).rejects.toThrow();
    await expect(
      core.network.request(
        testContext,
        { url },
        {
          data: () => {
            throw new Error("decoder rejected event");
          },
        },
      ),
    ).rejects.toThrow(/decoder rejected/);
    const limited: Buffer[] = [];
    const response = await core.network.request(
      testContext,
      { url, maxResponseBytes: 5 },
      { data: (b) => limited.push(b) },
    );
    expect(response.truncated).toBe(true);
    expect(Buffer.concat(limited)).toHaveLength(5);
    expect(JSON.stringify(audit.events)).not.toContain('"text":"first"');
  } finally {
    release();
    await core.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await dirs.cleanup();
  }
});

it("SSE handles split UTF-8/CRLF, rejects incomplete frames and enforces byte bounds", () => {
  const seen: [string, string][] = [],
    decoder = new ChatEventStream((event, data) => seen.push([event, data]));
  const wire = Buffer.from(': comment\r\nevent: message_delta\r\ndata: {"text":"Привет 👋"}\r\n\r\ndata: [DONE]\n\n');
  for (const byte of wire) decoder.push(Buffer.from([byte]));
  decoder.end();
  expect(seen).toEqual([
    ["message_delta", '{"text":"Привет 👋"}'],
    ["message", "[DONE]"],
  ]);
  const partial = new ChatEventStream(() => {});
  partial.push(Buffer.from("data: {"));
  expect(() => partial.end()).toThrow(/Incomplete/);
  expect(() => new ChatEventStream(() => {}, 2).push(Buffer.from("abc"))).toThrow(/limit/);
});

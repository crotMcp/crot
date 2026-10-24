import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ChatRuntime } from "../../src/service/chat-runtime.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { TestProvider } from "../approval-provider.js";
import { createTestCore, makeTempDirs, testContext, waitFor } from "../helpers.js";

describe("guarded chat failures", () => {
  it("never executes unselected or incomplete tool calls; aborts pending approval and redacts decoder failures", async () => {
    const dirs = await makeTempDirs(),
      audit = new MemoryAuditSink(),
      ui = new TestProvider();
    let mode = "unselected",
      hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      const chunks: Buffer[] = [];
      req.on("data", (b: Buffer) => chunks.push(b));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: unknown[] };
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (mode === "malformed") {
          res.end("data: credential-fixture-do-not-log\n\n");
          return;
        }
        if (body.messages.length > 1) {
          res.end("data: [DONE]\n\n");
          return;
        }
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "fs_write_file", arguments: JSON.stringify({ path: "blocked.txt", content: "must-not-exist" }) } }] } }] })}\n\n`,
        );
        res.end(mode === "incomplete" ? "" : "data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
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
      { approvalProviders: [ui] },
    );
    const chat = new ChatRuntime({
      core: () => core,
      context: () => testContext,
      configuration: () => ({ endpoint: `http://127.0.0.1:${port}` }),
      credential: () => undefined,
      run: (ctx, work) => work(ctx),
    });
    const start = (tools: string[] = []) =>
      String(chat.start({ provider: "Local HTTP", model: "fixture", message: "task", tools }).id);
    const finished = async (id: string) => {
      await waitFor(() => chat.poll(id).state !== "running");
      return chat.poll(id);
    };
    try {
      expect(await finished(start())).toMatchObject({
        state: "completed",
        blocks: expect.arrayContaining([expect.objectContaining({ type: "tool", status: "failed" })]),
      });
      expect(ui.shown).toHaveLength(0);
      mode = "incomplete";
      expect(await finished(start(["fs_write_file"]))).toMatchObject({ state: "failed" });
      expect(ui.shown).toHaveLength(0);
      mode = "malformed";
      expect(await finished(start())).toMatchObject({ state: "failed" });
      expect(JSON.stringify(audit.events)).not.toContain("credential-fixture-do-not-log");
      mode = "approval";
      core.permissions.runtime.replace({
        strict: false,
        rules: [{ operation: "filesystem.write_file", state: "ask" }],
      });
      const id = start(["fs_write_file"]);
      await ui.next();
      chat.stop(id);
      expect(await finished(id)).toMatchObject({ state: "cancelled" });
      await waitFor(() => ui.ended.length === 1);
      expect(ui.ended[0]?.status).toBe("cancelled");
      await expect(readFile(path.join(dirs.workspace, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      const before = hits;
      // Use the canonical operation selector: an endpoint allowlist alone never bypasses runtime deny.
      core.permissions.runtime.replace({ strict: false, rules: [{ operation: "network.request", state: "deny" }] });
      expect(await finished(start())).toMatchObject({ state: "failed" });
      expect(hits).toBe(before);
      for (const attachments of [
        [{ name: "x.png", mime: "image/png", data: Buffer.from("not-an-image").toString("base64") }],
        [{ name: "bad.txt", mime: "text/plain", data: "/w==" }],
      ]) {
        expect(() => chat.start({ provider: "Local HTTP", model: "fixture", message: "task", attachments })).toThrow();
      }
    } finally {
      await chat.close();
      await core.shutdown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await dirs.cleanup();
    }
  });
});

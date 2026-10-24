/** Test-only HTTP replacement for Electron IPC. All data/actions use an isolated real CrotService. */
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { ControlClient } from "../dist/service/control-client.js";
import { TrayToolClient } from "../dist/tray/tool-client.js";
import { TrayController } from "../dist/tray/controller.js";
import { trayView } from "../dist/tray/view-model.js";
import { createPrivateFileProtection } from "../dist/core/platform/private-files.js";
export async function serviceHarness() {
  const base = await mkdtemp(path.join(tmpdir(), "crot-ui-service-")),
    workspace = path.join(base, "workspace");
  await mkdir(workspace);
  const env = {
    ...process.env,
    HOME: base,
    LOCALAPPDATA: path.join(base, "local"),
    APPDATA: path.join(base, "roaming"),
    XDG_STATE_HOME: path.join(base, "state"),
    XDG_CONFIG_HOME: path.join(base, "config"),
  };
  const stateDir =
    process.platform === "win32"
      ? path.join(env.LOCALAPPDATA, "CROT")
      : process.platform === "darwin"
        ? path.join(base, "Library", "Application Support", "CROT", "State")
        : path.join(base, "state", "crot");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(stateDir, "secrets.json"), JSON.stringify({ version: 1, backend: "file" }), {
    mode: 0o600,
  });
  const bin = path.resolve("dist/bin/crot-mcp.js"),
    config = path.join(base, "config.json");
  let tool, control, controller, view, endpoint;
  return {
    base,
    workspace,
    bin,
    stateDir,
    async start(origin) {
      endpoint = origin + "/provider-probe";
      await writeFile(
        config,
        JSON.stringify({
          workspace: { root: workspace },
          permissions: {
            mode: "full_control",
            approvals: { untrustedContent: "off" },
            network: { allow: [new URL(origin).host] },
          },
          audit: { sink: "file", path: path.join(base, "audit.jsonl") },
        }),
      );
      tool = new TrayToolClient({ command: process.execPath, entry: bin, args: ["--config", config], env });
      await tool.call("fs_list_directory", { path: "." });
      control = await ControlClient.connect({
        stateDir,
        privateFiles: createPrivateFileProtection(process.platform === "win32"),
      });
      if (!control) throw Error("Service control channel unavailable");
      controller = new TrayController({
        stateDir,
        privateFiles: createPrivateFileProtection(process.platform === "win32"),
        onUpdate: (s) => {
          view = trayView(s);
        },
      });
      await controller.start();
    },
    async configureChatApproval() {
      await control.request("security.setPolicy", {
        strict: false,
        rules: [{ operation: "filesystem.write_file", state: "ask" }],
      });
    },
    async verifyChat() {
      const content = await readFile(path.join(base, "second", "chat-proof.txt"), "utf8");
      if (content !== "real-chat-approved") throw Error("Chat tool did not write the approved file");
      const journal = (await readFile(path.join(base, "audit.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (
        !journal.some(
          (event) =>
            event.operation === "filesystem.write_file" &&
            event.outcome === "success" &&
            event.approval?.status === "approved",
        )
      )
        throw Error("Approved chat audit missing");
      const { agents } = await control.request("agents.list");
      if (!agents.some((agent) => agent.name === "Local HTTP chat")) throw Error("Chat agent identity missing");
      return { approvedChatWrite: true, registeredChatAgent: true };
    },
    async handle(req, res, pathname) {
      if (pathname.startsWith("/chat-provider/")) {
        if (pathname.endsWith("/models")) {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ data: [{ id: "ui-model" }] }));
          return true;
        }
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (body.messages.length === 1) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Waiting for approved write" } }] })}\n\n`);
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "ui_call", function: { name: "fs_write_file", arguments: JSON.stringify({ path: "chat-proof.txt", content: "real-chat-approved" }) } }] } }] })}\n\n`,
          );
        } else
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "UI streaming tool complete" } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return true;
      }
      if (pathname === "/provider-probe") {
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        return true;
      }
      if (pathname !== "/real-rpc") return false;
      let data = "";
      for await (const c of req) {
        data += c;
        if (data.length > 262144) throw Error("Oversized test request");
      }
      try {
        const { kind, name, input } = JSON.parse(data || "{}");
        const value =
          kind === "view"
            ? view
            : kind === "tool"
              ? await tool.call(name, input)
              : kind === "product"
                ? await control.request(name, input)
                : kind === "decide"
                  ? await controller.decide(name, input.decision)
                  : kind === "action"
                    ? await controller.startPairing(input)
                    : true;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value }));
      } catch {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ value: { ok: false, message: "Service rejected operation" } }));
      }
      return true;
    },
    get shim() {
      return `window.crot={onView(fn){this.render=fn},async ready(){this.render(await this.request('view'));setInterval(async()=>{try{this.render(await this.request('view'))}catch{}},150)},async request(kind,name,input={}){const r=await fetch('/real-rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,name,input})});return (await r.json()).value},product(name,input){return this.request('product',name,input)},tool(name,input){return this.request('tool',name,input)},action(name,input){return this.request('action',name,input)},decide(name,decision){return this.request('decide',name,{decision})},repairL1:async()=>({ok:false})};window.serviceTest=${JSON.stringify({ projectPath: path.join(base, "second"), command: process.execPath, mcpFixture: path.resolve("tests/fixtures/product-mcp.mjs") })};`;
    },
    async verify() {
      const r = await control.request("projects.list");
      return { projects: r.projects.length, active: r.active, endpoint };
    },
    async close() {
      controller?.stop();
      control?.close();
      await tool?.close();
      await promisify(execFile)(process.execPath, [bin, "service", "stop"], { env, timeout: 15000 }).catch(() => {});
      await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { RemoteAcceptance } from "./harness.js";
import { connectClient, versions, type AcceptanceClient } from "./client.js";
let h: RemoteAcceptance | undefined;
let clients: AcceptanceClient[] = [];
afterEach(async () => {
  for (const c of clients) await c.close();
  clients = [];
  await h?.stop();
  h = undefined;
});
describe("WP-32 HTTPS OAuth → WSS → CrotService acceptance", () => {
  for (const version of versions)
    for (const preset of ["require-approval", "autonomous-browser"]) {
      it(`${version} / ${preset}: real project, approvals and negative authorization`, async () => {
        h = new RemoteAcceptance();
        await h.start();
        await h.seed();
        expect(await h.ask("preset.set", { value: preset })).toMatchObject({ ok: true });
        const c = await connectClient(h, version);
        clients.push(c);
        expect(await c.call("fs_read_file", { path: "fixture.txt" })).not.toHaveProperty("error");
        expect(
          await c.call("fs_write_file", { path: "written.txt", content: "WP32_OUTPUT_CANARY" }),
        ).not.toHaveProperty("error");
        expect(await readFile(path.join(h.workspace, "written.txt"), "utf8")).toBe("WP32_OUTPUT_CANARY");
        for (const name of ["git_status", "git_diff", "git_log"])
          expect(await c.call(name, {})).not.toHaveProperty("error");
        expect(await c.call("git_add", { paths: ["written.txt"] })).not.toHaveProperty("error");
        expect(await c.call("git_commit", { message: "WP32 remote commit" })).not.toHaveProperty("error");
        expect(await c.call("git_branch_create", { name: "wp32-branch" })).not.toHaveProperty("error");
        const auditBeforeInvalid = await h.audit();
        const missing = await c.call("browser_snapshot", {});
        expect(JSON.stringify(missing)).toContain("INVALID_INPUT");
        expect(await h.audit()).toBe(auditBeforeInvalid);
        expect(h.approvalErrors).toEqual([]);
        expect(h.wireVersions.has(version)).toBe(true);
        const audit = await h.audit();
        expect(audit).not.toContain("WP32_OUTPUT_CANARY");
        expect(audit).not.toContain("WP32_INPUT_CANARY");
        const log = JSON.stringify(h.logs);
        for (const secret of [c.token, "WP32_INPUT_CANARY", "WP32_OUTPUT_CANARY"]) expect(log).not.toContain(secret);
        // Workspace reads do not expose this context; browser exposure and gating are tested in the real-browser matrix.
        expect(h.approvals.length).toBe(0);
      }, 60000);
    }
});

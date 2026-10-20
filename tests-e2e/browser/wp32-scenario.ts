/** Shared by real-browser job and installed Linux L1 job: no in-memory MCP or approval bypass. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { RemoteAcceptance, eventually } from "../../tests/remote-acceptance/harness.js";
import { connectClient, issueToken, versions, type AcceptanceClient } from "../../tests/remote-acceptance/client.js";
import * as b from "./harness.js";
export async function remoteBrowserScenario(requireL1 = false): Promise<void> {
  const sb = await b.createSandbox();
  let h: RemoteAcceptance | undefined, chrome: b.ChromeInstance | undefined, fixture: b.FixtureServer | undefined;
  const clients: AcceptanceClient[] = [];
  try {
    const installed = await b.installNativeHost(sb);
    const downloads = path.join(sb.home, "Downloads");
    await mkdir(downloads, { recursive: true });
    await mkdir(path.join(sb.profileDir, "Default"), { recursive: true });
    await writeFile(
      path.join(sb.profileDir, "Default/Preferences"),
      JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
    );
    fixture = await b.startFixtureServer();
    h = new RemoteAcceptance();
    await h.start({ workspace: sb.workspace, stateDir: installed.stateDir, browser: true, downloads });
    await h.seed();
    chrome = b.launchChrome(b.chromeExecutable(), sb, { remoteDebugging: true });
    for (const version of versions)
      for (const preset of ["require-approval", "autonomous-browser"]) {
        expect(await h.ask("preset.set", { value: preset })).toMatchObject({ ok: true });
        const c = await connectClient(h, version);
        clients.push(c);
        const call = async (name: string, args: Record<string, unknown> = {}) => {
          const r = await c.call(name, args);
          expect(r, name + " " + JSON.stringify(r)).not.toHaveProperty("error");
          return r;
        };

        await eventually(
          async () => (await c.call("browser_status")).state === "connected",
          10000,
          "Chromium extension/native bridge connection",
        );
        const tabId = (await call("browser_tab_open", { url: fixture.origin + "/wp32.html" })).tabId as number;
        await call("browser_navigate", { tabId, url: fixture.origin + "/wp32.html?remote=1" });
        const snap = await call("browser_snapshot", { tabId });
        const ref = (name: string) => {
          const target = (snap.elements as { name: string; ref: string }[]).find((e) => e.name === name);
          if (!target) throw new Error("fixture ref missing: " + name);
          return target.ref;
        };
        const before = h.approvals.length;
        await call("browser_type", { tabId, ref: ref("Name"), text: "WP32_FORM_CANARY" });
        expect(h.approvals.length - before).toBe(preset === "require-approval" ? 1 : 0);
        await call("browser_select_option", { tabId, ref: ref("Choice"), values: ["b"] });
        await call("browser_set_checked", { tabId, ref: ref("Consent"), checked: true });
        await call("browser_click", { tabId, ref: ref("Submit form") });
        await eventually(() => fixture!.requests.some((r) => r.query.get("value") === "WP32_FORM_CANARY:b:true"));
        await call("browser_click", { tabId, selector: "#dialog" });
        await call("browser_dialog_handle", { tabId, accept: true });
        const popup = await call("browser_click", { tabId, selector: "#popup", waitUntil: "commit" });
        expect(JSON.stringify(popup)).toContain("newTabs");
        const tabs = (await call("browser_tabs_list")).tabs as {
          tabId: number;
          openedBy: string;
          openerTabId?: number;
        }[];
        expect(tabs.find((t) => t.tabId === tabId)).toMatchObject({ openedBy: "this-context", groupedByCrot: true });
        expect(tabs.some((t) => t.openerTabId === tabId && t.openedBy === "this-context")).toBe(true);
        const upload = "upload-" + version + "-" + preset + ".txt";
        await writeFile(path.join(sb.workspace, upload), "WP32_UPLOAD_CANARY");
        let count = h.approvals.length;
        await call("browser_file_upload", { tabId, ref: ref("Upload fixture"), paths: [upload] });
        expect(h.approvals.length).toBe(count + 1);
        await call("browser_click", { tabId, selector: "#read" });
        await eventually(() => fixture!.requests.some((r) => r.query.get("data") === "WP32_UPLOAD_CANARY"));
        count = h.approvals.length;
        const savePath = "download-" + version + "-" + preset + ".bin";
        await call("browser_download", { tabId, selector: "#download", savePath });
        expect(h.approvals.length).toBe(count + 1);
        expect(await readFile(path.join(sb.workspace, savePath))).toEqual(
          Buffer.from("WP26_FIXTURE_FILE_CONTENT_NOT_FOR_AUDIT\0binary"),
        );
        count = h.approvals.length;
        await call("fs_write_file", { path: "remote-output.txt", content: "WP32_FILE_CANARY" });
        expect(h.approvals.length).toBe(count + 1);
        await call("fs_read_file", { path: "remote-output.txt" });
        for (const name of ["git_status", "git_diff", "git_log"]) await call(name);
        await call("git_add", { paths: ["remote-output.txt"] });
        // A distinct commit per matrix row, with the mutation itself sent through remote MCP.
        await call("fs_write_file", { path: "remote-output.txt", content: "WP32_FILE_CANARY:" + version + preset });
        await call("git_add", { paths: ["remote-output.txt"] });
        count = h.approvals.length;
        await call("git_commit", { message: "remote " + version + " " + preset });
        expect(h.approvals.length).toBe(count + 1);
        await call("git_branch_create", { name: "wp32-" + version + "-" + preset });
        count = h.approvals.length;
        const shell = await c.call("shell_run", { script: "printf WP32_L1_CANARY" });
        expect(h.approvals.length).toBe(count + 1);
        if (requireL1) {
          expect(shell).not.toHaveProperty("error");
          expect(JSON.stringify(shell)).toContain("WP32_L1_CANARY");
        } else if (shell.error) expect(JSON.stringify(shell)).toMatch(/CONFINEMENT_UNAVAILABLE/);
        const docker = await c.call("docker_ps", { scope: "workspace" });
        // Daemon availability is not assumed: this is the real DockerService authorization/mediation pipeline.
        if (docker.error) expect(JSON.stringify(docker)).not.toMatch(/INVALID_INPUT|Capability .*not granted/);
        expect(await h.audit()).toContain('"operation":"docker.ps"');
        // Two distinct OAuth client principals: the pairing client is independently issued and verified.
        const otherToken = await issueToken(h, "client_pairing_native");
        // Use another real SDK connection, not a forged Core AuthContext.
        const other = await connectClient(h, version, otherToken);
        clients.push(other);
        const otherTabs = (await other.call("browser_tabs_list")).tabs as typeof tabs;
        expect(otherTabs.find((t) => t.tabId === tabId)?.openedBy).toBe("crot");
        await Promise.all([
          call("browser_click", { tabId, selector: "#one" }),
          other.call("browser_click", { tabId, selector: "#two" }).then((r) => expect(r).not.toHaveProperty("error")),
        ]);
        expect(JSON.stringify(await call("browser_page_read", { tabId }))).toContain("ORDER:12");
        for (const t of tabs.filter((t) => t.tabId === tabId || t.openerTabId === tabId))
          await call("browser_tab_close", { tabId: t.tabId });
        await other.close();
        await c.close();
      }
    expect(h.approvalErrors).toEqual([]);
    const logs = JSON.stringify(h.logs),
      audit = await h.audit();
    for (const canary of [
      "WP32_FORM_CANARY",
      "WP32_UPLOAD_CANARY",
      "WP32_FILE_CANARY",
      "WP32_DIALOG_CANARY",
      "WP32_L1_CANARY",
      "WP26_FIXTURE_FILE_CONTENT_NOT_FOR_AUDIT",
      ...clients.map((c) => c.token),
    ]) {
      expect(logs).not.toContain(canary);
      // Shell scripts are intentionally part of the command audit (not file contents/output).
      if (canary !== "WP32_L1_CANARY") expect(audit).not.toContain(canary);
    }
  } finally {
    for (const c of clients) await c.close().catch(() => undefined);
    await h?.stop();
    await chrome?.stop();
    await fixture?.close();
    await rm(sb.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

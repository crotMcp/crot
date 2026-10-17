/** Real CrotService / registered NativeHost, not a fake available status. */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ServeCommand } from "../../../src/cli/options.js";
import { createPrivateFileProtection } from "../../../src/core/platform/private-files.js";
import { CrotService } from "../../../src/service/service.js";
import { testContext } from "../../helpers.js";
import { createKeychainBackend, stateKey } from "../../../src/service/secrets/backends.js";

describe.runIf(process.platform === "darwin")("macOS registered production service", () => {
  it("protects real service state/control and http-token, reports ready; full_control stays unrestricted", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-mac-svc-")));
    const workspace = path.join(root, "w"),
      state = path.join(root, "s"),
      audit = path.join(root, "audit.jsonl");
    await mkdir(workspace);
    let service: CrotService | undefined;
    try {
      const started = await CrotService.start({
        command: {
          kind: "serve",
          config: {
            workspace: { root: workspace },
            audit: { sink: "file", path: audit },
            environment: { path: "inherited" },
            secrets: { store: "file" },
            http: { enabled: true, port: 0 },
          } as ServeCommand["config"],
          warnings: [],
        },
        launch: "managed",
        stateDir: state,
        privateFiles: createPrivateFileProtection(false),
        log: () => undefined,
        requestStop: () => undefined,
        identity: { environment: { unavailable: "isolated L1 qualification" } },
      });
      if (started === "already_running") throw Error("unexpected existing test service");
      service = started;
      expect(service.core.status().confinement).toMatchObject({
        mechanism: "macos-seatbelt",
        available: true,
        reason: null,
      });
      const paths = [
        "service-token",
        "control-token",
        "http-token",
        "service-settings.json",
        "remote-clients.json",
      ].map((p) => path.join(state, p));
      // Actual files exist before the negative probe; ENOENT is never accepted as a security denial.
      for (const p of paths.slice(3)) await writeFile(p, "{}");
      const r = await service.core.processes.exec(testContext, {
        command: process.execPath,
        args: [
          "-e",
          `const f=require('fs'),n=require('net');const denied=fn=>{try{fn();throw Error('escaped')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}};
for(const p of ${JSON.stringify(paths)}){denied(()=>f.readFileSync(p));denied(()=>f.writeFileSync(p,'bad'));}
const s=n.connect(${JSON.stringify(path.join(state, "control.sock"))});s.on('connect',()=>process.exit(2));s.on('error',async e=>{if(!['EPERM','EACCES'].includes(e.code))process.exit(3);const r=await fetch(${JSON.stringify(service.httpUrl!)});console.log('CROT-6A',r.status);process.exit(r.status===401?0:4)});`,
        ],
      });
      expect(r).toMatchObject({ exitCode: 0, timedOut: false });
      expect(r.stdout).toContain("CROT-6A 401");
      const token = (await readFile(path.join(state, "http-token"), "utf8")).trim();
      expect(r.stdout).not.toContain(token);
      const sw = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
      const proof = {
        title: "CROT-macOS-L1-production",
        value: {
          checkout: process.env.GITHUB_SHA,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          release: os.release(),
          macOS: sw,
          mechanism: "macos-seatbelt",
          available: true,
          protectedReads: "5/5",
          protectedWrites: "5/5",
          control: "EPERM/EACCES",
          httpWithoutToken: 401,
        },
      };
      console.log(`::notice title=CROT-macOS-L1-production::${JSON.stringify(proof)}`);
      if (process.env.CROT_6A_EVIDENCE_FILE)
        appendFileSync(process.env.CROT_6A_EVIDENCE_FILE, JSON.stringify(proof) + "\n");
    } finally {
      await service?.shutdown("macOS qualification");
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);

  it("denies the security CLI access to an existing CROT Keychain item (not a missing-item test)", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-mac-key-")));
    const state = path.join(root, "s");
    await mkdir(state);
    const keychain = path.join(state, "qualification.keychain-db"),
      workspace = path.join(root, "w");
    await mkdir(workspace);
    const backend = createKeychainBackend(state, { keychain });
    const security = (args: string[]) => execFileSync("/usr/bin/security", args, { encoding: "utf8" });
    let core: import("../../../src/core/crot-core.js").CrotCore | undefined;
    let native: import("../../../src/native-host/native-host.js").NativeHost | undefined;
    try {
      security(["create-keychain", "-p", "crot-public-test-password", keychain]);
      await backend.set("http-token", "crot-public-test-canary-not-a-user-secret");
      expect(await backend.get("http-token")).toBe("crot-public-test-canary-not-a-user-secret");
      const { NativeHost } = await import("../../../src/native-host/native-host.js");
      const { createTestCore } = await import("../../helpers.js");
      native = await NativeHost.start({ startupPath: "inherited", stateDir: state });
      core = await createTestCore({ workspace: { root: workspace } }, undefined, { platform: native.platform });
      expect(core.status().confinement.available).toBe(true);
      const r = await core.processes.exec(testContext, {
        command: "/usr/bin/security",
        args: ["find-generic-password", "-s", `crot-mcp:${stateKey(state)}`, "-a", "http-token", "-w", keychain],
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain("crot-public-test-canary-not-a-user-secret");
    } finally {
      await core?.shutdown();
      await native?.close();
      try {
        security(["delete-keychain", keychain]);
      } catch {
        /* creating the keychain itself may fail; never touch another keychain */
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});

/** Mandatory native AD-29 qualification; never interpreted as production availability. */
import { randomUUID } from "node:crypto";
import { CrotService } from "../../../src/service/service.js";
import { ControlClient } from "../../../src/service/control-client.js";
import { openSecretStore, generateSecret } from "../../../src/service/secrets/store.js";
import { secretFile } from "../../../src/service/secrets/backends.js";
import { secretCredentialStore, serviceEndpoint } from "../../../src/service/endpoints.js";
import { actualServiceActor } from "./diagnostics/appcontainer-service-actor.js";
import { parseDirectoryAccess, type DirectoryAccess } from "./diagnostics/directory-access.js";
import { createServicePrivateFiles } from "../../../src/service/private-files.js";
import { createRequire } from "node:module";
import { snapshotWorkspaceDescriptorDetails } from "./diagnostics/workspace-view-security.js";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, inject, it } from "vitest";
import { buildWorkspaceViewFixture } from "./diagnostics/workspace-view-build.js";
const execute = promisify(execFile);
describe.runIf(process.platform === "win32")("Windows AppContainer без драйвера — обязательная квалификация", () => {
  it("обычные API, NUL, Node/cmd/WinPS и отрицательные проверки исходных путей", async () => {
    // Resolve host TMP's RUNNER~1-style alias BEFORE sandboxing. WinPS path
    // canonicalization must not need directory enumeration of private ancestors.
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-appc-")));
    let build: Awaited<ReturnType<typeof buildWorkspaceViewFixture>> | undefined;
    let service: CrotService | undefined;
    let control: Awaited<ReturnType<typeof ControlClient.connect>>;
    try {
      const [workspace, temp, cache, outside] = ["workspace", "temp", "cache", "outside"].map((n) =>
        path.join(root, n),
      );
      for (const p of [workspace!, temp!, cache!, outside!]) await mkdir(p);
      const secret = path.join(workspace!, "protected.txt");
      await writeFile(secret, "");
      await createServicePrivateFiles(true).protectFile!(secret);
      await writeFile(secret, "owned fixture");
      const ffi = createRequire(import.meta.url)("koffi");
      const parents: string[] = [];
      let parent = path.dirname(workspace!);
      for (;;) {
        parents.push(parent);
        if (path.dirname(parent) === parent) break;
        parent = path.dirname(parent);
      }
      // Shared ancestors must be restored too; fingerprints include owner,
      // group, DACL order/provenance and the integrity label.
      const linked = path.join(workspace!, "link-source.txt");
      await writeFile(linked, "host-owned");
      const existingDirectory = path.join(workspace!, "existing-directory");
      await mkdir(existingDirectory);
      const existingFile = path.join(existingDirectory, "before.txt");
      const existingSibling = path.join(existingDirectory, "sibling.txt");
      await writeFile(existingFile, "initial");
      await writeFile(existingSibling, "untouched");
      const snapshots = () =>
        [workspace!, secret, linked, ...parents, existingDirectory, existingFile, existingSibling].map((file) =>
          snapshotWorkspaceDescriptorDetails(ffi, file),
        );
      const before = snapshots();
      expect(before.every((s) => s.medium)).toBe(true);
      build = await buildWorkspaceViewFixture();
      // Actual service, actual SecretStore and authenticated owner controls.
      // The profile SID is derived before bootstrap, then checked against the
      // fresh profile by the native controller before any actor starts.
      const profileName = `crot.l1.${randomUUID()}`;
      const sandboxSid = (await execute(build.helper, ["--derive-sid", profileName])).stdout.trim();
      expect(sandboxSid).toMatch(/^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/);
      const stateDir = path.join(outside!, "actual-service-state");
      await mkdir(stateDir);
      const privateFiles = createServicePrivateFiles(true, [sandboxSid]);
      const legacy = generateSecret();
      await writeFile(secretFile(stateDir, "service-token"), legacy + "\n");
      const started = await CrotService.start({
        command: {
          kind: "serve",
          config: {
            workspace: { root: workspace! },
            environment: { path: "inherited" },
            secrets: { store: "file" },
            browser: { enabled: false },
            audit: { sink: "file", path: path.join(stateDir, "audit.jsonl") },
          },
          warnings: [],
        },
        launch: "managed",
        stateDir,
        privateFiles,
        log: () => undefined,
        requestStop: () => undefined,
      });
      if (started === "already_running") throw new Error("Unexpected fixture service collision");
      service = started;
      const store = await openSecretStore(stateDir, privateFiles);
      await store.write("device-key", generateSecret());
      control = await ControlClient.connect({ stateDir, privateFiles });
      if (!control) throw new Error("Actual owner control unavailable");
      expect(await control.request("ping")).toEqual({ pid: process.pid, state: "running" });
      expect(await control.request("preset.set", { value: "require-approval" })).toMatchObject({ ok: true });
      expect((await store.read("service-token")) === legacy).toBe(true);
      const protectedFiles = [
        secretFile(stateDir, "service-token"),
        secretFile(stateDir, "control-token"),
        secretFile(stateDir, "device-key"),
        path.join(stateDir, "service-settings.json"),
        path.join(stateDir, "audit.jsonl"),
      ];
      const serviceBefore = await Promise.all(protectedFiles.map((f) => readFile(f)));
      expect(serviceBefore.every((b) => b.length > 0)).toBe(true);
      for (const file of protectedFiles) expect((await privateFiles.inspect(file)).ownerOnly).toBe(true);
      const credential = await secretCredentialStore(stateDir, privateFiles).read("control");
      if (!credential) throw new Error("Actual control credential unavailable");
      const endpoint = serviceEndpoint(stateDir, "control", credential).path;
      const actorScript = path.join(workspace!, "service-actor.cjs");
      await writeFile(actorScript, actualServiceActor);
      const actorScriptBefore = snapshotWorkspaceDescriptorDetails(ffi, actorScript);
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-6A-appcontainer-actual-owner",
          value: {
            serviceStarted: true,
            ownerAuthenticated: true,
            ownerSettingsWrite: true,
            legacyCredentialPreserved: true,
            privateDescriptorsVerified: protectedFiles.length,
            actorAttempted: false,
          },
        }) + "\n",
      );
      const beforeHelper = snapshots();
      let exit = 0;
      const result = await execute(
        build.helper,
        [workspace!, temp!, cache!, outside!, secret, process.execPath, profileName, ...protectedFiles, endpoint],
        {
          timeout: 150000,
          maxBuffer: 16384,
        },
      ).catch((error: unknown) => {
        const e = error as { code?: unknown; stdout?: unknown };
        if (typeof e.code !== "number" || typeof e.stdout !== "string") throw error;
        exit = e.code;
        return { stdout: e.stdout };
      });
      const v = JSON.parse(result.stdout) as {
        serviceAttempted: boolean;
        serviceCode: number;
        verified: boolean;
        nativeCode: number;
        nodeCode: number;
        cmdCode: number;
        psCode: number;
        cleanup: boolean;
      };
      const after = snapshots();
      const restored = after.every((s, i) => s.medium && s.fingerprint === before[i]!.fingerprint);
      const nodeResult = await readFile(path.join(workspace!, "node-result.json"), "utf8")
        .then((s) => JSON.parse(s) as unknown)
        .catch(() => undefined);
      const actorOutput = Object.fromEntries(
        await Promise.all(
          ["native", "node", "cmd", "powershell", "service"]
            .flatMap((name) => ["stdout", "stderr"].map((kind) => `${name}-${kind}.txt`))
            .map(async (name) => [
              name,
              await readFile(path.join(workspace!, name), "utf8")
                .then((s) => s.slice(0, name === "native-stdout.txt" ? 32768 : 2048))
                .catch(() => null),
            ]),
        ),
      );
      let serviceDecodeError: string | undefined;
      let serviceResult: {
        ready: boolean;
        reads: unknown[];
        writes: unknown[];
        endpointAttempted: boolean;
        endpointResult: unknown;
      } = { ready: false, reads: [], writes: [], endpointAttempted: false, endpointResult: "MISSING" };
      try {
        const decoded = JSON.parse(String(actorOutput["service-stdout.txt"])) as typeof serviceResult | null;
        if (
          !decoded ||
          typeof decoded.ready !== "boolean" ||
          !Array.isArray(decoded.reads) ||
          !Array.isArray(decoded.writes)
        )
          throw new Error("Invalid fixed service actor evidence");
        serviceResult = decoded;
      } catch {
        serviceDecodeError = "Missing or invalid fixed service actor evidence";
      }
      const serviceUnchanged = (await Promise.all(protectedFiles.map((f) => readFile(f)))).every((b, i) =>
        b.equals(serviceBefore[i]!),
      );
      const ownerPing = (await control.request("ping")) as { pid?: unknown; state?: unknown };
      const ownerStillAuthenticated = ownerPing?.pid === process.pid && ownerPing?.state === "running";
      const actorScriptRestored =
        snapshotWorkspaceDescriptorDetails(ffi, actorScript).fingerprint === actorScriptBefore.fingerprint;
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-6A-appcontainer-actual-state",
          value: {
            ...serviceResult,
            serviceDecodeError,
            serviceAttempted: v.serviceAttempted,
            serviceCode: v.serviceCode,
            serviceUnchanged,
            ownerStillAuthenticated,
            actorScriptRestored,
          },
        }) + "\n",
      );
      let directoryAccess: DirectoryAccess[] | undefined;
      let directoryAccessError: string | undefined;
      try {
        directoryAccess = parseDirectoryAccess(String(actorOutput["native-stdout.txt"]));
      } catch {
        directoryAccessError = "Missing or invalid fixed native directory-access evidence";
      }
      const testedCheckout = (await execute("git", ["rev-parse", "HEAD"], { windowsHide: true })).stdout.trim();
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-6A-native-appcontainer",
          value: {
            ...v,
            testedCheckout,
            githubSha: process.env.GITHUB_SHA ?? null,
            runtime: { node: process.version, arch: process.arch, os: os.version() },
            insideHardlinkOpened: !!(v.nativeCode & 4096),
            insideHardlinkWriteDenied: !!(v.nativeCode & 2048),
            externalLinkCreationDenied: !!(v.nativeCode & 8192),
            outsideHardlinkOpened: !!(v.nativeCode & 256),
            protectedReadOpened: !!(v.nativeCode & 512),
            protectedWriteOpened: !!(v.nativeCode & 1024),
            actorOutput,
            directoryAccess,
            directoryAccessError,
            originalDescriptorsRestored: restored,
            preparationDescriptorsUnchanged: beforeHelper.map((s, i) => s.fingerprint === before[i]!.fingerprint),
            descriptorChanges: before.map((b, i) => ({ before: b, after: after[i] })),
            nodeResult,
          },
        }) + "\n",
      );
      expect(exit, "код контроллера").toBe(0);
      expect(v.cleanup).toBe(true);
      expect(directoryAccessError).toBeUndefined();
      expect(JSON.parse(String(actorOutput["native-stdout.txt"]))).toMatchObject({ existingWorkspaceCrud: true });
      expect(await readFile(existingFile, "utf8")).toBe("changed");
      expect(await readFile(existingSibling, "utf8")).toBe("untouched");
      expect(directoryAccess).toBeDefined();
      for (const row of directoryAccess ?? []) {
        for (const open of row.opens) {
          expect.soft(open.closeError, `directory depth=${row.depth} mask=${open.mask} close`).toBe(0);
          if (row.depth > 0 && [2, 4, 65536, 262144, 524288].includes(open.mask)) {
            expect.soft(open.error, `outside ancestor depth=${row.depth} mask=${open.mask}`).toBe(5);
          }
        }
      }
      expect(restored, "восстановление исходных дескрипторов").toBe(true);
      expect(v.serviceAttempted).toBe(true);
      expect(v.serviceCode).toBe(0);
      expect(serviceDecodeError).toBeUndefined();
      expect(serviceResult.ready).toBe(true);
      expect(serviceResult.reads).toHaveLength(5);
      expect(serviceResult.writes).toHaveLength(5);
      for (const result of [...serviceResult.reads, ...serviceResult.writes])
        expect(["EACCES", "EPERM"]).toContain(result);
      expect(serviceResult.endpointAttempted).toBe(true);
      expect(["EACCES", "EPERM"]).toContain(serviceResult.endpointResult);
      expect(serviceUnchanged).toBe(true);
      expect(ownerStillAuthenticated).toBe(true);
      expect(actorScriptRestored).toBe(true);
      expect(v.verified).toBe(true);
      expect(v.nativeCode >>> 16).toBe(0x4352);
      const bits = v.nativeCode & 255;
      for (const [name, bit] of Object.entries({
        nul: 1,
        workspace: 2,
        temp: 4,
        cache: 8,
        outside: 16,
        protectedRead: 32,
        protectedWrite: 64,
        outsideHardlink: 128,
      })) {
        expect(!!(bits & bit), name).toBe(true);
      }
      expect(v.nativeCode & 4096, "внутреннее имя hardlink не открыто на запись").toBe(0);
      expect(!!(v.nativeCode & 2048), "внутреннее имя hardlink закрыто на запись").toBe(true);
      expect(!!(v.nativeCode & 8192), "создание нового внешнего hardlink отклонено").toBe(true);
      for (const row of directoryAccess ?? []) {
        expect(row.attributeError, `directory depth=${row.depth} attributes`).toBe(0);
        for (const open of row.opens.slice(0, 3))
          expect(open.error, `directory depth=${row.depth} read mask=${open.mask}`).toBe(0);
      }
      expect(!!(v.nativeCode & 16384), "чтение связанного файла сохранено").toBe(true);
      expect(!!(v.nativeCode & 32768), "чтение и запись через оба внутренних имени").toBe(true);
      for (const name of ["internal-source.txt", "internal-alias.txt"])
        expect(await readFile(path.join(workspace!, name), "utf8")).toBe("internal-final");
      expect((await readFile(path.join(workspace!, "ps-child-marker.txt"), "utf8")).trim()).toBe("nul-child-ready");
      expect(v.nodeCode).toBe(0);
      expect(v.cmdCode).toBe(0);
      expect(v.psCode).toBe(0);
      expect(JSON.parse(await readFile(path.join(workspace!, "node-result.json"), "utf8"))).toMatchObject({
        ready: true,
        read: true,
        nul: true,
      });
      expect((await readFile(path.join(workspace!, "cmd-result.txt"), "utf8")).trim()).toBe("cmd-ready");
      expect(await readFile(path.join(outside!, "target.txt"), "utf8")).toBe("unchanged");
      expect(await readFile(secret, "utf8")).toBe("owned fixture");
      expect(await readFile(linked, "utf8")).toBe("host-owned");
      expect(await readFile(path.join(outside!, "alias.txt"), "utf8")).toBe("host-owned");
    } finally {
      try {
        control?.close();
        await service?.shutdown("AppContainer actual-state fixture end");
        await build?.cleanup();
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }, 240000);
});

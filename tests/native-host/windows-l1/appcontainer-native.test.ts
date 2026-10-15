/** Mandatory native AD-29 qualification; never interpreted as production availability. */
import { createRequire } from "node:module";
import { snapshotWorkspaceDescriptor } from "./diagnostics/workspace-view-security.js";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, inject, it } from "vitest";
import { buildWorkspaceViewFixture } from "./diagnostics/workspace-view-build.js";
const execute = promisify(execFile);
describe.runIf(process.platform === "win32")("Windows AppContainer без драйвера — обязательная квалификация", () => {
  it("обычные API, NUL, Node/cmd/WinPS и отрицательные проверки исходных путей", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "crot-appc-"));
    let build: Awaited<ReturnType<typeof buildWorkspaceViewFixture>> | undefined;
    try {
      const [workspace, temp, cache, outside] = ["workspace", "temp", "cache", "outside"].map((n) =>
        path.join(root, n),
      );
      for (const p of [workspace!, temp!, cache!, outside!]) await mkdir(p);
      const secret = path.join(workspace!, "protected.txt");
      await writeFile(secret, "owned fixture");
      const ffi = createRequire(import.meta.url)("koffi");
      const snapshots = () => [workspace!, secret].map((file) => snapshotWorkspaceDescriptor(ffi, file));
      const before = snapshots();
      expect(before.every((s) => s.medium)).toBe(true);
      build = await buildWorkspaceViewFixture();
      let exit = 0;
      const result = await execute(build.helper, [workspace!, temp!, cache!, outside!, secret, process.execPath], {
        timeout: 150000,
        maxBuffer: 16384,
      }).catch((error: unknown) => {
        const e = error as { code?: unknown; stdout?: unknown };
        if (typeof e.code !== "number" || typeof e.stdout !== "string") throw error;
        exit = e.code;
        return { stdout: e.stdout };
      });
      const v = JSON.parse(result.stdout) as {
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
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-6A-native-appcontainer",
          value: { ...v, originalDescriptorsRestored: restored, nodeResult },
        }) + "\n",
      );
      expect(exit, "код контроллера").toBe(0);
      expect(v.cleanup).toBe(true);
      expect(restored, "восстановление исходных дескрипторов").toBe(true);
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
    } finally {
      try {
        await build?.cleanup();
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }, 240000);
});

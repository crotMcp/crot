import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { writeFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { procListeners } from "../../src/core/capabilities/projects/ports.js";
import { loadPortFfi } from "../../src/native-host/project-ports/ffi.js";
import { bindMacosPorts } from "../../src/native-host/project-ports/macos.js";
import { bindWindowsPorts } from "../../src/native-host/project-ports/windows.js";
import { NativeHost } from "../../src/native-host/native-host.js";
import { RuntimePermissionState } from "../../src/core/permissions/runtime.js";
import { TestProvider } from "../approval-provider.js";
import { createTestCore, makeTempDirs, testContext as ctx } from "../helpers.js";

async function listener(cwd: string): Promise<{ child: ChildProcess; port: number; close(): Promise<void> }> {
  const child = spawn(
    process.execPath,
    ["-e", 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>console.log(s.address().port));'],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Listener exited before startup")));
    child.stdout!.on("data", (data: Buffer) => {
      output += data.toString();
      if (output.includes("\n")) resolve(Number(output.trim()));
    });
  });
  return {
    child,
    port,
    close: async () => {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    },
  };
}

describe("guarded project inspection", () => {
  it("detects fixed manifests without scripts, secret contents, dependency versions or arbitrary metadata in its result", async () => {
    const dirs = await makeTempDirs(),
      audit = new MemoryAuditSink();
    const core = await createTestCore(
      { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
      audit,
    );
    try {
      await writeFile(
        path.join(dirs.workspace, "package.json"),
        JSON.stringify({
          name: "sensitive-project-name",
          scripts: { postinstall: "must-not-execute" },
          dependencies: { react: "private-version", remotion: "4" },
          devDependencies: { typescript: "5" },
        }),
      );
      await writeFile(path.join(dirs.workspace, "pyproject.toml"), '[project]\nname="private-python"');
      await writeFile(path.join(dirs.workspace, "Dockerfile"), "FROM sensitive-image");
      const result = await core.inspectProject(ctx);
      expect(result.manifests).toEqual([
        { file: "package.json", state: "detected", stack: ["Node.js", "TypeScript", "React", "Remotion"] },
        { file: "pyproject.toml", state: "detected", stack: ["Python"] },
        { file: "Dockerfile", state: "detected", stack: ["Docker"] },
      ]);
      const serialized = JSON.stringify([result, audit.events]);
      for (const text of [
        "sensitive-project-name",
        "must-not-execute",
        "private-version",
        "private-python",
        "sensitive-image",
      ])
        expect(serialized).not.toContain(text);
      expect(audit.events).toContainEqual(
        expect.objectContaining({ operation: "process.project_ports", outcome: "success" }),
      );
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });

  it("reports missing, oversized, malformed and non-file manifests rather than guessing", async () => {
    const dirs = await makeTempDirs();
    const core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
    try {
      await writeFile(path.join(dirs.workspace, "package.json"), '{"secret":bad-json');
      await mkdir(path.join(dirs.workspace, "Dockerfile"));
      expect((await core.inspectProject(ctx)).manifests.map((m) => m.state)).toEqual([
        "invalid",
        "missing",
        "not-file",
      ]);
      await writeFile(path.join(dirs.workspace, "package.json"), " ".repeat(65537));
      expect((await core.inspectProject(ctx)).manifests[0]?.state).toBe("too-large");
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });

  it("refuses filesystem and port observations through the existing capability/runtime gates", async () => {
    const dirs = await makeTempDirs(),
      audit = new MemoryAuditSink(),
      runtime = new RuntimePermissionState();
    const core = await createTestCore(
      { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
      audit,
      { runtimePermissions: runtime },
    );
    try {
      runtime.replace({ strict: false, rules: [{ operation: "filesystem.stat", state: "deny" }] });
      await expect(core.inspectProject(ctx)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(audit.events.some((e) => "operation" in e && e.operation === "process.project_ports")).toBe(false);
      runtime.replace({ strict: false, rules: [{ operation: "process.project_ports", state: "deny" }] });
      await expect(core.inspectProject(ctx)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(audit.events).toContainEqual(
        expect.objectContaining({ operation: "process.project_ports", outcome: "denied" }),
      );
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });

  it("cancellation closes an ask-bound port observation without running it", async () => {
    const dirs = await makeTempDirs(),
      runtime = new RuntimePermissionState(),
      ui = new TestProvider();
    runtime.replace({ strict: false, rules: [{ operation: "process.project_ports", state: "ask" }] });
    const core = await createTestCore(
      { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
      undefined,
      { runtimePermissions: runtime, approvalProviders: [ui] },
    );
    const abort = new AbortController();
    try {
      const work = core.inspectProject({ ...ctx, signal: abort.signal });
      const rejected = expect(work).rejects.toBeDefined();
      await ui.next();
      expect(ui.shown[0]?.request.subject.operation).toBe("process.project_ports");
      abort.abort();
      await rejected;
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });

  it.runIf(["linux", "darwin", "win32"].includes(process.platform))(
    "finds an actual workspace listener, excludes another cwd and does not invent closed ports",
    async () => {
      const dirs = await makeTempDirs();
      const native = await NativeHost.start({
        startupPath: "inherited",
        confinement: false,
        jobObjects: false,
        windowsAcl: false,
      });
      const core = await createTestCore(
        { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
        undefined,
        { platform: native.platform },
      );
      const own = await listener(dirs.workspace),
        outside = await listener(dirs.outside);
      let closed = false;
      try {
        if (process.platform !== "linux") {
          const ffi = await loadPortFfi();
          const api = process.platform === "darwin" ? bindMacosPorts(ffi) : bindWindowsPorts(ffi);
          const signal = new AbortController().signal;
          const metadata = await api.process(own.child.pid!, signal);
          expect(metadata).not.toBeNull();
          expect(await realpath(metadata!.cwd)).toBe(dirs.workspace);
          expect(await api.listeners(signal)).toContainEqual({
            pid: own.child.pid,
            address: "127.0.0.1",
            port: own.port,
          });
        }
        const result = await core.inspectProject(ctx);
        expect(result.ports.status).not.toBe("unavailable");
        expect(result.ports.listeners).toContainEqual({ pid: own.child.pid, address: "127.0.0.1", port: own.port });
        expect(result.ports.listeners.some((p) => p.pid === outside.child.pid)).toBe(false);
        await own.close();
        closed = true;
        expect((await core.inspectProject(ctx)).ports.listeners.some((p) => p.pid === own.child.pid)).toBe(false);
      } finally {
        if (!closed) await own.close();
        await outside.close();
        await core.shutdown();
        await native.close();
        await dirs.cleanup();
      }
    },
  );

  it("decodes listening TCP4/TCP6 sockets only, never established connections", () => {
    const data =
      "header\n 0: 0100007F:1F90 00000000:0000 0A 0:0 0:0 0 1000 0 123\n 1: 00000000000000000000000001000000:1F91 0:0 0A 0:0 0:0 0 1000 0 124\n 2: 0100007F:1F92 0:0 01 0:0 0:0 0 1000 0 125\n";
    expect([...procListeners(data)]).toEqual([
      ["123", { address: "127.0.0.1", port: 8080 }],
      ["124", { address: "0:0:0:0:0:0:0:1", port: 8081 }],
    ]);
  });
});

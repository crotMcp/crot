/** Core must not report a transport failure as a successful child exit. */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { CrotError } from "../../src/core/errors.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import type { ManagedProcess } from "../../src/core/platform/types.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { createTestCore, makeTempDirs, testContext as ctx, type TempDirs } from "../helpers.js";
describe("process transport failure remains inside the existing guard/audit", () => {
  let dirs: TempDirs, core: CrotCore, audit: MemoryAuditSink;
  let child: ManagedProcess;
  let rejectExit = false;
  const failure = new CrotError("OPERATION_FAILED", "Native process transport failed.");
  beforeEach(async () => {
    rejectExit = false;
    dirs = await makeTempDirs();
    audit = new MemoryAuditSink();
    const platform = await createNodePlatform({ startupPath: "inherited" });
    const launcher = {
      ...platform.launcher,
      resolveCommand: platform.launcher.resolveCommand.bind(platform.launcher),
      launch: async () => {
        const stdout = new PassThrough(),
          stderr = new PassThrough();
        child = {
          pid: undefined,
          stdin: null,
          stdout,
          stderr,
          hasExited: true,
          failure,
          exited: rejectExit ? Promise.reject(failure) : Promise.resolve({ code: 0, signal: null }),
          terminate: vi.fn(async () => {
            stdout.destroy();
            stderr.destroy();
          }),
          terminateSync: vi.fn(() => {
            stdout.destroy();
            stderr.destroy();
          }),
        };
        setImmediate(() => {
          stdout.end("partial output");
          stderr.end();
        });
        return child;
      },
    };
    core = await createTestCore({ workspace: { root: dirs.workspace } }, audit, {
      platform: { ...platform, launcher },
    });
  });
  afterEach(async () => {
    await core.shutdown();
    await dirs.cleanup();
  });
  it.each([false, true])(
    "cleans foreground and audits error even with actual exit 0 or rejected supervision (%s)",
    async (rejected) => {
      rejectExit = rejected;
      await expect(core.processes.exec(ctx, { command: process.execPath, args: ["-v"] })).rejects.toBe(failure);
      expect(child.terminate).toHaveBeenCalledWith("force");
      expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
      expect(audit.events.at(-1)).toMatchObject({
        operation: "process.exec",
        outcome: "error",
        error: { code: "OPERATION_FAILED" },
      });
    },
  );
  it("reports background transport failure through authorized read_output, not false successful output", async () => {
    const record = await core.processes.start(ctx, { command: process.execPath, args: ["-v"] });
    await expect(core.processes.readOutput(ctx, { id: record.id })).rejects.toBe(failure);
    expect(audit.events.at(-1)).toMatchObject({
      operation: "process.read_output",
      outcome: "error",
      error: { code: "OPERATION_FAILED" },
    });
  });
});

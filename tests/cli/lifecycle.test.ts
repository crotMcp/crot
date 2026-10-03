import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installLifecycle } from "../../src/cli/lifecycle.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import { isWindows } from "../helpers.js";

function harness(shutdown: (reason: string) => Promise<void> = async () => {}, timeoutMs = 2_000) {
  const host = new EventEmitter();
  const calls: string[] = [];
  const exits: number[] = [];
  const lifecycle = installLifecycle({
    host,
    signals: ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"],
    shutdown: async (reason) => {
      calls.push(`shutdown:${reason}`);
      await shutdown(reason);
    },
    emergency: () => calls.push("emergency"),
    exit: (code) => exits.push(code),
    log: () => undefined,
    timeoutMs,
  });
  return { host, calls, exits, lifecycle };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("host lifecycle", () => {
  it.each(["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"])(
    "%s starts one graceful shutdown and exits 0",
    async (signal) => {
      const h = harness();
      h.host.emit(signal);
      await tick();
      expect(h.calls).toEqual([`shutdown:${signal}`]);
      expect(h.exits).toEqual([0]);
    },
  );

  it("is idempotent for repeated stop requests (stdin end, transport close)", async () => {
    const h = harness();
    h.lifecycle.stop("stdin closed", 0);
    h.lifecycle.stop("transport closed", 0);
    await tick();
    expect(h.calls).toEqual(["shutdown:stdin closed"]);
    expect(h.exits).toEqual([0]);
  });

  it("a second signal during shutdown forces termination", async () => {
    const h = harness(() => new Promise(() => undefined));
    h.host.emit("SIGTERM");
    h.host.emit("SIGINT");
    await tick();
    expect(h.calls).toEqual(["shutdown:SIGTERM", "emergency"]);
    expect(h.exits).toEqual([1]);
  });

  it("forces termination when shutdown exceeds the deadline", async () => {
    const h = harness(() => new Promise(() => undefined), 50);
    h.host.emit("SIGHUP");
    await tick(150);
    expect(h.calls).toEqual(["shutdown:SIGHUP", "emergency"]);
    expect(h.exits).toEqual([1]);
  });

  it("forces termination when shutdown fails", async () => {
    const h = harness(async () => {
      throw new Error("boom");
    });
    h.host.emit("SIGINT");
    await tick();
    expect(h.calls).toEqual(["shutdown:SIGINT", "emergency"]);
    expect(h.exits).toEqual([1]);
  });

  it("fatal errors shut down gracefully with exit code 1", async () => {
    const h = harness();
    h.host.emit("uncaughtException", new Error("bug"));
    await tick();
    expect(h.calls).toEqual(["shutdown:uncaught exception"]);
    expect(h.exits).toEqual([1]);
  });

  it("the exit hook always force-kills remaining process trees synchronously", () => {
    const h = harness();
    h.host.emit("exit", 0);
    expect(h.calls).toEqual(["emergency"]);
  });
});

describe("platform shutdown signals", () => {
  it("include SIGHUP everywhere and SIGBREAK on Windows", async () => {
    const p = await createNodePlatform({ startupPath: "inherited" });
    expect(p.info.shutdownSignals).toEqual(
      isWindows ? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"],
    );
  });

  it("report the process-control guarantees of the launcher", async () => {
    const p = await createNodePlatform({ startupPath: "inherited" });
    expect(p.info.processControl).toEqual(
      isWindows
        ? { treeTermination: "taskkill-tree", orphanedDescendants: false, gracefulTermination: false }
        : { treeTermination: "process-group", orphanedDescendants: true, gracefulTermination: true },
    );
    expect(p.launcher.canTerminateOrphanedDescendants).toBe(p.info.processControl.orphanedDescendants);
  });
});

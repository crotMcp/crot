import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MacosActors } from "../../../src/native-host/macos-l1/actors.js";
import { seatbeltProfile } from "../../../src/native-host/macos-l1/profile.js";
import { createPosixLauncher } from "../../../src/core/platform/node-launcher.js";

describe.runIf(process.platform === "darwin")("native macOS kernel policy ownership", () => {
  it("recognizes only its owned process policy using the real Darwin ABI", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-identity-")));
    const actors = await MacosActors.load();
    const id = await actors.identity(root);
    const workspace = path.join(root, "w");
    await mkdir(workspace);
    const launcher = createPosixLauncher();
    let p: Awaited<ReturnType<typeof launcher.launch>> | undefined;
    try {
      const profile = seatbeltProfile({
        writable: [workspace],
        protectedPaths: [id.denied],
        dockerSocket: path.join(root, "d.sock"),
        network: "on",
      });
      p = await launcher.launch(
        {
          file: "/usr/bin/sandbox-exec",
          args: ["-p", profile, process.execPath, "-e", `console.log('READY');setInterval(()=>{},1000)`],
          display: "owned native policy",
        },
        { cwd: workspace, env: process.env as Record<string, string>, stdin: false },
      );
      let err = "";
      p.stderr.on("data", (b) => (err += String(b)));
      await new Promise<void>((resolve, reject) => {
        p!.stdout.once("data", () => resolve());
        void p!.exited.then(() => reject(Error(err || "child exited before readiness")));
      });
      expect(actors.identityStatus(p.pid!, id)).toMatchObject({ sandboxed: 1, denied: 1, allowed: 0 });
      expect(actors.owns(p.pid!, id)).toBe(true);
      expect(actors.owns(process.pid, id)).toBe(false);
    } finally {
      p?.terminateSync();
      await p?.exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});

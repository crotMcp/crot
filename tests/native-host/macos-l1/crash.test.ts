/** Real SIGKILL of the owner: no owner cleanup callback, no fake actor PID. */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, inject, it } from "vitest";
import { createPosixLauncher } from "../../../src/core/platform/node-launcher.js";
import type { ManagedProcess } from "../../../src/core/platform/types.js";

const builtNativeHost = pathToFileURL(
  path.resolve(path.dirname(inject("crotMcpBin")), "../native-host/native-host.js"),
).href;
const live = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pause = () => new Promise((r) => setTimeout(r, 30));
describe.runIf(process.platform === "darwin")("macOS full lease owner crash recovery", () => {
  it("kills detached/reparented actors and removes private temp after owner SIGKILL without touching an unrelated process", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-mac-crash-"))),
      workspace = path.join(root, "w");
    await mkdir(workspace);
    const base = createPosixLauncher();
    let unrelated: ManagedProcess | undefined;
    const ownerScript = `(async()=>{const {NativeHost}=await import(${JSON.stringify(builtNativeHost)});const n=await NativeHost.start({startupPath:'inherited',stateDir:${JSON.stringify(path.join(root, "s"))}});const c=await n.platform.confinement.open({workspace:${JSON.stringify(workspace)},protectedPaths:[],network:'on',dockerEnvironment:process.env,audit:()=>{}});if(!c.status().available)throw Error(JSON.stringify(c.status()));const p=await c.launcher.launch({file:process.execPath,args:['-e',${JSON.stringify("const p=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(JSON.stringify({actor:process.pid,detached:p.pid,home:process.env.HOME}));p.unref();setInterval(()=>{},1000);")}],display:'crash qualification'},{cwd:${JSON.stringify(workspace)},env:process.env,stdin:false});p.stdout.pipe(process.stdout);p.stderr.pipe(process.stderr)})().catch(e=>{console.error(e);process.exit(1)});`;
    const owner = spawn(process.execPath, ["-e", ownerScript], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const ownerExit = new Promise((resolve) => owner.once("exit", resolve));
    let err = "";
    owner.stderr.on("data", (b) => (err += String(b)));
    let actor = 0,
      detached = 0,
      lease = "";
    try {
      unrelated = await base.launch(
        {
          file: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          display: "unrelated negative ownership control",
        },
        { cwd: root, env: process.env as Record<string, string>, stdin: false },
      );
      const result = await new Promise<{ actor: number; detached: number; home: string }>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(Error("owner readiness timeout " + err)), 20000);
        owner.stdout.on("data", (b) => {
          out += String(b);
          if (out.includes("\n")) {
            try {
              const r = JSON.parse(out.slice(0, out.indexOf("\n"))) as {
                actor: number;
                detached: number;
                home: string;
              };
              clearTimeout(timer);
              resolve(r);
            } catch (e) {
              clearTimeout(timer);
              reject(e);
            }
          }
        });
        void ownerExit.then(() => {
          clearTimeout(timer);
          reject(Error("owner exited before readiness " + err));
        });
      });
      actor = result.actor;
      detached = result.detached;
      lease = path.dirname(result.home);
      expect(actor).toBeGreaterThan(1);
      expect(detached).toBeGreaterThan(1);
      expect(live(actor) && live(detached)).toBe(true);
      owner.kill("SIGKILL");
      await ownerExit;
      let removed = false;
      for (let i = 0; i < 200; i++) {
        try {
          await lstat(lease);
        } catch {
          removed = true;
        }
        if (removed && !live(actor) && !live(detached)) break;
        await pause();
      }
      expect(live(actor), "ordinary actor survived owner death").toBe(false);
      expect(live(detached), "detached actor survived owner death").toBe(false);
      expect(removed, "private lease remains after watchdog recovery").toBe(true);
      expect(live(unrelated.pid!), "watchdog touched an unrelated same-user process").toBe(true);
      console.log(
        "::notice title=CROT-macOS-L1-crash::" +
          JSON.stringify({
            checkout: process.env.GITHUB_SHA,
            node: process.version,
            arch: process.arch,
            owner: "SIGKILL",
            actorsDead: true,
            detachedDead: true,
            tempRemoved: true,
            unrelatedUntouched: true,
          }),
      );
    } finally {
      owner.kill("SIGKILL");
      await ownerExit;
      for (const pid of [actor, detached])
        if (pid > 1 && live(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* emergency test cleanup */
          }
        }
      unrelated?.terminateSync();
      await unrelated?.exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});

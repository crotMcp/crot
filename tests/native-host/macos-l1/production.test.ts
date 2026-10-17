import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createPosixLauncher } from "../../../src/core/platform/node-launcher.js";
import { MacosConfinement } from "../../../src/native-host/macos-l1/confinement.js";
import type { CoreConfinement, ManagedProcess } from "../../../src/core/platform/types.js";

const mac = process.platform === "darwin";
let root: string, workspace: string, state: string;
const sandboxes: CoreConfinement[] = [];
const servers: net.Server[] = [];
async function run(core: CoreConfinement, code: string): Promise<{ out: string; err: string; code: number | null }> {
  const p = await core.launcher.launch(
    { file: process.execPath, args: ["-e", code], display: "macOS native qualification" },
    { cwd: workspace, env: process.env as Record<string, string>, stdin: false },
  );
  return collect(p);
}
async function collect(p: ManagedProcess) {
  let out = "",
    err = "";
  p.stdout.on("data", (c) => {
    out += String(c);
  });
  p.stderr.on("data", (c) => {
    err += String(c);
  });
  const result = await p.exited;
  // exit may precede draining stdio.
  if (!p.stdout.readableEnded) await new Promise<void>((resolve) => p.stdout.once("end", resolve));
  return { out, err, code: result.code };
}
async function open(network: "on" | "off") {
  const provider = new MacosConfinement({ base: createPosixLauncher(), stateDir: state, env: process.env });
  const core = await provider.open({
    workspace,
    protectedPaths: [state],
    network,
    dockerEnvironment: process.env as Record<string, string>,
    audit: () => undefined,
  });
  sandboxes.push(core);
  expect(core.status()).toMatchObject({ mechanism: "macos-seatbelt", available: true, reason: null });
  return core;
}
describe.runIf(mac)("macOS production Seatbelt qualification", () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-mac-test-")));
    workspace = path.join(root, "workspace");
    state = path.join(root, "state");
    await mkdir(workspace);
    await mkdir(state);
    await writeFile(path.join(state, "secret"), "protected");
  });
  afterEach(async () => {
    for (const c of sandboxes.splice(0)) await c.close();
    for (const s of servers.splice(0)) s.close();
    await rm(root, { recursive: true, force: true });
  });
  it("runs node, sh, git and descendants with private HOME and caches", async () => {
    const core = await open("on");
    const r = await run(
      core,
      `const cp=require('child_process'),fs=require('fs');
fs.writeFileSync('workspace-output','ok'); fs.writeFileSync(process.env.TMPDIR+'/probe','tmp');
console.log(cp.execFileSync('/bin/sh',['-c','printf shell']).toString());
console.log(cp.execFileSync('/usr/bin/git',['--version']).toString());
console.log(cp.execFileSync(process.execPath,['-e',"console.log(require('child_process').execFileSync(process.execPath,['-p','42']).toString())"]).toString());
console.log(JSON.stringify({home:process.env.HOME, cache:process.env.npm_config_cache, docker:process.env.DOCKER_HOST}));`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(r.out).toContain("shell");
    expect(r.out).toContain("git version");
    expect(r.out).toContain("42");
    expect(await readFile(path.join(workspace, "workspace-output"), "utf8")).toBe("ok");
    expect(r.out).toContain("crot-l1-");
  });
  it("rejects protected reads/writes, outside writes and symlink escape", async () => {
    const core = await open("on");
    await symlink(root, path.join(workspace, "escape"));
    const targets = [path.join(state, "secret"), path.join(workspace, "escape", "state", "secret")];
    const r = await run(
      core,
      `const fs=require('fs'); const denied=f=>{try{f();throw Error('escaped')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}};
for(const p of ${JSON.stringify(targets)}) {denied(()=>fs.readFileSync(p));denied(()=>fs.writeFileSync(p,'x'));}
for(const p of ${JSON.stringify([path.join(root, "outside"), path.join(workspace, "escape", "outside")])})denied(()=>fs.writeFileSync(p,'x'));console.log('DENIED');`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(r.out).toContain("DENIED");
  });
  it("denies real control and direct Docker sockets, allows only the mediated socket", async () => {
    const control = path.join(state, "control.sock"),
      daemon = path.join(root, "docker.sock");
    for (const p of [control, daemon]) {
      const server = net.createServer((s) => s.end("bad"));
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(p, resolve));
    }
    const core = await open("on");
    const r = await run(
      core,
      `const net=require('net'); Promise.all(${JSON.stringify([control, daemon])}.map(p=>new Promise((resolve,reject)=>{const s=net.connect(p);s.on('connect',()=>reject(Error('escape')));s.on('error',e=>['EPERM','EACCES'].includes(e.code)?resolve():reject(e))}))).then(()=>console.log('SOCKETS-DENIED'),()=>process.exit(1));`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(r.out).toContain("SOCKETS-DENIED");
  });
  it.each(["on", "off"] as const)("network=%s permits host loopback; off refuses non-loopback", async (network) => {
    const server = net.createServer((s) => s.end("loopback-ok"));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const core = await open(network);
    const r = await run(
      core,
      `const n=require('net');const s=n.connect(${port},'127.0.0.1');s.on('data',c=>console.log(c.toString()));s.on('error',()=>process.exit(1));`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(r.out).toContain("loopback-ok");
    if (network === "off") {
      const r = await run(
        core,
        `const s=require('net').connect(443,'192.0.2.1');s.on('connect',()=>process.exit(1));s.on('error',e=>{console.log(e.code);process.exit(['EPERM','EACCES'].includes(e.code)?0:2)});setTimeout(()=>process.exit(3),3000).unref();`,
      );
      expect(r, r.err).toMatchObject({ code: 0 });
    }
  });
  it("remains fail-closed after close", async () => {
    const core = await open("on");
    await core.close();
    await expect(run(core, "console.log('unconfined')")).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
  });
});

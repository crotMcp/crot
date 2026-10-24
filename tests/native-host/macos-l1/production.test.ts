import { runtimeProtectedPaths } from "../../../src/native-host/macos-l1/runtime.js";
import { reinitializationProbe } from "../../../src/native-host/macos-l1/reinitialization.js";
import { execFileSync } from "node:child_process";
import { seatbeltProfile } from "../../../src/native-host/macos-l1/profile.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, realpath, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { DockerUpstream } from "../../../src/native-host/linux-l1/docker-endpoint.js";
import { createPosixLauncher } from "../../../src/core/platform/node-launcher.js";
import { MacosConfinement } from "../../../src/native-host/macos-l1/confinement.js";
import type { CoreConfinement, ManagedProcess } from "../../../src/core/platform/types.js";

const mac = process.platform === "darwin";
let root: string, workspace: string, state: string;
const sandboxes: CoreConfinement[] = [];
const servers: net.Server[] = [];
const refusals: { request: string; reason: string }[] = [];
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
async function open(
  network: "on" | "off",
  upstream?: DockerUpstream,
  projectSecretAllowedPaths: readonly string[] = [],
) {
  const provider = new MacosConfinement({
    base: createPosixLauncher(),
    stateDir: state,
    env: process.env,
    ...(upstream ? { upstream } : {}),
  });
  const core = await provider.open({
    workspace,
    protectedPaths: [state],
    projectSecretAllowedPaths,
    network,
    dockerEnvironment: process.env as Record<string, string>,
    audit: (e) => {
      refusals.push(e);
    },
  });
  sandboxes.push(core);
  expect(core.status()).toMatchObject({ mechanism: "macos-seatbelt", available: true, reason: null });
  return core;
}
describe.runIf(mac)("macOS production Seatbelt qualification", () => {
  beforeEach(async () => {
    refusals.length = 0;
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
  it("compiles the fixed SBPL on the real system", () => {
    const profile = seatbeltProfile({
      writable: [workspace],
      protectedPaths: [state],
      projectSecrets: { root: workspace, allowedPaths: [] },
      dockerSocket: path.join(root, "d.sock"),
      network: "on",
    });
    expect(
      execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", "printf COMPILED"], { encoding: "utf8" }),
    ).toBe("COMPILED");
  });

  it.each(["workspace", 'project [x]+(test) "quoted"'])(
    "denies future secrets in an already running actor (%s), including alias attempts",
    async (name) => {
      if (name !== "workspace") {
        workspace = path.join(root, name);
        await mkdir(workspace);
      }
      const core = await open("on");
      await writeFile(path.join(workspace, "public.txt"), "public");
      const p = await core.launcher.launch(
        {
          file: process.execPath,
          args: [
            "-e",
            `const fs=require('fs');
const denied=(label,f)=>{try{f();throw Error('secret escaped: '+label)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}};
console.log('READY');process.stdin.once('data',()=>{try{
if(fs.readFileSync('public.txt','utf8')!=='public')throw Error('ordinary file broken');
for(const name of ['.env.production','late.KEY','benign.txt'])denied(name+':read',()=>fs.readFileSync(name));
denied('rename',()=>fs.renameSync('.env.production','renamed.txt'));
denied('hardlink',()=>fs.linkSync('.env.production','linked.txt'));
denied('write',()=>fs.writeFileSync('late.KEY','bad'));
console.log('FUTURE-SECRETS-DENIED');process.stdin.destroy();}catch(e){console.error(e);process.exit(1)}});`,
          ],
          display: "future secret native test",
        },
        { cwd: workspace, env: process.env as Record<string, string>, stdin: true },
      );
      const result = collect(p);
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(Error("actor did not become ready")), 5000);
        const listener = (chunk: Buffer) => {
          output += String(chunk);
          if (output.includes("READY")) {
            clearTimeout(timer);
            p.stdout.off("data", listener);
            resolve();
          }
        };
        p.stdout.on("data", listener);
        p.exited.then(() => {
          clearTimeout(timer);
          reject(Error("actor exited before host update"));
        });
      });
      await writeFile(path.join(workspace, ".env.production"), "future-private");
      await writeFile(path.join(workspace, "late.KEY"), "future-key");
      await symlink(path.join(workspace, ".env.production"), path.join(workspace, "benign.txt"));
      p.stdin!.end("go");
      const r = await result;
      expect(r, r.err).toMatchObject({ code: 0 });
      expect(r.out).toContain("FUTURE-SECRETS-DENIED");
      expect(await readFile(path.join(workspace, ".env.production"), "utf8")).toBe("future-private");
      expect(await readFile(path.join(workspace, "late.KEY"), "utf8")).toBe("future-key");
    },
  );
  it("applies exact immutable owner opt-in and removes it only in a new drained sandbox", async () => {
    const approved = path.join(workspace, ".env");
    await writeFile(approved, "approved");
    await writeFile(path.join(workspace, "other.pem"), "private");
    const core = await open("on", undefined, [approved]);
    const r = await run(
      core,
      `const fs=require('fs');if(fs.readFileSync('.env','utf8')!=='approved')throw Error('opt-in failed');try{fs.readFileSync('other.pem');throw Error('broad grant')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}console.log('EXACT-GRANT');`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(r.out).toContain("EXACT-GRANT");
    await core.close();
    const fresh = await open("on");
    const revoked = await run(
      fresh,
      `try{require('fs').readFileSync('.env');throw Error('grant survived')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}console.log('REVOKED');`,
    );
    expect(revoked, revoked.err).toMatchObject({ code: 0 });
    expect(revoked.out).toContain("REVOKED");
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
  it("runs installed npm, pip, cargo, rustc and go using private caches", async () => {
    const core = await open("on");
    const r = await run(
      core,
      `const cp=require('child_process'),fs=require('fs');
for(const [tool,args] of [['npm',['--version']],['python3',['-m','pip','--version']],['cargo',['--version']],['rustc',['--version']],['go',['version']]]) {
let command=tool;let r=cp.spawnSync(command,args,{encoding:'utf8'});
if(tool==='go'&&r.error?.code==='ENOENT'&&process.env.RUNNER_TOOL_CACHE){const root=process.env.RUNNER_TOOL_CACHE+'/go';for(const version of fs.readdirSync(root).sort().reverse()){const candidate=root+'/'+version+'/'+process.arch+'/bin/go';if(fs.existsSync(candidate)){command=candidate;break}}r=cp.spawnSync(command,args,{encoding:'utf8'})}
if(r.error||r.status!==0)throw Error(tool+': '+r.stderr+' '+r.error); console.log(tool+': '+r.stdout.trim());
if(tool==='python3'){cp.execFileSync(command,['-c',"import zipfile\\nwith zipfile.ZipFile('crot_smoke-1.0-py3-none-any.whl','w') as z:\\n z.writestr('crot_smoke.py','answer = 42\\\\n')\\n z.writestr('crot_smoke-1.0.dist-info/METADATA','Metadata-Version: 2.1\\\\nName: crot-smoke\\\\nVersion: 1.0\\\\n')\\n z.writestr('crot_smoke-1.0.dist-info/WHEEL','Wheel-Version: 1.0\\\\nGenerator: crot\\\\nRoot-Is-Purelib: true\\\\nTag: py3-none-any\\\\n')\\n z.writestr('crot_smoke-1.0.dist-info/RECORD','crot_smoke.py,,\\\\ncrot_smoke-1.0.dist-info/METADATA,,\\\\ncrot_smoke-1.0.dist-info/WHEEL,,\\\\ncrot_smoke-1.0.dist-info/RECORD,,\\\\n')\\n"]);cp.execFileSync(command,['-m','pip','install','--no-index','--no-deps','--target','pip-smoke','crot_smoke-1.0-py3-none-any.whl']);cp.execFileSync(command,['-c',"import sys;sys.path.insert(0,'pip-smoke');import crot_smoke;assert crot_smoke.answer==42"])}
if(tool==='go'){fs.writeFileSync('main.go','package main\\nfunc main() {}\\n');cp.execFileSync(command,['build','-o','go-smoke','main.go'],{env:{...process.env,CGO_ENABLED:'0',GOTOOLCHAIN:'local'}});cp.execFileSync('./go-smoke',[])}
if(tool==='cargo'){cp.execFileSync(command,['new','--offline','--vcs','none','rust-smoke']);cp.execFileSync(command,['build','--offline','--manifest-path','rust-smoke/Cargo.toml']);cp.execFileSync('./rust-smoke/target/debug/rust-smoke',[])}
if(tool==='npm'){fs.writeFileSync('package.json',JSON.stringify({name:'crot-mac-smoke',version:'1.0.0',scripts:{test:'node -p 42'}}));cp.execFileSync(command,['install','--ignore-scripts','--offline','--no-audit','--no-fund']);cp.execFileSync(command,['test','--offline'])}
}
const cache=cp.execFileSync('npm',['config','get','cache'],{encoding:'utf8'}).trim();if(cache!==process.env.npm_config_cache)throw Error('npm cache is not private');
for(const name of ['npm_config_cache','PIP_CACHE_DIR','CARGO_HOME','RUSTUP_HOME','GOPATH','GOCACHE'])if(!process.env[name].startsWith(process.env.HOME+'/'))throw Error(name+' escaped private HOME');
console.log('PRIVATE-TOOL-CACHES');`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(r.out).toContain("PRIVATE-TOOL-CACHES");
  }, 120000);
  it("does not grant write handles to the owner/guardian Node and CROT runtime", async () => {
    const core = await open("on");
    // No truncation or writes even if the gate regresses: open/close only.
    const paths = runtimeProtectedPaths();
    const targets = [paths[0]!, path.join(paths[2]!, "package.json")];
    const r = await run(
      core,
      `const fs=require('fs');for(const p of ${JSON.stringify(targets)}){try{const fd=fs.openSync(p,'r+');fs.closeSync(fd);throw Error('writable runtime')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}}console.log('RUNTIME-READONLY');`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(r.out).toContain("RUNTIME-READONLY");
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
  it("returns audited Docker 403 without reaching a daemon", async () => {
    const core = await open("on");
    const r = await run(
      core,
      `const net=require('net');const body=JSON.stringify({Image:'alpine',HostConfig:{Privileged:true}});const s=net.connect(process.env.DOCKER_HOST.slice(7));let out='';s.on('connect',()=>s.write('POST /containers/create HTTP/1.1\\r\\nHost: docker\\r\\nContent-Length: '+Buffer.byteLength(body)+'\\r\\nConnection: close\\r\\n\\r\\n'+body));s.on('data',c=>out+=c);s.on('end',()=>{console.log(out);process.exit(out.includes('403 Forbidden')?0:1)});s.on('error',e=>{console.error(e);process.exit(2)});`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(r.out).toContain("403 Forbidden");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.request).toBe("container.create");
  });
  it("mediates a positive Docker byte stream and refuses protected/writable host binds", async () => {
    const daemon = path.join(root, "mock-daemon.sock");
    const server = net.createServer((s) =>
      s.once("data", () => s.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(daemon, resolve));
    const core = await open("on", {
      local: true,
      transport: "unix",
      connect: () =>
        new Promise((resolve, reject) => {
          const s = net.connect(daemon);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        }),
    });
    const r = await run(
      core,
      `const net=require('net');async function req(target,body){return new Promise((resolve,reject)=>{const s=net.connect(process.env.DOCKER_HOST.slice(7));let out='';s.on('connect',()=>s.write((body?'POST':'GET')+' '+target+' HTTP/1.1\\r\\nHost: docker\\r\\nConnection: close\\r\\n'+(body?'Content-Length: '+Buffer.byteLength(body)+'\\r\\n':'')+'\\r\\n'+(body||'')));s.on('data',b=>out+=b);s.on('end',()=>resolve(out));s.on('error',reject)})};(async()=>{const a=await req('/_ping');if(!a.includes('200 OK'))throw Error(a);for(const bind of ${JSON.stringify([state + ":/state:ro", root + ":/host:rw", workspace + ":/project:ro"])}){const b=await req('/containers/create',JSON.stringify({Image:'test',HostConfig:{Binds:[bind]}}));if(!b.includes('403 Forbidden'))throw Error(b)}console.log('DOCKER-200-403-403-403')})().catch(e=>{console.error(e);process.exit(1)});`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(r.out).toContain("DOCKER-200-403-403-403");
    expect(refusals).toHaveLength(3);
  });
  it("does not modify an external file through a pre-existing workspace hardlink", async () => {
    const external = path.join(root, "preexisting-external");
    await writeFile(external, "ORIGINAL");
    await link(external, path.join(workspace, "preexisting-alias"));
    const core = await open("on");
    const r = await run(
      core,
      `const fs=require('fs');for(const name of ['preexisting-alias','PREEXISTING-ALIAS']){if(!fs.existsSync(name))continue;try{fs.writeFileSync(name,'BAD');throw Error('hardlink escaped')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}}try{fs.renameSync('preexisting-alias','renamed-alias');throw Error('hardlink guard renamed')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}console.log('PREEXISTING-LINK-DENIED');`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(await readFile(external, "utf8")).toBe("ORIGINAL");
  });
  it("refuses admission when a protected secret already has another name outside CROT", async () => {
    await link(path.join(state, "secret"), path.join(root, "secret-alias"));
    const provider = new MacosConfinement({ base: createPosixLauncher(), stateDir: state, env: process.env });
    const c = await provider.open({
      workspace,
      protectedPaths: [state],
      network: "on",
      dockerEnvironment: process.env as Record<string, string>,
      audit: () => {},
    });
    try {
      expect(c.status()).toMatchObject({ available: false, reason: "self_test_failed" });
      await expect(run(c, "console.log(1)")).rejects.toMatchObject({ code: "CONFINEMENT_UNAVAILABLE" });
    } finally {
      await c.close();
      await provider.close();
    }
  });
  it("cannot turn a new external hardlink into an outside write", async () => {
    const external = path.join(root, "outside-hardlink");
    await writeFile(external, "ORIGINAL");
    const core = await open("on");
    const r = await run(
      core,
      `const fs=require('fs');try{fs.linkSync(${JSON.stringify(external)},'alias');fs.writeFileSync('alias','BAD');console.log('ESCAPED');process.exit(1)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('LINK-DENIED')}`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(await readFile(external, "utf8")).toBe("ORIGINAL");
  });
  it("blocks security CLI access to CROT Keychain secrets", async () => {
    const core = await open("on");
    const r = await run(
      core,
      `const cp=require('child_process');const r=cp.spawnSync('/usr/bin/security',['find-generic-password','-s','crot-mcp','-w'],{encoding:'utf8'});console.log(JSON.stringify({status:r.status,stdout:r.stdout}));if(r.status===0)process.exit(1);`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(r.out).toContain('"stdout":""');
  });
  it("kills detached/reparented and ordinary descendants by immutable Seatbelt identity", async () => {
    const core = await open("on");
    const r = await run(
      core,
      `const cp=require('child_process');const p=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(p.pid);p.unref();`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    const detachedPid = Number(r.out.trim());
    expect(detachedPid).toBeGreaterThan(1);
    let detachedAlive = true;
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(detachedPid, 0);
      } catch {
        detachedAlive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(detachedAlive).toBe(false);
    const p = await core.launcher.launch(
      {
        file: process.execPath,
        args: [
          "-e",
          `const p=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(p.pid);setInterval(()=>{},1000);`,
        ],
        display: "tree qualification",
      },
      { cwd: workspace, env: process.env as Record<string, string>, stdin: false },
    );
    const pid = await new Promise<number>((resolve) => p.stdout.once("data", (c) => resolve(Number(String(c).trim()))));
    expect(pid).toBeGreaterThan(0);
    await p.terminate("force");
    await p.exited;
    let alive = true;
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(alive).toBe(false);
  });
  it("blocks changing even the current UID/GID before an actor can hide ownership", async () => {
    const core = await open("on");
    const r = await run(
      core,
      `for(const [set,get] of [['setuid','getuid'],['seteuid','geteuid'],['setgid','getgid'],['setegid','getegid']]){try{process[set](process[get]());throw Error(set+' admitted')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}}console.log('UID-STABLE');`,
    );
    expect(r, r.err).toMatchObject({ code: 0 });
    expect(r.out).toContain("UID-STABLE");
  });
  it("lets the real command finish its graceful SIGTERM handler before draining", async () => {
    const core = await open("on");
    const p = await core.launcher.launch(
      {
        file: process.execPath,
        args: [
          "-e",
          "process.on('SIGTERM',()=>setTimeout(()=>{console.log('GRACEFUL-DONE');process.exit(0)},100));console.log('READY');setInterval(()=>{},1000)",
        ],
        display: "graceful termination",
      },
      { cwd: workspace, env: process.env as Record<string, string>, stdin: false },
    );
    let out = "";
    p.stdout.on("data", (b) => (out += String(b)));
    for (let n = 0; n < 100 && !out.includes("READY"); n++) await new Promise((r) => setTimeout(r, 20));
    expect(out).toContain("READY");
    await p.terminate("graceful");
    expect((await p.exited).code).toBe(0);
    if (!p.stdout.readableEnded) await new Promise<void>((resolve) => p.stdout.once("end", resolve));
    expect(out).toContain("GRACEFUL-DONE");
  });
  it("fails closed and drains existing actors if guardian acknowledgement hits a broken output pipe", async () => {
    const core = await open("on");
    const p = await core.launcher.launch(
      {
        file: process.execPath,
        args: ["-e", "console.log('READY');setInterval(()=>{},1000)"],
        display: "guardian EPIPE qualification",
      },
      { cwd: workspace, env: process.env as Record<string, string>, stdin: false },
    );
    await new Promise<void>((resolve) => p.stdout.once("data", () => resolve()));
    // Trusted test-only access to a private object, not a sandbox API or env override.
    const owner = core as unknown as { watchdog: { child: { stdout: { destroy(): void } } } };
    owner.watchdog.child.stdout.destroy();
    await expect(run(core, "console.log('must-not-run')")).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
    await p.exited;
    expect(core.status().available).toBe(false);
  });
  it("never drains another admitted Core's actors", async () => {
    const a = await open("on"),
      b = await open("on");
    const launch = async (c: CoreConfinement) => {
      const p = await c.launcher.launch(
        {
          file: process.execPath,
          args: ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
          display: "parallel Core",
        },
        { cwd: workspace, env: process.env as Record<string, string>, stdin: false },
      );
      const pid = await new Promise<number>((resolve) =>
        p.stdout.once("data", (b) => resolve(Number(String(b).trim()))),
      );
      return { p, pid };
    };
    const one = await launch(a),
      two = await launch(b);
    expect(one.pid).toBeGreaterThan(1);
    expect(two.pid).toBeGreaterThan(1);
    await one.p.terminate("force");
    await one.p.exited;
    expect(() => process.kill(two.pid, 0)).not.toThrow();
    await two.p.terminate("force");
    await two.p.exited;
  });
  it("does not allow actors to replace or stack their inherited sandbox identity", async () => {
    const core = await open("on");
    const r = await run(core, `${await reinitializationProbe()} console.log('REINIT-DENIED');`);
    expect(r, r.err).toMatchObject({ code: 0 });
  });
  it("remains fail-closed after close", async () => {
    const core = await open("on");
    await core.close();
    await expect(run(core, "console.log('unconfined')")).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
  });
});

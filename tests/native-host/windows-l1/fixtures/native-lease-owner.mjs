/** Real disposable lease owner. Parent kills it without shutdown/ACL cleanup. */
import process from "node:process";
import console from "node:console";
import { setTimeout, setInterval } from "node:timers";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
const [compiledRoot, serialized] = process.argv.slice(2),
  config = JSON.parse(serialized);
const load = (p) => import(pathToFileURL(path.join(compiledRoot, p)).href);
let owner;
try {
  const { WindowsNativeLeases } = await load("native-host/windows-l1/lease-owner.js");
  const { createServicePrivateFiles } = await load("service/private-files.js");
  const { NativeHost } = await load("native-host/native-host.js");
  const { WindowsLaunchEnvironment } = await load("native-host/windows-l1/launch-environment.js");
  const { NativeProcessLauncher } = await load("native-host/windows-l1/native-process.js");
  const { bindAppContainerProcessIdentity } = await load("native-host/windows-l1/appcontainer-process.js");
  const { loadBytePipeApi } = await load("native-host/windows-l1/byte-stdio.js");
  const { loadJobObjectApi } = await load("native-host/windows-job.js");
  const { bindLocalPipeShim } = await load("native-host/windows-l1/local-shim.js");
  const host = await NativeHost.start({ startupPath: "inherited", confinement: false });
  owner = await WindowsNativeLeases.open({
    directory: config.storage,
    ownerSid: config.ownerSid,
    privateFiles: createServicePrivateFiles(true),
  });
  const { openWindowsDockerEndpoint } = await load("native-host/windows-l1/docker-endpoint.js");
  let launcher, docker;
  const refusals = [],
    forwarded = [];
  const upstream = {
    local: true,
    transport: "other",
    connect: async () => {
      const input = new PassThrough(),
        output = new PassThrough();
      let request = "",
        sent = false;
      input.on("data", (bytes) => {
        request += bytes.toString();
        const sep = request.indexOf("\r\n\r\n");
        const length = Number(/content-length:\s*(\d+)/i.exec(request)?.[1] ?? 0);
        if (sent || sep < 0 || request.length < sep + 4 + length) return;
        sent = true;
        forwarded.push(request.split("\r\n")[0]);
        const body = "{}";
        output.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      });
      return Duplex.from({ readable: output, writable: input });
    },
  };
  const lease = await owner.openLease({
    workspace: config.workspace,
    network: "on",
    writableRuntime: [config.runtime],
    readOnlyRuntime: [config.compat],
    protectedPaths: config.protectedPaths,
    start: async (profile, network) => {
      const m = await import("koffi"),
        ffi = m.default ?? m;
      const dll = (n) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", n);
      const shim = bindLocalPipeShim(ffi, path.join(config.compat, "crot-local-shim.dll"));
      docker = await openWindowsDockerEndpoint({
        profile,
        ownerSid: config.ownerSid,
        upstream,
        paths: {
          writable: [config.workspace, config.runtime],
          protectedPaths: config.protectedPaths,
          dockerContextPaths: [],
          unreadable: [],
          daemonSockets: ["\\\\.\\pipe\\docker_engine"],
          // This test never forwards a bind: a lexical identity here is NOT
          // qualification of the production host-path resolver / daemon race.
          resolve: (value) => value,
        },
        onRefusal: (request, reason) => refusals.push({ event: "confinement.docker_refused", request, reason }),
        failed: (error) => {
          console.error(error);
          process.exitCode = 1;
        },
      });
      launcher = new NativeProcessLauncher({
        token: bindAppContainerProcessIdentity(
          ffi,
          { kernel32: dll("kernel32.dll"), advapi32: dll("advapi32.dll") },
          profile,
          config.ownerSid,
          shim,
          network,
        ),
        ownerSid: config.ownerSid,
        pipes: await loadBytePipeApi(),
        jobs: await loadJobObjectApi(),
        environment: host.platform.environment,
        childEnvironment: new WindowsLaunchEnvironment({
          systemRoot: process.env.SystemRoot ?? "C:\\Windows",
          privateRoot: config.runtime,
          runtimeBins: [config.runtime],
          dockerHost: docker.dockerHost,
        }),
        resolver: host.platform.launcher,
      });
      return {
        close: async () => {
          await launcher.close();
          await docker.endpoint.close();
          shim.close();
        },
        closeSync: () => {
          launcher.closeSync();
          docker.endpoint.closeSync();
        },
      };
    },
  });
  const js = `const f=require('fs'),cp=require('child_process'),http=require('http');
const socketPath=process.env.DOCKER_HOST.replace(/^npipe:\\/\\//,'').replaceAll('/','\\\\');
const query=(target,body)=>new Promise((resolve,reject)=>{const data=body?JSON.stringify(body):'';const r=http.request({socketPath,path:target,method:body?'POST':'GET',headers:{'Content-Length':Buffer.byteLength(data),Connection:'close'}},s=>{s.resume();s.on('end',()=>resolve(s.statusCode))});r.on('error',reject);r.end(data)});
(async()=>{const docker=[await query('/_ping'),await query('/containers/create',{HostConfig:{Privileged:true}}),await query('/containers/create',{HostConfig:{Binds:[${JSON.stringify(config.protectedPaths[0] + ":C:\\forbidden:ro")}]}}),await query('/containers/create',{HostConfig:{Binds:['C:\\\\outside:C:\\\\forbidden:rw']}})];
f.mkdirSync('new-dir');f.writeFileSync('new-dir/after.txt','created during lease');f.renameSync('original-0.txt','renamed-0.txt');const c=cp.spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'ignore'});f.writeFileSync('actor-ready.json',JSON.stringify({pid:process.pid,child:c.pid,docker,dockerHost:process.env.DOCKER_HOST}));setInterval(()=>{},1000)})().catch(e=>{console.error(e);process.exit(1)});`;
  const spec = await launcher.resolveCommand(config.executable, ["-e", js], { cwd: config.workspace, env: {} });
  const actor = await launcher.launch(spec, { cwd: config.workspace, env: {}, stdin: false });
  let actorErrors = "";
  actor.stderr.on("data", (bytes) => {
    actorErrors += bytes.toString();
  });
  actor.stdout.resume();
  let ready;
  for (let i = 0; i < 500; i++) {
    try {
      ready = JSON.parse(await readFile(path.join(config.workspace, "actor-ready.json"), "utf8"));
      break;
    } catch {
      if (actor.hasExited)
        throw new Error(`Actor exited before ready: ${JSON.stringify(await actor.exited)} ${actorErrors}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  if (!ready?.child) throw new Error(`actor did not reach real child spawn: ${actorErrors}`);
  process.send?.({ ready: true, plan: lease.plan, actors: ready, refusals, forwarded });
  setInterval(() => {}, 1000);
} catch (e) {
  console.error(e?.stack ?? e);
  try {
    await owner?.close();
  } catch (cleanup) {
    console.error(cleanup?.stack ?? cleanup);
  }
  process.exit(1);
}

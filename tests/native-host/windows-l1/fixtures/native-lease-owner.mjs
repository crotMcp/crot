/** Real disposable lease owner. Parent kills it without shutdown/ACL cleanup. */
import process from "node:process";
import console from "node:console";
import { setTimeout, setInterval } from "node:timers";
import { pathToFileURL } from "node:url";
import path from "node:path";
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
  let launcher;
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
        }),
        resolver: host.platform.launcher,
      });
      return {
        close: async () => {
          await launcher.close();
          shim.close();
        },
        closeSync: () => launcher.closeSync(),
      };
    },
  });
  const js = `const f=require('fs'),cp=require('child_process'); f.mkdirSync('new-dir');f.writeFileSync('new-dir/after.txt','created during lease'); f.renameSync('original-0.txt','renamed-0.txt'); const c=cp.spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'ignore'});f.writeFileSync('actor-ready.json',JSON.stringify({pid:process.pid,child:c.pid}));setInterval(()=>{},1000)`;
  const spec = await launcher.resolveCommand(config.executable, ["-e", js], { cwd: config.workspace, env: {} });
  await launcher.launch(spec, { cwd: config.workspace, env: {}, stdin: false });
  let ready;
  for (let i = 0; i < 500; i++) {
    try {
      ready = JSON.parse(await readFile(path.join(config.workspace, "actor-ready.json"), "utf8"));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  if (!ready?.child) throw new Error("actor did not reach real child spawn");
  process.send?.({ ready: true, plan: lease.plan, actors: ready });
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

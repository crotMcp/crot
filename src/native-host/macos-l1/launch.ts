/** Suspended-in-userspace admission: trusted bootstrap waits for Core's ACK
 * before it runs any caller code. Seatbelt policy identity is kernel-verified
 * while it waits. Only then is stdin released to the command. */
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { CommandSpec, LaunchOptions, ManagedProcess, ProcessLauncher } from "../../core/platform/types.js";
import { MacosActors, type ActorIdentity } from "./actors.js";
import { seatbeltProfile, type SeatbeltLayout } from "./profile.js";

const BOOTSTRAP = `const fs=require('fs'),cp=require('child_process');
const [ack,file,...args]=process.argv.slice(1);
fs.writeSync(1,ack);const b=Buffer.alloc(Buffer.byteLength(ack));let n=0;
while(n<b.length){let r;try{r=fs.readSync(0,b,n,b.length-n,null)}catch(e){if(e.code!=='EAGAIN')throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);continue}if(!r)process.exit(125);n+=r;}
if(b.toString()!==ack)process.exit(125);
const p=cp.spawn(file,args,{stdio:'inherit',env:process.env});
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{try{p.kill(sig)}catch{}});
p.on('error',()=>process.exit(127));p.on('exit',(code,signal)=>{if(signal){process.removeAllListeners(signal);try{process.kill(process.pid,signal)}catch{process.exit(128)}}else process.exit(code??1)});`;

export async function launchSeatbelt(
  base: ProcessLauncher,
  actors: MacosActors,
  id: ActorIdentity,
  layout: SeatbeltLayout,
  spec: CommandSpec,
  options: LaunchOptions,
  assertOpen: () => void,
): Promise<ManagedProcess> {
  assertOpen();
  const ack = `CROT-L1-${randomUUID()}\n`;
  const profile = seatbeltProfile({ ...layout, protectedPaths: [...layout.protectedPaths, id.denied] });
  const proc = await base.launch(
    {
      file: "/usr/bin/sandbox-exec",
      args: ["-p", profile, process.execPath, "-e", BOOTSTRAP, ack, spec.file, ...spec.args],
      display: spec.display,
    },
    { ...options, stdin: true },
  );
  const output = new PassThrough();
  let startup = Buffer.alloc(0),
    admitted = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Seatbelt admission timeout")), 10_000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const data = (chunk: Buffer) => {
        if (admitted) {
          if (!output.write(chunk)) {
            proc.stdout.pause();
            output.once("drain", () => proc.stdout.resume());
          }
          return;
        }
        startup = Buffer.concat([startup, chunk]);
        if (startup.length < Buffer.byteLength(ack)) return;
        if (startup.subarray(0, Buffer.byteLength(ack)).toString() !== ack || !proc.pid || !actors.owns(proc.pid, id)) {
          finish(new Error("Seatbelt identity mismatch"));
          return;
        }
        admitted = true;
        const rest = startup.subarray(Buffer.byteLength(ack));
        if (rest.length) output.write(rest);
        finish();
      };
      proc.stdout.on("data", data);
      proc.stdout.on("end", () => {
        output.end();
        if (!admitted) finish(new Error("Seatbelt bootstrap ended"));
      });
      proc.stdout.on("error", (e) => {
        output.destroy(e);
        if (!admitted) finish(e);
      });
      void proc.exited.then(() => {
        if (!admitted) finish(new Error("Seatbelt bootstrap exited"));
      });
    });
    assertOpen();
    proc.stdin!.write(ack);
    if (!options.stdin) proc.stdin!.end();
    return {
      pid: proc.pid,
      stdin: options.stdin ? proc.stdin : null,
      stdout: output,
      stderr: proc.stderr,
      exited: proc.exited,
      get hasExited() {
        return proc.hasExited;
      },
      get failure() {
        return proc.failure;
      },
      terminate: async (mode) => actors.signal(id, mode),
      terminateSync: () => actors.signal(id, "force"),
    };
  } catch (error) {
    // No ACK: user code has not run. Stop the trusted bootstrap as well as any
    // actor with this immutable policy identity; there is no alternate launch.
    proc.terminateSync();
    actors.signal(id, "force");
    output.destroy();
    throw error;
  }
}

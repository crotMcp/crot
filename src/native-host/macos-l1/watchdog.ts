/** Trusted out-of-sandbox guardian. EOF of a private, non-inherited pipe also
 * drains actors after SIGKILL of Core; no exit handler in the dead owner is
 * needed. User code never receives this pipe or a guardian request endpoint.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { MacosActors, type ActorIdentity } from "./actors.js";

export class MacosWatchdog {
  private readonly pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private alive = true;
  private closing = false;
  private failureHandler: (() => void) | undefined;
  private readonly exited: Promise<number | null>;
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      this.pending.get(line)?.resolve();
      this.pending.delete(line);
    });
    this.exited = new Promise((resolve) =>
      child.once("exit", (code) => {
        this.alive = false;
        if (!this.closing) this.failureHandler?.();
        for (const p of this.pending.values()) p.reject(Error("macOS guardian exited"));
        this.pending.clear();
        resolve(code);
      }),
    );
    child.on("error", () => {
      this.alive = false;
      if (!this.closing) this.failureHandler?.();
      for (const p of this.pending.values()) p.reject(Error("macOS guardian failed"));
      this.pending.clear();
    });
    child.stdin.on("error", () => undefined);
    child.stderr.resume();
  }
  static async start(root: string): Promise<MacosWatchdog> {
    // This is trusted, bundled class code, not user-provided/evaluated SBPL.
    // Sharing the actual ownership implementation prevents a second, weaker
    // crash-recovery matcher. Only these self-contained methods run here.
    const source = `const {createRequire}=require('node:module'),{createInterface}=require('node:readline'),fs=require('node:fs'),path=require('node:path');
const __name=(v)=>v; const Actors=(${MacosActors.toString()});
const ffi=createRequire(${JSON.stringify(import.meta.url)})('koffi');
const p=ffi.load('/usr/lib/libproc.dylib'),s=ffi.load('/usr/lib/libsandbox.1.dylib');
const actors=new Actors(p.func('int proc_listpids(uint32_t,uint32_t,void *,int)'),p.func('int proc_pidinfo(int,int,uint64_t,void *,int)'),s.func('int sandbox_check(int,const char *,int,...)'));
const root=${JSON.stringify(root)},ids=new Map();let ended=false;
const drain=()=>{if(ended)return;ended=true;let failed=false;for(const id of ids.values()){try{actors.signal(id,'force')}catch{failed=true}}if(!failed)fs.rmSync(root,{recursive:true,force:true});process.exit(failed?1:0)};
process.on('SIGTERM',drain);process.on('SIGINT',drain);
const lines=createInterface({input:process.stdin});lines.on('line',line=>{try{const m=JSON.parse(line);const id=m.id;if(!id||path.dirname(id.denied)!==root||path.dirname(id.allowed)!==root||!/^[-0-9a-f]{36}$/.test(path.basename(id.denied))||!/^[-0-9a-f]{36}$/.test(path.basename(id.allowed)))throw Error('invalid identity');if(m.kind==='add'){ids.set(id.denied,id);console.log(id.denied)}else if(m.kind==='forget'){ids.delete(id.denied)}else throw Error('invalid command')}catch{drain()}});lines.on('close',drain);console.log('READY');`;
    const child = spawn(process.execPath, ["-e", source], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const watchdog = new MacosWatchdog(child);
    try {
      await watchdog.wait("READY", () => undefined);
      return watchdog;
    } catch (error) {
      child.stdin.destroy();
      child.kill("SIGKILL");
      throw error;
    }
  }
  onFailure(handler: () => void): void {
    this.failureHandler = handler;
    if (!this.running) handler();
  }
  get running(): boolean {
    return this.alive && !this.closing;
  }
  private async wait(key: string, send: () => void): Promise<void> {
    if (!this.running) throw Error("macOS guardian unavailable");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(Error("macOS guardian timeout"));
      }, 10000);
      this.pending.set(key, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      send();
    });
  }
  async register(id: ActorIdentity): Promise<void> {
    await this.wait(id.denied, () => this.child.stdin.write(JSON.stringify({ kind: "add", id }) + "\n"));
  }
  forget(id: ActorIdentity): void {
    if (this.running) this.child.stdin.write(JSON.stringify({ kind: "forget", id }) + "\n");
  }
  closeSync(): void {
    this.closing = true;
    this.child.stdin.destroy();
  }
  async close(): Promise<void> {
    this.closeSync();
    const code = await this.exited;
    if (code !== 0) throw Error("macOS guardian drain failed");
  }
}

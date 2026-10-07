/**
 * One running L1 sandbox: crot-bwrap with crot-l1-init as PID 1, driven over
 * the private channel (init's stdin/stdout; frame format in
 * l1/native/crot-l1-init.c). It starts, streams, signals and reaps; it makes
 * no decision about what runs (ARCHITECTURE.md §27 AD-20 point 10).
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { constants as osConstants } from "node:os";
import { PassThrough, Writable, type Readable } from "node:stream";
import type { ExitStatus, ManagedProcess, TerminationMode } from "../../core/platform/types.js";

export const FRAME = {
  START: 1,
  STDIN: 2,
  SIGNAL: 3,
  SELFTEST: 4,
  PING: 5,
  HELLO: 10,
  STARTED: 11,
  START_FAILED: 12,
  STDOUT: 13,
  STDERR: 14,
  EXIT: 15,
  GONE: 16,
  SELFTEST_RESULT: 17,
  PONG: 18,
  ERROR: 19,
} as const;

const HEADER = 9;
const MAX_STDERR = 16 * 1024;

export function encodeFrame(type: number, id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(HEADER);
  h.writeUInt8(type, 0);
  h.writeUInt32BE(id >>> 0, 1);
  h.writeUInt32BE(payload.length, 5);
  return Buffer.concat([h, payload]);
}

/** NUL-terminated strings. Throws on a NUL inside a value (cannot be represented). */
export function encodeStrings(values: readonly string[]): Buffer {
  for (const v of values) if (v.includes("\0")) throw new Error("a value contains a NUL character");
  return Buffer.from(values.map((v) => `${v}\0`).join(""), "utf8");
}

export function startPayload(
  file: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  stdin: boolean,
): Buffer {
  const envList = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return encodeStrings([
    cwd,
    String(args.length + 1),
    file,
    ...args,
    String(envList.length),
    ...envList,
    stdin ? "1" : "0",
  ]);
}

/** Incremental frame decoder. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly onFrame: (type: number, id: number, payload: Buffer) => void) {}
  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= HEADER) {
      const len = this.buffer.readUInt32BE(5);
      if (this.buffer.length < HEADER + len) return;
      const type = this.buffer.readUInt8(0);
      const id = this.buffer.readUInt32BE(1);
      const payload = this.buffer.subarray(HEADER, HEADER + len);
      this.buffer = this.buffer.subarray(HEADER + len);
      this.onFrame(type, id, payload);
    }
  }
}

export class SandboxError extends Error {
  constructor(
    message: string,
    /** crot-bwrap's diagnostic output (never shown to agents; used to classify overlay/userns failures). */
    readonly diagnostics = "",
  ) {
    super(message);
  }
}

export class LaunchError extends Error {
  constructor(
    message: string,
    readonly errno: number,
  ) {
    super(message);
  }
}

const SIGNAL_NAMES = new Map<number, string>(
  Object.entries(osConstants.signals).map(([name, n]) => [n as number, name] as const),
);

interface Command {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  started: { resolve: (pid: number) => void; reject: (e: Error) => void } | undefined;
  exit: (s: ExitStatus) => void;
  gone: () => void;
  goneSeen: boolean;
  exited: boolean;
}

export interface SandboxSpawn {
  readonly file: string;
  readonly args: readonly string[];
}

/** A running sandbox. */
export class Sandbox {
  private readonly commands = new Map<number, Command>();
  private readonly pending = new Map<number, (payload: Buffer) => void>();
  private nextId = 1;
  private stderrText = "";
  private ended = false;
  private endError: SandboxError | undefined;
  private readonly endedPromise: Promise<SandboxError>;
  private resolveEnded!: (e: SandboxError) => void;
  /** AppArmor label reported by crot-l1-init ("none" without AppArmor). */
  label = "";

  private constructor(private readonly child: ChildProcessByStdio<Writable, Readable, Readable>) {
    this.endedPromise = new Promise((resolve) => (this.resolveEnded = resolve));
  }

  /** Start crot-bwrap and wait for crot-l1-init's HELLO (its own label). */
  static async start(
    spawnSpec: SandboxSpawn,
    onEnd?: (error: SandboxError) => void,
    timeoutMs = 15_000,
  ): Promise<Sandbox> {
    const child = spawn(spawnSpec.file, [...spawnSpec.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {},
      detached: false,
    });
    const sandbox = new Sandbox(child);
    const hello = new Promise<string>((resolve, reject) => {
      sandbox.pending.set(0, (payload) => resolve(payload.toString("utf8")));
      void sandbox.endedPromise.then(reject);
    });
    const decoder = new FrameDecoder((type, id, payload) => sandbox.onFrame(type, id, payload));
    child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (sandbox.stderrText.length < MAX_STDERR) sandbox.stderrText += chunk.toString("utf8");
    });
    child.stdin.on("error", () => sandbox.end("the sandbox channel closed"));
    child.on("error", (error) =>
      sandbox.end(`crot-bwrap could not be started (${(error as NodeJS.ErrnoException).code ?? "error"})`),
    );
    child.on("exit", (code, signal) => sandbox.end(`the sandbox ended (${signal ?? `exit ${code}`})`));
    if (onEnd) void sandbox.endedPromise.then(onEnd);
    let timer: NodeJS.Timeout | undefined;
    try {
      sandbox.label = await Promise.race([
        hello,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SandboxError("the sandbox did not start in time")), timeoutMs);
        }),
      ]);
    } catch (error) {
      sandbox.kill();
      if (error instanceof SandboxError) throw new SandboxError(error.message, sandbox.stderrText);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    return sandbox;
  }

  get running(): boolean {
    return !this.ended;
  }

  /** crot-bwrap's diagnostic output so far. */
  get diagnostics(): string {
    return this.stderrText;
  }

  /** Resolves when the sandbox has ended. */
  get whenEnded(): Promise<SandboxError> {
    return this.endedPromise;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Commands still running (not GONE). */
  get size(): number {
    return this.commands.size;
  }

  private send(frame: Buffer): void {
    if (this.ended) throw new SandboxError(this.endError?.message ?? "the sandbox has ended");
    this.child.stdin.write(frame);
  }

  private onFrame(type: number, id: number, payload: Buffer): void {
    if (type === FRAME.HELLO || type === FRAME.SELFTEST_RESULT || type === FRAME.PONG || type === FRAME.ERROR) {
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      waiter?.(type === FRAME.ERROR ? Buffer.from(`ERROR ${payload.toString("utf8")}`) : payload);
      return;
    }
    const cmd = this.commands.get(id);
    if (!cmd) return;
    switch (type) {
      case FRAME.STARTED:
        cmd.started?.resolve(Number(payload.toString("utf8")));
        cmd.started = undefined;
        break;
      case FRAME.START_FAILED: {
        const errno = Number(/errno:(\d+)/.exec(payload.toString("utf8"))?.[1] ?? 0);
        cmd.started?.reject(new LaunchError(`the command could not be started (errno ${errno})`, errno));
        cmd.started = undefined;
        break;
      }
      case FRAME.STDOUT:
        if (payload.length === 0) cmd.stdout.end();
        else cmd.stdout.write(Buffer.from(payload));
        break;
      case FRAME.STDERR:
        if (payload.length === 0) cmd.stderr.end();
        else cmd.stderr.write(Buffer.from(payload));
        break;
      case FRAME.EXIT: {
        const text = payload.toString("utf8");
        const code = /^code:(\d+)$/.exec(text);
        const sig = /^signal:(\d+)$/.exec(text);
        cmd.exit({
          code: code ? Number(code[1]) : null,
          signal: sig ? (SIGNAL_NAMES.get(Number(sig[1])) ?? `SIG${sig[1]}`) : null,
        });
        break;
      }
      case FRAME.GONE:
        cmd.goneSeen = true;
        if (!cmd.stdout.writableEnded) cmd.stdout.end();
        if (!cmd.stderr.writableEnded) cmd.stderr.end();
        cmd.exit({ code: null, signal: "SIGKILL" });
        cmd.gone();
        this.commands.delete(id);
        break;
      default:
        break;
    }
  }

  private end(message: string): void {
    if (this.ended) return;
    this.ended = true;
    this.endError = new SandboxError(message, this.stderrText);
    for (const waiter of this.pending.values()) waiter(Buffer.from(`ERROR ${message}`));
    this.pending.clear();
    for (const cmd of this.commands.values()) {
      cmd.started?.reject(this.endError);
      cmd.started = undefined;
      if (!cmd.stdout.writableEnded) cmd.stdout.end();
      if (!cmd.stderr.writableEnded) cmd.stderr.end();
      cmd.exit({ code: null, signal: "SIGKILL" });
      cmd.gone();
    }
    this.commands.clear();
    this.resolveEnded(this.endError);
  }

  /** Run the boundary self-test probes; returns crot-l1-init's report lines. */
  async selftest(ops: readonly string[]): Promise<string[]> {
    const id = this.nextId++;
    const result = new Promise<Buffer>((resolve) => this.pending.set(id, resolve));
    this.send(encodeFrame(FRAME.SELFTEST, id, encodeStrings(ops)));
    const text = (await result).toString("utf8");
    if (text.startsWith("ERROR ")) throw new SandboxError(text.slice(6));
    return text.split("\n").filter(Boolean);
  }

  async ping(timeoutMs = 5_000): Promise<boolean> {
    if (this.ended) return false;
    const id = this.nextId++;
    const result = new Promise<Buffer>((resolve) => this.pending.set(id, resolve));
    try {
      this.send(encodeFrame(FRAME.PING, id));
    } catch {
      return false;
    }
    let timer: NodeJS.Timeout | undefined;
    const reply = await Promise.race([
      result,
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs))),
    ]);
    if (timer) clearTimeout(timer);
    return reply !== null && reply.length === 0;
  }

  /**
   * Start a command under its own subreaper. Rejects with LaunchError when
   * exec fails inside the sandbox, with SandboxError when the sandbox cannot
   * run it.
   */
  async launch(
    file: string,
    args: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
    stdin: boolean,
  ): Promise<ManagedProcess> {
    const id = this.nextId++;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let exitStatus: ExitStatus | undefined;
    let resolveExit!: (s: ExitStatus) => void;
    const exited = new Promise<ExitStatus>((resolve) => (resolveExit = resolve));
    let resolveGone!: () => void;
    const gone = new Promise<void>((resolve) => (resolveGone = resolve));
    let pidResolve!: (pid: number) => void;
    let pidReject!: (e: Error) => void;
    const started = new Promise<number>((resolve, reject) => {
      pidResolve = resolve;
      pidReject = reject;
    });
    const cmd: Command = {
      stdout,
      stderr,
      started: { resolve: pidResolve, reject: pidReject },
      exit: (s) => {
        if (exitStatus) return;
        exitStatus = s;
        cmd.exited = true;
        resolveExit(s);
      },
      gone: () => resolveGone(),
      goneSeen: false,
      exited: false,
    };
    this.commands.set(id, cmd);
    try {
      this.send(encodeFrame(FRAME.START, id, startPayload(file, args, cwd, env, stdin)));
    } catch (error) {
      this.commands.delete(id);
      throw error;
    }
    let pid: number;
    try {
      pid = await started;
    } catch (error) {
      this.commands.delete(id);
      throw error;
    }
    const send = (frame: Buffer) => this.send(frame);
    const isRunning = () => this.running;
    const endSandbox = () => this.kill();
    const signal = (how: "T" | "K") => {
      if (cmd.goneSeen || !isRunning()) return;
      try {
        send(encodeFrame(FRAME.SIGNAL, id, Buffer.from(how)));
      } catch {
        // The sandbox has ended: so has the tree.
      }
    };
    const stdinStream = stdin
      ? new Writable({
          write(chunk: Buffer, _enc, callback) {
            try {
              for (let off = 0; off < chunk.length; off += 1 << 20) {
                send(encodeFrame(FRAME.STDIN, id, chunk.subarray(off, off + (1 << 20))));
              }
              callback();
            } catch (error) {
              callback(error as Error);
            }
          },
          final(callback) {
            try {
              send(encodeFrame(FRAME.STDIN, id));
            } catch {
              // ended
            }
            callback();
          },
        })
      : null;
    stdinStream?.on("error", () => undefined);
    return {
      pid,
      stdin: stdinStream,
      stdout,
      stderr,
      exited,
      get hasExited() {
        return cmd.exited;
      },
      terminate: async (mode: TerminationMode) => {
        signal(mode === "force" ? "K" : "T");
        if (mode === "force") await Promise.race([gone, new Promise((r) => setTimeout(r, 2_000))]);
      },
      terminateSync: () => {
        // CROT is exiting: end the whole sandbox (every tree in it ends with PID 1).
        endSandbox();
      },
    };
  }

  /** End the sandbox: crot-l1-init (PID 1) exits and the kernel ends every process in it. */
  async close(timeoutMs = 3_000): Promise<void> {
    if (this.ended) return;
    try {
      this.child.stdin.end();
    } catch {
      // already closed
    }
    const timer = setTimeout(() => this.kill(), timeoutMs);
    await this.endedPromise;
    clearTimeout(timer);
  }

  /** Forced, synchronous end of the sandbox. */
  kill(): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

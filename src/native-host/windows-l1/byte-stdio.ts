/**
 * Owned native byte streams. Parent I/O is OVERLAPPED (never blocking ReadFile/
 * WriteFile on the event loop); child ends are ordinary blocking byte handles.
 * This module is a launcher component, not a confinement availability proof.
 */
import { randomBytes } from "node:crypto";
import { Duplex, Readable, Writable } from "node:stream";
import { CrotError } from "../../core/errors.js";
import { validateSid } from "../validation.js";
import type { TokenFfi, TokenLibraries } from "./restricted-token.js";

export type NativeHandle = unknown;
export interface PipeOperation {
  readonly completed: boolean;
  poll(): { state: "pending" } | { state: "complete"; bytes: number } | { state: "eof" };
  cancel(): void;
  /** Only legal after completion. Native memory must remain pinned until then. */
  release(): void;
}
export interface BytePipe {
  readonly parent: NativeHandle;
  readonly child: NativeHandle;
  read(buffer: Buffer): PipeOperation;
  write(buffer: Buffer): PipeOperation;
  closeParent(): void;
  closeChild(): void;
}
export interface LocalByteServer {
  readonly path: string;
  close(): Promise<void>;
  closeSync(): void;
}
export interface LocalByteServerOptions {
  readonly ownerSid: string;
  readonly packageSid: string;
  readonly accept: (connection: Duplex) => void;
  readonly failed: (error: Error) => void;
}
export interface BytePipeApi {
  /** Trusted service transport. Never a relaxation of host pipe DACLs. */
  listenLocal?(options: LocalByteServerOptions): Promise<LocalByteServer>;
  create(direction: "input" | "output", ownerSid: string): Promise<BytePipe>;
}
const failure = (stage: string, code?: number) =>
  new CrotError(
    "OPERATION_FAILED",
    `Native byte stdio: ${stage} failed${code === undefined ? "" : ` (code ${code})`}.`,
    { stage, ...(code === undefined ? {} : { nativeCode: code }) },
  );
const valid = (h: unknown) =>
  h !== undefined && h !== null && h !== 0 && h !== 0n && h !== -1n && h !== 0xffffffffffffffffn;
const ok = (n: unknown) => n === true || (typeof n === "number" && n !== 0);
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
// A broken driver must never cause native buffers to be garbage-collected while
// the kernel may still write them. Quarantine is fatal for this transport, not
// a successful cleanup or a reason to continue launching on the same backend.
const quarantined = new Set<PipeOperation>();
// Completed requests can still own an event if CloseHandle fails. Their exact
// operation object retains that event and its released flag, avoiding handle
// reuse/ABA when another creator retries cleanup before allocating anything.
const failedCompletedReleases = new Set<PipeOperation>();
// Failed setup never returns an owner to the caller. Retain its exact,
// idempotent release actions and refuse more allocation until all recover.
const failedSetupReleases = new Set<() => void>();
const failedLocalSockets = new Set<LocalDuplex>();
function releaseSetup(action: () => void): void {
  const retry = () => {
    action();
    failedSetupReleases.delete(retry);
  };
  try {
    retry();
  } catch {
    failedSetupReleases.add(retry);
  }
}
function retryStdioReleases(): void {
  let error: unknown;
  for (const operation of failedCompletedReleases) {
    try {
      operation.release();
    } catch (cause) {
      error ??= cause;
    }
  }
  for (const release of failedSetupReleases) {
    try {
      release();
    } catch (cause) {
      error ??= cause;
    }
  }
  for (const socket of failedLocalSockets) {
    try {
      socket.closeNativeSync();
    } catch (cause) {
      error ??= cause;
    }
  }
  if (error) throw error;
}
export function quarantinedStdioOperations(): number {
  return quarantined.size;
}

class Endpoint {
  private pending?: PipeOperation;
  private closed = false;
  private parentClosed = false;
  private releaseParent(): void {
    if (this.parentClosed) return;
    this.pipe.closeParent();
    this.parentClosed = true;
  }
  private closing?: Promise<void>;
  constructor(readonly pipe: BytePipe) {}
  async transfer(buffer: Buffer, write: boolean): Promise<number | null> {
    if (this.closed || this.pending) throw failure("endpoint state");
    const operation = write ? this.pipe.write(buffer) : this.pipe.read(buffer);
    this.pending = operation;
    let value: number | null = null;
    let failed: { cause: unknown } | undefined;
    try {
      for (;;) {
        const status = operation.poll();
        if (status.state === "eof") break;
        if (status.state === "complete") {
          if (!Number.isSafeInteger(status.bytes) || status.bytes < 0 || status.bytes > buffer.length)
            throw failure("invalid byte count");
          value = status.bytes;
          break;
        }
        await delay();
      }
    } catch (cause) {
      failed = { cause };
    }
    try {
      // Even an unexpected FFI exception cannot release memory still owned by
      // the kernel. Cancellation is acknowledged before clearing ownership.
      if (!operation.completed) {
        operation.cancel();
        const deadline = Date.now() + 5000;
        while (!operation.completed) {
          try {
            operation.poll();
          } catch (error) {
            if (!operation.completed) throw error;
          }
          if (Date.now() >= deadline && !operation.completed) throw failure("transfer completion deadline");
          if (!operation.completed) await delay();
        }
      }
    } catch (cause) {
      failed ??= { cause };
    }
    if (!operation.completed) {
      quarantined.add(operation);
      this.closed = true;
      // Retain the endpoint and operation; never free an outstanding OVERLAPPED.
      failed ??= { cause: failure("incomplete transfer ownership") };
    } else {
      try {
        operation.release();
        this.pending = undefined;
      } catch (cause) {
        // Completion is not successful resource release. Keep this exact
        // request reachable for close/retry and forbid another transfer.
        this.closed = true;
        failed ??= { cause };
      }
    }
    if (failed) throw failed.cause;
    return value;
  }
  close(): Promise<void> {
    if (this.parentClosed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      if (this.pending && !this.pending.completed) this.pending.cancel();
      const deadline = Date.now() + 5000;
      while (this.pending) {
        if (this.pending.completed) {
          this.pending.release();
          this.pending = undefined;
          break;
        }
        if (Date.now() >= deadline) {
          quarantined.add(this.pending);
          throw failure("cancel completion deadline");
        }
        await delay();
      }
      this.releaseParent();
    })().catch((error: unknown) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
  closeSync(): void {
    if (this.parentClosed) return;
    this.closed = true;
    if (this.pending) {
      const operation = this.pending;
      operation.cancel();
      // The process-exit path cannot pump the JS loop. Poll native completion
      // directly before permitting any handle/memory release.
      const deadline = Date.now() + 5000;
      while (!operation.completed) {
        try {
          operation.poll();
        } catch (error) {
          if (!operation.completed) throw error;
        }
        if (Date.now() >= deadline && !operation.completed) {
          quarantined.add(operation);
          throw failure("synchronous cancel completion deadline");
        }
      }
      operation.release();
      this.pending = undefined;
    }
    this.releaseParent();
  }
}
/** A duplex server instance owns both directions until both cancellations drain. */
class LocalDuplex extends Duplex {
  private reading = false;
  private readonly input: Endpoint;
  private readonly output: Endpoint;
  private closing?: Promise<void>;
  constructor(pipe: BytePipe) {
    super({ allowHalfOpen: true, highWaterMark: 32768 });
    let directions = 0;
    const side = () => {
      let counted = false;
      return () => {
        if (!counted) {
          counted = true;
          directions++;
        }
        if (directions === 2) pipe.closeParent();
      };
    };
    this.input = new Endpoint({ ...pipe, closeParent: side() });
    this.output = new Endpoint({ ...pipe, closeParent: side() });
    this.on("error", () => undefined);
  }
  override _read(): void {
    if (this.reading || this.destroyed) return;
    this.reading = true;
    const data = Buffer.alloc(32768);
    void this.input.transfer(data, false).then(
      (bytes) => {
        this.reading = false;
        if (this.destroyed) return;
        if (bytes === null || bytes === 0) this.push(null);
        else if (this.push(data.subarray(0, bytes))) this._read();
      },
      (error: Error) => this.destroy(error),
    );
  }
  override _write(data: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    void (async () => {
      let offset = 0;
      while (offset < data.length) {
        const bytes = await this.output.transfer(data.subarray(offset), true);
        if (!bytes) throw failure("LOCAL write EOF");
        offset += bytes;
      }
    })().then(
      () => done(),
      (error: Error) => done(error),
    );
  }
  override _final(done: (error?: Error | null) => void): void {
    // Named byte pipes have no independent write FIN. The protocol ends the
    // request with HTTP framing, and the completed reply closes the instance.
    done();
    this.destroy();
  }
  closeNative(): Promise<void> {
    if (!this.closing)
      this.closing = (async () => {
        const results = await Promise.allSettled([this.input.close(), this.output.close()]);
        const failed = results.find((r) => r.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        failedLocalSockets.delete(this);
      })().catch((cause: unknown) => {
        failedLocalSockets.add(this);
        this.closing = undefined;
        throw cause;
      });
    return this.closing;
  }
  closeNativeSync(): void {
    let error: unknown;
    for (const end of [this.input, this.output])
      try {
        end.closeSync();
      } catch (cause) {
        error ??= cause;
      }
    if (error) {
      failedLocalSockets.add(this);
      throw error;
    }
    failedLocalSockets.delete(this);
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    void this.closeNative().then(
      () => done(error),
      (cause: Error) => done(cause),
    );
  }
}

class PipeReadable extends Readable {
  private busy = false;
  constructor(private readonly endpoint: Endpoint) {
    super({ highWaterMark: 32768 });
  }
  override _read(): void {
    if (this.busy || this.destroyed) return;
    this.busy = true;
    const buffer = Buffer.alloc(32768);
    void this.endpoint.transfer(buffer, false).then(
      (count) => {
        this.busy = false;
        if (this.destroyed) return;
        if (count === null || count === 0) this.push(null);
        else if (this.push(buffer.subarray(0, count))) setImmediate(() => this._read());
      },
      (error: Error) => {
        this.busy = false;
        if (!this.destroyed) this.destroy(error);
      },
    );
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    void this.endpoint.close().then(
      () => done(error),
      (cleanup: Error) => done(error ?? cleanup),
    );
  }
}
class PipeWritable extends Writable {
  constructor(private readonly endpoint: Endpoint) {
    super({ highWaterMark: 32768 });
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    void (async () => {
      let offset = 0;
      while (offset < chunk.length) {
        const length = Math.min(chunk.length - offset, 32768);
        const count = await this.endpoint.transfer(chunk.subarray(offset, offset + length), true);
        if (count === null || count === 0) throw failure("stdin closed before write completion", 109);
        offset += count;
      }
    })().then(
      () => done(),
      (error: Error) => done(error),
    );
  }
  override _final(done: (error?: Error | null) => void): void {
    void this.endpoint.close().then(
      () => done(),
      (error: Error) => done(error),
    );
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    void this.endpoint.close().then(
      () => done(error),
      (cleanup: Error) => done(error ?? cleanup),
    );
  }
}

export interface NativeByteStdio {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  close(): Promise<void>;
  closeSync(): void;
}
export function isNativeByteStdio(value: unknown): value is NativeByteStdio {
  return typeof value === "object" && value !== null && owned.has(value as NativeByteStdio);
}
const owned = new WeakMap<NativeByteStdio, { pipes: BytePipe[]; released: boolean; consumed: boolean }>();
/** Internal launcher authority. A fabricated object or external handle list is refused. */
export function ownedStdioHandles(stdio: NativeByteStdio): readonly NativeHandle[] {
  const state = owned.get(stdio);
  if (!state || state.consumed) throw failure("unowned child handles");
  return state.pipes.map((pipe) => pipe.child);
}
export function releaseStdioChildEnds(stdio: NativeByteStdio): void {
  const state = owned.get(stdio);
  if (!state) throw failure("unowned transport");
  if (state.released) return;
  // Once release begins the bridge can never authorize another launch, even
  // when one close fails. Retain ownership so cleanup can retry failed closes.
  state.consumed = true;
  let error: unknown;
  for (const pipe of state.pipes) {
    try {
      pipe.closeChild();
    } catch (e) {
      error ??= e;
    }
  }
  if (error) throw error;
  state.released = true;
}
export async function createNativeByteStdio(api: BytePipeApi, ownerSid: string): Promise<NativeByteStdio> {
  validateSid(ownerSid);
  retryStdioReleases();
  if (quarantined.size) throw failure("previous incomplete cancellation");
  const pipes: BytePipe[] = [];
  try {
    for (const direction of ["input", "output", "output"] as const) pipes.push(await api.create(direction, ownerSid));
  } catch (error) {
    for (const pipe of pipes) {
      for (const release of [() => pipe.closeChild(), () => pipe.closeParent()]) {
        releaseSetup(release);
      }
    }
    throw error;
  }
  const endpoints = pipes.map((pipe) => new Endpoint(pipe));
  const input = new PipeWritable(endpoints[0]!);
  const output = new PipeReadable(endpoints[1]!);
  const errors = new PipeReadable(endpoints[2]!);
  // Always install transport listeners before the caller can attach a consumer.
  // The ManagedProcess adapter owns propagation; no unhandled EventEmitter error.
  for (const stream of [input, output, errors]) stream.on("error", () => undefined);
  const result: NativeByteStdio = {
    stdin: input,
    stdout: output,
    stderr: errors,
    close: async () => {
      let childError: unknown;
      try {
        releaseStdioChildEnds(result);
      } catch (error) {
        childError = error;
      }
      input.destroy();
      output.destroy();
      errors.destroy();
      const settled = await Promise.allSettled(endpoints.map((endpoint) => endpoint.close()));
      const failed = settled.find((r) => r.status === "rejected");
      if (childError) throw childError;
      if (failed?.status === "rejected") throw failed.reason;
    },
    closeSync: () => {
      let error: unknown;
      try {
        releaseStdioChildEnds(result);
      } catch (e) {
        error = e;
      }
      for (const endpoint of endpoints) {
        try {
          endpoint.closeSync();
        } catch (e) {
          error ??= e;
        }
      }
      input.destroy();
      output.destroy();
      errors.destroy();
      if (error) throw error;
    },
  };
  owned.set(result, { pipes, released: false, consumed: false });
  return Object.freeze(result);
}

const COUNT = "CROT_BYTE_COUNT";
const HANDLE = "CROT_BYTE_HANDLE";
const SECURITY = "CROT_BYTE_SECURITY";
const declared = new WeakSet<object>();
export function bindBytePipeApi(ffi: TokenFfi, libraries: TokenLibraries): BytePipeApi {
  if (!declared.has(ffi)) {
    ffi.struct(COUNT, { value: "uint32_t" });
    ffi.struct(HANDLE, { value: "void *" });
    ffi.struct(SECURITY, { length: "uint32_t", descriptor: "void *", inherit: "int32_t" });
    declared.add(ffi);
  }
  if (ffi.sizeof(SECURITY) !== 24 || ffi.sizeof("void *") !== 8) throw failure("64-bit ABI");
  const k = ffi.load(libraries.kernel32),
    a = ffi.load(libraries.advapi32);
  const last = k.func("uint32_t __stdcall GetLastError(void)");
  const free = k.func("void * __stdcall LocalFree(void *memory)");
  const sd = a.func(
    `int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ ${HANDLE} *out, void *size)`,
  );
  const server = k.func(
    `void * __stdcall CreateNamedPipeW(str16 name, uint32_t access, uint32_t mode, uint32_t instances, uint32_t outSize, uint32_t inSize, uint32_t timeout, ${SECURITY} *security)`,
  );
  const client = k.func(
    "void * __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, void *template)",
  );
  const connect = k.func("int __stdcall ConnectNamedPipe(void *pipe, void *overlapped)");
  const read = k.func(
    `int __stdcall ReadFile(void *file, void *buffer, uint32_t length, void *count, void *overlapped)`,
  );
  const write = k.func(
    `int __stdcall WriteFile(void *file, void *buffer, uint32_t length, void *count, void *overlapped)`,
  );
  const result = k.func(
    `int __stdcall GetOverlappedResult(void *file, void *overlapped, _Out_ ${COUNT} *count, int wait)`,
  );
  const cancel = k.func("int __stdcall CancelIoEx(void *file, void *overlapped)");
  const event = k.func("void * __stdcall CreateEventW(void *security, int manual, int initial, str16 name)");
  const close = k.func("int __stdcall CloseHandle(void *handle)");
  const inherit = k.func("int __stdcall SetHandleInformation(void *handle, uint32_t mask, uint32_t flags)");
  const errorCode = () => Number(last());
  const release = (h: NativeHandle) => {
    if (valid(h) && !ok(close(h))) throw failure("CloseHandle", errorCode());
  };
  const operation = (handle: NativeHandle, buffer: Buffer, start: (overlap: Buffer) => unknown): PipeOperation => {
    const doneEvent = event(null, 1, 0, null);
    if (!valid(doneEvent)) throw failure("CreateEventW", errorCode());
    const overlap = Buffer.alloc(32);
    ffi.encode(overlap.subarray(24), "void *", doneEvent);
    let terminal = false,
      released = false,
      initial: number;
    try {
      initial = ok(start(overlap)) ? 0 : errorCode();
    } catch (error) {
      release(doneEvent);
      throw error;
    }
    if (![0, 997, 535, 109, 232].includes(initial)) {
      release(doneEvent);
      throw failure("start overlapped I/O", initial);
    }
    let lastStatus: ReturnType<PipeOperation["poll"]> | undefined;
    let terminalError: Error | undefined;
    const ownedOperation: PipeOperation = {
      get completed() {
        return terminal;
      },
      poll: () => {
        if (released) throw failure("poll after release");
        // Capture buffer in this object until completion, not only in an FFI call.
        if (!Buffer.isBuffer(buffer)) throw failure("operation buffer ownership");
        if (terminalError) throw terminalError;
        if (terminal) return lastStatus!;
        if ([109, 232].includes(initial)) {
          terminal = true;
          return (lastStatus = { state: "eof" });
        }
        if (initial === 535) {
          terminal = true;
          return (lastStatus = { state: "complete", bytes: 0 });
        }
        const count: { value?: number } = {};
        if (ok(result(handle, overlap, count, 0))) {
          terminal = true;
          return (lastStatus = { state: "complete", bytes: count.value! });
        }
        const code = errorCode();
        if (code === 996) return { state: "pending" };
        terminal = true;
        if ([109, 232].includes(code)) return (lastStatus = { state: "eof" });
        // Cancellation is terminal as well: memory can now be released safely.
        terminalError = failure("complete overlapped I/O", code);
        throw terminalError;
      },
      cancel: () => {
        if (!terminal && !released && !ok(cancel(handle, overlap))) {
          const code = errorCode();
          if (code !== 1168) throw failure("CancelIoEx", code);
        }
      },
      release: () => {
        if (released) return;
        if (!terminal) throw failure("release of pending native memory");
        try {
          release(doneEvent);
          released = true;
          failedCompletedReleases.delete(ownedOperation);
        } catch (error) {
          failedCompletedReleases.add(ownedOperation);
          throw error;
        }
      },
    };
    return ownedOperation;
  };
  return {
    listenLocal: async (options) => {
      validateSid(options.ownerSid);
      if (!/^S-1-15-2-(?:\d+-){6}\d+$/.test(options.packageSid)) throw failure("LOCAL package SID");
      retryStdioReleases();
      if (quarantined.size) throw failure("previous incomplete cancellation");
      const name = `\\\\.\\pipe\\LOCAL\\crot-l1-docker-${randomBytes(24).toString("hex")}`;
      // LOCAL is virtualized only for an AppContainer caller. The trusted
      // host must listen in that package/session's *physical* NPFS namespace,
      // while child DOCKER_HOST keeps the documented logical LOCAL address.
      const convertSid = a.func(`int __stdcall ConvertStringSidToSidW(str16 text, _Out_ ${HANDLE} *out)`);
      const objectPath = k.func(
        `int __stdcall GetAppContainerNamedObjectPath(void *token, void *sid, uint32_t length, void *path, _Out_ ${COUNT} *needed)`,
      );
      const packageSid: { value?: NativeHandle } = {};
      let physical: string;
      try {
        if (!ok(convertSid(options.packageSid, packageSid)) || !valid(packageSid.value))
          throw failure("LOCAL package SID allocation", errorCode());
        const text = Buffer.alloc(8192),
          needed: { value?: number } = {};
        if (!ok(objectPath(null, packageSid.value, text.length / 2, text, needed)))
          throw failure("LOCAL named-object path", errorCode());
        const count = text.indexOf(Buffer.from([0, 0]));
        // UTF-16 terminators must be found on a code-unit boundary.
        let end = 0;
        while (end + 1 < text.length && text.readUInt16LE(end) !== 0) end += 2;
        if (end === 0 || end >= text.length || count < 0) throw failure("LOCAL named-object path length");
        const prefix = text.subarray(0, end).toString("utf16le").replace(/\\+$/, "");
        if (
          !/^\\Sessions\\[0-9]+\\AppContainerNamedObjects\\S-1-15-2-/.test(prefix) ||
          !prefix.endsWith(`\\${options.packageSid}`)
        )
          throw failure("LOCAL named-object namespace");
        physical = `\\\\.\\pipe${prefix}\\${name.slice(name.lastIndexOf("\\") + 1)}`;
      } finally {
        if (valid(packageSid.value))
          releaseSetup(() => {
            if (valid(free(packageSid.value))) throw failure("LOCAL package SID LocalFree", errorCode());
            packageSid.value = undefined;
          });
      }
      const descriptor: { value?: NativeHandle } = {};
      const sockets = new Set<LocalDuplex>();
      let listener: NativeHandle,
        connection: PipeOperation | undefined,
        stopping = false,
        first = true;
      let accepting: Promise<void> = Promise.resolve();
      let closing: Promise<void> | undefined;
      const releaseDescriptor = () => {
        if (valid(descriptor.value)) {
          if (valid(free(descriptor.value))) throw failure("LOCAL descriptor LocalFree", errorCode());
          descriptor.value = undefined;
        }
      };
      const closeListener = () => {
        if (valid(listener)) {
          release(listener);
          listener = undefined;
        }
      };
      const cancelConnectionSync = () => {
        if (!connection) return;
        connection.cancel();
        const deadline = Date.now() + 5000;
        while (!connection.completed) {
          try {
            connection.poll();
          } catch (cause) {
            if (!connection.completed) throw cause;
          }
          if (Date.now() >= deadline && !connection.completed) {
            quarantined.add(connection);
            throw failure("LOCAL accept cancellation deadline");
          }
        }
        connection.release();
        connection = undefined;
      };
      const prepare = () => {
        listener = server(physical, 3 | 0x40000000 | (first ? 0x80000 : 0), 8, 255, 65536, 65536, 0, {
          length: 24,
          descriptor: descriptor.value,
          inherit: 0,
        });
        if (!valid(listener)) throw failure("LOCAL CreateNamedPipeW", errorCode());
        first = false;
        if (!ok(inherit(listener, 1, 0))) throw failure("LOCAL noninheritance", errorCode());
        connection = operation(listener, Buffer.alloc(0), (overlap) => connect(listener, overlap));
      };
      try {
        // No SYSTEM/ALL APPLICATION PACKAGES/Everyone grant. Generic write
        // necessarily includes bit 4 (CREATE_PIPE_INSTANCE); only clients in
        // this same disposable lease can use it. The service never connects to
        // or trusts this child-facing address. Host daemon credentials stay host-side.
        if (
          !ok(
            sd(
              `D:P(A;;GA;;;${options.ownerSid})(A;;0x12019f;;;${options.packageSid})S:(ML;;NW;;;LW)`,
              1,
              descriptor,
              null,
            ),
          )
        )
          throw failure("LOCAL descriptor", errorCode());
        if (!valid(descriptor.value)) throw failure("LOCAL descriptor output");
        prepare();
        accepting = (async () => {
          while (!stopping) {
            const status = connection!.poll();
            if (status.state === "pending") {
              await delay();
              continue;
            }
            if (status.state !== "complete") throw failure("LOCAL accept EOF");
            connection!.release();
            connection = undefined;
            const handle = listener;
            listener = undefined;
            let closed = false;
            const socket = new LocalDuplex({
              parent: handle,
              child: undefined,
              read: (buffer) =>
                operation(handle, buffer, (overlap) => read(handle, buffer, buffer.length, null, overlap)),
              write: (buffer) =>
                operation(handle, buffer, (overlap) => write(handle, buffer, buffer.length, null, overlap)),
              closeChild: () => undefined,
              closeParent: () => {
                if (!closed) {
                  release(handle);
                  closed = true;
                }
              },
            });
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            // Keep an owned instance alive while opening the next one: no
            // moment exists at which another process can squat the name.
            prepare();
            options.accept(socket);
          }
        })().catch((cause: unknown) => {
          if (!stopping) options.failed(cause instanceof Error ? cause : failure("LOCAL accept"));
        });
      } catch (cause) {
        stopping = true;
        try {
          cancelConnectionSync();
          closeListener();
        } catch {
          /* retained native operations fail closed */
        }
        releaseSetup(releaseDescriptor);
        throw cause;
      }
      return Object.freeze({
        path: name,
        close: () => {
          if (!closing)
            closing = (async () => {
              stopping = true;
              cancelConnectionSync();
              await accepting;
              closeListener();
              const results = await Promise.allSettled(
                [...sockets].map(async (socket) => {
                  socket.destroy();
                  await socket.closeNative();
                }),
              );
              const failed = results.find((r) => r.status === "rejected");
              if (failed?.status === "rejected") throw failed.reason;
              releaseDescriptor();
            })().catch((cause: unknown) => {
              closing = undefined;
              throw cause;
            });
          return closing;
        },
        closeSync: () => {
          stopping = true;
          cancelConnectionSync();
          closeListener();
          let error: unknown;
          for (const socket of sockets)
            try {
              socket.closeNativeSync();
              socket.destroy();
            } catch (cause) {
              error ??= cause;
            }
          if (error) throw error;
          releaseDescriptor();
        },
      });
    },
    create: async (direction, ownerSid) => {
      validateSid(ownerSid);
      retryStdioReleases();
      if (quarantined.size) throw failure("previous incomplete cancellation");
      const descriptor: { value?: NativeHandle } = {};
      let parent: NativeHandle, child: NativeHandle;
      let connection: PipeOperation | undefined;
      let parentClosed = false,
        childClosed = false;
      const closeParent = () => {
        if (!parentClosed && valid(parent)) {
          release(parent);
          parentClosed = true;
        }
      };
      const closeChild = () => {
        if (!childClosed && valid(child)) {
          release(child);
          childClosed = true;
        }
      };
      const releaseDescriptor = () => {
        if (valid(descriptor.value)) {
          if (valid(free(descriptor.value))) throw failure("pipe descriptor LocalFree", errorCode());
          descriptor.value = undefined;
        }
      };
      const name = `\\\\.\\pipe\\crot-byte-${randomBytes(24).toString("hex")}`;
      try {
        // Parent-only IPC: Medium NR/NW; only handles already opened by this
        // trusted process will be transferred to the Low child. No network pipe.
        if (!ok(sd(`D:P(A;;GA;;;${ownerSid})(A;;GA;;;SY)S:(ML;;NWNR;;;ME)`, 1, descriptor, null)))
          throw failure("pipe descriptor", errorCode());
        if (!valid(descriptor.value)) throw failure("pipe descriptor output");
        parent = server(name, (direction === "input" ? 2 : 1) | 0x40000000 | 0x80000, 8, 1, 65536, 65536, 0, {
          length: 24,
          descriptor: descriptor.value,
          inherit: 0,
        });
        if (!valid(parent)) throw failure("CreateNamedPipeW", errorCode());
        if (!ok(inherit(parent, 1, 0))) throw failure("parent noninheritance", errorCode());
        connection = operation(parent, Buffer.alloc(0), (overlap) => connect(parent, overlap));
        child = client(name, direction === "input" ? 0x80000000 : 0x40000000, 0, null, 3, 0, null);
        if (!valid(child)) throw failure("open child pipe", errorCode());
        if (!ok(inherit(child, 1, 0))) throw failure("child initial noninheritance", errorCode());
        const deadline = Date.now() + 5000;
        for (;;) {
          const state = connection.poll();
          if (state.state !== "pending") {
            if (state.state !== "complete") throw failure("pipe connection EOF");
            break;
          }
          if (Date.now() >= deadline) throw failure("pipe connection deadline");
          await delay();
        }
        connection.release();
        connection = undefined;
        // Complete descriptor release before returning the pipe. If it fails,
        // setup still owns both ends and the catch below retains all failures.
        releaseDescriptor();
        return {
          parent,
          child,
          read: (buffer) => operation(parent, buffer, (overlap) => read(parent, buffer, buffer.length, null, overlap)),
          write: (buffer) =>
            operation(parent, buffer, (overlap) => write(parent, buffer, buffer.length, null, overlap)),
          closeParent,
          closeChild,
        };
      } catch (error) {
        let incomplete = false;
        if (connection) {
          try {
            connection.cancel();
            const deadline = Date.now() + 5000;
            while (!connection.completed) {
              try {
                connection.poll();
              } catch (failure) {
                if (!connection.completed) throw failure;
              }
              if (Date.now() >= deadline && !connection.completed) throw failure("setup cancel completion deadline");
              if (!connection.completed) await delay();
            }
          } catch {
            incomplete = !connection.completed;
          }
          if (incomplete) quarantined.add(connection);
          else {
            try {
              connection.release();
            } catch {
              /* preserve setup failure */
            }
          }
        }
        // A pending kernel request still owns its OVERLAPPED and parent handle.
        // Closing the child is safe; never free or close the quarantined parent.
        releaseSetup(closeChild);
        if (!incomplete) releaseSetup(closeParent);
        releaseSetup(releaseDescriptor);
        throw error;
      }
    },
  };
}
export async function loadBytePipeApi(): Promise<BytePipeApi> {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) throw failure("native platform");
  const moduleName: string = "koffi";
  const module = await import(moduleName);
  return bindBytePipeApi(module.default ?? module, { kernel32: "kernel32.dll", advapi32: "advapi32.dll" });
}

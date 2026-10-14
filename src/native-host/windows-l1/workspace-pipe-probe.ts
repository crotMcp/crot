/**
 * Disposable WP-23c transport. One root, bounded fixed filesystem verbs,
 * owner-only local Low pipe, per-run capability. NO execute/read/open-handle
 * verb, impersonation, network listener or registration in NativeHost/Core.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { validateSid } from "../validation.js";
import type { TokenFfi } from "./restricted-token.js";
import { loadWorkspaceProbe, type WorkspaceProbe } from "./workspace-probe.js";

const MAX_MESSAGE = 64 * 1024;
const declared = new WeakSet<object>();
export interface WorkspacePipeProbe {
  readonly pipe: string;
  /** Research run capability, not a CROT credential. Do not log. */
  readonly capability: string;
  close(): Promise<void>;
}

export async function startWorkspacePipeProbe(root: string, ownerSid: string): Promise<WorkspacePipeProbe> {
  validateSid(ownerSid);
  const workspace: WorkspaceProbe = await loadWorkspaceProbe(root);
  const name: string = "koffi";
  const imported = await import(name);
  const ffi = (imported.default ?? imported) as TokenFfi;
  if (!declared.has(ffi)) {
    ffi.struct("CROT_WS_PIPE_SD", { value: "void *" });
    ffi.struct("CROT_WS_PIPE_COUNT", { value: "uint32_t" });
    ffi.struct("CROT_WS_PIPE_ATTRIBUTES", {
      nLength: "uint32_t",
      lpSecurityDescriptor: "void *",
      bInheritHandle: "int",
    });
    declared.add(ffi);
  }
  const k = ffi.load("kernel32.dll");
  const a = ffi.load("advapi32.dll");
  const descriptor = a.func(
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ CROT_WS_PIPE_SD *sd, void *size)",
  );
  const free = k.func("void * __stdcall LocalFree(void *memory)");
  const create = k.func(
    "void * __stdcall CreateNamedPipeW(str16 name, uint32_t access, uint32_t mode, uint32_t instances, uint32_t outSize, uint32_t inSize, uint32_t timeout, CROT_WS_PIPE_ATTRIBUTES *attributes)",
  );
  const connect = k.func("int __stdcall ConnectNamedPipe(void *pipe, void *overlapped)");
  const read = k.func(
    "int __stdcall ReadFile(void *pipe, _Out_ uint8_t *bytes, uint32_t size, _Out_ CROT_WS_PIPE_COUNT *count, void *overlapped)",
  );
  const write = k.func(
    "int __stdcall WriteFile(void *pipe, uint8_t *bytes, uint32_t size, _Out_ CROT_WS_PIPE_COUNT *count, void *overlapped)",
  );
  const disconnect = k.func("int __stdcall DisconnectNamedPipe(void *pipe)");
  const lastError = k.func("uint32_t __stdcall GetLastError(void)");
  const close = k.func("int __stdcall CloseHandle(void *handle)");
  const pipe = `\\\\.\\pipe\\crot-workspace-probe-${randomBytes(24).toString("hex")}`;
  const capability = randomBytes(32).toString("hex");
  const sd: { value?: unknown } = {};
  let handle: unknown;
  try {
    // Only this NEW disposable endpoint is Low. Never relabel workspace files.
    if (!descriptor(`D:P(A;;GA;;;${ownerSid})S:(ML;;NW;;;LW)`, 1, sd, null) || !sd.value)
      throw new Error("Workspace probe pipe descriptor failed.");
    handle = create(pipe, 0x80003, 0xf, 1, MAX_MESSAGE, MAX_MESSAGE, 1000, {
      nLength: ffi.sizeof("CROT_WS_PIPE_ATTRIBUTES"),
      lpSecurityDescriptor: sd.value,
      bInheritHandle: 0,
    }); // first instance, duplex; message/NOWAIT, reject remote clients.
    if (!handle || handle === -1n || handle === 0xffffffffffffffffn)
      throw new Error("Workspace probe pipe creation failed.");
  } catch (e) {
    workspace.close();
    throw e;
  } finally {
    if (sd.value) free(sd.value);
  }
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        // Nonblocking pipe: no worker thread can outlive teardown. GetLastError
        // is sampled synchronously on the same thread as its native operation.
        let connected = false;
        while (!stopped && !connected) {
          const ok = connect(handle, null);
          const error = ok ? 0 : lastError();
          connected = Boolean(ok) || error === 535; // ERROR_PIPE_CONNECTED
          if (!connected) await delay(5);
        }
        if (stopped) break;
        const bytes = Buffer.alloc(MAX_MESSAGE);
        const count: { value?: number } = {};
        let ok: unknown = 0;
        const deadline = Date.now() + 5000;
        while (!stopped && Date.now() < deadline) {
          ok = read(handle, bytes, bytes.length, count, null);
          if (ok || lastError() !== 232) break; // NO_DATA in NOWAIT mode
          await delay(5);
        }
        if (stopped) break;
        let accepted = false;
        try {
          if (!ok || !count.value || count.value >= MAX_MESSAGE) throw new Error("frame");
          const envelope = JSON.parse(bytes.subarray(0, count.value).toString("utf8")) as Record<string, unknown>;
          if (
            !envelope ||
            typeof envelope !== "object" ||
            Array.isArray(envelope) ||
            Object.keys(envelope).length !== 2 ||
            typeof envelope.capability !== "string" ||
            envelope.capability.length !== 64 ||
            !timingSafeEqual(Buffer.from(envelope.capability, "utf8"), Buffer.from(capability, "utf8"))
          )
            throw new Error("capability");
          workspace.execute(envelope.request);
          accepted = true;
        } catch {
          // No paths, contents, capabilities or native error details on wire.
        }
        if (!stopped) {
          const response = Buffer.from(JSON.stringify({ ok: accepted }) + "\n");
          write(handle, response, response.length, {}, null);
          // NOWAIT writes finish immediately. Give the client time to consume
          // the tiny response before disconnect discards unread pipe buffers.
          const deadline = Date.now() + 1000;
          const peek = k.func(
            "int __stdcall PeekNamedPipe(void *pipe, void *buffer, uint32_t size, void *read, _Out_ CROT_WS_PIPE_COUNT *available, void *left)",
          );
          // Client acknowledges receipt with one byte, never a second verb.
          while (!stopped && Date.now() < deadline) {
            const available: { value?: number } = {};
            if (!peek(handle, null, 0, null, available, null) || available.value) break;
            await delay(5);
          }
        }
      } catch {
        // Failed/abandoned connections grant nothing. Reconnect unless closing.
      } finally {
        if (!stopped) disconnect(handle);
      }
    }
  })();
  let closing: Promise<void> | undefined;
  return {
    pipe,
    capability,
    close() {
      closing ??= (async () => {
        stopped = true;
        await loop;
        disconnect(handle);
        try {
          if (!close(handle)) throw new Error("Workspace probe pipe close failed.");
        } finally {
          workspace.close();
        }
      })();
      return closing;
    },
  };
}

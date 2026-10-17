/** Probe the raw kernel apply path too: compiler IPC denial alone is not proof
 * that a malicious actor cannot stack a precompiled profile and hide identity. */
import { createRequire } from "node:module";
type Fn = (...args: unknown[]) => unknown;
interface Ffi {
  load(name: string): { func(name: string, result: unknown, args: unknown[]): Fn };
  struct(fields: Record<string, string>): unknown;
  pointer(type: unknown): unknown;
  decode(pointer: unknown, type: unknown): unknown;
  view(pointer: unknown, size: number): ArrayBuffer;
}
let script: Promise<string> | undefined;
export function reinitializationProbe(): Promise<string> {
  return (script ??= compile());
}
async function compile(): Promise<string> {
  const name: string = "koffi";
  const imported = (await import(name)) as { default: Ffi };
  const ffi = imported.default;
  const lib = ffi.load("/usr/lib/libsandbox.1.dylib");
  const profile = ffi.struct({ builtin: "void *", data: "void *", size: "size_t" });
  const error = Buffer.alloc(8);
  const pointer = lib.func("sandbox_compile_string", ffi.pointer(profile), ["str", "void *", "void *"])(
    "(version 1)(deny default)",
    null,
    error,
  );
  if (!pointer) {
    const message = ffi.decode(error, "void *");
    if (message) lib.func("sandbox_free_error", "void", ["void *"])(message);
    throw Error("cannot compile sandbox reinitialization canary");
  }
  let bytes: Buffer;
  try {
    const p = ffi.decode(pointer, profile) as { data: unknown; size: number | bigint };
    const size = Number(p.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > 1024 * 1024) throw Error("invalid compiled canary");
    bytes = Buffer.from(Buffer.from(ffi.view(p.data, size)));
  } finally {
    lib.func("sandbox_free_profile", "void", [ffi.pointer(profile)])(pointer);
  }
  return `const ffi=require(${JSON.stringify(createRequire(import.meta.url).resolve("koffi"))});
const lib=ffi.load('/usr/lib/libsandbox.1.dylib');
const profile=ffi.struct({builtin:'void *',data:'void *',size:'size_t'});
const blob=Buffer.from(${JSON.stringify(bytes.toString("base64"))},'base64');
const apply=lib.func('sandbox_apply','int',[ffi.pointer(profile)]);
if(apply({builtin:null,data:blob,size:blob.length})===0)process.exit(44);
const init=lib.func('sandbox_init','int',['str','uint64_t','void *']);
if(init('(version 1)(deny default)',0,Buffer.alloc(8))===0)process.exit(45);`;
}

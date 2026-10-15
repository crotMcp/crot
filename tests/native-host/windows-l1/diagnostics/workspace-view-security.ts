/** Read-only native test snapshot; no descriptor/SID is emitted into evidence. */
import { createHash } from "node:crypto";
interface SecurityFfi {
  struct(name: string, fields: Record<string, string>): unknown;
  load(name: string): { func(signature: string): (...args: unknown[]) => unknown };
  decode: { string16(pointer: unknown, length: number): string };
}
const bound = new WeakMap<object, ReturnType<typeof bind>>();
const valid = (p: unknown) => p !== null && p !== undefined && p !== 0 && p !== 0n;
const ok = (n: unknown) => n !== false && valid(n);
function bind(ffi: SecurityFfi) {
  const h = "CROT_VIEW_SD_POINTER",
    n = "CROT_VIEW_SD_LENGTH";
  ffi.struct(h, { value: "void *" });
  ffi.struct(n, { value: "uint32_t" });
  const adv = ffi.load("advapi32.dll"),
    kernel = ffi.load("kernel32.dll");
  const get = adv.func(
    `uint32_t __stdcall GetNamedSecurityInfoW(str16 name, int kind, uint32_t sections, void *owner, void *group, void *dacl, void *sacl, _Out_ ${h} *descriptor)`,
  );
  const text = adv.func(
    `int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *descriptor, uint32_t revision, uint32_t sections, _Out_ ${h} *text, _Out_ ${n} *length)`,
  );
  const free = kernel.func("void * __stdcall LocalFree(void *memory)");
  const pending = new Set<unknown>();
  const release = () => {
    for (const pointer of pending) {
      if (valid(free(pointer))) throw Error("Read-only workspace descriptor release failed.");
      pending.delete(pointer);
    }
  };
  return (filename: string) => {
    release(); // A persistent release failure prevents a fresh allocation.
    const descriptor: { value?: unknown } = {},
      output: { value?: unknown } = {},
      length: { value?: number } = {};
    try {
      // OWNER|GROUP|DACL|LABEL query, not a privileged full-SACL query.
      if (get(filename, 1, 0x17, null, null, null, null, descriptor) !== 0 || !valid(descriptor.value))
        throw Error("Read-only workspace descriptor query failed.");
      // Serialize SACL (8), never LABEL (16): AD-26 native correction retained.
      if (
        !ok(text(descriptor.value, 1, 0x0f, output, length)) ||
        !valid(output.value) ||
        !Number.isSafeInteger(length.value) ||
        length.value! < 1 ||
        length.value! > 65536
      )
        throw Error("Read-only workspace descriptor encoding failed.");
      const canonical = ffi.decode.string16(output.value, length.value! - 1);
      const labels = [...canonical.matchAll(/\(ML;[^;]*;([^;]*);;;([^;)]+)\)/g)];
      const hash = (s: string) => createHash("sha256").update(s).digest("hex");
      const sections: Record<string, string> = Object.fromEntries(
        canonical
          .split(/(?=[OGDS]:)/)
          .filter(Boolean)
          .map((s): [string, string] => [s.charAt(0), s]),
      );
      const dacl = sections.D ?? "";
      return {
        // Section hashes/counts expose no raw descriptor or principal SID.
        sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, hash(v)])),
        daclFlags: dacl.slice(2).split("(")[0],
        daclAceHashes: (dacl.match(/\([^()]*\)/g) ?? []).map(hash),
        fingerprint: createHash("sha256").update(canonical).digest("hex"),
        // No label means the documented implicit Medium/NW policy, not an
        // encoding/query error or an inferred missing access-control value.
        medium: labels.every((m) => ["ME", "S-1-16-8192"].includes(m[2]!) && m[1]!.includes("NW")),
      };
    } finally {
      if (valid(descriptor.value)) pending.add(descriptor.value);
      if (valid(output.value)) pending.add(output.value);
      release();
    }
  };
}
export function snapshotWorkspaceDescriptorDetails(ffi: SecurityFfi, filename: string) {
  let read = bound.get(ffi);
  if (!read) {
    read = bind(ffi);
    bound.set(ffi, read);
  }
  return read(filename);
}

/** Preserve the original privacy-minimal public contract. */
export function snapshotWorkspaceDescriptor(ffi: SecurityFfi, filename: string) {
  const { fingerprint, medium } = snapshotWorkspaceDescriptorDetails(ffi, filename);
  return { fingerprint, medium };
}

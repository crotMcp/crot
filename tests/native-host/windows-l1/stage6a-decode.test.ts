/** Portable check: direct UTF-16 memory, not a pointer-to-pointer. */
import { createRequire } from "node:module";
import { it, expect } from "vitest";
it("decodes a directly allocated SID string without a second pointer dereference", async () => {
  const ffi = createRequire(import.meta.url)("koffi");
  const module = await import(new URL("./fixtures/stage6a-native.mjs", import.meta.url).href);
  const owned = Buffer.from("S-1-16-4096\0", "utf16le");
  expect(module.decodeSidString(ffi, owned)).toBe("S-1-16-4096");
  expect(ffi.sizeof("str16")).toBe(ffi.sizeof("void *"));
});

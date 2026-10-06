/**
 * The DPAPI bindings (koffi, DATA_BLOB marshalling, copy-out and LocalFree) on
 * macOS/Linux, against a stand-in library with the ABI of CryptProtectData /
 * CryptUnprotectData / LocalFree compiled with the system C compiler. The real
 * DPAPI round trip runs on Windows in secrets-backends.test.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindDpapi } from "../../../src/service/secrets/dpapi.js";

const MOCK = `
#include <stdlib.h>
#include <stdint.h>
typedef struct { uint32_t cbData; uint8_t *pbData; } BLOB;
static int live = 0;
static int xform(BLOB *in, BLOB *ent, BLOB *out, int tag) {
  out->cbData = in->cbData + (tag ? 1 : -1);
  out->pbData = malloc(out->cbData);
  live++;
  if (tag) { for (uint32_t i = 0; i < in->cbData; i++) out->pbData[i + 1] = in->pbData[i] ^ ent->pbData[i % ent->cbData]; out->pbData[0] = 0xc5; }
  else { if (in->cbData < 1 || in->pbData[0] != 0xc5) { free(out->pbData); live--; return 0; } for (uint32_t i = 0; i < out->cbData; i++) out->pbData[i] = in->pbData[i + 1] ^ ent->pbData[i % ent->cbData]; }
  return 1;
}
int CryptProtectData(BLOB *in, void *d, BLOB *e, void *r, void *p, uint32_t f, BLOB *out) { return f == 1 && !d && !r && !p ? xform(in, e, out, 1) : 0; }
int CryptUnprotectData(BLOB *in, void *d, BLOB *e, void *r, void *p, uint32_t f, BLOB *out) { return f == 1 ? xform(in, e, out, 0) : 0; }
void *LocalFree(void *m) { free(m); live--; return 0; }
int LiveAllocations(void) { return live; }
`;

function compiler(): string | undefined {
  if (process.platform === "win32") return undefined;
  for (const cc of ["cc", "gcc", "clang"]) {
    try {
      execFileSync(cc, ["--version"], { stdio: "ignore" });
      return cc;
    } catch {
      // next
    }
  }
  return undefined;
}

const cc = compiler();
let dir = "";
let lib = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let koffi: any;

describe.skipIf(!cc)("DPAPI bindings (stand-in library)", () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "crot-dpapi-"));
    await writeFile(path.join(dir, "mock.c"), MOCK);
    lib = path.join(dir, "libmockdpapi.so");
    execFileSync(cc!, ["-shared", "-fPIC", "-o", lib, path.join(dir, "mock.c")]);
    koffi = ((await import("koffi")) as { default?: unknown }).default ?? (await import("koffi"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips data through the bound functions and frees every output buffer", () => {
    const api = bindDpapi(koffi, { crypt32: lib, kernel32: lib });
    const entropy = Buffer.from("crot-mcp:http-token");
    const secret = Buffer.from("a-secret-value-0123456789-abcdefghijklmnopqrstuvwxyz");
    const blob = api.protect(secret, entropy);
    expect(blob.length).toBe(secret.length + 1);
    expect(blob.includes(secret)).toBe(false);
    expect(api.unprotect(blob, entropy).equals(secret)).toBe(true);
    for (let i = 0; i < 2000; i++) {
      const data = Buffer.alloc(64 + (i % 7), i % 251);
      expect(api.unprotect(api.protect(data, entropy), entropy).equals(data)).toBe(true);
    }
    const live = koffi.load(lib).func("int LiveAllocations(void)") as () => number;
    expect(live()).toBe(0);
    // Bindings are cached per library pair.
    expect(bindDpapi(koffi, { crypt32: lib, kernel32: lib })).toBe(api);
  });

  it("reports a failing call as an error", () => {
    const api = bindDpapi(koffi, { crypt32: lib, kernel32: lib });
    expect(() => api.unprotect(Buffer.from([1, 2, 3]), Buffer.from("e"))).toThrow(/DPAPI decryption failed/);
  });
});

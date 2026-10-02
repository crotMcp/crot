import { describe, expect, it } from "vitest";
import { canonicalEncodingName, codePageEncodingName, createEncodingSupport, decodingFor, parseWindowsCodePages } from "../../src/core/platform/encoding.js";

const decode = (name: string, ...b: number[]) => decodingFor(name)!.decode(Uint8Array.from(b), false);

describe("code pages", () => {
  it("maps Windows code pages to decoders", () => {
    expect(codePageEncodingName(437)).toBe("cp437");
    expect(codePageEncodingName(850)).toBe("cp850");
    expect(codePageEncodingName(866)).toBe("ibm866");
    expect(codePageEncodingName(932)).toBe("shift_jis");
    expect(codePageEncodingName(1252)).toBe("windows-1252");
    expect(codePageEncodingName(65001)).toBe("utf-8");
    expect(codePageEncodingName(1361)).toBeNull();
  });

  it("decodes DOS/OEM code pages that TextDecoder does not support", () => {
    expect(decode("cp437", 0x81, 0x9b, 0xe1, 0xc9, 0x41)).toBe("ü¢ß╔A");
    expect(decode("cp850", 0x81, 0xd5, 0x9b)).toBe("üıø");
    expect(decode("cp852", 0xa5, 0xe7)).toBe("ąš");
    expect(decode("cp866", 0x8f, 0xe0, 0xa8)).toBe("При");
    // Undefined bytes are not silently mapped.
    expect(decodingFor("cp857")!.decode(Uint8Array.from([0xd5]), true)).toBeNull();
  });

  it("decodes windows-1252 per WHATWG on every Node version (0x80-0x9F are not C1 controls)", () => {
    const c1 = Array.from({ length: 0x20 }, (_, i) => 0x80 + i);
    const expected =
      "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
      "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";
    for (const label of ["windows-1252", "cp1252", "1252", "latin1", "iso-8859-1", "ascii"]) {
      const d = decodingFor(label)!;
      expect(d.name).toBe("windows-1252");
      expect(d.decode(Uint8Array.from(c1), true)).toBe(expected);
      expect(d.decode(Uint8Array.from([0x41, 0xa0, 0xe9, 0xff]), true)).toBe("A\u00a0éÿ");
    }
  });

  it("canonicalizes encoding labels", () => {
    expect(canonicalEncodingName("UTF8")).toBe("utf-8");
    expect(canonicalEncodingName("850")).toBe("cp850");
    expect(canonicalEncodingName("ibm437")).toBe("cp437");
    expect(canonicalEncodingName("cp1252")).toBe("windows-1252");
    expect(canonicalEncodingName("latin1")).toBe("windows-1252");
    expect(canonicalEncodingName("utf-16le")).toBe("utf-16le");
    expect(canonicalEncodingName("klingon")).toBeNull();
  });

  it("parses reg.exe output", () => {
    const out = [
      "",
      "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
      "    ACP    REG_SZ    1252",
      "    OEMCP    REG_SZ    850",
      "    MACCP    REG_SZ    10000",
      "",
    ].join("\r\n");
    expect(parseWindowsCodePages(out)).toEqual({ oem: 850, ansi: 1252 });
    expect(parseWindowsCodePages("ERROR")).toBeNull();
  });
});

describe("EncodingSupport", () => {
  it("POSIX: auto has no fallback; oem/ansi are rejected", () => {
    const e = createEncodingSupport(null);
    expect(e.fallback).toBeNull();
    expect(e.resolve("auto")).toEqual({ mode: "auto", fallback: null });
    expect(() => e.resolve("oem")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => e.resolve("nope")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("Windows: auto falls back to the OEM code page; oem/ansi resolve to code pages", () => {
    const e = createEncodingSupport({ oem: 437, ansi: 1252 });
    expect(e.fallback).toBe("cp437");
    expect(e.resolve("oem")).toMatchObject({ mode: "fixed", decoding: { name: "cp437" } });
    expect(e.resolve("ANSI")).toMatchObject({ mode: "fixed", decoding: { name: "windows-1252" } });
    expect(e.resolve("utf-16le")).toMatchObject({ mode: "fixed", decoding: { name: "utf-16le" } });
  });

  it("Windows with the UTF-8 system code page: no legacy fallback", () => {
    expect(createEncodingSupport({ oem: 65001, ansi: 65001 }).fallback).toBeNull();
  });

  it("Windows with an unsupported OEM code page: oem is rejected, auto has no fallback", () => {
    const e = createEncodingSupport({ oem: 1361, ansi: 1252 });
    expect(e.fallback).toBeNull();
    expect(() => e.resolve("oem")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});

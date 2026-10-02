import { CrotError } from "../errors.js";
import { OEM_CODE_PAGE_TABLES } from "./code-pages.js";
import type { CodePages, EncodingSupport, ResolvedEncoding, TextDecoding } from "./types.js";

/**
 * Text decoding for process output. Uses Node's built-in TextDecoder (WHATWG
 * encodings) plus small tables for the DOS/OEM code pages Windows consoles
 * use; no external dependencies.
 */

/** Windows code page numbers that are WHATWG encodings. */
const WHATWG_CODE_PAGES: Readonly<Record<number, string>> = {
  65001: "utf-8",
  1200: "utf-16le",
  1201: "utf-16be",
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  10000: "macintosh",
  20866: "koi8-r",
  21866: "koi8-u",
  20932: "euc-jp",
  28592: "iso-8859-2",
  28593: "iso-8859-3",
  28594: "iso-8859-4",
  28595: "iso-8859-5",
  28596: "iso-8859-6",
  28597: "iso-8859-7",
  28598: "iso-8859-8",
  28603: "iso-8859-13",
  28605: "iso-8859-15",
  54936: "gb18030",
};

/** Canonical encoding name for a Windows code page, or null when CROT cannot decode it. */
export function codePageEncodingName(codePage: number): string | null {
  if (OEM_CODE_PAGE_TABLES[codePage] !== undefined) return `cp${codePage}`;
  return WHATWG_CODE_PAGES[codePage] ?? null;
}

function whatwgName(label: string): string | null {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return null;
  }
}

/**
 * Canonical name for an encoding label: "utf8", "cp850", "850", "ibm437",
 * "windows-1252", "cp1252", "shift_jis", ... Returns null when unsupported.
 */
export function canonicalEncodingName(label: string): string | null {
  const l = label.trim().toLowerCase();
  const cp = /^(?:cp|ibm|windows-)?(\d+)$/.exec(l);
  if (cp) {
    const byNumber = codePageEncodingName(Number(cp[1]));
    if (byNumber) return byNumber;
  }
  return whatwgName(l);
}

function tableDecoding(codePage: number, high: string): TextDecoding {
  return {
    name: `cp${codePage}`,
    decode(bytes, fatal) {
      let out = "";
      for (const b of bytes) {
        const c = b < 0x80 ? String.fromCharCode(b) : high[b - 0x80]!;
        if (fatal && c === "\ufffd") return null;
        out += c;
      }
      return out;
    },
  };
}

/** Decoder for an encoding label (see canonicalEncodingName), or null when unsupported. */
export function decodingFor(label: string): TextDecoding | null {
  const canonical = canonicalEncodingName(label);
  if (!canonical) return null;
  const cp = /^cp(\d+)$/.exec(canonical);
  if (cp) return tableDecoding(Number(cp[1]), OEM_CODE_PAGE_TABLES[Number(cp[1])]!);
  return {
    name: canonical,
    decode(bytes, fatal) {
      try {
        // BOMs are handled by the caller (only meaningful at offset 0).
        return new TextDecoder(canonical, { fatal, ignoreBOM: true }).decode(bytes);
      } catch {
        return null;
      }
    },
  };
}

/** Parse `reg query HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage` output. */
export function parseWindowsCodePages(output: string): CodePages | null {
  const value = (name: string) => {
    const m = new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(\\d+)\\s*$`, "im").exec(output);
    return m ? Number(m[1]) : undefined;
  };
  const oem = value("OEMCP");
  const ansi = value("ACP");
  return oem !== undefined && ansi !== undefined ? { oem, ansi } : null;
}

/**
 * Encoding support for a platform. `codePages` are the Windows OEM (console)
 * and ANSI code pages, or null on platforms whose native output encoding is UTF-8.
 */
export function createEncodingSupport(codePages: CodePages | null): EncodingSupport {
  const fromCodePage = (cp: number) => {
    const name = codePageEncodingName(cp);
    return name ? decodingFor(name) : null;
  };
  const fallback = codePages && codePages.oem !== 65001 ? fromCodePage(codePages.oem) : null;
  return {
    codePages,
    fallback: fallback?.name ?? null,
    resolve(requested): ResolvedEncoding {
      const r = requested.trim().toLowerCase();
      if (r === "auto") return { mode: "auto", fallback };
      if (r === "oem" || r === "ansi") {
        if (!codePages) throw new CrotError("INVALID_INPUT", `Encoding '${requested}' is only available on Windows (this platform uses UTF-8).`);
        const cp = r === "oem" ? codePages.oem : codePages.ansi;
        const decoding = fromCodePage(cp);
        if (!decoding) throw new CrotError("INVALID_INPUT", `The ${r.toUpperCase()} code page ${cp} is not supported; pass an explicit encoding.`);
        return { mode: "fixed", decoding };
      }
      const decoding = decodingFor(r);
      if (!decoding) throw new CrotError("INVALID_INPUT", `Unsupported encoding '${requested}'.`);
      return { mode: "fixed", decoding };
    },
  };
}

import path from "node:path";
import { CrotError } from "../errors.js";
import type { PathRules, PathStyle } from "./types.js";

/** Windows reserved device names (with or without extension), e.g. CON, NUL, COM1.txt. */
const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
const WIN_INVALID_CHARS = /[<>"|?*\u0000-\u001f]/;

function invalid(message: string): never {
  throw new CrotError("INVALID_INPUT", message);
}

function fold(s: string, caseSensitive: boolean): string {
  const n = s.normalize("NFC");
  return caseSensitive ? n : n.toLowerCase();
}

function makeRules(style: PathStyle): PathRules {
  const p = style === "win32" ? path.win32 : path.posix;

  const splitRest = (abs: string): { root: string; segments: string[] } => {
    const normalized = p.resolve(abs);
    const root = p.parse(normalized).root;
    const segments = normalized.slice(root.length).split(p.sep).filter((s) => s.length > 0);
    return { root, segments };
  };

  return {
    style,
    sep: p.sep,
    validate(input: string): void {
      if (input.includes("\0")) invalid("Path must not contain NUL bytes.");
      if (style === "posix") return;

      if (/^[\\/]{2}[?.][\\/]/.test(input)) {
        invalid(`Windows device and \\\\?\\ namespace paths are not supported: ${input}`);
      }
      if (/^[a-zA-Z]:(?![\\/])/.test(input)) {
        invalid(`Drive-relative paths are ambiguous; use an absolute path (e.g. C:\\dir) or a workspace-relative path: ${input}`);
      }
      const body = /^[a-zA-Z]:/.test(input) ? input.slice(2) : input;
      if (body.includes(":")) invalid(`Alternate data streams and ':' are not allowed in Windows paths: ${input}`);
      if (WIN_INVALID_CHARS.test(body)) invalid(`Path contains characters that are invalid on Windows: ${input}`);
      const isUnc = /^[\\/]{2}[^\\/]/.test(input);
      const components = body.split(/[\\/]/).filter((c) => c.length > 0);
      components.forEach((component, index) => {
        if (component === "." || component === "..") return;
        if (isUnc && index < 2) return; // server and share names
        if (/[. ]$/.test(component)) {
          invalid(`Windows path components must not end with '.' or ' ' (they would be silently altered): ${input}`);
        }
        if (WIN_RESERVED.test(component.trim())) invalid(`Windows reserved device name in path: ${input}`);
      });
    },
    isAbsolute: (x) => p.isAbsolute(x),
    resolve: (...s) => p.resolve(...s),
    dirname: (x) => p.dirname(x),
    basename: (x) => p.basename(x),
    join: (...s) => p.join(...s),
    root: (x) => p.parse(p.resolve(x)).root,
    relativeSegments(ancestor, candidate, caseSensitive) {
      // Windows paths are always compared case-insensitively.
      const cs = style === "win32" ? false : caseSensitive;
      const a = splitRest(ancestor);
      const c = splitRest(candidate);
      if (fold(a.root, cs) !== fold(c.root, cs)) return null;
      if (c.segments.length < a.segments.length) return null;
      for (let i = 0; i < a.segments.length; i++) {
        if (fold(a.segments[i]!, cs) !== fold(c.segments[i]!, cs)) return null;
      }
      return c.segments.slice(a.segments.length);
    },
    equals(a, b, caseSensitive) {
      const rel = this.relativeSegments(a, b, caseSensitive);
      return rel !== null && rel.length === 0;
    },
  };
}

export const posixPathRules: PathRules = makeRules("posix");
export const win32PathRules: PathRules = makeRules("win32");

export function pathRulesFor(style: PathStyle): PathRules {
  return style === "win32" ? win32PathRules : posixPathRules;
}

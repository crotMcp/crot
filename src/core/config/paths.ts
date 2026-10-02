import os from "node:os";
import path from "node:path";

/**
 * Expand a leading "~" (home directory) in a user-supplied path. MCP clients
 * usually launch servers without a shell, so "~" would otherwise be literal.
 */
export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/** Strip a UTF-8 byte-order mark (common in files saved by Windows editors). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

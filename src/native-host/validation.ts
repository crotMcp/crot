/**
 * Strict validation of everything the Native Host passes to or reads from the
 * operating system (process ids, SIDs, paths, tool output). Bounded sizes;
 * malformed input is rejected with INVALID_INPUT, never repaired.
 */
import path from "node:path";
import { CrotError } from "../core/errors.js";

export const MAX_WINDOWS_PATH_LENGTH = 32_767;
/** Upper bound for output read from OS tools (whoami, icacls, PowerShell). */
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
export const MAX_ACL_RULES = 256;
const MAX_SID_LENGTH = 200;
const SID_PATTERN = /^S-1-\d{1,15}(?:-\d{1,10}){1,15}$/;

const invalid = (message: string) => new CrotError("INVALID_INPUT", message);

/** A Windows/POSIX process id: integer in 1..2^32-1. */
export function validatePid(pid: unknown): number {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 || pid > 0xffff_ffff)
    throw invalid("Invalid process id.");
  return pid;
}

/** A Windows security identifier in string form (S-1-...). */
export function validateSid(sid: unknown): string {
  if (typeof sid !== "string" || sid.length > MAX_SID_LENGTH || !SID_PATTERN.test(sid))
    throw invalid("Invalid Windows security identifier.");
  return sid;
}

/**
 * An absolute Windows path (drive or UNC) without control characters, quotes
 * or wildcard/reserved characters, so it can be handed to OS tools as a single
 * argument and never be read as an option or pattern.
 */
export function validateWindowsPath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_WINDOWS_PATH_LENGTH)
    throw invalid("Invalid Windows path: empty or too long.");
  if (/[\u0000-\u001f"*?<>|]/.test(input)) throw invalid("Invalid Windows path: control or reserved characters.");
  if (!/^(?:[A-Za-z]:\\|\\\\[^\\/]+\\[^\\/]+)/.test(input))
    throw invalid("Invalid Windows path: must be absolute (drive or UNC).");
  return path.win32.normalize(input);
}

/**
 * Node reports some paths in the Win32 file namespace form: on Windows,
 * fs.promises.mkdir(dir, { recursive: true }) returns the first created
 * directory as \\?\C:\... (it calls the binding with toNamespacedPath(dir)).
 * Convert exactly the drive (\\?\X:\) and UNC (\\?\UNC\server\share) forms
 * back to ordinary absolute paths. Anything else is returned unchanged and is
 * left to validateWindowsPath, which still rejects it.
 */
export function fromWin32NamespacedPath(input: string): string {
  if (/^\\\\\?\\UNC\\[^\\/]+\\[^\\/]+/i.test(input)) return `\\\\${input.slice("\\\\?\\UNC\\".length)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/.test(input)) return input.slice("\\\\?\\".length);
  return input;
}

/** Whether `candidate` is `target` or one of its ancestors (Windows: case-insensitive). Both must be validated paths. */
export function isSameOrAncestorWindowsPath(candidate: string, target: string): boolean {
  const a = path.win32.normalize(candidate).replace(/\\+$/, "").toLowerCase();
  const t = path.win32.normalize(target).replace(/\\+$/, "").toLowerCase();
  return t === a || t.startsWith(`${a}\\`);
}

/** The user SID from `whoami /user /fo csv /nh` (one line: "domain\user","S-1-..."). */
export function parseWhoamiSid(output: unknown): string {
  if (typeof output !== "string" || output.length === 0 || output.length > 4096)
    throw invalid("Unexpected whoami output.");
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length !== 1) throw invalid("Unexpected whoami output.");
  const match = /,"(S-1-[0-9-]+)"$/.exec(lines[0]!);
  if (!match) throw invalid("Unexpected whoami output.");
  return validateSid(match[1]);
}

export interface AclRule {
  readonly sid: string;
  readonly type: "Allow" | "Deny";
  readonly inherited: boolean;
}

export interface AclReport {
  /** Inheritance from the parent is disabled. */
  readonly protected: boolean;
  readonly owner: string;
  readonly rules: readonly AclRule[];
}

/**
 * Parse the ACL report printed by the Native Host's inspection script:
 *   protected=True|False
 *   owner=S-1-...
 *   rule=S-1-...|Allow|Deny|True|False   (zero or more)
 * Any other line, a duplicate header or a missing header is rejected.
 */
export function parseAclReport(output: unknown): AclReport {
  if (typeof output !== "string" || output.length > MAX_TOOL_OUTPUT_BYTES) throw invalid("Malformed ACL report.");
  let isProtected: boolean | undefined;
  let owner: string | undefined;
  const rules: AclRule[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const prot = /^protected=(True|False)$/.exec(line);
    const own = /^owner=(S-1-[0-9-]+)$/.exec(line);
    const rule = /^rule=(S-1-[0-9-]+)\|(Allow|Deny)\|(True|False)$/.exec(line);
    if (prot && isProtected === undefined) {
      isProtected = prot[1] === "True";
    } else if (own && owner === undefined) {
      owner = validateSid(own[1]);
    } else if (rule) {
      if (rules.length >= MAX_ACL_RULES) throw invalid("ACL report has too many rules.");
      rules.push({ sid: validateSid(rule[1]), type: rule[2] as "Allow" | "Deny", inherited: rule[3] === "True" });
    } else {
      throw invalid("Malformed ACL report.");
    }
  }
  if (isProtected === undefined || owner === undefined) throw invalid("Malformed ACL report.");
  return { protected: isProtected, owner, rules };
}

/** Owner-only: at least one allow rule, and every allow rule is for `userSid`. */
export function isOwnerOnly(report: AclReport, userSid: string): boolean {
  const allows = report.rules.filter((r) => r.type === "Allow");
  return allows.length > 0 && allows.every((r) => r.sid === userSid);
}

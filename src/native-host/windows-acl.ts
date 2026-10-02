/**
 * Owner-only Windows ACLs for CROT's private files (HTTP token, audit log,
 * private config/state directories).
 *
 * Files and directories are restricted to the SID of the user CROT runs as:
 * inheritance is removed and the only allow rule is full control for that
 * user. The result is verified by reading the ACL back. Windows has no
 * equivalent of chmod 0600 and none is pretended: fileMode is undefined.
 *
 * Uses the system tools icacls.exe, whoami.exe and Windows PowerShell from
 * %SystemRoot%\System32 (absolute paths, no shell, bounded output, timeouts).
 */
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../core/errors.js";
import type { PrivateFileProtection, PrivateFileStatus } from "../core/platform/types.js";
import { isOwnerOnly, MAX_TOOL_OUTPUT_BYTES, parseAclReport, parseWhoamiSid, validateSid, validateWindowsPath, type AclReport } from "./validation.js";

const TOOL_TIMEOUT_MS = 30_000;

export type ToolRunner = (file: string, args: readonly string[], env?: Readonly<Record<string, string>>) => Promise<string>;

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0]!.slice(0, 200);

/** Run a system tool without a shell; output is bounded. */
export const runTool: ToolRunner = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { windowsHide: true, timeout: TOOL_TIMEOUT_MS, maxBuffer: MAX_TOOL_OUTPUT_BYTES, encoding: "utf8", shell: false, ...(env ? { env: { ...env } } : {}) },
      (error, stdout, stderr) => {
        if (error) {
          reject(new CrotError("OPERATION_FAILED", `${path.win32.basename(file)} failed: ${firstLine(stderr || stdout || error.message)}`));
          return;
        }
        resolve(stdout);
      },
    );
  });

export interface WindowsTools {
  readonly whoami: string;
  readonly icacls: string;
  readonly powershell: string;
}

export function windowsTools(systemRoot: string): WindowsTools {
  const system32 = path.win32.join(validateWindowsPath(systemRoot), "System32");
  return {
    whoami: path.win32.join(system32, "whoami.exe"),
    icacls: path.win32.join(system32, "icacls.exe"),
    powershell: path.win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
  };
}

/** SID of the user this process runs as. */
export async function currentUserSid(tools: WindowsTools, run: ToolRunner = runTool): Promise<string> {
  return parseWhoamiSid(await run(tools.whoami, ["/user", "/fo", "csv", "/nh"]));
}

/** Prints the ACL in the line format parsed by parseAclReport; the path is passed through the environment, never interpolated. */
const INSPECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$acl = Get-Acl -LiteralPath $env:CROT_ACL_TARGET",
  "$sid = [System.Security.Principal.SecurityIdentifier]",
  "'protected=' + $acl.AreAccessRulesProtected",
  "'owner=' + $acl.GetOwner($sid).Value",
  "foreach ($r in $acl.GetAccessRules($true, $true, $sid)) { 'rule=' + $r.IdentityReference.Value + '|' + $r.AccessControlType + '|' + $r.IsInherited }",
].join("\n");
const INSPECT_ENCODED = Buffer.from(INSPECT_SCRIPT, "utf16le").toString("base64");

export interface WindowsAclProtection extends PrivateFileProtection {
  readonly mechanism: "windows-acl";
  readonly userSid: string;
  protectFile(file: string): Promise<void>;
}

export function createWindowsAclProtection(options: { readonly tools: WindowsTools; readonly userSid: string; readonly run?: ToolRunner }): WindowsAclProtection {
  const sid = validateSid(options.userSid);
  const { tools } = options;
  const run = options.run ?? runTool;

  const readAcl = async (target: string): Promise<AclReport> => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
    env.CROT_ACL_TARGET = target;
    return parseAclReport(await run(tools.powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", INSPECT_ENCODED], env));
  };

  const restrict = async (target: string, kind: "file" | "directory"): Promise<void> => {
    const p = validateWindowsPath(target);
    const grant = `*${sid}:${kind === "directory" ? "(OI)(CI)" : ""}F`;
    await run(tools.icacls, [p, "/inheritance:r", "/grant:r", grant, "/Q"]);
    let report = await readAcl(p);
    // Explicit rules for other principals survive /inheritance:r; remove them.
    const others = [...new Set(report.rules.filter((r) => r.type === "Allow" && r.sid !== sid).map((r) => r.sid))];
    for (const other of others) await run(tools.icacls, [p, "/remove:g", `*${other}`, "/Q"]);
    if (others.length > 0) report = await readAcl(p);
    if (!isOwnerOnly(report, sid)) throw new CrotError("OPERATION_FAILED", `Could not restrict ${p} to the CROT user.`);
  };

  return {
    mechanism: "windows-acl",
    enforced: true,
    fileMode: undefined,
    userSid: sid,
    ensureDirectory: async (dir) => {
      const created = await mkdir(dir, { recursive: true });
      // Only directories CROT creates are restricted (the topmost new one; children inherit).
      if (created !== undefined) await restrict(created, "directory");
    },
    protectFile: async (file) => {
      const p = validateWindowsPath(file);
      const info = await stat(p).catch(() => undefined);
      if (!info?.isFile()) throw new CrotError("INVALID_INPUT", `Not a regular file: ${p}`);
      await restrict(p, "file");
    },
    inspect: async (file): Promise<PrivateFileStatus> => {
      const p = validateWindowsPath(file);
      const info = await stat(p).catch(() => undefined);
      if (!info) return { mechanism: "windows-acl", ownerOnly: true, detail: "will be created with an owner-only ACL" };
      const report = await readAcl(p);
      if (isOwnerOnly(report, sid)) return { mechanism: "windows-acl", ownerOnly: true, detail: `ACL grants access only to the CROT user (${sid})` };
      const others = [...new Set(report.rules.filter((r) => r.type === "Allow" && r.sid !== sid).map((r) => r.sid))];
      return {
        mechanism: "windows-acl",
        ownerOnly: false,
        detail: `ACL also grants access to ${others.join(", ") || "nobody (no allow rule for the CROT user)"}; CROT restricts the files it uses at startup`,
      };
    },
  };
}

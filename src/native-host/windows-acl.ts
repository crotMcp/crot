/**
 * Owner-only Windows ACLs for CROT's private files (HTTP token, audit log,
 * private config/state directories).
 *
 * Files and directories are restricted to the SID of the user CROT runs as:
 * the DACL is replaced by a protected DACL (no inheritance) whose only rule is
 * full control for that user. The result is verified by reading the ACL back.
 * Windows has no equivalent of chmod 0600 and none is pretended: fileMode is
 * undefined.
 *
 * Uses whoami.exe and Windows PowerShell from %SystemRoot%\System32 (absolute
 * paths, no shell, bounded output, timeouts). The PowerShell script uses .NET
 * security classes only (no modules, so it does not depend on PSModulePath)
 * and receives the path and SID through the environment, never interpolated.
 */
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../core/errors.js";
import type { PrivateFileProtection, PrivateFileStatus } from "../core/platform/types.js";
import {
  fromWin32NamespacedPath,
  isOwnerOnly,
  isSameOrAncestorWindowsPath,
  MAX_TOOL_OUTPUT_BYTES,
  parseAclReport,
  parseWhoamiSid,
  validateSid,
  validateWindowsPath,
  type AclReport,
} from "./validation.js";

const TOOL_TIMEOUT_MS = 30_000;

export type ToolRunner = (file: string, args: readonly string[], env?: Readonly<Record<string, string>>) => Promise<string>;

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0]!.slice(0, 200);

const XML_ENTITIES: Readonly<Record<string, string>> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };

/**
 * Readable failure text from a tool's output. PowerShell writes errors to a
 * redirected stderr as CLIXML ("#< CLIXML" + XML); the error records are
 * decoded so the message names the actual failure.
 */
export function toolFailureText(stderr: string, stdout: string, fallback: string): string {
  let text = stderr;
  if (text.trimStart().startsWith("#< CLIXML")) {
    text = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
      .map((m) => m[1]!)
      .join("")
      .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/&(?:lt|gt|amp|quot|apos);/g, (e) => XML_ENTITIES[e] ?? e);
  }
  return firstLine(text.trim() || stdout.trim() || fallback);
}

/** Run a system tool without a shell; output is bounded. */
export const runTool: ToolRunner = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { windowsHide: true, timeout: TOOL_TIMEOUT_MS, maxBuffer: MAX_TOOL_OUTPUT_BYTES, encoding: "utf8", shell: false, ...(env ? { env: { ...env } } : {}) },
      (error, stdout, stderr) => {
        if (error) {
          reject(new CrotError("OPERATION_FAILED", `${path.win32.basename(file)} failed: ${toolFailureText(stderr, stdout, error.message)}`));
          return;
        }
        resolve(stdout);
      },
    );
  });

export interface WindowsTools {
  readonly whoami: string;
  readonly powershell: string;
}

export function windowsTools(systemRoot: string): WindowsTools {
  const system32 = path.win32.join(validateWindowsPath(systemRoot), "System32");
  return {
    whoami: path.win32.join(system32, "whoami.exe"),
    powershell: path.win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
  };
}

/** SID of the user this process runs as. */
export async function currentUserSid(tools: WindowsTools, run: ToolRunner = runTool): Promise<string> {
  return parseWhoamiSid(await run(tools.whoami, ["/user", "/fo", "csv", "/nh"]));
}

/**
 * CROT_ACL_MODE=restrict: replace the DACL with a protected one granting full
 * control to CROT_ACL_SID only (directories: inherited by children).
 * Then (both modes) print the ACL in the line format parsed by parseAclReport.
 */
const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$p = $env:CROT_ACL_TARGET",
  "$isDir = [System.IO.Directory]::Exists($p)",
  "if (-not $isDir -and -not [System.IO.File]::Exists($p)) { throw 'ACL target does not exist.' }",
  "if ($env:CROT_ACL_MODE -eq 'restrict') {",
  "  $user = [System.Security.Principal.SecurityIdentifier]::new($env:CROT_ACL_SID)",
  "  $full = [System.Security.AccessControl.FileSystemRights]::FullControl",
  "  $allow = [System.Security.AccessControl.AccessControlType]::Allow",
  "  if ($isDir) {",
  "    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
  "    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($user, $full, $inherit, [System.Security.AccessControl.PropagationFlags]::None, $allow)",
  "    $sec = [System.Security.AccessControl.DirectorySecurity]::new()",
  "  } else {",
  "    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($user, $full, $allow)",
  "    $sec = [System.Security.AccessControl.FileSecurity]::new()",
  "  }",
  "  $sec.SetAccessRuleProtection($true, $false)",
  "  $sec.AddAccessRule($rule)",
  "  if ($isDir) { [System.IO.Directory]::SetAccessControl($p, $sec) } else { [System.IO.File]::SetAccessControl($p, $sec) }",
  "}",
  "$sections = [System.Security.AccessControl.AccessControlSections]'Access, Owner'",
  "if ($isDir) { $acl = [System.Security.AccessControl.DirectorySecurity]::new($p, $sections) } else { $acl = [System.Security.AccessControl.FileSecurity]::new($p, $sections) }",
  "$sidType = [System.Security.Principal.SecurityIdentifier]",
  "'protected=' + $acl.AreAccessRulesProtected",
  "'owner=' + $acl.GetOwner($sidType).Value",
  "foreach ($r in $acl.GetAccessRules($true, $true, $sidType)) { 'rule=' + $r.IdentityReference.Value + '|' + $r.AccessControlType + '|' + $r.IsInherited }",
].join("\n");
const ACL_ENCODED = Buffer.from(ACL_SCRIPT, "utf16le").toString("base64");

/**
 * Environment for Windows PowerShell: the CROT process environment without
 * PSModulePath (a PowerShell 7 value breaks Windows PowerShell 5.1), plus the
 * script inputs. Variable names are compared case-insensitively, as on Windows.
 */
function powershellEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.toUpperCase() === "PSMODULEPATH" || name.toUpperCase().startsWith("CROT_ACL_")) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

export interface WindowsAclProtection extends PrivateFileProtection {
  readonly mechanism: "windows-acl";
  readonly userSid: string;
  protectFile(file: string): Promise<void>;
}

export function createWindowsAclProtection(options: { readonly tools: WindowsTools; readonly userSid: string; readonly run?: ToolRunner }): WindowsAclProtection {
  const sid = validateSid(options.userSid);
  const { tools } = options;
  const run = options.run ?? runTool;

  const acl = async (target: string, mode: "inspect" | "restrict"): Promise<AclReport> => {
    const env = powershellEnv({ CROT_ACL_TARGET: target, CROT_ACL_MODE: mode, CROT_ACL_SID: sid });
    return parseAclReport(await run(tools.powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ACL_ENCODED], env));
  };

  const restrict = async (target: string): Promise<void> => {
    const p = validateWindowsPath(target);
    const report = await acl(p, "restrict");
    if (!report.protected || !isOwnerOnly(report, sid)) throw new CrotError("OPERATION_FAILED", `Could not restrict ${p} to the CROT user.`);
  };

  return {
    mechanism: "windows-acl",
    enforced: true,
    fileMode: undefined,
    userSid: sid,
    ensureDirectory: async (dir) => {
      const target = validateWindowsPath(dir);
      const created = await mkdir(target, { recursive: true });
      if (created === undefined) return;
      // mkdir reports the first created directory in namespaced form (\\?\C:\...) on Windows.
      const first = validateWindowsPath(fromWin32NamespacedPath(created));
      if (!isSameOrAncestorWindowsPath(first, target)) {
        throw new CrotError("OPERATION_FAILED", `Unexpected directory reported as created for ${target}.`);
      }
      // Only directories CROT creates are restricted (the topmost new one; children inherit).
      await restrict(first);
    },
    protectFile: async (file) => {
      const p = validateWindowsPath(file);
      const info = await stat(p).catch(() => undefined);
      if (!info?.isFile()) throw new CrotError("INVALID_INPUT", `Not a regular file: ${p}`);
      await restrict(p);
    },
    inspect: async (file): Promise<PrivateFileStatus> => {
      const p = validateWindowsPath(file);
      const info = await stat(p).catch(() => undefined);
      if (!info) return { mechanism: "windows-acl", ownerOnly: true, detail: "will be created with an owner-only ACL" };
      const report = await acl(p, "inspect");
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

/** Fixed Seatbelt policy. No caller supplied SBPL, regex, executable or shell interpolation. */
import { realpathSync } from "node:fs";
import path from "node:path";
import type { ConfinementNetwork } from "../../core/platform/types.js";

/** Canonicalize existing ancestors as well as absent leaves (/var and /tmp on Darwin). */
export function canonicalPath(input: string): string {
  if (!path.posix.isAbsolute(input) || /[\x00-\x1f\x7f]/.test(input)) throw new Error("invalid policy path");
  let p = path.posix.normalize(input);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.posix.join(realpathSync(p), ...tail.reverse());
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const parent = path.posix.dirname(p);
      if (parent === p) throw error;
      tail.push(path.posix.basename(p));
      p = parent;
    }
  }
}

/** Scheme string, not a JavaScript/JSON string: control characters are rejected, slash is literal. */
export function sbplString(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("invalid policy string");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface SeatbeltLayout {
  readonly writable: readonly string[];
  readonly projectSecrets?: { readonly root: string; readonly allowedPaths: readonly string[] };
  readonly protectedPaths: readonly string[];
  readonly readOnlyPaths?: readonly string[];
  readonly dockerSocket: string;
  readonly network: ConfinementNetwork;
}

/** Fixed POSIX-ERE grammar: no caller-supplied regex or recursive allow grant. */
export function projectSecretRule(policy: NonNullable<SeatbeltLayout["projectSecrets"]>): string {
  const root = canonicalPath(policy.root);
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `^${escaped === "/" ? "" : escaped}/([^/]+/)*(\\.[eE][nN][vV](\\.[^/]*)?|[^/]*\\.([pP][eE][mM]|[kK][eE][yY]))(/.*)?$`;
  const exceptions = policy.allowedPaths.map((name) => {
    const target = canonicalPath(name),
      rel = path.posix.relative(root, target);
    if (!rel || rel.startsWith("../") || path.posix.isAbsolute(rel)) throw new Error("Secret access outside workspace");
    if (target !== path.posix.normalize(name)) throw new Error("Secret grant must not follow an alias");
    return `(require-not (literal ${sbplString(target)}))`;
  });
  // A normal Scheme string consumes the doubled backslashes emitted by
  // sbplString. A # regex literal preserves them and changes the pattern.
  return `(deny file-read* file-write* (require-all (regex ${sbplString(pattern)}) ${exceptions.join(" ")}))
; No actor-created hardlink alias may turn a denied name into a readable one.
; Darwin link=9, linkat=471; immutable inherited syscall denial.
(deny syscall-unix (syscall-number 9) (syscall-number 471))`;
}

export function seatbeltProfile(layout: SeatbeltLayout): string {
  const subpaths = (paths: readonly string[]) => paths.map((p) => `(subpath ${sbplString(p)})`).join("\n");
  const guards = new Set<string>();
  for (const root of [...layout.writable, ...layout.protectedPaths, ...(layout.readOnlyPaths ?? [])]) {
    for (let p = root; p !== "/"; p = path.posix.dirname(p)) guards.add(p);
  }
  const guardedNames = [...guards].map((p) => `(literal ${sbplString(p)})`).join("\n");
  return `(version 1)
(deny default)
(allow file-read*)
(allow process-fork process-exec)
(allow sysctl-read)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
; Block direct group/session changes. Readiness separately proves that the
; inherited kernel sandbox rejects policy reinitialization. Do not blanket-block
; __mac_syscall: dyld needs AMFI checks through that shared syscall.
; posix_spawn(SETSID) is covered separately by inherited kernel policy identity.
; Darwin syscalls.master: setpgid=82, setsid=147 (both supported architectures).
; Keep real/effective identity stable even across a setuid executable. A
; privileged descendant must not change real UID and escape owner-only drain.
(deny syscall-unix (syscall-number 82) (syscall-number 147)
  (syscall-number 23) (syscall-number 80) (syscall-number 126)
  (syscall-number 127) (syscall-number 181) (syscall-number 182)
  (syscall-number 183) (syscall-number 243) (syscall-number 285) (syscall-number 311))
(allow mach-lookup
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.mDNSResponder"))
(allow file-write* ${subpaths(layout.writable)})
(allow file-write-data file-ioctl
  (literal "/dev/null") (literal "/dev/tty") (literal "/dev/zero")
  (literal "/dev/random") (literal "/dev/urandom"))
; Do not rename/unlink the policy roots or protected ancestors to evade path rules.
(deny file-write-unlink file-write-mode file-write-owner file-write-flags ${guardedNames})
${layout.projectSecrets ? projectSecretRule(layout.projectSecrets) : ""}
; Denial wins over broad host reads and writable workspace roots.
(deny file-read* file-write* ${subpaths(layout.protectedPaths)})
${layout.readOnlyPaths?.length ? `(deny file-write* ${subpaths(layout.readOnlyPaths)})` : ""}
; No arbitrary AF_UNIX: control, Docker, SSH agents and user daemons stay outside.
(allow network* (local unix-socket (literal ${sbplString(layout.dockerSocket)})))
(allow network-outbound (remote unix-socket (literal ${sbplString(layout.dockerSocket)})))
${layout.network === "on" ? "(allow network* (local ip) (remote ip))" : '(allow network-bind network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))'}
`;
}

/**
 * Windows host-path boundary for the shared Docker request policy (AD-20.9).
 * This is NOT endpoint transport, native path admission or backend readiness.
 * Only local drive paths with an admitted native resolver are supported. UNC,
 * device/Volume-GUID aliases and Docker Desktop/WSL translations fail closed;
 * they require a separately verified daemon-to-host mapping before support.
 */
import path from "node:path";
import { Refusal, type DockerBoundary, type DockerHostPaths } from "../linux-l1/docker-policy.js";

export interface WindowsDockerPaths {
  readonly writable: readonly string[];
  readonly protectedPaths: readonly string[];
  /** Docker context directories/keys are protected even inside a writable root. */
  readonly dockerContextPaths: readonly string[];
  readonly unreadable: readonly string[];
  readonly daemonSockets: readonly string[];
  readonly endpointSocket: string;
  /**
   * Trusted host adapter, not client input. Resolve existing path identity and
   * aliases, or throw on ambiguity/non-local/reparse races. A lexical identity
   * callback alone is not production admission. The adapter must retain guards
   * through daemon consumption; this pure policy does not solve that TOCTOU.
   */
  readonly resolve: (source: string) => string;
}
const fail = (where: string, reason: string): never => {
  throw new Refusal(`${where}: ${reason}`);
};
const volumeName = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value);
const pipeName = (value: string) => value.replaceAll("/", "\\").toLowerCase();

/** Reject Win32 alias syntax before normalization can erase it. */
export function canonicalWindowsDockerPath(value: string): string {
  if (typeof value !== "string" || value.length > 32767 || !/^[a-zA-Z]:[\\/]/.test(value))
    return fail("Docker path", "an unambiguous local absolute drive path is required");
  const tail = value.slice(3).replaceAll("/", "\\");
  if (/[\x00-\x1f\x7f:*?"<>|%~]/.test(tail))
    return fail("Docker path", "device, stream or alias syntax is not allowed");
  for (const segment of tail.split("\\")) {
    if (segment === "." || segment === ".." || segment === "") continue;
    if (/[. ]$/.test(segment) || /^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment))
      return fail("Docker path", "a Win32 alias segment is not allowed");
  }
  const normalized = path.win32.normalize(value.replaceAll("/", "\\")).toLowerCase();
  return normalized.length === 3 ? normalized : normalized.replace(/\\+$/, "");
}
const contains = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith("\\") ? parent : `${parent}\\`);
const isPipe = (value: string) => /^\\\\[.?]\\pipe\\/i.test(pipeName(value));

/** Parse the drive colons as path syntax, never as a source/target separator. */
export function parseWindowsDockerBind(bind: string): { source: string; readOnly: boolean; namedVolume: boolean } {
  if (typeof bind !== "string" || bind.length > 65535 || /[\x00-\x1f\x7f]/.test(bind))
    return fail("Docker bind", "invalid bind syntax");
  const sourceDrive = /^[a-zA-Z]:[\\/]/.test(bind);
  const separator = bind.indexOf(":", sourceDrive ? 2 : 0);
  if (separator <= 0) return fail("Docker bind", "missing source or target");
  const source = bind.slice(0, separator);
  const rest = bind.slice(separator + 1);
  const targetDrive = /^[a-zA-Z]:[\\/]/.test(rest);
  const optionsAt = rest.indexOf(":", targetDrive ? 2 : 0);
  const target = optionsAt < 0 ? rest : rest.slice(0, optionsAt);
  const options = optionsAt < 0 ? [] : rest.slice(optionsAt + 1).split(",");
  if (!target || options.some((option) => !["ro", "rw", "readonly", "nocopy"].includes(option)))
    return fail("Docker bind", "ambiguous target or unsupported options");
  if (targetDrive) canonicalWindowsDockerPath(target);
  else if (isPipe(target)) {
    /* container-side pipe name; source still checked by policy */
  } else if (!target.startsWith("/") || target.includes("\\")) return fail("Docker bind", "invalid target");
  const namedVolume = volumeName(source);
  if (!namedVolume && !isPipe(source)) canonicalWindowsDockerPath(source);
  if (options.includes("rw") && (options.includes("ro") || options.includes("readonly")))
    return fail("Docker bind", "conflicting access options");
  return { source, readOnly: options.includes("ro") || options.includes("readonly"), namedVolume };
}

/** Snapshot trusted boundary lists so later caller mutations cannot widen it. */
export function createWindowsDockerBoundary(options: WindowsDockerPaths): DockerBoundary {
  if (typeof options.resolve !== "function") return fail("Docker boundary", "native resolver is required");
  const resolver = options.resolve;
  const paths = (items: readonly string[]) => Object.freeze(items.map(canonicalWindowsDockerPath));
  const writable = paths(options.writable);
  const protectedPaths = paths([...options.protectedPaths, ...options.dockerContextPaths]);
  const unreadable = paths(options.unreadable);
  const endpointSocket = pipeName(options.endpointSocket);
  if (!/^\\\\\.\\pipe\\local\\crot-l1-docker-[a-z0-9-]+$/.test(endpointSocket))
    return fail("Docker boundary", "an owned LOCAL endpoint name is required");
  const daemonSockets = Object.freeze(options.daemonSockets.map(pipeName));
  const hostPaths: DockerHostPaths = Object.freeze({
    parseBind: parseWindowsDockerBind,
    checkSource(source: string, readOnly: boolean, where: string): void {
      const pipe = pipeName(source);
      if (pipe === endpointSocket) return;
      if (pipe.startsWith("\\\\.\\pipe\\") || pipe.startsWith("\\\\?\\pipe\\") || daemonSockets.includes(pipe))
        return fail(where, "binds a Docker daemon or unmediated pipe endpoint");
      const lexical = canonicalWindowsDockerPath(source);
      let resolved: string;
      try {
        resolved = canonicalWindowsDockerPath(resolver(lexical));
      } catch {
        return fail(where, "host path identity could not be admitted");
      }
      for (const candidate of new Set([lexical, resolved])) {
        if (protectedPaths.some((p) => contains(p, candidate) || contains(candidate, p)))
          return fail(where, "binds a CROT-protected path");
        const writableSource = writable.some((p) => contains(p, candidate));
        if (!readOnly && !writableSource) return fail(where, "a writable bind source must be inside the workspace");
        if (readOnly && !writableSource && unreadable.some((p) => contains(p, candidate) || contains(candidate, p)))
          return fail(where, "binds a path the sandbox cannot read");
      }
    },
  });
  return Object.freeze({ writable, protectedPaths, unreadable, daemonSockets, endpointSocket, hostPaths });
}

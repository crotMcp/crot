/**
 * The fixed checks of the L1 Docker endpoint (ARCHITECTURE.md §27 AD-20
 * point 9 a-d). Pure: no I/O. The endpoint has no configuration, no
 * per-request choice and does not involve the PermissionEngine; it refuses
 * only what would carry a confined process across the L1 boundary through the
 * daemon.
 */
import path from "node:path";
import { isWithin } from "./bwrap-args.js";

/** Platform-specific path checks; the Windows adapter must never use POSIX volume detection. */
export interface DockerHostPaths {
  checkSource(source: string, readOnly: boolean, where: string): void;
  parseBind(bind: string): { source: string; readOnly: boolean; namedVolume?: boolean };
}

/** The L1 boundary as the Docker endpoint applies it to host paths. */
export interface DockerBoundary {
  readonly hostPaths?: DockerHostPaths;
  /** Writable sources are accepted only inside these (the workspace and the L1 private storage). */
  readonly writable: readonly string[];
  /** CROT-protected paths: a source that is or contains one is refused (rule a). */
  readonly protectedPaths: readonly string[];
  /** Entries the sandbox cannot read (hidden by the read boundary): read-only sources there are refused (rule a). */
  readonly unreadable: readonly string[];
  /** Real daemon endpoints (rule d). */
  readonly daemonSockets: readonly string[];
  /** The endpoint's own socket, which may be bound (rule d). */
  readonly endpointSocket: string;
  /** Resolve a host path (symbolic links) before it is checked; identity for a remote daemon. */
  readonly resolve?: (p: string) => string;
}

/** Capabilities that act on the host kernel or other namespaces (rule b). */
export const REFUSED_CAPABILITIES = new Set([
  "ALL",
  "SYS_ADMIN",
  "SYS_MODULE",
  "SYS_RAWIO",
  "SYS_PTRACE",
  "SYS_BOOT",
  "DAC_READ_SEARCH",
  "MAC_ADMIN",
  "MAC_OVERRIDE",
  "BPF",
  "PERFMON",
  "SYSLOG",
]);

/** Security options that turn off a container's confinement (rule c). */
const REFUSED_SECURITY_OPTIONS = new Set([
  "apparmor=unconfined",
  "seccomp=unconfined",
  "systempaths=unconfined",
  "label=disable",
]);

export class Refusal extends Error {}

const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

/** Device paths of the classes the sandbox itself has (AD-20 point 6). */
export function deviceAllowed(device: string): boolean {
  const p = path.posix.normalize(device);
  return (
    [
      "/dev/null",
      "/dev/zero",
      "/dev/full",
      "/dev/random",
      "/dev/urandom",
      "/dev/tty",
      "/dev/fuse",
      "/dev/net/tun",
      "/dev/kfd",
    ].includes(p) ||
    /^\/dev\/nvidia(\d+|ctl|-uvm|-uvm-tools|-modeset)$/.test(p) ||
    /^\/dev\/dri\/renderD\d+$/.test(p)
  );
}

function normalizeCap(cap: string): string {
  const c = cap.trim().toUpperCase();
  return c.startsWith("CAP_") ? c.slice(4) : c;
}

/** Normalized security option: "apparmor:unconfined" and "apparmor=unconfined" are the same. */
function normalizeSecurityOpt(opt: string): string {
  return opt.trim().replace(":", "=").toLowerCase();
}

/** Check one host path source (rules a and d). */
export function checkSource(boundary: DockerBoundary, source: string, readOnly: boolean, where: string): void {
  if (boundary.hostPaths) return boundary.hostPaths.checkSource(source, readOnly, where);
  if (!path.posix.isAbsolute(source)) return; // a named volume, not a host path
  const lexical = path.posix.normalize(source);
  const resolved = boundary.resolve ? boundary.resolve(lexical) : lexical;
  for (const p of new Set([lexical, resolved])) {
    if (p === boundary.endpointSocket) continue; // rule d: the endpoint's own socket may be bound
    if (boundary.daemonSockets.some((s) => isWithin(p, s))) refuse(`${where}: binds a Docker daemon endpoint`);
    if (boundary.protectedPaths.some((q) => isWithin(p, q) || isWithin(q, p)))
      refuse(`${where}: binds a CROT-protected path`);
    const writable = boundary.writable.some((w) => isWithin(w, p));
    if (readOnly) {
      // The workspace is shown read-write even where it lies below a hidden root (a workspace in /tmp).
      if (!writable && boundary.unreadable.some((q) => isWithin(q, p) || isWithin(p, q)))
        refuse(`${where}: binds a path the sandbox cannot read`);
    } else if (!writable) {
      refuse(`${where}: a writable bind source must be inside the workspace`);
    }
  }
}

/** Parse a HostConfig.Binds entry "source:target[:options]". */
export function parseBind(bind: string): { source: string; readOnly: boolean } {
  const parts = bind.split(":");
  const source = parts[0] ?? "";
  const options = parts.length >= 3 ? (parts[parts.length - 1] ?? "").split(",") : [];
  return { source, readOnly: options.includes("ro") || options.includes("readonly") };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Volume driver options that bind a host path (local driver: o=bind, device=<path>). */
export function checkVolumeOptions(
  boundary: DockerBoundary,
  options: Json | undefined,
  readOnly: boolean,
  where: string,
): void {
  if (!options) return;
  const o = (str(options.o) ?? "").split(",").map((s) => s.trim());
  const device = str(options.device);
  if (device && (o.includes("bind") || o.includes("rbind") || str(options.type) === "none")) {
    checkSource(boundary, device, readOnly || o.includes("ro"), `${where}: volume driver option device`);
  }
}

/** A Mounts[] entry of a container or service. */
function checkMount(boundary: DockerBoundary, mount: Json, where: string): void {
  const type = str(mount.Type) ?? "volume";
  const readOnly = mount.ReadOnly === true;
  const source = str(mount.Source) ?? "";
  if (type === "bind" || type === "npipe") checkSource(boundary, source, readOnly, where);
  if (type === "volume") {
    const driverConfig = obj(obj(mount.VolumeOptions)?.DriverConfig);
    checkVolumeOptions(boundary, obj(driverConfig?.Options), readOnly, where);
  }
}

/** Rules b and c on a HostConfig (also used for exec/attach/archive/commit on existing containers). */
function checkPrivileges(hostConfig: Json, where: string): void {
  if (hostConfig.Privileged === true) refuse(`${where}: privileged containers are not allowed`);
  for (const cap of arr(hostConfig.CapAdd)) {
    if (typeof cap === "string" && REFUSED_CAPABILITIES.has(normalizeCap(cap)))
      refuse(`${where}: capability ${normalizeCap(cap)} is not allowed`);
  }
  for (const [field, label] of [
    ["PidMode", "PID"],
    ["IpcMode", "IPC"],
    ["UsernsMode", "user"],
    ["CgroupnsMode", "cgroup"],
  ] as const) {
    if (str(hostConfig[field]) === "host") refuse(`${where}: the host ${label} namespace is not allowed`);
  }
  for (const opt of arr(hostConfig.SecurityOpt)) {
    if (typeof opt === "string" && REFUSED_SECURITY_OPTIONS.has(normalizeSecurityOpt(opt)))
      refuse(`${where}: security option ${normalizeSecurityOpt(opt)} is not allowed`);
  }
  // The Docker CLI and Compose send --security-opt systempaths=unconfined as empty MaskedPaths/ReadonlyPaths.
  for (const field of ["MaskedPaths", "ReadonlyPaths"] as const) {
    const value = hostConfig[field];
    if (Array.isArray(value) && value.length === 0)
      refuse(`${where}: security option systempaths=unconfined is not allowed`);
  }
  for (const device of arr(hostConfig.Devices)) {
    const d = obj(device);
    const hostPath = str(d?.PathOnHost);
    if (hostPath !== undefined && !deviceAllowed(hostPath)) refuse(`${where}: device ${hostPath} is not allowed`);
  }
  // Device cgroup rules grant access to device nodes by number: the same as a device mapping (rule c).
  if (arr(hostConfig.DeviceCgroupRules).length > 0) refuse(`${where}: device cgroup rules are not allowed`);
}

/** Rules a-d on a container HostConfig (create, or the configuration of an existing container). */
export function checkHostConfig(boundary: DockerBoundary, hostConfig: Json | undefined, where = "container"): void {
  if (!hostConfig) return;
  checkPrivileges(hostConfig, where);
  for (const bind of arr(hostConfig.Binds)) {
    if (typeof bind !== "string") continue;
    const parsed = boundary.hostPaths ? boundary.hostPaths.parseBind(bind) : parseBind(bind);
    if ("namedVolume" in parsed && parsed.namedVolume) continue;
    const { source, readOnly } = parsed;
    checkSource(boundary, source, readOnly, `${where}: bind ${source}`);
  }
  for (const mount of arr(hostConfig.Mounts)) {
    const m = obj(mount);
    if (m) checkMount(boundary, m, `${where}: mount ${str(m.Source) ?? ""}`);
  }
}

/** The mounts of an existing container as reported by inspect (Mounts[] with Type/Source/RW). */
export function checkInspectedMounts(boundary: DockerBoundary, mounts: unknown, where: string): void {
  for (const mount of arr(mounts)) {
    const m = obj(mount);
    if (!m || !["bind", "npipe"].includes(str(m.Type) ?? "")) continue;
    checkSource(boundary, str(m.Source) ?? "", m.RW === false, `${where}: mount ${str(m.Source) ?? ""}`);
  }
}

/** POST /containers/create body. Returns the container names of VolumesFrom to check as well. */
export function checkContainerCreate(boundary: DockerBoundary, body: Json): { volumesFrom: string[] } {
  const hostConfig = obj(body.HostConfig);
  checkHostConfig(boundary, hostConfig);
  const volumesFrom = arr(hostConfig?.VolumesFrom)
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.split(":")[0] ?? v);
  return { volumesFrom };
}

/**
 * POST /containers/{id}/exec body (rule b): a privileged exec runs with every
 * capability and without the container's AppArmor profile, i.e. a privileged
 * process in an otherwise unprivileged container.
 */
export function checkExecCreate(body: Json): void {
  if (body.Privileged === true) refuse("exec: privileged processes are not allowed");
}

/** POST /volumes/create body. */
export function checkVolumeCreate(boundary: DockerBoundary, body: Json): void {
  const driver = str(body.Driver) ?? "local";
  if (driver === "local") checkVolumeOptions(boundary, obj(body.DriverOpts), false, "volume");
}

/** POST /services/create and /services/{id}/update bodies (Swarm). */
export function checkServiceSpec(boundary: DockerBoundary, body: Json): void {
  const spec = obj(obj(body.TaskTemplate)?.ContainerSpec);
  if (!spec) return;
  for (const mount of arr(spec.Mounts)) {
    const m = obj(mount);
    if (m) checkMount(boundary, m, `service: mount ${str(m.Source) ?? ""}`);
  }
  for (const cap of arr(spec.CapabilityAdd)) {
    if (typeof cap === "string" && REFUSED_CAPABILITIES.has(normalizeCap(cap)))
      refuse(`service: capability ${normalizeCap(cap)} is not allowed`);
  }
  const privileges = obj(spec.Privileges);
  if (obj(privileges?.AppArmor)?.Mode === "disabled")
    refuse("service: security option apparmor=unconfined is not allowed");
  if (obj(privileges?.Seccomp)?.Mode === "unconfined")
    refuse("service: security option seccomp=unconfined is not allowed");
  if (obj(privileges?.SELinuxContext)?.Disable === true)
    refuse("service: security option label=disable is not allowed");
}

/** Query of POST /build (classic builder and BuildKit): entitlements and security options (rule c). */
export function checkBuildQuery(query: URLSearchParams): void {
  for (const opt of query.getAll("securityopt")) {
    if (REFUSED_SECURITY_OPTIONS.has(normalizeSecurityOpt(opt))) refuse(`build: security option ${opt} is not allowed`);
  }
}

/** The BuildKit entitlement security.insecure, as it appears in a Solve request on a /grpc or /session stream (rule c). */
export const INSECURE_ENTITLEMENT = Buffer.from("security.insecure");

/**
 * Add the CROT container profile (crot-l1-container-<v>) to a container
 * create body for a daemon on this host that supports AppArmor (AD-20
 * point 9). Any other apparmor= option is replaced.
 */
export function withContainerProfile(body: Json, profile: string): Json {
  const hostConfig = obj(body.HostConfig) ?? {};
  const options = arr(hostConfig.SecurityOpt).filter(
    (o): o is string => typeof o === "string" && !normalizeSecurityOpt(o).startsWith("apparmor="),
  );
  return { ...body, HostConfig: { ...hostConfig, SecurityOpt: [...options, `apparmor=${profile}`] } };
}

/** What a Docker API request is, for audit and for the checks (request kind; never a payload). */
export type RequestKind =
  | "container.create"
  | "container.exec"
  | "container.attach"
  | "container.archive"
  | "container.commit"
  | "volume.create"
  | "service.create"
  | "service.update"
  | "build"
  | "session"
  | "grpc"
  | "plugin.install"
  | "other";

export interface ClassifiedRequest {
  readonly kind: RequestKind;
  /** The container id or name for exec/attach/archive/commit. */
  readonly container?: string;
  readonly query: URLSearchParams;
}

/** Classify a request line (method and target), with or without the /vX.Y API version prefix. */
export function classify(method: string, target: string): ClassifiedRequest {
  const url = new URL(target, "http://docker");
  const p = url.pathname.replace(/^\/v\d+(\.\d+)?(?=\/)/, "");
  const m = method.toUpperCase();
  const q = url.searchParams;
  let match: RegExpExecArray | null;
  if (m === "POST" && p === "/containers/create") return { kind: "container.create", query: q };
  if (m === "POST" && (match = /^\/containers\/([^/]+)\/exec$/.exec(p)))
    return { kind: "container.exec", container: decodeURIComponent(match[1]!), query: q };
  if (m === "POST" && (match = /^\/containers\/([^/]+)\/attach(\/ws)?$/.exec(p)))
    return { kind: "container.attach", container: decodeURIComponent(match[1]!), query: q };
  if (m === "GET" && (match = /^\/containers\/([^/]+)\/attach\/ws$/.exec(p)))
    return { kind: "container.attach", container: decodeURIComponent(match[1]!), query: q };
  if ((m === "PUT" || m === "GET" || m === "HEAD") && (match = /^\/containers\/([^/]+)\/archive$/.exec(p)))
    return { kind: "container.archive", container: decodeURIComponent(match[1]!), query: q };
  if (m === "GET" && (match = /^\/containers\/([^/]+)\/export$/.exec(p)))
    return { kind: "container.archive", container: decodeURIComponent(match[1]!), query: q };
  if (m === "POST" && p === "/commit") {
    const container = q.get("container") ?? "";
    return { kind: "container.commit", container, query: q };
  }
  if (m === "POST" && p === "/volumes/create") return { kind: "volume.create", query: q };
  if (m === "POST" && p === "/services/create") return { kind: "service.create", query: q };
  if (m === "POST" && /^\/services\/[^/]+\/update$/.test(p)) return { kind: "service.update", query: q };
  if (m === "POST" && p === "/build") return { kind: "build", query: q };
  if (m === "POST" && p === "/session") return { kind: "session", query: q };
  if (m === "POST" && p === "/grpc") return { kind: "grpc", query: q };
  if (m === "POST" && (p === "/plugins/pull" || p === "/plugins/create" || /^\/plugins\/[^/]+\/upgrade$/.test(p)))
    return { kind: "plugin.install", query: q };
  return { kind: "other", query: q };
}

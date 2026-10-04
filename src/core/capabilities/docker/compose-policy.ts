/**
 * Compose policy of `docker.use` (ARCHITECTURE.md §27, AD-3).
 *
 * Two pure checks protect `docker_compose_up`:
 *
 * 1. scanComposeSource() runs on the raw bytes of every Compose file before
 *    Docker Compose reads it. It refuses the constructs that make Compose read
 *    further files CROT has not authorized (include, extends, label_file) and
 *    the YAML features that could spell them without the literal key
 *    (hexadecimal escapes, line continuations, binary or verbatim tags,
 *    directives).
 *
 * 2. reviewComposeModel() runs on the model Compose produced
 *    (`docker compose config --format json`: merged, interpolated and
 *    normalized). It is deny-by-default: every top-level, service, volume,
 *    network, secret and config key that is not listed here refuses the
 *    operation. Nothing that grants a container host privileges (privileged,
 *    capabilities, devices, host namespaces, security options, runtimes,
 *    logging drivers, the Docker API socket), builds or pulls images, or
 *    mounts host data through a volume driver is allowed. Every host path the
 *    model mounts (bind mounts, secret and config files) is returned so that
 *    the caller can authorize it with the PermissionEngine like any other path.
 *
 * Both checks refuse with UNSAFE_COMPOSE and list every violation found.
 */
import { CrotError } from "../../errors.js";

/** Largest Compose file CROT reviews. */
export const COMPOSE_FILE_MAX_BYTES = 1024 * 1024;

/** Keys that make Compose load more files while it builds the model. */
const FORBIDDEN_WORDS = ["include", "extends", "label_file"] as const;

const SOURCE_RULES: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  ...FORBIDDEN_WORDS.map((word) => ({
    pattern: new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`),
    reason: `'${word}' is not supported (it loads files CROT has not authorized)`,
  })),
  { pattern: /\\[xuU]/, reason: "hexadecimal escapes are not supported" },
  { pattern: /\\\r?\n/, reason: "escaped line breaks are not supported" },
  { pattern: /!!binary|!<|tag:yaml\.org/, reason: "binary and verbatim YAML tags are not supported" },
  { pattern: /^%/m, reason: "YAML directives are not supported" },
];

/**
 * Refuse a Compose file whose text could make Docker Compose read files that
 * CROT has not authorized, or that CROT cannot review reliably.
 */
export function scanComposeSource(data: Uint8Array, file: string): void {
  if (data.length > COMPOSE_FILE_MAX_BYTES) {
    throw unsafe(`Compose file ${file} is larger than ${COMPOSE_FILE_MAX_BYTES} bytes.`, [file]);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw unsafe(`Compose file ${file} is not valid UTF-8.`, [file]);
  }
  const violations: string[] = [];
  if (text.includes("\0")) violations.push("NUL characters are not supported");
  for (const rule of SOURCE_RULES) if (rule.pattern.test(text)) violations.push(rule.reason);
  if (violations.length > 0) {
    throw unsafe(`Compose file ${file} is refused by docker.use: ${violations.join("; ")}.`, violations);
  }
}

/** A host path the model mounts into a container. */
export interface ComposeHostPath {
  /** Where the path is used, e.g. "services.web.volumes[0]" or "secrets.token". */
  readonly where: string;
  readonly kind: "bind" | "secret" | "config";
  /** Path as Compose resolved it (absolute). */
  readonly source: string;
  /** Whether the container can only read it. */
  readonly readOnly: boolean;
  /** Replace the path in the model (with the canonical path CROT authorized). */
  replace(canonical: string): void;
}

export interface ComposeReview {
  readonly name: string | undefined;
  readonly services: string[];
  readonly hostPaths: ComposeHostPath[];
  /** Resources that exist outside the project (external volumes); they need filesystem.full. */
  readonly external: string[];
}

type Json = Record<string, unknown>;

const TOP_LEVEL_KEYS = new Set(["name", "services", "networks", "volumes", "secrets", "configs"]);

/**
 * Service keys docker.use accepts, with a check of their value (true: any
 * value). Everything else, e.g. build, privileged, cap_add, devices, pid,
 * userns_mode, security_opt (other than no-new-privileges), sysctls, runtime,
 * gpus, logging, volume_driver, external_links, use_api_socket, develop,
 * provider, post_start and pre_stop, is refused.
 */
const SERVICE_KEYS: Readonly<Record<string, true | ((value: unknown, where: string, out: string[]) => void)>> = {
  image: (v, where, out) => {
    if (typeof v !== "string" || v.length === 0) out.push(`${where}: an image is required`);
  },
  command: true,
  entrypoint: true,
  environment: true,
  working_dir: true,
  user: true,
  container_name: true,
  hostname: true,
  domainname: true,
  mac_address: true,
  ports: true,
  expose: true,
  depends_on: true,
  healthcheck: true,
  restart: true,
  stop_signal: true,
  stop_grace_period: true,
  tty: true,
  stdin_open: true,
  init: true,
  read_only: true,
  tmpfs: true,
  shm_size: true,
  mem_limit: true,
  mem_reservation: true,
  memswap_limit: true,
  mem_swappiness: true,
  cpus: true,
  cpu_shares: true,
  cpu_quota: true,
  cpu_period: true,
  cpuset: true,
  pids_limit: true,
  ulimits: true,
  dns: true,
  dns_search: true,
  dns_opt: true,
  extra_hosts: true,
  platform: true,
  profiles: true,
  links: true,
  scale: true,
  attach: true,
  cap_drop: true,
  secrets: true,
  configs: true,
  labels: (v, where, out) => checkLabels(v, where, out),
  pull_policy: (v, where, out) => {
    if (!["never", "missing", "if_not_present"].includes(String(v))) {
      out.push(`${where}: only 'never' or 'missing' is allowed (docker.use never pulls images)`);
    }
  },
  network_mode: (v, where, out) => {
    const value = String(v);
    if (!["none", "bridge", "default"].includes(value) && !value.startsWith("service:")) {
      out.push(`${where}: '${value}' is not allowed (only none, bridge or service:<name>)`);
    }
  },
  ipc: (v, where, out) => {
    const value = String(v);
    if (!["private", "shareable", "none"].includes(value) && !value.startsWith("service:")) {
      out.push(`${where}: '${value}' is not allowed (only private, shareable, none or service:<name>)`);
    }
  },
  pid: (v, where, out) => {
    const value = String(v);
    if (!value.startsWith("service:")) out.push(`${where}: '${value}' is not allowed (only service:<name>)`);
  },
  volumes_from: (v, where, out) => {
    for (const entry of asArray(v)) {
      if (typeof entry !== "string" || entry.startsWith("container:")) {
        out.push(`${where}: only services of the project are allowed, not '${String(entry)}'`);
      }
    }
  },
  security_opt: (v, where, out) => {
    for (const entry of asArray(v)) {
      if (!/^no-new-privileges([:=]true)?$/.test(String(entry))) {
        out.push(`${where}: '${String(entry)}' is not allowed (only no-new-privileges)`);
      }
    }
  },
  networks: (v, where, out) => {
    if (v === null || v === undefined) return;
    if (!isObject(v)) return out.push(`${where}: unexpected value`);
    for (const [name, attachment] of Object.entries(v)) {
      if (attachment === null || attachment === undefined) continue;
      if (!isObject(attachment)) {
        out.push(`${where}.${name}: unexpected value`);
        continue;
      }
      for (const key of Object.keys(attachment)) {
        if (!SERVICE_NETWORK_KEYS.has(key)) out.push(`${where}.${name}.${key} is not allowed`);
      }
    }
  },
  deploy: (v, where, out) => checkDeploy(v, where, out),
  // volumes are checked by reviewServiceVolumes.
  volumes: true,
};

const SERVICE_NETWORK_KEYS = new Set([
  "aliases",
  "ipv4_address",
  "ipv6_address",
  "link_local_ips",
  "mac_address",
  "priority",
  "gw_priority",
]);

const DEPLOY_KEYS = new Set([
  "mode",
  "replicas",
  "resources",
  "restart_policy",
  "placement",
  "labels",
  "update_config",
  "rollback_config",
  "endpoint_mode",
]);
const RESOURCE_LIMIT_KEYS = new Set(["cpus", "memory", "pids"]);
const RESOURCE_RESERVATION_KEYS = new Set(["cpus", "memory"]);

const BIND_KEYS = new Set(["type", "source", "target", "read_only", "bind", "consistency"]);
const BIND_OPTION_KEYS = new Set(["create_host_path", "propagation", "selinux"]);
const VOLUME_MOUNT_KEYS = new Set(["type", "source", "target", "read_only", "volume", "consistency"]);
const VOLUME_OPTION_KEYS = new Set(["nocopy", "subpath"]);
const TMPFS_MOUNT_KEYS = new Set(["type", "target", "read_only", "tmpfs", "consistency"]);

const TOP_VOLUME_KEYS = new Set(["name", "driver", "external", "labels"]);
const TOP_NETWORK_KEYS = new Set([
  "name",
  "driver",
  "external",
  "labels",
  "ipam",
  "internal",
  "attachable",
  "enable_ipv4",
  "enable_ipv6",
]);
const IPAM_KEYS = new Set(["driver", "config"]);
const TOP_SECRET_KEYS = new Set(["name", "file", "content", "labels"]);

/**
 * Review the normalized Compose model. Throws UNSAFE_COMPOSE listing every
 * violation; otherwise returns the services and every host path to authorize.
 */
export function reviewComposeModel(model: unknown): ComposeReview {
  const out: string[] = [];
  const hostPaths: ComposeHostPath[] = [];
  const external: string[] = [];
  if (!isObject(model)) throw unsafe("Docker Compose returned an unexpected model.", []);

  for (const key of Object.keys(model)) {
    if (!TOP_LEVEL_KEYS.has(key) && !isExtension(key)) out.push(`top-level '${key}' is not allowed`);
  }
  const name = typeof model.name === "string" ? model.name : undefined;

  const services = model.services;
  if (!isObject(services) || Object.keys(services).length === 0) out.push("the project defines no services");
  const serviceNames = isObject(services) ? Object.keys(services) : [];
  for (const [serviceName, service] of isObject(services) ? Object.entries(services) : []) {
    const where = `services.${serviceName}`;
    if (!isObject(service)) {
      out.push(`${where}: unexpected value`);
      continue;
    }
    if (!("image" in service)) out.push(`${where}: an image is required (docker.use never builds images)`);
    for (const [key, value] of Object.entries(service)) {
      if (isExtension(key)) continue;
      const rule = SERVICE_KEYS[key];
      if (rule === undefined) {
        out.push(`${where}.${key} is not allowed`);
        continue;
      }
      if (rule !== true) rule(value, `${where}.${key}`, out);
    }
    if (service.volumes !== undefined && service.volumes !== null) {
      reviewServiceVolumes(service.volumes, `${where}.volumes`, out, hostPaths);
    }
  }

  reviewTopLevel(model.volumes, "volumes", out, (where, volume) => {
    for (const key of Object.keys(volume)) {
      if (!TOP_VOLUME_KEYS.has(key) && !isExtension(key)) out.push(`${where}.${key} is not allowed`);
    }
    if (volume.driver !== undefined && volume.driver !== "local") {
      out.push(`${where}.driver '${String(volume.driver)}' is not allowed (only local)`);
    }
    checkLabels(volume.labels, `${where}.labels`, out);
    if (volume.external === true) external.push(`${where} (external volume ${String(volume.name ?? "")})`.trim());
  });

  reviewTopLevel(model.networks, "networks", out, (where, network) => {
    for (const key of Object.keys(network)) {
      if (!TOP_NETWORK_KEYS.has(key) && !isExtension(key)) out.push(`${where}.${key} is not allowed`);
    }
    if (network.driver !== undefined && network.driver !== "bridge") {
      out.push(`${where}.driver '${String(network.driver)}' is not allowed (only bridge)`);
    }
    if (network.name === "host" || network.name === "none") {
      out.push(`${where}: the '${String(network.name)}' network is not allowed`);
    }
    checkLabels(network.labels, `${where}.labels`, out);
    if (network.ipam !== undefined && network.ipam !== null) {
      if (!isObject(network.ipam)) {
        out.push(`${where}.ipam: unexpected value`);
      } else {
        for (const key of Object.keys(network.ipam)) {
          if (!IPAM_KEYS.has(key)) out.push(`${where}.ipam.${key} is not allowed`);
        }
        if (network.ipam.driver !== undefined && network.ipam.driver !== "default") {
          out.push(`${where}.ipam.driver is not allowed`);
        }
      }
    }
  });

  for (const section of ["secrets", "configs"] as const) {
    reviewTopLevel(model[section], section, out, (where, entry) => {
      for (const key of Object.keys(entry)) {
        if (!TOP_SECRET_KEYS.has(key) && !isExtension(key)) out.push(`${where}.${key} is not allowed`);
      }
      checkLabels(entry.labels, `${where}.labels`, out);
      if (entry.file !== undefined) {
        if (typeof entry.file !== "string" || entry.file.length === 0) {
          out.push(`${where}.file: unexpected value`);
        } else {
          hostPaths.push({
            where,
            kind: section === "secrets" ? "secret" : "config",
            source: entry.file,
            readOnly: true,
            replace: (canonical) => {
              entry.file = canonical;
            },
          });
        }
      }
    });
  }

  if (out.length > 0) {
    throw unsafe(`The Compose project is refused by docker.use: ${out.join("; ")}.`, out);
  }
  return { name, services: serviceNames, hostPaths, external };
}

function reviewServiceVolumes(value: unknown, where: string, out: string[], hostPaths: ComposeHostPath[]): void {
  if (!Array.isArray(value)) return void out.push(`${where}: unexpected value`);
  value.forEach((mount: unknown, index) => {
    const at = `${where}[${index}]`;
    if (!isObject(mount)) return void out.push(`${at}: unexpected value`);
    switch (mount.type) {
      case "bind": {
        checkKeys(mount, BIND_KEYS, at, out);
        if (mount.bind !== undefined && mount.bind !== null) {
          if (!isObject(mount.bind)) {
            out.push(`${at}.bind: unexpected value`);
          } else {
            checkKeys(mount.bind, BIND_OPTION_KEYS, `${at}.bind`, out);
            const propagation = mount.bind.propagation;
            if (propagation !== undefined && propagation !== "private" && propagation !== "rprivate") {
              out.push(`${at}.bind.propagation '${String(propagation)}' is not allowed (only private, rprivate)`);
            }
          }
        }
        if (typeof mount.source !== "string" || mount.source.length === 0) {
          out.push(`${at}: a bind mount needs a source path`);
          return;
        }
        hostPaths.push({
          where: at,
          kind: "bind",
          source: mount.source,
          readOnly: mount.read_only === true,
          replace: (canonical) => {
            mount.source = canonical;
          },
        });
        return;
      }
      case "volume":
        checkKeys(mount, VOLUME_MOUNT_KEYS, at, out);
        if (mount.volume !== undefined && mount.volume !== null) {
          if (isObject(mount.volume)) checkKeys(mount.volume, VOLUME_OPTION_KEYS, `${at}.volume`, out);
          else out.push(`${at}.volume: unexpected value`);
        }
        return;
      case "tmpfs":
        checkKeys(mount, TMPFS_MOUNT_KEYS, at, out);
        return;
      default:
        out.push(`${at}: mount type '${String(mount.type)}' is not allowed (only bind, volume, tmpfs)`);
    }
  });
}

function reviewTopLevel(
  section: unknown,
  name: string,
  out: string[],
  check: (where: string, entry: Json) => void,
): void {
  if (section === undefined || section === null) return;
  if (!isObject(section)) return void out.push(`${name}: unexpected value`);
  for (const [key, entry] of Object.entries(section)) {
    if (isExtension(key)) continue;
    if (entry === null || entry === undefined) continue;
    if (!isObject(entry)) {
      out.push(`${name}.${key}: unexpected value`);
      continue;
    }
    check(`${name}.${key}`, entry);
  }
}

function checkDeploy(value: unknown, where: string, out: string[]): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) return void out.push(`${where}: unexpected value`);
  checkKeys(value, DEPLOY_KEYS, where, out);
  checkLabels(value.labels, `${where}.labels`, out);
  const resources = value.resources;
  if (resources === undefined || resources === null) return;
  if (!isObject(resources)) return void out.push(`${where}.resources: unexpected value`);
  checkKeys(resources, new Set(["limits", "reservations"]), `${where}.resources`, out);
  if (isObject(resources.limits)) checkKeys(resources.limits, RESOURCE_LIMIT_KEYS, `${where}.resources.limits`, out);
  if (isObject(resources.reservations)) {
    checkKeys(resources.reservations, RESOURCE_RESERVATION_KEYS, `${where}.resources.reservations`, out);
  }
}

/** Labels may not impersonate the labels Compose itself sets (CROT scopes containers by them). */
function checkLabels(value: unknown, where: string, out: string[]): void {
  if (value === undefined || value === null) return;
  const keys = Array.isArray(value)
    ? value.map((entry) => String(entry).split("=", 1)[0] ?? "")
    : isObject(value)
      ? Object.keys(value)
      : null;
  if (keys === null) return void out.push(`${where}: unexpected value`);
  for (const key of keys) {
    if (key.startsWith("com.docker.compose.")) out.push(`${where}: label '${key}' is reserved for Docker Compose`);
  }
}

function checkKeys(object: Json, allowed: ReadonlySet<string>, where: string, out: string[]): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key) && !isExtension(key)) out.push(`${where}.${key} is not allowed`);
  }
}

function isExtension(key: string): boolean {
  return key.startsWith("x-");
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function unsafe(message: string, violations: readonly string[]): CrotError {
  return new CrotError("UNSAFE_COMPOSE", message, { violations });
}

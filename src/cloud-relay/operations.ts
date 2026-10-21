/** Metadata-only operations support for WP-39: metrics and durable state backup. */
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AccountService, type State } from "../account-service/service.js";
import { isDeviceId } from "../identity/device-id.js";
import { isDevicePublicKey, type DeviceRecord } from "./registry.js";
import { randomUUID } from "node:crypto";
import type { RelayLogRecord } from "./log.js";
import type { RelayStatus } from "./server.js";

const KNOWN_EVENTS = [
  "relay.listening",
  "relay.closed",
  "relay.internal_error",
  "request.complete",
  "request.refused",
  "tunnel.ready",
  "tunnel.closed",
  "account.request",
] as const;
export class OperationalMetrics {
  private readonly started = Date.now();
  private readonly events = new Map<string, number>();
  observe(record: RelayLogRecord): void {
    const event = KNOWN_EVENTS.includes(record.event as (typeof KNOWN_EVENTS)[number]) ? record.event : "other";
    this.events.set(event, (this.events.get(event) ?? 0) + 1);
  }
  render(status: RelayStatus, now = Date.now()): string {
    const lines = [
      "# HELP crot_relay_uptime_seconds Relay process uptime.",
      "# TYPE crot_relay_uptime_seconds gauge",
      `crot_relay_uptime_seconds ${Math.max(0, Math.floor((now - this.started) / 1000))}`,
      "# TYPE crot_relay_devices_online gauge",
      `crot_relay_devices_online ${status.devicesOnline}`,
      "# TYPE crot_relay_open_streams gauge",
      `crot_relay_open_streams ${status.openStreams}`,
      "# TYPE crot_relay_tunnels gauge",
      `crot_relay_tunnels{phase="handshake"} ${status.tunnels.handshake}`,
      `crot_relay_tunnels{phase="ready"} ${status.tunnels.ready}`,
      `crot_relay_tunnels{phase="draining"} ${status.tunnels.draining}`,
      "# TYPE crot_relay_admission_requests gauge",
      `crot_relay_admission_requests ${status.admission.requests}`,
      "# TYPE crot_relay_event_total counter",
    ];
    for (const event of [...KNOWN_EVENTS, "other"])
      lines.push(`crot_relay_event_total{event="${event}"} ${this.events.get(event) ?? 0}`);
    return lines.join("\n") + "\n";
  }
}

export function metricsTokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && supplied.length >= 32 && timingSafeEqual(supplied, wanted);
}

export interface StateBackupManifest {
  readonly schema: 1;
  readonly createdAt: string;
  readonly files: readonly { name: "registry" | "accounts"; sha256: string; bytes: number }[];
}
export async function backupRelayState(input: {
  registryFile: string;
  accountFile: string;
  outputDir: string;
  now?: () => number;
}): Promise<StateBackupManifest> {
  const pairs = [
    ["registry", input.registryFile],
    ["accounts", input.accountFile],
  ] as const;
  const temp = `${input.outputDir}.tmp-${process.pid}`;
  await mkdir(temp, { recursive: true, mode: 0o700 });
  const files: StateBackupManifest["files"][number][] = [];
  for (const [name, source] of pairs) {
    const data = await readFile(source);
    await writeFile(path.join(temp, `${name}.json`), data, { mode: 0o600 });
    files.push({ name, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length });
  }
  const manifest: StateBackupManifest = {
    schema: 1,
    createdAt: new Date((input.now ?? Date.now)()).toISOString(),
    files,
  };
  await writeFile(path.join(temp, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, input.outputDir);
  return manifest;
}
export async function restoreRelayState(input: {
  backupDir: string;
  registryFile: string;
  accountFile: string;
  /** Fault-injection seam; production defaults to fs.rename. */
  replace?: typeof rename;
}): Promise<void> {
  const manifest = JSON.parse(
    await readFile(path.join(input.backupDir, "manifest.json"), "utf8"),
  ) as StateBackupManifest;
  if (manifest.schema !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== 2)
    throw new Error("invalid relay backup manifest");
  const names = manifest.files.map((entry) => entry.name).sort();
  if (names.join(",") !== "accounts,registry") throw new Error("invalid relay backup manifest");
  const targets = { registry: input.registryFile, accounts: input.accountFile } as const;
  const validated: Array<{ target: string; data: Buffer }> = [];
  for (const entry of manifest.files) {
    if ((entry.name !== "registry" && entry.name !== "accounts") || !/^[0-9a-f]{64}$/.test(entry.sha256))
      throw new Error("invalid relay backup entry");
    const name = entry.name as "registry" | "accounts";
    const data = await readFile(path.join(input.backupDir, `${name}.json`));
    if (data.length !== entry.bytes || createHash("sha256").update(data).digest("hex") !== entry.sha256)
      throw new Error(`relay backup integrity failure: ${name}`);
    JSON.parse(data.toString("utf8"));
    validated.push({ target: targets[name], data });
  }
  const account = JSON.parse(validated.find((v) => v.target === input.accountFile)!.data.toString()) as State;
  AccountService.validateState(account);
  const registry = JSON.parse(validated.find((v) => v.target === input.registryFile)!.data.toString()) as {
    version: number;
    devices: DeviceRecord[];
  };
  if (
    !registry ||
    Object.keys(registry).sort().join(",") !== "devices,version" ||
    registry.version !== 1 ||
    !Array.isArray(registry.devices) ||
    registry.devices.length > 100_000
  )
    throw new Error("invalid registry schema");
  const seen = new Set<string>();
  for (const record of registry.devices) {
    if (
      !record ||
      Object.keys(record).sort().join(",") !== "accountId,deviceId,environment,publicKey,registeredAt" ||
      !isDeviceId(record.deviceId) ||
      seen.has(record.deviceId) ||
      !isDevicePublicKey(record.publicKey) ||
      typeof record.environment !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,31}$/.test(record.environment) ||
      typeof record.registeredAt !== "string" ||
      !Number.isFinite(Date.parse(record.registeredAt))
    )
      throw new Error("invalid registry record");
    seen.add(record.deviceId);
    const owner = account.accounts.find((a) => a.accountId === record.accountId);
    // Reservations without registry entries are valid after interrupted registration;
    // registry records without matching commercial ownership are never valid.
    if (!owner?.devices.some((d) => d.deviceId === record.deviceId))
      throw new Error("inconsistent registry/accounts ownership");
  }
  if (path.resolve(input.registryFile) === path.resolve(input.accountFile))
    throw new Error("restore targets must differ");
  const id = randomUUID();
  const staged: Array<{ target: string; temp: string; original?: Buffer }> = [];
  const replaced: typeof staged = [];
  let rollbackIncomplete = false;
  try {
    for (const { target, data } of validated) {
      let original: Buffer | undefined;
      try {
        original = await readFile(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.restore-${id}`;
      staged.push({ target, temp, original });
      await writeFile(temp, data, { mode: 0o600 });
    }
    for (const entry of staged) {
      await (input.replace ?? rename)(entry.temp, entry.target);
      replaced.push(entry);
    }
  } catch (error) {
    try {
      for (const entry of replaced.reverse()) {
        if (entry.original) {
          await writeFile(entry.temp, entry.original, { mode: 0o600 });
          await (input.replace ?? rename)(entry.temp, entry.target);
        } else await rm(entry.target, { force: true });
      }
    } catch (rollbackError) {
      rollbackIncomplete = true;
      throw new AggregateError(
        [error, rollbackError],
        "restore failed and rollback incomplete; keep relay stopped and recover offline",
      );
    }
    throw error;
  } finally {
    // Preserve original-byte recovery files if the rollback rename itself failed.
    if (!rollbackIncomplete) for (const entry of staged) await rm(entry.temp, { force: true });
  }
}

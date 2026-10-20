/**
 * Registered devices of the Cloud Relay (ARCHITECTURE.md §27 AD-22 point 4).
 *
 * A record binds a device id to the account that paired it and the device's
 * public tunnel key (`DevicePublicKey`, WP-28). A device id registers once:
 * the same account and key again is an idempotent repeat, anything else is a
 * conflict. Nothing secret is stored (no token, no private key). Fresh
 * device-key proof permits conditional removal of the exact registered record.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DevicePublicKey } from "../identity/device-credential.js";
import { isDeviceId } from "../identity/device-id.js";

export interface DeviceRecord {
  readonly deviceId: string;
  readonly accountId: string;
  readonly publicKey: DevicePublicKey;
  /** The relay's identity environment id at registration. */
  readonly environment: string;
  readonly registeredAt: string;
}

export type RegisterResult = "created" | "unchanged" | "conflict";

export interface DeviceRegistry {
  get(deviceId: string): Promise<DeviceRecord | undefined>;
  register(record: DeviceRecord): Promise<RegisterResult>;
  count(): Promise<number>;
  remove(expected: DeviceRecord): Promise<boolean>;
}

/** Whether `value` is an Ed25519 public JWK with exactly the members of `DevicePublicKey`. */
export function isDevicePublicKey(value: unknown): value is DevicePublicKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort();
  if (keys.join(",") !== "crv,kty,x") return false;
  if (v.kty !== "OKP" || v.crv !== "Ed25519" || typeof v.x !== "string") return false;
  const bytes = Buffer.from(v.x, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === v.x;
}

const sameKey = (a: DevicePublicKey, b: DevicePublicKey) => a.kty === b.kty && a.crv === b.crv && a.x === b.x;

function decide(existing: DeviceRecord | undefined, record: DeviceRecord): RegisterResult | undefined {
  if (!existing) return undefined;
  return existing.accountId === record.accountId && sameKey(existing.publicKey, record.publicKey)
    ? "unchanged"
    : "conflict";
}

export class MemoryDeviceRegistry implements DeviceRegistry {
  protected readonly records = new Map<string, DeviceRecord>();

  async get(deviceId: string): Promise<DeviceRecord | undefined> {
    return this.records.get(deviceId);
  }

  async register(record: DeviceRecord): Promise<RegisterResult> {
    const decided = decide(this.records.get(record.deviceId), record);
    if (decided) return decided;
    this.records.set(record.deviceId, record);
    return "created";
  }

  async remove(expected: DeviceRecord): Promise<boolean> {
    if (this.records.get(expected.deviceId) !== expected) return false;
    this.records.delete(expected.deviceId);
    return true;
  }

  async count(): Promise<number> {
    return this.records.size;
  }
}

const FILE_VERSION = 1;

/**
 * A registry persisted as one JSON file (single relay instance; written
 * atomically, owner-only). Multi-instance storage is internal to WP-29 and
 * not part of v1 here (AD-22 open question 8).
 */
export class FileDeviceRegistry extends MemoryDeviceRegistry {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly file: string) {
    super();
  }

  static async open(file: string): Promise<FileDeviceRegistry> {
    const registry = new FileDeviceRegistry(file);
    let text: string | undefined;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (text !== undefined) {
      const doc = JSON.parse(text) as { version?: unknown; devices?: unknown };
      if (doc.version !== FILE_VERSION || !Array.isArray(doc.devices))
        throw new Error("the device registry file has an unknown format");
      for (const r of doc.devices as DeviceRecord[]) {
        if (!isDeviceId(r.deviceId) || typeof r.accountId !== "string" || !isDevicePublicKey(r.publicKey))
          throw new Error("the device registry file contains an invalid record");
        registry.records.set(r.deviceId, r);
      }
    }
    return registry;
  }

  override async register(record: DeviceRecord): Promise<RegisterResult> {
    const run = this.queue.then(async () => {
      const result = await super.register(record);
      if (result === "created") {
        try {
          await this.persist();
        } catch (error) {
          // Not durable means not registered: the device's pairing fails and can be repeated.
          this.records.delete(record.deviceId);
          throw error;
        }
      }
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  override async remove(expected: DeviceRecord): Promise<boolean> {
    const run = this.queue.then(async () => {
      if (!(await super.remove(expected))) return false;
      try {
        await this.persist();
      } catch (error) {
        this.records.set(expected.deviceId, expected);
        throw error;
      }
      return true;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const doc = { version: FILE_VERSION, devices: [...this.records.values()] };
    await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

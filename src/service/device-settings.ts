/**
 * Device settings of the service (ARCHITECTURE.md §27, AD-19 points 5–7):
 * the preset chosen in the tray, remote mode and the remote full-control
 * opt-in. Stored in the service's protected private state, never in the
 * configuration file, and changed only for requests on the authenticated
 * control channel.
 *
 * The remote full-control opt-in (WP-31) is stored together with its grant:
 * the device id and account of the pairing it was given for. It is kept
 * across restarts and applies only while that pairing is in effect
 * (`ControlCenter.remoteProfile`). Every pairing has a new device id
 * (AD-21 point 5), so a grant never carries over to a new pairing. An opt-in
 * recorded before WP-31 has no grant and never applies.
 *
 * Fail closed: if the stored state cannot be read or is malformed (including
 * a malformed grant), the effective settings are the most restrictive ones
 * (preset `require-approval`, remote mode off, opt-in off) and the error is
 * reported.
 */
import { UNTRUSTED_CONTENT_SETTINGS, type UntrustedContentSetting } from "../core/approvals/exposure.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { isDeviceId } from "../identity/device-id.js";
import { isRecord, readStateFile, writeStateFile } from "./private-state.js";
import { isValidRemoteId } from "./remote-clients.js";

export const SERVICE_SETTINGS_FILE_NAME = "service-settings.json";
const FORMAT_VERSION = 1;

/** The pairing a remote full-control opt-in was given for (WP-31). */
export interface FullControlGrant {
  readonly deviceId: string;
  readonly accountId: string;
  readonly grantedAt: string;
}

export interface DeviceSettings {
  /** The preset chosen by the user; absent: the configuration's value applies. */
  readonly preset?: UntrustedContentSetting;
  /** Remote mode (§22): off by default. */
  readonly remoteMode: boolean;
  /** Remote full-control opt-in (AD-13 point 5): off by default. */
  readonly remoteFullControl: boolean;
  /** The pairing the opt-in was given for (WP-31); present only with `remoteFullControl`. */
  readonly remoteFullControlGrant?: FullControlGrant;
}

const DEFAULTS: DeviceSettings = Object.freeze({ remoteMode: false, remoteFullControl: false });
/** Effective settings while the stored state cannot be read. */
const FAIL_CLOSED: DeviceSettings = Object.freeze({
  preset: "require-approval",
  remoteMode: false,
  remoteFullControl: false,
});

function parseGrant(value: unknown): FullControlGrant | undefined {
  if (!isRecord(value)) return undefined;
  const { deviceId, accountId, grantedAt } = value;
  if (!isDeviceId(deviceId) || !isValidRemoteId(accountId) || typeof grantedAt !== "string") return undefined;
  return { deviceId, accountId, grantedAt };
}

function parse(text: string): DeviceSettings | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== FORMAT_VERSION) return undefined;
  if (typeof value.remoteMode !== "boolean" || typeof value.remoteFullControl !== "boolean") return undefined;
  if (value.preset !== undefined) {
    if (typeof value.preset !== "string" || !(UNTRUSTED_CONTENT_SETTINGS as readonly string[]).includes(value.preset))
      return undefined;
  }
  let grant: FullControlGrant | undefined;
  if (value.remoteFullControlGrant !== undefined) {
    grant = parseGrant(value.remoteFullControlGrant);
    // A grant without the opt-in, or one that is not well formed, is malformed state.
    if (!grant || value.remoteFullControl !== true) return undefined;
  }
  return {
    ...(value.preset !== undefined ? { preset: value.preset as UntrustedContentSetting } : {}),
    remoteMode: value.remoteMode,
    remoteFullControl: value.remoteFullControl,
    ...(grant ? { remoteFullControlGrant: grant } : {}),
  };
}

function serialize(settings: DeviceSettings): string {
  const grant = settings.remoteFullControl ? settings.remoteFullControlGrant : undefined;
  return (
    JSON.stringify({
      version: FORMAT_VERSION,
      ...(settings.preset !== undefined ? { preset: settings.preset } : {}),
      remoteMode: settings.remoteMode,
      remoteFullControl: settings.remoteFullControl,
      ...(grant ? { remoteFullControlGrant: grant } : {}),
    }) + "\n"
  );
}

export class DeviceSettingsStore {
  private constructor(
    readonly file: string,
    private readonly privateFiles: PrivateFileProtection,
    private stored: DeviceSettings,
    /** Why the stored state could not be read; undefined when it could. */
    private failure: string | undefined,
  ) {}

  static async open(file: string, privateFiles: PrivateFileProtection): Promise<DeviceSettingsStore> {
    let read;
    try {
      read = await readStateFile(file);
    } catch (error) {
      return new DeviceSettingsStore(file, privateFiles, DEFAULTS, `cannot read ${file}: ${message(error)}`);
    }
    if (read.kind === "missing") return new DeviceSettingsStore(file, privateFiles, DEFAULTS, undefined);
    const parsed = parse(read.text);
    if (!parsed) return new DeviceSettingsStore(file, privateFiles, DEFAULTS, `${file} is malformed`);
    return new DeviceSettingsStore(file, privateFiles, parsed, undefined);
  }

  /** The settings in effect (fail-closed values while the stored state cannot be read). */
  get settings(): DeviceSettings {
    return this.failure !== undefined ? FAIL_CLOSED : this.stored;
  }

  /** Why the stored state could not be read; undefined when it could. */
  get error(): string | undefined {
    return this.failure;
  }

  /**
   * Store a change. The file is written first; the effective settings change
   * only when that succeeded. Writing replaces an unreadable file with the
   * effective (fail-closed) settings plus the change. Turning the opt-in off
   * drops its grant.
   */
  async update(change: Partial<DeviceSettings> & { readonly clearPreset?: boolean }): Promise<DeviceSettings> {
    const { clearPreset, ...rest } = change;
    const { preset, remoteFullControlGrant, ...flags } = { ...this.settings, ...rest };
    const next: DeviceSettings = {
      ...(clearPreset || preset === undefined ? {} : { preset }),
      remoteMode: flags.remoteMode,
      remoteFullControl: flags.remoteFullControl,
      ...(flags.remoteFullControl && remoteFullControlGrant ? { remoteFullControlGrant } : {}),
    };
    await writeStateFile(this.file, serialize(next), this.privateFiles);
    this.stored = next;
    this.failure = undefined;
    return next;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

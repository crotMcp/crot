/**
 * Device settings of the service (ARCHITECTURE.md §27, AD-19 points 5–7):
 * the preset chosen in the tray, remote mode and the remote full-control
 * opt-in. Stored in the service's protected private state, never in the
 * configuration file, and changed only for requests on the authenticated
 * control channel.
 *
 * Fail closed: if the stored state cannot be read or is malformed, the
 * effective settings are the most restrictive ones (preset
 * `require-approval`, remote mode off, opt-in off) and the error is reported.
 */
import { UNTRUSTED_CONTENT_SETTINGS, type UntrustedContentSetting } from "../core/approvals/exposure.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { isRecord, readStateFile, writeStateFile } from "./private-state.js";

export const SERVICE_SETTINGS_FILE_NAME = "service-settings.json";
const FORMAT_VERSION = 1;

export interface DeviceSettings {
  /** The preset chosen by the user; absent: the configuration's value applies. */
  readonly preset?: UntrustedContentSetting;
  /** Remote mode (§22): off by default. */
  readonly remoteMode: boolean;
  /** Remote full-control opt-in (AD-13 point 5): off by default; recorded only until WP-31. */
  readonly remoteFullControl: boolean;
}

const DEFAULTS: DeviceSettings = Object.freeze({ remoteMode: false, remoteFullControl: false });
/** Effective settings while the stored state cannot be read. */
const FAIL_CLOSED: DeviceSettings = Object.freeze({
  preset: "require-approval",
  remoteMode: false,
  remoteFullControl: false,
});

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
  return {
    ...(value.preset !== undefined ? { preset: value.preset as UntrustedContentSetting } : {}),
    remoteMode: value.remoteMode,
    remoteFullControl: value.remoteFullControl,
  };
}

function serialize(settings: DeviceSettings): string {
  return (
    JSON.stringify({
      version: FORMAT_VERSION,
      ...(settings.preset !== undefined ? { preset: settings.preset } : {}),
      remoteMode: settings.remoteMode,
      remoteFullControl: settings.remoteFullControl,
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
   * effective (fail-closed) settings plus the change.
   */
  async update(change: Partial<DeviceSettings> & { readonly clearPreset?: boolean }): Promise<DeviceSettings> {
    const base = this.settings;
    const { clearPreset, ...rest } = change;
    const merged: DeviceSettings = { ...base, ...rest };
    const next: DeviceSettings = clearPreset
      ? { remoteMode: merged.remoteMode, remoteFullControl: merged.remoteFullControl }
      : merged;
    await writeStateFile(this.file, serialize(next), this.privateFiles);
    this.stored = next;
    this.failure = undefined;
    return next;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shared fixtures of the WP-28 identity tests. */
import path from "node:path";
import { generateDeviceId } from "../../src/identity/device-id.js";
import type { IdentityEnvironment } from "../../src/identity/environment.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { DEVICE_BINDING_FILE_NAME, DeviceBindingStore, type DeviceKeyStore } from "../../src/service/device-binding.js";
import type { SecretName } from "../../src/service/secrets/types.js";
import { isWindows } from "../helpers.js";
import { TEST_ISSUER, TEST_RELAY } from "./test-authorization-server.js";

export const privateFiles = createPrivateFileProtection(isWindows);

/** An in-memory secret store for the device key (with switchable failures). */
export class MemoryKeyStore implements DeviceKeyStore {
  readonly values = new Map<SecretName, string>();
  failWrite = false;
  failDelete = false;
  readonly backend = {
    description: "memory test store",
    delete: async (name: "device-key") => {
      if (this.failDelete) throw new Error("keychain locked");
      this.values.delete(name);
    },
  };
  async read(name: SecretName): Promise<string | undefined> {
    return this.values.get(name);
  }
  async write(name: SecretName, value: string): Promise<void> {
    if (this.failWrite) throw new Error("keychain locked");
    this.values.set(name, value);
  }
}

export const testEnvironment = (overrides: Partial<IdentityEnvironment> = {}): IdentityEnvironment => ({
  id: "test",
  kind: "development",
  issuer: TEST_ISSUER,
  relayHost: TEST_RELAY,
  pairing: { clientId: "client_pairing_native", redirectPort: 0, scope: "openid" },
  ...overrides,
});

/** Open a binding store in `dir`, paired to `accountId` (with a new device id) unless `paired: false`. */
export async function openBinding(
  dir: string,
  options: {
    accountId?: string;
    deviceId?: string;
    environment?: IdentityEnvironment;
    paired?: boolean;
    keys?: MemoryKeyStore;
  } = {},
): Promise<{ binding: DeviceBindingStore; keys: MemoryKeyStore; deviceId: string }> {
  const keys = options.keys ?? new MemoryKeyStore();
  const binding = await DeviceBindingStore.open(path.join(dir, DEVICE_BINDING_FILE_NAME), privateFiles, keys);
  const deviceId = options.deviceId ?? generateDeviceId();
  if (options.paired !== false) {
    const env = options.environment ?? testEnvironment();
    await binding.pair(
      {
        deviceId,
        accountId: options.accountId ?? "user_01",
        environment: env.id,
        issuer: env.issuer,
        relayHost: env.relayHost,
      },
      env,
    );
  }
  return { binding, keys, deviceId };
}

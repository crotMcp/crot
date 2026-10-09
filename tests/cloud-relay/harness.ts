/** Shared setup of the Cloud Relay tests (WP-29). */
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { CloudRelay, type CloudRelayOptions } from "../../src/cloud-relay/server.js";
import { MemoryDeviceRegistry } from "../../src/cloud-relay/registry.js";
import type { RelayLogRecord } from "../../src/cloud-relay/log.js";
import { devicePublicKey, type DevicePublicKey } from "../../src/identity/device-credential.js";
import { canonicalDeviceUri, generateDeviceId } from "../../src/identity/device-id.js";
import { IssuerKeySet } from "../../src/identity/jwks.js";
import { PAIRING_CLIENT, TEST_RELAY, TestAuthorizationServer } from "../identity/test-authorization-server.js";
import { TestDevice, type TestDeviceOptions } from "./test-device.js";

export interface PairedDevice {
  readonly deviceId: string;
  readonly accountId: string;
  readonly key: KeyObject;
  readonly publicKey: DevicePublicKey;
  readonly uri: string;
}

export class RelayHarness {
  readonly as = new TestAuthorizationServer();
  readonly registry = new MemoryDeviceRegistry();
  readonly logs: RelayLogRecord[] = [];
  relay!: CloudRelay;
  private readonly devices: TestDevice[] = [];

  async start(options: Partial<CloudRelayOptions> = {}): Promise<this> {
    this.relay = new CloudRelay({
      relayHost: TEST_RELAY,
      issuer: this.as.issuer,
      pairingClientId: PAIRING_CLIENT,
      environment: "test",
      keys: new IssuerKeySet({ issuer: this.as.issuer, http: this.as.http() }),
      registry: this.registry,
      log: (r) => this.logs.push(r),
      ...options,
    });
    await this.relay.listen({ port: 0, host: "127.0.0.1" });
    return this;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.relay.port}`;
  }

  async stop(): Promise<void> {
    for (const d of this.devices.splice(0)) d.ws.terminate();
    await this.relay.close();
  }

  newDevice(accountId = "user_01"): PairedDevice {
    const deviceId = generateDeviceId();
    const { privateKey } = generateKeyPairSync("ed25519");
    return {
      deviceId,
      accountId,
      key: privateKey,
      publicKey: devicePublicKey(privateKey),
      uri: canonicalDeviceUri(TEST_RELAY, deviceId),
    };
  }

  pairingToken(device: PairedDevice, claims: Record<string, unknown> = {}): string {
    return this.as.token({ resource: device.uri, sub: device.accountId, clientId: PAIRING_CLIENT, claims });
  }

  clientToken(device: PairedDevice, claims: Record<string, unknown> = {}): string {
    return this.as.token({ resource: device.uri, sub: device.accountId, claims });
  }

  async registerRaw(
    deviceId: string,
    token: string | undefined,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
    const res = await fetch(`${this.origin}/d/${deviceId}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      headers: res.headers,
    };
  }

  async register(device: PairedDevice): Promise<void> {
    const r = await this.registerRaw(device.deviceId, this.pairingToken(device), { publicKey: device.publicKey });
    if (r.status !== 201) throw new Error(`registration failed: ${r.status}`);
  }

  deviceOptions(device: PairedDevice, extra: Partial<TestDeviceOptions> = {}): TestDeviceOptions {
    return { url: this.origin, deviceId: device.deviceId, key: device.key, relayHost: TEST_RELAY, ...extra };
  }

  async online(device: PairedDevice, extra: Partial<TestDeviceOptions> = {}): Promise<TestDevice> {
    const d = await TestDevice.online(this.deviceOptions(device, extra));
    this.devices.push(d);
    return d;
  }

  async connect(device: PairedDevice, extra: Partial<TestDeviceOptions> = {}): Promise<TestDevice> {
    const d = await TestDevice.connect(this.deviceOptions(device, extra));
    this.devices.push(d);
    return d;
  }

  /** A paired, registered device with its tunnel up. */
  async ready(
    extra: Partial<TestDeviceOptions> = {},
    accountId?: string,
  ): Promise<{ paired: PairedDevice; device: TestDevice }> {
    const paired = this.newDevice(accountId);
    await this.register(paired);
    return { paired, device: await this.online(paired, extra) };
  }

  url(device: PairedDevice, suffix = "/mcp"): string {
    return `${this.origin}/d/${device.deviceId}${suffix}`;
  }

  /** POST a JSON-RPC body with the device's client token. */
  post(
    device: PairedDevice,
    body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    headers: Record<string, string> = {},
  ) {
    return fetch(this.url(device), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.clientToken(device)}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-method": "tools/list",
        ...headers,
      },
      body,
    });
  }

  /** A raw request whose response is not read automatically. */
  raw(
    device: PairedDevice,
    options: { method?: string; headers?: Record<string, string>; body?: Buffer | string; chunked?: boolean } = {},
  ): Promise<{ res: IncomingMessage; destroy: () => void }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(this.url(device), {
        method: options.method ?? "POST",
        headers: { authorization: `Bearer ${this.clientToken(device)}`, ...options.headers },
      });
      req.on("response", (res) => resolve({ res, destroy: () => req.destroy() }));
      req.on("error", reject);
      if (options.body !== undefined) {
        if (options.chunked) req.setHeader("transfer-encoding", "chunked");
        req.write(options.body);
      }
      req.end();
    });
  }

  logText(): string {
    return JSON.stringify(this.logs);
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

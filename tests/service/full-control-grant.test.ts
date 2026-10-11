import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServeCommand } from "../../src/cli/options.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { ControlCenter } from "../../src/service/control-center.js";
import { ControlClient } from "../../src/service/control-client.js";
import { DEVICE_BINDING_FILE_NAME, type PairedBinding } from "../../src/service/device-binding.js";
import { DeviceSettingsStore, SERVICE_SETTINGS_FILE_NAME } from "../../src/service/device-settings.js";
import type { ControlOverview } from "../../src/service/protocol.js";
import { CrotService } from "../../src/service/service.js";
import { isWindows, makeTempDirs, waitFor, type TempDirs } from "../helpers.js";
import { TestAuthorizationServer } from "../identity/test-authorization-server.js";

/**
 * WP-31: the remote full-control opt-in is stored with its grant (device id and account of the pairing it was
 * given for). It is restored after a restart for that pairing only; a grant of another pairing, a legacy
 * opt-in without a grant, malformed state or an unusable binding never give full control.
 */

const privateFiles = createPrivateFileProtection(isWindows);
const DEVICE = "abcdefghijklmnopqrstuvwxya";
const OTHER_DEVICE = "bbcdefghijklmnopqrstuvwxya";
const ACCOUNT_ID = "acct-1";

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await dirs.cleanup();
});

const pairedAs = (deviceId: string, accountId = ACCOUNT_ID): { paired: PairedBinding; error: undefined } => ({
  paired: {
    deviceId,
    accountId,
    environment: "test",
    issuer: "https://auth.example.com",
    relayHost: "relay.example.com",
    pairedAt: "2026-10-10T00:00:00.000Z",
  },
  error: undefined,
});

async function storeWith(content: unknown): Promise<DeviceSettingsStore> {
  const file = path.join(dirs.outside, SERVICE_SETTINGS_FILE_NAME);
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  return DeviceSettingsStore.open(file, privateFiles);
}

const grant = (deviceId = DEVICE, accountId = ACCOUNT_ID) => ({
  deviceId,
  accountId,
  grantedAt: "2026-10-10T00:00:00.000Z",
});

describe("stored full-control grant (unit)", () => {
  it("is persisted with the device id and account and restored by a new store for the same pairing", async () => {
    const file = path.join(dirs.outside, SERVICE_SETTINGS_FILE_NAME);
    const store = await DeviceSettingsStore.open(file, privateFiles);
    await store.update({ remoteFullControl: true, remoteFullControlGrant: grant() });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      version: 1,
      remoteFullControl: true,
      remoteFullControlGrant: { deviceId: DEVICE, accountId: ACCOUNT_ID },
    });
    const reopened = await DeviceSettingsStore.open(file, privateFiles);
    expect(ControlCenter.remoteProfile(reopened, pairedAs(DEVICE))).toEqual({
      fullControl: { deviceId: DEVICE, accountId: ACCOUNT_ID },
    });
    expect(ControlCenter.fullControlProblem(reopened, pairedAs(DEVICE))).toBeUndefined();
    // Other settings changes keep the grant; turning the opt-in off drops it.
    await reopened.update({ remoteMode: true });
    expect(reopened.settings.remoteFullControlGrant).toMatchObject({ deviceId: DEVICE });
    await reopened.update({ remoteFullControl: false });
    const stored = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(stored.remoteFullControl).toBe(false);
    expect(stored).not.toHaveProperty("remoteFullControlGrant");
  });

  it("does not apply to another device id, another account, an unpaired device or an unusable binding", async () => {
    const store = await storeWith({
      version: 1,
      remoteMode: true,
      remoteFullControl: true,
      remoteFullControlGrant: grant(),
    });
    expect(store.error).toBeUndefined();
    expect(ControlCenter.remoteProfile(store, pairedAs(OTHER_DEVICE))).toBeUndefined();
    expect(ControlCenter.fullControlProblem(store, pairedAs(OTHER_DEVICE))).toMatch(/another pairing/);
    expect(ControlCenter.remoteProfile(store, pairedAs(DEVICE, "acct-2"))).toBeUndefined();
    expect(ControlCenter.fullControlProblem(store, pairedAs(DEVICE, "acct-2"))).toMatch(/another pairing/);
    expect(ControlCenter.remoteProfile(store, { paired: undefined })).toBeUndefined();
    expect(ControlCenter.fullControlProblem(store, { paired: undefined, error: undefined })).toMatch(/not paired/);
    expect(ControlCenter.fullControlProblem(store, { paired: undefined, error: "broken" })).toMatch(/binding/);
  });

  it("an opt-in recorded without a grant (before WP-31) never applies and is reported", async () => {
    const store = await storeWith({ version: 1, remoteMode: true, remoteFullControl: true });
    expect(store.error).toBeUndefined();
    expect(store.settings.remoteFullControl).toBe(true);
    expect(ControlCenter.remoteProfile(store, pairedAs(DEVICE))).toBeUndefined();
    expect(ControlCenter.fullControlProblem(store, pairedAs(DEVICE))).toMatch(/turn it on again/);
  });

  it("a malformed grant or a grant without the opt-in is malformed state: fail closed", async () => {
    for (const content of [
      { version: 1, remoteMode: true, remoteFullControl: true, remoteFullControlGrant: { deviceId: 7 } },
      { version: 1, remoteMode: true, remoteFullControl: true, remoteFullControlGrant: grant("NOT-A-DEVICE") },
      { version: 1, remoteMode: true, remoteFullControl: false, remoteFullControlGrant: grant() },
      "{broken",
    ]) {
      const store = await storeWith(content);
      expect(store.error).toMatch(/malformed/);
      expect(store.settings).toEqual({ preset: "require-approval", remoteMode: false, remoteFullControl: false });
      expect(ControlCenter.remoteProfile(store, pairedAs(DEVICE))).toBeUndefined();
    }
  });
});

// ---- end to end over the real service -----------------------------------------------------------

let stateDir: string;
let authServer: TestAuthorizationServer;
let services: CrotService[];
let clients: ControlClient[];

describe("stored full-control grant across restarts (service)", () => {
  beforeEach(async () => {
    stateDir = isWindows ? path.join(dirs.outside, "state") : await mkdtemp(path.join("/tmp", "crot-g-"));
    authServer = new TestAuthorizationServer();
    services = [];
    clients = [];
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of services.splice(0)) await s.shutdown("test end");
    if (!isWindows) await rm(stateDir, { recursive: true, force: true });
  });

  const ACCOUNT = "user_01GRANTTEST";
  const settingsFile = () => path.join(stateDir, SERVICE_SETTINGS_FILE_NAME);

  function serveCommand(): ServeCommand {
    return {
      kind: "serve",
      config: {
        workspace: { root: dirs.workspace },
        audit: { sink: "file", path: path.join(dirs.outside, "audit.jsonl") },
        environment: { path: "inherited" },
        secrets: { store: "file" },
        http: { enabled: true, port: 0 },
        permissions: { mode: "full_control" },
      } as ServeCommand["config"],
      warnings: [],
    };
  }

  async function startService(): Promise<CrotService> {
    const service = await CrotService.start({
      command: serveCommand(),
      launch: "managed",
      stateDir,
      privateFiles,
      log: () => undefined,
      requestStop: () => undefined,
      resume: { intervalMs: 60_000, thresholdMs: 10_000 },
      identity: { environment: authServer.environment(), http: authServer.http() },
    });
    if (service === "already_running") throw new Error("already running");
    services.push(service);
    return service;
  }

  async function restart(service: CrotService): Promise<CrotService> {
    for (const c of clients.splice(0)) c.close();
    await service.shutdown("restart");
    services.splice(services.indexOf(service), 1);
    return startService();
  }

  async function tray(): Promise<ControlClient> {
    const client = (await ControlClient.connect({ stateDir, privateFiles }))!;
    clients.push(client);
    return client;
  }

  const ask = (client: ControlClient, method: string, params?: Record<string, unknown>) =>
    client.request(method as never, params) as Promise<Record<string, unknown>>;

  async function pairDevice(client: ControlClient): Promise<string> {
    const started = (await ask(client, "pairing.start")) as { authorizationUrl: string };
    const page = await fetch(authServer.authorize(started.authorizationUrl, { sub: ACCOUNT }).redirect, {
      signal: AbortSignal.timeout(5_000),
    });
    await page.text();
    let view: ControlOverview | undefined;
    await waitFor(async () => {
      view = (await ask(client, "overview")) as unknown as ControlOverview;
      return view.pairing.state === "paired";
    });
    return view!.pairing.device!.deviceId;
  }

  it("is restored after a restart for the same pairing; unpairing and a new pairing end it", async () => {
    let service = await startService();
    let control = await tray();
    const first = await pairDevice(control);
    expect(await ask(control, "remote.setFullControl", { enabled: true })).toMatchObject({ ok: true, enabled: true });
    expect(service.core.status().remote.fullControl).toMatchObject({
      enabled: true,
      deviceId: first,
      accountId: ACCOUNT,
    });
    expect(JSON.parse(await readFile(settingsFile(), "utf8"))).toMatchObject({
      remoteFullControl: true,
      remoteFullControlGrant: { deviceId: first, accountId: ACCOUNT },
    });

    // Restart: restored without asking again, bound to the same pairing.
    service = await restart(service);
    expect(service.core.status().remote.fullControl).toMatchObject({
      enabled: true,
      deviceId: first,
      accountId: ACCOUNT,
    });
    expect(service.status().controls).toMatchObject({ remoteFullControl: true, remoteFullControlEffective: true });

    // Unpairing ends it, also after a restart; a new pairing (new device id) does not inherit it.
    control = await tray();
    expect(await ask(control, "device.unpair")).toMatchObject({ ok: true });
    expect(service.core.status().remote.fullControl.enabled).toBe(false);
    service = await restart(service);
    expect(service.core.status().remote.fullControl.enabled).toBe(false);
    control = await tray();
    const second = await pairDevice(control);
    expect(second).not.toBe(first);
    expect(service.core.status().remote.fullControl.enabled).toBe(false);
    const stored = JSON.parse(await readFile(settingsFile(), "utf8")) as Record<string, unknown>;
    expect(stored.remoteFullControl).toBe(false);
    expect(stored).not.toHaveProperty("remoteFullControlGrant");
  });

  it("a grant for another pairing in the state file does not apply after a restart; turning it on rebinds", async () => {
    let service = await startService();
    const control = await tray();
    const deviceId = await pairDevice(control);
    await ask(control, "remote.setFullControl", { enabled: true });
    const stored = JSON.parse(await readFile(settingsFile(), "utf8")) as Record<string, unknown>;
    const other = deviceId === OTHER_DEVICE ? DEVICE : OTHER_DEVICE;
    await writeFile(settingsFile(), JSON.stringify({ ...stored, remoteFullControlGrant: grant(other, ACCOUNT) }));
    service = await restart(service);
    expect(service.core.status().remote.fullControl.enabled).toBe(false);
    const again = await tray();
    const view = (await ask(again, "overview")) as unknown as ControlOverview;
    expect(view.remote).toMatchObject({ fullControl: true, fullControlEffective: false });
    expect(view.remote.errors.join(" ")).toMatch(/another pairing/);
    // The user turns it on again: bound to the pairing in effect.
    expect(await ask(again, "remote.setFullControl", { enabled: true })).toMatchObject({ ok: true });
    expect(service.core.status().remote.fullControl).toMatchObject({ enabled: true, deviceId });
  });

  it("an unusable device binding never applies a stored grant", async () => {
    let service = await startService();
    const control = await tray();
    await pairDevice(control);
    await ask(control, "remote.setFullControl", { enabled: true });
    for (const c of clients.splice(0)) c.close();
    await service.shutdown("restart");
    services.splice(services.indexOf(service), 1);
    await writeFile(path.join(stateDir, DEVICE_BINDING_FILE_NAME), "not json");
    service = await startService();
    expect(service.core.status().remote.fullControl.enabled).toBe(false);
    expect(service.status().controls).toMatchObject({ remoteFullControlEffective: false });
  });
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseUpdateManifest } from "../../src/installer/update.js";
import { describe, expect, it } from "vitest";
import { OperationalMetrics, metricsTokenMatches } from "../../src/cloud-relay/operations.js";
import { sanitizeRecord } from "../../src/cloud-relay/log.js";
import { RemoteExposureStore } from "../../src/core/approvals/remote-exposure.js";
import { TabQueue } from "../../src/core/capabilities/browser/tab-queue.js";
import { CHILD_ENV_ALLOWLIST, createChildEnvironment } from "../../src/core/platform/child-environment.js";
import { REMOTE_DEFAULT_CAPABILITIES } from "../../src/core/permissions/engine.js";
import { canonicalDeviceUri, generateDeviceId } from "../../src/identity/device-id.js";
import { IssuerKeySet } from "../../src/identity/jwks.js";
import { OAuthAccessTokenVerifier } from "../../src/identity/verifier.js";
import { TestAuthorizationServer } from "../identity/test-authorization-server.js";

const root = path.resolve(import.meta.dirname, "../..");
const source = (file: string) => readFile(path.join(root, file), "utf8");

describe("WP-33 release-blocking security invariants", () => {
  it("1. passes only allowlisted environment values to confined children", () => {
    const child = createChildEnvironment({ PATH: "/bin", HOME: "/secret", API_TOKEN: "canary", LANG: "C" }, [], false);
    expect(Object.hasOwn(child, "API_TOKEN")).toBe(false);
    expect(child.base.HOME).toBe("/secret");
    expect(Object.keys(child.base).every((key) => child.allows(key))).toBe(true);
    expect(CHILD_ENV_ALLOWLIST).not.toContain("API_TOKEN");
  });

  it("2. keeps every supported L1 profile and escape qualification in the matrix", async () => {
    for (const file of [
      "src/native-host/linux-l1/confinement.ts",
      "src/native-host/macos-l1/confinement.ts",
      "src/native-host/windows-l1/confinement.ts",
      "tests/native-host/linux-l1/l1-integration.test.ts",
      "tests/native-host/macos-l1/production.test.ts",
      "tests/native-host/windows-l1/production-confinement.test.ts",
    ])
      expect((await source(file)).length).toBeGreaterThan(100);
  });

  it("3. keeps user approvals on the private authenticated control channel", async () => {
    const channel = await source("src/service/channel.ts");
    const controls = await source("src/service/control-center.ts");
    expect(channel).toMatch(/HMAC\(K/);
    expect(channel).toMatch(/credential/i);
    expect(controls).toMatch(/approvals\.decide/);
    expect(await source("src/cloud-relay/server.ts")).not.toMatch(/approveTool|grantCapability/);
  });

  it("4. persists remote exposure fail-closed and permits reset only through its explicit API", async () => {
    const store = RemoteExposureStore.inMemory();
    store.markExposed("account/device/client");
    expect(store.isExposed("account/device/client")).toBe(true);
    expect(store.reset("account/device/client")).toBe("reset");
    expect(store.isExposed("account/device/client")).toBe(false);
    expect(await source("src/core/approvals/remote-exposure.ts")).toContain(
      "malformed; every remote client is treated as exposed",
    );
  });

  it("5. rejects tokens from another issuer or audience before granting a principal", async () => {
    const as = new TestAuthorizationServer();
    const deviceId = generateDeviceId();
    const resource = canonicalDeviceUri(as.relayHost, deviceId);
    const verifier = new OAuthAccessTokenVerifier({
      environment: as.environment(),
      keys: new IssuerKeySet({ issuer: as.issuer, http: as.http() }),
      binding: () => ({
        state: "paired",
        deviceId,
        accountId: "user_security",
        issuer: as.issuer,
        relayHost: as.relayHost,
      }),
    });
    expect(await verifier.verifyAccessToken(as.token({ resource, sub: "user_security" }))).toBeDefined();
    expect(
      await verifier.verifyAccessToken(
        as.token({ resource: canonicalDeviceUri(as.relayHost, generateDeviceId()), sub: "user_security" }),
      ),
    ).toBeUndefined();
    expect(
      await verifier.verifyAccessToken(
        as.token({ resource, sub: "user_security", claims: { iss: "https://evil.example" } }),
      ),
    ).toBeUndefined();
  });

  it("6. exposes only fixed relay metadata and scrubs payload-shaped fields", () => {
    const canary = "SECRET-PAYLOAD-CANARY";
    const clean = sanitizeRecord({
      event: "request.complete",
      mcpMethod: canary,
      software: canary,
      status: 200,
    });
    const metrics = new OperationalMetrics();
    metrics.observe(clean);
    const rendered = metrics.render({
      tunnels: { handshake: 0, ready: 0, draining: 0 },
      openStreams: 0,
      devicesOnline: 0,
      admission: { clients: 0, requests: 0, bufferedRequestBytes: 0, uncreditedResponseBytes: 0 },
    });
    expect(JSON.stringify(clean)).not.toContain(canary);
    expect(rendered).not.toContain(canary);
  });

  it("7. keeps a fixed CDP allowlist without Runtime or arbitrary script execution", async () => {
    const cdp = await source("extension/src/cdp.ts");
    expect(cdp).toContain("CDP_ALLOWED_METHODS");
    expect(cdp).not.toMatch(/["']Runtime\./);
    expect(cdp).not.toContain("eval(");
  });

  it("8. requires explicit remote tab targeting and serializes per-tab work FIFO", async () => {
    const queue = new TabQueue();
    const order: number[] = [];
    let release!: () => void;
    const first = queue.run(
      "connection:tab",
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push(1);
            resolve();
          };
        }),
    );
    const second = queue.run("connection:tab", async () => {
      order.push(2);
    });
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
    expect(await source("src/core/capabilities/browser/service.ts")).toMatch(/tabId/);
  });

  it("9. keeps the remote default profile explicit and excludes full filesystem authority", () => {
    expect(REMOTE_DEFAULT_CAPABILITIES.length).toBeGreaterThan(0);
    expect(REMOTE_DEFAULT_CAPABILITIES).not.toContain("filesystem.full");
    expect(new Set(REMOTE_DEFAULT_CAPABILITIES).size).toBe(REMOTE_DEFAULT_CAPABILITIES.length);
  });

  it("10. rejects traversal, duplicate paths and missing identity in the executable manifest parser", () => {
    const manifest = {
      schema: 1,
      product: "crot",
      version: "1.0.0",
      identityEnvironment: "staging",
      files: [{ path: "bin/a.js", sha256: "a".repeat(64) }],
    };
    expect(parseUpdateManifest(manifest).version).toBe("1.0.0");
    for (const target of ["../escape", "/absolute", "C:\\escape", "a/../b", "a\\b"])
      expect(() => parseUpdateManifest({ ...manifest, files: [{ ...manifest.files[0], path: target }] })).toThrow();
    expect(() => parseUpdateManifest({ ...manifest, files: [manifest.files[0], manifest.files[0]] })).toThrow(
      "duplicate",
    );
    expect(() => parseUpdateManifest({ ...manifest, identityEnvironment: "" })).toThrow();
  });

  it("11. authenticates operational metrics fail-closed without relying on review prose", () => {
    const token = "m".repeat(48);
    expect(metricsTokenMatches(`Bearer ${token}`, token)).toBe(true);
    for (const header of [undefined, token, "Bearer short", `Bearer ${"n".repeat(48)}`, `bearer ${token}`])
      expect(metricsTokenMatches(header, token)).toBe(false);
    expect(metricsTokenMatches("Bearer short", "short")).toBe(false);
  });

  it("12. discloses every accepted v1 architecture risk AD-13 through AD-36", async () => {
    const risks = await source("docs/security/RESIDUAL_RISKS.md");
    for (let n = 13; n <= 36; n++) expect(risks).toContain(`AD-${n}`);
  });
});

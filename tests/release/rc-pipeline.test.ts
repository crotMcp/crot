import { execFile } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("WP-40 repository RC pipeline", () => {
  it("assembles pinned desktop, extension, SBOM and checksums into one manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "crot-rc-"));
    roots.push(root);
    const identity = path.join(root, "identity.json");
    const out = path.join(root, "rc");
    const keyFile = path.join(root, "update-key.pem");
    const keys = generateKeyPairSync("ed25519");
    await writeFile(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
    await writeFile(
      identity,
      JSON.stringify({
        id: "staging",
        issuer: "https://prestigious-continent-62-staging.authkit.app",
        relayHost: "relay-staging.crot.network",
        pairingClientId: "client_01M5FJB95CE7KH33Y1SPE5X77Q",
        pairingRedirectPort: 0,
        pairingScope: "openid",
      }),
    );
    await exec(
      process.execPath,
      [
        "scripts/build-rc.mjs",
        "--repository-test",
        "--skip-check",
        "--skip-e2e",
        "--environment",
        identity,
        "--out",
        out,
      ],
      { timeout: 120_000, env: { ...process.env, CROT_UPDATE_SIGNING_KEY: keyFile } },
    );
    const manifestBytes = await readFile(path.join(out, "rc-manifest.json"));
    const signature = Buffer.from((await readFile(path.join(out, "rc-manifest.sig"), "utf8")).trim(), "base64");
    expect(verify(null, manifestBytes, keys.publicKey, signature)).toBe(true);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    expect(manifest.identity).toMatchObject({
      issuer: "https://prestigious-continent-62-staging.authkit.app",
      relayHost: "relay-staging.crot.network",
    });
    expect(manifest.files.some((f: { path: string }) => f.path === "desktop/sbom.cdx.json")).toBe(true);
    expect(manifest.files.some((f: { path: string }) => f.path.endsWith(".zip"))).toBe(true);
    expect(manifest.readinessCriteria.liveCloudDrills).toBe("operator_required");
    expect(manifest.operatorGates.beta).toBe("required");
  }, 120_000);
});

import { execFile } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { verifyUpdatePackage } from "../../src/installer/update.js";
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
    expect(manifest.repositoryTest).toBe(true);
    expect(manifest.channel).toBe("repository-test");
    expect(manifest.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.treeSha).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.readinessCriteria.securityReview).toBe("not_qualified_test_artifact");
    const update = await verifyUpdatePackage(path.join(out, "update"), keys.publicKey);
    expect(update.files.some((f) => f.path === "native/vendor/detours/LICENSE.md")).toBe(true);
    expect(manifest.identity).toMatchObject({
      issuer: "https://prestigious-continent-62-staging.authkit.app",
      relayHost: "relay-staging.crot.network",
    });
    expect(manifest.files.some((f: { path: string }) => f.path === "desktop/sbom.cdx.json")).toBe(true);
    expect(manifest.files.some((f: { path: string }) => f.path.endsWith(".zip"))).toBe(true);
    expect(manifest.readinessCriteria.liveCloudDrills).toBe("operator_required");
    expect(manifest.operatorGates.beta).toBe("required");
  }, 120_000);
  it.each([".", "..", "src", "docs", "tests", ".git"])(
    "rejects unsafe disposable-repository output %s",
    async (relative) => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "crot-path-"));
      roots.push(temp);
      const root = path.join(temp, "repo");
      await mkdir(root);
      await writeFile(path.join(root, "sentinel"), "preserved");
      const output = path.resolve(root, relative);
      const moduleUrl = pathToFileURL(path.resolve("scripts/output-path.mjs")).href;
      // Only call validation, never recursive rm; even a failing regression cannot delete the checkout.
      await expect(
        exec(process.execPath, [
          "--input-type=module",
          "-e",
          `const { validateOutput } = await import(${JSON.stringify(moduleUrl)}); await validateOutput(${JSON.stringify(root)}, ${JSON.stringify(output)});`,
        ]),
      ).rejects.toThrow("unsafe output directory");
      expect(await readFile(path.join(root, "sentinel"), "utf8")).toBe("preserved");
    },
  );
  it.skipIf(process.platform === "win32")("rejects a symlink output without touching its target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "crot-output-"));
    roots.push(root);
    const link = path.join(root, "linked");
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "sentinel"), "preserved");
    await symlink(target, link, "dir");
    await expect(exec(process.execPath, ["scripts/build-rc.mjs", "--out", path.join(link, "rc")])).rejects.toThrow(
      "unsafe output symlink",
    );
    expect(await readFile(path.join(target, "sentinel"), "utf8")).toBe("preserved");
  });
});

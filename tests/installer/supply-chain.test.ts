import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
describe("WP-34 release supply chain", () => {
  it("requires pinned N3 identity and emits SBOM, checksums and notices", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "crot-release-"));
    roots.push(root);
    const env = path.join(root, "identity.json");
    const out = path.join(root, "out");
    await writeFile(
      env,
      JSON.stringify({
        id: "staging",
        issuer: "https://prestigious-continent-62-staging.authkit.app",
        relayHost: "relay-staging.crot.network",
        pairingClientId: "client_01",
        pairingRedirectPort: 0,
        pairingScope: "openid",
      }),
    );
    await exec(process.execPath, ["scripts/build-release.mjs", "--out", out], {
      env: { ...process.env, RELEASE_IDENTITY_ENVIRONMENT: env },
    });
    const identity = JSON.parse(await readFile(path.join(out, "release-identity.json"), "utf8"));
    expect(identity.issuer).toBe("https://prestigious-continent-62-staging.authkit.app");
    expect(identity.relayHost).toBe("relay-staging.crot.network");
    const sbom = JSON.parse(await readFile(path.join(out, "sbom.cdx.json"), "utf8"));
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.components.length).toBeGreaterThan(0);
    expect(await readFile(path.join(out, "SHA256SUMS"), "utf8")).toContain("release-identity.json");
    expect(await readFile(path.join(out, "THIRD_PARTY_NOTICES.md"), "utf8")).toContain("Third-Party Notices");
  }, 120000);
});

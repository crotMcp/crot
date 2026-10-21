import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { backupRelayState, restoreRelayState } from "../../src/cloud-relay/operations.js";
it("restores original bytes after the second rename fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crot-restore-"));
  try {
    const registryFile = path.join(root, "registry.json"),
      accountFile = path.join(root, "accounts.json"),
      backupDir = path.join(root, "backup");
    await writeFile(registryFile, JSON.stringify({ version: 1, devices: [] }));
    await writeFile(accountFile, JSON.stringify({ version: 1, accounts: [], events: [] }));
    await backupRelayState({ registryFile, accountFile, outputDir: backupDir });
    await writeFile(registryFile, "previous registry bytes");
    await writeFile(accountFile, "previous account bytes");
    let calls = 0;
    await expect(
      restoreRelayState({
        backupDir,
        registryFile,
        accountFile,
        replace: async (from, to) => {
          if (++calls === 2) throw new Error("second rename failed");
          await rename(from, to);
        },
      }),
    ).rejects.toThrow("second rename failed");
    expect(await readFile(registryFile, "utf8")).toBe("previous registry bytes");
    expect(await readFile(accountFile, "utf8")).toBe("previous account bytes");
    const invalid = JSON.stringify({ version: 99, accounts: [], events: [] });
    await writeFile(path.join(backupDir, "accounts.json"), invalid);
    const manifest = JSON.parse(await readFile(path.join(backupDir, "manifest.json"), "utf8"));
    const entry = manifest.files.find((f: { name: string }) => f.name === "accounts");
    entry.bytes = Buffer.byteLength(invalid);
    entry.sha256 = createHash("sha256").update(invalid).digest("hex");
    await writeFile(path.join(backupDir, "manifest.json"), JSON.stringify(manifest));
    await expect(restoreRelayState({ backupDir, registryFile, accountFile })).rejects.toThrow(
      "invalid commercial metadata",
    );
    expect(await readFile(registryFile, "utf8")).toBe("previous registry bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["version", "ownership", "duplicate"])(
  "rejects invalid registry %s before touching either target",
  async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "crot-restore-schema-"));
    try {
      const { generateDeviceId } = await import("../../src/identity/device-id.js");
      const registryFile = path.join(root, "registry.json"),
        accountFile = path.join(root, "accounts.json"),
        backupDir = path.join(root, "backup");
      const record = {
        deviceId: generateDeviceId(),
        accountId: "owner",
        publicKey: { kty: "OKP", crv: "Ed25519", x: Buffer.alloc(32, 7).toString("base64url") },
        environment: "staging",
        registeredAt: new Date(0).toISOString(),
      };
      await writeFile(
        registryFile,
        JSON.stringify({
          version: kind === "version" ? 99 : 1,
          devices: kind === "duplicate" ? [record, record] : [record],
        }),
      );
      await writeFile(
        accountFile,
        JSON.stringify({
          version: 1,
          accounts:
            kind === "duplicate"
              ? [
                  {
                    accountId: "owner",
                    plan: "free",
                    status: "active",
                    trialUsed: false,
                    devices: [{ deviceId: record.deviceId, registeredAt: 0, revoked: false, clients: [] }],
                  },
                ]
              : [],
          events: [],
        }),
      );
      await backupRelayState({ registryFile, accountFile, outputDir: backupDir });
      await writeFile(registryFile, "old registry");
      await writeFile(accountFile, "old accounts");
      await expect(restoreRelayState({ backupDir, registryFile, accountFile })).rejects.toThrow();
      expect(await readFile(registryFile, "utf8")).toBe("old registry");
      expect(await readFile(accountFile, "utf8")).toBe("old accounts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("reports incomplete rollback and retains original-byte recovery files if rollback rename fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crot-restore-recovery-"));
  try {
    const registryFile = path.join(root, "registry.json"),
      accountFile = path.join(root, "accounts.json"),
      backupDir = path.join(root, "backup");
    await writeFile(registryFile, JSON.stringify({ version: 1, devices: [] }));
    await writeFile(accountFile, JSON.stringify({ version: 1, accounts: [], events: [] }));
    await backupRelayState({ registryFile, accountFile, outputDir: backupDir });
    await writeFile(registryFile, "original registry");
    await writeFile(accountFile, "original accounts");
    let calls = 0;
    await expect(
      restoreRelayState({
        backupDir,
        registryFile,
        accountFile,
        replace: async (a, b) => {
          if (++calls >= 2) throw new Error("disk failure");
          await rename(a, b);
        },
      }),
    ).rejects.toThrow("rollback incomplete");
    const recovery = (await readdir(root)).find((n) => n.startsWith("registry.json.restore-"));
    expect(recovery).toBeDefined();
    expect(await readFile(path.join(root, recovery!), "utf8")).toBe("original registry");
    expect(await readFile(accountFile, "utf8")).toBe("original accounts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

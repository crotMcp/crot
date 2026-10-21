import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
const fault = vi.hoisted(() => ({ corrupt: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    cp: async (...args: Parameters<typeof fs.cp>) => {
      await fs.cp(...args);
      if (fault.corrupt) await fs.writeFile(args[1], "raced bytes");
    },
  };
});
import { applyUpdate, updateManifestBytes, type UpdateManifest } from "../../src/installer/update.js";
it("rehashes copied bytes and rejects a copy-time substitution before activation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crot-race-"));
  try {
    const keys = generateKeyPairSync("ed25519");
    const pack = path.join(root, "package");
    await mkdir(path.join(pack, "payload"), { recursive: true });
    await writeFile(path.join(pack, "payload/a.js"), "trusted");
    const manifest: UpdateManifest = {
      schema: 1,
      product: "crot",
      version: "1.0.0",
      identityEnvironment: "staging",
      files: [{ path: "a.js", sha256: createHash("sha256").update("trusted").digest("hex") }],
    };
    await writeFile(path.join(pack, "update-manifest.json"), JSON.stringify(manifest));
    await writeFile(
      path.join(pack, "update-manifest.sig"),
      sign(null, updateManifestBytes(manifest), keys.privateKey).toString("base64"),
    );
    const register = vi.fn();
    fault.corrupt = true;
    await expect(
      applyUpdate(
        pack,
        keys.publicKey,
        { installRoot: path.join(root, "install"), stateRoot: path.join(root, "state") },
        { register, unregister: vi.fn(), healthCheck: async () => true },
      ),
    ).rejects.toThrow("staged update hash mismatch");
    expect(register).not.toHaveBeenCalled();
    await expect(readFile(path.join(root, "install/current"))).rejects.toThrow();
  } finally {
    fault.corrupt = false;
    await rm(root, { recursive: true, force: true });
  }
});

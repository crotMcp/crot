import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyUpdate,
  installedVersion,
  uninstall,
  updateManifestBytes,
  verifyUpdatePackage,
  type InstallHooks,
  type UpdateManifest,
} from "../../src/installer/update.js";
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
async function root() {
  const r = await mkdtemp(path.join(os.tmpdir(), "crot-update-"));
  roots.push(r);
  return r;
}
async function pack(
  base: string,
  version: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  content = version,
) {
  const dir = path.join(base, `package-${version}`);
  await mkdir(path.join(dir, "payload", "bin"), { recursive: true });
  await writeFile(path.join(dir, "payload/bin/crot-mcp"), content);
  const manifest: UpdateManifest = {
    schema: 1,
    product: "crot",
    version,
    identityEnvironment: "staging",
    files: [{ path: "bin/crot-mcp", sha256: createHash("sha256").update(content).digest("hex") }],
  };
  await writeFile(path.join(dir, "update-manifest.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(dir, "update-manifest.sig"),
    sign(null, updateManifestBytes(manifest), privateKey).toString("base64") + "\n",
  );
  return dir;
}

describe("WP-34 signed update lifecycle", () => {
  it("fresh-installs, upgrades without touching user state, and cleanly uninstalls", async () => {
    const base = await root();
    const keys = generateKeyPairSync("ed25519");
    const layout = { installRoot: path.join(base, "install"), stateRoot: path.join(base, "state") };
    await mkdir(layout.stateRoot);
    await writeFile(path.join(layout.stateRoot, "config.json"), "config");
    await writeFile(path.join(layout.stateRoot, "device-binding"), "binding");
    await writeFile(path.join(layout.stateRoot, "remote-exposure.json"), "exposure");
    const calls: string[] = [];
    const hooks: InstallHooks = {
      register: async (d) => {
        calls.push(`register:${path.basename(d)}`);
      },
      unregister: async () => {
        calls.push("unregister");
      },
      healthCheck: async () => true,
    };
    await applyUpdate(await pack(base, "1.0.0", keys.privateKey), keys.publicKey, layout, hooks);
    await applyUpdate(await pack(base, "1.1.0", keys.privateKey), keys.publicKey, layout, hooks);
    expect(await installedVersion(layout)).toBe("1.1.0");
    expect(await readFile(path.join(layout.stateRoot, "config.json"), "utf8")).toBe("config");
    expect(await readFile(path.join(layout.stateRoot, "device-binding"), "utf8")).toBe("binding");
    expect(await readFile(path.join(layout.stateRoot, "remote-exposure.json"), "utf8")).toBe("exposure");
    await uninstall(layout, hooks);
    expect(await installedVersion(layout)).toBeUndefined();
    expect(await readFile(path.join(layout.stateRoot, "config.json"), "utf8")).toBe("config");
    expect(calls).toContain("unregister");
  });
  it("rejects a tampered payload and a forged signature before changing current", async () => {
    const base = await root();
    const keys = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    const layout = { installRoot: path.join(base, "install"), stateRoot: path.join(base, "state") };
    const hooks: InstallHooks = { register: async () => {}, unregister: async () => {}, healthCheck: async () => true };
    await applyUpdate(await pack(base, "1.0.0", keys.privateKey), keys.publicKey, layout, hooks);
    const tampered = await pack(base, "1.1.0", keys.privateKey);
    await writeFile(path.join(tampered, "payload/bin/crot-mcp"), "tampered");
    await expect(applyUpdate(tampered, keys.publicKey, layout, hooks)).rejects.toThrow("hash mismatch");
    expect(await installedVersion(layout)).toBe("1.0.0");
    const forged = await pack(base, "1.2.0", attacker.privateKey);
    await expect(verifyUpdatePackage(forged, keys.publicKey)).rejects.toThrow("signature verification failed");
  });
  it("rolls back automatically when the new service fails its health check", async () => {
    const base = await root();
    const keys = generateKeyPairSync("ed25519");
    const layout = { installRoot: path.join(base, "install"), stateRoot: path.join(base, "state") };
    let healthy = true;
    const registrations: string[] = [];
    const hooks: InstallHooks = {
      register: async (d) => {
        registrations.push(path.basename(d));
      },
      unregister: async () => {},
      healthCheck: async () => healthy,
    };
    await applyUpdate(await pack(base, "2.0.0", keys.privateKey), keys.publicKey, layout, hooks);
    healthy = false;
    expect(await applyUpdate(await pack(base, "2.1.0", keys.privateKey), keys.publicKey, layout, hooks)).toMatchObject({
      rolledBack: true,
      previous: "2.0.0",
    });
    expect(await installedVersion(layout)).toBe("2.0.0");
    expect(registrations).toEqual(["2.0.0", "2.1.0", "2.0.0"]);
  });
  it.each(["false", "throw", "register"])(
    "preserves same-version bytes and registration on %s failure",
    async (failure) => {
      const base = await root();
      const keys = generateKeyPairSync("ed25519");
      const layout = { installRoot: path.join(base, "install"), stateRoot: path.join(base, "state") };
      const hooks: InstallHooks = {
        register: async () => {},
        unregister: async () => {},
        healthCheck: async () => true,
      };
      await applyUpdate(await pack(base, "3.0.0", keys.privateKey, "original"), keys.publicKey, layout, hooks);
      const updated = await pack(base, "3.0.0", keys.privateKey, "replacement");
      let registrations = 0;
      let unregistered = 0;
      const faulty: InstallHooks = {
        register: async () => {
          if (++registrations === 1 && failure === "register") throw new Error("register failure");
        },
        unregister: async () => {
          unregistered++;
        },
        healthCheck: async () => {
          if (failure === "throw") throw new Error("health failure");
          return false;
        },
      };
      const operation = applyUpdate(updated, keys.publicKey, layout, faulty);
      if (failure === "false") expect((await operation).rolledBack).toBe(true);
      else await expect(operation).rejects.toThrow("failure");
      expect(await installedVersion(layout)).toBe("3.0.0");
      expect(await readFile(path.join(layout.installRoot, "versions/3.0.0/bin/crot-mcp"), "utf8")).toBe("original");
      expect(registrations).toBe(2);
      expect(unregistered).toBe(1);
    },
  );
  it.each([false, true])("unregisters failed fresh install (throw=%s)", async (throws) => {
    const base = await root();
    const keys = generateKeyPairSync("ed25519");
    const layout = { installRoot: path.join(base, "install"), stateRoot: path.join(base, "state") };
    let removed = 0;
    const operation = applyUpdate(await pack(base, "4.0.0", keys.privateKey), keys.publicKey, layout, {
      register: async () => {},
      unregister: async () => {
        removed++;
      },
      healthCheck: async () => {
        if (throws) throw new Error("failed health");
        return false;
      },
    });
    if (throws) await expect(operation).rejects.toThrow("failed health");
    else expect((await operation).rolledBack).toBe(true);
    expect(await installedVersion(layout)).toBeUndefined();
    expect(removed).toBe(1);
  });
});

/** Signed, transactional package install/update with health-check rollback (WP-34). */
import { createHash, verify as verifySignature, type KeyObject } from "node:crypto";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PackageFile {
  readonly path: string;
  readonly sha256: string;
}
export interface UpdateManifest {
  readonly schema: 1;
  readonly product: "crot";
  readonly version: string;
  readonly identityEnvironment: string;
  readonly files: readonly PackageFile[];
}
export interface InstallLayout {
  readonly installRoot: string;
  readonly stateRoot: string;
}
export interface InstallHooks {
  readonly register: (versionDir: string) => Promise<void>;
  readonly unregister: () => Promise<void>;
  readonly healthCheck: (versionDir: string) => Promise<boolean>;
}
export interface ApplyResult {
  readonly version: string;
  readonly previous?: string;
  readonly rolledBack: boolean;
}
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

function canonicalManifest(manifest: UpdateManifest): Buffer {
  return Buffer.from(JSON.stringify(manifest) + "\n", "utf8");
}
function safeRelative(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).some((p) => p === "" || p === "." || p === "..")
  );
}
export function parseUpdateManifest(value: unknown): UpdateManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("update manifest is not an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "files,identityEnvironment,product,schema,version")
    throw new Error("update manifest has unknown or missing fields");
  if (v.schema !== 1 || v.product !== "crot" || typeof v.version !== "string" || !VERSION.test(v.version))
    throw new Error("invalid update identity");
  if (typeof v.identityEnvironment !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(v.identityEnvironment))
    throw new Error("release identity environment is required");
  if (!Array.isArray(v.files) || v.files.length === 0) throw new Error("update package has no files");
  const seen = new Set<string>();
  const files = v.files.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid update file");
    const f = item as Record<string, unknown>;
    if (
      Object.keys(f).sort().join(",") !== "path,sha256" ||
      typeof f.path !== "string" ||
      !safeRelative(f.path) ||
      typeof f.sha256 !== "string" ||
      !SHA256.test(f.sha256)
    )
      throw new Error("invalid update file entry");
    if (seen.has(f.path)) throw new Error("duplicate update file");
    seen.add(f.path);
    return { path: f.path, sha256: f.sha256 };
  });
  return { schema: 1, product: "crot", version: v.version, identityEnvironment: v.identityEnvironment, files };
}
export async function verifyUpdatePackage(
  packageDir: string,
  publicKey: string | Buffer | KeyObject,
): Promise<UpdateManifest> {
  const manifest = parseUpdateManifest(
    JSON.parse(await readFile(path.join(packageDir, "update-manifest.json"), "utf8")),
  );
  const signature = Buffer.from(
    (await readFile(path.join(packageDir, "update-manifest.sig"), "utf8")).trim(),
    "base64",
  );
  if (signature.length !== 64 || !verifySignature(null, canonicalManifest(manifest), publicKey, signature))
    throw new Error("update manifest signature verification failed");
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(packageDir, "payload", file.path));
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
      throw new Error(`update payload hash mismatch: ${file.path}`);
  }
  return manifest;
}
async function current(layout: InstallLayout): Promise<string | undefined> {
  try {
    const value = (await readFile(path.join(layout.installRoot, "current"), "utf8")).trim();
    return VERSION.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
async function setCurrent(layout: InstallLayout, version: string): Promise<void> {
  const temp = path.join(layout.installRoot, `.current-${process.pid}-${Date.now()}`);
  await writeFile(temp, `${version}\n`, { mode: 0o600 });
  await rename(temp, path.join(layout.installRoot, "current"));
}

export async function applyUpdate(
  packageDir: string,
  publicKey: string | Buffer | KeyObject,
  layout: InstallLayout,
  hooks: InstallHooks,
): Promise<ApplyResult> {
  const manifest = await verifyUpdatePackage(packageDir, publicKey);
  const previous = await current(layout);
  const versions = path.join(layout.installRoot, "versions");
  const target = path.join(versions, manifest.version);
  const staging = `${target}.staging-${process.pid}`;
  await mkdir(versions, { recursive: true, mode: 0o700 });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const file of manifest.files) {
      const destination = path.join(staging, file.path);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await cp(path.join(packageDir, "payload", file.path), destination);
    }
    await writeFile(path.join(staging, "installed-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
    });
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    await setCurrent(layout, manifest.version);
    await hooks.register(target);
    if (!(await hooks.healthCheck(target))) {
      if (previous) {
        await setCurrent(layout, previous);
        await hooks.register(path.join(versions, previous));
      } else {
        await rm(path.join(layout.installRoot, "current"), { force: true });
        await hooks.unregister();
      }
      return { version: manifest.version, previous, rolledBack: true };
    }
    return { version: manifest.version, previous, rolledBack: false };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (previous) await setCurrent(layout, previous);
    throw error;
  }
}
export async function uninstall(
  layout: InstallLayout,
  hooks: Pick<InstallHooks, "unregister">,
  purgeUserData = false,
): Promise<void> {
  await hooks.unregister();
  await rm(layout.installRoot, { recursive: true, force: true });
  if (purgeUserData) await rm(layout.stateRoot, { recursive: true, force: true });
}
export async function installedVersion(layout: InstallLayout): Promise<string | undefined> {
  const version = await current(layout);
  if (!version) return;
  try {
    await access(path.join(layout.installRoot, "versions", version, "installed-manifest.json"));
    return version;
  } catch {
    return;
  }
}
export const updateManifestBytes = canonicalManifest;

/** Deterministic CycloneDX SBOM and SHA-256 manifest for a release directory (WP-34). */
import { createHash } from "node:crypto";
import process from "node:process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function walk(dir, prefix = "") {
  const out = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (["SHA256SUMS", "sbom.cdx.json"].includes(rel)) continue;
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}
export async function generateSupplyChain(out) {
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const components = Object.entries(lock.packages ?? {})
    .filter(([k, v]) => k.startsWith("node_modules/") && v?.version)
    .map(([k, v]) => {
      const name = k.slice("node_modules/".length);
      return {
        type: "library",
        name,
        version: v.version,
        purl: `pkg:npm/${encodeURIComponent(name)}@${v.version}`,
        ...(v.license ? { licenses: [{ license: { id: v.license } }] } : {}),
      };
    })
    .sort((a, b) => a.purl.localeCompare(b.purl));
  components.push({
    type: "library",
    name: "Microsoft Detours",
    version: "4.0.1",
    licenses: [{ license: { id: "MIT" } }],
    properties: [
      { name: "crot:scope", value: "vendored native source; compiled only for Windows qualification/build" },
    ],
  });
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${createHash("sha256")
      .update(`${pkg.name}@${pkg.version}`)
      .digest("hex")
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, "$1-$2-$3-$4-$5")}`,
    version: 1,
    metadata: { component: { type: "application", name: "CROT", version: pkg.version } },
    components,
  };
  await writeFile(path.join(out, "sbom.cdx.json"), JSON.stringify(sbom, null, 2) + "\n");
  const files = await walk(out);
  const sums = [];
  for (const file of files) {
    const bytes = await readFile(path.join(out, file));
    sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
  }
  await writeFile(path.join(out, "SHA256SUMS"), sums.join("\n") + "\n");
  return { components: components.length, files: files.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? path.join(root, "dist-release"));
  process.stdout.write(`${JSON.stringify(await generateSupplyChain(out))}\n`);
}

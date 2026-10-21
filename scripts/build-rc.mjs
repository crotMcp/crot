/** WP-40 repository RC pipeline. Production mode requires tests, Chromium and an Ed25519 signing key. */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { validateOutput } from "./output-path.mjs";
const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const value = (x) => args[args.indexOf(x) + 1];
const repositoryTest = has("--repository-test");
const out = await validateOutput(root, path.resolve(root, has("--out") ? value("--out") : "artifacts/rc"));
const identity = has("--environment") ? value("--environment") : process.env.RELEASE_IDENTITY_ENVIRONMENT;
if (!identity) throw new Error("RELEASE_IDENTITY_ENVIRONMENT or --environment is required");
if (!repositoryTest && !process.env.CROT_E2E_CHROME) throw new Error("CROT_E2E_CHROME is required for an RC");
if (!repositoryTest && !process.env.CROT_UPDATE_SIGNING_KEY)
  throw new Error("CROT_UPDATE_SIGNING_KEY is required for an RC");
if (!repositoryTest && (has("--skip-check") || has("--skip-e2e")))
  throw new Error("production RC builds cannot skip repository checks or browser E2E");

const run = (cmd, argv, env = {}) =>
  execFileSync(cmd, argv, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
if (!has("--skip-check")) run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "check"]);
if (!has("--skip-e2e")) run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "test:e2e:browser"]);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const release = path.join(out, "desktop");
run(process.execPath, ["scripts/build-release.mjs", "--environment", identity, "--out", release]);
run(process.execPath, ["scripts/package-extension.mjs"], { CROT_EXTENSION_OUT: path.join(out, "extension") });
async function walk(dir, prefix = "") {
  const list = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) list.push(...(await walk(path.join(dir, e.name), rel)));
    else if (e.isFile()) list.push(rel);
  }
  return list;
}
// Produce exactly the canonical schema consumed by verifyUpdatePackage/applyUpdate.
const update = path.join(out, "update");
await mkdir(update, { recursive: true });
const { cp } = await import("node:fs/promises");
await cp(release, path.join(update, "payload"), { recursive: true });
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const updateFiles = [];
for (const rel of await walk(path.join(update, "payload"))) {
  const data = await readFile(path.join(update, "payload", rel));
  updateFiles.push({ path: rel, sha256: createHash("sha256").update(data).digest("hex") });
}
const updateManifest = {
  schema: 1,
  product: "crot",
  version: pkg.version,
  identityEnvironment: JSON.parse(await readFile(identity, "utf8")).id,
  files: updateFiles,
};
await writeFile(path.join(update, "update-manifest.json"), JSON.stringify(updateManifest) + "\n");
let signingKey;
if (process.env.CROT_UPDATE_SIGNING_KEY) {
  signingKey = createPrivateKey(await readFile(process.env.CROT_UPDATE_SIGNING_KEY));
  if (signingKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 signing key required");
  await writeFile(
    path.join(update, "update-manifest.sig"),
    sign(null, Buffer.from(JSON.stringify(updateManifest) + "\n"), signingKey).toString("base64") + "\n",
  );
}
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const files = [];
for (const rel of await walk(out)) {
  if (rel.startsWith("rc-manifest")) continue;
  const data = await readFile(path.join(out, rel));
  files.push({ path: rel, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
}
const required = [
  "desktop/sbom.cdx.json",
  "desktop/SHA256SUMS",
  "desktop/THIRD_PARTY_NOTICES.md",
  "desktop/release-identity.json",
];
for (const requiredFile of required)
  if (!files.some((file) => file.path === requiredFile)) throw new Error(`missing RC artifact: ${requiredFile}`);
if (!files.some((file) => file.path.endsWith(".zip"))) throw new Error("missing extension store archive");
const manifest = {
  schema: 1,
  product: "crot",
  channel: repositoryTest ? "repository-test" : "rc",
  repositoryTest,
  commitSha: git("rev-parse", "HEAD"),
  treeSha: git("rev-parse", "HEAD^{tree}"),
  dirty: git("status", "--porcelain").length > 0,
  tools: {
    node: process.version,
    typescript: JSON.parse(await readFile(path.join(root, "node_modules/typescript/package.json"), "utf8")).version,
    chromium: process.env.CROT_E2E_CHROME
      ? execFileSync(process.env.CROT_E2E_CHROME, ["--version"], { encoding: "utf8" }).trim()
      : null,
  },
  createdAt: new Date().toISOString(),
  identity: JSON.parse(await readFile(identity, "utf8")),
  checks: { repositoryCheck: !has("--skip-check"), browserE2e: !has("--skip-e2e"), sbom: true, extensionPackage: true },
  readinessCriteria: {
    corePermissionsAndAudit: repositoryTest
      ? "not_qualified_test_artifact"
      : "checks_executed_platform_evidence_required",
    browserChain: repositoryTest ? "not_qualified_test_artifact" : "checks_executed_platform_evidence_required",
    crossPlatformIsolation: repositoryTest
      ? "not_qualified_test_artifact"
      : "checks_executed_platform_evidence_required",
    remoteIdentityAndRelay: repositoryTest
      ? "not_qualified_test_artifact"
      : "checks_executed_platform_evidence_required",
    signedSupplyChain: repositoryTest ? "not_qualified_test_artifact" : "checks_executed_platform_evidence_required",
    securityReview: repositoryTest ? "not_qualified_test_artifact" : "checks_executed_platform_evidence_required",
    legalPublication: "operator_required",
    storePublication: "operator_required",
    liveCloudDrills: "operator_required",
    betaAcceptance: "operator_required",
  },
  operatorGates: { osVendorSigning: "required", storePublication: "required", beta: "required" },
  files,
};
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
await writeFile(path.join(out, "rc-manifest.json"), bytes);
if (signingKey) {
  await writeFile(path.join(out, "rc-manifest.sig"), sign(null, bytes, signingKey).toString("base64") + "\n");
}
process.stdout.write(`${out}\n`);

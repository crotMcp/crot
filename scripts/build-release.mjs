/** Pin public identity metadata into a separate release artifact, never a runtime override. */
import process from "node:process";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argument = (name) => args[args.indexOf(name) + 1];
const environmentInput = args.includes("--environment")
  ? argument("--environment")
  : process.env.RELEASE_IDENTITY_ENVIRONMENT;
if (!environmentInput)
  throw new Error(
    "release identity is required: pass --environment <public JSON> or set RELEASE_IDENTITY_ENVIRONMENT to its path (N3)",
  );
import { validateOutput } from "./output-path.mjs";
const out = await validateOutput(root, path.resolve(root, args.includes("--out") ? argument("--out") : "dist-release"));
// Compile to a fresh directory: validation failure never changes an existing release.
const temp = path.join(root, "node_modules", ".cache", `release-${randomUUID()}`);
try {
  execFileSync(
    process.execPath,
    [
      createRequire(import.meta.url).resolve("typescript/bin/tsc"),
      "-p",
      path.join(root, "tsconfig.build.json"),
      "--outDir",
      temp,
    ],
    { cwd: root, stdio: "inherit" },
  );
  const { validateEnvironment } = await import(pathToFileURL(path.join(temp, "identity/environment.js")).href);
  const config = await readFile(path.resolve(environmentInput), "utf8");
  if (Buffer.byteLength(config) > 16384) throw new Error("identity metadata exceeds 16 KiB");
  const environment = validateEnvironment(JSON.parse(config), "release");
  if (typeof environment === "string") throw new Error(environment);
  // All executable bytes are fixed; metadata is JSON-encoded, not interpolated source.
  await writeFile(
    path.join(temp, "identity/release-environment.js"),
    `const value = ${JSON.stringify(environment)};\nObject.freeze(value.pairing);\nexport const RELEASE_IDENTITY_ENVIRONMENT = Object.freeze(value);\n`,
  );
  await writeFile(path.join(temp, "release-identity.json"), JSON.stringify(environment, null, 2) + "\n");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const { cp } = await import("node:fs/promises");
  await cp(temp, out, { recursive: true });
  await cp(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(out, "THIRD_PARTY_NOTICES.md"));
  // Inventory only reviewed tracked native sources, never ignored local keys/build products.
  const nativeFiles = execFileSync("git", ["ls-files", "-z", "native"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  for (const file of nativeFiles) {
    await mkdir(path.dirname(path.join(out, file)), { recursive: true });
    await cp(path.join(root, file), path.join(out, file));
  }
  const { generateSupplyChain } = await import("./generate-supply-chain.mjs");
  await generateSupplyChain(out);
} finally {
  await rm(temp, { recursive: true, force: true });
}

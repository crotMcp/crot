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
if (!args.includes("--environment") || !argument("--environment"))
  throw new Error("--environment <public JSON> required");
const out = path.resolve(root, args.includes("--out") ? argument("--out") : "dist-release");
if (out === root || out === path.join(root, "src") || out.includes(`${path.sep}src${path.sep}`))
  throw new Error("unsafe output directory");
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
  const config = await readFile(path.resolve(argument("--environment")), "utf8");
  if (Buffer.byteLength(config) > 16384) throw new Error("identity metadata exceeds 16 KiB");
  const environment = validateEnvironment(JSON.parse(config), "release");
  if (typeof environment === "string") throw new Error(environment);
  // All executable bytes are fixed; metadata is JSON-encoded, not interpolated source.
  await writeFile(
    path.join(temp, "identity/release-environment.js"),
    `const value = ${JSON.stringify(environment)};\nObject.freeze(value.pairing);\nexport const RELEASE_IDENTITY_ENVIRONMENT = Object.freeze(value);\n`,
  );
  await writeFile(path.join(temp, "release-identity.json"), JSON.stringify(environment, null, 2) + "\n");
  await mkdir(out, { recursive: true });
  const { cp } = await import("node:fs/promises");
  await cp(temp, out, { recursive: true });
} finally {
  await rm(temp, { recursive: true, force: true });
}

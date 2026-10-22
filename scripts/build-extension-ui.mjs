/** Bundle first-party UI assets without network access or runtime evaluation. */
import { Buffer } from "node:buffer";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
const repo = fileURLToPath(new URL("../", import.meta.url));
const theme = await readFile(path.join(repo, "src/ui/theme.ts"), "utf8");
const css = /export const CROT_CSS = `([\s\S]*?)`;/.exec(theme)?.[1];
if (!css || css.includes("${")) throw new Error("shared theme must be a static CSS literal");
await writeFile(path.join(repo, "extension/ui.css"), css);
const source = JSON.parse(await readFile(path.join(repo, "extension/icons/source.json"), "utf8"));
await mkdir(path.join(repo, "extension/icons"), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const name = `icon${size}.png`,
    encoded = source[name];
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("invalid bundled icon");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.subarray(1, 4).toString() !== "PNG" || bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size)
    throw new Error("invalid icon dimensions");
  await writeFile(path.join(repo, "extension/icons", name), bytes);
}

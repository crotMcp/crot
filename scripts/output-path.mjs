/** Only disposable children of artifacts/dist-release or a named OS temp directory. */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
export async function validateOutput(root, output) {
  root = await realpath(root);
  let out = path.resolve(output);
  const inside = (parent, child) =>
    child !== parent &&
    !path.relative(parent, child).startsWith("..") &&
    !path.isAbsolute(path.relative(parent, child));
  const rawTemp = path.resolve(os.tmpdir());
  const temp = await realpath(rawTemp);
  // macOS /var and Windows short-name temp aliases are trusted OS roots,
  // not arbitrary output symlinks. Normalize only that root, then inspect descendants.
  if (out === rawTemp || inside(rawTemp, out)) out = path.join(temp, path.relative(rawTemp, out));
  const tempRelative = path.relative(temp, out).split(path.sep);
  const allowed =
    out === path.join(root, "dist-release") ||
    inside(path.join(root, "artifacts"), out) ||
    (!inside(root, out) &&
      inside(temp, out) &&
      /^crot-[A-Za-z0-9_-]+$/.test(tempRelative[0]) &&
      tempRelative.length > 1);
  if (!allowed || out === root || inside(out, root)) throw new Error("unsafe output directory");
  let cursor = out;
  while (cursor !== path.dirname(cursor) && cursor !== root && cursor !== temp) {
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("unsafe output symlink");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    cursor = path.dirname(cursor);
  }
  return out;
}

/** Validate local Markdown targets/heading anchors; not a semantic architecture proof. */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
const root = process.cwd();
async function markdown(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "dist-release", "artifacts"].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await markdown(file)));
    else if (entry.name.endsWith(".md")) files.push(file);
  }
  return files;
}
const files = await markdown(root);
const errors = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
    const value = match[1];
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:|^\//.test(value)) continue;
    const [relative, anchor] = value.split("#");
    const target = relative ? path.resolve(path.dirname(file), relative) : file;
    try {
      await stat(target);
    } catch {
      errors.push(`${path.relative(root, file)}: missing ${value}`);
      continue;
    }
    if (anchor && target.endsWith(".md")) {
      const text = await readFile(target, "utf8");
      const seen = new Map();
      const anchors = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => {
        const base = m[1]
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_ -]/gu, "")
          .replaceAll(" ", "-");
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return base + (n ? `-${n}` : "");
      });
      if (!anchors.includes(anchor)) errors.push(`${path.relative(root, file)}: missing anchor ${value}`);
    }
  }
}
if (errors.length) {
  process.stderr.write(errors.join("\n") + "\n");
  process.exitCode = 1;
} else process.stdout.write(`Validated ${files.length} Markdown files: local paths and explicit heading anchors\n`);

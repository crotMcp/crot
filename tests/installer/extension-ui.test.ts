import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function cleanCheckout(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "crot-extension-ui-"));
  roots.push(root);
  for (const file of [
    "scripts/build-extension-ui.mjs",
    "src/ui/theme.ts",
    "extension/icons/source.json",
    "extension/manifest.json",
  ]) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.resolve(file), target);
  }
  return root;
}
const build = (root: string) =>
  exec(process.execPath, [path.join(root, "scripts/build-extension-ui.mjs")], { cwd: root });

describe("clean-checkout extension UI build (including the L1 qualification path)", () => {
  it("creates every manifest icon and shared CSS without preexisting ignored assets, deterministically", async () => {
    const root = await cleanCheckout();
    const manifest = JSON.parse(await readFile(path.join(root, "extension/manifest.json"), "utf8")) as {
      icons: Record<string, string>;
      action: { default_icon: Record<string, string> };
    };
    const files = [
      ...new Set([...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]),
      "ui.css",
    ];
    for (const file of files) await expect(access(path.join(root, "extension", file))).rejects.toThrow();
    await build(root);
    const digest = async () =>
      Promise.all(
        files.map(async (file) =>
          createHash("sha256")
            .update(await readFile(path.join(root, "extension", file)))
            .digest("hex"),
        ),
      );
    const first = await digest();
    for (const [size, file] of Object.entries(manifest.icons)) {
      const png = await readFile(path.join(root, "extension", file));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(Number(size));
      expect(png.readUInt32BE(20)).toBe(Number(size));
    }
    expect(await readFile(path.join(root, "extension/ui.css"), "utf8")).toContain("#090A0F");
    await build(root);
    expect(await digest()).toEqual(first);
  });

  it("refuses interpolated source instead of evaluating theme code", async () => {
    const root = await cleanCheckout();
    await writeFile(path.join(root, "src/ui/theme.ts"), "export const CROT_CSS = `body{color:${untrusted()}}`;");
    await expect(build(root)).rejects.toThrow("shared theme must be a static CSS literal");
    await expect(access(path.join(root, "extension/ui.css"))).rejects.toThrow();
  });
});

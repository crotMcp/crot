import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
const exec = promisify(execFile);
const outputs: string[] = [];
afterAll(async () => {
  for (const o of outputs) await rm(o, { recursive: true, force: true });
});
describe("WP-35 extension store package", () => {
  it("validates MV3 and emits reproducible zip plus SHA-256", async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), "crot-extension-package-"));
    outputs.push(out);
    const code = `import {packageExtension} from ${JSON.stringify(new URL("../../scripts/package-extension.mjs", import.meta.url).href)}; console.log(JSON.stringify(await packageExtension({repo:${JSON.stringify(path.resolve("."))},outDir:${JSON.stringify(out)}})))`;
    const one = JSON.parse((await exec(process.execPath, ["--input-type=module", "-e", code])).stdout);
    const first = await readFile(one.target);
    const two = JSON.parse((await exec(process.execPath, ["--input-type=module", "-e", code])).stdout);
    const second = await readFile(two.target);
    expect(first.equals(second)).toBe(true);
    expect(createHash("sha256").update(first).digest("hex")).toBe(one.digest);
    expect(one.files).toContain("manifest.json");
    expect(one.files.some((f: string) => f.startsWith("dist/"))).toBe(true);
    expect(await readFile(`${one.target}.sha256`, "utf8")).toContain(one.digest);
  });
});

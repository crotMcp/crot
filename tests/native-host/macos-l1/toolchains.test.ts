import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect } from "vitest";
import { prepareRustup } from "../../../src/native-host/macos-l1/toolchains.js";
describe.runIf(process.platform !== "win32")("macOS private Rustup preparation", () => {
  it("reuses only toolchain links and default selection, not host credentials or other settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "crot-rustup-"));
    const home = path.join(root, "private"),
      host = path.join(root, "host", ".rustup");
    try {
      await mkdir(path.join(host, "toolchains", "stable-aarch64-apple-darwin"), { recursive: true });
      await writeFile(
        path.join(host, "settings.toml"),
        'version = "12"\ndefault_toolchain = "stable-aarch64-apple-darwin"\nprofile = "complete"\n',
      );
      await writeFile(path.join(host, "credentials"), "must-not-copy");
      await prepareRustup(home, path.join(root, "host"), {});
      expect(await realpath(path.join(home, "rustup/toolchains/stable-aarch64-apple-darwin"))).toBe(
        await realpath(path.join(host, "toolchains/stable-aarch64-apple-darwin")),
      );
      expect(await readdir(path.join(home, "rustup"))).toEqual(["settings.toml", "toolchains"]);
      expect(await readFile(path.join(home, "rustup/settings.toml"), "utf8")).not.toContain("profile");
      expect(await readFile(path.join(host, "settings.toml"), "utf8")).toContain('profile = "complete"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

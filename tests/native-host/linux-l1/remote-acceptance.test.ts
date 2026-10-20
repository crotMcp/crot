/** Included by the existing mandatory L1 CI command; no extra workflow or secret needed. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { RemoteAcceptance } from "../../remote-acceptance/harness.js";
import { connectClient, versions } from "../../remote-acceptance/client.js";
const required = process.platform === "linux" && process.env.CROT_L1_REQUIRED === "1";
it.runIf(required)(
  "WP-32 remote HTTPS/WSS shell executes under real installed L1 (all protocol versions)",
  async () => {
    const h = new RemoteAcceptance();
    try {
      await h.start();
      await h.seed();
      for (const version of versions) {
        const client = await connectClient(h, version);
        try {
          const result = await client.call("shell_run", { script: "printf WP32_REAL_L1; cat /proc/self/attr/current" });
          expect(result).not.toHaveProperty("error");
          expect(JSON.stringify(result)).toContain("WP32_REAL_L1");
          expect(JSON.stringify(result)).toMatch(/crot.*payload/);
        } finally {
          await client.close();
        }
      }
      if (process.env.GITHUB_ACTIONS)
        console.log(
          "\n::notice title=WP-32 remote L1 qualification::All three protocol revisions executed a real confined shell; payload AppArmor label verified.",
        );
    } finally {
      await h.stop();
    }
  },
  120000,
);
it.runIf(required && process.arch === "x64")(
  "WP-32 combined project + real Chromium + actual L1 matrix",
  async () => {
    // Branded Google Chrome no longer guarantees --load-extension support.
    // Use the same Chrome for Testing distribution as the mandatory browser CI job.
    const browserDir = await mkdtemp(path.join(tmpdir(), "crot-wp32-chrome-"));
    let chrome: string;
    try {
      const output = execFileSync(
        "npx",
        ["--yes", "@puppeteer/browsers", "install", "chrome@stable", "--path", browserDir],
        { encoding: "utf8", timeout: 120000 },
      );
      chrome = output.trim().split("\n").at(-1)!.split(" ").slice(1).join(" ");
      expect(chrome, "Chrome for Testing must install; no optional skip").toBeTruthy();
    } catch (error) {
      await rm(browserDir, { recursive: true, force: true });
      throw error;
    }
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { stdio: "inherit" });
    execFileSync(process.execPath, [tsc, "-p", "extension/tsconfig.json"], { stdio: "inherit" });
    const saved = {
      chrome: process.env.CROT_E2E_CHROME,
      args: process.env.CROT_E2E_CHROME_ARGS,
      headless: process.env.CROT_E2E_HEADLESS,
    };
    Object.assign(process.env, {
      CROT_E2E_CHROME: chrome,
      CROT_E2E_CHROME_ARGS: "--no-sandbox",
      CROT_E2E_HEADLESS: "1",
    });
    try {
      const { remoteBrowserScenario } = await import("../../../tests-e2e/browser/wp32-scenario.js");
      await remoteBrowserScenario(true);
    } finally {
      await rm(browserDir, { recursive: true, force: true });
      for (const [key, value] of [
        ["CROT_E2E_CHROME", saved.chrome],
        ["CROT_E2E_CHROME_ARGS", saved.args],
        ["CROT_E2E_HEADLESS", saved.headless],
      ]) {
        if (value === undefined) delete process.env[key!];
        else process.env[key!] = value;
      }
    }
  },
  300000,
);

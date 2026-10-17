import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    ...(process.platform === "darwin"
      ? {
          reporters: [
            "default",
            ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
            "./tests/macos-l1-reporter.ts",
          ],
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          // Native qualification changes real shared ancestor descriptors.
          // Run files serially; production has its own durable machine owner.
          fileParallelism: false,
          reporters: [
            "default",
            ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
            "./tests/stage6a-reporter.ts",
          ],
        }
      : {}),
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});

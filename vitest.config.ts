import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    ...(process.platform === "win32"
      ? {
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

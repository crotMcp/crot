import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters:
      process.platform === "win32"
        ? [
            "default",
            ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
            "./tests/stage6a-reporter.ts",
          ]
        : undefined,
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Real-browser E2E (docs/BROWSER_E2E.md). Kept out of the default `npm test`
 * (tests/**) because it needs a Chromium binary and a display (or headless).
 * Run with `npm run test:e2e:browser`.
 */
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: ["tests-e2e/**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

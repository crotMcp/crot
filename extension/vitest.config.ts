import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Tests of the CROT Browser Extension, run against a fake chrome API (npm run test:extension). */
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: ["extension/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});

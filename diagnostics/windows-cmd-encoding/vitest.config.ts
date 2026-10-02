// TEMPORARY diagnostic config (see README.md). Not used by `npm test`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["diagnostics/windows-cmd-encoding/**/*.diag.ts"],
    environment: "node",
    testTimeout: 180_000,
    fileParallelism: false,
  },
});

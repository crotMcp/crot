import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * Lint configuration for CROT (sources, tests, extension, E2E and config files).
 * Recommended rules only, without type-aware linting; formatting is left to
 * Prettier (eslint-config-prettier turns off conflicting stylistic rules).
 */
export default defineConfig([
  globalIgnores(["**/dist/", "coverage/", "node_modules/", "tests-e2e/browser/fixtures/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
]);

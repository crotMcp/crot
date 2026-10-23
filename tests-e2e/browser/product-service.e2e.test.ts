import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "vitest";
import { chromeExecutable } from "./harness.js";
it(
  "shipped UI talks to real CrotService: projects, files/git/terminal, connector HTTP, MCP discovery, task cancellation, audit",
  { timeout: 120000 },
  async () => {
    await promisify(execFile)(process.execPath, ["scripts/ui-e2e.mjs", "--service"], {
      env: { ...process.env, CROT_E2E_CHROME: chromeExecutable() },
      timeout: 110000,
    });
  },
);

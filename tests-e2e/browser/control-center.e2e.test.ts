import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "vitest";
import { chromeExecutable } from "./harness.js";

it(
  "product UI: real Chromium checks three-screen onboarding, five primary destinations, contextual tools, approvals and desktop geometry",
  { timeout: 120_000 },
  async () => {
    await promisify(execFile)(process.execPath, ["scripts/ui-e2e.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, CROT_E2E_CHROME: chromeExecutable() },
      timeout: 110_000,
    });
  },
);

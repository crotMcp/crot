import { it } from "vitest";
import { remoteBrowserScenario } from "./wp32-scenario.js";
it("WP-32 all three MCP versions × both presets over HTTPS/WSS with real Chromium", async () => {
  await remoteBrowserScenario();
}, 180000);

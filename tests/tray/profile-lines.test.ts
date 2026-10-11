import { describe, expect, it } from "vitest";
import type { ControlOverview } from "../../src/service/protocol.js";
import { profileLines } from "../../src/tray/view-model.js";

/** WP-31: the tray reports the effective preset and its source, the remote profile, the opt-in and the restrictions. */

const overview = (
  remote: Record<string, unknown>,
  preset: Record<string, unknown> = { effective: "autonomous-browser", source: "device" },
) => ({ preset, remote }) as unknown as ControlOverview;

const PROFILE = {
  mode: "sandbox",
  capabilities: ["filesystem.read", "browser.control"],
  untrustedContent: "autonomous-browser",
  fullControl: { enabled: false },
  restrictions: ["workspace only", "shell and process operations need command confinement L1"],
};

const REMOTE_LINE =
  "Remote clients: mode sandbox, untrusted-content protection autonomous-browser, " +
  "capabilities filesystem.read, browser.control";
const NOT_IN_EFFECT = "Remote full control: recorded in the device settings but NOT in effect";

describe("tray: effective preset and remote profile (WP-31)", () => {
  it("reports the preset and its source, the remote profile and every restriction", () => {
    const lines = profileLines(overview({ fullControl: false, fullControlEffective: false, profile: PROFILE }));
    expect(lines[0]).toBe("Approval preset: Autonomous browser (autonomous-browser), chosen on this device");
    expect(lines).toContain(REMOTE_LINE);
    expect(lines).toContain("Remote full control: off");
    for (const r of PROFILE.restrictions) expect(lines).toContain(`Restriction: ${r}`);
  });

  it("an effective opt-in names the one device it applies to", () => {
    const profile = { ...PROFILE, fullControl: { enabled: true, deviceId: "dev-1", accountId: "acct-1" } };
    const lines = profileLines(overview({ fullControl: true, fullControlEffective: true, profile }));
    expect(lines).toContain("Remote full control: ON for device dev-1 (account acct-1) only");
  });

  it("an opt-in in effect but not saved says it is off after a restart", () => {
    const profile = { ...PROFILE, fullControl: { enabled: true, deviceId: "dev-1" } };
    const lines = profileLines(overview({ fullControl: false, fullControlEffective: true, profile }));
    expect(lines).toContain("Remote full control: ON for device dev-1 only (not saved: off after a restart)");
  });

  it("a recorded opt-in that the running Core does not apply is never reported as on", () => {
    const lines = profileLines(overview({ fullControl: true, fullControlEffective: false, profile: PROFILE }));
    expect(lines.some((l) => l.startsWith(NOT_IN_EFFECT))).toBe(true);
    expect(lines.some((l) => l.includes("ON for device"))).toBe(false);
  });

  it("unreadable device settings are reported as the fail-closed source", () => {
    const preset = { effective: "require-approval", source: "fail-closed" };
    const lines = profileLines(overview({ fullControl: false }, preset));
    expect(lines).toEqual([
      "Approval preset: Ask for every action (require-approval), device settings unreadable, most restrictive",
    ]);
  });
});

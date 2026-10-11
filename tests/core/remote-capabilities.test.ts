/**
 * WP-31, ARCHITECTURE.md §27 AD-23 point 4: every capability has an explicit
 * remote decision. A capability added to CAPABILITIES without a decided remote
 * default fails this test, and the engine never grants it to a remote principal.
 */
import { describe, expect, it } from "vitest";
import { remotePrincipal, type AuthContext } from "../../src/core/auth/principal.js";
import { CAPABILITIES, type Capability } from "../../src/core/permissions/capabilities.js";
import { PermissionEngine, REMOTE_DEFAULT_CAPABILITIES } from "../../src/core/permissions/engine.js";
import { createPermissionPolicy, SANDBOX_FORBIDDEN_CAPABILITIES } from "../../src/core/permissions/policy.js";
import { testContext as local } from "../helpers.js";

const remote = (deviceId: string, accountId = "acc-1"): AuthContext => ({
  principal: remotePrincipal({
    id: `remote-${deviceId}`,
    transport: "http",
    authMethod: "test",
    accountId,
    deviceId,
    clientId: "client-1",
  }),
});

/** The remote default agreed for WP-31 (AD-23 points 4 and 5): every current capability except filesystem.full. */
const AGREED_REMOTE_DEFAULT: readonly Capability[] = [
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "process.manage",
  "git.read",
  "git.write",
  "docker.use",
  "browser.read",
  "browser.control",
  "network.access",
];

describe("remote default capabilities (AD-23 point 4)", () => {
  it("every capability has an explicit remote decision: a decided remote default or never granted remotely", () => {
    const undecided = CAPABILITIES.filter(
      (c) => !REMOTE_DEFAULT_CAPABILITIES.includes(c) && !SANDBOX_FORBIDDEN_CAPABILITIES.includes(c),
    );
    expect(undecided).toEqual([]);
  });

  it("the remote default list holds only known capabilities, never filesystem.full, without duplicates", () => {
    for (const c of REMOTE_DEFAULT_CAPABILITIES) expect(CAPABILITIES).toContain(c);
    expect(REMOTE_DEFAULT_CAPABILITIES.filter((c) => SANDBOX_FORBIDDEN_CAPABILITIES.includes(c))).toEqual([]);
    expect(new Set(REMOTE_DEFAULT_CAPABILITIES).size).toBe(REMOTE_DEFAULT_CAPABILITIES.length);
  });

  it("keeps the agreed WP-31 remote default", () => {
    expect(new Set(REMOTE_DEFAULT_CAPABILITIES)).toEqual(new Set(AGREED_REMOTE_DEFAULT));
  });

  it("remote principals get the configured capabilities intersected with the remote defaults", () => {
    const full = new PermissionEngine(createPermissionPolicy({ mode: "full_control" }));
    expect(new Set(full.remoteProfile.capabilities)).toEqual(
      new Set(CAPABILITIES.filter((c) => REMOTE_DEFAULT_CAPABILITIES.includes(c))),
    );
    const narrow = new PermissionEngine(
      createPermissionPolicy({ mode: "sandbox", capabilities: ["filesystem.read", "browser.read"] }),
    );
    expect(new Set(narrow.remoteProfile.capabilities)).toEqual(new Set(["filesystem.read", "browser.read"]));
    expect(narrow.authorize({ context: remote("d1"), capability: "browser.read" }).allowed).toBe(true);
    expect(narrow.authorize({ context: remote("d1"), capability: "browser.control" }).allowed).toBe(false);
  });

  it("the full-control opt-in adds only filesystem.full to the remote defaults; local principals are unchanged", () => {
    const e = new PermissionEngine(createPermissionPolicy({ mode: "full_control" }), {
      remote: { fullControl: { deviceId: "d1", accountId: "acc-1" } },
    });
    expect(new Set(e.remoteProfile.fullControl.capabilities)).toEqual(
      new Set<Capability>([...REMOTE_DEFAULT_CAPABILITIES, "filesystem.full"]),
    );
    for (const capability of CAPABILITIES) {
      expect(e.authorize({ context: local, capability }).allowed).toBe(true);
      expect(e.authorize({ context: remote("d1"), capability }).allowed).toBe(true);
      expect(e.authorize({ context: remote("d2"), capability }).allowed).toBe(capability !== "filesystem.full");
    }
  });
});

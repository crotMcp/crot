/**
 * WP-31: the remote permission profile, the presets and the per-device
 * full-control opt-in, evaluated by the one PermissionEngine.
 */
import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_BROWSER_RULES,
  BROWSER_UPLOAD_RULE_ID,
  REMOTE_FULL_CONTROL_RULE_ID,
  UNTRUSTED_CONTENT_RULE_ID,
  UNTRUSTED_CONTENT_SETTINGS,
} from "../../src/core/approvals/exposure.js";
import { KNOWN_OPERATIONS } from "../../src/core/approvals/operations.js";
import { validateApprovalRules } from "../../src/core/approvals/rules.js";
import { remotePrincipal, type AuthContext } from "../../src/core/auth/principal.js";
import { CrotError } from "../../src/core/errors.js";
import type { Capability } from "../../src/core/permissions/capabilities.js";
import { PermissionEngine, type PermissionEngineOptions } from "../../src/core/permissions/engine.js";
import { createPermissionPolicy, type PermissionPolicyInput } from "../../src/core/permissions/policy.js";
import type { ResolvedPath } from "../../src/core/workspace/workspace.js";
import { testContext as local } from "../helpers.js";

const inside: ResolvedPath = { absolute: "/ws/a.txt", relative: "a.txt", insideWorkspace: true };
const outside: ResolvedPath = { absolute: "/etc/hosts", relative: null, insideWorkspace: false };

const remote = (deviceId: string, accountId = "acc-1", clientId = "client-1"): AuthContext => ({
  principal: remotePrincipal({
    id: `remote-${deviceId}`,
    transport: "http",
    authMethod: "test",
    accountId,
    deviceId,
    clientId,
  }),
});

const engine = (policy: PermissionPolicyInput, options: PermissionEngineOptions = {}) =>
  new PermissionEngine(createPermissionPolicy(policy), options);

const withPreset = (
  untrustedContent: (typeof UNTRUSTED_CONTENT_SETTINGS)[number],
  extra: PermissionEngineOptions = {},
) => engine({ mode: "full_control" }, { ...extra, approvals: { rules: [], untrustedContent } });

const gate = (
  e: PermissionEngine,
  ctx: AuthContext,
  capabilities: Capability[],
  operation = "test.op",
  exposed = true,
) => e.approvalRequirement(ctx, { operation, capabilities, exposed });

describe("remote default profile (safe remote defaults)", () => {
  it("is limited to the workspace even when the local configuration is full_control; local keeps full_control", () => {
    const e = engine({ mode: "full_control" });
    expect(e.authorize({ context: local, capability: "filesystem.read", paths: [outside] }).allowed).toBe(true);
    const d = e.authorize({ context: remote("d1"), capability: "filesystem.read", paths: [outside] });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.missing).toEqual(["filesystem.full"]);
    expect(e.authorize({ context: remote("d1"), capability: "filesystem.write", paths: [inside] }).allowed).toBe(true);
    expect(e.modeFor(local)).toBe("full_control");
    expect(e.modeFor(remote("d1"))).toBe("sandbox");
    // Local reporting is unchanged.
    expect(e.mode).toBe("full_control");
    expect(e.isGranted("filesystem.full")).toBe(true);
  });

  it("never grants a remote principal more than the configured capabilities", () => {
    const e = engine(
      { mode: "sandbox", capabilities: ["filesystem.read"] },
      { remote: { fullControl: { deviceId: "d1" } } },
    );
    for (const ctx of [remote("d1"), remote("d2")]) {
      expect(e.authorize({ context: ctx, capability: "shell.execute", paths: [inside] }).allowed).toBe(false);
      expect(e.authorize({ context: ctx, capability: "network.access" }).allowed).toBe(false);
    }
    expect(e.remoteProfile.capabilities).toEqual(["filesystem.read"]);
  });

  it("keeps untrusted-content protection on for remote principals when the local preset is off", () => {
    const e = withPreset("off");
    expect(gate(e, local, ["shell.execute"])).toEqual({ required: false });
    expect(gate(e, remote("d1"), ["shell.execute"])).toMatchObject({ required: true, rule: UNTRUSTED_CONTENT_RULE_ID });
    expect(gate(e, remote("d1"), ["browser.control"])).toMatchObject({ required: true });
    expect(e.remoteProfile.untrustedContent).toBe("require-approval");
    expect(e.approvals.untrustedContent).toBe("off");
  });

  it("defaults to require-approval for every principal without configuration", () => {
    const e = engine({ mode: "sandbox" });
    for (const ctx of [local, remote("d1")])
      expect(gate(e, ctx, ["browser.control"])).toMatchObject({ required: true, rule: UNTRUSTED_CONTENT_RULE_ID });
    expect(e.remoteProfile).toMatchObject({
      mode: "sandbox",
      untrustedContent: "require-approval",
      fullControl: { enabled: false },
    });
  });
});

describe("presets", () => {
  const gated: Capability[] = ["shell.execute", "filesystem.write", "git.write", "network.access"];

  it("require-approval (ask for every action): every effect, including browser control, is gated in an exposed session", () => {
    const e = withPreset("require-approval");
    for (const ctx of [local, remote("d1")]) {
      for (const c of [...gated, "browser.control" as const]) expect(gate(e, ctx, [c]).required).toBe(true);
      expect(gate(e, ctx, ["browser.control"], "browser.click", false)).toEqual({ required: false });
      expect(gate(e, ctx, ["filesystem.read"])).toEqual({ required: false });
    }
  });

  it("autonomous-browser: browser control runs without approval, also in an exposed session", () => {
    const e = withPreset("autonomous-browser");
    for (const ctx of [local, remote("d1")]) {
      for (const op of ["browser.click", "browser.type", "browser.navigate", "browser.tab_open", "browser.tab_close"])
        expect(gate(e, ctx, ["browser.control"], op)).toEqual({ required: false });
      expect(gate(e, ctx, ["browser.read"], "browser.page_read")).toEqual({ required: false });
    }
  });

  it("autonomous-browser: shell, filesystem write, Git write, network access and Docker Compose stay gated", () => {
    const e = withPreset("autonomous-browser");
    for (const ctx of [local, remote("d1")]) {
      for (const c of gated)
        expect(gate(e, ctx, [c])).toMatchObject({ required: true, rule: UNTRUSTED_CONTENT_RULE_ID });
      for (const op of ["docker.compose_up", "docker.compose_down"])
        expect(gate(e, ctx, ["shell.execute"], op)).toMatchObject({ required: true });
    }
  });

  it("autonomous-browser: a local file upload through the browser always needs approval, exposed or not", () => {
    const e = withPreset("autonomous-browser");
    for (const ctx of [local, remote("d1")])
      for (const exposed of [true, false])
        expect(gate(e, ctx, ["browser.control", "filesystem.read"], "browser.file_upload", exposed)).toMatchObject({
          required: true,
          rule: BROWSER_UPLOAD_RULE_ID,
        });
  });

  it("autonomous-browser gates every known browser operation that reads local files", () => {
    // Guard for future operations: a browser operation whose name suggests local file access must be gated by name.
    const fileOps = KNOWN_OPERATIONS.filter((op) => op.startsWith("browser.") && /file|upload/.test(op));
    const named = new Set(AUTONOMOUS_BROWSER_RULES.flatMap((r) => r.match.operations ?? []));
    for (const op of fileOps) expect(named.has(op)).toBe(true);
  });

  it("a clean session runs without approval in every preset (default remote profile)", () => {
    for (const preset of UNTRUSTED_CONTENT_SETTINGS) {
      const e = withPreset(preset);
      for (const ctx of [local, remote("d1")])
        expect(gate(e, ctx, ["shell.execute"], "process.exec", false)).toEqual({ required: false });
    }
  });

  it("user rules cannot take the ids of built-in rules", () => {
    const policy = createPermissionPolicy({ mode: "sandbox" });
    for (const id of [UNTRUSTED_CONTENT_RULE_ID, BROWSER_UPLOAD_RULE_ID, REMOTE_FULL_CONTROL_RULE_ID])
      expect(() => validateApprovalRules([{ id, match: { capabilities: ["shell.execute"] } }], policy)).toThrow(
        CrotError,
      );
  });
});

describe("remote full-control opt-in", () => {
  const optedIn = () =>
    engine({ mode: "sandbox" }, { remote: { fullControl: { deviceId: "d1", accountId: "acc-1" } } });

  it("is denied without the opt-in", () => {
    const e = engine({ mode: "full_control" });
    expect(e.authorize({ context: remote("d1"), capability: "filesystem.read", paths: [outside] }).allowed).toBe(false);
    expect(e.remoteProfile.fullControl).toEqual({ enabled: false });
  });

  it("changes real authorization outcomes for the remote clients of the bound device", () => {
    const e = optedIn();
    expect(e.authorize({ context: remote("d1"), capability: "filesystem.read", paths: [outside] }).allowed).toBe(true);
    expect(
      e.authorize({
        context: remote("d1", "acc-1", "another-client"),
        capability: "filesystem.write",
        paths: [outside],
      }).allowed,
    ).toBe(true);
    expect(e.modeFor(remote("d1"))).toBe("full_control");
  });

  it("never grants full control to another device, another account or a local principal", () => {
    const e = optedIn();
    for (const ctx of [remote("d2"), remote("d1", "acc-2")]) {
      expect(e.authorize({ context: ctx, capability: "filesystem.read", paths: [outside] }).allowed).toBe(false);
      expect(e.modeFor(ctx)).toBe("sandbox");
    }
    expect(e.authorize({ context: local, capability: "filesystem.read", paths: [outside] }).allowed).toBe(false);
    expect(e.modeFor(local)).toBe("sandbox");
    expect(e.mode).toBe("sandbox");
  });

  it("an empty device id never enables it", () => {
    const e = engine({ mode: "sandbox" }, { remote: { fullControl: { deviceId: "" } } });
    expect(e.authorize({ context: remote(""), capability: "filesystem.read", paths: [outside] }).allowed).toBe(false);
    expect(e.remoteProfile.fullControl.enabled).toBe(false);
  });

  it("keeps the shell commands of the bound device behind approval, even in a clean session", () => {
    const e = optedIn();
    expect(gate(e, remote("d1"), ["shell.execute"], "process.exec", false)).toMatchObject({
      required: true,
      rule: REMOTE_FULL_CONTROL_RULE_ID,
    });
    expect(gate(e, remote("d1"), ["process.manage", "shell.execute"], "process.start", false)).toMatchObject({
      required: true,
      rule: REMOTE_FULL_CONTROL_RULE_ID,
    });
    expect(gate(e, remote("d2"), ["shell.execute"], "process.exec", false)).toEqual({ required: false });
    expect(gate(e, local, ["shell.execute"], "process.exec", false)).toEqual({ required: false });
  });

  it("keeps untrusted-content protection for the bound device", () => {
    const e = engine(
      { mode: "sandbox" },
      { approvals: { rules: [], untrustedContent: "off" }, remote: { fullControl: { deviceId: "d1" } } },
    );
    expect(gate(e, remote("d1"), ["filesystem.write"])).toMatchObject({
      required: true,
      rule: UNTRUSTED_CONTENT_RULE_ID,
    });
    expect(gate(e, local, ["filesystem.write"])).toEqual({ required: false });
  });

  it("is reported with its device and restrictions", () => {
    const s = optedIn().remoteProfile;
    expect(s.mode).toBe("sandbox");
    expect(s.capabilities).not.toContain("filesystem.full");
    expect(s.fullControl).toMatchObject({ enabled: true, deviceId: "d1", accountId: "acc-1" });
    expect(s.fullControl.capabilities).toContain("filesystem.full");
    expect(s.restrictions.join(" ")).toMatch(/L1/);
    expect(s.restrictions.join(" ")).toMatch(/d1/);
  });
});

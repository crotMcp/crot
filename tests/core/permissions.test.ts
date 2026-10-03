import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../../src/core/permissions/capabilities.js";
import { PermissionEngine } from "../../src/core/permissions/engine.js";
import { createPermissionPolicy, SANDBOX_DEFAULT_CAPABILITIES } from "../../src/core/permissions/policy.js";
import type { ResolvedPath } from "../../src/core/workspace/workspace.js";
import { CrotError } from "../../src/core/errors.js";
import { testContext } from "../helpers.js";

const inside: ResolvedPath = { absolute: "/ws/a.txt", relative: "a.txt", insideWorkspace: true };
const outside: ResolvedPath = { absolute: "/etc/passwd", relative: null, insideWorkspace: false };

describe("permission policy", () => {
  it("uses sandbox defaults", () => {
    const policy = createPermissionPolicy({ mode: "sandbox" });
    expect([...policy.grants].sort()).toEqual([...SANDBOX_DEFAULT_CAPABILITIES].sort());
    expect(policy.grants.has("filesystem.full")).toBe(false);
  });

  it("grants every capability in full_control by default", () => {
    const policy = createPermissionPolicy({ mode: "full_control" });
    expect([...policy.grants].sort()).toEqual([...CAPABILITIES].sort());
  });

  it("rejects filesystem.full in sandbox mode", () => {
    expect(() =>
      createPermissionPolicy({ mode: "sandbox", capabilities: ["filesystem.read", "filesystem.full"] }),
    ).toThrow(CrotError);
  });

  it("honours an explicit capability subset", () => {
    const policy = createPermissionPolicy({ mode: "sandbox", capabilities: ["filesystem.read"] });
    expect([...policy.grants]).toEqual(["filesystem.read"]);
  });
});

describe("PermissionEngine", () => {
  it("allows granted capabilities inside the workspace", () => {
    const engine = new PermissionEngine(createPermissionPolicy({ mode: "sandbox" }));
    expect(engine.authorize({ context: testContext, capability: "filesystem.read", paths: [inside] })).toEqual({
      allowed: true,
    });
  });

  it("denies capabilities that are not granted", () => {
    const engine = new PermissionEngine(createPermissionPolicy({ mode: "sandbox", capabilities: ["filesystem.read"] }));
    const decision = engine.authorize({ context: testContext, capability: "filesystem.write", paths: [inside] });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.missing).toEqual(["filesystem.write"]);
  });

  it("denies paths outside the workspace in sandbox mode", () => {
    const engine = new PermissionEngine(createPermissionPolicy({ mode: "sandbox" }));
    const decision = engine.authorize({
      context: testContext,
      capability: "filesystem.read",
      paths: [inside, outside],
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.missing).toEqual(["filesystem.full"]);
  });

  it("allows paths outside the workspace in full_control mode", () => {
    const engine = new PermissionEngine(createPermissionPolicy({ mode: "full_control" }));
    expect(engine.authorize({ context: testContext, capability: "filesystem.write", paths: [outside] })).toEqual({
      allowed: true,
    });
  });

  it("still enforces the capability set in full_control mode", () => {
    const engine = new PermissionEngine(
      createPermissionPolicy({ mode: "full_control", capabilities: ["filesystem.read", "filesystem.full"] }),
    );
    expect(engine.authorize({ context: testContext, capability: "shell.execute" }).allowed).toBe(false);
    expect(engine.authorize({ context: testContext, capability: "filesystem.read", paths: [outside] }).allowed).toBe(
      true,
    );
  });
});

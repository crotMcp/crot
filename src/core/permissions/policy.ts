import { CrotError } from "../errors.js";
import { CAPABILITIES, type Capability } from "./capabilities.js";

/**
 * Permission modes (ARCHITECTURE.md §6).
 *
 * - sandbox: every path and working directory must be inside the workspace;
 *   full developer capabilities are available inside it.
 * - full_control: the user explicitly grants the full OS-level capabilities of
 *   the CROT process.
 */
export const PERMISSION_MODES = ["sandbox", "full_control"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Capabilities granted by default in SANDBOX mode. */
export const SANDBOX_DEFAULT_CAPABILITIES: readonly Capability[] = [
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "process.manage",
  "git.read",
  "git.write",
];

/** Capabilities that can never be granted in SANDBOX mode. */
export const SANDBOX_FORBIDDEN_CAPABILITIES: readonly Capability[] = ["filesystem.full"];

/** Immutable, validated permission policy. Created once, consumed by the PermissionEngine. */
export interface PermissionPolicy {
  readonly mode: PermissionMode;
  readonly grants: ReadonlySet<Capability>;
}

export interface PermissionPolicyInput {
  readonly mode: PermissionMode;
  /** Explicit capability set. When omitted, the mode's defaults apply. */
  readonly capabilities?: readonly Capability[];
}

export function createPermissionPolicy(input: PermissionPolicyInput): PermissionPolicy {
  const requested = input.capabilities ?? defaultCapabilities(input.mode);
  if (input.mode === "sandbox") {
    const forbidden = requested.filter((c) => SANDBOX_FORBIDDEN_CAPABILITIES.includes(c));
    if (forbidden.length > 0) {
      throw new CrotError(
        "CONFIG_ERROR",
        `Capabilities not allowed in sandbox mode: ${forbidden.join(", ")}. Use full_control mode to access paths outside the workspace.`,
      );
    }
  }
  return Object.freeze({ mode: input.mode, grants: new Set(requested) });
}

export function defaultCapabilities(mode: PermissionMode): readonly Capability[] {
  return mode === "full_control" ? CAPABILITIES : SANDBOX_DEFAULT_CAPABILITIES;
}

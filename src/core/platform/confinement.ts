/**
 * Core side of command confinement L1 (ARCHITECTURE.md §27 AD-20 point 11).
 *
 * The decision for the children of shell.execute and process.manage in
 * workspace (sandbox) mode, made in Core's process service before launch, from
 * the platform's reported L1 state. It runs inside the operation the
 * PermissionEngine already authorized and changes neither the
 * PermissionEngine nor approval semantics.
 */
import type { PrincipalKind } from "../auth/principal.js";
import { CrotError } from "../errors.js";
import type {
  ConfinementNetwork,
  ConfinementReason,
  ConfinementStatus,
  CoreConfinement,
  ProcessLauncher,
} from "./types.js";

export type ConfinementDecision =
  /** L1 is available: the command runs in the Core's sandbox. */
  | "confine"
  /** L1 does not apply (full_control) or is unavailable for a local principal: the command runs as before L1. */
  | "unconfined"
  /** L1 is unavailable and the principal is remote: refused before any process starts. */
  | "refuse";

/**
 * AD-20 point 11. `confinement` is undefined when L1 does not apply to this
 * Core (permission mode full_control).
 */
export function decideConfinement(
  status: ConfinementStatus | undefined,
  principal: PrincipalKind,
): ConfinementDecision {
  if (!status) return "unconfined";
  if (status.available) return "confine";
  return principal === "remote" ? "refuse" : "unconfined";
}

export function confinementUnavailableError(status: ConfinementStatus): CrotError {
  return new CrotError(
    "CONFINEMENT_UNAVAILABLE",
    `Command confinement L1 is not available on this machine (${status.reason ?? "unknown"}); ` +
      "shell and process operations of remote clients are refused in workspace mode.",
    { reason: status.reason, network: status.network },
  );
}

const NOT_IMPLEMENTED_DETAIL = "command confinement L1 is not implemented for this operating system";

export function notImplementedStatus(network: ConfinementNetwork): ConfinementStatus {
  return { mechanism: "none", available: false, network, reason: "not_implemented", detail: NOT_IMPLEMENTED_DETAIL };
}

/** A CoreConfinement that is never available (platforms without L1, and Cores without a platform mechanism). */
export function unavailableConfinement(
  network: ConfinementNetwork,
  reason: ConfinementReason = "not_implemented",
  detail: string = NOT_IMPLEMENTED_DETAIL,
): CoreConfinement {
  const status: ConfinementStatus = {
    mechanism: reason === "not_implemented" ? "none" : "linux-bubblewrap",
    available: false,
    network,
    reason,
    detail,
  };
  const refuse = async (): Promise<never> => {
    throw confinementUnavailableError(status);
  };
  const launcher: ProcessLauncher = {
    resolveCommand: refuse,
    launch: refuse,
    canTerminateOrphanedDescendants: false,
    processControl: { treeTermination: "process-group", orphanedDescendants: false, gracefulTermination: false },
  };
  return {
    status: () => status,
    refresh: async () => status,
    launcher,
    close: async () => undefined,
    closeSync: () => undefined,
  };
}

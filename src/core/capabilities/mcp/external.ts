/** External metadata/results are untrusted sources; effectful calls need normal Core authorization. */
import type { AuthContext } from "../../auth/principal.js";
import type { ExecutionGuard } from "../../execution/guard.js";
import type { Capability } from "../../permissions/capabilities.js";
export function executeExternalMcp<T>(
  guard: ExecutionGuard,
  context: AuthContext,
  capability: readonly Capability[],
  details: Readonly<Record<string, unknown>>,
  execute: () => Promise<T>,
): Promise<T> {
  return guard.run(context, { operation: "mcp.call", capability, details }, execute);
}

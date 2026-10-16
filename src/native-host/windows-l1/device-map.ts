/** Rejected experiment. Kept as a fail-closed tombstone for older internal callers. */
import { CrotError } from "../../core/errors.js";
/** No native calls, allocations, privilege changes, or process mutation are permitted. */
export function bindPrivatePipeMaps(): never {
  throw new CrotError("CONFINEMENT_UNAVAILABLE", "Private ProcessDeviceMap is not a supported Windows L1 mechanism.");
}

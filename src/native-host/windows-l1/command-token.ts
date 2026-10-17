/**
 * Unique write-filter token component. No common restricting SIDs: adding
 * Everyone/Builtin Users to make startup pass would reopen ambient Low writes.
 * This component alone does not supply a writable Medium workspace or L1.
 */
import { randomBytes } from "node:crypto";
import { validateSid } from "../validation.js";
import type { RestrictedToken, RestrictedTokenApi } from "./restricted-token.js";
export function createCommandToken(api: RestrictedTokenApi, ownerSid: string): RestrictedToken {
  validateSid(ownerSid);
  const n = randomBytes(16);
  const sid = `S-1-5-21-${n.readUInt32LE(0)}-${n.readUInt32LE(4)}-${n.readUInt32LE(8)}-${n.readUInt32LE(12)}`;
  const token = api.create(sid, false, undefined, "write-only");
  try {
    token.prepareProbeObjects(ownerSid);
    token.lowerProbeIntegrity();
    return token;
  } catch (error) {
    try {
      token.close();
    } catch {
      /* preserve original setup failure */
    }
    throw error;
  }
}

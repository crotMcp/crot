/** Protocol fixtures only: descriptors below are NOT Windows security evidence. */
import { newLeaseId, type LeasePlan, type LeaseObject } from "../../../src/native-host/windows-l1/lease-journal.js";
export function leasePlan(id = newLeaseId()): LeasePlan {
  const original = Buffer.alloc(24, 1).toString("base64"),
    planned = Buffer.alloc(24, 2).toString("base64");
  const objects: LeaseObject[] = ["ancestor", "workspace", "workspace-node"].map((role, i) => ({
    role: role as LeaseObject["role"],
    identity: {
      volume: "\\\\?\\Volume{00000000-0000-4000-8000-000000000001}\\",
      fileId: String(i + 1).padStart(16, "0"),
      creationTime: "0000000000000001",
      directory: i !== 2,
    },
    original,
    planned,
  }));
  return {
    version: 1,
    network: "off",
    id,
    profile: { name: `crot.l1.${id}`, sid: "S-1-15-2-1-2-3-4-5-6-7" },
    workspace: "C:\\project",
    objects,
  };
}

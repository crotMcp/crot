import { describe, expect, it } from "vitest";
import type { LeaseObject } from "../../../src/native-host/windows-l1/lease-journal.js";
import {
  restoredWorkspaceLinkAlias,
  validateNativeLeaseDelta,
} from "../../../src/native-host/windows-l1/lease-native.js";
const sid = "S-1-15-2-1-2-3-4-5-6-7";
function object(deny = 0x000d0156, allow = 0x1200a9, flags = 0): LeaseObject {
  const base = Buffer.alloc(52);
  base[0] = 1;
  base.writeUInt16LE(0x8004, 2);
  base.writeUInt32LE(20, 4);
  base.writeUInt32LE(32, 8);
  base.writeUInt32LE(44, 16);
  base[20] = base[32] = 1;
  base[21] = base[33] = 1;
  base[44] = 2;
  base.writeUInt16LE(8, 46);
  const ace = (type: number, mask: number) => {
    const b = Buffer.alloc(48);
    b[0] = type;
    b[1] = flags;
    b.writeUInt16LE(48, 2);
    b.writeUInt32LE(mask, 4);
    b[8] = 1;
    b[9] = 8;
    b[15] = 15;
    [2, 1, 2, 3, 4, 5, 6, 7].forEach((v, i) => b.writeUInt32LE(v, 16 + i * 4));
    return b;
  };
  const planned = Buffer.concat([base, ace(1, deny), ace(0, allow)]);
  planned.writeUInt16LE(104, 46);
  planned.writeUInt16LE(2, 48);
  return {
    role: "workspace-link",
    identity: {
      volume: "\\\\?\\Volume{00000000-0000-4000-8000-000000000001}\\",
      fileId: "0000000000000001",
      creationTime: "0000000000000001",
      directory: false,
      links: 2,
    },
    original: base.toString("base64"),
    planned: planned.toString("base64"),
  };
}
describe("identity-only external hardlink recovery is strictly read-only", () => {
  it("accepts only the exact noninheriting write/delete/DAC/owner deny plus RX pair", () => {
    expect(() => validateNativeLeaseDelta(object(), sid)).not.toThrow();
  });
  it.each([
    [0, 0x1200a9, 0],
    [0x000d0156, 0x1301bf, 0],
    [0x000d0156, 0x1200a9, 3],
  ])("refuses weakened or inheriting ACEs %j/%j/%j", (deny, allow, flags) => {
    expect(() => validateNativeLeaseDelta(object(deny, allow, flags), sid)).toThrow("read-only hardlink ACE delta");
  });
  it("does not exempt a directory or a single-link identity", () => {
    for (const identity of [
      { directory: true, links: 2 },
      { directory: false, links: 1 },
    ]) {
      const o = object();
      expect(() => validateNativeLeaseDelta({ ...o, identity: { ...o.identity, ...identity } }, sid)).toThrow(
        "read-only hardlink identity",
      );
    }
  });
  it("permits an outside alias only for an unchanged, exactly restored read-only original", () => {
    const saved = object(),
      current = { ...saved, role: "workspace-node" as const };
    expect(restoredWorkspaceLinkAlias(saved, current, saved.original, 2)).toBe(true);
    expect(restoredWorkspaceLinkAlias(undefined, current, saved.original, 2)).toBe(false);
    expect(restoredWorkspaceLinkAlias(saved, current, saved.planned, 2)).toBe(false);
    expect(restoredWorkspaceLinkAlias(saved, current, saved.original, 3)).toBe(false);
    expect(restoredWorkspaceLinkAlias({ ...saved, role: "workspace-node" }, current, saved.original, 2)).toBe(false);
    expect(
      restoredWorkspaceLinkAlias(
        saved,
        { ...current, identity: { ...current.identity, creationTime: "0000000000000009" } },
        saved.original,
        2,
      ),
    ).toBe(false);
  });
});

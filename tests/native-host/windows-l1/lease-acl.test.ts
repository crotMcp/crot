import { describe, expect, it } from "vitest";
import {
  leaseDescriptor,
  leaseFileIdDescriptor,
  prepareNewWorkspaceSidRemoval,
} from "../../../src/native-host/windows-l1/lease-acl.js";
function sd() {
  const b = Buffer.alloc(52);
  b[0] = 1;
  b.writeUInt16LE(0x8004, 2);
  b.writeUInt32LE(20, 4);
  b.writeUInt32LE(32, 8);
  b.writeUInt32LE(44, 16);
  b[20] = b[32] = 1;
  b[21] = b[33] = 1;
  b[44] = 2;
  b.writeUInt16LE(8, 46);
  return b;
}
describe("bounded self-relative lease descriptor parser", () => {
  it("accepts a structurally bounded O/G/DACL descriptor without changing its bytes", () => {
    const b = sd(),
      before = Buffer.from(b),
      p = leaseDescriptor(b);
    expect(p.owner).toHaveLength(12);
    expect(p.group).toHaveLength(12);
    expect(p.dacl).toHaveLength(8);
    expect(p.control).toBe(0x8004);
    expect(b).toEqual(before);
  });
  it("accepts exact owner/group SID aliasing in a valid relative descriptor", () => {
    const b = sd();
    b.writeUInt32LE(20, 8);
    const p = leaseDescriptor(b);
    expect(p.owner).toEqual(p.group);
  });

  it("uses the 24-byte Win10 union ABI even for a 64-bit NTFS FileId", () => {
    const id = leaseFileIdDescriptor("1234567890abcdef");
    expect(id).toHaveLength(24);
    expect(id.readUInt32LE(0)).toBe(24);
    expect(id.readUInt32LE(4)).toBe(0);
    expect(id.readBigUInt64LE(8)).toBe(0x1234567890abcdefn);
    expect(id.readBigUInt64LE(16)).toBe(0n);
    expect(() => leaseFileIdDescriptor("../file")).toThrow();
  });
  it.each(["short-SID", "large-SID", "unknown-ACE", "object-flags"])("rejects native-unsafe ACE payload %s", (kind) => {
    const b = Buffer.concat([sd(), Buffer.alloc(20)]);
    b.writeUInt16LE(28, 46);
    b.writeUInt16LE(1, 48);
    b[52] = 0;
    b.writeUInt16LE(20, 54);
    b[60] = 1;
    b[61] = 1;
    if (kind === "short-SID") b.writeUInt16LE(8, 54);
    if (kind === "large-SID") b[61] = 15;
    if (kind === "unknown-ACE") b[52] = 254;
    if (kind === "object-flags") {
      b[52] = 5;
      b.writeUInt32LE(4, 60);
    }
    expect(() => leaseDescriptor(b)).toThrow();
  });
  it.each([
    "short",
    "absolute",
    "revision",
    "offset",
    "SID-count",
    "overlap",
    "ACL-size",
    "ACL-count",
    "ACL-revision",
    "null-DACL",
  ])("refuses %s without calling native code", (kind) => {
    let b = sd();
    if (kind === "short") b = b.subarray(0, 10);
    if (kind === "absolute") b.writeUInt16LE(4, 2);
    if (kind === "revision") b[0] = 2;
    if (kind === "offset") b.writeUInt32LE(0xfffffffc, 4);
    if (kind === "SID-count") b[21] = 16;
    if (kind === "overlap") b.writeUInt32LE(24, 8);
    if (kind === "ACL-size") b.writeUInt16LE(65535, 46);
    if (kind === "ACL-count") b.writeUInt16LE(1, 48);
    if (kind === "ACL-revision") b[44] = 1;
    if (kind === "null-DACL") b.writeUInt32LE(0, 16);
    expect(() => leaseDescriptor(b)).toThrow();
  });
});

describe("exact owned-SID cleanup planning (pure bytes, not native proof)", () => {
  const packageSid = "S-1-15-2-1-2-3-4-5-6-7";
  function fixture() {
    const bin = (last: number) => {
      const b = Buffer.alloc(40);
      b[0] = 1;
      b[1] = 8;
      b[7] = 15;
      [2, 1, 2, 3, 4, 5, 6, last].forEach((v, i) => b.writeUInt32LE(v, 8 + i * 4));
      return b;
    };
    const ace = (last: number, type = 0) => {
      const offset = type === 5 ? 28 : 8,
        b = Buffer.alloc(offset + 40);
      b[0] = type;
      b[1] = 0x13;
      b.writeUInt16LE(b.length, 2);
      b.writeUInt32LE(0x1301bf, 4);
      if (type === 5) {
        b.writeUInt32LE(1, 8);
        b.fill(0x4f, 12, 28);
      }
      bin(last).copy(b, offset);
      return b;
    };
    const foreign = ace(8),
      own = ace(7),
      objectOwn = ace(7, 5),
      tail = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const old = sd(),
      b = Buffer.concat([old, foreign, own, objectOwn, tail]);
    b.writeUInt16LE(b.length - 44, 46);
    b.writeUInt16LE(3, 48);
    const identity = {
      volume: "\\\\?\\Volume{00000000-0000-4000-8000-000000000001}\\",
      fileId: "0000000000000001",
      creationTime: "0000000000000001",
      directory: false,
    };
    return {
      object: {
        identity,
        role: "workspace-node" as const,
        original: b.toString("base64"),
        planned: b.toString("base64"),
      },
      b,
      foreign,
      tail,
    };
  }
  it("removes simple/object own ACEs and preserves foreign ACE plus unused tail exactly", () => {
    const f = fixture(),
      before = leaseDescriptor(f.b),
      p = prepareNewWorkspaceSidRemoval(f.object, packageSid),
      after = leaseDescriptor(Buffer.from(p.planned, "base64"));
    expect(after.dacl.readUInt16LE(4)).toBe(1);
    expect(after.dacl.subarray(8)).toEqual(Buffer.concat([f.foreign, f.tail]));
    expect(after.control).toBe(before.control);
    expect(after.rmControl).toBe(before.rmControl);
    for (const key of ["owner", "group", "sacl"] as const) expect(after[key]).toEqual(before[key]);
    expect(p.original).toBe(f.object.original);
    expect(p.identity).toEqual(f.object.identity);
    expect(prepareNewWorkspaceSidRemoval({ ...p, original: p.planned }, packageSid).planned).toBe(p.planned);
  });
  it("returns identical original bytes when no trustee SID matches", () => {
    const f = fixture();
    expect(prepareNewWorkspaceSidRemoval(f.object, "S-1-15-2-9-9-9-9-9-9-9").planned).toBe(f.object.original);
  });
  it.each(["S-1-1-0", "S-1-15-2-01-2-3-4-5-6-7", "S-1-15-2-4294967296-2-3-4-5-6-7"])(
    "refuses unsafe cleanup SID %s",
    (sid) => {
      expect(() => prepareNewWorkspaceSidRemoval(fixture().object, sid)).toThrow();
    },
  );
  it("refuses non-workspace-node roles and malformed descriptors", () => {
    const f = fixture();
    expect(() => prepareNewWorkspaceSidRemoval({ ...f.object, role: "runtime-node" }, packageSid)).toThrow("role");
    expect(() =>
      prepareNewWorkspaceSidRemoval({ ...f.object, original: Buffer.alloc(20).toString("base64") }, packageSid),
    ).toThrow();
  });
});

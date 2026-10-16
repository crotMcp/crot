import { describe, expect, it } from "vitest";
import { leaseDescriptor } from "../../../src/native-host/windows-l1/lease-acl.js";
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

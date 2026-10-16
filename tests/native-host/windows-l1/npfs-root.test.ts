import { describe, expect, it } from "vitest";
import { NPFS_CREATE_MASK, npfsGrantDescriptor } from "../../../src/native-host/windows-l1/npfs-root.js";
const sid = "S-1-15-2-1-2-3-4-5-6-7";
describe("qualification-only NPFS grant admission", () => {
  it("grants only create-instance, read-attributes and synchronize without inheritance", () => {
    expect(NPFS_CREATE_MASK).toBe(0x100084);
    expect(NPFS_CREATE_MASK & 3).toBe(0);
    expect(npfsGrantDescriptor("D:P(D;;GA;;;AN)(A;;GA;;;SY)(A;ID;GR;;;BU)", sid)).toBe(
      `D:P(D;;GA;;;AN)(A;;GA;;;SY)(A;;0x100084;;;${sid})(A;ID;GR;;;BU)`,
    );
  });
  it.each(["S-1-5-32-545", "S-1-15-2-1", "S-1-15-2-1-2-3-4-5-6-7)(A;;GA;;;WD)"])(
    "refuses non-package or injected identity %s",
    (bad) => {
      expect(() => npfsGrantDescriptor("D:(A;;GA;;;SY)", bad)).toThrow();
    },
  );
  it.each(["D:", "D:NO_ACCESS_CONTROL", "S:(ML;;NW;;;LW)", "D:(XA;;GA;;;SY;(condition))", `D:(A;;GR;;;${sid})`])(
    "refuses an ambiguous or already-owned descriptor %s",
    (before) => {
      expect(() => npfsGrantDescriptor(before, sid)).toThrow();
    },
  );
});

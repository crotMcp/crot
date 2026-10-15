import { describe, expect, it } from "vitest";
import { directoryProbeMasks, parseDirectoryAccess } from "./directory-access.js";
const row = (depth: number) => ({
  depth,
  attributeError: depth ? 5 : 0,
  opens: directoryProbeMasks.map((mask) => ({ mask, error: depth ? 5 : 0, closeError: 0 })),
});
describe("fixed native directory-access evidence", () => {
  it("retains distinct attribute, traverse, list and each write-mask result", () => {
    const rows = [row(0), row(1)];
    expect(parseDirectoryAccess(JSON.stringify({ directoryAccess: rows }))).toEqual(rows);
  });
  it.each([[], Array.from({ length: 65 }, (_, i) => row(i)), [row(1)]])("rejects invalid bounds/depth", (rows) => {
    expect(() => parseDirectoryAccess(JSON.stringify({ directoryAccess: rows }))).toThrow();
  });
  it("rejects omitted or reordered masks rather than inferring a denial", () => {
    const missing = row(0);
    missing.opens.pop();
    expect(() => parseDirectoryAccess(JSON.stringify({ directoryAccess: [missing] }))).toThrow();
    const swapped = row(0);
    swapped.opens.reverse();
    expect(() => parseDirectoryAccess(JSON.stringify({ directoryAccess: [swapped] }))).toThrow();
  });
  it.each([-1, 1.5, 0x100000000, "5", null])("rejects invalid error code %s", (error) => {
    const invalid = { ...row(0), attributeError: error };
    expect(() => parseDirectoryAccess(JSON.stringify({ directoryAccess: [invalid] }))).toThrow();
  });
  it("preserves an opened write handle and failed close as failures, not denied access", () => {
    const actual = row(1);
    actual.depth = 0;
    actual.opens[3] = { mask: 2, error: 0, closeError: 6 };
    expect(parseDirectoryAccess(JSON.stringify({ directoryAccess: [actual] }))[0]!.opens[3]).toEqual({
      mask: 2,
      error: 0,
      closeError: 6,
    });
  });
});

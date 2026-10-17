/** Portable read-only ABI/fault checks; not native Windows evidence. */
import { describe, expect, it, vi } from "vitest";
import {
  snapshotWorkspaceDescriptor,
  snapshotWorkspaceDescriptorDetails,
} from "./diagnostics/workspace-view-security.js";
function fixture(sddl = "O:SYD:P(A;;FA;;;SY)S:(ML;;NW;;;ME)") {
  let fault = false;
  const get = vi.fn((_name, _kind, _flags, _o, _g, _d, _s, out) => {
    out.value = 4n;
    return 0;
  });
  const text = vi.fn((_sd, _rev, _flags, out, length) => {
    out.value = 8n;
    length.value = sddl.length + 1;
    return 1;
  });
  const free = vi.fn(() => (fault ? 8n : null));
  const ffi = {
    struct: () => undefined,
    load: () => ({
      func: (s: string) => {
        if (s.includes("GetNamedSecurityInfoW(")) return get;
        if (s.includes("ConvertSecurityDescriptorToStringSecurityDescriptorW(")) return text;
        if (s.includes("LocalFree(")) return free;
        throw Error("unexpected ABI");
      },
    }),
    decode: { string16: vi.fn(() => sddl) },
  };
  return {
    ffi,
    get,
    text,
    free,
    setFault: (f: boolean) => {
      fault = f;
    },
  };
}
describe("workspace original security snapshot", () => {
  it("returns only section/ACE hashes and non-principal flags in opt-in detail mode", () => {
    const sid = "S-1-5-21-1-2-3-1000";
    const f = fixture(`O:${sid}G:SYD:PAI(A;;FA;;;${sid})(D;;FW;;;SY)S:(ML;;NW;;;ME)`);
    const result = snapshotWorkspaceDescriptorDetails(f.ffi, "C:\\workspace");
    expect(Object.keys(result.sections).sort()).toEqual(["D", "G", "O", "S"]);
    expect(result.daclFlags).toBe("PAI");
    expect(result.daclAceHashes).toHaveLength(2);
    for (const h of [...Object.values(result.sections), ...result.daclAceHashes]) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain(sid);
    expect(JSON.stringify(result)).not.toContain("(A;");
    expect(f.free).toHaveBeenCalledTimes(2);
  });
  it("queries LABEL but serializes SACL, includes owner/group/DACL, emits only hash and Medium boolean", () => {
    const f = fixture();
    const result = snapshotWorkspaceDescriptor(f.ffi, "C:\\workspace");
    expect(f.get.mock.calls[0]?.[2]).toBe(0x17);
    expect(f.text.mock.calls[0]?.[2]).toBe(0x0f);
    expect(Object.keys(result).sort()).toEqual(["fingerprint", "medium"]);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.medium).toBe(true);
    expect(f.free).toHaveBeenCalledTimes(2);
  });
  it("accepts successful implicit Medium readback but rejects actual Low and fails actual query errors", () => {
    expect(snapshotWorkspaceDescriptor(fixture("O:SYD:P(A;;FA;;;SY)").ffi, "C:\\workspace").medium).toBe(true);
    expect(snapshotWorkspaceDescriptor(fixture("O:SYD:P(A;;FA;;;SY)S:(ML;;NW;;;LW)").ffi, "C:\\workspace").medium).toBe(
      false,
    );
    const f = fixture();
    f.get.mockReturnValueOnce(5);
    expect(() => snapshotWorkspaceDescriptor(f.ffi, "C:\\workspace")).toThrow("query failed");
    expect(f.ffi.decode.string16).not.toHaveBeenCalled();
  });
  it("rejects failed encoding rather than treating it as implicit Medium", () => {
    const f = fixture();
    f.text.mockImplementationOnce((_sd, _rev, _flags, out, length) => {
      out.value = 8n;
      length.value = 10;
      return 0;
    });
    expect(() => snapshotWorkspaceDescriptor(f.ffi, "C:\\workspace")).toThrow("encoding failed");
    expect(f.ffi.decode.string16).not.toHaveBeenCalled();
    expect(f.free).toHaveBeenCalledTimes(2);
  });
  it("retains exact failed frees and blocks allocation until release succeeds", () => {
    const f = fixture();
    f.setFault(true);
    expect(() => snapshotWorkspaceDescriptor(f.ffi, "C:\\workspace")).toThrow("release failed");
    expect(() => snapshotWorkspaceDescriptor(f.ffi, "C:\\workspace")).toThrow("release failed");
    expect(f.get).toHaveBeenCalledOnce();
    f.setFault(false);
    expect(snapshotWorkspaceDescriptor(f.ffi, "C:\\workspace").medium).toBe(true);
    expect(f.get).toHaveBeenCalledTimes(2);
  });
});

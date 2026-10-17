/** Native ABI/resource fault fixtures only, not a kernel/network qualification. */
import { describe, expect, it, vi } from "vitest";
import { bindAppContainerNetworkNative } from "../../../src/native-host/windows-l1/network-native.js";
import type { TokenFfi } from "../../../src/native-host/windows-l1/restricted-token.js";
const sid = "S-1-15-2-1-2-3-4-5-6-7";
function fixture() {
  type Row = { Sid: { sid: string }; Attributes: number };
  let rows: Row[] = [{ Sid: { sid }, Attributes: 4 }];
  const outer = {},
    processHeap = {},
    freed: unknown[] = [];
  const get = vi.fn((count: { value?: number }, output: { value?: unknown }) => {
    count.value = rows.length;
    output.value = outer;
    return 0;
  });
  const heapFree = vi.fn((_heap: unknown, _flags: unknown, pointer: unknown) => {
    freed.push(pointer);
    return 1;
  });
  const localFree = vi.fn((_pointer: unknown): unknown => null);
  const text = vi.fn((pointer: unknown, output: { value?: unknown }) => {
    output.value = pointer;
    return 1;
  });
  const decode = vi.fn((pointer: unknown, type: string): unknown =>
    type === "char16_t" ? (pointer as { sid: string }).sid : rows,
  );
  const functions = {
    NetworkIsolationGetAppContainerConfig: get,
    GetProcessHeap: () => processHeap,
    HeapFree: heapFree,
    LocalFree: localFree,
    IsValidSid: () => 1,
    ConvertSidToStringSidW: text,
  };
  const loads: string[] = [];
  const ffi = {
    load: (name: string) => {
      loads.push(name);
      return {
        func: (signature: string) => {
          const name = Object.keys(functions).find((n) => signature.includes(n + "("));
          if (!name) throw new Error(signature);
          return functions[name as keyof typeof functions];
        },
      };
    },
    struct: vi.fn(),
    sizeof: (type: string) => (type.includes("SID_ATTRIBUTES") ? 16 : 8),
    decode,
  } as unknown as TokenFfi & { decode(pointer: unknown, type: string, length?: number): unknown };
  const run = vi.fn(async (_file: string, args: readonly string[]) => {
    rows = args.includes("-a") ? [{ Sid: { sid }, Attributes: 4 }] : [];
    return "OK";
  });
  const native = bindAppContainerNetworkNative(ffi, "C:\\Windows", run);
  return {
    native,
    rows,
    outer,
    processHeap,
    freed,
    get,
    heapFree,
    localFree,
    text,
    decode,
    run,
    loads,
    empty: () => {
      rows = [];
    },
  };
}
describe("Windows loopback API ownership (injected)", () => {
  it("frees each SID with process HeapFree and outer array last, text with LocalFree", async () => {
    const f = fixture();
    expect(await f.native.contains(sid)).toBe(true);
    expect(f.freed).toEqual([f.rows[0]!.Sid, f.outer]);
    expect(f.heapFree.mock.calls.every(([heap, flags]) => heap === f.processHeap && flags === 0)).toBe(true);
    expect(f.localFree).toHaveBeenCalledExactlyOnceWith(f.rows[0]!.Sid);
  });
  it("frees a nonnull empty output array without trying to decode inner pointers", async () => {
    const f = fixture();
    f.empty();
    expect(await f.native.contains(sid)).toBe(false);
    expect(f.decode).not.toHaveBeenCalled();
    expect(f.freed).toEqual([f.outer]);
  });
  it("uses only absolute system libraries and exact per-SID tool arguments", async () => {
    const f = fixture();
    await f.native.remove(sid);
    await f.native.add(sid);
    expect(f.run.mock.calls).toEqual([
      ["C:\\Windows\\System32\\CheckNetIsolation.exe", ["LoopbackExempt", "-d", `-p=${sid}`]],
      ["C:\\Windows\\System32\\CheckNetIsolation.exe", ["LoopbackExempt", "-a", `-p=${sid}`]],
    ]);
    expect(f.loads).toEqual(
      ["kernel32.dll", "advapi32.dll", "FirewallAPI.dll"].map((n) => `C:\\Windows\\System32\\${n}`),
    );
  });
  it("does not accept a failed tool exit as a successful exemption change", async () => {
    const f = fixture();
    f.run.mockRejectedValueOnce(new Error("Access denied"));
    await expect(f.native.remove(sid)).rejects.toThrow("host preparation or privilege required");
    expect(await f.native.contains(sid)).toBe(true);
  });
  it("retains failed heap frees and retries only the still-owned allocation", async () => {
    const f = fixture();
    f.heapFree.mockReturnValueOnce(0);
    await expect(f.native.contains(sid)).rejects.toThrow("configuration release");
    expect(await f.native.contains(sid)).toBe(true);
    expect(f.heapFree.mock.calls.slice(0, 3).map((v) => v[2])).toEqual([f.rows[0]!.Sid, f.rows[0]!.Sid, f.outer]);
  });
  it("retains failed LocalFree and does not silently abandon SID text", async () => {
    const f = fixture();
    f.localFree.mockReturnValueOnce({ failed: true });
    await expect(f.native.contains(sid)).rejects.toThrow("SID text release");
    expect(await f.native.contains(sid)).toBe(true);
    expect(f.localFree.mock.calls.slice(0, 2).map((v) => v[0])).toEqual([f.rows[0]!.Sid, f.rows[0]!.Sid]);
  });
  it("frees known outputs when SID conversion fails", async () => {
    const f = fixture();
    f.text.mockImplementationOnce((pointer, output) => {
      output.value = pointer;
      return 0;
    });
    await expect(f.native.contains(sid)).rejects.toThrow("configuration SID text");
    expect(f.localFree).toHaveBeenCalledOnce();
    expect(f.freed).toEqual([f.rows[0]!.Sid, f.outer]);
  });
  it.each(["error", "bounds", "decode"])(
    "blocks after ambiguous %s output instead of traversing unknown pointers",
    async (kind) => {
      const f = fixture();
      if (kind === "error")
        f.get.mockImplementationOnce((count, output) => {
          count.value = f.rows.length;
          output.value = f.outer;
          return 5;
        });
      if (kind === "bounds")
        f.get.mockImplementationOnce((count, output) => {
          count.value = 1000000;
          output.value = f.outer;
          return 0;
        });
      if (kind === "decode")
        f.decode.mockImplementationOnce(() => {
          throw new Error("bad output");
        });
      await expect(f.native.contains(sid)).rejects.toThrow();
      await expect(f.native.contains(sid)).rejects.toThrow("unknown configuration output");
      expect(f.get).toHaveBeenCalledOnce();
      expect(f.heapFree).not.toHaveBeenCalled();
    },
  );
});

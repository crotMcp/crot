import { describe, expect, it, vi } from "vitest";
import { bindWindowsLeaseLock } from "../../../src/native-host/windows-l1/lease-lock.js";
import type { TokenFfi } from "../../../src/native-host/windows-l1/restricted-token.js";
function fixture() {
  let lastHandle = 0;
  const create = vi.fn(() => ++lastHandle),
    close = vi.fn((_handle: unknown) => 1);
  const info = vi.fn((_h: unknown, b: Buffer) => {
    b.writeUInt32LE(1, 40);
    return 1;
  });
  const flags = vi.fn((_h: unknown, b: Buffer) => {
    b.writeUInt32LE(0, 0);
    return 1;
  });
  const ffi = {
    load: () => ({
      func: (s: string) =>
        s.includes("CreateFileW")
          ? create
          : s.includes("GetFileInformationByHandle")
            ? info
            : s.includes("GetHandleInformation")
              ? flags
              : close,
    }),
  } as unknown as TokenFfi;
  return { create, close, info, flags, lock: bindWindowsLeaseLock(ffi, "kernel32.dll") };
}
describe("Windows lease lock ownership (injected API, not kernel evidence)", () => {
  it("requests data access + zero sharing, OPEN_EXISTING and no inherited handle", async () => {
    const f = fixture(),
      lock = await f.lock("C:\\private\\lease.lock");
    expect(f.create).toHaveBeenCalledWith("C:\\private\\lease.lock", 0xc0000000, 0, null, 3, 0x200000, null);
    lock.close();
    lock.close();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it.each(["reparse", "directory", "hardlink", "inheritance", "query"])(
    "rejects %s before ownership is returned",
    async (kind) => {
      const f = fixture();
      if (kind === "inheritance")
        f.flags.mockImplementation((_h, b) => {
          b.writeUInt32LE(1);
          return 1;
        });
      else
        f.info.mockImplementation((_h, b) => {
          b.writeUInt32LE(kind === "hardlink" ? 2 : 1, 40);
          b.writeUInt32LE(kind === "reparse" ? 0x400 : kind === "directory" ? 0x10 : 0);
          return kind === "query" ? 0 : 1;
        });
      await expect(f.lock("C:\\private\\lease.lock")).rejects.toThrow();
      expect(f.close).toHaveBeenCalledTimes(1);
    },
  );
  it("retains setup-release failures and retries before another acquisition", async () => {
    const f = fixture();
    f.info.mockReturnValueOnce(0);
    f.close.mockReturnValueOnce(0);
    await expect(f.lock("C:\\private\\lease.lock")).rejects.toThrow();
    const lock = await f.lock("C:\\private\\lease.lock");
    expect(f.close.mock.calls[1]![0]).toBe(1);
    lock.close();
  });
  it("does not auto-close an explicit owner's handle after its failed close", async () => {
    const f = fixture(),
      first = await f.lock("C:\\private\\lease.lock");
    f.close.mockReturnValueOnce(0);
    expect(() => first.close()).toThrow();
    const second = await f.lock("C:\\other\\lease.lock");
    expect(f.close).toHaveBeenCalledTimes(1);
    first.close();
    second.close();
    expect(f.close.mock.calls.map((c) => c[0])).toEqual([1, 1, 2]);
  });
});

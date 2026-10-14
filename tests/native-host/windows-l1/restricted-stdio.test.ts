/** Portable ownership/allowlist tests. Not native ABI or sandbox proof. */
import { expect, it, vi } from "vitest";
import { bindNulProcessCreation } from "../../../src/native-host/windows-l1/restricted-stdio.js";
import type { TokenFfi } from "../../../src/native-host/windows-l1/restricted-token.js";

function fixture(fail?: string) {
  let error = 0;
  const calls = new Map<string, ReturnType<typeof vi.fn>>();
  const fn = (name: string, body: (...args: unknown[]) => unknown) => calls.set(name, vi.fn(body));
  fn("GetLastError", () => error);
  fn("CreateFileW", () => (fail === "open" ? 0xffffffffffffffffn : 42n));
  fn("SetHandleInformation", () => (fail === "inherit" ? ((error = 5), 0) : 1));
  fn("InitializeProcThreadAttributeList", (list, _count, _flags, size) => {
    (size as { value: number }).value = 64;
    if (list === null) {
      error = 122;
      return 0;
    }
    return fail === "initialize" ? ((error = 5), 0) : 1;
  });
  fn("UpdateProcThreadAttribute", () => (fail === "allowlist" ? ((error = 5), 0) : 1));
  fn("DeleteProcThreadAttributeList", () => undefined);
  fn("CreateProcessAsUserW", () => (fail === "create" ? ((error = 5), 0) : 1));
  fn("CloseHandle", () => (fail === "close" ? ((error = 6), 0) : 1));
  const ffi: TokenFfi = {
    struct: () => undefined,
    sizeof: (name) => (name.endsWith("EXTENDED") ? 112 : name.endsWith("INFORMATION") ? 24 : 104),
    encode: (buffer, type, value) => {
      expect(type).toBe("void *");
      buffer.writeBigUInt64LE(value as bigint);
    },
    load: () => ({
      func: (signature) => {
        const name = /\b(\w+)\(/.exec(signature)?.[1];
        const call = name ? calls.get(name) : undefined;
        if (!call) throw new Error("Unrecognized owned API declaration.");
        return call;
      },
    }),
  };
  const create = bindNulProcessCreation(ffi, { kernel32: "test-kernel", advapi32: "test-advapi" });
  return {
    calls,
    launch: () => create(1n, "C:\\owned.exe", Buffer.alloc(8), 0x08000404, Buffer.alloc(8), "C:\\work", {}),
  };
}

it("inherits only the fixed owned NUL handle and releases all parent-side resources", () => {
  const f = fixture();
  f.launch();
  expect(f.calls.get("CreateFileW")).toHaveBeenCalledWith("\\\\.\\NUL", 0xc0000000, 3, null, 3, 0x80, null);
  const update = f.calls.get("UpdateProcThreadAttribute")!.mock.calls[0]!;
  expect(update[2]).toBe(0x20002);
  expect((update[3] as Buffer).readBigUInt64LE()).toBe(42n);
  expect(update[4]).toBe(8);
  const args = f.calls.get("CreateProcessAsUserW")!.mock.calls[0]!;
  expect(args[5]).toBe(1);
  expect(args[6]).toBe(0x08080404);
  expect(args[9]).toMatchObject({
    startup: { cb: 112, dwFlags: 0x100, hStdInput: 42n, hStdOutput: 42n, hStdError: 42n },
  });
  expect(f.calls.get("DeleteProcThreadAttributeList")).toHaveBeenCalledOnce();
  expect(f.calls.get("CloseHandle")).toHaveBeenCalledExactlyOnceWith(42n);
});

it.each(["open", "inherit", "initialize", "allowlist", "create", "close"])(
  "fails closed and releases owned resources on %s failure",
  (stage) => {
    const f = fixture(stage);
    expect(f.launch).toThrow();
    if (["open", "inherit", "initialize", "allowlist"].includes(stage))
      expect(f.calls.get("CreateProcessAsUserW")).not.toHaveBeenCalled();
    if (stage === "open") expect(f.calls.get("CloseHandle")).not.toHaveBeenCalled();
    else expect(f.calls.get("CloseHandle")).toHaveBeenCalledExactlyOnceWith(42n);
    if (["allowlist", "create", "close"].includes(stage))
      expect(f.calls.get("DeleteProcThreadAttributeList")).toHaveBeenCalledOnce();
    else expect(f.calls.get("DeleteProcThreadAttributeList")).not.toHaveBeenCalled();
  },
);

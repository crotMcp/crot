/** Portable ownership/allowlist tests. Not native ABI or sandbox proof. */
import { expect, it, vi } from "vitest";
import { createNativeByteStdio, type BytePipeApi } from "../../../src/native-host/windows-l1/byte-stdio.js";
import {
  bindPipeProcessCreation,
  bindNulProcessCreation,
} from "../../../src/native-host/windows-l1/restricted-stdio.js";
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
    ffi,
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

async function byteFixture(fail?: string) {
  const f = fixture(fail);
  let n = 0;
  const api: BytePipeApi = {
    create: async () => {
      const child = BigInt(++n * 2);
      return {
        parent: child + 100n,
        child,
        read: () => {
          throw new Error("unexpected read");
        },
        write: () => {
          throw new Error("unexpected write");
        },
        closeParent: vi.fn(),
        closeChild: vi.fn(),
      };
    },
  };
  const io = await createNativeByteStdio(api, "S-1-5-21-1-2-3-1000");
  const create = bindPipeProcessCreation(f.ffi, { kernel32: "test-kernel", advapi32: "test-advapi" });
  return {
    ...f,
    io,
    launch: () => create(1n, "C:\\owned.exe", Buffer.alloc(8), 0x08000404, Buffer.alloc(8), "C:\\work", {}, io),
  };
}
it("inherits exactly three branded child handles; clears inheritance without yielding", async () => {
  const f = await byteFixture();
  try {
    f.launch();
    const update = f.calls.get("UpdateProcThreadAttribute")!.mock.calls[0]!;
    expect(update[2]).toBe(0x20002);
    const list = update[3] as Buffer;
    expect(list.length).toBe(24);
    expect([0, 8, 16].map((offset) => list.readBigUInt64LE(offset))).toEqual([2n, 4n, 6n]);
    expect(f.calls.get("SetHandleInformation")!.mock.calls).toEqual([
      [2n, 1, 1],
      [4n, 1, 1],
      [6n, 1, 1],
      [2n, 1, 0],
      [4n, 1, 0],
      [6n, 1, 0],
    ]);
    const startup = f.calls.get("CreateProcessAsUserW")!.mock.calls[0]![9];
    expect(startup).toMatchObject({
      startup: { cb: 112, dwFlags: 0x100, hStdInput: 2n, hStdOutput: 4n, hStdError: 6n },
    });
  } finally {
    await f.io.close();
  }
});
it.each(["inherit", "initialize", "allowlist", "create"])("pipe handle allowlist fails closed on %s", async (stage) => {
  const f = await byteFixture(stage);
  try {
    expect(f.launch).toThrow();
    if (stage !== "create") expect(f.calls.get("CreateProcessAsUserW")).not.toHaveBeenCalled();
    else
      expect(f.calls.get("SetHandleInformation")!.mock.calls.slice(-3)).toEqual([
        [2n, 1, 0],
        [4n, 1, 0],
        [6n, 1, 0],
      ]);
  } finally {
    await f.io.close();
  }
});
it("rejects forged external handles before touching native startup attributes", () => {
  const f = fixture();
  const create = bindPipeProcessCreation(f.ffi, { kernel32: "test-kernel", advapi32: "test-advapi" });
  expect(() =>
    create(1n, "C:\\owned.exe", Buffer.alloc(8), 0x08000404, Buffer.alloc(8), "C:\\work", {}, {} as never),
  ).toThrow("unowned");
  expect(f.calls.get("InitializeProcThreadAttributeList")).not.toHaveBeenCalled();
  expect(f.calls.get("CreateProcessAsUserW")).not.toHaveBeenCalled();
});

it("retains the trusted UTF-16 desktop buffer through both native extended startup paths", async () => {
  const desktop = Buffer.from(`crot-${"b".repeat(48)}\\actor\0`, "utf16le");
  const f = fixture();
  bindNulProcessCreation(f.ffi, { kernel32: "test-kernel", advapi32: "test-advapi" })(
    1n,
    "C:\\owned.exe",
    Buffer.alloc(8),
    0x08000404,
    Buffer.alloc(8),
    "C:\\work",
    {},
    desktop,
  );
  expect(f.calls.get("CreateProcessAsUserW")!.mock.calls[0]![9]).toMatchObject({ startup: { lpDesktop: desktop } });
  const b = await byteFixture();
  try {
    bindPipeProcessCreation(b.ffi, { kernel32: "test-kernel", advapi32: "test-advapi" })(
      1n,
      "C:\\owned.exe",
      Buffer.alloc(8),
      0x08000404,
      Buffer.alloc(8),
      "C:\\work",
      {},
      b.io,
      desktop,
    );
    expect(b.calls.get("CreateProcessAsUserW")!.mock.calls[0]![9]).toMatchObject({ startup: { lpDesktop: desktop } });
  } finally {
    await b.io.close();
  }
});

it("sets hidden-console startup flags while preserving exact stdio and desktop", async () => {
  const f = await byteFixture();
  const desktop = Buffer.from(`crot-${"d".repeat(48)}\\actor\0`, "utf16le");
  try {
    bindPipeProcessCreation(f.ffi, { kernel32: "test-kernel", advapi32: "test-advapi" })(
      1n,
      "C:\\owned.exe",
      Buffer.alloc(8),
      0x414,
      Buffer.alloc(8),
      "C:\\work",
      {},
      f.io,
      desktop,
    );
    const args = f.calls.get("CreateProcessAsUserW")!.mock.calls[0]!;
    expect(args[6]).toBe(0x80414);
    expect(args[9]).toMatchObject({
      startup: { dwFlags: 0x101, wShowWindow: 0, lpDesktop: desktop, hStdInput: 2n, hStdOutput: 4n, hStdError: 6n },
    });
  } finally {
    await f.io.close();
  }
});

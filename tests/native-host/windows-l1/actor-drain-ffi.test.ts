/** ABI/access-mask/resource fixtures. Only the Windows native test proves OS behaviour. */
import { describe, expect, it, vi } from "vitest";
import { bindAppContainerActorDrain } from "../../../src/native-host/windows-l1/actor-drain.js";
import type { TokenFfi } from "../../../src/native-host/windows-l1/restricted-token.js";
const ownerSid = "S-1-5-21-1-2-3-1001",
  packageSid = "S-1-15-2-1-2-3-4-5-6-7";
function fixture() {
  const owner = {},
    pkg = {},
    other = {},
    outer = {};
  type Process = { pid: number; owner: unknown; pkg?: unknown; alive: boolean };
  const processes: Process[] = [
    { pid: process.pid, owner, alive: true },
    { pid: 500001, owner, pkg, alive: true },
    { pid: 500002, owner, pkg: other, alive: true },
    { pid: 500003, owner: other, pkg, alive: true },
  ];
  type Handle = { process: Process; token?: boolean };
  let lastError = 0,
    hideController = false,
    unknownUser = false;
  const rows = () =>
    processes
      .filter((p) => p.alive && (!hideController || p.pid !== process.pid))
      .map((p) => ({ pid: p.pid, user: unknownUser && p.pid === 500001 ? null : p.owner }));
  const enumerate = vi.fn(
    (
      _server: unknown,
      level: { value: number },
      _session: unknown,
      out: { value?: unknown },
      count: { value?: number },
    ) => {
      level.value = 0;
      count.value = rows().length;
      out.value = outer;
      return 1;
    },
  );
  const freeWts = vi.fn(() => 1),
    localFree = vi.fn(() => null),
    close = vi.fn((_h: unknown) => 1);
  const open = vi.fn((_access: number, _inherit: unknown, pid: number): unknown => {
    const p = processes.find((v) => v.pid === pid && v.alive);
    if (!p) {
      lastError = 87;
      return null;
    }
    return { process: p };
  });
  const openToken = vi.fn((h: Handle, _access: unknown, out: { value?: unknown }) => {
    out.value = { process: h.process, token: true };
    return 1;
  });
  const terminate = vi.fn((h: Handle) => {
    h.process.alive = false;
    return 1;
  });
  const refs = new Map<number, unknown>([
    [1, owner],
    [2, pkg],
    [3, other],
  ]);
  const information = vi.fn((h: Handle, kind: number, b: Buffer, _size: unknown, out: { value?: number }) => {
    if (kind === 1) {
      b.writeUInt32LE(h.process.owner === owner ? 1 : 3);
      out.value = 16;
    } else if (kind === 29) {
      b.writeUInt32LE(h.process.pkg ? 1 : 0);
      out.value = 4;
    } else if (kind === 31) {
      b.writeUInt32LE(h.process.pkg === pkg ? 2 : 3);
      out.value = 8;
    } else throw new Error("unexpected token information class");
    return 1;
  });
  const functions = {
    WTSEnumerateProcessesExW: enumerate,
    WTSFreeMemoryExW: freeWts,
    ConvertStringSidToSidW: (sid: string, out: { value?: unknown }) => {
      out.value = sid === ownerSid ? owner : pkg;
      return 1;
    },
    IsValidSid: () => 1,
    EqualSid: (a: unknown, b: unknown) => (a === b ? 1 : 0),
    OpenProcessToken: openToken,
    GetTokenInformation: information,
    OpenProcess: open,
    TerminateProcess: terminate,
    WaitForSingleObject: (h: Handle) => (h.process.alive ? 258 : 0),
    CloseHandle: close,
    LocalFree: localFree,
    GetLastError: () => lastError,
  };
  const loads: string[] = [];
  const ffi = {
    load: (file: string) => {
      loads.push(file);
      return {
        func: (signature: string) => {
          const name = Object.keys(functions).find((n) => signature.includes(n + "("));
          if (!name) throw new Error(signature);
          return functions[name as keyof typeof functions];
        },
      };
    },
    struct: vi.fn(),
    sizeof: (type: string) => (type.includes("WTS_PROCESS") ? 24 : 8),
    decode: (pointer: unknown, type: string) =>
      type === "void *" ? refs.get((pointer as Buffer).readUInt32LE(0)) : rows(),
  } as unknown as TokenFfi & { decode(pointer: unknown, type: string, length?: number): unknown };
  const drain = bindAppContainerActorDrain(ffi, "C:\\Windows");
  return {
    drain,
    processes,
    owner,
    pkg,
    outer,
    enumerate,
    freeWts,
    localFree,
    close,
    open,
    openToken,
    terminate,
    information,
    loads,
    hide: () => {
      hideController = true;
    },
    unknown: () => {
      unknownUser = true;
    },
  };
}
describe("AppContainer actor native access/resource contract (injected)", () => {
  it("kills only same-user exact-package actors and preserves the other package/user/controller", async () => {
    const f = fixture(),
      result = await f.drain(ownerSid, packageSid);
    expect(result).toEqual({ terminated: 1, scans: 3, emptyScans: 2 });
    expect(f.terminate.mock.calls.map(([h]) => h.process.pid)).toEqual([500001]);
    expect(f.processes.filter((p) => p.alive).map((p) => p.pid)).toEqual([process.pid, 500002, 500003]);
    expect(f.open.mock.calls.filter(([access]) => access === 0x101001).map((v) => v[2])).toEqual([500001]);
    expect(f.openToken.mock.calls.every((v) => v[1] === 8)).toBe(true);
    expect(f.localFree.mock.calls).toHaveLength(2);
    expect(f.freeWts).toHaveBeenCalledTimes(3);
  });
  it("loads fixed system DLLs and enumerates every session with level zero ABI", async () => {
    const f = fixture();
    await f.drain(ownerSid, packageSid);
    expect(f.loads).toEqual(["kernel32.dll", "advapi32.dll", "wtsapi32.dll"].map((n) => `C:\\Windows\\System32\\${n}`));
    expect(f.enumerate.mock.calls.every((v) => v[0] === null && v[1].value === 0 && v[2] === 0xfffffffe)).toBe(true);
  });
  it.each(["hide", "unknown"] as const)("refuses %s inventory before terminating any process", async (kind) => {
    const f = fixture();
    f[kind]();
    await expect(f.drain(ownerSid, packageSid)).rejects.toThrow(
      kind === "hide" ? "excluded live owner" : "unknown inventory user",
    );
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.freeWts).toHaveBeenCalledOnce();
  });
  it("does not turn token-query denial on a living process into absence", async () => {
    const f = fixture();
    f.openToken.mockReturnValueOnce(0);
    await expect(f.drain(ownerSid, packageSid)).rejects.toThrow("token open");
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.localFree).toHaveBeenCalledTimes(2);
  });
  it("requires terminal wait success and closes exact resources on failure", async () => {
    const f = fixture();
    f.terminate.mockReturnValueOnce(0);
    await expect(f.drain(ownerSid, packageSid)).rejects.toThrow("actor termination");
    expect(f.close.mock.calls.length).toBeGreaterThan(0);
    expect(f.localFree).toHaveBeenCalledTimes(2);
  });
  it("accepts a failed TerminateProcess only after the exact process handle proves death", async () => {
    const f = fixture();
    f.terminate.mockImplementationOnce((h) => {
      h.process.alive = false;
      return 0;
    });
    expect((await f.drain(ownerSid, packageSid)).emptyScans).toBe(2);
    expect(f.terminate).toHaveBeenCalledOnce();
  });
  it("serialises concurrent drain requests so SID allocations cannot be freed by another owner", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.drain(ownerSid, packageSid), f.drain(ownerSid, packageSid)]);
    expect(a.terminated + b.terminated).toBe(1);
    expect(b.emptyScans).toBe(2);
    expect(f.localFree).toHaveBeenCalledTimes(4);
  });
});

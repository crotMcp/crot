import { mkdir } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { RuntimePermissionState } from "../../src/core/permissions/runtime.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import { observeNativePorts, type NativePortApi } from "../../src/native-host/project-ports/observer.js";
import { lsofFiles, lsofListeners, macosProcessIdentity } from "../../src/native-host/project-ports/macos.js";
import { windowsCwdDescriptor, windowsTcpListeners } from "../../src/native-host/project-ports/windows.js";
import { createTestCore, makeTempDirs, testContext } from "../helpers.js";

const endpoint = { pid: 42, address: "127.0.0.1", port: 4321 };
describe("native project listener observation", () => {
  it("decodes NUL-delimited Darwin cwd fields without splitting whitespace or records", () => {
    const input = "p42\0\nfcwd\0n/Users/owner/project with spaces\0\np43\0\nfcwd\0n/tmp/line\nname\0\n";
    expect(lsofFiles(input).map((f) => [f.pid, f.fd, f.name])).toEqual([
      [42, "cwd", "/Users/owner/project with spaces"],
      [43, "cwd", "/tmp/line\nname"],
    ]);
  });
  it("accepts only numeric TCP endpoints and preserves IPv4/IPv6", () => {
    const input =
      "p42\0\nf3\0tIPv4\0PTCP\0n127.0.0.1:4321\0\nf4\0tIPv6\0PTCP\0n[::1]:4322\0\nf5\0tIPv4\0PUDP\0n*:53\0\nf6\0tIPv4\0PTCP\0n*:8080\0\nf7\0tIPv4\0PTCP\0n127.0.0.1:9->127.0.0.2:10\0\n";
    expect(lsofListeners(input)).toEqual([
      endpoint,
      { pid: 42, address: "::1", port: 4322 },
      { pid: 42, address: "0.0.0.0", port: 8080 },
    ]);
  });
  it("validates Darwin kernel PID, UID and microsecond creation identity", () => {
    const data = Buffer.alloc(136);
    data.writeUInt32LE(42, 12);
    data.writeUInt32LE(1000, 20);
    data.writeBigUInt64LE(123n, 120);
    data.writeBigUInt64LE(456n, 128);
    expect(macosProcessIdentity(data, 42, 1000)).toBe("123:456");
    expect(macosProcessIdentity(data, 42, 1001)).toBeNull();
    expect(() => macosProcessIdentity(data, 43, 1000)).toThrow("ABI mismatch");
    data.writeBigUInt64LE(1000000n, 128);
    expect(() => macosProcessIdentity(data, 42, 1000)).toThrow("creation identity");
  });
  it("decodes Windows owner-PID listening rows in network byte order, not established connections", () => {
    const data = Buffer.alloc(4 + 48);
    data.writeUInt32LE(2, 0);
    data.writeUInt32LE(2, 4);
    Buffer.from([127, 0, 0, 1]).copy(data, 8);
    data.writeUInt16BE(4321, 12);
    data.writeUInt32LE(42, 24);
    data.writeUInt32LE(5, 28);
    data.writeUInt32LE(43, 48);
    expect(windowsTcpListeners(data, 2)).toEqual([endpoint]);
    const ipv6 = Buffer.alloc(60);
    ipv6.writeUInt32LE(1);
    ipv6[19] = 1;
    ipv6.writeUInt32LE(3, 20);
    ipv6.writeUInt16BE(443, 24);
    ipv6.writeUInt32LE(2, 52);
    ipv6.writeUInt32LE(99, 56);
    expect(windowsTcpListeners(ipv6, 23)).toEqual([{ pid: 99, address: "0:0:0:0:0:0:0:1%3", port: 443 }]);
    data.writeUInt32LE(3);
    expect(() => windowsTcpListeners(data, 2)).toThrow("length");
  });
  it("bounds Windows CurrentDirectory pointers and byte counts before any memory read", () => {
    const data = Buffer.alloc(16);
    data.writeUInt16LE(6);
    data.writeUInt16LE(8, 2);
    data.writeBigUInt64LE(0x20000n, 8);
    expect(windowsCwdDescriptor(data)).toEqual({ address: 0x20000n, length: 6 });
    data.writeUInt16LE(7);
    expect(() => windowsCwdDescriptor(data)).toThrow();
    data.writeUInt16LE(6);
    data.writeBigUInt64LE(8n, 8);
    expect(() => windowsCwdDescriptor(data)).toThrow();
    data.writeBigUInt64LE(0x20000n, 8);
    data.writeUInt16LE(4, 2);
    expect(() => windowsCwdDescriptor(data)).toThrow();
  });
  it("rechecks kernel identity, canonical cwd and listener table before attributing an endpoint", async () => {
    const dirs = await makeTempDirs();
    try {
      const read = vi.fn().mockResolvedValue({ identity: "created:1", cwd: dirs.workspace });
      const api: NativePortApi = { listeners: vi.fn().mockResolvedValue([endpoint]), process: read };
      expect((await observeNativePorts(dirs.workspace, api)).listeners).toEqual([endpoint]);
      expect(read).toHaveBeenCalledTimes(2);
      read
        .mockReset()
        .mockResolvedValueOnce({ identity: "created:1", cwd: dirs.workspace })
        .mockResolvedValueOnce({ identity: "created:2", cwd: dirs.workspace });
      expect((await observeNativePorts(dirs.workspace, api)).listeners).toEqual([]);
      read
        .mockReset()
        .mockResolvedValueOnce({ identity: "created:1", cwd: dirs.workspace })
        .mockResolvedValueOnce({ identity: "created:1", cwd: dirs.outside });
      expect((await observeNativePorts(dirs.workspace, api)).listeners).toEqual([]);
      read.mockReset().mockResolvedValue({ identity: "created:1", cwd: dirs.workspace });
      api.listeners = vi.fn().mockResolvedValueOnce([endpoint]).mockResolvedValueOnce([]);
      expect((await observeNativePorts(dirs.workspace, api)).listeners).toEqual([]);
    } finally {
      await dirs.cleanup();
    }
  });
  it("excludes positively foreign owners and outside/sibling-prefix cwd", async () => {
    const dirs = await makeTempDirs();
    try {
      const sibling = dirs.workspace + "-other";
      await mkdir(sibling);
      for (const value of [null, { identity: "1", cwd: dirs.outside }, { identity: "1", cwd: sibling }]) {
        const api = { listeners: async () => [endpoint], process: vi.fn().mockResolvedValue(value) };
        expect((await observeNativePorts(dirs.workspace, api)).listeners).toEqual([]);
      }
    } finally {
      await dirs.cleanup();
    }
  });
  it("reports unreadable metadata as partial and a failed native table as unavailable, not free", async () => {
    const dirs = await makeTempDirs();
    try {
      const api = { listeners: async () => [endpoint], process: vi.fn().mockRejectedValue(new Error("access denied")) };
      expect(await observeNativePorts(dirs.workspace, api)).toMatchObject({ status: "partial", listeners: [] });
      api.listeners = async () => {
        throw new Error("native API unavailable");
      };
      const result = await observeNativePorts(dirs.workspace, api);
      expect(result).toMatchObject({ status: "unavailable", listeners: [] });
      expect(result.notes.join(" ")).toContain("not proof");
    } finally {
      await dirs.cleanup();
    }
  });
  it("bounds listeners and process observations", async () => {
    const dirs = await makeTempDirs();
    try {
      const api = {
        listeners: async () => Array.from({ length: 600 }, (_, n) => ({ ...endpoint, port: n + 1 })),
        process: async () => ({ identity: "1", cwd: dirs.workspace }),
      };
      const result = await observeNativePorts(dirs.workspace, api);
      expect(result.status).toBe("partial");
      expect(result.listeners).toHaveLength(512);
      const process = vi.fn().mockResolvedValue(null);
      await observeNativePorts(dirs.workspace, {
        listeners: async () => Array.from({ length: 129 }, (_, n) => ({ ...endpoint, pid: n + 1 })),
        process,
      });
      expect(process).toHaveBeenCalledTimes(128);
    } finally {
      await dirs.cleanup();
    }
  });
  it("propagates cancellation instead of success or unavailable", async () => {
    const abort = new AbortController();
    abort.abort();
    const api = { listeners: vi.fn(), process: vi.fn() };
    await expect(observeNativePorts("/unused", api, abort.signal)).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    expect(api.listeners).not.toHaveBeenCalled();
  });
  it("does not publish an endpoint when cancellation occurs during the final identity recheck", async () => {
    const dirs = await makeTempDirs(),
      abort = new AbortController();
    let reads = 0;
    try {
      const api: NativePortApi = {
        listeners: async () => [endpoint],
        process: async () => {
          if (++reads === 2) abort.abort();
          return { identity: "1", cwd: dirs.workspace };
        },
      };
      await expect(observeNativePorts(dirs.workspace, api, abort.signal)).rejects.toMatchObject({
        code: "OPERATION_FAILED",
      });
      expect(reads).toBe(2);
    } finally {
      await dirs.cleanup();
    }
  });
  it("invokes the platform observer only after the one Core guard permits it", async () => {
    const dirs = await makeTempDirs(),
      runtime = new RuntimePermissionState();
    const base = await createNodePlatform({ startupPath: "inherited" }),
      observe = vi
        .fn()
        .mockResolvedValue({ status: "observed", scope: "same-user-workspace-cwd", listeners: [endpoint], notes: [] });
    const core = await createTestCore(
      { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
      undefined,
      { platform: { ...base, observeProjectPorts: observe }, runtimePermissions: runtime },
    );
    try {
      runtime.replace({ strict: false, rules: [{ operation: "process.project_ports", state: "deny" }] });
      await expect(core.inspectProject(testContext)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(observe).not.toHaveBeenCalled();
      runtime.replace({ strict: false, rules: [] });
      expect((await core.inspectProject(testContext)).ports.listeners).toEqual([endpoint]);
      expect(observe).toHaveBeenCalledWith(dirs.workspace, undefined);
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });
});

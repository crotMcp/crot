/** Fixed Darwin libproc identity + fixed lsof fields; never reads environment or command lines. */
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import type { ProjectPort } from "../../core/platform/types.js";
import type { PortFfi } from "./ffi.js";
import type { NativePortApi } from "./observer.js";

interface LsofFile {
  pid: number;
  fd: string;
  name: string;
  family: string;
  protocol: string;
}
/** -F0 uses NUL fields and a newline between records, so spaces/newlines are never split as fields. */
export function lsofFiles(text: string): LsofFile[] {
  const result: LsofFile[] = [];
  let pid = 0,
    file: LsofFile | undefined;
  const flush = () => {
    if (file) result.push(file);
    file = undefined;
  };
  for (const raw of text.split("\0")) {
    const field = raw.startsWith("\n") ? raw.slice(1) : raw;
    if (!field) continue;
    const value = field.slice(1);
    if (field[0] === "p") {
      flush();
      pid = /^\d+$/.test(value) ? Number(value) : 0;
    } else if (field[0] === "f") {
      flush();
      if (pid > 0 && pid <= 0x7fffffff) file = { pid, fd: value, name: "", family: "", protocol: "" };
    } else if (file && field[0] === "n") file.name = value;
    else if (file && field[0] === "t") file.family = value;
    else if (file && field[0] === "P") file.protocol = value;
  }
  flush();
  return result;
}
export function lsofListeners(text: string): ProjectPort[] {
  return lsofFiles(text).flatMap((file) => {
    if (file.protocol !== "TCP" || !["IPv4", "IPv6"].includes(file.family)) return [];
    const index = file.name.lastIndexOf(":"),
      port = Number(file.name.slice(index + 1));
    let address = file.name.slice(0, index);
    if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
    if (address === "*") address = file.family === "IPv4" ? "0.0.0.0" : "0:0:0:0:0:0:0:0";
    if (
      index < 0 ||
      !/^\d+$/.test(file.name.slice(index + 1)) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !isIP(address)
    )
      return [];
    return [{ pid: file.pid, address, port }];
  });
}
export function macosProcessIdentity(data: Buffer, pid: number, uid: number): string | null {
  // Darwin proc_bsdinfo: sizeof=136 on supported arm64/x86_64. These are public libproc fields.
  if (data.length !== 136 || data.readUInt32LE(12) !== pid) throw new Error("Darwin process identity ABI mismatch");
  if (data.readUInt32LE(20) !== uid) return null;
  const seconds = data.readBigUInt64LE(120),
    micros = data.readBigUInt64LE(128);
  if (seconds === 0n || micros > 999999n) throw new Error("Invalid Darwin creation identity");
  return `${seconds}:${micros}`;
}
export function bindMacosPorts(ffi: PortFfi): NativePortApi {
  if (!process.getuid) throw new Error("Darwin UID unavailable");
  const uid = process.getuid();
  const query = ffi
    .load("/usr/lib/libproc.dylib")
    .func("int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size)");
  const identity = (pid: number) => {
    const data = Buffer.alloc(136);
    if (Number(query(pid, 3, 0, data, data.length)) !== data.length)
      throw new Error("Darwin process identity unavailable");
    return macosProcessIdentity(data, pid, uid);
  };
  const run = (args: string[], signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "/usr/sbin/lsof",
        args,
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 1500,
          signal,
          env: { PATH: "/usr/sbin:/usr/bin:/bin", LC_ALL: "C" },
        },
        (error, stdout, stderr) => {
          if (!error) {
            if (stderr.trim()) reject(new Error("Darwin listener observation incomplete"));
            else resolve(stdout);
          } else if ((error as { code?: number }).code === 1 && !stdout && !stderr.trim()) resolve("");
          else reject(new Error("Darwin process observation unavailable"));
        },
      );
    });
  return {
    listeners: async (signal) =>
      lsofListeners(await run(["-nP", "-a", "-u", String(uid), "-iTCP", "-sTCP:LISTEN", "-F0pfnPt"], signal)),
    process: async (pid, signal) => {
      const before = identity(pid);
      if (!before) return null;
      const files = lsofFiles(await run(["-a", "-p", String(pid), "-d", "cwd", "-F0pfn"], signal));
      const cwd = files.find((f) => f.pid === pid && f.fd === "cwd")?.name;
      if (!cwd?.startsWith("/") || cwd.includes("\0") || identity(pid) !== before)
        throw new Error("Darwin cwd observation unstable");
      return { identity: before, cwd };
    },
  };
}

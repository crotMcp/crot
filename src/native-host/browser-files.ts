/** Descriptor/handle primitives for browser files. No request API or authorization. */
import * as fs from "node:fs";
import { open, lstat, realpath, readlink } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../core/errors.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import type { Workspace, ResolvedPath } from "../core/workspace/workspace.js";
import { currentUserSid, windowsTools } from "./windows-acl.js";
import { loadWindowsPrivateState } from "./windows-state.js";

export interface TransferInfo {
  isFile(): boolean;
  dev: number | bigint;
  ino: number | bigint;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
export interface TransferFile {
  stat(): Promise<TransferInfo>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  write(buffer: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
const fail = (stage: string): never => {
  throw new CrotError("OPERATION_FAILED", `Browser file ${stage} failed.`);
};
let ffiPromise: Promise<typeof import("koffi")> | undefined;
const ffi = () => (ffiPromise ??= import("koffi"));
let windowsProtection: Promise<PrivateFileProtection> | undefined;
export function browserPrivateProtection(fallback: PrivateFileProtection): Promise<PrivateFileProtection> {
  if (process.platform !== "win32") return Promise.resolve(fallback);
  // Use the same kernel-verified, owner-only DACL/MIC policy as native private state.
  return (windowsProtection ??= currentUserSid(windowsTools(process.env.SystemRoot ?? "C:\\Windows")).then((sid) =>
    loadWindowsPrivateState(sid),
  ));
}
export async function canonicalDescriptor(fd: number): Promise<string> {
  if (process.platform === "linux") return readlink(`/proc/self/fd/${fd}`);
  if (process.platform !== "darwin") return fail("descriptor platform");
  const lib = (await ffi()).load("/usr/lib/libSystem.B.dylib");
  const get = lib.func("int fcntl(int fd, int command, ...)");
  const out = Buffer.alloc(1024);
  if (get(fd, 50 /* F_GETPATH */, "void *", out) !== 0) return fail("descriptor path");
  return out.subarray(0, out.indexOf(0)).toString("utf8");
}
export async function openTransferCreate(file: string, protection: PrivateFileProtection): Promise<TransferFile> {
  if (process.platform === "win32") {
    const parent = (await windowsApi()).pin(path.dirname(file));
    try {
      const item = await privateWindowsOutput(parent, path.basename(file), protection, file);
      return {
        ...item,
        close: async () => {
          try {
            await item.close();
          } finally {
            parent.close();
          }
        },
      };
    } catch (e) {
      parent.close();
      throw e;
    }
  }
  return open(
    file,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600,
  );
}
export async function openTransferRead(file: string): Promise<TransferFile> {
  if (process.platform === "win32") {
    const api = await windowsApi();
    const parent = api.pin(path.dirname(file));
    try {
      const item = parent.open(path.basename(file), false);
      return {
        ...item,
        close: async () => {
          try {
            await item.close();
          } finally {
            parent.close();
          }
        },
      };
    } catch (e) {
      parent.close();
      throw e;
    }
  }
  const entry = await lstat(file);
  const input = await open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = await input.stat();
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.dev !== info.dev ||
      entry.ino !== info.ino ||
      (await canonicalDescriptor(input.fd)) !== file
    )
      fail("source identity");
    return input;
  } catch (e) {
    await input.close();
    throw e;
  }
}
export async function verifyTransferIdentity(file: string, info: TransferInfo): Promise<void> {
  const entry = await lstat(file, { bigint: true });
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.dev !== BigInt(info.dev) ||
    entry.ino !== BigInt(info.ino) ||
    entry.size !== BigInt(info.size) ||
    entry.nlink !== BigInt(info.nlink)
  )
    fail("file identity");
}
export type CopyTransfer = (source: TransferFile, target: TransferFile, size: number) => Promise<void>;

/** macOS publication uses *at syscalls, never /dev/fd pathname emulation. */
export async function publishDarwin(
  source: TransferFile,
  size: number,
  destination: ResolvedPath,
  overwrite: boolean,
  workspace: Workspace,
  tempName: string,
  copy: CopyTransfer,
): Promise<void> {
  const parentPath = path.dirname(destination.absolute);
  const parent = await open(parentPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const lib = (await ffi()).load("/usr/lib/libSystem.B.dylib");
  const create = lib.func("int openat(int dir, str name, int flags, ...)");
  const rename = lib.func("int renameat(int fromdir, str from, int todir, str to)");
  const link = lib.func("int linkat(int fromdir, str from, int todir, str to, int flags)");
  const unlink = lib.func("int unlinkat(int dir, str name, int flags)");
  const check = async () => {
    const held = await parent.stat(),
      now = await lstat(parentPath);
    if (
      now.isSymbolicLink() ||
      held.dev !== now.dev ||
      held.ino !== now.ino ||
      (await canonicalDescriptor(parent.fd)) !== parentPath ||
      (await realpath(parentPath)) !== parentPath ||
      (await workspace.resolve(destination.absolute)).absolute !== destination.absolute ||
      !workspace.contains(workspace.root, parentPath)
    )
      fail("destination parent");
  };
  let created = false;
  try {
    await check();
    const fd = create(
      parent.fd,
      tempName,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      "unsigned int",
      0o600,
    );
    if (fd < 0) fail("temporary create");
    created = true;
    const output = fdFile(fd);
    try {
      await copy(source, output, size);
      await output.sync();
    } finally {
      await output.close();
    }
    await check();
    const result = overwrite
      ? rename(parent.fd, tempName, parent.fd, path.basename(destination.absolute))
      : link(parent.fd, tempName, parent.fd, path.basename(destination.absolute), 0);
    if (result !== 0) {
      if (!overwrite && (await ffi()).errno() === 17)
        throw new CrotError("ALREADY_EXISTS", "Download destination already exists.");
      fail("atomic publication");
    }
    if (overwrite) created = false;
    if (created && unlink(parent.fd, tempName, 0) !== 0) fail("temporary removal");
    created = false;
    await parent.sync();
  } finally {
    if (created) unlink(parent.fd, tempName, 0);
    await parent.close();
  }
}
function fdFile(fd: number): TransferFile {
  return {
    stat: () => new Promise((resolve, reject) => fs.fstat(fd, (e, s) => (e ? reject(e) : resolve(s)))),
    read: (b, o, l, p) =>
      new Promise((resolve, reject) => fs.read(fd, b, o, l, p, (e, n) => (e ? reject(e) : resolve({ bytesRead: n })))),
    write: (b, o, l) =>
      new Promise((resolve, reject) =>
        fs.write(fd, b, o, l, null, (e, n) => (e ? reject(e) : resolve({ bytesWritten: n }))),
      ),
    sync: () => new Promise((resolve, reject) => fs.fsync(fd, (e) => (e ? reject(e) : resolve()))),
    close: () => new Promise((resolve, reject) => fs.close(fd, (e) => (e ? reject(e) : resolve()))),
  };
}

let windowsPromise: Promise<ReturnType<typeof bindWindows>> | undefined;
function windowsApi() {
  return (windowsPromise ??= ffi().then(bindWindows));
}
function bindWindows(ffi: typeof import("koffi")) {
  if (ffi.sizeof("void *") !== 8) fail("Windows ABI");
  const k = ffi.load("kernel32.dll"),
    nt = ffi.load("ntdll.dll");
  const create = k.func(
    "void * __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
  );
  const close = k.func("int __stdcall CloseHandle(void *handle)");
  const info = k.func("int __stdcall GetFileInformationByHandle(void *handle, _Out_ uint8_t *buffer)");
  const finalPath = k.func(
    "uint32_t __stdcall GetFinalPathNameByHandleW(void *handle, _Out_ uint8_t *buffer, uint32_t size, uint32_t flags)",
  );
  const read = k.func(
    "int __stdcall ReadFile(void *handle, _Out_ uint8_t *buffer, uint32_t size, _Out_ uint8_t *done, void *overlapped)",
  );
  const write = k.func(
    "int __stdcall WriteFile(void *handle, const uint8_t *buffer, uint32_t size, _Out_ uint8_t *done, void *overlapped)",
  );
  const flush = k.func("int __stdcall FlushFileBuffers(void *handle)");
  const set = k.func(
    "int __stdcall SetFileInformationByHandle(void *handle, int kind, const uint8_t *buffer, uint32_t size)",
  );
  const rename = nt.func(
    "int32_t __stdcall NtSetInformationFile(void *handle, _Out_ uint8_t *status, const uint8_t *buffer, uint32_t size, int kind)",
  );
  const valid = (h: unknown) =>
    h !== null && h !== undefined && h !== 0 && h !== 0n && h !== -1n && h !== 0xffffffffffffffffn;
  const inspect = (h: unknown, directory: boolean, expected: string): TransferInfo => {
    const b = Buffer.alloc(52);
    if (!info(h, b) || !!(b.readUInt32LE(0) & 0x10) !== directory || b.readUInt32LE(0) & 0x400)
      fail("Windows reparse/type");
    const text = Buffer.alloc(65536),
      length = Number(finalPath(h, text, 32768, 0));
    const actual = text
      .subarray(0, length * 2)
      .toString("utf16le")
      .replace(/^\\\\\?\\/, "");
    if (!length || length >= 32768 || actual.toLowerCase() !== expected.toLowerCase()) fail("Windows handle path");
    const size = b.readUInt32LE(32) * 2 ** 32 + b.readUInt32LE(36);
    return {
      isFile: () => !directory,
      dev: BigInt(b.readUInt32LE(28)),
      ino: (BigInt(b.readUInt32LE(44)) << 32n) | BigInt(b.readUInt32LE(48)),
      nlink: b.readUInt32LE(40),
      size,
      mtimeMs: Number(b.readBigUInt64LE(20) / 10000n),
      ctimeMs: Number(b.readBigUInt64LE(4) / 10000n),
    };
  };
  const pin = (directory: string) => {
    // Every ancestor is opened without FILE_SHARE_DELETE: a junction/symlink or
    // ancestor rename cannot redirect a later file open/publication. No drive-relative/UNC paths.
    if (
      !/^[A-Za-z]:\\/.test(directory) ||
      directory
        .slice(3)
        .split("\\")
        .some((p) => p === "." || p === ".." || /[. ]$/.test(p))
    )
      fail("Windows local path");
    const handles: unknown[] = [];
    const paths = [directory.slice(0, 3)];
    for (const part of directory.slice(3).split("\\").filter(Boolean)) paths.push(path.win32.join(paths.at(-1)!, part));
    try {
      for (const p of paths) {
        const h: unknown = create(
          p,
          0x1200a0 /* directory read/synchronize */,
          3 /* read/write, NOT delete */,
          null,
          3,
          0x02200000 /* backup + open reparse */,
          null,
        );
        if (!valid(h)) fail("Windows parent pin");
        handles.push(h);
        inspect(h, true, p);
      }
    } catch (e) {
      for (const h of handles.reverse()) close(h);
      throw e;
    }
    return {
      close: () => {
        for (const h of handles.reverse()) if (!close(h)) fail("Windows parent close");
        handles.length = 0;
      },
      open: (name: string, writable: boolean, existing = false) => {
        const file = path.win32.join(directory, name);
        const h: unknown = create(
          file,
          writable ? 0xc0010000 /* read/write/delete */ : 0x80000000,
          1 /* only read sharing; no modification/deletion */,
          null,
          writable && !existing ? 1 : 3,
          0x00200000 /* OPEN_REPARSE_POINT */,
          null,
        );
        if (!valid(h)) fail("Windows file open");
        let closed = false,
          position = 0;
        try {
          const s = inspect(h, false, file);
          if (s.nlink !== 1) fail("Windows hardlink");
        } catch (e) {
          close(h);
          throw e;
        }
        return {
          stat: async () => inspect(h, false, file),
          read: async (b: Buffer, o: number, l: number, p: number) => {
            if (position !== p) fail("Windows read position");
            const done = Buffer.alloc(4);
            if (!read(h, b.subarray(o, o + l), l, done, null)) fail("Windows read");
            const bytesRead = done.readUInt32LE();
            position += bytesRead;
            return { bytesRead };
          },
          write: async (b: Buffer, o: number, l: number) => {
            const done = Buffer.alloc(4);
            if (!write(h, b.subarray(o, o + l), l, done, null)) fail("Windows write");
            return { bytesWritten: done.readUInt32LE() };
          },
          sync: async () => {
            if (!flush(h)) fail("Windows flush");
          },
          close: async () => {
            if (!closed) {
              closed = true;
              if (!close(h)) fail("Windows file close");
            }
          },
          remove: () => {
            if (!set(h, 4 /* FileDispositionInfo */, Buffer.from([1]), 1)) fail("Windows temporary delete");
          },
          install: (name: string, overwrite: boolean) => {
            // Native handle-relative rename; no close + pathname MoveFile race.
            const text = Buffer.from(name, "utf16le"),
              b = Buffer.alloc(24 + text.length);
            b[0] = overwrite ? 1 : 0;
            ffi.encode(b.subarray(8, 16), "void *", handles.at(-1));
            b.writeUInt32LE(text.length, 16);
            text.copy(b, 20);
            const status = Number(rename(h, Buffer.alloc(16), b, b.length, 10 /* FileRenameInformation */));
            if (status < 0) {
              if (!overwrite && status >>> 0 === 0xc0000035)
                throw new CrotError("ALREADY_EXISTS", "Download destination already exists.");
              fail("Windows atomic rename");
            }
          },
        };
      },
    };
  };
  return { pin };
}
export async function publishWindows(
  source: TransferFile,
  size: number,
  destination: ResolvedPath,
  overwrite: boolean,
  workspace: Workspace,
  tempName: string,
  protection: PrivateFileProtection,
  copy: CopyTransfer,
): Promise<void> {
  const directory = path.dirname(destination.absolute),
    api = await windowsApi();
  const parent = api.pin(directory);
  let output: ReturnType<typeof parent.open> | undefined,
    installed = false;
  try {
    if (
      !workspace.contains(workspace.root, directory) ||
      (await workspace.resolve(destination.absolute)).absolute !== destination.absolute
    )
      fail("destination parent");
    output = await privateWindowsOutput(parent, tempName, protection, path.join(directory, tempName));
    await copy(source, output, size);
    await output.sync();
    if ((await workspace.resolve(destination.absolute)).absolute !== destination.absolute) fail("destination identity");
    output.install(path.basename(destination.absolute), overwrite);
    installed = true;
  } finally {
    try {
      if (output) {
        try {
          if (!installed) output.remove();
        } finally {
          await output.close();
        }
      }
    } finally {
      parent.close();
    }
  }
}

async function privateWindowsOutput(
  parent: ReturnType<Awaited<ReturnType<typeof windowsApi>>["pin"]>,
  name: string,
  protection: PrivateFileProtection,
  file: string,
) {
  // ACL installer intentionally denies delete sharing. Close only the EMPTY file,
  // install/read back its private DACL, then reopen and compare exact identity.
  // No secret bytes exist until the verified handle is held against replacement.
  const empty = parent.open(name, true);
  let expected: TransferInfo;
  try {
    expected = await empty.stat();
  } finally {
    await empty.close();
  }
  let output: ReturnType<typeof parent.open> | undefined;
  try {
    await protection.protectFile!(file);
    if (!(await protection.inspect(file)).ownerOnly) fail("temporary DACL");
    output = parent.open(name, true, true);
    const actual = await output.stat();
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== 0 || actual.nlink !== 1)
      fail("temporary identity");
    return output;
  } catch (e) {
    // Reopen only for identity verification. Never delete a substituted entry.
    // The normal path still holds the output handle for all bytes + publication.
    try {
      output ??= parent.open(name, true, true);
      const actual = await output.stat();
      if (actual.dev === expected.dev && actual.ino === expected.ino) output.remove();
    } catch {
      /* Inaccessible/substituted entries are not ours to remove. */
    } finally {
      await output?.close();
    }
    throw e;
  }
}

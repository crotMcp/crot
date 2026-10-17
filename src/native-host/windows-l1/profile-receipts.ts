/**
 * Durable proof of fresh S_OK ownership, independent of the ACL plan. The caller
 * holds the service's native journal lock for this owner's entire lifetime.
 * An interrupted create without a durable S_OK receipt is ambiguous and blocks
 * recovery; neither a matching name nor a derivable SID permits adoption.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import type { PrivateFileProtection } from "../../core/platform/types.js";
import {
  assertOwnedAppContainerProfile,
  type AppContainerProfile,
  type AppContainerProfiles,
} from "./appcontainer-profile.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SID = /^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/;
const fail = (stage: string) =>
  new CrotError("CONFINEMENT_FAILED", `Windows profile receipt: ${stage} failed.`, { stage });
export interface ProfileReceipt {
  readonly id: string;
  readonly name: string;
  readonly sid: string;
  readonly closed: boolean;
}
export interface ProfileReceiptNative {
  derive(name: string): string;
  /** Delete only after durable receipt validation and actor drain. */
  remove(name: string): void;
}
export interface DurableProfiles {
  create(): Promise<AppContainerProfile>;
  receipts(): Promise<readonly ProfileReceipt[]>;
  validate(profile: { name: string; sid: string }): Promise<ProfileReceipt>;
  remove(profile: { name: string; sid: string }, live?: AppContainerProfile): Promise<void>;
}
type Frame = { stage: "intent" | "created" | "closed"; id: string; name: string; sid: string; ownerSid: string };
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function decode(bytes: Buffer, ownerSid: string): ProfileReceipt {
  if (!bytes.length || bytes.length > 16384 || bytes.at(-1) !== 10) throw fail("record boundary");
  let previous = "0".repeat(64),
    result: Frame | undefined;
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trimEnd().split("\n");
  if (lines.length > 3) throw fail("record length");
  for (const [i, line] of lines.entries()) {
    let frame: Frame;
    try {
      const outer = JSON.parse(line) as { body: string; hash: string };
      if (typeof outer.body !== "string" || digest(outer.body) !== outer.hash) throw fail("checksum");
      const value = JSON.parse(outer.body) as { previous: string; frame: Frame };
      frame = value.frame;
      if (value.previous !== previous || Object.keys(frame).sort().join() !== "id,name,ownerSid,sid,stage")
        throw fail("record shape");
      if (
        frame.stage !== ["intent", "created", "closed"][i] ||
        !UUID.test(frame.id) ||
        frame.name !== `crot.l1.${frame.id}` ||
        !SID.test(frame.sid) ||
        frame.ownerSid !== ownerSid
      )
        throw fail("record identity");
      if (
        result &&
        ["id", "name", "sid", "ownerSid"].some((k) => result![k as keyof Frame] !== frame[k as keyof Frame])
      )
        throw fail("record identity changed");
      previous = outer.hash;
    } catch {
      throw fail("record decode");
    }
    result = frame;
  }
  if (!result || result.stage === "intent") throw fail("ambiguous profile creation");
  return { id: result.id, name: result.name, sid: result.sid, closed: result.stage === "closed" };
}
export async function openDurableProfiles(options: {
  directory: string;
  ownerSid: string;
  privateFiles: PrivateFileProtection;
  profiles: AppContainerProfiles;
  native: ProfileReceiptNative;
}): Promise<DurableProfiles> {
  const { directory, ownerSid, privateFiles, profiles, native } = options;
  if (!path.isAbsolute(directory) || !privateFiles.enforced) throw fail("private directory admission");
  await privateFiles.ensureDirectory(directory);
  const check = async (file: string, dir = false) => {
    const s = await lstat(file);
    if (
      s.isSymbolicLink() ||
      (dir ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) ||
      !(await privateFiles.inspect(file)).ownerOnly
    )
      throw fail("private object admission");
  };
  await check(directory, true);
  const fileFor = (id: string) => {
    if (!UUID.test(id)) throw fail("receipt id");
    return path.join(directory, `profile-${id}.wal`);
  };
  const read = async (id: string) => {
    const file = fileFor(id);
    await check(file);
    const h = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const s = await h.stat();
      if (!s.isFile() || s.nlink !== 1 || s.size > 16384) throw fail("receipt file");
      return await h.readFile();
    } finally {
      await h.close();
    }
  };
  const append = async (h: FileHandle, frame: Frame, before: Buffer) => {
    const previous = before.length
      ? (JSON.parse(before.toString("utf8").trimEnd().split("\n").at(-1)!) as { hash: string }).hash
      : "0".repeat(64);
    const body = JSON.stringify({ previous, frame }),
      bytes = Buffer.from(JSON.stringify({ body, hash: digest(body) }) + "\n");
    let n = 0;
    while (n < bytes.length) {
      const r = await h.write(bytes, n, bytes.length - n, before.length + n);
      if (r.bytesWritten < 1) throw fail("short write");
      n += r.bytesWritten;
    }
    await h.sync();
    if (process.platform !== "win32") {
      const dir = await open(directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
    return Buffer.concat([before, bytes]);
  };
  let tail: Promise<unknown> = Promise.resolve(),
    blocked = false;
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(async () => {
      if (blocked) throw fail("owner blocked");
      try {
        return await fn();
      } catch (cause) {
        blocked = true;
        throw cause;
      }
    });
    tail = result.catch(() => undefined);
    return result;
  };
  const validate = async (profile: { name: string; sid: string }) => {
    const id = profile.name.slice("crot.l1.".length),
      record = decode(await read(id), ownerSid);
    if (record.name !== profile.name || record.sid !== profile.sid || native.derive(record.name) !== record.sid)
      throw fail("ownership proof");
    return record;
  };
  return {
    create: () =>
      serial(async () => {
        const id = randomUUID(),
          name = `crot.l1.${id}`,
          sid = native.derive(name);
        if (!SID.test(sid)) throw fail("derived package SID");
        const file = fileFor(id),
          h = await open(file, "wx+", privateFiles.fileMode);
        let profile: AppContainerProfile | undefined;
        try {
          await privateFiles.protectFile?.(file);
          await check(file);
          const frame: Frame = { stage: "intent", id, name, sid, ownerSid };
          const before = await append(h, frame, Buffer.alloc(0));
          profile = profiles.createReserved(id);
          assertOwnedAppContainerProfile(profile);
          if (profile.name !== name || profile.sid !== sid) throw fail("fresh profile SID mismatch");
          const after = await append(h, { ...frame, stage: "created" }, before);
          decode(after, ownerSid);
          return profile;
        } catch (cause) {
          // Failure before a durable receipt cannot authenticate a restart's
          // deletion. Only this exact in-memory S_OK owner may compensate now.
          profile?.close();
          throw cause;
        } finally {
          await h.close();
        }
      }),
    receipts: () =>
      serial(async () => {
        const names = await readdir(directory);
        if (names.length > 4096 || names.some((n) => !/^profile-[0-9a-f-]{36}\.wal$/.test(n)))
          throw fail("receipt inventory");
        const records: ProfileReceipt[] = [];
        for (const name of names.sort()) {
          const record = decode(await read(name.slice(8, -4)), ownerSid);
          if (native.derive(record.name) !== record.sid) throw fail("receipt derivation");
          records.push(record);
        }
        return records;
      }),
    validate: (profile) => serial(() => validate(profile)),
    remove: (profile, live) =>
      serial(async () => {
        const record = await validate(profile);
        if (record.closed) return;
        if (live) {
          assertOwnedAppContainerProfile(live);
          if (live.name !== record.name || live.sid !== record.sid) throw fail("foreign live owner");
          live.close();
        } else native.remove(record.name);
        const file = fileFor(record.id),
          before = await read(record.id),
          h = await open(file, "r+");
        try {
          decode(
            await append(h, { id: record.id, name: record.name, sid: record.sid, ownerSid, stage: "closed" }, before),
            ownerSid,
          );
        } finally {
          await h.close();
        }
      }),
  };
}

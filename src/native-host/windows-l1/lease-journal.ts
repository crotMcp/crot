/**
 * AD-29 durable lease protocol. Trusted host component, not an RPC surface and
 * not a Windows availability predicate. Native identity/SD validation, pinned
 * restore and actor draining belong to LeaseRecoveryNative, NOT this journal.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CrotError } from "../../core/errors.js";
import type { PrivateFileProtection } from "../../core/platform/types.js";
import { isSameOrAncestorWindowsPath, validateWindowsPath } from "../validation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PACKAGE = /^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/;
const JOB = /^Local\\crot-l1-job-[0-9a-f]{48}$/;
const FILE = /^lease-([0-9a-f-]{36})\.wal$/;
const LIMIT = 32 * 1024 * 1024;
const MAX_JOURNALS = 64;
const MAX_JOBS = 4096;
const ZERO = "0".repeat(64);
const fail = (stage: string) =>
  new CrotError("CONFINEMENT_FAILED", `Windows lease journal: ${stage} failed.`, { stage });
const descriptor = z
  .string()
  .min(4)
  .max(87384)
  .refine((s) => {
    const b = Buffer.from(s, "base64");
    return b.length >= 20 && b.length <= 65536 && b.toString("base64") === s;
  });
const identity = z
  .object({
    volume: z.string().regex(/^\\\\\?\\Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\$/),
    fileId: z.string().regex(/^[0-9a-f]{16}$/),
    creationTime: z.string().regex(/^[0-9a-f]{16}$/),
    directory: z.boolean(),
    links: z.number().int().min(1).max(0xffffffff).optional(),
  })
  .strict();
const object = z
  .object({
    identity,
    role: z.enum(["ancestor", "workspace", "workspace-node", "workspace-link", "protected", "runtime", "runtime-node"]),
    original: descriptor,
    planned: descriptor,
  })
  .strict();
const planSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(UUID),
    profile: z
      .object({
        name: z.string().regex(/^crot\.l1\.[0-9a-f-]{36}$/),
        sid: z
          .string()
          .regex(PACKAGE)
          .refine((s) =>
            s
              .split("-")
              .slice(4)
              .every((p) => Number(p) <= 0xffffffff && String(Number(p)) === p),
          ),
      })
      .strict(),
    // Old v1 journals predate network-on: omission MUST mean off, never on.
    network: z.enum(["on", "off"]).default("off"),
    workspace: z.string().min(4).max(32700),
    objects: z.array(object).min(1).max(10000),
  })
  .strict();
export type LeaseObject = z.infer<typeof object>;
export type LeasePlan = z.infer<typeof planSchema>;
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan"), plan: planSchema }).strict(),
  z.object({ type: z.literal("active") }).strict(),
  z.object({ type: z.literal("job"), name: z.string().regex(JOB) }).strict(),
  z.object({ type: z.literal("closed") }).strict(),
]);
type Event = z.infer<typeof eventSchema>;
export interface LeaseRecord {
  readonly plan: LeasePlan;
  readonly active: boolean;
  readonly jobs: readonly string[];
  readonly closed: boolean;
}

function validatePlan(value: unknown): LeasePlan {
  const result = planSchema.safeParse(value);
  if (!result.success) throw fail("plan shape");
  const p = result.data;
  if (p.profile.name !== `crot.l1.${p.id}`) throw fail("profile ownership");
  validateWindowsPath(p.workspace);
  if (
    !/^[A-Za-z]:\\/.test(p.workspace) ||
    /[\u0000-\u001f/*?"<>|]/.test(p.workspace) ||
    p.workspace.slice(2).includes(":")
  )
    throw fail("workspace path");
  if (
    p.workspace
      .slice(3)
      .split("\\")
      .some((v) => !v || v === "." || v === ".." || /[. ]$/.test(v))
  )
    throw fail("workspace components");
  if (
    p.objects.filter((o) => o.role === "workspace").length !== 1 ||
    p.objects.some((o) => o.role === "workspace" && !o.identity.directory)
  )
    throw fail("workspace identity");
  const keys = p.objects.map((o) => `${o.identity.volume}:${o.identity.fileId}`);
  if (new Set(keys).size !== keys.length) throw fail("duplicate identity");
  return p;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function frame(sequence: number, previous: string, event: Event): string {
  const body = JSON.stringify({ sequence, previous, event });
  return JSON.stringify({ body, sha256: digest(body) }) + "\n";
}
/** Strict replay: no ignored tail, duplicate plans, jobs after close or gaps. */
export function decodeLeaseJournal(bytes: Buffer): LeaseRecord {
  return replay(bytes).record;
}
function replay(bytes: Buffer): { record: LeaseRecord; sequence: number; hash: string } {
  if (!bytes.length || bytes.length > LIMIT || bytes[bytes.length - 1] !== 10) throw fail("journal boundary");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let plan: LeasePlan | undefined,
    active = false,
    closed = false,
    previous = ZERO,
    sequence = 0;
  const jobs: string[] = [];
  for (const line of text.slice(0, -1).split("\n")) {
    let event: Event;
    try {
      const outer = z
        .object({ body: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(JSON.parse(line));
      if (digest(outer.body) !== outer.sha256) throw fail("checksum");
      const inner = z
        .object({ sequence: z.number().int(), previous: z.string(), event: eventSchema })
        .strict()
        .parse(JSON.parse(outer.body));
      if (inner.sequence !== sequence || inner.previous !== previous) throw fail("event chain");
      event = inner.event;
      previous = outer.sha256;
    } catch {
      throw fail("journal decode");
    }
    if (closed) throw fail("events after close");
    if (event.type === "plan") {
      if (sequence !== 0 || plan) throw fail("duplicate plan");
      plan = validatePlan(event.plan);
    } else {
      if (!plan) throw fail("missing plan");
      if (event.type === "active") {
        if (active) throw fail("duplicate activation");
        active = true;
      } else if (event.type === "job") {
        if (!active || jobs.includes(event.name) || jobs.length >= MAX_JOBS) throw fail("job ownership");
        jobs.push(event.name);
      } else closed = true;
    }
    sequence++;
  }
  if (!plan) throw fail("missing plan");
  return { record: { plan, active, jobs, closed }, sequence, hash: previous };
}

export interface LeaseJournalStore {
  /** One immutable plan, committed before ANY native mutation. */
  create(plan: LeasePlan): Promise<void>;
  read(id: string): Promise<LeaseRecord>;
  list(): Promise<readonly LeaseRecord[]>;
  append(id: string, event: Exclude<Event, { type: "plan" }>): Promise<void>;
  /** Under the lifetime lock, prune only a validated durable closed tombstone. */
  pruneClosed?(id: string): Promise<void>;
  /** Release the OS lock, never unlink/age out another process's lock file. */
  close(): Promise<void>;
}
export interface LeaseStoreOptions {
  readonly directory: string;
  readonly privateFiles: PrivateFileProtection;
  /** Native exclusive no-share handle; must reject links/reparse and be noninheritable. */
  readonly lock: (file: string) => Promise<{ close(): void }>;
  /** Tests only: the production implementation MUST be FileHandle.sync. */
  readonly sync?: (handle: FileHandle) => Promise<void>;
}

/**
 * Append-only owner-protected WAL. No rename/delete/rewrite during commit;
 * completed journals are retained as tombstones. Exclusive native lock spans
 * listing, preflight and all recovery work. A torn/failed write poisons this
 * instance and remains on disk for fail-closed restart diagnostics.
 */
export async function openLeaseJournalStore(options: LeaseStoreOptions): Promise<LeaseJournalStore> {
  const { directory, privateFiles, lock } = options;
  if (
    !path.isAbsolute(directory) ||
    !privateFiles.enforced ||
    !["windows-acl", "posix-mode"].includes(privateFiles.mechanism)
  )
    throw fail("private storage admission");
  await privateFiles.ensureDirectory(directory);
  const check = async (file: string, isDirectory: boolean) => {
    const info = await lstat(file);
    if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1))
      throw fail("private object type");
    if ((await privateFiles.inspect(file)).ownerOnly !== true) throw fail("private descriptor");
  };
  await check(directory, true);
  const sync = options.sync ?? ((h: FileHandle) => h.sync());
  const protectEmpty = async (file: string): Promise<FileHandle> => {
    const h = await open(file, "wx+", privateFiles.fileMode);
    try {
      await privateFiles.protectFile?.(file);
      await check(file, false);
      return h;
    } catch (error) {
      await h.close();
      throw error;
    }
  };
  const lockFile = path.join(directory, "lease.lock");
  try {
    const h = await protectEmpty(lockFile);
    await h.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await check(lockFile, false);
  const ownership = await lock(lockFile);
  let closing = false,
    closed = false,
    poisoned = false,
    tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(async () => {
      if (closing || closed || poisoned) throw fail(closing || closed ? "closed store" : "poisoned store");
      try {
        return await operation();
      } catch (error) {
        poisoned = true;
        throw error;
      }
    });
    tail = result.catch(() => undefined);
    return result;
  };
  const filename = (id: string) => {
    if (!UUID.test(id)) throw fail("lease id");
    return path.join(directory, `lease-${id}.wal`);
  };
  const read = async (id: string) => {
    const file = filename(id);
    await check(file, false);
    const h = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await h.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > LIMIT) throw fail("journal file size");
      const result = replay(await h.readFile());
      if (result.record.plan.id !== id) throw fail("journal file identity");
      return result;
    } finally {
      await h.close();
    }
  };
  const write = async (h: FileHandle, bytes: Buffer, position: number) => {
    let done = 0;
    while (done < bytes.length) {
      const { bytesWritten } = await h.write(bytes, done, bytes.length - done, position + done);
      if (bytesWritten < 1) throw fail("short journal write");
      done += bytesWritten;
    }
    await sync(h);
  };
  return {
    create: (value) =>
      serialized(async () => {
        const p = validatePlan(value);
        // Check both spelling and native resolved locations at the platform seam.
        // This lexical check alone is not an ancestor/reparse admission proof.
        if (isSameOrAncestorWindowsPath(p.workspace, directory.replaceAll("/", "\\")))
          throw fail("journal inside workspace");
        const bytes = Buffer.from(frame(0, ZERO, { type: "plan", plan: p }));
        if (bytes.length > LIMIT) throw fail("journal plan size");
        const existing = (await readdir(directory)).filter((s) => FILE.test(s));
        if (existing.length >= MAX_JOURNALS) throw fail("journal capacity");
        const h = await protectEmpty(filename(p.id));
        try {
          await write(h, bytes, 0);
          // POSIX needs the parent directory committed as well. On Windows,
          // FileHandle.sync maps to FlushFileBuffers on this new NTFS file;
          // filesystem/volume admission is a native-plan prerequisite.
          if (process.platform !== "win32") {
            const directoryHandle = await open(directory, "r");
            try {
              await directoryHandle.sync();
            } finally {
              await directoryHandle.close();
            }
          }
        } finally {
          await h.close();
        }
      }),
    read: (id) => serialized(async () => (await read(id)).record),
    list: () =>
      serialized(async () => {
        const names = await readdir(directory);
        if (names.some((s) => s !== "lease.lock" && !FILE.test(s))) throw fail("unrecognized journal entry");
        if (names.length > MAX_JOURNALS + 1) throw fail("journal capacity");
        const records: LeaseRecord[] = [];
        for (const name of names.sort()) {
          if (name === "lease.lock") continue;
          const id = FILE.exec(name)![1]!;
          records.push((await read(id)).record);
        }
        return records;
      }),
    pruneClosed: (id) =>
      serialized(async () => {
        if (!(await read(id)).record.closed) throw fail("cannot prune an open lease");
        await unlink(filename(id));
        if (process.platform !== "win32") {
          const dir = await open(directory, "r");
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        }
      }),
    append: (id, event) =>
      serialized(async () => {
        const file = filename(id),
          current = await read(id);
        const bytes = Buffer.from(frame(current.sequence, current.hash, event));
        const h = await open(file, "r+");
        try {
          const before = await h.readFile();
          // Validate the COMPLETE proposed history before making it durable.
          // No unchecked second plan or invalid lifecycle edge can be appended.
          replay(Buffer.concat([before, bytes]));
          await write(h, bytes, before.length);
        } finally {
          await h.close();
        }
      }),
    close: async () => {
      closing = true;
      await tail;
      if (closed) return;
      // A failed CloseHandle retains the ownership resource for explicit retry.
      ownership.close();
      closed = true;
    },
  };
}

/** Generate a trusted lease identity, not an actor-selected profile name. */
export const newLeaseId = (): string => randomUUID();

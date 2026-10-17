/** Full adapter: journal plans never grant authority merely by naming a path. */
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import type { AppContainerProfile } from "./appcontainer-profile.js";
import { leaseDescriptor, loadLeaseAclObjects, prepareNewWorkspaceSidRemoval } from "./lease-acl.js";
import type { LeaseObject, LeasePlan } from "./lease-journal.js";
import type { LeaseRecoveryNative, PinnedLeaseObject } from "./lease-recovery.js";
import type { DurableProfiles } from "./profile-receipts.js";
import type { AppContainerNetworkLease, AppContainerNetworkNative } from "./network.js";
const fail = (stage: string) =>
  new CrotError("CONFINEMENT_FAILED", `Windows native recovery: ${stage} failed.`, { stage });
export type LeaseAclApi = Awaited<ReturnType<typeof loadLeaseAclObjects>>;
type Hold = ReturnType<LeaseAclApi["hold"]>;
const missingWorkspaceNode = (o: LeaseObject, cause: unknown) =>
  o.role === "workspace-node" &&
  cause instanceof CrotError &&
  cause.details?.nativeCode === 2 &&
  ["guard by ID open", "open saved file ID"].includes(String(cause.details?.stage));
const key = (o: LeaseObject) => `${o.identity.volume}:${o.identity.fileId}`;
const dos = (p: string) =>
  p
    .replace(/^\\\\\?\\/, "")
    .replace(/\\+$/, "")
    .toLowerCase();
const inside = (root: string, p: string) => dos(p) === dos(root) || dos(p).startsWith(`${dos(root)}\\`);
const pending = new Set<Hold>();
const close = (holds: readonly Hold[]) => {
  let error: unknown;
  for (const h of [...holds].reverse()) {
    pending.add(h);
    try {
      h.close();
      pending.delete(h);
    } catch (cause) {
      error ??= cause;
    }
  }
  if (error) throw error;
};
/** Compare foreign ACE bytes/order, not a lossy SDDL projection. */
const aces = (b: Buffer) => {
  const acl = leaseDescriptor(b).dacl,
    result: string[] = [];
  let p = 8;
  for (let i = 0; i < acl.readUInt16LE(4); i++) {
    const n = acl.readUInt16LE(p + 2);
    result.push(acl.subarray(p, p + n).toString("hex"));
    p += n;
  }
  return result;
};
export function validateNativeLeaseDelta(object: LeaseObject, sid: string): void {
  const before = leaseDescriptor(Buffer.from(object.original, "base64")),
    after = leaseDescriptor(Buffer.from(object.planned, "base64"));
  if (
    before.control !== after.control ||
    before.rmControl !== after.rmControl ||
    !before.owner.equals(after.owner) ||
    !before.group.equals(after.group) ||
    !before.sacl.equals(after.sacl)
  )
    throw fail("foreign descriptor sections");
  const removed = prepareNewWorkspaceSidRemoval({ ...object, role: "workspace-node", original: object.planned }, sid);
  // A fresh SID MUST NOT already be present in the original descriptor.
  const originalRemoved = prepareNewWorkspaceSidRemoval({ ...object, role: "workspace-node" }, sid);
  if (
    originalRemoved.planned !== object.original ||
    JSON.stringify(aces(Buffer.from(removed.planned, "base64"))) !==
      JSON.stringify(aces(Buffer.from(object.original, "base64")))
  )
    throw fail("foreign ACE plan mutation");
  if (object.role === "workspace-link") {
    // A by-ID NTFS open can report ANY hardlink name, including the original
    // outside name. Only this exact file-global read-only delta may bypass the
    // single-name containment check; no writable outside object is admitted.
    if (object.identity.directory || (object.identity.links ?? 0) < 2) throw fail("read-only hardlink identity");
    const values = sid.split("-").slice(3).map(Number),
      binarySid = Buffer.alloc(8 + values.length * 4);
    binarySid[0] = 1;
    binarySid[1] = values.length;
    binarySid[7] = 15;
    values.forEach((value, i) => binarySid.writeUInt32LE(value, 8 + i * 4));
    const ace = (type: number, mask: number) => {
      const b = Buffer.alloc(8 + binarySid.length);
      b[0] = type;
      b.writeUInt16LE(b.length, 2);
      b.writeUInt32LE(mask, 4);
      binarySid.copy(b, 8);
      return b.toString("hex");
    };
    const originalAces = aces(Buffer.from(object.original, "base64")),
      plannedAces = aces(Buffer.from(object.planned, "base64"));
    if (
      plannedAces.length !== originalAces.length + 2 ||
      ![ace(1, 0x000d0156), ace(0, 0x1200a9)].every(
        (expected) => plannedAces.filter((a) => a === expected).length === 1,
      )
    )
      throw fail("read-only hardlink ACE delta");
  }
}
export function createNativeLeaseAdapter(options: {
  acl: LeaseAclApi;
  profiles: DurableProfiles;
  ownerSid: string;
  journalDirectory: string;
  receiptDirectory: string;
  network: AppContainerNetworkNative;
  drain: (ownerSid: string, packageSid: string) => Promise<unknown>;
  live: Map<string, { profile: AppContainerProfile; network?: AppContainerNetworkLease; stop(): Promise<void> }>;
}): LeaseRecoveryNative {
  const { acl, profiles, live } = options;
  const observe = (o: LeaseObject) => {
    const h = acl.hold(o, false);
    try {
      return h.snapshot();
    } finally {
      close([h]);
    }
  };
  return {
    validatePlan: async (plan) => {
      close([...pending]);
      await profiles.validate(plan.profile);
      const root = plan.objects.find((o) => o.role === "workspace");
      if (
        !root ||
        !root.identity.directory ||
        plan.objects.length > 10000 ||
        new Set(plan.objects.map(key)).size !== plan.objects.length
      )
        throw fail("plan identity set");
      const workspace = observe(root);
      if (dos(workspace.dosPath) !== dos(plan.workspace)) throw fail("workspace root moved");
      const runtime = plan.objects.filter((o) => o.role === "runtime").map((o) => observe(o).dosPath);
      for (const storage of [options.journalDirectory, options.receiptDirectory]) {
        // Resolve the private storage by a native object too, not lexical policy.
        const saved = acl.capture(storage, "protected", plan.profile.sid, 0),
          actual = observe(saved);
        if (inside(workspace.dosPath, actual.dosPath) || runtime.some((r) => inside(r, actual.dosPath)))
          throw fail("journal inside actor tree");
      }
      for (const object of plan.objects) {
        validateNativeLeaseDelta(object, plan.profile.sid);
        let current: ReturnType<typeof observe>;
        try {
          current = observe(object);
        } catch (cause) {
          if (missingWorkspaceNode(object, cause)) continue;
          throw cause;
        }
        if (object.role === "workspace-node" && !inside(workspace.volumePath, current.volumePath))
          throw fail("workspace node escaped");
        if (object.role === "runtime-node" && !runtime.some((r) => inside(r, current.dosPath)))
          throw fail("runtime node escaped");
        if (object.role === "ancestor" && ![workspace.dosPath, ...runtime].some((r) => inside(current.dosPath, r)))
          throw fail("unrelated ancestor");
        if (object.role === "protected" && runtime.some((r) => inside(r, current.dosPath)))
          throw fail("protected runtime overlap");
      }
    },
    holdGuards: async (plan) => {
      const holds: Hold[] = [];
      try {
        for (const o of plan.objects) if (o.role !== "workspace-node") holds.push(acl.hold(o));
        return { close: () => close(holds) };
      } catch (cause) {
        close(holds);
        throw cause;
      }
    },
    drainActors: async (record) => {
      // Production jobs are unnamed kill-on-last-handle-close. Owner death
      // closes all of them in the kernel; a SID inventory proves the result.
      // Named research jobs must not be adopted merely from a saved name.
      if (record.jobs.length) throw fail("unqualified named Job recovery");
      await live.get(record.plan.profile.name)?.stop();
      await options.drain(options.ownerSid, record.plan.profile.sid);
    },
    pin: (object): PinnedLeaseObject => {
      try {
        return acl.pin(object);
      } catch (cause) {
        if (!missingWorkspaceNode(object, cause)) throw cause;
        // Absence is an NTFS-by-ID FILE_NOT_FOUND result, not an ENOENT
        // pathname guess. Reuse, reparse, access denial and links never qualify.
        return {
          state: () => {
            try {
              observe(object);
              return "conflict";
            } catch (error) {
              if (missingWorkspaceNode(object, error)) return "absent";
              throw error;
            }
          },
          apply: () => {
            throw fail("apply deleted workspace identity");
          },
          restore: () => {
            throw fail("restore deleted workspace identity");
          },
          close: () => undefined,
        };
      }
    },
    stripNewWorkspaceObjects: async (plan) => {
      const root = plan.objects.find((o) => o.role === "workspace")!,
        original = new Set(plan.objects.map(key)),
        held: Hold[] = [];
      let count = 0;
      const visit = async (object: LeaseObject, depth: number) => {
        if (depth > 64 || ++count > 10000) throw fail("workspace walk bound");
        const hold = acl.hold(object);
        held.push(hold);
        const info = hold.snapshot();
        const rootPath = held[0]!.snapshot().volumePath;
        if (!inside(rootPath, info.volumePath)) throw fail("workspace walk escaped");
        // Strip parent before enumeration: concurrently created descendants
        // can no longer inherit the transient SID from this directory.
        if (!original.has(key(object))) hold.stripOwnSid(plan.profile.sid);
        if (!object.identity.directory) return;
        const directory = dos(info.dosPath);
        const names = await readdir(directory);
        if (names.length > 10000) throw fail("directory bound");
        for (const name of names.sort()) {
          if (!name || name === "." || name === ".." || /[\\/:\x00-\x1f]/.test(name)) throw fail("directory entry");
          const child = acl.capture(path.win32.join(directory, name), "workspace-node", plan.profile.sid, 0);
          await visit(child, depth + 1);
        }
        const after = await readdir(directory);
        if (JSON.stringify(names.sort()) !== JSON.stringify(after.sort())) throw fail("workspace enumeration changed");
      };
      try {
        await visit(root, 0);
      } finally {
        close(held);
      }
    },
    removeNetwork: async (plan) => {
      const owner = live.get(plan.profile.name);
      if (owner?.network) await owner.network.close();
      else await options.network.remove(plan.profile.sid);
      if (await options.network.contains(plan.profile.sid)) throw fail("loopback cleanup readback");
    },
    deleteProfile: async (plan) => {
      const owner = live.get(plan.profile.name);
      await profiles.remove(plan.profile, owner?.profile);
      live.delete(plan.profile.name);
    },
  };
}

/** Snapshot a local tree before mutation, retaining roots/ancestors as guards. */
export async function planNativeLease(options: {
  acl: LeaseAclApi;
  profile: AppContainerProfile;
  workspace: string;
  network: "on" | "off";
  writableRuntime: readonly string[];
  readOnlyRuntime: readonly string[];
  protectedPaths: readonly string[];
}): Promise<{ plan: LeasePlan; close(): void }> {
  const { acl, profile } = options,
    objects: LeaseObject[] = [],
    holds: Hold[] = [],
    seen = new Set<string>();
  const add = (p: string, role: LeaseObject["role"], rights: number, deny = false, inherit = false, guard = true) => {
    const o = acl.capture(p, role, profile.sid, rights, deny, inherit, "readonly"),
      k = key(o);
    if (seen.has(k)) return undefined;
    seen.add(k);
    objects.push(o);
    if (guard || o.role === "workspace-link") {
      try {
        holds.push(acl.hold(o));
      } catch (cause) {
        if (cause instanceof CrotError)
          throw new CrotError(
            cause.code,
            `Windows lease guard ${String(cause.details?.stage)}:${String(cause.details?.nativeCode)} (${o.role}; ${p})`,
            cause.details,
            { cause },
          );
        throw cause;
      }
    }
    return o;
  };
  try {
    const roots = [options.workspace, ...options.writableRuntime, ...options.readOnlyRuntime];
    for (let i = 0; i < roots.length; i++) {
      if (options.protectedPaths.some((p) => inside(p, roots[i]!))) throw fail("root inside protected storage");
      for (let j = 0; j < i; j++)
        if (inside(roots[i]!, roots[j]!) || inside(roots[j]!, roots[i]!)) throw fail("overlapping actor roots");
    }
    for (const root of roots) {
      if (!/^[A-Za-z]:\\/.test(root) || root.length <= 3) throw fail("literal root path");
      const chain: string[] = [];
      let p = path.win32.dirname(root);
      for (;;) {
        chain.unshift(p);
        const next = path.win32.dirname(p);
        if (next === p) break;
        p = next;
        if (chain.length > 64) throw fail("ancestor depth");
      }
      for (const ancestor of chain) add(ancestor, "ancestor", 0x1000a9);
    }
    let protectedCount = 0;
    const protect = async (p: string, depth: number) => {
      if (++protectedCount > 10000 || depth > 64) throw fail("protected snapshot bound");
      const s = await lstat(p).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return undefined;
        throw e;
      });
      if (!s) return;
      if (s.isSymbolicLink()) throw fail("protected reparse");
      const o = add(p, "protected", 0x1f01ff, true, s.isDirectory());
      if (o && s.isDirectory())
        for (const n of (await readdir(p)).sort()) await protect(path.win32.join(p, n), depth + 1);
    };
    for (const p of options.protectedPaths) await protect(p, 0);
    let count = 0;
    const walk = async (p: string, role: LeaseObject["role"], rights: number, depth: number) => {
      if (++count > 10000 || depth > 64) throw fail("snapshot bound");
      const s = await lstat(p);
      if (s.isSymbolicLink()) throw fail("snapshot reparse");
      const o = add(p, role, rights, false, s.isDirectory(), !role.endsWith("node"));
      if (!o) return;
      if (s.isDirectory())
        for (const n of (await readdir(p)).sort())
          await walk(
            path.win32.join(p, n),
            role === "workspace" || role === "workspace-node" ? "workspace-node" : "runtime-node",
            rights,
            depth + 1,
          );
    };
    await walk(options.workspace, "workspace", 0x1301bf, 0);
    for (const root of options.writableRuntime) await walk(root, "runtime", 0x1301bf, 0);
    for (const root of options.readOnlyRuntime) await walk(root, "runtime", 0x1200a9, 0);
    if (objects.filter((o) => o.role === "workspace").length !== 1) throw fail("protected workspace overlap");
    return {
      plan: {
        version: 1,
        id: profile.name.slice(8),
        profile: { name: profile.name, sid: profile.sid },
        network: options.network,
        workspace: options.workspace,
        objects,
      },
      close: () => close(holds),
    };
  } catch (cause) {
    close(holds);
    throw cause;
  }
}

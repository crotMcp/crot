/** Real NTFS object-handle restoration. Not profile/Job/network/backend qualification. */
import { link, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadLeaseAclObjects,
  prepareNewWorkspaceSidRemoval,
  leaseDescriptor,
} from "../../../src/native-host/windows-l1/lease-acl.js";
import { createServicePrivateFiles } from "../../../src/service/private-files.js";
import { isWindows, makeTempDirs, type TempDirs } from "../../helpers.js";
const sid = "S-1-15-2-1-2-3-4-5-6-7",
  other = "S-1-15-2-7-6-5-4-3-2-1";
describe.runIf(isWindows)("Windows native lease ACL transactions", () => {
  let dirs: TempDirs, api: Awaited<ReturnType<typeof loadLeaseAclObjects>>, file: string;
  beforeEach(async () => {
    dirs = await makeTempDirs();
    api = await loadLeaseAclObjects();
    file = path.join(dirs.workspace, "file.txt");
    await writeFile(file, "unchanged bytes");
    await createServicePrivateFiles(true).protectFile!(file);
  });
  afterEach(async () => {
    await dirs?.cleanup();
  });
  it("holds a real by-ID data guard against rename and strips only an owned ACE", async () => {
    const object = api.capture(file, "workspace-node", sid, 0x1301bf),
      pin = api.pin(object);
    pin.apply();
    pin.close();
    const guard = api.hold(object);
    try {
      expect(guard.snapshot().dosPath.toLowerCase()).toContain("file.txt");
      await expect(rename(file, file + ".moved")).rejects.toMatchObject({
        code: expect.stringMatching(/EPERM|EACCES|EBUSY/),
      });
      guard.stripOwnSid(sid);
      expect(leaseDescriptor(Buffer.from(guard.snapshot().descriptor, "base64")).dacl).toEqual(
        leaseDescriptor(Buffer.from(object.original, "base64")).dacl,
      );
    } finally {
      guard.close();
    }
    await rename(file, file + ".moved");
  });
  it("precomputes the installed SD without mutation and restores the exact original DACL/control", () => {
    const object = api.capture(file, "workspace-node", sid, 0x1301bf),
      pin = api.pin(object);
    try {
      expect(pin.state()).toBe("original");
      pin.apply();
      expect(pin.state()).toBe("planned");
      pin.restore();
      expect(pin.state()).toBe("original");
      pin.restore();
    } finally {
      pin.close();
    }
    expect(api.capture(file, "workspace-node", sid, 0x1301bf).original).toBe(object.original);
  });
  it("follows the saved object identity after rename, never the replacement at its old path", async () => {
    const object = api.capture(file, "workspace-node", sid, 0x1301bf),
      moved = file + ".moved";
    await rename(file, moved);
    await writeFile(file, "replacement");
    await createServicePrivateFiles(true).protectFile!(file);
    const replacement = api.capture(file, "workspace-node", sid, 0x1301bf).original,
      pin = api.pin(object);
    try {
      pin.apply();
      expect(pin.state()).toBe("planned");
      pin.restore();
    } finally {
      pin.close();
    }
    expect(api.capture(moved, "workspace-node", sid, 0x1301bf).original).toBe(object.original);
    expect(api.capture(file, "workspace-node", sid, 0x1301bf).original).toBe(replacement);
    expect(await readFile(file, "utf8")).toBe("replacement");
  });
  it("rejects foreign ACL edits rather than restoring an old snapshot over them", () => {
    const original = api.capture(file, "workspace-node", sid, 0x1301bf),
      first = api.pin(original);
    first.apply();
    const foreign = api.capture(file, "workspace-node", other, 0x1200a9),
      second = api.pin(foreign);
    try {
      second.apply();
      expect(first.state()).toBe("conflict");
      expect(() => first.restore()).toThrow("foreign descriptor changed");
      expect(second.state()).toBe("planned");
      second.restore();
      first.restore();
    } finally {
      second.close();
      first.close();
    }
  });
  it("rejects a new external hardlink after capture, before any ACL mutation", async () => {
    const object = api.capture(file, "workspace-node", sid, 0x1301bf);
    await link(file, path.join(dirs.outside, "alias.txt"));
    expect(() => api.pin(object)).toThrow("links changed");
    expect(() => api.capture(file, "workspace-node", sid, 0x1301bf)).toThrow("multi-link");
  });
  it("strips only the owned inherited SID on a new workspace node after parent restore", async () => {
    const root = api.capture(dirs.workspace, "workspace", sid, 0x1301bf, false, true),
      rootPin = api.pin(root);
    let childPin: ReturnType<typeof api.pin> | undefined;
    try {
      rootPin.apply();
      const child = path.join(dirs.workspace, "new-after-acquire.txt");
      await writeFile(child, "new content");
      // Foreign ACE is deliberately added and MUST survive exact byte readback.
      const foreign = api.capture(child, "workspace-node", other, 0x1200a9),
        foreignPin = api.pin(foreign);
      try {
        foreignPin.apply();
      } finally {
        foreignPin.close();
      }
      rootPin.restore();
      const before = api.capture(child, "workspace-node", sid, 0x1301bf),
        removal = prepareNewWorkspaceSidRemoval(before, sid);
      expect(removal.planned).not.toBe(before.original);
      childPin = api.pin(removal);
      childPin.apply();
      const after = api.capture(child, "workspace-node", sid, 0x1301bf).original;
      expect(after).toBe(removal.planned);
      expect(prepareNewWorkspaceSidRemoval({ ...before, original: after }, sid).planned).toBe(after);
      const old = leaseDescriptor(Buffer.from(before.original, "base64")),
        next = leaseDescriptor(Buffer.from(after, "base64"));
      for (const field of ["owner", "group", "sacl"] as const) expect(next[field]).toEqual(old[field]);
      expect(next.control).toBe(old.control);
      expect(await readFile(child, "utf8")).toBe("new content");
    } finally {
      childPin?.close();
      rootPin.restore();
      rootPin.close();
    }
  });
  it("rejects a stale creation time even if the volume/file ID still exists", () => {
    const object = api.capture(file, "workspace-node", sid, 0x1301bf);
    object.identity.creationTime = "0000000000000000";
    expect(() => api.pin(object)).toThrow("identity");
  });
  it("restores directory ACLs nonpropagatingly without rewriting an unrelated child descriptor", async () => {
    const dir = path.join(dirs.workspace, "directory");
    await mkdir(dir);
    await createServicePrivateFiles(true).protectFile!(dir);
    const child = path.join(dir, "child.txt");
    await writeFile(child, "original");
    const before = api.capture(child, "workspace-node", sid, 0x1301bf).original;
    const object = api.capture(dir, "workspace", sid, 0x1301bf, false, true),
      pin = api.pin(object);
    try {
      pin.apply();
      pin.restore();
    } finally {
      pin.close();
    }
    expect(api.capture(child, "workspace-node", sid, 0x1301bf).original).toBe(before);
  });
});

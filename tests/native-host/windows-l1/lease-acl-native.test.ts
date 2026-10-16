/** Real NTFS object-handle restoration. Not profile/Job/network/backend qualification. */
import { link, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLeaseAclObjects } from "../../../src/native-host/windows-l1/lease-acl.js";
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

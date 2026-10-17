/** Protocol tests; native profile removal is qualified separately on Windows. */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppContainerProfiles } from "../../../src/native-host/windows-l1/appcontainer-profile.js";
import { openDurableProfiles } from "../../../src/native-host/windows-l1/profile-receipts.js";
import { createServicePrivateFiles } from "../../../src/service/private-files.js";
const sid = "S-1-15-2-1-2-3-4-5-6-7",
  ownerSid = "S-1-5-21-1-2-3-1001";
describe("durable fresh profile receipts", () => {
  let root: string, directory: string, creates: string[], removed: string[], status: number;
  const privateFiles = createServicePrivateFiles(process.platform === "win32");
  const native = {
    derive: () => sid,
    remove: (name: string) => {
      removed.push(name);
    },
  };
  const profiles = () =>
    createAppContainerProfiles({
      create: (name, output) => {
        creates.push(name);
        output.value = 123;
        return status;
      },
      sidText: () => sid,
      remove: (name) => {
        removed.push(name);
        return 0;
      },
      freeSid: () => undefined,
    });
  const open = () => openDurableProfiles({ directory, ownerSid, privateFiles, native, profiles: profiles() });
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "crot-profile-receipt-"));
    directory = path.join(root, "receipts");
    creates = [];
    removed = [];
    status = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("flushes an intent before native creation and validates the fresh receipt after reopen", async () => {
    const o = await open(),
      profile = await o.create();
    expect(creates).toEqual([profile.name]);
    const record = await (await open()).validate(profile);
    expect(record).toMatchObject({ name: profile.name, sid, closed: false });
    expect((await o.receipts()).length).toBe(1);
    await o.remove(profile, profile);
    expect(removed).toEqual([profile.name]);
    expect((await (await open()).validate(profile)).closed).toBe(true);
    await (await open()).remove(profile);
    expect(removed).toHaveLength(1);
  });
  it("never adopts or deletes a pre-existing/native-failed profile", async () => {
    status = 183;
    const o = await open();
    await expect(o.create()).rejects.toThrow("profile creation");
    expect(removed).toHaveLength(0);
    await expect((await open()).receipts()).rejects.toThrow("ambiguous profile creation");
    expect(removed).toHaveLength(0);
  });
  it("retains and rejects a torn S_OK receipt, never inferring ownership from SID/name", async () => {
    const o = await open(),
      profile = await o.create(),
      name = (await readdir(directory))[0]!;
    const file = path.join(directory, name),
      bytes = await readFile(file);
    await writeFile(file, bytes.subarray(0, bytes.length - 1));
    await expect((await open()).remove(profile)).rejects.toThrow("record boundary");
    expect(removed).toHaveLength(0);
    profile.close();
  });
  it("rejects changed derivation, foreign receipt identity and unrecognised inventory", async () => {
    const o = await open(),
      profile = await o.create();
    await expect((await open()).validate({ ...profile, sid: sid + "0" })).rejects.toThrow("ownership proof");
    const other = await openDurableProfiles({
      directory,
      ownerSid: ownerSid + "0",
      privateFiles,
      native,
      profiles: profiles(),
    });
    await expect(other.receipts()).rejects.toThrow("record decode");
    await writeFile(path.join(directory, "foreign.json"), "{}");
    await expect((await open()).receipts()).rejects.toThrow("receipt inventory");
    expect(removed).toHaveLength(0);
    profile.close();
  });
  it("does not accept a structural live-profile copy as proof of native deletion", async () => {
    const o = await open(),
      profile = await o.create();
    await expect(o.remove(profile, { ...profile })).rejects.toThrow("unowned profile");
    expect(removed).toHaveLength(0);
    profile.close();
  });
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExposureTracker } from "../../src/core/approvals/exposure.js";
import { RemoteExposureStore, REMOTE_EXPOSURE_FILE_NAME } from "../../src/core/approvals/remote-exposure.js";
import {
  localPrincipal,
  newLocalExposureScope,
  newSession,
  remoteExposureScope,
  remotePrincipal,
  type AuthContext,
} from "../../src/core/auth/principal.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { makeTempDirs, type TempDirs } from "../helpers.js";

/** AD-15 point 8: exposure scopes and the persisted state of remote scopes. */

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await dirs.cleanup();
});

const privateFiles = () => createPrivateFileProtection(process.platform === "win32");
const KEY = remoteExposureScope("acct", "device", "client").remoteKey!;

const remote = (clientId = "client", scope = true): AuthContext => {
  const principal = remotePrincipal({
    id: "acct",
    transport: "relay",
    authMethod: "oauth",
    accountId: "acct",
    deviceId: "device",
    clientId,
  });
  return scope ? { principal, exposureScope: remoteExposureScope("acct", "device", clientId) } : { principal };
};

describe("RemoteExposureStore", () => {
  it("creates an empty state file on first start and persists exposure as digests", async () => {
    const file = path.join(dirs.outside, "state", REMOTE_EXPOSURE_FILE_NAME);
    const store = await RemoteExposureStore.open(file, privateFiles());
    expect(store.failedClosed).toBe(false);
    expect(store.isExposed(KEY)).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, exposed: [] });
    store.markExposed(KEY);
    expect(store.isExposed(KEY)).toBe(true);
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("acct");
    expect(JSON.parse(text).exposed).toHaveLength(1);

    const reopened = await RemoteExposureStore.open(file, privateFiles());
    expect(reopened.isExposed(KEY)).toBe(true);
    expect(reopened.isExposed(remoteExposureScope("acct", "device", "other").remoteKey!)).toBe(false);
  });

  it.each([["{not json"], ['{"version":2,"exposed":[]}'], ['{"version":1,"exposed":["nope"]}'], [""]])(
    "fails closed on a malformed state (%s) and leaves the file untouched",
    async (content) => {
      const file = path.join(dirs.outside, REMOTE_EXPOSURE_FILE_NAME);
      await writeFile(file, content);
      const errors: unknown[] = [];
      const store = await RemoteExposureStore.open(file, privateFiles(), { onError: (e) => errors.push(e) });
      expect(store.failedClosed).toBe(true);
      expect(store.isExposed(KEY)).toBe(true);
      expect(errors).toHaveLength(1);
      store.markExposed(KEY);
      expect(await readFile(file, "utf8")).toBe(content);
    },
  );

  it("fails closed when the state cannot be read", async () => {
    const file = path.join(dirs.outside, REMOTE_EXPOSURE_FILE_NAME);
    await mkdir(file); // a directory: EISDIR
    const store = await RemoteExposureStore.open(file, privateFiles(), { onError: () => undefined });
    expect(store.failedClosed).toBe(true);
    expect(store.isExposed(KEY)).toBe(true);
  });

  it("the only way to clear exposure is reset(), used only by the service (AD-19 point 8)", () => {
    const methods = Object.getOwnPropertyNames(RemoteExposureStore.prototype).sort();
    expect(methods).toEqual(["constructor", "isExposed", "markExposed", "reset"]);
    // The tracker Core and the guard use has no way to clear a scope.
    expect(Object.getOwnPropertyNames(ExposureTracker.prototype).sort()).toEqual([
      "constructor",
      "isExposed",
      "recordSuccess",
      "sameScope",
      "scopeOf",
    ]);
  });

  it("reset: writes first, then clears one scope; refused while failed closed", async () => {
    const file = path.join(dirs.outside, REMOTE_EXPOSURE_FILE_NAME);
    const store = await RemoteExposureStore.open(file, privateFiles());
    const OTHER = remoteExposureScope("acct", "device", "other").remoteKey!;
    expect(store.reset(KEY)).toBe("already_clean");
    store.markExposed(KEY);
    store.markExposed(OTHER);
    expect(store.reset(KEY)).toBe("reset");
    expect(store.isExposed(KEY)).toBe(false);
    expect(store.isExposed(OTHER)).toBe(true);
    const reopened = await RemoteExposureStore.open(file, privateFiles());
    expect(reopened.isExposed(KEY)).toBe(false);
    expect(reopened.isExposed(OTHER)).toBe(true);

    const broken = path.join(dirs.outside, "broken.json");
    await writeFile(broken, "{not json");
    const failed = await RemoteExposureStore.open(broken, privateFiles(), { onError: () => undefined });
    expect(failed.reset(KEY)).toBe("failed_closed");
    expect(failed.isExposed(KEY)).toBe(true);
    expect(await readFile(broken, "utf8")).toBe("{not json");
  });
});

describe("ExposureTracker: scopes", () => {
  it("remote scopes are keyed by (account, device, client), not by object identity", () => {
    const tracker = new ExposureTracker({ remote: RemoteExposureStore.inMemory() });
    const a = remote();
    const a2 = remote();
    expect(tracker.sameScope(a, a2)).toBe(true);
    expect(tracker.sameScope(a, remote("other"))).toBe(false);
    expect(tracker.isExposed(a2)).toBe(false);
    tracker.recordSuccess(a, "browser.page_read");
    expect(tracker.isExposed(a2)).toBe(true);
    expect(tracker.isExposed(remote("other"))).toBe(false);
  });

  it("a remote principal never falls into a local scope", () => {
    const tracker = new ExposureTracker({ remote: RemoteExposureStore.inMemory() });
    const local: AuthContext = { principal: localPrincipal("stdio") };
    const session = newSession();
    // A remote principal with a local session still uses its remote scope.
    const withSession: AuthContext = { principal: remote(undefined, false).principal, session };
    tracker.recordSuccess(withSession, "network.request");
    expect(tracker.isExposed(remote())).toBe(true);
    expect(tracker.isExposed({ principal: localPrincipal("stdio"), session })).toBe(false);
    expect(tracker.isExposed(local)).toBe(false);
    expect(tracker.sameScope(withSession, { principal: localPrincipal("stdio"), session })).toBe(false);
  });

  it("a remote principal without identity is always exposed", () => {
    const tracker = new ExposureTracker({ remote: RemoteExposureStore.inMemory() });
    const anonymous: AuthContext = { principal: { id: "x", kind: "remote", transport: "relay", authMethod: "oauth" } };
    expect(tracker.isExposed(anonymous)).toBe(true);
  });

  it("without a store every remote scope is exposed (fail closed)", () => {
    const tracker = new ExposureTracker();
    expect(tracker.isExposed(remote())).toBe(true);
  });

  it("local scopes: the exposure scope takes precedence over the session", () => {
    const tracker = new ExposureTracker();
    const scope = newLocalExposureScope();
    const a: AuthContext = { principal: localPrincipal("http"), exposureScope: scope, session: newSession() };
    const b: AuthContext = { principal: localPrincipal("http"), exposureScope: scope, session: newSession() };
    expect(tracker.sameScope(a, b)).toBe(true);
    tracker.recordSuccess(a, "browser.tabs_list");
    expect(tracker.isExposed(b)).toBe(true);
    expect(tracker.isExposed({ principal: localPrincipal("http"), exposureScope: newLocalExposureScope() })).toBe(
      false,
    );
  });
});

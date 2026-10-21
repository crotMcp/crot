import { describe, expect, it } from "vitest";
import { hostManifest } from "../../src/cli/browser-install.js";
import { RELEASE_EXTENSION_IDS, RELEASE_EXTENSION_ORIGINS } from "../../src/cli/release-extension-ids.js";
describe("OD-10 release extension whitelist", () => {
  it("contains only pinned store/local IDs and is the manifest's sole authority", () => {
    expect(Object.keys(RELEASE_EXTENSION_IDS)).toEqual(["chromeWebStore", "edgeAddons", "localRc"]);
    expect(Object.values(RELEASE_EXTENSION_IDS).every((id) => /^[a-p]{32}$/.test(id))).toBe(true);
    expect(hostManifest("/crot/host").allowed_origins).toEqual(RELEASE_EXTENSION_ORIGINS);
    expect(Object.isFrozen(RELEASE_EXTENSION_IDS)).toBe(true);
  });
});

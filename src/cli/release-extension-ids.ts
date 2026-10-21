/**
 * Release-pinned extension identity catalog (OD-10).
 *
 * Store pages, web content and CLI input can never add an origin. The same
 * signed MV3 key is currently submitted to Chrome Web Store, Edge Add-ons and
 * local/RC builds, so all three channels intentionally resolve to one ID. If a
 * store reassigns an ID, that ID is changed here in a reviewed release.
 */
export const RELEASE_EXTENSION_IDS = Object.freeze({
  chromeWebStore: "bllcepanlhojbddfbbpegmnokpaakool",
  edgeAddons: "bllcepanlhojbddfbbpegmnokpaakool",
  localRc: "bllcepanlhojbddfbbpegmnokpaakool",
});
const EXTENSION_ID = /^[a-p]{32}$/;
for (const [channel, id] of Object.entries(RELEASE_EXTENSION_IDS)) {
  if (!EXTENSION_ID.test(id)) throw new Error(`invalid release extension id for ${channel}`);
}
export const RELEASE_EXTENSION_ORIGINS = Object.freeze(
  [...new Set(Object.values(RELEASE_EXTENSION_IDS))].sort().map((id) => `chrome-extension://${id}/`),
);

# Chrome Web Store and Edge Add-ons publication

1. From a clean checkout, run `npm ci`, `npm run check`, `npm run test:e2e:browser`, then `npm run package:extension`.
2. Record the produced `artifacts/extension/crot-browser-extension-<version>.zip` and matching `.sha256`. Re-run packaging and require the same digest.
3. Inspect the ZIP root: `manifest.json` and `dist/` only. Confirm MV3, the exact permission set, `<all_urls>`, `incognito: not_allowed`, and no forbidden fields. The packaging command fails otherwise.
4. Submit the identical archive to Chrome Web Store and Microsoft Edge Add-ons. Paste the exact texts from [PERMISSIONS.md](PERMISSIONS.md) and [PRIVACY.md](PRIVACY.md).
5. Complete each store's developer-account, branding, support URL and privacy-policy fields. Store credentials and signing keys are operator secrets and never enter the repository or CI.
6. After approval, compare assigned IDs with `src/cli/release-extension-ids.ts`. If a store assigns a different ID, update that reviewed release catalog and rerun all tests. Never accept an ID from a user, agent, web page, CLI argument or remote configuration.
7. Install each store build into a clean branded browser and verify native-host connection, compatibility/update-required behavior, debugger notice and the WP-24…WP-27 browser acceptance matrix.
8. Publish only after the signed desktop release contains the same pinned ID catalog. Roll back by unpublishing/halting rollout and retaining the prior compatible desktop release.

Repository automation prepares and validates submission materials; developer-account approval and store publication are operator gates.

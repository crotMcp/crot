# Third-Party Notices

CROT is distributed with third-party software. Copyright remains with the respective authors. The authoritative dependency versions and license identifiers for each build are recorded in `sbom.cdx.json`, generated from the locked dependency graph.

## Runtime components

- **Model Context Protocol SDKs** (`@modelcontextprotocol/sdk`, `@modelcontextprotocol/server`) — MIT License.
- **Zod** (`zod`) — MIT License.
- **Koffi** (`koffi`, optional native dependency) — MIT License.
- **Node.js runtime**, when bundled by an OS package — Node.js license; includes third-party notices published by the Node.js project.

## Build and test tooling

Build-only packages, including TypeScript, ESLint, Prettier, Vitest and Electron, are listed with exact versions and declared licenses in the generated CycloneDX SBOM. They are not implied to be part of every binary distribution.

This notice does not replace the license text shipped by a dependency or platform package. Release packaging must retain applicable license files and this notice.

## Native/vendor and platform dependencies

Microsoft Detours 4.0.1 (MIT) is vendored under `native/vendor/detours`; the upstream pin and complete license are preserved in `README.md` and `LICENSE.md` there and copied into release/update payloads. This is source inventory, not a claim that every platform uses a Detours binary.

Linux confinement relies on operator-installed bubblewrap and platform AppArmor support. Node runtime, OS libraries and optional Electron packaging are external prerequisites, not bundled standalone runtimes. A deployable image/platform package must extend this source/npm SBOM with its actual base-image and OS package inventory. GUI MSI/DMG/DEB installers and vendor signing remain external/incomplete release stages.

## Offline UI brand marks

The GitHub, YouTube, Notion and OpenAI connector marks in `src/ui/brand-icons.ts`
come from Simple Icons 11.0.0 (CC0-1.0), downloaded from the pinned npm package.
The original-color Google mark is from Google gstatic branding; Slack and Figma
marks are the brand SVGs from Wikimedia Commons. These are unmodified, vendored
offline assets, not loaded from third parties by the renderer.

- https://www.gstatic.com/images/branding/googleg/1x/googleg_standard_color_128dp.png
- https://commons.wikimedia.org/wiki/File:Slack_icon_2019.svg
- https://commons.wikimedia.org/wiki/File:Figma-logo.svg

CC0: https://creativecommons.org/publicdomain/zero/1.0/ . Brand names and marks
remain trademarks of their respective owners; this does not imply affiliation.
The yellow CROT mole vector is a vector tracing of the owner-supplied design reference.

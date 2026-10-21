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

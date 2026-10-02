# TEMPORARY: Windows cmd output encoding diagnostic

This is not part of the product or the regular test suite. Delete this
directory and `.github/workflows/windows-encoding-diagnostic.yml` once the
Windows Unicode failures (category B of the P1 CI failures) are resolved.

It investigates why these tests fail on Windows CI:

- `process: output encoding (Windows) > cmd scripts output UTF-8, including characters outside the OEM code page`
- `process: output encoding (Windows) > cmd builtins list non-ASCII file names exactly`

The diagnostic asserts nothing and changes no behaviour. It records:

- chcp exit codes, stdout and stderr (stderr is never hidden)
- the active code page before and after the UTF-8 prelude
- the exact command specs and command lines
- raw stdout and stderr bytes as hex
- the decoding CROT selects (`auto`)

It saves everything to `diagnostics-output/windows-cmd-encoding-node<version>.json`.

- Run by: `.github/workflows/windows-encoding-diagnostic.yml` (windows-latest, Node 20 and 22)
- Local run on Windows: `npx vitest run --config diagnostics/windows-cmd-encoding/vitest.config.ts`

The regular `npm test` does not pick it up: Vitest only includes
`tests/**/*.test.ts`, and `tsconfig.json` only covers `src` and `tests`.

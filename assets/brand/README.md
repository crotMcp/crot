# CROT brand assets

`crot-mascot.svg` is the flat master; `crot-wordmark.svg` contains outlined local
Inter glyphs. Neither needs a remote font or runtime vector library. Dark assets
add a narrow light outer contour; the wordmark uses theme-specific fills.

Run `npm run generate:design` from the repository root. SVG rasterization is
transparent (including fit padding). The generator also bundles offline fonts,
Lucide nodes and licensed vendor marks into the renderer's external assets.

- `desktop/`: 16–1024px PNG, multi-image ICO and PNG-backed ICNS.
- `tray/`: 16/22/32px monochrome template, dark/light variants.
- `extension/`: 16/32/48/128px, also exported into the extension source manifest.
- `favicon/`: SVG and ICO.
- `tokens.css`: canonical owner Light/Dark tokens; renderer layout consumes these.
- `licenses/`: third-party licenses. See `THIRD_PARTY_NOTICES.md` at repository root.

These are repository design assets, not signed or store-qualified application
packages. Native tray appearance must still be qualified on each target OS.

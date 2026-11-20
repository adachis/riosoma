# Design systems

This folder is the raw source.  The uniform, ready-to-use versions live in `themes/`, which `tools/build_themes.py` generates from here, so start there unless you're changing the build.

These are the theme and color files from the 52 original design-system zips.  Each folder holds that system's `tokens/` directory, its `README.md`, its original `styles.css` (which sets the order tokens load in), and `MANIFEST.tsv`, a listing of every file in the original zip.  Fonts, images, components, and UI kits stayed in the zips, which still live in Dropbox.

`SOURCES.tsv` lists the zip each folder came from, along with its size and Dropbox content hash, so you can tell whether a zip has changed since this pull.

## How these map to Riosoma

- **A design system is a Riosoma theme.**  Art Deco, Kawaii, Synthwave, and the rest each become one theme.
- **A design system's own themes are Riosoma color schemes.**  Panic Play's Spectrum, Midnight, and Arcade are color schemes you can set for the Panic Play theme.

## Where the color schemes live in the originals

The build flattens all of this into one convention (see `themes/README.md`), but the originals don't agree.  Most define schemes as CSS custom property blocks under an attribute selector, but the attribute name and file vary.

- `[data-theme="…"]` is the most common pattern, used by 36 systems.  It's usually in `tokens/themes.css`, but Diagram, Holographic, Magazine, Maximalist, Maximalist Lite, Midcentury, and Y2K put it in `tokens/colors.css` or `tokens/palette(s).css`.
- Others use `data-scheme` (Bauhaus, Glitch, and JMDS), `data-palette` (Boho, Palette, and Sketch), or a system-specific prefix like `data-bp-theme` (BitPixel), `data-gf-theme` (Graffiti), `data-gv-theme` (Groovy), `data-nb-theme` (Brutalist Neo), `data-nt-theme` (Nature), or `data-ad-theme` (Art Deco).
- Victorian uses `.theme-*` classes, and Neumorph uses `.neu-theme-*` classes.
- Industrial Retrofuturism swaps accents with `data-accent`, and Glitch and Palette add a light and dark `data-mode` on top of their schemes.
- Destiny has a single color scheme with no variants.

Each system's `README.md` explains its scheme setup in more detail, so check there first when the selector alone doesn't tell the whole story.

# Retro 90s — Design System

A cross-medium design system built on the visual grammar of mid-nineties consumer software and the flat-vector illustration that surrounded it: heavy ink outlines, flat saturated fills, hard offset shadows, square corners, bevelled OS chrome, and type that shouts.

It is deliberately **medium-agnostic**. The same tokens and components drive a marketing site, a desktop file manager, a phone app, a game HUD and a printed gig poster. Nothing is softened for any one of them — a game menu in this system looks like a control panel, because that is the point.

There is no real company behind it. The UI kits use a fictional cassette shop and zine, **Static Archive**, as sample content so the screens read as products rather than storybooks.

---

## Sources

Everything visual in `assets/` came out of the licensed stock packs supplied with the brief. Nothing was drawn, traced or generated.

| Pack (as supplied) | Used for |
| --- | --- |
| `retro-pc-elements` | Pixel-art object icons — the desktop-metaphor icon set (`assets/icons/pixel/`) |
| `90-s-vibe-pack-vector-01` | Hand-outlined object illustrations: floppy, radio, camera, arcade cabinet, film roll, skates |
| `90s-technology-vector-pack-01` / `-05` | Flat-outline tech illustrations (cassette and friends) |
| `nostalgic-90s-asset-illustration` | Flat vector objects used as product and article art |
| `retro-90-s-illustration` | Outlined figure illustrations used in hero and editorial bands |
| `90s-retro-vintage-seamless-pattern`, `y2k-seamless-vector-pattern`, `the-90-s-seamless-pattern-01`, `old-shapes-vector-pattern`, `memphis-background` | Full-bleed background patterns (`assets/patterns/`) |
| `retro-90s-music-party-sticker-elements` | Sticker sheet reference |

Also supplied but **not used**: two gaming HTML templates (`bonx…`, `gameon…`) whose dark-neon aesthetic is a different system entirely, and a set of 1920s-motif SVG icons whose subject matter did not match the era. Reference JPEGs and AVIFs supplied alongside the zips were used only to read the direction; none of their artwork appears here.

**No logo was supplied, so none was made.** Wherever a mark would go, the name is set in display type on an accent block (see `guidelines/brand-logotype.html`). Do not draw one.

---

## Content fundamentals

**Voice.** Dry, specific, slightly world-weary. It states facts about physical objects and lets the reader decide how to feel. It never explains its own cleverness, and it never uses the word "nostalgia".

**Person.** Second person for anything the reader does ("You held pause down and counted"). First person plural is avoided — the brand is a counter, not a team. Product copy is impersonal and declarative.

**Casing.** Sentence case for body copy and hints. **UPPERCASE for display type** — every heading, button label, card title, badge and status cell. That contrast between shouted display and quiet body is the whole typographic joke.

**Length.** Product blurbs are one sentence, five to nine words. Section intros are two sentences. Alerts are one sentence with a concrete number in it.

**Emoji: never.** Not in UI, not in copy, not in marketing. Unicode symbols are used only where they are functional glyphs — `×` for dismiss, `›` for a chevron, `▶` for an advance caret.

**Numbers stay specific.** "12 MB left", "88 minutes", "5 working days", "SKU 0042-A". Vague quantifiers ("lots", "tons", "blazing fast") do not appear.

Examples in the wild:

> Twelve tracks, no skips.

> Orders are recorded in real time. Allow five working days before shipping.

> This volume holds working masters only. Do not defragment while a dub is running.

> Flash works. Mostly.

Avoid: exclamation marks in UI copy, "seamlessly", "effortless", "reimagined", "elevate", any sentence that begins "In today's".

---

## Visual foundations

### Colour
Thirteen complete schemes. `arcade` is the default and is derived from the pixel-OS source art (coral title bars, mint buttons, sage-cream body, dark-teal outlines). The other twelve come from the supplied palettes and are named `spectrum`, `midnight`, `voltage`, `sandlot`, `peach`, `campfire`, `mintwave`, `neonfern`, `bubblegum`, `poolside`, `playbill`, `sagebrush`.

Apply one with `data-theme` on any element — `<html data-theme="poolside">`, or on a single preview wrapper. Every component reads the same semantic tokens (`--accent`, `--on-accent`, `--ink`, `--paper`, `--surface`, `--chrome`, …), so a scheme change retints an entire product with no component edits. `midnight` is the one dark scheme and inverts `--text` against `--paper`; the rest are light.

Each `[data-theme]` block also sets `color: var(--text)` on itself, so a scoped theme cannot leak inherited colour from `:root`.

**Contrast-safe pairs.** Every token that carries text has a named partner, and the pairs are contrast-checked (≥4.5:1) in all thirteen schemes. Use the partner, never a neighbouring accent:

| Background | Foreground |
| --- | --- |
| `--paper` / `--surface` / `--surface-2` | `--text`, `--text-2` |
| `--accent` … `--accent-4` | `--on-accent` … `--on-accent-4` |
| `--chrome` (title bars) | `--on-chrome` |
| `--wallpaper` (desktop / backdrop fills) | `--on-wallpaper` |
| `--success` / `--warning` / `--danger` / `--info` | `--on-success` / `--on-warning` / `--on-danger` / `--on-info` |

`--link` is the anchor colour, guaranteed against `--surface`, `--paper` and `--surface-2`. Do not set links to an accent — several accents *are* the surface in some schemes.

The pairs are solved numerically, not by eye. The worst pair in the entire system is 4.60:1; the audit covers 22 pairs × 13 schemes. Two consequences worth knowing:

- **Arcade's coral and teal are darker than the source art** (`#B7513C`, `#3C7886` rather than `#E8654A`, `#3E7C8A`). Arcade is the one palette this system authored, so it was darkened to keep cream on-colours on title bars and primary buttons rather than flipping them to ink.
- **Sandlot's `#457B9D` is not used as a text-bearing surface.** It sits at a luminance where no foreground reaches 4.5:1 (its ceiling is ~4.35), so `--accent-2` and `--info` point at the palette's `#1D3557` instead. `#457B9D` remains available as `--text-2` and as a decorative tint.

Supplied palette hex values are otherwise untouched — where a pair failed, the *foreground* moved.

Where a supplied palette has no usable neutral, `--paper` and `--text` are derived tints and shades of that palette's own extremes rather than borrowed greys.

**Usage ratio.** Roughly 60% paper/surface, 25% one accent, 15% ink. Two accents may share a screen; three is a poster, not an interface.

### Type
| Role | Family | Rules |
| --- | --- | --- |
| Display | Archivo Black | All headings, buttons, card titles, stats. Always uppercase, `--ls-display` (-0.02em), line-height 1.02. |
| Body | Space Grotesk | All running copy, labels, inputs. 16px default, 14px in dense UI, line-height 1.5. |
| Pixel | Silkscreen | The "system voice": title bars, badges, status cells, HUD labels, captions, legal lines. Never below 10px, never for a paragraph. |
| Mono | IBM Plex Mono | Paths, code, tabular figures, dialogue text. |

Scale is a 1.25 major third snapped to whole pixels, 10 → 76px.

**Substitution flag.** No font binaries were supplied with the brief, so all four families are Google Fonts loaded from the CDN in `tokens/fonts.css`. If licensed originals exist, drop them in and replace the `@import` with `@font-face` rules.

### Borders, corners, shadows
The single most load-bearing decision: **everything has a 3px ink border.** 2px at small sizes, 5px for the heaviest print rules.

Corners are **square**. `--r-0: 0` is the default for every surface, control and window. The only rounded shapes in the system are `Tag` and `Sticker` (full pills) and the round `Avatar` variant. Do not round a card.

Shadows are **hard offsets, never blurred**: 2 / 3 / 5 / 8 / 12px at 45°, always in `--shadow-ink`. There is no soft elevation model and no blur radius anywhere in the system. Pixel OS chrome uses bevels instead — `--bevel-out` for raised faces, `--bevel-in` for wells and pressed states.

### Interaction
- **Hover:** translate(-2px, -2px) and the shadow grows one step. Ghost buttons instead fill with `--accent-3`.
- **Press:** translate(+3px, +3px) and the shadow collapses to 1px — the element visibly lands on the page. Pixel-variant controls swap `--bevel-out` for `--bevel-in` instead of moving.
- **Focus:** 3px dashed ink outline at 3px offset. Never a glow.
- **Disabled:** 45% opacity plus grayscale(.6), shadow reduced to 2px.
- **Selected:** accent fill, not a tint or an underline.

### Motion
Steps, not curves. `--ease-snap` is `steps(2,end)`, loaders are `steps(4,end)`, blinking carets are `steps(1,end)`. The only smooth easing in the system is `--ease-out`, used for the 90ms hover lift. Durations: 90ms fast, 150ms base, 260ms slow, 18s marquee. Everything collapses to 0 under `prefers-reduced-motion`.

### Surfaces and backgrounds
Cards are flat `--surface` with a 3px ink border and a 5px shadow; a media band separated by its own border; a tinted footer bar. No gradients, no glass, no translucency. **Blur is never used** — not on scrims, not on overlays. Modal scrims are a 45%-opacity ink layer with a dithered conic checker on top, which is how the era faked transparency.

Backgrounds are one of three things: a flat colour block, a CSS-generated texture (checker, halftone, hatch, scanlines, grid — all in `css/patterns.css`, all themable), or a full-bleed supplied pattern from `assets/patterns/`. Textures sit at 9–16% opacity behind content, never above it. Full-bleed photographic imagery does not exist in this system; illustration does.

### Imagery
Flat vector with heavy black outlines, saturated fills, no rendering, no gradient shading. Illustrations are **placed, never redrawn** — drop the supplied PNG or SVG into a bordered surface, sometimes rotated a few degrees, often with a hard `drop-shadow()` matching the shadow scale. Pixel icons render with `image-rendering: pixelated` and are never smoothed or resized off their native grid.

### Layout
Content maxes at `--page-max` (1180px) with a 32px page gutter. Sections are separated by full-width 3px ink rules rather than whitespace alone. The header is sticky; nothing else is fixed. Grids are 2, 3 or 4 columns; the 3-column product grid is the house default. Groups of siblings use flex/grid with `gap`, never margins.

---

## Iconography

**Two systems, cleanly separated.**

1. **Font Awesome** is the UI glyph set — toolbars, buttons, form affordances, tab bars, list rows, transport controls. Solid weight, `currentColor`, sized by the surrounding text.

   The supplied kit is the production embed:

   ```html
   <script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
   ```

   ⚠️ **Substitution flag.** The kit's SVG-with-JS renderer does not complete inside this preview environment — it fetches the icon SVGs but never swaps the `<i>` elements — so every page in this project loads the equivalent **Font Awesome 6 Free CSS/webfont build** from cdnjs instead. Each file carries a comment marking the swap. In production, replace the stylesheet link with the kit script; every icon name used here exists in both builds.

   ```html
   <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer">
   ```

2. **Pixel object icons** (`assets/icons/pixel/*.png`, from the supplied pack) are the desktop-metaphor set — disks, documents, folders, modems. They stand for *things*, not actions: desktop shortcuts, file rows, inventory slots, list leading art. Always `image-rendering: pixelated`, always at a size that keeps the pixel grid whole (20 / 34 / 44 / 72px).

Never mix the two in one row. A toolbar is all Font Awesome; a file list is all pixel PNGs.

**Emoji are never used as icons.** Unicode is used only for functional glyphs already listed under Content Fundamentals. Window-control glyphs (`_`, `□`, `✕`) are typed characters inside bordered buttons — this is intentional and era-correct, not a fallback.

Do not hand-roll SVG icons for this system. If a needed glyph is not in Font Awesome, use the closest one and note the gap.

---

## Index

**Root**
- `styles.css` — the single entry point; `@import` list only.
- `readme.md` — this file.
- `thumbnail.html` — homepage tile.

**Tokens** (`tokens/`) — `fonts.css`, `colors.css`, `themes.css` (13 schemes), `typography.css`, `spacing.css`, `surfaces.css` (borders, radii, shadows, bevels, focus), `motion.css`.

**CSS layer** (`css/`) — `base.css` (element resets and defaults), `patterns.css` (themable textures), `components.css` (the `r9-*` class layer every component renders through).

**Assets** (`assets/`) — `icons/pixel/`, `illustrations/objects/`, `illustrations/tech/`, `illustrations/people/`, `patterns/`.

**Guidelines** (`guidelines/`) — 21 specimen cards covering colour (accents, neutrals, semantic, all schemes, a live scheme switcher), type (display, body, pixel, mono, scale), spacing (scale, in use) and brand (borders, bevels, radii, patterns, motion, marquee, wordmark, iconography, illustration).

### Components

`components/core/` — **Button**, **IconButton**, **Badge**, **Tag**, **Sticker**, **Card**, **Panel**, **Divider**, **Marquee**, **Avatar**

`components/forms/` — **Field**, **Input**, **Textarea**, **Select**, **Checkbox**, **Radio**, **Switch**, **Slider**

`components/feedback/` — **Alert**, **ProgressBar**, **Toast**, **Tooltip**, **Modal**, **Spinner**

`components/navigation/` — **Tabs**, **Menubar**, **Breadcrumbs**, **Pagination**, **StatusBar**

`components/chrome/` — **WindowFrame**, **Toolbar**, **Taskbar**, **DesktopIcon**

`components/mobile/` — **MobileBar**, **TabBar**, **ListRow**, **Sheet**

`components/game/` — **HudPanel**, **Meter**, **GameButton**, **InventorySlot**, **DialogueBox**

`components/data/` — **DataTable**, **Stat**, **KeyValue**

Each has a sibling `.d.ts` (props contract) and `.prompt.md` (one-line what-and-when plus a usage example). Each directory has one `@dsCard` preview page.

**Intentional additions.** The brief supplied no component inventory — only visual references — so this is an authored set. Beyond the standard primitives, four families exist because the brief names five target media and a generic set cannot reach them: `chrome/` (five desktop window treatments, taskbar, desktop icons), `mobile/` (platform-aware app bar, tab bar, list row, bottom sheet), `game/` (HUD, meters, inventory slots, dialogue box) and `core/Marquee` + `core/Sticker`, both of which are era-defining layout devices rather than decoration.

### UI kits

| Kit | Directory | Surfaces |
| --- | --- | --- |
| Web — Static Archive | `ui_kits/web/` | Home, product, three-step checkout, long-form article |
| Desktop — Deck Manager | `ui_kits/desktop/` | Desktop environment, file browser, media player, control panel; all five window chromes switchable live |
| Mobile — Static Archive app | `ui_kits/mobile/` | Library, now playing, browse, profile — iOS and Android side by side |
| Game — Tape Runner | `ui_kits/game/` | Title screen, in-game HUD, inventory, pause menu |
| Print & layout | `ui_kits/print/` | Gig poster, zine spread, mailer card, business card, shelf tag |

Each kit has its own `README.md` and an interactive `index.html`.

### Templates

Starting folders a consuming project can copy wholesale. Each is a single Design Component plus a one-line `ds-base.js` that points at this system.

| Template | Directory | Starts you with |
| --- | --- | --- |
| Web landing page | `templates/web-landing/` | Marquee band, halftone hero, stat strip, three-up grid, signup band, ink footer |
| Desktop app window | `templates/desktop-app/` | Wallpaper, desktop icons, window with menubar / sidebar / table / status bar, taskbar |
| Mobile app screen | `templates/mobile-screen/` | Phone bezel, app bar, filter chips, feature card, list rows, tab bar |
| Game HUD screen | `templates/game-screen/` | Meter HUD, score panel, quick slots, hotkey buttons, dialogue box, scanlines |
| Print poster | `templates/print-poster/` | Accent flood with halftone, stacked display headline, listing block, detail panel |

To retarget a template in a consuming project, edit the `base` line at the top of that folder's `ds-base.js`.

---

## Using a colour scheme

```html
<html data-theme="poolside">
  <link rel="stylesheet" href="styles.css">
```

Or scope it to a region:

```html
<section data-theme="midnight"> … </section>
```

`guidelines/colors-switcher.html` is a working switcher; the desktop kit's control panel and the game kit's pause menu both change scheme at runtime the same way.

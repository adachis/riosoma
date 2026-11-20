# Y2K Design System

A complete interface system in the late-1990s / turn-of-the-millennium computer idiom: hard ink
frames, two-tone bevels, gradient title bars, chrome and holographic fills, checkerboards, wireframe
solids and acid-bright palettes. It is built to cover five surfaces with one vocabulary — **web
pages, desktop applications (Windows / macOS / Linux), mobile apps (iOS / Android), video-game UI,
and print layout** — without softening for any of them.

**There is no client brand here.** "Y2K" is the name of the system, not a company. The demo content
across the UI kits belongs to an invented CD shop called *Silver Disc* and an invented rhythm game
called *Neon Circuit*; both exist purely so the components have something real to hold.

---

## Sources

| Source | What it provided | Notes |
| --- | --- | --- |
| `Y2K Assets/` (attached local folder) | 24 display typefaces (OTF/TTF), 142 sticker SVGs, 41 badge SVGs, 55 wireframe-solid SVGs, 30 lifestyle cliparts, 4 pixel-art icon SVGs, 5 chrome 3D PNGs, 21 seamless "digital paper" JPGs, PSD/AI/EPS source files | A royalty-free asset and font library, not a product codebase. Selected assets were copied into `assets/`. |
| ~50 uploaded reference images (`uploads/`) | Visual direction only: retro OS window furniture, pixel dialog boxes, acid-green rave UI sheets, cyber HUD sheets, Y2K web-page layouts, badge/shape packs, a rhythm-game song-select screen | Used as a **mood reference**. No uploaded image, logo, wordmark, brand name or copy appears in the system. |
| Font Awesome Kit `559791bdc6` | All functional iconography | Loaded from `https://kit.fontawesome.com/559791bdc6.js`. |
| Google Fonts | Body, mono and bitmap faces (see *Font substitutions*) | The asset library shipped display faces only. |

**No Figma file, GitHub repository or product codebase was supplied**, so there was no existing
component inventory to mirror. The component set below is therefore authored from scratch and sized
to the five target surfaces — see *Intentional additions*.

---

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. Imports only. |
| `tokens/` | `fonts.css` `colors.css` `typography.css` `spacing.css` `effects.css` `base.css` |
| `css/` | Component CSS: `controls` `surfaces` `navigation` `data` `decor` `game` `mobile` `print` |
| `components/` | 56 React primitives in 7 groups (`core` `forms` `surfaces` `navigation` `data` `game` `mobile`) |
| `ui_kits/web/` | Marketing + commerce site, 4 screens |
| `ui_kits/desktop/` | Desktop app with switchable Win / Mac / Linux chrome |
| `ui_kits/mobile/` | One app in iOS and Android dialects, side by side |
| `ui_kits/game/` | Title, song select, in-game HUD, pause |
| `ui_kits/print/` | Poster, magazine spread, letter flyer |
| `guidelines/` | 22 foundation specimen cards (colours, type, spacing, brand) |
| `templates/` | 5 Design-Component starting templates — see below |
| `assets/fonts/` | 24 bundled display TTFs |
| `assets/stickers/` | 50 sticker SVGs |
| `assets/wireframes/` | 12 wireframe-solid SVGs (inherit `currentColor`) |
| `assets/shapes/` | 64 silhouette PNGs driven as CSS masks — bursts, blobs, arrows, rings, frames |
| `assets/badges/` | 41 full-colour sticker badges |
| `assets/doodles/` | 17 star/heart line doodles |
| `assets/chrome/` | 5 rendered silver 3D PNGs |
| `assets/textures/` | 12 seamless raster grounds, named by subject |
| `thumbnail.html` | Homepage tile |

### Components

**core** — `Button` `IconButton` `Badge` `Tag` `Icon` `Divider` `Marquee` `ProgressBar` `Spinner` `Avatar` `Sticker` `Blob` `Collage` `PixelBox` `PixelButton` `Ribbon`

**forms** — `Input` `Textarea` `Select` `Checkbox` `Radio` `Switch` `Slider` `SearchField`

**surfaces** — `Window` `Panel` `Card` `GroupBox` `Dialog` `Toast` `Tooltip` `StatusBar`

**navigation** — `MenuBar` `Toolbar` `ToolbarSeparator` `ToolbarSpacer` `TabBar` `Sidebar` `Breadcrumb` `Pagination`

**data** — `Table` `ListRow` `Meter` `Stat`

**game** — `HudPanel` `StatBar` `ScoreReadout` `DialogueBox` `ItemSlot` `ItemSlotGrid`

**mobile** — `MobileStatusBar` `AppBar` `MobileTabBar` `ListCell` `Sheet`

### Templates

Five starting points consuming projects can copy, one per surface. Each is a Design Component that
loads the system through a sibling `ds-base.js` (one line to repoint) and composes real components.

| Folder | Template |
| --- | --- |
| `templates/web-landing/` | **Y2K landing page** — chrome header, marquee, gradient hero, card grid, footer |
| `templates/desktop-app/` | **Y2K desktop app** — window chrome (switchable Win/Mac/Linux), menu bar, toolbar, sidebar, table |
| `templates/mobile-app/` | **Y2K mobile app** — phone frame, status bar, large app bar, feed, list cells, tab bar |
| `templates/game-hud/` | **Y2K game HUD** — corner-anchored stat bars, score readouts, hotbar, dialogue box |
| `templates/print-poster/` | **Y2K print poster** — 24×36 event poster, print-ready |

Every component has a sibling `.d.ts` (props contract) and `.prompt.md` (one-line "what & when", a
usage example, notable variants). Each directory has one `@dsCard` HTML showing its full variant set.

---

## VISUAL FOUNDATIONS

### The one idea

**Every surface is an outlined box with a light edge on the top-left, a dark edge on the bottom-right,
and a shadow that never blurs.** Windows, cards, buttons, inputs, HUD panels, phone screens and
printed pages are all the same construction at different scales. Get that right and everything else
is decoration.

### Colour

Twelve complete themes ship, each declaring the identical 27-token contract, so any component styled
with tokens survives a theme swap untouched. Set `data-theme` on `<html>`:

`rave` (default) · `millennium` · `spectrum` · `siren` · `sherbet` · `arcade` · `aqua` · `mint` ·
`bubblegum` · `lagoon` · `varsity` · `sage`

The contract, per theme: raw palette (`--t1`…`--t5` — only these five are guaranteed; `spectrum`
also ships `--t6`…`--t8`, so give those a fallback), `--desktop` `--desktop-2`, `--surface`
`--surface-2` `--surface-3`, `--chrome-face`, `--edge-light` `--edge-dark` `--frame`, `--ink`
`--ink-2` `--ink-3`, `--title-from` `--title-to` `--on-title`, `--accent` `--on-accent` `--accent-2`
`--on-accent-2`, `--hot` `--on-hot`, `--ok` `--on-ok` `--warn` `--on-warn` `--bad` `--on-bad`,
`--ok-text` `--warn-text` `--bad-text`, `--link` `--link-hover`, `--glow`.

**The contrast contract.** Your twelve palettes are preserved verbatim in `--t1`…`--t5` and are what
the swatch cards, decorative fills and gradient stops draw from. The *functional* fill tokens
(`--accent`, `--ok`, `--bad`, `--warn`, `--title-*`) are shaded from those palette colours only as far
as needed for their paired foreground to clear 4.5:1, and every fill ships an explicit `--on-*`
foreground rather than assuming white. Seven of the twelve palettes have mid-value accents where
white fails: `rave` `varsity` `mint` `millennium` `bubblegum` take dark ink on the untouched palette
colour; `spectrum` `siren` `sherbet` `arcade` `lagoon` take a shaded accent with white. Status colours
set as *text* directly on `--surface` use the separate `--ok-text` / `--bad-text` / `--warn-text`
variants, shaded for that lighter ground — `--bad` at 11px on near-white would otherwise fail.

Text tokens are shaded against the **darkest ground they can land on**, not just `--surface`:
`--ink` and `--ink-2` clear 4.5:1 on all four surface tints (`--surface`, `--surface-2`,
`--surface-3`, `--chrome-face`) in every theme, and `--ok-text` / `--warn-text` / `--bad-text` /
`--link` / `--link-hover` clear it on the three grounds they actually appear on. `--ink-3` is
**decorative only** — sheet grips, empty-slot glyphs, inactive title bars. Structural labels that
look faint (sidebar group headings, list counts, trailing values, shortcut hints, folios) all use
`--ink-2`.

If you would rather keep a palette colour exactly as issued and accept the lower ratio, override
`--accent` in the theme block; the `--on-accent` pairing is one line beneath it.

Two-layer model: a **saturated desktop** (`--desktop`, a radial gradient to `--desktop-2`) with
**near-neutral windows** floating on it (`--surface`). Chrome strips — toolbars, title bars, status
bars, tab wells — sit on `--chrome-face`, always a tint of the theme rather than a true grey. Three
dark themes (`millennium`, `mint`, and `sage` in its accent role) invert that relationship.

Live preview of all twelve, with a working window/button/badge demo, is the **Theme variants** card
in *Colors*.

### Type

| Token | Face | Job |
| --- | --- | --- |
| `--font-display` | **Y2K Avaben** | Heroes, poster titles, game logos. Wide cyber caps, tracked +0.06em, uppercase only. |
| `--font-mega` | **Y2K Kabisat** | Impact headlines and print covers. Ultra-fat, negative tracking, 0.78–0.84 line height. |
| `--font-core` | **Y2K Cuano** (400/700) | The system UI face. Every heading, button, label, window title, nav item. |
| `--font-text` | Archivo | Long-form body copy at 15/1.55. |
| `--font-mono` | Space Mono | Data, readouts, timestamps, code, typed input values. |
| `--font-pixel` | Silkscreen | Bitmap micro-labels — status bars, HUD counters, folios, captions. Uppercase, tracked +0.08em, 9–12px only. |
| `--font-bubble` | **Y2K Bubbly** | The sticker / kawaii voice. |
| `--font-techno` | **Y2K Macarthur** | Condensed techno for tickers and table headers. |
| `--font-nostalgia` | **Y2K Nostalgia** | Chunky retro-web wordmarks. |
| `--font-outline` | **Y2K Punk Cyber Outline** | Hollow display over imagery. |

**Never set a display headline flat.** Pick a treatment from `css/decor.css`: `.y2k-type-stack` and
`.y2k-type-stack-3` (two- and three-step hard offsets), `.y2k-type-outline` /
`.y2k-type-outline-fill`, `.y2k-type-chrome`, `.y2k-type-holo`, `.y2k-type-emboss`,
`.y2k-type-glow`, `.y2k-type-glitch` (misregistered CMY plates), `.y2k-type-warp` /
`.y2k-type-squish`.

**Kabisat (`--font-mega`) does not take a shadow stack.** Its strokes are heavy enough that even the
two-step offset closes the counters. Use it flat, or on a plate, at 30–60px — section headings, price
flashes, folios. **Stacked wordmarks and logos use Avaben (`--font-display`)**, whose open counters
survive three offsets.

Sizes run `9 10 11 13 15 18 22 28 36 48 64 88 120 168`. Ready-made roles (`--type-hero`,
`--type-title`, `--type-body`, `--type-ui`, `--type-label`, `--type-mono`, `--type-pixel`) exist so
you rarely set family + size + leading by hand.

Fourteen further display faces are bundled and declared (`Y2K Keyute`, `Y2K Brickbond`, `Y2K Flukin`,
`Y2K Jawbyte`, `Y2K Pukor`, `Y2K Auror`, `Y2K Euphemia`, `Y2K Holly`, `Y2K Oblado`, `Y2K Various`,
`Y2K Nineties`, `Y2K Moneter`, `Y2K Kabisat Tall`, `Y2K Punk Cyber`) for one-off wordmarks. They are
deliberately **not** tokenised — reach for them by name when a piece needs its own voice.

**Numerals:** the display faces draw stylised figures — Avaben's `1` reads as a `7` and its `2` as a
`z` at small sizes. **Set every figure that carries meaning in `--font-mono`** (scores, prices,
stats, durations, capacities). Display numerals are for poster-scale type only.

### Spacing & radii

4px base, but the system keeps the odd 2/3/5/6px steps that bevelled chrome needs: `2 3 4 5 6 8 10 12
14 16 20 24 28 32 40 48 56 64 80 96 128`. Control heights are 24 / 32 / 44px; 44 is the mobile tap
floor. Title bars 24px (Win) / 28px (Mac) / 34px (Linux); status bars 22px.

**Radii are 0 by default.** `--r-1` through `--r-4` (2–10px) exist for small softening. Rounding
above that is a deliberate register change: `--r-bubble` (14px) for kawaii cards, `--r-pill` for
tags, sticker buttons and mobile grips. `Sheet` is the only component that rounds by default.

### Borders, bevels, shadows

- **Borders**: `1 / 2 / 3 / 5px` (`--bw-hair` `--bw` `--bw-thick` `--bw-heavy`). No hairlines on
  anything structural. Windows get 3px, cards 2px, print rules 5px.
- **Bevels**: `--bevel-out` (raised control), `--bevel-in` (pressed / selected), `--bevel-well`
  (text fields, slider tracks, progress tracks), plus 1px `-sm` variants for small controls. Two
  inset shadows, zero blur, `--edge-light` top-left and `--edge-dark` bottom-right.
- **Drop shadows**: `2 / 4 / 7 / 12px` hard offsets in `--frame`, plus `--shadow-accent`. **Nothing
  in this system has a blurred shadow.** The only soft effects are `--glow-soft` / `--glow-hard`,
  reserved for game readouts.
- **Inner vs outer**: bevels are *always* inner (they describe the material of the control); drop
  shadows are *always* outer (they describe stacking). Never both directions on one element.

### Backgrounds & texture

**Two stacked layers, always.** A tiled raster ground underneath, pure-CSS overlays on top.

Twelve raster grounds ship in `assets/textures/`, named for what they depict rather than numbered,
because loudness is the thing you pick on:

- **Abstract, safe under content** — `memphis` (teal shapes and bolts), `animal` (neon tiger/leopard),
  `zebra-snake` (acid-green snakeskin), `pebble` (rainbow stones)
- **Dark, for desktops and game grounds** — `vinyl` (records and cassettes on navy), `tape` (cassettes
  on purple)
- **Figurative, needs a plate over any text** — `smiley`, `candy`, `shell`, `fish`, `skate`, `beach`

Apply with `.y2k-ground .y2k-ground--memphis`; `--sm` / `--lg` change the tile scale, `--tint` pushes
it toward the theme accent without losing grain.

Seven pure-CSS textures then layer over the top and follow the active theme: `--tex-checker` (20px),
`--tex-checker-sm` (8px), `--tex-grid` (24px), `--tex-scanline`, `--tex-dither` (2px), `--tex-stripe`,
`--tex-halftone`. Reach for them through `.y2k-over--scan` / `--grid` / `--dither` / `--halftone` /
`--checker` / `--vignette` / `--holo` / `--noise`, and stack two or three. `.y2k-crt` bundles
scanlines, a vignette and a corner sheen in one element.

**Photography is the one thing this system does not supply.** The kits stand in the chrome 3D PNGs
and shape bursts. Where real imagery goes, treat it warm and high-contrast, framed in 3px ink, with a
scanline or halftone overlay — never desaturated, never soft, never bleeding without a frame.

### Shapes — the silhouette library

`assets/shapes/` holds 64 flat silhouettes. They are driven as **CSS masks**, so they take any theme
colour, gradient or texture:

```jsx
<Blob shape={21} size={260} color="var(--accent-2)" />
<Blob shape={54} size={90} fill="chrome" />
<Blob shape={38} size={160} stack color="var(--hot)" />
```

Families: bursts `3 5 20 21 22 23 33 38 53 54 55 56` · rings `30 31 32 41 57` · arrows and swooshes
`6 7 8 9 10 11` · blobs `19 34 37 39 45 52 61 64` · squiggles `25 26 27 43` · frames and arches
`2 12 13 14 15 16 17 18` · hearts `42 48` · leaves `51 62 63` · flower `60` · pin `24` · crescent `44`.

`.y2k-burst` wraps a focal element in one so a score, price or thumbnail reads as a sticker.

### Transparency & blur

Almost never. `HudPanel` uses `color-mix(in oklab, var(--surface) 78%, transparent)` so the play
field reads through it; `--scrim` is a dithered pattern at 55% rather than a blur. There is **no
backdrop-filter anywhere in the system** — frosted glass is the wrong decade.

### Animation & interaction

Short and mechanical. Durations `80 / 130 / 200 / 340ms`. Easings: `--ease-snap` for most things,
`--ease-bounce` for entrances (toasts only), `--ease-step` / `--ease-step-2` for anything that should
read as a machine — the spinner rotates in 5 steps, the switch knob jumps in 2, the progress fill
advances in 5, the dialogue caret blinks in 2.

| State | Change |
| --- | --- |
| Hover | `translate(-1px,-1px)`, shadow grows 2px→5px. Ghost buttons darken their fill instead. |
| Press | `translate(2px,2px)`, drop shadow collapses to 0, bevel inverts to `--bevel-in`. |
| Focus | 2px **dashed** `--frame` outline at 2px offset. Dashed, not solid — it reads as a marquee selection. |
| Selected | `--accent` fill + `--on-accent` text + `--bevel-in-sm`. |
| Disabled | `opacity: .45`, pointer-events off, shadow removed, bevel kept. |

Fades are rare. Nothing in the system eases opacity from 0 to 1 over more than 200ms.

### Cards, windows, layout

A **card** is `--surface`, a 2px `--frame` border, square corners and a 4px hard shadow; interactive
cards lift on hover. A **window** is `--chrome-face`, a 3px frame, a gradient title bar with caption
buttons, and a `--surface` body separated by a 2px rule. Windows also appear decoratively on web
pages and posters — a hero media player, a webring block — which is a deliberate part of the look.

Layout tokens: `--w-page` 1200px, `--w-prose` 66ch, `--w-sidebar` 232px, `--w-panel` 320px,
`--gutter` 24px. Fixed elements: site headers are sticky, marquees are full-bleed, HUD panels anchor
to viewport corners, mobile tab bars pin to the bottom. Everything else flows.

### Density budget — the floor, not the ceiling

**Y2K is a collage medium.** It is not a clean style and this system should never look restrained. An
under-dressed screen is a bug. Per full-screen composition, the **minimum** is:

| | Minimum per screen |
| --- | --- |
| Tiled raster ground (`.y2k-ground--*`) | 1, on every full-bleed section |
| Pure-CSS overlays on top of it (`.y2k-over--*`) | 2 — pick from scan, grid, dither, halftone, checker, vignette, noise |
| Silhouette shapes (`Blob`) | 3–5, at least two bleeding off an edge |
| Stickers / badges / doodles (`Collage`, `.y2k-sticker-wall`) | 4–8 |
| Display-type treatment (`.y2k-type-*`) | every headline; never set one flat |
| Tilted elements (`.y2k-tilt-*`) | 3+ — nothing important is axis-aligned |
| Ribbons, rules, barcodes, swatch strips | 2+ |
| Marquee | 1–2 |

What keeps it readable is not restraint, it is **plates**. Any running text sitting over a tiled
ground goes on a `.y2k-plate` (or `--ink` / `--accent-2` / `--chrome`), and any figurative ground
under text gets a solid scrim overlay at 60–90%. Loud ground, hard plate, legible type — that is the
whole trick. The one thing that stays disciplined is contrast; everything else piles up.

Two things are still capped: **one or two background colours per composition** (the theme's
`--desktop` pair), and **glow is reserved for game readouts.**

---

## CONTENT FUNDAMENTALS

### Voice

Two registers, chosen by surface, never mixed inside one block.

**System voice** — lowercase, terse, machine-adjacent. Used for anything the interface says about
itself: window titles, status bars, file names, HUD labels, folios.

> `my_documents` · `sign_in.exe` · `24 items` · `3.4 MB` · `drive ready` · `now loading track 04` ·
> `visitor 00418822` · `best viewed at 1024×768`

**Editorial voice** — plain sentence case, specific, dry, no hype. Used for anything a human wrote:
headlines, product copy, article body, help text.

> "Twelve tracks recorded to minidisc between midnight and 4am, transferred with one cable and no
> plugins." · "A run of five hundred discs takes eleven hours if nothing goes wrong, and nothing has
> ever gone entirely right."

### Casing

| Element | Casing |
| --- | --- |
| Display headlines (`--font-display`, `--font-mega`) | ALL CAPS |
| Micro labels, badges, status cells, folios | ALL CAPS, tracked +0.14em |
| Headings, buttons, nav, body | Sentence case |
| Window titles, filenames, technical strings | lowercase, `snake_case` where it reads as a filename |
| Sticker / kawaii voice | lowercase with doubled punctuation — `click me!!`, `so cute!!` |

### Person

"You" for anything addressed to the reader ("Bring this flyer", "Your bag"). "We" only in editorial
prose where a real author is speaking. The interface never says "I".

### Numbers

Always specific, never rounded to feel bigger. `112 / 500`, `3.4 / 4.0 GB`, `9,821,440`. Scores and
counters zero-pad in the mono face (`00034789`). Dates in the system voice use the era's slash
format (`12/31/1999`); editorial prose spells them out.

### Emoji

**Never.** Not in copy, not in UI, not as decoration. The system's expressive vocabulary is the
sticker library and the Font Awesome glyph set. If a piece needs a smiley, it uses
`assets/stickers/smile-mouth.svg`, not `🙂`.

### Punctuation & symbols

`·` as an inline separator in the system voice. `✦` between marquee items. `…` in menu items that
open a dialog (`Preferences…`, `Add folder…`). Em dashes are allowed in editorial prose and avoided
in UI strings. No exclamation marks outside the sticker register.

### Length

Badges 1–3 words. Buttons 1–3 words, verb first. Status cells under 20 characters. Card body 1–2
sentences. Dialog text one or two short sentences, and a dialog always offers an explicit dismiss.
Article paragraphs 2–4 sentences.

---

## ICONOGRAPHY

### Functional icons — Font Awesome Kit `559791bdc6`

All functional iconography is **Font Awesome**, loaded from the kit script in every card and kit:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Components take Font Awesome **class strings**, never SVG nodes: `<Button icon="fa-solid fa-bolt">`,
`<IconButton icon="fa-solid fa-xmark" label="Close" />`, `<Icon name="fa-solid fa-compact-disc"
size="lg" />`. `fa-solid` is the house style; `fa-regular` is used only where a hollow counterpart
carries meaning (`fa-regular fa-heart` for un-favourited, `fa-regular fa-square` for the maximize
caption). Sizing goes through the type scale via the `Icon` wrapper rather than raw pixels.

The kit's own icon vocabulary leans period-correct: `fa-compact-disc` `fa-floppy-disk` `fa-hard-drive`
`fa-headphones` `fa-fire` `fa-print` `fa-folder-open` `fa-file-lines` `fa-magnifying-glass`
`fa-hourglass-half`.

**Never hand-roll an SVG when a Font Awesome glyph exists**, and never substitute an emoji or a
unicode dingbat for an icon.

### Decorative iconography — bundled vector assets

Four bundled sets, all copied from the supplied asset library, all real vector files:

| Set | Count | Format | Use |
| --- | --- | --- | --- |
| `assets/stickers/` | 50 | Flat multicolour SVG | Sticker accents — smileys, flames, lips, aliens, discs, word marks. Placed with `Sticker`, which adds the hard drop shadow and optional tilt. |
| `assets/badges/` | 41 | Full-colour SVG | Larger ready-made sticker badges — "GRL PWR", "EASY PEASY", "STAY COOL", ladybugs, sunglasses faces. The collage workhorses. Use in `Collage` or `.y2k-sticker-wall`. |
| `assets/doodles/` | 17 | Line SVG | Star and heart doodles for small gaps between larger decals. |
| `assets/shapes/` | 64 | Silhouette PNG with alpha | Driven as CSS masks via `Blob`, so they take any theme colour. See *Shapes*. |
| `assets/wireframes/` | 12 | Single-colour SVG (`fill: currentColor`) | Abstract wireframe solids. Full-bleed ornament; bleed them off the edge, never centre one. |
| `assets/chrome/` | 5 | Rendered PNG with alpha | Silver 3D objects (star, stars, winged heart, wings, cat). Photography stand-ins and hero ornament. |
| `assets/textures/` | 12 | Seamless PNG, 700² | Tiled grounds. See *Backgrounds & texture*. |

Sticker filenames are semantic (`star-smile.svg`, `disco-ball.svg`, `word-no-bad-days.svg`) so an
agent can pick one without opening it. Word-mark stickers are prefixed `word-`.

### What is not here

- **No logo.** No brand mark was supplied and none was invented. Wherever a mark would go, the
  UI kits set the invented product name in `--font-display` as plain type. `thumbnail.html` does the
  same with the system name.
- **No photography.** See *Backgrounds & texture*.
- **No custom icon font or sprite sheet.** The four bundled pixel-art computer icons in the source
  library were single large illustrations rather than a UI icon set, so Font Awesome carries the
  functional load instead.

**Decoration is not iconography.** Font Awesome handles anything the user acts on. The sticker,
badge, doodle, shape, wireframe and chrome libraries handle everything that is there to be looked at.
Decoration never carries meaning and never sits in a tap target.

---

## Font substitutions — please review

The supplied library contains **display faces only**. Three roles had no candidate and are filled
from Google Fonts:

| Role | Substitute | Why |
| --- | --- | --- |
| Body / long-form (`--font-text`) | **Archivo** | Squarish grotesque; sits beside Cuano without clashing and has the weight range Cuano lacks. |
| Mono / readouts (`--font-mono`) | **Space Mono** | Genuinely monospaced with period-appropriate quirk. |
| Bitmap micro-labels (`--font-pixel`) | **Silkscreen** | Real 1-bit bitmap face; the library's pixel-ish faces are caps-only display weights, unusable at 9–11px. |

**If you have licensed body, mono and bitmap faces, send them and they will be swapped in** — the
change is three `@font-face` blocks in `tokens/fonts.css` and three token values in
`tokens/typography.css`.

`Y2K Cuano` carries the whole UI at 10–36px. It holds up well, but it is a display face doing a text
face's job; if you have a workhorse UI grotesque in the brand, it belongs in `--font-core`.

---

## Intentional additions

No source defined a component inventory, so the set is authored. Three entries are worth calling out
as decisions rather than defaults:

- **`Icon`** — a sizing wrapper over the Font Awesome kit, so icons use type tokens instead of
  ad-hoc pixel values.
- **`Sticker`** — an asset wrapper for `assets/stickers/`. It exists to make "use the bundled SVG"
  easier than "draw one", which is the rule that matters most in this system.
- **`Blob`** — renders one of the 64 silhouettes as a themeable CSS mask. Without it the shape library
  is 64 unusable pale-yellow PNGs.
- **`Collage`** — the absolutely-positioned decoration plane. Encodes "load it up, never eat clicks".
- **`PixelBox` / `PixelButton`** — the bitmap-dialog register, distinct from the beveled `Dialog`.
- **`Ribbon`** — rotated word plate, the era's default kicker.
- **`ItemSlotGrid` / `ToolbarSeparator` / `ToolbarSpacer`** — layout siblings exported alongside
  their primary component rather than as separate families.

The `game/` and `mobile/` groups exist because two of the five target surfaces need vocabulary the
desktop set does not cover (resource bars, score readouts, inventory cells; platform status bars,
app bars, tap-sized cells). Everything in them is the same chrome at a different scale.

---

## Using this system

```html
<!-- one stylesheet, one icon kit -->
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
<!-- webfont fallback: the kit fetches icon SVGs at runtime, which some
     sandboxed previews block. This link keeps glyphs rendering either way. -->
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
<!-- optional: pick a theme -->
<html data-theme="millennium">
```

React consumers read components off the compiled bundle:

```js
const { Window, Button, Table } = window.Y2KDesignSystem_98b5b8;
```

Non-React consumers can use the CSS classes directly — `y2k-btn y2k-btn--primary`, `y2k-window`,
`y2k-table`, `y2k-hud` — since every component is a thin wrapper over them.

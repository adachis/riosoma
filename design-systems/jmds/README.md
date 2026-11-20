# JMDS Design System

**JMDS** is a design system for interfaces built on the visual logic of Japanese poster
modernism and Japanese editorial design. It is not a Japanese-language system — all copy is
American English. What it borrows is method, not language: flat screenprint inks, a modular
geometric grid, extreme type-size contrast, deliberate emptiness, and hairline print rules.

JMDS covers four media: **web**, **mobile apps**, **desktop apps**, **video game UI** and
**print layouts**. Colour, type families and effects never fork per medium — a scheme looks the
same on a phone, in a window, behind a HUD and on a printed sheet. What changes is density and
unit: 44px targets and 16px body on mobile, 26px rows and 13px type on desktop, 90ms response
and corner brackets in a HUD, millimetres and points in print. Those live in
`tokens/media.css`.

Its defining feature is **swappable color schemes**. JMDS ships eight named palettes drawn
from specific print traditions. Every component reads semantic tokens only, so a whole page —
or a single band inside a page — repaints from one `data-scheme` attribute. Schemes are a
fixed set chosen per job, not an arbitrary theming layer.

```html
<html data-scheme="tanaka">           <!-- whole document -->
<section data-scheme="yozora">        <!-- one dark band inside a light page -->
```

---

## SOURCES

The brief supplied twenty reference images and a name. No codebase, Figma file, brand
guidelines, logo, or font binaries were provided. Nothing from the references appears in the
system; they were read for design philosophy only.

Reference material, held in `uploads/` for provenance:

| Group | Files |
| --- | --- |
| Poster modernism | Ikko Tanaka (`IKKO_TANAKA_horizontal.jpg`), Ryuichi Yamashiro for Morisawa (`01-Ryuichi-Yamashiro--ad-for-Morisawa-Co.--early-80s.jpg`), 1930s advertising sheet (`modern_graphic_12.jpg`), Showa-era poster set (`images.jpg`) |
| Psychedelic / pop | Tadanori Yokoo — MoMA *Word Image* (`CHSDM-292887_01-000001-scaled.jpg`), *Collection of Stories* cover (`07-Tadanori-Yokoo--...jpg`) |
| Editorial / magazine | *Idea* covers 371, 405, 414 (`72479d974e7db1d716a5a47bfa9423ed.jpg`, `images-1.jpg`, `images-3.jpg`), *Design* 12/1959 (`da604137bcaeb9e3f3c1158d62c2570b.jpg`), layout handbook (`images-5.jpg`) |
| Print / riso | Fluorescent riso card (`japanesetrends-01_H.png`), ramen specimen sheet (`il_570xN.6293285091_fl1u.webp`), others (`515dEF8GapL...jpg`, `tumblr_oyqn8luzIi1qaz1ado1_1280.jpg`, `images-2.jpg`, `images-4.jpg`, `images-6.jpg`) |
| Web | Alishia (`images-7.jpg`), unouplus (`web-design-inspiration-unouplus-720x476.png`) |

### What "JMDS" stands for

The brief gives the name only. Read here as **J**apanese **M**odernist **D**esign **S**ystem.
If it means something else internally, say so and every wordmark and readme reference will be
corrected.

### No logo exists

No logo or mark was supplied, and none was invented. The brand renders as the wordmark
**JMDS** set in the display face, uppercase, tracked `-0.03em`. The one mark JMDS permits is a
plain circle in accent ink — the hinomaru disc — used beside the wordmark or as a bullet. See
`guidelines/brand-wordmark.html`. Supply a real logo and it drops into `assets/`.

### Products

No product existed in the brief. Six UI kits were built to demonstrate the system across every
medium it covers — all labelled demonstrations, not recreations, with views that had no source
material left deliberately blank:

| Kit | Medium | Scheme |
| --- | --- | --- |
| **Archive** | Web — public poster catalog | `hinomaru` |
| **Press Room** | Web — production dashboard | `yozora` |
| **Mobile** | Phone app — tabbed catalog | `hinomaru` |
| **Desktop** | Application window | `sumi` |
| **Game UI** | HUD, title and pause | `yokoo` |
| **Print** | Five-sheet A4 catalog | `sumi` |

---

## CONTENT FUNDAMENTALS

The voice is a museum catalog: factual, specific, unhurried. Copy states what a thing is and
what happened to it. It does not sell, hedge, or explain its own importance.

**Person.** Second person for actions the user takes ("Add to run", "Browse the catalog").
First person plural only for institutional statements, and rarely. Never "I".

**Casing.** Sentence case for headings, titles, and body copy. UPPERCASE only in mono —
labels, kickers, badges, tabs, nav links, folios. That split is load-bearing: uppercase means
"this is a marker", sentence case means "this is content". Never uppercase a sentence.

**Length.** Headlines run two to four words. Supporting paragraphs run one or two sentences,
capped at 44 characters per line. Body copy caps at 64. Captions are one clause.

**Numerals.** Zero-padded and mono wherever they are labels: `Plate 04`, `02 / 12`,
`PR-1104`. Real quantities keep their natural form: `412 sheets`, `1,884`.

**Specificity over adjectives.** "Silkscreen, six inks on kinari stock" — not "beautifully
crafted". If a sentence contains no fact, cut it.

**Emoji: never.** Not in UI, not in marketing, not in docs. The system has an icon set and a
geometric vocabulary; emoji break both.

Examples, in voice:

> Four hundred and twelve sheets of Japanese poster modernism, catalogued plate by plate —
> press, ink count, stock.

> Six inks exceeds the press maximum for kinari stock.

> The plate stays in the archive but leaves the active catalog.

> Left intentionally blank — no source material was provided for this view.

Off-voice, for contrast: "Discover our stunning collection!" — sells, exclaims, says nothing.
"We're excited to announce…" — announces the announcement. Both are wrong here.

---

## VISUAL FOUNDATIONS

### Color

Eight named schemes, each a real print tradition. Pick by job, then stop thinking about color.

| Scheme | Palette | Use for |
| --- | --- | --- |
| `hinomaru` (default) | Vermilion on kinari paper, sumi text | Product UI, general purpose |
| `sumi` | Ink monochrome, one red seal accent | Documents, data, long reads |
| `tanaka` | Kinari ground, jade / violet / turquoise | Brand pages, exhibitions |
| `yokoo` | Black ground, magenta / cyan / coral | Campaigns, launches |
| `riso` | Fluorescent pink and matcha on white | Marketing, editorial, zines |
| `yozora` | Night sumi, amber hairlines | Dark mode, dashboards |
| `showa` | Mustard ground, crimson / ultramarine | Retail, events, posters |
| `sakura` | Dusty pink paper, ink brown | Wellness, features |

Rules: at most one accent fill per view; two chromatic inks plus paper and ink is the working
maximum on any single screen; a third ink appears once, as an accent inside a geometric block.
Never sample a hex directly — read `--accent`, `--fg-1`, `--bg-inset` and the scheme resolves
it. Base inks live in `tokens/colors.css`, schemes in `tokens/schemes.css`.

### Type

Four voices, in `tokens/typography.css`:

- **Display — Archivo Expanded, 900.** Uppercase, set solid (`0.86`), tracked `-0.03em`.
  Headlines and the wordmark only.
- **Core — Zen Kaku Gothic New.** Interface and body. 15px at 1.62, measure 64ch.
- **Editorial — Zen Old Mincho.** Pull quotes and feature openers. Never a UI label.
- **Mono — Space Mono.** Labels, captions, folios, numerals, table headers. Uppercase at
  `+0.14em`; marginal labels at `+0.26em`.

The system's signature typographic move is size contrast with nothing in between: a 66px
display headline sitting directly against an 11px mono caption. The middle of the scale
(21–36px) is used sparingly and on purpose.

### Space and layout

12 columns, 20px gutters, 56px page margin (96px on wide brand pages). Layouts are
asymmetric — a 5-column block against a 3-column ink panel against 4 empty columns. **Empty
columns are content.** Space scale is 1px to 176px; jump two steps rather than one.

Fixed elements: the product header (`sticky`, closed by a 2px rule), the sidebar in tool
layouts, toasts bottom-right, scheme chips bottom-left in demos. Nothing else floats.

### Backgrounds

Flat ink fields. **No gradients anywhere** — not in headers, not in hero sections, not
behind text. When a panel needs relief, change the flat fill (`--bg-inset`, `--bg-sunk`) or
nest a different scheme. Four legal textures, all in `tokens/effects.css`: `--tooth` (paper
micro-dot), `--hatch` (45° hairline hatch), `--stripe` (accent bars), and overprint
(two inks crossing at `mix-blend-mode: multiply`). Full-bleed color bands are encouraged;
full-bleed photographs are fine when real photography exists.

### Imagery

JMDS has no photography of its own. Where a picture would go, `GeoBlock` renders a flat
shape composition — disc, quarter, bars, split, grid — in scheme inks. Vary the shape across
a grid. When real imagery arrives, its color vibe should be warm and slightly desaturated,
with visible grain, printed rather than photographic; monochrome with a single ink overprint
is also correct. Cool, glossy, high-dynamic-range stock photography is off-brand.

### Platform density

One system, four densities. Never mix them: a 13px desktop row inside a phone app is a bug.

| | Mobile | Desktop | Game HUD | Print |
| --- | --- | --- | --- | --- |
| Body type | 16px minimum | 13px (12px dense) | 15px in dialogue | 10.5pt on a 13pt baseline |
| Label type | 11px mono | 11px mono | 12px mono | 7.5pt caption / 7pt folio |
| Row / control | 56px row, 44px minimum target | 26–32px row, 24px control | 52px hotbar slot | — |
| Chrome | 52px app bar, 58px tab bar | 34px title, 28px menu, 40px toolbar, 24px status | 28px screen gutter | 16mm margin, 3mm bleed |
| Edge margin | 16px | 12px | 28px | 16mm (24mm wide) |
| Response | 130ms | 130ms | 90ms | — |

Medium-specific rules worth stating outright:

- **Mobile.** Hit targets never below 44px even when the glyph is 20px. Body copy never below
  16px. Press feedback is a flat fill change — no scale, no ripple. Sheets are square-cornered
  with a 3px top rule and a 3px grab bar, not a rounded card with a pill handle. Respect
  `--safe-top` / `--safe-bottom`. JMDS does **not** draw a fake OS status bar.
- **Desktop.** Chrome buttons always `lift={false}` — no hover shift in dense strips. Popovers
  (menu bar, context menu) are square with a 2px frame and a small offset block; the row
  highlight is a solid accent fill. Window controls are ink dots (left) or glyph boxes
  (right), and they are **separate components** — `TitleBar` for macOS, `WindowsTitleBar` for
  Windows/Linux. Pick one at implementation time and keep it; there is no prop that switches
  between them and no runtime toggle in a shipped product. Both are 34px. On
  `WindowsTitleBar`, close hover takes a solid `--critical` fill — the one place JMDS fills a
  control on hover with a semantic colour, because the platform convention outweighs the rule.
- **Game UI.** Panels are **corner brackets**, not frames: four 14px L-arms in accent ink, 3px
  weight, over an 88% ink wash (`solid` when the scene is busy). Meters are hairline outlines
  with a flat ink fill — no gradient, no glow, no bloom, no gloss, no bevel. Cooldown is a
  rising ink wash, never a radial sweep. HUD transitions run at `--dur-hud` (90ms).
  `GameMenuList` is the one place JMDS uses a left-edge band, because there it is a menu
  cursor rather than a card accent. `--hud-scanline` is the only screen texture permitted.
- **Print.** Type is in **pt**, geometry in mm/in — never px on a sheet. Columns are justified
  with hyphenation (screen text is not). Everything sits on a 13pt baseline. Crop marks, the
  desk background, sheet offset blocks and any toolbar are screen-only and stripped by the
  `@media print` block in `tokens/media.css`. Body never below 10pt, captions never below 7pt.
  One full-bleed figure per page at most.

### Borders, shadows, depth

- Hairline `1px` for content divisions, `2px` for structural closes (header, table head),
  `3px` for active indicators and dialog frames, `6px` for section bands and tone edges.
- **No soft shadows and no blur, ever.** Depth is a hard zero-blur offset block —
  `3px 3px 0`, `6px 6px 0`, `10px 10px 0` — the screenprint misregistration. `--offset-sm/md/lg`.
- Tone bands sit on the **top** edge of a Callout, Toast, or Card. Never a rounded box with
  a colored left border.
- No protection gradients over imagery. If a caption needs contrast, it sits on a solid
  capsule or outside the image entirely.

### Transparency and blur

Transparency is allowed in exactly two places: the modal scrim (a flat ink wash at ~84%,
via `color-mix`) and overprint (`mix-blend-mode: multiply`). `backdrop-filter` is not used.
Glass, frost, and translucent nav bars are off-brand.

### Corner radii

`--radius-0` (square) is the default and covers cards, buttons, inputs, dialogs, toasts,
tooltips, badges, checkboxes. `--radius-sm` (2px) exists but is rarely right. Round shapes
are limited to `--radius-pill` (tags, switch tracks) and `--radius-circle` (the disc motif,
radio buttons, avatar-position marks). The `Switch` deliberately puts a **square** knob in a
pill track.

### Cards

`--bg-surface` on a 1px `--rule`, square corners, no shadow by default. A mono uppercase
kicker in accent ink sits above the title; a hairline footer carries meta. One hero card per
page may carry a static `--offset-md`. Interactive cards shift `translate(-3px,-3px)` and gain
the offset block on hover.

### Animation

Mechanical and short. `--ease-mech: cubic-bezier(0.2,0,0.1,1)`, durations 70 / 130 / 200 /
340ms. Only two properties animate: flat color and `translate`. **No scale, no bounce, no
spring, no fade-and-rise entrances.** Print does not bounce. `prefers-reduced-motion`
collapses everything to 1ms in `tokens/base.css`.

### Interaction states

- **Hover (buttons):** the ink inverts — `primary` goes from accent fill to sumi fill — and
  the element shifts `translate(-2px,-2px)` with an offset block behind it.
- **Hover (links):** color goes to `--fg-1` and the text takes an `--accent-soft` highlight
  block behind it.
- **Hover (cards, rows):** flat fill change to `--bg-inset`, no opacity tricks.
- **Press:** the element returns to `translate(0,0)` and the offset block disappears — it
  looks pressed *into* the sheet. No scale-down, no opacity dip.
- **Focus:** a solid two-ring offset (`--ring`) in `--focus`. Never a glow.
- **Disabled:** `opacity: 0.38` and `cursor: not-allowed`. Colors are not changed.
- Opacity is never used to express hover.

---

## ICONOGRAPHY

**Substitution, flagged.** The references are poster and editorial work and contain no icon
system, so JMDS has no native icon set. It uses **Lucide Static** (v0.469.0) from CDN as the
closest match to the brand's geometry: uniform 2px stroke, geometric construction, square
terminals, no fill. Supply a real icon set and only `components/core/Icon.jsx` changes.

- Icons are rendered by the `Icon` component as a **CSS mask** filled with `currentColor`, so
  every glyph re-inks with the scheme automatically. Do not use `<img>` for icons.
- Sizes: 14px in `sm` controls, 18px in `md`, 22px in `lg`. Never below 14.
- Icons never appear alone unless the control has a `label` (`IconButton` requires one).
- **Never hand-roll an SVG icon** and never draw illustrations. Where imagery is missing,
  use `GeoBlock`'s flat geometry.
- **Unicode as icon:** permitted for the required-field asterisk (`*`) and the folio slash
  (`/`) only. Nothing else.
- **Emoji: never.**
- No icon font, no sprite sheet. `assets/` is empty pending real brand material.

---

## FONT SUBSTITUTIONS

No font binaries were supplied, so all four families are Google Fonts substitutions loaded
from `tokens/fonts.css`:

| Role | Family | Why |
| --- | --- | --- |
| Display | **Archivo Expanded** 400–900 | Wide, high-contrast grotesque that holds up set solid at poster sizes |
| Core | **Zen Kaku Gothic New** 400–900 | Modern Japanese gothic; clean and neutral for interface text |
| Editorial | **Zen Old Mincho** 400–900 | Mincho serif for quotes and feature openers |
| Mono | **Space Mono** 400/700 | Slightly eccentric mono with the right feel for print labels |

**Ask:** if JMDS has licensed typefaces, send the `.woff2` files. They drop into `assets/fonts/`
with `@font-face` rules in `tokens/fonts.css`; nothing else changes.

---

## INDEX

### Root

| File | Purpose |
| --- | --- |
| `readme.md` | This guide. |
| `styles.css` | Global CSS entry — `@import` list only. Consumers link this. |
| `thumbnail.html` | Homepage tile for the system. |
| `uploads/` | The twenty reference images, kept for provenance. Not used in the system. |
| `assets/` | Empty. Awaiting a real logo, icon set, fonts, and photography. |

### Tokens (`tokens/`)

`fonts.css` · `colors.css` (base inks) · `schemes.css` (the eight schemes) ·
`typography.css` · `spacing.css` · `effects.css` (radii, offsets, motion, textures) ·
`media.css` (mobile / desktop / HUD / print metrics + the print stylesheet) ·
`base.css` (element defaults).

### Components (`components/`)

**core/** — `Button`, `IconButton`, `Icon`, `Badge`, `Tag`, `Card`, `Rule`

**forms/** — `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `RadioGroup`, `Switch`

**navigation/** — `NavBar`, `Tabs`, `Pagination`

**feedback/** — `Dialog`, `Toast`, `Tooltip`, `Callout`

**editorial/** — `PosterHeading`, `VerticalLabel`, `GeoBlock`, `SchemeSwitcher` (plus the
`SCHEMES` descriptor list)

**mobile/** — `AppBar`, `TabBar`, `ListRow`, `SegmentedControl`, `BottomSheet`, `ActionSheet`

**desktop/** — `TitleBar` (macOS chrome), `WindowsTitleBar` (Windows/Linux chrome), `MenuBar`, `Toolbar`, `TreeNav`, `StatusBar`, `ContextMenu`

**game/** — `HudPanel`, `ResourceMeter`, `AbilitySlot`, `DialogueBox`, `GameMenuList`, `ObjectiveTracker`

**print/** — `PrintSheet`, `PrintColumns`, `Masthead`, `FigureBlock`, `Folio`, `Colophon`

The five core groups above are medium-neutral and used by all four platforms. Buttons, badges,
tags, fields, dialogs, toasts, callouts, rules and `GeoBlock` are shared everywhere — the
platform groups add only what a medium genuinely needs on top.

Every component has a sibling `.d.ts` (props contract) and `.prompt.md` (what, when, usage).
Each directory has one `@dsCard` HTML showing its variants and states.

#### Intentional additions

No source defined a component inventory, so the standard set was authored. Four additions
carry the brand rather than a generic UI need:

- **`Icon`** — wrapper for the substituted Lucide set; one file to swap when real icons arrive.
- **`PosterHeading`** — the display-type headline unit; without it every team rebuilds the
  kicker-plus-solid-display lockup differently.
- **`VerticalLabel`** — the tategaki gutter label, one of the system's strongest motifs.
- **`GeoBlock`** — flat geometric media fill, so nobody reaches for a stock photograph or
  hand-drawn SVG.
- **`SchemeSwitcher`** — makes the eight-scheme system operable and demonstrable.

The four platform groups (`mobile/`, `desktop/`, `game/`, `print/`) were added at the user's
request to extend the system beyond web pages. Each contains only components with no
medium-neutral equivalent — a bottom sheet, a menu bar, a HUD bracket panel, a printed sheet.
Nothing in them duplicates a core primitive.

`Rule` and `Callout` are additions to the standard list too: `Rule` because the labelled
hairline replaces a whole tier of small headings here, and `Callout` because `Toast` alone
cannot carry a persistent inline notice.

### Guidelines (`guidelines/`)

30 specimen cards feeding the Design System tab, grouped **Colors** (paper and ink, warm inks,
cool inks, one card per scheme, semantic roles), **Type** (display, core, editorial, mono,
scale, size contrast), **Spacing** (scale, grid in use, mobile metrics, desktop metrics, print
metrics), **Brand** (offset blocks, rules and registration, radii, fills and textures, motion,
wordmark, HUD metrics).

### UI kits (`ui_kits/`)

| Kit | Medium | Surface | Scheme |
| --- | --- | --- | --- |
| `archive/` | Web | Public poster catalog — landing, faceted browse, plate record | `hinomaru` + nested `yozora` |
| `pressroom/` | Web | Production dashboard — sidebar, run table, ink panel | `yozora` |
| `mobile/` | Phone app | Tabbed catalog, plate record, runs, appearance picker | `hinomaru` |
| `desktop/` | Desktop app | Window chrome, menus, source tree, data table, inspector | `sumi` |
| `game/` | Game UI | HUD, title screen, pause overlay, dialogue | `yokoo` |
| `print/` | Print | Five A4 sheets — cover, feature, plate list, poster, colophon | `sumi` |

Each kit has its own `README.md`. Both are demonstration surfaces, not recreations — see
Products above.

### Templates (`templates/`)

Starting folders a consuming project can copy. Each is a Design Component that loads this
system via a sibling `ds-base.js`.

| Template | What it gives you |
| --- | --- |
| `catalog-page/CatalogPage.dc.html` | Editorial catalog page — header, poster headline, nested dark stat band, facet rail, card grid, folio footer |
| `dashboard/Dashboard.dc.html` | Dark data tool — mono sidebar, stat tiles, held-job callout, run table, ink-build detail panel |

---

## USING JMDS

```html
<link rel="stylesheet" href="styles.css">
<script src="_ds_bundle.js"></script>
<html data-scheme="riso">
```

Then read tokens, never literals:

```jsx
<Card kicker="Plate 04" title="Nihon Buyo" interactive
      media={<GeoBlock shape="disc" ink="var(--accent)" ratio="4 / 3" />}
      meta={<><span>Ikko Tanaka</span><span>1981</span></>}>
  Silkscreen, six inks on kinari stock.
</Card>
```

Then pick the medium's density from `tokens/media.css` and compose from the matching
component group — `mobile/`, `desktop/`, `game/`, `print/` — on top of the shared core.

Five rules that keep work on-brand in every medium: square corners; hard offset blocks instead
of soft shadows; uppercase only in mono; no gradients; leave space empty.

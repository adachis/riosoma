# Document — Design System

**Document** is a design system built from the visual language of printed business documents:
annual reports, KPI reports, invoices, letterhead and editorial poster layouts. It applies that
language — oversized display type, hairline rules, numbered indexes, mono metadata, near-monochrome
paper and ink, and one swappable accent voice — across five surfaces: web pages, desktop apps
(macOS / Windows / Linux), mobile apps (iOS / Android), video game UI, and print layout.

There is no real company behind this system. It is a generic, transferable document language, derived
from the *overall design approach* of the supplied references rather than from any one of them.

## Sources

The system was developed from the following files, supplied as design inspiration only. No image,
logo, brand name, or copy from any reference appears in this design system.

| File | What it contributed |
| --- | --- |
| `uploads/Invoice Blue.jpg` | Capsule table rows, pill summary blocks, single-accent monochrome tinting, four-dot break motif |
| `uploads/Invoice.jpg` | Cream/tinted paper, oversized letter-spaced display title, asterisk reference mark, rounded outer table frame |
| `uploads/1000_F_363650154_09piPYNGddBadFdwehYRM3rSSesL1fts.jpg` | Letterhead structure: full-height ink rail, icon + label + hairline contact stack, solid ink header bar |
| `uploads/390a99fda41a0ee363256d784e8ee607.jpg` | Editorial poster grammar: display type bleeding off the measure, rotated marginal labels, parenthesised page numbers, justified multi-column body |
| `uploads/modern-minimalist-resume-template_742173-33092.avif` | Boxed grid frame, circle-inset panels, hairline cell structure, right-aligned marginal labels |
| `uploads/White Grey Modern Minimalist Annual Report.pdf` (24 pp, A4) | Cover / contents / leadership / numbered-section structure; near-monochrome palette |
| `uploads/Bruttos - KPI Report (Print).pdf` (24 pp, A4) | KPI figure blocks, numbered index with page leaders, `Page - 06` folio style, section numbering `01`–`06` |
| `uploads/Main File 2 (Print).pdf` (24 pp, A4) | "Strictly confidential, for recipient only" callout convention, index-content spread, financial table layout |
| `uploads/Infographic.pdf` (3 pp, 1920 × 1080) | Landscape data spreads: share-of-total meters, regional breakdowns, big-number stat grids |

**Not received:** the six `Minimalist Event Report-0*.eps` files listed in the brief did not arrive in
`uploads/`. If those carry the strongest layout signal, re-attach them and the print kit can be extended.

**Rendering note:** the PDFs could not be rasterised in this environment (the PDF renderer hung on every
page). Their *text content, page geometry, and fill-colour tables* were extracted programmatically and
used as the structural source; their visual layout was inferred from that data plus the raster references.
Colour extraction confirmed all four PDFs are effectively monochrome — near-black plus one or two low-count
accent fills — which is why this system is monochrome-first with a separate accent layer.

---

## CONTENT FUNDAMENTALS

**Voice.** Registrar, not marketer. Copy states what a thing is and what it does, then stops. No
exclamation, no urgency, no second-person selling. Where a claim needs support, a figure carries it.

**Person.** Third person for the product and the record ("Exports are watermark-free"). Second person
only in instructions and controls ("Choose a format"). First-person plural is avoided entirely — the
document speaks, not a team.

**Casing.** Three registers, applied strictly:

- **Sentence case** — headings, body copy, button labels that read as sentences, dialog titles.
  `Export document`, `The shape of a yearly account`
- **UPPERCASE + tracking** — every mono label: eyebrows, field labels, table headers, badges, folios,
  section names, key hints. `KEY PERFORMANCE INDICATOR`, `TOTAL DUE`, `SECTOR 04`
- **Numerals, zero-padded** — sections, pages, indexes and item numbers are always padded to two or
  three digits: `01`, `02`, `(012) / 024`, `No 001234`

**Length.** Headings are 2–6 words. Body paragraphs are 2–4 sentences at a 62-character measure. Field
hints are one clause. Badges are never more than two words. Empty states are a title plus one sentence.

**Punctuation.** No colons after labels — the label sits above or left of its value and the layout does
the joining. En dashes for ranges (`Oct–Dec 2050`), middle dots for metadata runs
(`Report · 24 pp · 2 min ago`), parentheses for page numbers.

**Numbers.** Always tabular mono, right-aligned in tables, thousands separated. Deltas carry the sign
and the arrow (`↑ +29%` / `↓ 4pt`), never colour alone. Percentages are whole numbers unless the source
is finer than 1%.

**Emoji.** Never. Not in UI, not in copy, not in sample content. Where a glyph is needed, use a
FontAwesome icon or the asterisk reference mark (`✱`).

**Sample copy vocabulary** (what the system's placeholder content sounds like):

> KEY PERFORMANCE INDICATOR · Q4 — Q4 Report — Issued 23 AUG 2045 — Total followers 1,289k+ — +29% vs Q3
> — Strictly confidential. For recipient only. — Sessions are de-duplicated across devices.

---

## VISUAL FOUNDATIONS

### Type

| Role | Face | Weights | Notes |
| --- | --- | --- | --- |
| Display / headings | **Familjen Grotesk** | 400, 500, 600 | Tracking −0.035em at display sizes, −0.015em at heading sizes |
| Body / UI | **Hanken Grotesk** | 300–700 | 1.55 leading, 62ch measure |
| Labels / figures | **IBM Plex Mono** | 300–600 | Every uppercase label and every numeral in a table |

**Type substitutions — flag.** No font binaries were supplied. The references use a rounded geometric
humanist sans (invoices), a tight neo-grotesque (editorial poster) and a light display serif (resume).
The three faces above are the closest Google Fonts matches and are loaded from the Google Fonts CDN in
`tokens/fonts.css`. **If you have the real licensed families, send the `woff2` files and the
`@font-face` block will be rewritten to serve them locally.** Because the fonts are remote, the
compiler currently reports zero `@font-face` rules — that resolves as soon as binaries land.

Scale runs `--fs-01` (11px) to `--fs-14` (148px). Steps 11–14 are editorial display sizes and appear
**once per page at most**. Minimum sizes: 24px on a 1920×1080 slide, 12pt in print, 11px for mono labels.

### Colour

Monochrome first. Paper is a warm-neutral light ramp (`--paper-0` … `--paper-4`); ink is a near-black
ramp (`--ink-0` #0e0e0d … `--ink-5`) and **never pure #000**. Structure is carried by three rule
weights, not by fills.

On top of that sits exactly one accent voice, defined by 13 schemes (monochrome default + the 12
supplied palettes). Every scheme fills the same contract:

`--accent` · `--accent-2` … `--accent-5` · `--accent-ink` (type on accent) · `--accent-soft` (tinted fill)
· `--accent-on-soft` (type on `--accent-soft`) · `--paper-tint` (tinted sheet) · `--c1` … `--cN` (the raw
source ramp)

**`--accent-on-soft` is the only legal foreground on `--accent-soft`.** In the light-accent schemes
(apricot, candy, field, electric, spectrum, reef) `--accent` itself falls to 2.2–4.1:1 on its own soft
fill, so those schemes darken it. Every scheme now measures **6.4:1 or better** for on-soft text and
**4.6:1 or better** for `--accent-ink` on `--accent`. `Badge tone="accentSoft"`, `Callout tone="accent"`
and the Android active tab pill all read through this token — never hard-code `--accent` on a soft fill.

Apply with `data-theme` on `<html>`, `<body>`, or any container:

```html
<body data-theme="lagoon">
<section data-theme="press">   <!-- scoped: one spread in a different voice -->
```

Schemes: `mono` `spectrum` `midnight` `electric` `archive` `apricot` `field` `lagoon` `signal` `candy`
`reef` `press` `sage`.

Rules for accent use: **one accent per page or screen.** Accent is allowed on marks, charts, capsules,
badges, links on hover, active pills and one primary button. It is never applied to body copy, table
rules, or window chrome. Semantic status colours (`--success` `--warning` `--danger` `--info`) are fixed
across all schemes so meaning never shifts with theme.

### Spacing and layout

4px base with print-derived intermediate steps (`--space-025` 2px … `--space-9` 128px). Page margins are
tokens, not leftovers: `--margin-page` 96px, `--margin-page-tight` 32px, `--margin-page-mobile` 24px.
Content maxes at 1240px on 12 columns with `--space-3` gutters. Print sheets are A4 at 96 dpi
(794 × 1123 px) with a 64px (≈17 mm) margin.

Where a layout needs air, remove a column — never shrink the type. Fixed elements are limited to the
sticky site header, mobile status/tab bars, desktop window bars and game HUD panels.

### Backgrounds and imagery

No photographic or illustrative background is part of the system. Sheets are flat `--paper-*` or
`--paper-tint`; one section per page may be solid `--ink-0` full-bleed. The only textures are
`--pattern-rule` (a 8px ledger field) and `--pattern-hatch` (135° 6px hatch, used for redaction and
empty plates). **No gradients anywhere** — not in backgrounds, not in bars, not in overlays.

Imagery, when a project supplies it, should read cool-neutral to warm-grey with visible grain and no
saturation push; it sits in a hairline-bordered rectangle at the grid, full-bleed or half-column, never
rounded and never with a scrim over type. In this system every image is a labelled placeholder block so
nothing pretends to be art that was not supplied.

### Corners, borders, shadows

**Two radii only:** `0` for everything structural (cards, inputs, panels, tables, windows, sheets) and
`999px` for the capsule (badges, summary rows, chips, tab pills, the game reticle). 4px / 6px / 8px
rounding is out of system.

Borders: `1px` hairline (rows, cards, field underlines), `1.5px` medium (section and masthead rules,
keycaps, active tab), `3px` heavy (active nav edge marker only).

Shadows: `--shadow-none` is the default for every surface. `--shadow-paper` (0 18px 44px −18px, 16%)
marks a lifted sheet or hovered card. `--shadow-pop` (0 40px 90px −28px, 34%) is only for dialogs,
toasts and menus. There are no inner shadows and no glows.

**Cards** are therefore: white or tinted fill, 1px hairline border, square corners, no shadow, optional
uppercase mono eyebrow above a sentence-case title. Nothing floats unless it is genuinely above the page.

### Transparency and blur

Used in exactly three places: the sticky web header (`--veil` 82% paper + `--blur-bar`), mobile
status/tab bars (same), and game HUD panels (82% ink + 6px blur). Dialog scrims use `--scrim`
(ink at 44%) with a 2px blur. Everywhere else, surfaces are opaque.

### Motion

Documents settle; they do not spring. Durations `--dur-fast` 120ms (controls), `--dur-base` 180ms
(surfaces, toggles), `--dur-slow` 280ms (bars and meters filling), `--dur-page` 420ms (view changes).
Easing is `--ease-out` `cubic-bezier(.2,.7,.25,1)` for entrances and `--ease-in-out`
`cubic-bezier(.6,0,.2,1)` for moves. **No bounce, no overshoot, no spring, no scale-in.** Fades and
position moves only; bars and meters animate width. All durations collapse to 0 under
`prefers-reduced-motion`.

### Interaction states

| State | Treatment |
| --- | --- |
| Hover, ink control | Background `--ink-0` → `--ink-1` (slightly lighter, never a tint) |
| Hover, accent control | `filter: brightness(.92)` |
| Hover, outline / ghost | Fill drops in at `--paper-2`; border unchanged |
| Hover, link | Colour and underline both switch to `--accent` |
| Press | `filter: brightness(.86)`. **No scale, no translate** |
| Focus | `1.5px solid var(--focus-ring)` outline at 2px offset — the same ink ring on every control |
| Disabled | `opacity: .38`, no filter, `cursor: not-allowed` |
| Selected, nav | `--paper-2` fill plus a 3px `--ink-0` edge bar |
| Selected, tab | 1.5px `--ink-0` rule under the label |
| Selected, game menu | Full inversion — no glow, no outline |

---

## ICONOGRAPHY

**System:** [FontAwesome](https://fontawesome.com), loaded from the project's own kit:

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
<!-- fallback: the kit only serves domains authorised in its settings -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/css/all.min.css" crossorigin="anonymous">
```

**Kit domain flag.** The kit script loads but injects nothing on this preview host, because
`kit.fontawesome.com` only serves domains registered in the kit's settings. Every page in this project
therefore also links the FontAwesome **free** CDN stylesheet as a fallback, and icons render from
whichever source answers. Add this project's preview domain (and your own app domains) to the kit's
authorised list and the kit — including any Pro families — takes over automatically. The fallback line
can then be removed.

Every card, kit and template in this project loads that kit. The `Icon` component wraps it:

```jsx
<Icon name="arrow-up-right" variant="solid" size="14px" />
```

Rules:

- `variant="solid"` is the default and covers every icon in the free set. `variant="regular"` is used
  only for icons that have a regular cut (folder, user, file-lines, bookmark, star, bell, calendar) —
  asking for a regular icon that has no free regular cut renders an empty box. `light` / `thin` /
  `duotone` need the Pro kit and are not used by this system; `brands` is available and unused.
- Icons inherit `currentColor`. The only permitted explicit colours are `--ink-*`, `--text-muted` and
  `--accent`.
- Sizes: 10–12px beside mono labels, 13–14px in controls and rows, 16–18px in tab bars and feature
  blocks, 22px in empty states. Never larger — an icon is never a hero element here.
- `fixedWidth` on any icon in a vertical list so labels align.
- Decorative icons get `aria-hidden`; meaningful ones require `label`.

**Not used:** emoji, Unicode dingbats as UI icons, hand-drawn or bespoke SVG icons, and PNG icons.
The one non-FontAwesome glyph in the system is the **asterisk reference mark `✱`** (U+2731), set in the
display face, used beside a wordmark or masthead title as a print reference mark.

**No logo was supplied.** The system therefore has no logo file. Wherever a mark would go, the brand
name is set in plain type — `Document` in Familjen Grotesk Medium at −0.04em tracking, with the
asterisk mark in `--accent`. `assets/` is intentionally empty: no mark, illustration, or photograph was
drawn or invented. See `guidelines/brand-mark.html` for the three permitted lockups.

---

## Components

42 primitives in eight groups. Each has `<Name>.jsx`, `<Name>.d.ts` and `<Name>.prompt.md`, plus one
`@dsCard` sheet per directory.

**`components/core/`** — `Badge` · `Button` · `Card` · `Divider` · `Icon` · `IconButton` · `Tag`

**`components/forms/`** — `Checkbox` · `Field` · `Input` · `Radio` · `Select` · `Switch` · `Textarea`

**`components/navigation/`** — `Breadcrumb` · `IndexList` · `MenuList` · `Pagination` · `Tabs`

**`components/feedback/`** — `Dialog` · `EmptyState` · `ProgressBar` · `Toast` · `Tooltip`

**`components/data/`** — `CapsuleRow` · `DataTable` · `Legend` · `MeterList` · `StatFigure`

**`components/document/`** — `Callout` · `EdgeLabel` · `PageHeader` · `PullQuote` · `SectionLabel`

**`components/chrome/`** — `MobileNavBar` · `MobileStatusBar` · `MobileTabBar` · `WindowChrome`

**`components/game/`** — `GameMenu` · `GamePanel` · `KeyHint` · `VitalBar`

### Intentional additions

No source defined a component inventory (the references are finished documents, not a component
library), so the inventory is the standard set sized to this system's needs, plus these deliberate
additions:

- `Icon` — wrapper for the FontAwesome kit, so glyph style and sizing stay consistent.
- `IndexList`, `SectionLabel`, `EdgeLabel`, `PageHeader`, `PullQuote`, `Callout`, `CapsuleRow`,
  `StatFigure` — the document motifs that make this system itself rather than a generic UI kit. Each
  maps to a specific pattern in the references (contents index, numbered section, rotated spine label,
  masthead, pull quote, confidentiality note, pill summary row, KPI figure).
- `WindowChrome`, `MobileStatusBar`, `MobileNavBar`, `MobileTabBar` — required by the brief's desktop
  and mobile surfaces.
- `GamePanel`, `GameMenu`, `VitalBar`, `KeyHint` — required by the brief's game-UI surface. These apply
  the document language unchanged; they do not adopt game-UI conventions.

## UI kits

| Kit | Entry | Screens |
| --- | --- | --- |
| Web | `ui_kits/web/index.html` | Home, Product, Pricing, Template library, Journal article |
| Desktop | `ui_kits/desktop/index.html` | Library + editor in macOS / Windows / Linux chrome; export dialog; dialog, utility and toolbar windows |
| Mobile | `ui_kits/mobile/index.html` | Library, document, activity, settings, empty — iOS and Android side by side |
| Game | `ui_kits/game/index.html` | Title, in-game HUD, archive/pause, options |
| Print | `ui_kits/print/index.html` | A4 cover, contents index, KPI spread, invoice, letterhead |

Every kit mounts `ui_kits/ThemeSwitcher.jsx` — a preview-only control, not product UI — so any screen
can be checked against all 13 schemes.

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | The one file consumers link. `@import` list only |
| `tokens/fonts.css` | Font families + Google Fonts load |
| `tokens/colors.css` | Paper, ink, rules, semantic status, semantic aliases |
| `tokens/themes.css` | The 13 `data-theme` scopes |
| `tokens/typography.css` | Weights, size scale, leading, tracking, composed roles |
| `tokens/spacing.css` | Space scale, page margins, measure, grid, control heights |
| `tokens/surfaces.css` | Radii, border widths, shadows, transparency, patterns |
| `tokens/motion.css` | Durations, easing, composed transitions, reduced-motion |
| `tokens/base.css` | Element resets, link colours, focus ring, `.ds-*` helpers |
| `components/<group>/` | The 42 primitives |
| `ui_kits/<surface>/` | The five kits, each with its own `README.md` |
| `guidelines/*.html` | 21 foundation specimen cards |
| `guidelines/theme-preview.html` | Full composition rendered in every scheme, with a live switcher |
| `thumbnail.html` | Homepage tile |
| `assets/` | Intentionally empty — no logo or imagery was supplied |

## Caveats

1. Font binaries are substitutions from Google Fonts (see Type above).
2. The six `.eps` event-report files never arrived; the print kit covers report / invoice / letterhead
   but not an event-recap spread.
3. PDF pages could not be rasterised here, so PDF layouts were reconstructed from extracted text,
   geometry and fill colours rather than from a visual read.
4. All imagery in every kit is a labelled placeholder. Nothing was drawn or generated.

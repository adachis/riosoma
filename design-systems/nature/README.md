# Nature Design System

A calm, photographic design language for organisations whose subject is the natural world — landscape studios, conservation bodies, botanical retail, outdoor products, field software. Deep green ink on warm off-white, very large uppercase display type, hairline rules instead of boxes, and full-bleed landscape photography carrying most of the emotional weight.

It is built to be applied across five surfaces without changing its personality: **web pages, desktop apps (macOS / Windows / Linux), mobile apps (iOS / Android), video-game interface, and print**.

There is **no logo**. None was supplied in the source material, and none has been invented. Wherever a mark would sit, the word `NATURE` is set in the display face at 700 weight with 0.16em tracking. See `guidelines/brand-wordmark.card.html`.

---

## Sources

Everything in this system was derived from material the user attached. Nothing from those sources is reproduced verbatim: no supplied logo, brand name, copy, illustration or photograph from a reference has been carried through, and the visual language is a synthesis rather than a copy of any one template.

**Attached codebase** — mounted read-only as `Nature/`:

| Path | What it is | What was taken |
| --- | --- | --- |
| `Nature/leaflife-garden-landscape-service-template-2026-01-14-02-07-39-utc/` | HTML/SCSS marketing template for a garden-landscape service. The most fully-specified source: SCSS variables, typography partial, shortcode partials. | The core of the system — colour seeds (`#374836`, `#f9fbf3`, `#e1ece3`), the Plus Jakarta Sans / DM Sans pairing, the 100/80/56/42/32/24/20/18/16 type scale, the 3/5/7/10/15/20 radius ladder, the square-button-that-rounds-on-hover, `[BRACKET]` kickers, gradient emphasis words, glass panels over photography, 48/64px circular arrow buttons, the 20px photo frame with 1.05 zoom. |
| `Nature/Gardyn/` | Bootstrap/MDB garden-service template with four swappable colour schemes. | The vivid leaf accent `#77a32a` (its `css/colors/green.css`), and the confirmation that this category of product expects a runtime colour-scheme switch — which became the 13-theme variant system. |
| `Nature/Plant_v1.0.0/` | Bootstrap 3 plant-shop template, ten homepage variants. | Read for structural conventions only (product grids, filter rails, cart flows). Its Bootstrap 3 CSS was not used. |
| `Nature/Figma-Plantzone-v1.0-19-March-2024/` | 29 exported PNG page designs plus `PlantZone.fig`. | Reviewed as PNG reference for e-commerce page inventory. The `.fig` was not mounted, so nothing was read from it directly. |
| `Nature/50-nature-2026-03-27-01-51-36-utc/` | 50-icon nature set, SVG outline and colourline at 64px. | 30 outline SVGs copied to `assets/icons/`. |
| `Nature/Nature 2/` | Filled landscape/nature icon set, SVG + PNG. | 8 filled marks copied to `assets/illustrations/` as spot illustrations. |
| `Nature/nature-2026-02-24-01-22-19-utc/` | 34 plant/tree line SVGs. | Reviewed; the 50-icon set was more consistent, so this one was not shipped. |
| `Nature/*.jpg` (10 files) | Stock landscape photography, 4600–8256px wide. | 8 photographs resized to 1800px and copied to `assets/photos/` as **placeholders**. |

**Uploaded reference images** — 11 files in `uploads/`: eco-tourism and plant-retail web concepts, moss/interior product pages, garden app screens. Used only to calibrate mood (generous whitespace, capsule tags, small circular icon badges, cool green palettes). **None of them appear in the system**, and no branding, name or copy from them was used.

Not supplied, and therefore absent: a real logo, a live product URL, a GitHub repository, a Figma link with read access, slide templates, and brand tone-of-voice documentation. Copy in this system is original, written in the voice described below.

---

## Content fundamentals

The source templates write like a studio talking about work it has actually done. The system keeps that and tightens it.

**Voice.** Plain, concrete, slightly technical. The subject is always the site, the ground, the water, the plant — not the company's feelings about them. Prefer a measurable claim over an adjective: "1,240 m² of terraced planting above a spring-fed stream" rather than "a stunning transformation".

**Person.** "We" for the organisation, "you" for the reader. Never "I". Never third-person self-reference ("Nature believes…").

**Casing.** This is the strongest copy rule in the system, because casing carries the hierarchy:
- Display and section headings: **UPPERCASE**, no full stop. `CREATE YOUR WILD GARDEN`, `WE ARE DIFFERENT IN EVERY WAY`.
- Kickers, eyebrows, field labels, table heads, tab labels, badges: **UPPERCASE with 0.08em tracking**, usually one or two words. `[ VALUES ]`, `[ APPROACH ]`, `SITE SIZE`.
- Everything else — body, card titles, list rows, buttons, captions: **sentence case**. `Get Started` and `Book a visit` are title-ish because they are two-word buttons; longer buttons stay sentence case.
- Never Title Case A Whole Sentence Like This.

**Length.** Hero subtitle ≤ 30 words. Body paragraphs 2–3 sentences. Card descriptions ≤ 18 words. Feature titles 3–4 words (`Passion in every bed`, `Site before style`). Table cells are values, not sentences.

**Numbers.** Always numerals, always with a unit, always tabular in tables (`--nt-font-mono`). Ordinals in lists are zero-padded two digits (`01`, `02`, `03`) — the source uses this for both process steps and index rows, and it is a load-bearing part of the look.

**Emoji: never.** Not in UI, not in copy, not in marketing. Iconography is Font Awesome or the shipped SVG set. Unicode characters are used as glyphs in exactly one place: the square brackets around kickers, and they are `aria-hidden`.

**Vibe.** Unhurried and slightly austere. Confident without exclamation marks. No urgency language, no growth-hack copy, no "unlock", "supercharge", "seamless", "revolutionise". If a sentence would work in a seed catalogue, it works here.

**Examples of good copy from this system:**
- `They spent two days just looking at where the water goes. Everything since has held up.` (testimonial)
- `Site before style — the ground decides the plan, not a mood board.` (feature)
- `Two to six weeks depending on hard landscaping and season.` (FAQ answer)
- `Cover tender beds tonight.` (frost alert)
- `If a bed needs weekly attention in year three, the plan was wrong.` (long-form)

**And what to avoid:** `Transform your outdoor space into a breathtaking oasis! 🌿` — wrong on casing, punctuation, emoji, and register.

---

## Visual foundations

### Colour

Three tones do almost all the work: **ink** (deep green `#374836`), **paper** (warm off-white `#f9fbf3`), and **soft** (pale moss `#e1ece3`). The vivid **leaf accent** `#77a32a` is used sparingly — a filled button, a meter, a focus ring, one badge — never as a background for large areas.

The whole palette derives from eight seeds. A theme sets `--nt-seed-ink`, `-paper`, `-accent`, `-accent-2`, `-accent-3`, `-accent-4`, `-on-accent`; `tokens/theme.css` derives about fifty semantic tokens from them with `color-mix(in oklab, …)`. Text ramps are ink mixed into paper at 62% / 42% / 26%; borders at 14% / 32%; hover and press are ink at 8% / 16% alpha.

Because custom properties resolve where they are declared, **each `[data-nt-theme]` block restates the full derived set**. That duplication in `tokens/themes.css` is deliberate — collapsing it breaks nested theming.

**13 colour schemes** ship: Grove (default, native to the system) plus twelve variants — Spectrum, Midnight Gold, Neon Bloom, Field Red, Blush Sage, Harvest, Lagoon, Fern Coral, Sorbet, Reef, Ochre, Stone Mint. Set `data-nt-theme="lagoon"` on `<html>`, `<body>`, or any subtree. Each variant keeps the structure — dark ink, light paper, one loud accent — so layouts do not need to change.

Several palettes contained no colour dark enough to serve as ink at body-text contrast. In those cases the ink seed is the palette's darkest hue deepened (e.g. Spectrum's `#26343d` from its slate/teal end). This is noted here rather than hidden.

**Signal colours are constant across all themes** — success `#43aa8b`, warning `#f8961e`, danger `#e63946`, info `#4d908e`. Status must not change meaning when someone switches theme.

### Type

- **Display / headings:** Plus Jakarta Sans, shipped as a variable TTF and aliased `Nature Display`. 600 for section headings, 400 for the largest hero (100px), 700 for wordmarks and numbers.
- **Body / UI:** DM Sans, shipped as a variable TTF and aliased `Nature Text`. 400 body, 500–600 for emphasis and labels, 700 for buttons.
- **Mono:** no monospace binary was supplied, so `--nt-font-mono` is a system stack (`ui-monospace, SF Mono, Menlo, Consolas`). It carries ordinals, quantities, coordinates and keycaps. **If a brand mono is wanted, supply the file.**

Scale, exactly as the source specifies it: 100 / 80 / 56 / 42 / 32 / 30 / 24 / 20 / 18 / 16 / 14 / 12. Line heights tighten as size grows: 1.08em at 100px, 1.1em at 80px, 1.2em for headings, 1.25em at 32px, 1.33em at 24px, 1.5em for body. Display sizes step down at 1400px, 1199px, 991px and 767px breakpoints.

Headings get `text-wrap: balance`, body gets `text-wrap: pretty`, long-form is capped at 70ch.

**Gradient emphasis** is the system's one typographic flourish: one word inside a section heading fades from ink toward haze `#a0a6a1` (`.nt-gradient-text`), or from moss toward paper on dark sections (`.nt-gradient-text-inverse`). One word per heading, never two.

### Spacing and layout

The spacing scale is the rhythm the source actually uses, not a 4px grid: 4, 8, 10, 12, 16, 20, 24, 32, 40, 50, 64, 80, 100, 120, 150. Where the source says 5px or 13px, this system says 5px and 13px.

Container 1296px with 24px gutters; narrow container 880px. Sections are separated by 100px, dropping to 70px below 991px. The gap between a section heading and its content is 64px. Grid and flex `gap` is used everywhere; margins on siblings are avoided.

Fixed elements: the site header is either sticky at 88px tall or absolutely positioned over a photographic hero. Game HUD panels pin to the four corners with a 24px inset. Nothing else is fixed.

### Backgrounds

Four background treatments, and no others:
1. **Flat paper** — the default.
2. **Flat ink** — for process bands, footers, next-project bands. Roughly one dark band per two light ones.
3. **Full-bleed photography** with either an ink wash at 50–65% or a bottom-up protection gradient (`--nt-protect-bottom`). Text never sits on unprotected photography.
4. **Pale moss (`--nt-surface-soft`)** for form cards, icon tiles and sidebars.

No gradients as decoration. No mesh, no bluish-purple, no noise overlays, no repeating patterns, no hand-drawn illustration.

### Photography

Cool green landscapes: moss, waterfalls, canopy, alpine lake, meadow with snow peaks, dunes. Overcast or golden-hour light, high humidity, no people, no products, no filters or duotones. Colour is left as shot — the palette is already green, so the imagery does not need grading. Grain is not added.

All eight photographs in `assets/photos/` are **placeholders** and must be replaced with licensed imagery before anything ships.

### Corners, cards and borders

Cards are 20px radius, 24px padding, and are defined by **fill, not by shadow**: paper with a hairline border, pale moss with none, ink, or glass. Small controls use 10px; chips, table cells and inputs 5–7px; tags and switches are pills (`1.6em`); avatars and arrow buttons are circles.

Borders are always 1px. Two weights: `--nt-border` (ink at 14%) for structural hairlines, and `--nt-border-ink` (full ink) for the accordion, index-row and meta-bar rules that are meant to read as drawn lines. There is exactly one dashed border in the system — the process card in the source — and it is not part of the component set.

**Cards with a coloured left border do not exist in this system.**

### Shadow

Elevation is nearly absent by design. `--nt-shadow-soft` (0 2px 10px, ink 7%) for barely-lifted surfaces, `-card` (0 12px 32px -12px, 18%) for hoverable cards, `-lift` for the hover state, `-overlay` (0 32px 80px -24px, 40%) for modals, device frames and window chrome. Inner shadows are used only as focus rings inside form fields (`inset 0 0 0 1px`). The one white shadow in the system is `--nt-shadow-halo`, a 50%-paper glow lifted from the source's hero stat panel.

### Transparency and blur

Blur appears in exactly one context: **glass over photography**. `--nt-glass-bg` is a 241° gradient from 50% paper to 10% paper, `--nt-glass-border` is a 50%-paper hairline, `--nt-glass-blur` is `blur(5px)`. Used for hero info panels, gallery hover badges, game HUD, and icon buttons sitting on imagery. Never over a flat colour, never as a "frosted card" on a normal page.

Protection gradients are preferred over capsules for text on photography: a bottom-up ink gradient across the whole frame, not a pill behind the words. Capsules are used only for tags, which are outlined rather than filled.

### Motion

Everything transitions; almost nothing bounces. `0.2s` for icon and checkbox state, `0.3s` for buttons, links and hovers, `0.4s` for cards, accordions and washes, `0.6s` for the underline sweep, `0.8s` for photo cross-fades, `1.2s` for photo zoom. Default easing is plain `ease`; `cubic-bezier(0.49,0.49,0.08,1)` for progress and sweeps; `cubic-bezier(0.7,-0.56,0.27,1.6)` — the only overshoot — for the text-link underline retracting to 50%.

Entrances fade up 18px (`@keyframes nt-fade-up`). The preloader and spinner are two dots pulsing 0.6s apart. `prefers-reduced-motion` collapses every duration to 0.01ms.

**Three hover signatures define the system and should be preserved:**
1. **Filled buttons go from 0 to 10px radius and lift 2px.** Square at rest, rounded on hover.
2. **Circular buttons invert their fill and scale to 1.08.**
3. **Photographs zoom to 1.05 over 1.2s**, and hoverable photo cards fade an ink wash in and round their corners to 20px.

Text links draw a full-width 1px rule that retracts to 50% from the right on hover. Overlapping circle and avatar groups spread apart at the ends.

Press states darken rather than shrink: a 16%-ink overlay (`--nt-state-press`). Nothing scales down on click. Disabled is 40% opacity with pointer events off.

---

## Iconography

**Two icon systems, used for different jobs.**

**1. Font Awesome (the user's kit) — all UI iconography.** Load the kit in every page:

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

Every component that takes an `icon` prop expects a Font Awesome class string (`"fa-solid fa-arrow-up-right"`). Conventions:
- **Solid** for actions, controls and navigation: `fa-arrow-right`, `fa-arrow-up-right`, `fa-magnifying-glass`, `fa-chevron-down`, `fa-xmark`, `fa-check`, `fa-plus`, `fa-sliders`, `fa-bars`.
- **Regular** for objects and nouns: `fa-user`, `fa-heart`, `fa-calendar`, `fa-clock`, `fa-bookmark`, `fa-square`.
- **Nature nouns** in either weight: `fa-seedling`, `fa-leaf`, `fa-tree`, `fa-mountain-sun`, `fa-droplet`, `fa-sun`, `fa-snowflake`, `fa-fire`, `fa-wind`.
- Nominal size 20px standalone, `0.9em` inside a button, 17px in a mobile tab bar. Always `currentColor`.
- The diagonal `fa-arrow-up-right` (or `fa-arrow-right` rotated -45°) is the system's "open this" glyph and appears in every kit.

The source templates bundled five icon fonts (FA4, FA6, Elegant, et-line, IcoFont) plus inline SVG. **None of them were shipped**; the user's Font Awesome kit replaces all of them. This is the one intentional substitution, and it was requested.

**2. Shipped SVG sets — decorative and domain iconography.**
- `assets/icons/` — 30 outline nature/weather icons on a 64px grid, copied from the attached set. Fixed stroke colour, so recolour by inlining the file or with a CSS `filter` (the game kit inverts them to white). Used for inventory slots, category tiles and specimen sheets.
- `assets/illustrations/` — 8 filled landscape marks (national park, tree, maple leaf, clover, hot springs, swamp, iceberg, grass), for empty states and large spot graphics. **Placeholder artwork — replace for production.**

No icon in this system was drawn by hand, and none should be. If a glyph is missing, take it from Font Awesome.

---

## Index

### Root
| File | Purpose |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` lines only. |
| `readme.md` | This document. |
| `thumbnail.html` | Homepage tile for the design system. |

### Tokens — `tokens/`
`fonts.css` (font-face + family aliases) · `palette.css` (raw Grove ramp + constant signals) · `theme.css` (seeds + the derived semantic layer) · `themes.css` (12 variant scopes) · `typography.css` · `space.css` · `radius.css` · `elevation.css` · `motion.css` · `layout.css`

### Base — `base/`
`base.css` (element defaults, focus rings, keyframes) · `utilities.css` (`.nt-container`, `.nt-section`, `.nt-ink`, `.nt-glass`, `.nt-protect`, `.nt-gradient-text`, `.nt-display-1/2`, `.nt-mono`, `.nt-label`, responsive type steps)

### Components — `components/`
Each has `<Name>.jsx`, `<Name>.d.ts`, `<Name>.prompt.md`, and one `@dsCard` HTML per directory.

- **core/** — `Button`, `IconButton`, `ArrowButton`, `Tag` (+ `TagGroup`), `Badge`, `Card`, `BracketLabel`, `SectionHeading`, `Stat`, `Divider`
- **forms/** — `FormField`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `SearchField`
- **navigation/** — `NavBar`, `Breadcrumb`, `Tabs`, `Pagination`, `SideNav`, `Footer`
- **feedback/** — `Alert`, `Dialog`, `Toast`, `Tooltip`, `ProgressBar`, `Spinner`
- **data/** — `Table`, `Accordion`, `Avatar` (+ `AvatarGroup`), `ListRow`, `Rating`
- **surfaces/** — `GlassPanel`, `ImageFrame`, `WindowChrome`, `DeviceFrame`, `GameHUD`, `ThemePicker`

**Intentional additions.** The attached sources are HTML templates, not component libraries, so no component inventory was handed down; the standard primitive set was authored and then extended where the five required surfaces demanded it. Additions beyond a conventional set, each with its reason:
- `BracketLabel`, `SectionHeading`, `Stat`, `ListRow`, `ArrowButton`, `GlassPanel`, `ImageFrame` — these are the source's most distinctive recurring blocks; leaving them out would mean every consumer rebuilding them slightly differently.
- `WindowChrome`, `DeviceFrame` — required by the desktop and mobile surface briefs.
- `GameHUD` — required by the game surface brief.
- `ThemePicker` — needed to demonstrate the 13 colour schemes. **It is documentation UI, not product UI**; do not ship it in a product.

### UI kits — `ui_kits/`
| Kit | Contents |
| --- | --- |
| `web/` | Marketing site — Home, Projects, ProjectDetail, Contact, wired click-through in `WebApp.jsx`. |
| `desktop/` | One planting-planner app inside macOS, Windows and Linux chrome — Planner, Library. |
| `mobile/` | Four-screen field app rendered in iOS and Android shells side by side. |
| `game/` | In-world HUD, inventory overlay and pause menu over a scene plate. |
| `print/` | Poster, brochure spread, business card, report page, journal cover. Pure CSS, prints directly. |

Each kit has its own `README.md` and a `@dsCard`-tagged `index.html`.

### Templates — `templates/`
`landing-page/` and `app-screen/` — starting folders a consuming project can copy.

### Guidelines — `guidelines/`
26 specimen cards feeding the Design System tab, grouped **Colors** (surfaces, text ramp, accent, support, signals, lines & states, glass, 13 theme variants), **Type** (families, display, headings, body, labels, gradient emphasis), **Spacing** (space scale, section rhythm, radius ladder, container, elevation), **Motion** (durations, hover signatures) and **Brand** (wordmark, Font Awesome usage, nature icon set, illustrations, photography).

### Assets — `assets/`
`fonts/` (2 variable TTFs) · `photos/` (8 landscape placeholders, 1800px) · `icons/` (30 outline SVGs) · `illustrations/` (8 filled SVGs)

---

## Using it

```html
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

Then either use the compiled components (`window.NatureDesignSystem_7637d7`) or write plain markup against the `--nt-*` tokens. To switch scheme, add `data-nt-theme="harvest"` to any element.

## Known gaps

- No logo, no monospace binary, no brand tone-of-voice document.
- All photography and all spot illustrations are placeholders.
- `PlantZone.fig` was present but not mounted as a readable Figma file, so nothing was read from it.
- The nature SVG icons have baked-in stroke colours rather than `currentColor`.
- Template markup references photographs with paths relative to this project (`../../assets/photos/…`). A consuming project that copies a `templates/<slug>/` folder must repoint those to its own bound `_ds/` tree, the same one-line change as `base` in `ds-base.js`.
- Component cards and the React UI kits read components from `window.NatureDesignSystem_7637d7`, which the compiler emits as `_ds_bundle.js`. On the very first pass that file does not exist yet, so those pages render empty until the bundle is compiled; the token, print and guideline cards do not depend on it.

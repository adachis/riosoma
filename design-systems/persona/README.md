# Persona — design system

A high-contrast, cut-paper interface system. Everything is built from three ingredients: a single saturated accent, a near-black ink, and a paper white. Type is heavy and set at an angle. Surfaces are square-cornered slabs with hard offset shadows. Selection wiggles. Nothing fades politely.

The system is deliberately domain-agnostic. The same tokens and components drive a magazine website, a desktop research app, a phone reader, a full-screen game HUD and a printed A4 spread, and each of those is built out in full under `ui_kits/`.

**There is no logo.** No brand mark existed in any supplied source, so none was invented. Wherever a mark would go, the word *Persona* is set in the display face at a −2° to −3° tilt with a four-corner ink outline. See `thumbnail.html` for the canonical treatment.

---

## Sources

| Source | What it gave us |
| --- | --- |
| `persona-menu-master/` (attached local codebase — a fan-made interactive game menu, MIT-style hobby project, originally at github.com/AnyThony/persona-menu) | The interaction grammar: `clip-path` wiggle on selection, four-corner `text-shadow` outlines, `-20deg` rotated cards, slide-in-from-right entrances with an 80%-overshoot keyframe, hover/select audio hooks. `src/styles.css` is the single most useful file. |
| 26 reference images in `uploads/` | Visual direction only — ransom-note headline tiles, diagonal full-bleed wedges, halftone and ray textures, staggered menu columns, magazine spread structure, two-ink print treatment. |
| Font Awesome Kit `559791bdc6` | The entire icon layer. |

Nothing from those sources ships inside this system: no images were copied, no fonts were lifted, no names, logos or copy were reused. The reference images informed proportion, rhythm and motion vocabulary; every asset here is generated from CSS or set in a licensed webfont.

### Substitutions, flagged
- **Fonts.** The attached codebase ships a `UXFont.ttf` extracted from a commercial game. It is not used and was not copied. The display face is **Anton** (Google Fonts), the closest freely licensable heavy condensed grotesque; **Bungee** covers sticker/stamp lettering, **Barlow Semi Condensed** all running text and UI, **Space Mono** all figures. If you have licensed brand faces, replace the four `--font-*` tokens in `tokens/typography.css` and nothing else needs to change.
- **Icons.** No icon set existed in the sources. The system uses your Font Awesome kit. Load it on every page: `<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>`.
- **Imagery.** No photography, illustration or key art is included. Every place one belongs is a labelled dashed placeholder at the correct aspect ratio.

---

## Content fundamentals

**Voice.** Flat, declarative, faintly deadpan. Short sentences that state a fact and stop. The system never sells, never enthuses, never explains its own cleverness. When something is a limitation, it says so.

- Good: "Four issues a year. One arrives late. It always does."
- Good: "Nothing matches. Try fewer words."
- Bad: "Oops! We couldn't find anything 🙈 Try adjusting your filters!"

**Person.** Second person for instructions to the reader ("Bring something you printed and regret"). First person plural only in editorial contexts where a named group is speaking ("We asked what survived the compression"). Never first person singular. Product UI avoids person entirely: "Order received", not "We've received your order".

**Casing.** This is the loudest rule in the system.
- Display type, buttons, menu items, tabs, slab labels, table headers, stat labels, chips, badges, window titles, tab-bar labels: **UPPERCASE**, always, via `text-transform`. Never type them uppercase in the source — the CSS does it, so the string stays readable in code and in translation.
- Everything else — body copy, help text, placeholders, dialogue, article prose: **sentence case**. Not title case. "Send the calling card?" not "Send The Calling Card?"

**Length.** Menu labels are one word where possible, two at most, and are budgeted at eleven characters — the width the staggered menu column is built for. Button labels are one to three words and start with a verb ("Place the order", "Read the feature"). Help text is one sentence. Error messages name what happened and what to do, in that order, in under twelve words: "That key was rejected."

**Numbers.** Always in `--font-data` (Space Mono), always tabular, always with thousands separators. Dates as `04 / 22` in game and dashboard contexts, `04/22 · 21:14` in lists, spelled out in editorial. Currency symbols stay attached to the figure.

**Punctuation.** Curly quotes in prose, straight in UI. Em dashes are rare — the middle dot `·` is the system's separator for metadata runs ("Interview · 14 min"). Exclamation marks appear nowhere.

**Emoji.** Never. Not in UI, not in copy, not in documentation. The icon layer is Font Awesome; if a glyph is needed there is a glyph for it.

---

## Visual foundations

### Colour
Ten variables carry everything: `--ink`, `--paper`, `--brand`, `--brand-2`, `--brand-3`, `--on-brand`, `--success`, `--warning`, `--danger`, `--info`. Neutrals are *derived*, not authored — `--ink-90` through `--ink-10` are `color-mix()` steps between ink and paper, so a theme never has to specify a grey ramp.

Semantic aliases (`--surface-page`, `--text-body`, `--line-hard`, `--state-hover-fill`, …) sit on top and are declared twice: once on `:root`, once on `[data-theme]`. That duplication is deliberate — it lets a `data-theme` attribute on any subtree re-resolve every alias against its own ramp.

**One accent per surface.** The brand colour is the only saturated colour in a layout. Semantic colours appear at the moment they mean something and then leave. Two accents fighting is the single fastest way to break this system.

**Thirteen palettes ship.** `ink` (the signature crimson/ink/newsprint default) plus twelve supplied variants: `spectrum`, `midnight`, `riot`, `signal`, `sherbet`, `campfire`, `verdant`, `mintshock`, `bubblegum`, `lagoon`, `ember`, `sage`. Set `data-theme="riot"` on `<html>`, `<body>` or any container. `guidelines/theme-playground.html` shows every component under every palette.

### Type
Four families, no exceptions.

| Token | Family | Where |
| --- | --- | --- |
| `--font-display` | Anton | Headlines, menu items, buttons, tabs, window titles, stat values, drop caps. Uppercase, `-0.01em` tracking, `0.86` leading at display sizes. |
| `--font-sticker` | Bungee | Chips, stamps, small caps badges. Never above `--size-lg`. |
| `--font-ui` / `--font-body` | Barlow Semi Condensed | All running text, form fields, help text, table cells. 500 for body, 700 for emphasis, 600 italic for pull quotes. |
| `--font-data` | Space Mono | Every figure: currency, counters, timestamps, HP readouts, page folios, keyboard hints. |

Scale is a 1.30 ratio from 11px to 152px, floored so nothing lands under 11px in UI and 12pt in print. Slide/game text never goes below `--size-md` (20px).

`--ink-outline-1` through `-4` are the four-corner `text-shadow` that lets pale display type sit on photography. Level 2 is default; level 4 is hero-only.

### Space and geometry
4px base, `--space-1` (4) through `--space-10` (128). Page gutter is `--space-5` (24), section rhythm `--space-7` (48), hero `--space-9` (96).

**Corners are square.** `--radius-none` is the default for panels, cards, buttons, fields, tables, windows. `--radius-pill` exists for radio dots, badges and the one floating mobile action. `--radius-soft` (6px) is available and almost never used. Softness where the system expects a hard edge reads as a mistake.

Instead of radii, the system **cuts corners**: `--clip-cut-tr` (top-right chamfer, the button and tab shape), `--clip-cut-both`, `--clip-slab` (irregular quad), `--clip-blade`, `--clip-flag`, `--clip-torn`. One cut shape per element; one full-bleed diagonal per band.

**Tilts come from a fixed list** — `--tilt-hair` (−1.5°), `--tilt-sm` (−3°), `--tilt-md` (−5.5°), `--tilt-lg` (−8°), `--tilt-xl` (−20°), plus two positive angles. Never invent an angle. `--skew-slab` (−12°) is the horizontal shear used by slab labels, progress tracks, health bars and active tab-bar items; text inside always counter-skews so letters stay upright.

### Backgrounds and texture
No photographic backgrounds ship with the system. Depth comes from CSS-generated, theme-tinted texture: `--tex-halftone` (1.15px dots on a 6px grid), `--tex-hatch` (135° repeating stripes), `--tex-rays` (conic starburst, used behind dialogs and on game stages), `--tex-newsprint` (1-in-3px horizontal noise for print grounds). Full-bleed colour blocks and clipped diagonal wedges do the rest.

Where photography belongs, it is duotone: ink plus brand, cool and high-contrast, never warm and never desaturated to grey. Scrims (`--scrim-bottom`, `--scrim-side`) are the only approved way to protect type over an image — the system uses ink-outlined type rather than capsules.

### Borders, shadows, elevation
Borders are `--stroke` (3px) by default, `--stroke-thin` (2px) on small controls, `--stroke-heavy` (5px) on hero and modal edges, `--stroke-brutal` (8px) on toast accents. Always solid, always `--line-hard` (ink). Dashed borders mean *empty* or *placeholder* and nothing else.

Shadows are **hard offsets with zero blur** — `3px 3px 0`, `6px 6px 0`, `10px 10px 0` of ink. Cards, buttons, panels, fields and windows all use them. Blur appears exactly once, under floating layers (`--shadow-float`, `0 18px 44px rgba(0,0,0,.5)`), and always paired with a hard shadow underneath it. Inner shadows are used only to fake a border on a transparent slab.

Transparency and blur are rationed: `--blur-sheet` exists for sheet backdrops, and `color-mix()` alpha is used only for scrims, hover washes on table rows, and the dialog overlay. Type is never alpha-reduced — muted text uses `--ink-70`, a real mixed colour, so contrast stays measurable.

### Cards
Square corners, 3px ink border, `6px 6px 0` ink shadow, no radius, no gradient. The media band is a halftone placeholder at 16:9 with a 3px bottom rule. Interactive cards rotate to `--tilt-sm` and lift 4px on hover while the shadow grows to `10px 10px 0`. That is the entire card language.

### Motion
Durations: 70 / 120 / 200 / 420 / 620ms. Easings: `--ease-snap` (overshoot, the default), `--ease-overshoot` (aggressive, for stamps), `--ease-out-hard`, `--ease-in-hard`.

Named animations: `psn-wiggle` (the selection slab's 400ms clip-path loop), `psn-fly-in` / `psn-fly-out` (entrances travel from off-screen right and overshoot to −1.5% before settling — lifted from the source codebase's `slide-in`), `psn-stamp` (dialogs land from 2.4× scale), `psn-jitter`, `psn-spin`, `psn-marquee`, `psn-flash`.

Nothing cross-fades. Opacity transitions are limited to tooltips. `prefers-reduced-motion` collapses every duration to 1ms and stops the wiggle.

### States
- **Hover** — the element *changes colour and moves*. Buttons flip fill to `--state-hover-fill` and rotate from `--tilt-hair` to `--tilt-sm` while lifting 2px and growing the shadow. Menu items translate 14px right and grow 5%. List rows flood brand and slide 6px right. Icon buttons rotate and scale 1.08.
- **Press** — scale 0.94–0.97, shadow collapses to `1px 1px 0`, fill darkens to `--state-press-fill`.
- **Focus** — 3px solid `--focus-ring` outline at 2–3px offset. Never removed, never replaced by a colour change alone. Menu items use a dashed ring at 6px offset so it reads against art.
- **Selected** — brand fill plus a tilt. Selection is never indicated by colour alone in dense lists; the row also moves.
- **Disabled** — `--opacity-disabled` (0.42), transform and shadow removed, cursor `not-allowed`.

### Layout rules
Content caps at `--container-wide` (1240px) for pages and `--container-text` (62ch) for prose. Game stages are a fixed 1280×720; phones are 390×800; A4 print pages are 794×1123 at 96dpi.

Fixed elements: the site header is sticky with a 5px brand rule beneath it; `CommandHints` is pinned bottom-right on full-screen surfaces and owns that corner; the mobile tab bar is bottom-fixed with a 3px brand top rule. Nothing else is fixed.

Layout is flex and grid with `gap` throughout. Sibling groups are never spaced by margins on individual children.

---

## Iconography

**Font Awesome is the icon layer.** No bespoke glyph set exists in the sources and none was drawn. Load the kit on every page:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

- **Family.** `fa-solid` is the default and covers ~95% of use. `fa-regular` appears only inside dense data tables and the Windows maximise glyph. `fa-light` and `fa-duotone` are not used.
- **Size.** Icons run at 1.0–1.5× their adjacent text size; standalone icons in `IconButton` are `--size-sm` at md and `--size-md` at lg. Icon-only controls always carry an `aria-label`.
- **Colour.** Icons inherit `currentColor`. They are never given their own accent.
- **The `Icon` component** wraps the class-string convention (`<Icon name="bolt" />`). Components that take an icon prop expect the full Font Awesome class string (`icon="fa-solid fa-bolt"`), because that is what a designer pastes from the kit search.
- **Unicode as icon.** Two exceptions only: `·` as the metadata separator, and `◀` as the end-of-article mark in print and long-form. Arrow glyphs (`↵`, `↑↓`, `⌘`) are permitted inside `CommandHints` keys and keyboard shortcut labels because Font Awesome has no matching key-cap treatment.
- **Emoji.** Never.
- **Logos and brand marks.** None ship. Do not generate one.

---

## Index

### Root
| File | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` lines only. |
| `thumbnail.html` | Homepage tile — the canonical wordmark treatment. |
| `readme.md` | This file. |

### Tokens — `tokens/`
`typography.css` · `colors.css` · `themes.css` (13 palettes) · `spacing.css` · `effects.css` · `motion.css`

### Foundations — `guidelines/`
19 specimen cards (Colors, Type, Spacing, Brand) plus `theme-playground.html`, an interactive switcher that renders the whole component set under all 13 palettes.

### Components — `components/`
Styling lives in `components/components.css` (class prefix `psn-`). Every component is a self-contained `.jsx` with a sibling `.d.ts` and `.prompt.md`.

**core/** — `Button`, `IconButton`, `Chip`, `Badge`, `Panel`, `Icon`
**typography/** — `RansomHeading`, `SlabLabel`
**forms/** — `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`
**navigation/** — `MenuList`, `Tabs`, `Breadcrumb`, `Pagination`, `CommandHints`
**feedback/** — `Dialog`, `Toast`, `Tooltip`, `Banner`, `ProgressBar`, `Spinner`
**data/** — `Card`, `StatBlock`, `DataTable`, `ListRow`
**chrome/** — `WindowFrame`, `MobileStatusBar`, `MobileNavBar`, `MobileTabBar`
**game/** — `HealthBar`, `RadialCommand`, `DialogueBox`, `ItemSlot`

38 components in total.

#### Intentional additions
No source defined a component inventory — the attached codebase is a single game-menu demo, not a library. The set above was authored from scratch to cover the five target surfaces. Three entries are worth calling out because they exist for this system specifically rather than because "a design system usually has one":

- **`Icon`** — a thin wrapper over Font Awesome class strings, so the icon layer has one documented call site instead of raw `<i>` tags scattered through kits.
- **`RansomHeading`** / **`SlabLabel`** — the cut-tile headline and skewed label bar are the system's two signature typographic devices, lifted directly from the reference material. Without them every consumer would hand-roll the same markup.
- **`MenuList`** — the staggered, outlined, wiggle-selected command column is the single most recognisable pattern in the sources; it is a component, not a layout recipe.

### UI kits — `ui_kits/`
| Kit | Screens |
| --- | --- |
| `web/` | Editorial site — home, feature article, filterable archive, subscribe form |
| `desktop/` | Casefile — three-pane document app in macOS, Windows and Linux chrome, plus preferences and command-palette windows |
| `mobile/` | Reader app — iOS and Android side by side; home, reader, saved, settings |
| `game/` | Second Face — title, main menu, battle HUD, inventory at 1280×720 |
| `print/` | Cover, two-page feature spread, poster, business cards at A4 and 85×55mm |

Each kit has its own `README.md` documenting the rules specific to that surface.

---

## Using it

```html
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
<body data-theme="ink">
```

Then compose from the components. Reach for a token before a literal value; if a value you need is not a token, that is usually a sign the design is drifting.

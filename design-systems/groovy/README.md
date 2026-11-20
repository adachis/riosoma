# Groovy Design System

A 1970s-revival visual system for building interfaces, games, and print. Warm paper grounds,
fat bubble display type, chunky ink outlines, hard offset "sticker" shadows, seamless floral and
psychedelic pattern artwork, and twelve interchangeable colour schemes.

Groovy is not a product brand. It is a **style system**: a full set of foundations and components
that can be applied to any subject matter — a record shop, a bank, a puzzle game, a festival
programme — and still read as one coherent piece of design.

---

## Sources

Everything in this system was derived from material the client supplied. No third-party brand,
logo, name, or copy appears anywhere in it.

| Source | What it gave us |
| --- | --- |
| `Groovy Assets/` (attached local folder, read-only) | 30+ display/script/text typefaces, 16 wave backgrounds, ~150 seamless pattern tiles, an Earth-Day illustration bundle (~300 SVG/PNG/EPS flat-vector graphics), a psychedelic starburst SVG, a floral alphabet |
| `uploads/*.jpg|png|webp|avif` (24 reference images) | Style reference only — 70s landing-page and poster templates, logotype sheets, groovy lettering samples. **Used for reading the style, never copied.** None ship in the system. |
| `textstudio.com/logo/1048/Css+Font` and `textstudio.com/logo/retro-vintage-groovy-70s-style-font-1260` (links supplied) | Confirmed the layered-offset lettering treatment (solid fill + hard ink offset, no blur) that the wordmark and hero type use |
| 12 Coolors palettes (links supplied) | The twelve colour-scheme variants, each re-tuned to muted 70s values |
| Font Awesome Kit `559791bdc6` | All UI iconography |

**Fonts** — every typeface in `assets/fonts/` was copied from the supplied `Groovy Assets/Groovy Fonts/`
folder. One substitution: **no monospace face existed in the library**, so `--font-mono` maps to
**Space Mono** from Google Fonts. Send a licensed mono and it is a one-line swap in `tokens/fonts.css`.

**No logo** — the sources contain no logo file or brand mark, so none was invented. The wordmark is
the name set in `--font-chunk` with a hard ink offset (`guidelines/brand-wordmark.html`).

---

## Index

| File / folder | What's in it |
| --- | --- |
| `styles.css` | Global entry point. Imports only — link this one file. |
| `tokens/` | `fonts.css` `colors.css` `themes.css` `typography.css` `spacing.css` `radius.css` `shadows.css` `motion.css` `texture.css` `base.css` |
| `assets/fonts/` | 20 local font binaries (TTF/OTF/WOFF) |
| `assets/illustrations/` | 40 flat-vector SVG illustrations |
| `assets/patterns/` | 13 seamless pattern tiles |
| `assets/backgrounds/` | 8 full-bleed wave / starburst graphics |
| `components/` | 64 React primitives in 13 groups (below) |
| `guidelines/` | 28 foundation specimen cards |
| `ui_kits/` | Five surface kits: web, desktop, mobile, game, print |
| `_dev_ds.js` | Dev fallback: builds the component namespace in-browser when `_ds_bundle.js` hasn't been compiled yet. No-op once it has. |
| `thumbnail.html` | Homepage tile |

### Components

Grouped by concern. Every component is `<Name>.jsx` + `<Name>.d.ts` + `<Name>.prompt.md`, with one
`@dsCard` preview per directory.

- **`components/core/`** — `Button` `IconButton` `Badge` `Tag` `Card` `Sticker` `RainbowRule` `Marquee` `Arch`
- **`components/forms/`** — `Field` `Input` `Textarea` `Select` `Checkbox` `Radio` `Switch` `Slider` `SegmentedControl`
- **`components/navigation/`** — `NavBar` `Tabs` `SideNav` `Breadcrumb` `Pagination`
- **`components/feedback/`** — `Alert` `Toast` `Modal` `Tooltip` `ProgressBar` `Spinner` `EmptyState`
- **`components/data/`** — `Avatar` `Stat` `Table` `ListRow` `Accordion`
- **`components/fluid/`** — `WaveEdge` `Blob` `SquiggleRule` `Scatter` `ArcText`
- **`components/layout/`** — `Hero` `PageSection` `PatternPanel`
- **`components/window/`** — `MacWindow` `WindowsWindow` `LinuxWindow` `DesktopMenuBar`
- **`components/mobile/`** — `PhoneFrame` `MobileAppBar` `MobileTabBar` `ActionSheet`
- **`components/game/`** — `HudPanel` `Meter` `GameButton` `DialogueBox` `InventorySlot` `ScoreCounter`
- **`components/print/`** — `DropCap` `PullQuote` `Caption` `PosterFrame`
- **`components/icons/`** — `Icon`
- **`components/theme/`** — `ThemeSwitcher`

**Intentional additions.** The sources are an asset library, not a component library, so the
component inventory is authored rather than transcribed. Two entries are worth calling out:

- `Icon` — a Font Awesome wrapper. The library ships illustration SVGs but no UI glyph set, so UI icons come from the client's kit; this gives them one call site and a short alias vocabulary.
- `ThemeSwitcher` — documentation furniture for previewing the twelve schemes. It is deliberately **not** meant to ship inside a product UI.

### Colour-scheme previews

`guidelines/colors-schemes.html` lists all twelve; `guidelines/colors-scheme-preview.html` renders the
same UI in each one with a live switcher. The `ThemeSwitcher` component does the same thing inside a
React page. All three are documentation tools — see the rules under Visual foundations → Colour.

### UI kits

| Kit | Surfaces |
| --- | --- |
| `ui_kits/web/` | Marketing home, catalogue/listing, article, checkout |
| `ui_kits/desktop/` | macOS library app, Windows studio app, Linux file manager — all three window types |
| `ui_kits/mobile/` | iOS: browse, detail, profile · Android: home, list, settings |
| `ui_kits/game/` | Title screen, in-game HUD, inventory/pause, dialogue scene |
| `ui_kits/print/` | Event poster, two-page editorial spread, ticket + label sheet |

---

## Content fundamentals

**Voice.** Warm, plain-spoken, unhurried. It sounds like a person who knows the subject well and
isn't performing. The register is closer to a well-written shop sign than to marketing copy.

**Person.** Address the reader as **you**. Speak as **we** for the organisation. Never "I".
Never the third-person corporate voice ("Groovy believes…").

**Casing.** Sentence case for anything a person reads as a sentence — headings, body, hints,
buttons in body context. `UPPERCASE` **only** for micro-labels: eyebrows, field labels, badges,
stickers, tab labels, table headers, button labels inside the `Button` component. Those get
`--ls-caps` (0.12em) tracking and never drop below 11px. Never all-caps a full sentence.

**Length.** Headlines 3–7 words. Section leads one sentence. Body paragraphs 2–4 sentences.
Micro-labels 1–3 words. Button labels 1–3 words, verb-first.

**Punctuation.** Serial commas. En dashes with spaces for asides. No exclamation marks in UI copy —
the type is already loud enough. Numerals as digits everywhere ("4 crates", not "four crates")
except when starting a sentence.

**Emoji.** Never. Not in UI, not in copy, not in headings. The illustration set covers every job an
emoji would do, and does it in the brand's own drawing style.

**Examples — do**

> Fresh out of the crate
> Dig the whole catalogue
> We only write when there's something worth hearing.
> Ships in two working days, tracked.
> Your crate is empty. New pressings land every Thursday.
> `ADD TO CRATE` · `SOLD OUT` · `SIDE A` · `12 TRACKS`

**Examples — don't**

> Unlock Your Groovy Journey! ✨  *(title case, exclamation, emoji, empty promise)*
> Groovy is committed to curating best-in-class vinyl experiences.  *(corporate third person)*
> OUR STORY BEGAN IN A SMALL GARAGE IN 1974 AND SINCE THEN…  *(all-caps sentence)*
> Oops! Something went wrong 😬  *(cute failure; say what broke and what to do)*

**Error and empty copy.** Name the problem, then the next action, in that order, in one or two
sentences. "That address looks wrong. Check for a missing @." Not "Invalid input."

---

## Visual foundations

### Colour

A warm **paper** ground (`--gv-paper`, a cream or tinted off-white) carries almost every surface.
**Ink** (`--gv-ink`, a deep warm brown or navy) does all the outlining and all the body text — it is
never pure black. Three action colours sit on top: **primary** (a burnt orange or brick),
**secondary** (a teal, denim, or forest), and **accent** (a mustard gold). Each has a `-deep`
press tone and an `-ink` foreground guaranteed to pass contrast on it.

Five ordered **band** tokens (`--gv-band-1` … `-5`) drive every rainbow: rules, arcs, progress
fills, meter tracks, poster stripes. They are theme-scoped, so the rainbow recolours with the scheme.

**Twelve schemes**, each adapted from a supplied Coolors palette into muted 70s values:
`sunburst` (default) · `midnight-lounge` (dark) · `discotheque` · `roller-rink` · `peach-parlor` ·
`harvest-table` · `lagoon` · `neon-cactus` (dark) · `bubblegum` · `seafoam` · `denim-marigold` ·
`avocado-kitchen`. Apply one with `data-gv-theme="<name>"` on `<html>` or any wrapper. Every
scheme redeclares the identical token contract — including the derived shadow and rainbow tokens —
so nothing downstream changes.

**Rules.** At most **two** coloured bands per page or screen; everything else is paper. Accent gold
appears **once** per view (active nav pill, or one sticker, or one feature card — not all three).
Semantic colours are always solid fills with their `-ink` foreground; never a 10%-alpha tint with
coloured text on it. Product UIs pick one scheme and commit — the switcher is a docs tool.

### Type

Five roles, no overlap:

| Token | Face | Use |
| --- | --- | --- |
| `--font-chunk` | Lucky Chunks | Hero and display only, 40px+. One per page. |
| `--font-slab` | Chinook | Every `h1`–`h6`, card titles, stat values. |
| `--font-script` | Bold Groovy (italic) | Pull quotes, taglines. Never UI labels. |
| `--font-poster` / `--font-caps` | Chunky Sticker / Sugar Groovy | Print headlines, game titles, ticket stubs. Caps only. |
| `--font-text` | Sugar Peachy (300/400/500/700/900) | All body, UI, labels, buttons. |
| `--font-mono` | Space Mono *(substituted)* | Numbers, SKUs, timers, scores, code. |

`--font-vintage` (Back To Vintage, roman + italic) is available for editorial serif settings.

Body 16px / 1.55. Headings 1.16. Display 0.92–1.08 — chunk type needs tight leading or it
falls apart. Tracking is near-zero everywhere except uppercase micro-labels at 0.12em.
Slide/deck text never below 24px; print never below 12pt; mobile touch targets never below 44px.

### Spacing and layout

4px base, 13 steps, generous at the top (`--sp-12` is 104px). Section rhythm is `--section-y`
(104px). Content sits inside `--page-max` (1180px) or `--page-wide` (1440px). Prose is capped at
`--measure` (66ch). Cards pad `--sp-6`; stacked blocks gap `--sp-4`; inline siblings gap `--sp-3`.
Layout is always flex/grid with `gap` — never margin-spaced inline siblings.

Fixed elements are rare and deliberate: a `sticky` `NavBar`, a bottom `MobileTabBar`, edge-anchored
`HudPanel`s in game UI. Nothing else pins.

### Fluid, not gridded

**This is the system's governing instinct.** The era it comes from was about personal freedom, and
the design has to behave that way: curves instead of edges, drift instead of alignment, organic
shapes instead of repeated rectangles. A tidy grid of four identical cards is the single most
off-brand thing you can build here.

Five moves carry it, and a page should use at least two:

1. **Curved section boundaries.** Bands end on a `WaveEdge` — `wave`, `ripple`, `scallop`, `drip`, or `arc` — not a straight rule. Alternate the shape and `mirror` between consecutive edges so no curve repeats. `PageSection` takes `waveTop` / `waveBottom` and compensates its own padding.
2. **Off-grid layout.** `Scatter` keeps a grid's responsive columns but gives each child a deterministic vertical drift and a small rotation, so rows never share a baseline. Use it for card sets, chips, galleries, and stat pods. Keep `amplitude` 18–34px and `tilt` under 3.5°.
3. **Organic silhouettes.** `Blob` and `Card shape="blob|blob-2|blob-3|pebble"` break up runs of rectangles. Six organic radii (`--r-blob-1`…`-4`, `--r-petal`, `--r-pebble`) plus `--r-leaf` and `--r-lozenge`. Vary the `variant` across siblings; at most three blobs in view.
4. **Wobbly rules.** `SquiggleRule` replaces `RainbowRule` wherever the divider is decorative. Keep `RainbowRule` for tight spots — card footers, progress fills, sidebars.
5. **Tilt and arc.** Stickers, pills, feature cards and illustrations rotate by `--tilt-xs`…`--tilt-lg` (±1.5° to ±8°). `ArcText` sets short headings on a curve. Content cards stay under 4°; decoration can go further.

The counterweight: **tables, forms, print trim, and data stay square and aligned.** Fluidity is for
the page's structure and its decoration, never for something a reader has to scan in rows or a
printer has to cut.

### Corners

Nothing is square by accident. `--r-xs` 6 · `--r-sm` 10 · `--r-md` 18 · `--r-lg` 28 · `--r-xl` 40 ·
`--r-pill` 999. Buttons, inputs, selects, tags, badges, avatars: **pill**. Cards, panels, modals:
`--r-lg`. Small controls and tables: `--r-md`. `--r-arch` (999px top, 18px bottom) is the system's
signature silhouette — imagery, portraits, hero panels, reward cards. `--r-blob` exists for
decorative shapes only.

### Borders and shadows

**Ink outlines are structural, not decorative.** Almost every surface carries a 2–3px solid ink
border (`--bw-1` 2px is the default, `--bw-2` 3px for emphasis, `--bw-3` 4px for game and print
frames). Dashed 2px ink marks the hollow states: ghost buttons, empty inventory slots, cancel rows.

**Shadows are hard, zero-blur offsets** in full-strength ink — lifted from screen-printing, not from
Material. `--shadow-sticker-sm` 2px, `--shadow-sticker` 4px, `-lg` 7px, `-xl` 12px.
`--shadow-tint` offsets in accent gold instead of ink; `--shadow-double` stacks gold at 4px and ink
at 8px, reserved for the single most important element on a page. `--shadow-press` is the 1px
pressed state. `--shadow-inset` / `-deep` recess inputs and meter tracks.

`--shadow-lifted` is the **only** blurred shadow in the system and exists solely for modals.

### Backgrounds and imagery

Backgrounds are **real artwork**, never CSS gradients pretending to be artwork. Three moves:

1. **Pattern wash** — a seamless tile from `assets/patterns/` behind a section at 15–25% opacity (`--pattern-wash` is 0.18). Tile size `--pattern-tile` (340px).
2. **Full-bleed wave** — a graphic from `assets/backgrounds/` as a hero backdrop or a section transition (`PatternPanel`).
3. **Flat paper** — the default, and the right answer most of the time.

Photography, when present, is warm: amber-biased, slightly desaturated, visible grain, never cool
or clinical. It always sits inside an `Arch` or an ink-outlined frame — never bleeding to an
unframed edge inside a content area.

Illustrations are flat vector with thick ink outlines and no gradients (`assets/illustrations/`).
They are used as `<img>` tags. **Never redraw them, never generate new ones by hand.**

### Transparency and blur

Used sparingly and only where physical depth is implied: the modal scrim (ink at 55% with a 3px
blur), the mobile action-sheet scrim (ink at 50%, no blur), and `color-mix` soft borders. No
frosted-glass panels, no translucent cards, no glass nav bars. Opacity below 100% never appears on
text — muted text uses `--gv-ink-2` / `-3`, never alpha, so contrast stays predictable.

### Motion

The house curve is `--ease-groove` — `cubic-bezier(.34,1.42,.64,1)`, a slight overshoot, so things
settle like a needle dropping onto vinyl. `--ease-bounce` overshoots harder for toggles and pops.
Nothing is linear except the marquee.

Durations: `--dur-fast` 150ms for hover and press · `--dur-base` 240ms for panels, toggles,
disclosure · `--dur-slow` 420ms for view transitions · `--dur-marquee` 22s.

Named keyframes in `tokens/base.css`: `gv-marquee` (announcement bands), `gv-spin` (the record
spinner), `gv-bob` (idle float on illustrations and prompts), `gv-wobble`, `gv-pop` (modals,
toasts, sheets). All motion collapses to 1ms under `prefers-reduced-motion`.

### States

- **Hover** — lift `translate(-2px,-2px)` and *grow* the shadow one step. Never a colour change alone, never an opacity drop.
- **Press** — sink `translate(2px,2px)`, shadow drops to `--shadow-press`, background moves to the `-deep` tone.
- **Focus** — 3px solid `--focus-ring` (accent gold) at 2px offset. Visible on keyboard only, never suppressed.
- **Selected** — accent gold fill with ink text and a small sticker shadow. This is the one consistent "on" signal across tags, tabs, side nav, accordion headers, and inventory slots.
- **Disabled** — 45% opacity, shadow removed, `not-allowed` cursor. Never greyed to a different hue.
- **Invalid** — border switches to `--gv-danger`, message below in danger with a `circle-exclamation` glyph.
- **Loading** — the spinning record (`Spinner`), or `Button loading` which swaps the leading icon for a spinning disc.

### Cards

Paper fill, 3px ink border, `--r-lg` corners, `--shadow-sticker`. `media` slots bleed full-width and
are separated by an ink rule. `footer` sits on a 2px ink rule. Interactive cards lift on hover.
No card ever has a coloured left border only, and no card has a soft blurred shadow.

---

## Iconography

**UI glyphs: Font Awesome, kit `559791bdc6`.** The supplied asset library contains illustrations
but no UI glyph set, so the client's own kit covers every functional icon. Load it in the page head:

```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Both lines are intentional. The kit is the client's authorised source; the cdnjs Font Awesome 6
Free stylesheet is a webfont fallback so `<i class="fa-solid …">` still renders on origins the kit
isn't authorised for. Every card and UI kit in this project loads both. If you know the kit is
authorised for your domain, drop the cdnjs line.

Style: `fa-solid` is the default weight, `fa-regular` for outline variants (empty window buttons,
unfilled stars). No brand icons, no duotone, no thin. Sizes 14 / 16 / 18 / 20 px in UI;
`fa-fw` on anything in a list or nav so glyphs align. Icons are `aria-hidden` unless they carry
meaning alone, in which case they take a `label`.

Prefer the `Icon` component and its aliases (`record` `disc` `flower` `sun` `heart` `star` `peace`
`cart` `search` `menu` `close` `check` `next` `prev` `play` `pause` `bolt` `user` `settings`) so
glyph choices stay consistent. Passing a raw class string is fine for anything outside the alias set.

**Illustrations: `assets/illustrations/` (40 SVGs).** Flat vector, thick ink outline, no gradients —
suns with faces, daisies, hippie flowers, toadstools, rainbow splashes, groovy hearts, peace signs,
stars, swirls, waves, sunglasses, a guitar, a coffee cup. Use them at 40–140px for empty states,
game portraits and inventory items, poster decoration, and card spot art. Reference by `<img>`.

**Never** hand-roll an SVG for either job. **Never** use emoji or Unicode glyphs (✳ in the `Marquee`
separator is the single exception, and it is decorative and `aria-hidden`). **Never** approximate a
missing illustration — ask for the asset.

---

## Using this system

```html
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

```jsx
// components are exposed on the compiled bundle's namespace
const { Button, Card, Hero, RainbowRule } = window.GroovyDesignSystem_f9068d;
```

Switch schemes at any level:

```html
<html data-gv-theme="denim-marigold">
<div data-gv-theme="neon-cactus"> <!-- scoped preview --> </div>
```

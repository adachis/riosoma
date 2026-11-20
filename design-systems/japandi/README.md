# Japandi Design System

A design system for the **Japandi** aesthetic — the meeting point of Japanese
restraint and Scandinavian function. Warm paper grounds, sumi ink, hairline
structure, one saturated accent, and a great deal of deliberate empty space.

It is built to cover five very different surfaces from one token set:

| Surface | What it covers | UI kit |
|---|---|---|
| Web | Marketing pages, editorial, commerce, journal | `ui_kits/web/` |
| Desktop | macOS, Windows and Linux window chrome, all window types | `ui_kits/desktop/` |
| Mobile | iOS and Android app screens | `ui_kits/mobile/` |
| Game | HUD, pause menu, inventory, dialogue, quest log | `ui_kits/game/` |
| Print | Poster, editorial spread, product sheet, invitation | `ui_kits/print/` |

## Sources

This system was built from a set of **visual references supplied by the user as
image uploads** — no codebase, Figma file or repository was provided. The
references were interior/lifestyle web pages, Japanese-Scandinavian art prints,
Ukiyo-e-derived pattern plates, editorial poster layouts and product mockups.

Because those references belong to third parties, **none of them are vendored
into this project and no name, mark, logo or copy from any of them is reused.**
Everything here is an original interpretation of the shared visual language:
warm off-white paper, oat and clay neutrals, sumi-black ink, indigo and
vermillion accents, thin-stroke line art, and asymmetric editorial grids.

Consequences worth knowing:

- **There is no logo.** No mark existed in the sources, so none was invented.
  Wherever a mark would go, the brand name is set in the display serif
  (`Wordmark`). Do not draw, commission-by-proxy, or approximate one.
- **There is no photography.** Cards and kits use pattern tokens and tinted
  fills where imagery belongs, with a visible placeholder label. Drop real
  photography in and the layouts are already sized for it.
- **The fonts are Google Fonts substitutions.** No font binaries were supplied.
  See *Font substitutions* below.

---

## Content fundamentals

**The voice is a maker's, not a marketer's.** It states what a thing is and how
it was made, and stops. Confidence comes from omission.

- **Person.** Third person or plain imperative for product and interface copy.
  First-person plural (*we*) only for studio statements; second person (*you*)
  only where the reader must act. Never "Let's".
- **Sentence length.** Short declaratives, one idea each. Two sentences is a
  paragraph. The serif reading face rewards a slow, even rhythm.
- **Casing.** Sentence case for everything readable. UPPERCASE with wide
  tracking for structural labels only — field labels, eyebrows, CTAs, status
  bars, breadcrumbs. Never uppercase a full sentence.
- **Numbers.** Always numerals, always in the mono face when they are data.
  Enumerate sections as `01 —`, `02 —`. Give real units (`14 days`, `¥182,400`).
- **Emoji.** Never. Not in UI, not in copy, not in docs. Icons are Font Awesome
  glyphs; status is a coloured dot.
- **Punctuation.** En dashes for ranges, em dashes sparingly, no exclamation
  marks. Japanese interpuncts (`·`) separate short metadata runs.
- **Words to avoid.** *Effortless, curated, elevate, seamless, journey,
  unlock, delight, revolutionary, game-changing.* Also avoid the
  "not this, but that" construction.

Examples, on-voice:

> The fusion of *Japanese* and Scandinavian aesthetics.
> Layered texture keeps a minimal room from reading clinical.
> White oak, hand-oiled. Fourteen-day lead time.
> Two items are back-ordered. Ship dates move to 14 March.
> No saved rooms yet. Anything you bookmark shows up here.

Examples, off-voice:

> Discover our effortlessly curated collection! ✨
> We're on a mission to revolutionise how you experience your space.
> It's not just furniture — it's a lifestyle.

Microcopy conventions: buttons are verb phrases (*Discover the collection*,
*Show 42 results*); empty states name the thing that is missing and how it
arrives; errors say what happened and what to do, never apologise twice.

---

## Visual foundations

### Colour

The default theme is **Sumi**: warm paper `#f7f4ee`, sumi ink `#1f1d1a`, *ai*
indigo `#22406b` as the primary accent, *shu* vermillion `#c6472c` as the
secondary, and a sage `#cfd6c8` tint. Never more than two accent colours in a
view, and vermillion appears at most once — it is a seal, not a fill.

Colour is **derived, not enumerated**. A theme declares eight seed values
(`--seed-paper`, `--seed-ink`, `--seed-accent`, `--seed-accent-ink`,
`--seed-accent-2`, `--seed-accent-2-ink`, `--seed-tint`, plus semantics) and
`tokens/colors.css` mixes every ground, surface, ink step, hairline, hover and
tint out of them with `color-mix(in oklab, …)`. Components reference only the
derived tokens — never a seed, never a literal hex.

That is what makes the **thirteen colour schemes** interchangeable. Apply one
with `data-theme` on `<html>` or on any wrapper element:

```html
<html data-theme="setouchi">
<div data-theme="yozora"> … </div>
```

| Theme | Character |
|---|---|
| *(none)* — **Sumi** | Paper, ink, indigo, vermillion. The brand. |
| `kiln` | Full-spectrum earthenware; ten hues, chart-friendly |
| `yozora` | Night sky over the bay — dark |
| `kabuki` | Stage lacquer; loud, high-chroma |
| `setouchi` | Inland sea; cool, calm, very legible |
| `sakura` | Blush and sage; the softest theme |
| `momiji` | Autumn maple on deep slate |
| `shinrin` | Forest bathing; graded greens |
| `kokedama` | Moss under a neon lamp — dark |
| `amezaiku` | Pulled sugar; for youth surfaces |
| `nagisa` | Tideline; citrus paper, one hot signal colour |
| `kitsune` | Fox on oat linen; print-leaning |
| `sugi` | Cedar and mist; nearly monochrome, the quietest |

Colour schemes are a **preview and product-variant mechanism**. A shipped
product picks one and stays there; the `ThemePicker` component is documentation
furniture and must not appear in a product surface.

**Contrast.** `--ink-3` is the secondary-text token — labels, eyebrows,
captions, column headers, list subtitles — all at 10–12px, so it is mixed 70%
toward ink and clears 4.5:1 on `--ground`, `--ground-2`, `--surface` and
`--surface-2` in the default theme. `--ink-4` (55%) is **decorative and
disabled only**: separators, empty slots, spent objectives, glyph hints. Never
set a label or prose in it.

**Tone as text.** The semantic tokens (`--ok`, `--warn`, `--danger`, `--info`,
`--accent-2`) are **fill** colours — bars, rules, dots, borders — where hue
fidelity to your palette matters more than luminance. As 11px type they fail
4.5:1, so anything rendered as text uses the `-text` pair instead:
`--ok-text`, `--warn-text`, `--danger-text`, `--info-text`, `--accent-text`,
`--accent-2-text` — the hue held at 28% over the theme's ink. `Badge`,
`Alert` and `Stat` are wired this way; follow the same split in anything you
add. Measured in the default theme: 8.9–13.7:1 on soft grounds, paper, and
surface alike.

**Known palette limits.** Two things cannot be fixed by derivation, because
they are properties of the supplied palettes rather than of the system:

- *Neutral ramp.* **Kokedama** reaches only 4.6:1 even at `--ink-2`,
  **Shinrin** 4.8:1, **Kiln** and **Sugi** 5.6:1, so their `--ink-3` sits
  under 4.5:1. Promote secondary text to `--ink-2` in those themes.
- *Semantics.* Seven tone/ground pairs still fall short, all but one in
  Kokedama: warn-on-soft 4.45, danger-on-soft 4.30, danger-on-surface 3.65,
  info-on-surface 4.37, accent-2-on-soft 4.30, accent-2-on-surface 3.65; plus
  Shinrin accent-2-on-soft at 4.47.

Both are fixed by darkening the ink seed of the affected palette. I did not do
that silently — they are your colours.

Type over imagery always uses full-opacity ink on a `--scrim-gradient`, never
alpha-muted type on bare photography.

### Type

Three voices, no more.

- **Display — EB Garamond.** Headlines, pull quotes, dialogue, card titles,
  `Stat` values, and *body copy*. Body text in the serif is a deliberate
  choice: it slows reading to the pace the layout implies. Tight tracking
  (`-0.02em`) at display sizes, 1.62 line-height at reading size, 62ch measure.
- **Interface — Outfit.** Buttons, form controls, list rows, nav, captions.
  Weights 200–600; 400 and 500 do almost all the work.
- **Technical — Martian Mono.** Eyebrows, tabular data, keybinds, status bars,
  page numbers. Small and wide-tracked; never used for prose.
- **Japanese set — Shippori Mincho** (`--font-jp`), including vertical
  (`writing-mode: vertical-rl`) settings.

Wide tracking is how small type earns authority here: `0.06em` on button
labels, `0.14em` on field labels, `0.26em` on editorial CTAs. Italic serif
carries emphasis — never bold inside a serif sentence.

### Layout

- Asymmetric editorial grids: an image column that runs past the text block,
  a caption that hangs into the margin, a heading that starts at the second
  column. Symmetry is reserved for the centred statement section.
- Full-bleed image bands alternate with generous paper bands. `--section-y` is
  112px; the paper between sections is content.
- `--measure` 62ch for body, `--measure-tight` 44ch for intros and quotes.
- `--container` 1200px, `--container-narrow` 720px.
- Spacing follows a √2-ish progression (2 · 4 · 6 · 10 · 14 · 20 · 28 · 40 ·
  56 · 80 · 112 · 160) rather than a 4/8 grid, so small gaps stay tight and
  large ones become real silence.
- Fixed elements are rare: a sticky `Navbar`, a mobile `TabBar`, a desktop
  `StatusBar`. No floating action buttons, no sticky sidebars, no cookie bars
  designed as part of the composition.

### Backgrounds, texture and imagery

Grounds are flat, warm and near-white; the only gradients in the system are the
two **protection gradients** used behind type over imagery, both mixed from ink
so they stay warm. There are **no decorative gradients**.

Their alpha is not chosen by eye. It is solved for `--ink-invert` type over
**pure white** — the worst case for this brand's window-light photography —
where 0.64 is the floor for 4.5:1. Both bands hold 0.66–0.74 across the zone
that carries type, then fade to nothing:

- `--scrim-gradient` protects the **bottom**: 74% at the foot, 66% at 56%, clear
  by 72%, so the top quarter of a hero stays open image.
- `--scrim-gradient-top` protects the **top**, painted by `Navbar
  variant="over-image"`. The bar's own height is the band, so type in its
  middle sits on 0.68+.

Measured on the web kit hero over white: nav links and wordmark 5.6:1, headline
4.9–5.9:1, caption 6.4:1. A backdrop blur is **not** protection — it does
nothing for luminance contrast. Never alpha-mute type over an image and hope
the blur carries it.

Texture comes from four CSS-generated motifs that re-colour with the theme:
**seigaiha** (wave scallops), **kōshi** (hairline grid), **kasuri** (fleck) and
**washi** (paper grain), plus a **tatami** band. One motif per view, at low
contrast, never two stacked.

Imagery, when supplied, should read **warm and low-contrast**: window light,
oat and clay, visible grain, shallow depth of field, no cool blue casts and no
heavy saturation. Objects photographed with space around them. Line art is
thin-stroke black on paper — the *sumi* brush register.

### Borders, shadows, corners

- **Hairlines are the structural device.** 1px `--line` for containment, 1px
  `--line-2` for emphasis, 3px `--rule-heavy` for editorial rules. Reach for a
  hairline before a border, and a border before a shadow.
- **Shadows are warm, wide and faint** — mixed from ink, never black, with very
  large blur and 4–18% opacity. The read is sunlight through paper, not float.
  Cards get `--shadow-sm` at most; only overlays get `--shadow-lg`.
- **Corners are square.** Panels, cards, images and tables sit at 0–3px.
  Curvature is reserved for things the hand touches — buttons, chips, tags,
  switches, avatars are pills — and for the single **arch** motif
  (`--radius-arch`), a shoji/torii silhouette used at most once per view.
- Coloured left borders are **off-system**. `Alert` puts its tone rule on top.
- Game panels may clip two opposite corners 10px (`corner="notched"`). That is
  the only cut corner in the system and it does not extend to app UI.

### Transparency and blur

Used only where content sits over live or moving material: game HUD panels
(6–8px blur over a translucent paper or ink ground), the `Dialog` scrim (3px),
and a `Navbar` set `variant="over-image"`. Never on a static page card.

### Motion

Everything glides and settles. `--ease-out` is `cubic-bezier(.16,.84,.28,1)` —
a long settling tail. Durations: 80ms instant, 140ms controls, 220ms surfaces,
380ms sheets, 900ms scroll reveals. **No bounce, no overshoot, no spring.**
Scale changes stay under 2%. `prefers-reduced-motion` zeroes every duration.

- **Hover** shifts ground, not opacity: `--surface-hover` under a row,
  `--accent-hover` (accent mixed 84% toward ink) under a filled button,
  hairline strengthening from `--line` to `--line-strong` on outlines. Cards
  lift 2px and their media scales 1.03 over 620ms.
- **Press** settles: `translateY(0.5px)` plus `scale(0.988)`. Nothing shrinks
  visibly and nothing changes hue.
- **Focus** is a 2px `--focus-ring` box-shadow plus an accent border. Visible,
  never removed.
- **Selected** is `--accent-soft` fill with accent text, or a 2px accent bar on
  the leading edge (`SideNav`) — never a filled pill.

---

## Iconography

**Font Awesome, via the kit `559791bdc6`** — a **Pro** kit, running in SVG
replacement mode (`method: "js"`). Every icon in the system is a Font Awesome
glyph rendered through the `Icon` component. No hand-drawn SVGs, no emoji, no
Unicode characters pressed into service as icons.

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

- **Weights.** `fa-light` is the default and the on-brand choice — its stroke
  matches the hairline language. `fa-thin` is available for oversized display
  glyphs. `fa-solid` is reserved for anything under 14px (checkmarks, status
  carets, active tab-bar icons) and for game HUD readouts where mass is needed.
  `Icon`, `Button` and `IconButton` all default to `light`.
- **On a Free kit, set `weight="solid"`.** Light and Thin do not exist there and
  Free's Regular set is sparse, so `regular` collapses to nothing for most
  glyph names used here.
- **Sizing.** Icons inherit `font-size` and `currentColor` by default. Use
  `fixedWidth` in lists so glyphs align on a 1.25em box.
- **No icon system was supplied in the sources.** Font Awesome is the user's
  explicit choice; it is not a substitution for something that existed.
- **Kit assets are domain-locked.** A Pro kit serves its payload from
  `ka-p.fontawesome.com`, which returns 403 to origins outside the kit's
  allowed-domain list — including sandboxed previews. Every card and UI kit in
  this project therefore also links the public Font Awesome **Free** webfont
  build, and `Icon` picks its family class at runtime: Pro classes while the
  kit is live (detected by SVG replacement or a resolving `fa-light` glyph),
  `fa-solid` for every non-brand weight when it is not. A CSS override cannot
  fix this on its own — Free attaches per-glyph `content` only under the
  families it defines, so a `fa-light` element has no glyph to restyle.
  **Add your production and preview domains to the kit's allowed list and the
  fallback never engages.**
- **Every glyph name in this project resolves under Free as well as Pro.**
  Four Pro-only names were swapped out so the fallback is complete:
  `signal-bars` → `signal`, `grid-2` → `table-cells-large`,
  `candle-holder` → `lightbulb`, `slash-forward` → `slash`. On a Pro kit you
  may prefer the originals; swap them back knowing the Free fallback will show
  a 0×0 box for them.
- **Emoji are never used.** Status is a 5px `Badge` dot or a semantic colour.
- **Japanese glyphs** (和洋, かな) appear as *typography*, set in
  `--font-jp` — as content or as an editorial mark, never as an icon.
- No sprite sheet, icon font of our own, or PNG icons exist in this project.
  `assets/` holds no logo or imagery for the reasons given under *Sources*.

---

## Font substitutions — please confirm

No font binaries were supplied, so these are nearest-match Google Fonts,
loaded by `@import` in `tokens/fonts.css`:

| Role | Substituted with | Notes |
|---|---|---|
| Display serif | **EB Garamond** | Classical, high-contrast, strong italic |
| Interface sans | **Outfit** | Geometric, light weights, wide-tracking-friendly |
| Technical mono | **Martian Mono** | Very wide; used only at 10–12px |
| Japanese serif | **Shippori Mincho** | Mincho companion to the Latin serif |

**If you have licensed faces, send the files** and I will replace the imports
with local `@font-face` rules and re-tune the type scale to their metrics.

---

## Index

### Root

| File | What it is |
|---|---|
| `readme.md` | This document — the design guide |
| `styles.css` | The single stylesheet consumers link; `@import` list only |
| `thumbnail.html` | Homepage tile for this design system |

### Tokens — `tokens/`

`fonts.css` (webfont imports + family tokens) · `palette.css` (the eight
seeds) · `themes.css` (twelve alternate schemes) · `colors.css` (all derived
colour) · `typography.css` (scale + semantic roles) · `spacing.css` (space,
insets, page rhythm, hairline weights) · `radius.css` · `elevation.css`
(shadows, rings, HUD glow) · `motion.css` (durations, curves, press) ·
`pattern.css` (seigaiha, kōshi, kasuri, washi, tatami) · `base.css` (element
defaults and `jp-*` type utilities).

### Components — `components/`

**core/** — `Button`, `IconButton`, `Icon`, `Badge`, `Tag`, `Card`,
`Divider`, `Wordmark`

**forms/** — `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`,
`Switch`, `Slider`

**navigation/** — `Navbar`, `SideNav`, `Tabs`, `Breadcrumb`, `Pagination`,
`Menu`

**feedback/** — `Alert`, `Toast`, `Tooltip`, `Dialog`, `Progress`,
`EmptyState`

**data/** — `Table`, `Stat`, `ListRow`, `Meter`, `Timeline`

**chrome/** (desktop) — `WindowFrame`, `MenuBar`, `Toolbar`, `StatusBar`

**mobile/** — `PhoneFrame`, `AppBar`, `TabBar`, `Sheet`, `Segmented`

**game/** — `GamePanel`, `ResourceMeter`, `Hotbar`, `DialogueBox`, `QuestCard`

**brand/** — `ThemePicker`, `PatternBand`

Each directory holds `<Name>.jsx`, `<Name>.d.ts`, `<Name>.prompt.md` and one
`@dsCard`-tagged HTML specimen.

#### Intentional additions

No source defined a component inventory, so the set above is an authored
standard set. Three entries exist for reasons specific to this brief:

- **`Icon`** — a wrapper over the Font Awesome kit, so no surface hand-rolls
  an `<i class="fa-…">` and weight policy lives in one place.
- **`ThemePicker`** — required by the brief's request for switchable colour
  scheme previews. Documentation surfaces only.
- **`PatternBand`** — exposes the motif tokens as a component so decorative
  bands re-colour with the theme instead of being pasted CSS.

### Guidelines — `guidelines/`

Foundation specimen cards, one concept each, grouped **Colors**, **Type**,
**Spacing** and **Brand** in the Design System tab.

### UI kits — `ui_kits/`

`web/` · `desktop/` · `mobile/` · `game/` · `print/` — each with its own
`README.md`, an interactive `index.html`, and small JSX screens composed from
the components above.

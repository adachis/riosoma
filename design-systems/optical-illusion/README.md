# Optical Illusion — Design System

A high-contrast, op-art design system built for five surfaces at once: web,
desktop apps, mobile apps, game UI, and print. Its premise is that perception
is a material you design with. Contrast, rhythm, and edge behaviour do more
work here than color or ornament, and every component is built so it still
reads when the pattern behind it is trying to move.

**Namespace:** `window.DesignSystem_3b8b2c`
**Global CSS entry:** `styles.css`

---

## 1. Sources

Everything visual here derives from one attached asset pack plus three
published articles on optical effects in design. The pack is a licensed
stock-vector collection of abstract optical-illusion artwork — no brand, no
logo, no product copy, no fonts. There was no codebase, no Figma file, and no
existing component inventory, so the component set below is authored from
scratch against a standard inventory sized to the five target surfaces.

**Attached codebase (read-only mount):** `Optical Illusion/`

| Source folder | What it is | Used for |
| --- | --- | --- |
| `56-illusions-forms-abstract-surrealistic-optical-…/` | 56 concentric-line "forms" (AI/EPS/PDF/JPG/PNG/SVG) | The house motif. Five PNGs copied to `assets/forms/`. |
| `Abstract Optical Illusion Checkerboard/` | Seamless warped checkerboard | `assets/patterns/checkerboard-warp.*` |
| `Optical Geometry/` | Interlocking concentric squares, seamless | `assets/patterns/optical-geometry.*` |
| `diamond-optical-illusion-seamless-pattern-…/` | Seamless diamond illusion | `assets/patterns/diamond-illusion.*` |
| `red-isometric-cube-optical-illusion-…/` | Impossible-cube isometric field | `assets/patterns/isometric-cube.*` |
| `hypnotic-halftone-texture-…/` | 10 halftone concentric-ring textures | `assets/imagery/halftone-*.jpg` |
| `liquid-optical-illusion-backgrounds-…/` | 10 liquid contour backgrounds | `assets/imagery/liquid-*.jpg` — the palette source |
| `PNG/Optical Ripple Lines-0*.png` | Warped line-field ripples | `assets/patterns/ripple-lines-*.png` |

**Reference reading** (informed the principles, not the visuals):
- `https://medium.com/design-bridges/optical-effects-9fca82b4cd9a`
- `https://thenextweb.com/news/how-to-apply-optical-illusions-to-web-ui-design`
- `https://nostalgicdolphin.com/7-optical-illusions-that-every-graphic-designer-should-know/`

**Color scheme variants** were supplied as twelve Coolors palettes and are
implemented verbatim in `tokens/themes.css`. See §6.

### No logo
The sources contain no logo or brand mark, so none was created. Wherever a mark
would go, the system sets the words **OPTICAL ILLUSION** in the display voice —
`font-display`, uppercase, width axis at 118%, tracking `-0.03em`. Do not draw
a mark. If a real one arrives, drop it at `assets/logo.svg` and the project
thumbnail will pick it up.

### Substitutions flagged
- **Fonts.** No binaries were supplied. Substituted from Google Fonts:
  **Archivo** (variable width axis, stands in for a wide grotesque display
  face), **Hanken Grotesk** (body), **Space Mono** (labels and data). Loaded via
  `@import` in `tokens/fonts.css`. **If you have licensed display fonts, send
  them** — the width axis is doing real work and a proper expanded grotesque
  would be better.
- **Icons.** No icon set was supplied. Uses the **Font Awesome kit
  `559791bdc6`** as instructed. See §7.

---

## 2. Content fundamentals

The voice is a museum wall label written by an engineer. Declarative, specific,
unhurried. It states what a thing does and what it does to you, then stops.

**Person.** Second person for instruction ("Hold to confirm"), no person at all
for description ("Contrast rises at the edge"). Never first person. Never "we"
or "our" in product UI; "we" is allowed in marketing body copy only.

**Casing.**
- Display headings: ALL CAPS, always. Short — four words is long.
- Section labels and eyebrows: ALL CAPS, mono, tracking `0.14em`.
- Buttons and menu items: Sentence case. `Send`, `Add layer`, `Discard changes`.
- Body copy and captions: sentence case, full stops on complete sentences,
  none on fragments or captions of three words or fewer.
- Data and numerals: mono, tabular figures, no thousands separators under 10,000.

**Length.** Headline ≤ 4 words. Subhead ≤ 14 words. Button label 1–2 words.
Empty state: one sentence plus one action. Tooltip: a noun phrase, never a
sentence. Error: what happened, then what to do, in that order, both short.

**Emoji.** Never. Not in UI, not in marketing, not in the docs. Status is
carried by a Font Awesome glyph and a color band.

**Numbers and units.** Always paired with a mono unit label at `--size-3xs`,
uppercase, `--text-muted`. `48 / MS`, `12 / PT`, `3 / ACTIVE`.

**Specific examples**

| Slot | Write | Not |
| --- | --- | --- |
| Hero headline | `PERCEPTION IS A MATERIAL` | `We help you design better` |
| Hero subhead | `A contrast system for interfaces that have to hold still while the background moves.` | `Unlock the power of visual perception!` |
| Primary button | `Start a study` | `Get Started Now →` |
| Empty state | `No studies yet. Create one to start collecting responses.` | `Nothing here! 🎉 Let's fix that.` |
| Error | `Upload failed. The file is 24 MB; the limit is 10 MB.` | `Oops, something went wrong.` |
| Tooltip | `Stripe pitch` | `Click here to change the stripe pitch` |
| Loading | `MEASURING` | `Please wait while we work our magic…` |
| Print caption | `Warped checkerboard, 24 pt pitch` | `A cool pattern we made` |
| Game objective | `HOLD THE NORTH GATE` | `Objective: Defend the northern gate area!` |

---

## 3. Visual foundations

### The idea
Two colors and a period. Almost every surface in this system is built from an
ink, a paper, and a repeating interval — `--pitch-hair` through
`--pitch-broad`. Depth comes from interval change, not from shadow or gradient.
A card is not raised by blur; it is raised by a hard offset block of ink.

### Color
Default scheme is **Ink & Signal**, sampled from the liquid contour artwork:
ink `#14161F` (a blue-black, never neutral gray-black), paper `#F2F0E4` (warm,
never white), signal `#F2521E` (a burnt orange, one step off pure red-orange).
Backgrounds are paper or ink; there is no third ground. Signal appears once per
view — one primary action, one active state, one accent rule. The five `--op-*`
band tokens carry patterns, data series, and game UI; they are the only place
more than three colors appear at once.

Never: bluish-purple gradients, aggressive multi-stop background gradients,
cards with a colored left border and nothing else, tinted "glass" everywhere.

### Type
Three voices, no exceptions. Display is Archivo with the width axis pushed to
118% and the tracking pulled to `-0.03em`, always uppercase, often set at
`--leading-flush` (0.86) so lines nearly touch — the stack becomes a shape.
Body is Hanken Grotesk at `--leading-body` (1.55) inside a `66ch` measure.
Labels and all data are Space Mono, uppercase, `0.14em` tracked, at
`--size-3xs`/`--size-2xs`. Mixing display and mono in one line is the system's
signature; body never mixes with either.

### Spacing and layout
4px grid with two deliberate off-grid steps — 6 and 18 — because the stripe
pitches land there. Page gutter 24px, 64px at large. Content max 1240px, wide
max 1600px, 12 columns, 24px gap. Section rhythm is 96/128px vertical, and
sections butt directly against each other with a 2px ink rule rather than
floating in whitespace. Fixed elements: web nav is sticky with a 2px bottom
rule (never a floating pill); app sidebars are fixed-width 264px; mobile tab
bars are fixed; game HUD is anchored to the four corners and never centered.

### Where imagery goes in an app UI
Product surfaces carry the same imagery load as print and game UI; a screen of
flat paper with no optical figure on it is off-brand. The four places it goes:

1. **A pattern band.** A 72px full-width strip of a ripple or contour asset
   under the toolbar or above a page header. No type on it, so no protection
   layer needed — the cheapest way to put the brand on a dense screen.
2. **Plate thumbnails.** Wherever a list or table row names something visual,
   the row leads with a 44–52px generated-pattern swatch at that item's own
   pitch, not initials. Give each row a *different* pattern; two adjacent
   swatches that read alike are worse than none. Note that `.op-moire` has a
   fixed 2/7px period and collapses to plain stripes under ~80px — use
   `.op-concentric` at an 8px pitch for small moire thumbnails.
3. **A patterned header.** Large-title mobile bars and detail heroes sit on a
   corner-origin ring field with `.op-protect-bottom`. The title lands in the
   protected zone; any kicker *above* it needs an `.op-capsule`, because a
   bottom gradient does nothing for type at the top edge.
4. **A form mark.** One concentric form from `assets/forms/` per surface, at
   100–150px, in dead space — a sidebar foot, the end of an account screen, a
   footer. One per view, never scattered.

### Backgrounds
Four legal grounds: flat paper, flat ink, a generated pattern from
`tokens/patterns.css`, or a full-bleed asset from `assets/imagery/`. Generated
patterns are theme-aware and re-tint per scheme. Asset imagery is used
full-bleed only — never as a small decorative tile, never at reduced opacity as
"texture". Repeating patterns are the norm; photography is absent from the
system entirely. Gradients exist for exactly one job: protection layers.

### Transparency and blur
Transparency is used for scrims and protection only, never for decoration.
`--blur-glass` (14px) is permitted on exactly two things: the mobile iOS tab
bar and a menu that overlaps a moving pattern. Everything else is opaque. When
in doubt, use `.op-capsule` — an opaque box with a 2px ink border — instead of
blur.

### Protection gradients vs capsules
Type over a pattern needs one of two treatments, and the choice is mechanical:
- **Protection gradient** (`.op-protect-top` / `.op-protect-bottom` /
  `.op-protect-ink`) when the type sits at an edge of the pattern area.
- **Capsule** (`.op-capsule`) when the type sits in the middle of it, or when
  the pattern pitch is `--pitch-hair` or `--pitch-fine`, where a gradient can't
  win.

Never reduce a pattern's opacity to make type legible. Cover it or move it.

### Borders
Borders are structural, not decorative — this system is border-led, not
shadow-led. `--border-hair` (1px) separates rows inside a container.
`--border-strong` (2px) is the default outline for anything interactive or
containing: buttons, fields, cards, window chrome, HUD panels.
`--border-heavy` (3px) marks a selected or focused container.
`--border-slab` (6px) is reserved for print rules and section dividers.
Border color is `--line-strong` (full ink) — not a tinted gray.

### Shadows
Hard offset only, zero blur, ink-colored, always down-right:
`--shadow-block-xs/sm/md/lg` at 2/3/5/8px. A card carries `sm`; a dialog
carries `lg`; a hovered primary button swaps to `--shadow-block-accent`. Inner
shadow is used only as a 1–2px inset ring (`--shadow-inset-*`) to hold a field
edge. There is exactly one soft shadow, `--shadow-float`, for menus and modals
that must lift off a scrim.

### Corner radii
Default `--radius-2` = **6px**, applied to cards, fields, buttons, and panels.
It reads as a corner that has been cut rather than rounded. `--radius-0` for
print blocks, table cells, and pattern panels. `--radius-1` (2px) for tags and
chips. `--radius-pill` only on toggle tracks, badges, and mobile segmented
controls. `--radius-circle` on avatars and game ability buttons. Never mix two
radii inside one component.

### What a card looks like
`--surface-card` background, `--border-strong` ink outline, `--radius-2`,
`--shadow-block-sm` down-right, `--space-6` (16px) internal padding at small
and `--space-8` (24px) at default. No gradient, no colored border, no
top-accent stripe unless the card is a status card, in which case it gets a
6px full-height band on the left in `--op-1`.

### Animation
Snap in, settle out. `--dur-fast` (140ms) for state changes, `--dur-base`
(220ms) for entrances, `--ease-snap` for almost everything, `--ease-out` for
overlays. Nothing fades in from nothing except a scrim; elements arrive by
moving 4–8px and clipping in. `--ease-overshoot` is permitted **only** in game
UI. The one ambient animation in the system is `.op-drift`, a 24s linear
background-position loop on hero patterns, disabled under
`prefers-reduced-motion`.

### Hover and press
- **Hover:** the element lifts 1px (`--hover-lift`) and its shadow grows one
  step. Fills darken by `--hover-tint` (6%) via `color-mix`. Ghost and text
  buttons gain a 2px ink underline rather than a background.
- **Press:** the element translates +2px down-right (`--press-translate`) so it
  moves *into* its own shadow, and the shadow shrinks to `xs`. Fills darken by
  `--press-tint` (14%). Nothing scales. Nothing bounces.
- **Focus:** `--ring-focus` — a 3px 45%-alpha signal ring, offset 2px. Focus is
  never removed and never replaced with color alone.
- **Disabled:** `--disabled-opacity` 0.42, borders drop to `--line-mid`, cursor
  `not-allowed`, shadow removed entirely.
- **Selected:** border goes to `--border-heavy` and the interior fills with
  `--surface-sunken`; selection is never signaled by color alone.

### Imagery vibe
Vector-flat, high-contrast, warm-neutral. The liquid contour set is ink /
paper / burnt-orange; the halftone and ripple sets are pure black on white with
visible print grain. Nothing is photographic, nothing is soft-focus, nothing is
cool-toned or desaturated-pastel. When an image must be tinted to a scheme, use
`mix-blend-mode: multiply` over an `--op-*` fill rather than a CSS filter.

### The ink ramp is contrast-clamped
`--ink-400` (= `--text-muted`) is not a free visual choice. In every scheme it
is set to the lightest value that still clears 4.5:1 against that scheme's
worst light ground, then `--ink-700/600/500` interpolate evenly between
`--ink-800` (the body-text anchor) and `--ink-400`, so the ramp cannot invert
and `--text-secondary` is always stronger than `--text-muted`. A side effect:
in low-contrast palettes — Deep Mint, Warm Clay, Cobalt Cream, Sage Fog — the
bottom of the ramp is compressed, and secondary sits close to muted. That is
deliberate. Do not "restore" the spread by lightening `--ink-400`.

`--ink-300` is a line and decoration step (`--line-mid`), never text. Nothing
in the system sets type in it.

### Drop caps and columns
Multi-column print flow uses `.oi-columns`; the drop cap is the explicit
`.oi-dropcap` span rather than `::first-letter`, which browsers ignore inside a
multicolumn block. Set it in the display voice at `--size-4xl`, floated left,
line-height 0.78.

### Optical corrections
The reason the system is named what it is. These are non-optional:
- **Overshoot.** Round shapes (circular avatars, dots, game reticles) are drawn
  1.5% larger than the square they sit beside, or they read small.
- **Optical centering.** A single glyph or triangle inside a circle sits
  ~4% right of true center. Play/next icons especially.
- **Cap nudge.** All-caps blocks get `margin-block-start: -0.06em` against a
  baseline; caps have no descenders and otherwise sit low.
- **Light-on-dark shave.** Type set light-on-dark is one weight step lighter
  than the same type dark-on-light; light type on dark ground blooms.
- **Simultaneous contrast.** The same gray reads darker on paper than on ink,
  so `--text-secondary` and `--text-inverse-soft` are separate tokens, not one
  token with opacity.
- **Vertical illusion.** A square is drawn slightly wider than tall (icon boxes
  are 1.02:1) because equal measures read tall.

---

## 4. Foundations reference

| Concern | File |
| --- | --- |
| Webfont loading + substitution note | `tokens/fonts.css` |
| Ink / paper / signal ramps, semantic aliases | `tokens/colors.css` |
| 12 color scheme variants | `tokens/themes.css` |
| Three type voices, scale, optical corrections | `tokens/typography.css` |
| Spacing scale, stripe pitches, chrome heights | `tokens/spacing.css` |
| Radii, borders, block shadows, motion | `tokens/effects.css` |
| Generated + asset-backed pattern system | `tokens/patterns.css` |
| Component class layer (`oi-*`) every primitive renders | `component-styles.css` |

Specimen cards live in `guidelines/` and render in the Design System tab.

---

## 5. Assets

```
assets/
  patterns/    checkerboard-warp · optical-geometry · diamond-illusion ·
               isometric-cube (svg + jpg each) · ripple-lines-01/03/05 (png)
  imagery/     liquid-01 · liquid-02 · liquid-04 · liquid-07 ·
               halftone-01 · halftone-05 (jpg)
  forms/       form-03 · form-08 · form-12 · form-21 · form-27 · form-33 ·
               form-44 · form-50 (png)
```

`forms/` are the concentric-line marks — transparent PNG, pure ink. They are
the closest thing the system has to a brand illustration set and are used as
oversized single elements: one per hero, one per section break, one per slide.
Never scatter several in one view.

`patterns/` SVGs are seamless and tile at any size; the JPGs are the same
artwork rasterised for `background-image` use where an SVG's line weight would
alias.

---

## 6. Color scheme variants

Set `data-theme` on any ancestor element — `<html>`, `<body>`, or a single
`<div>` wrapping one panel. Semantic tokens resolve through the base ramps, so
a scope switch re-tints every component with no code change.

This works because every custom property whose value contains `var()` — the
semantic aliases in `tokens/colors.css`, the block shadows and focus rings in
`tokens/effects.css`, and the pattern defaults in `tokens/patterns.css` — is
declared on `*,*::before,*::after` rather than on `:root`. A property
containing `var()` is substituted at computed-value time on the element
carrying the declaration, so a `:root`-only alias resolves once against
`<html>`'s ramps and descendants inherit an already-resolved color that a
nested `[data-theme]` cannot reach. **If you add a token whose value
references another token, put it in one of those universal blocks, not in
`:root`.** Base ramps and literal values stay on `:root`.

One thing a theme scope cannot do for you: a themed container must also set its
own text color, since `color` is a normal inherited property and an unstyled
child keeps whatever `color` its ancestors resolved. Put `.oi-root` on the
themed element (it sets `background` and `color` together) or set
`color: var(--text-primary)` yourself.

| `data-theme` | Name | Ground | Signal | Muted min | Body min | On-accent | Accent-text |
| --- | --- | --- | --- | --- | --- | --- | --- |
| *(none)* | Ink & Signal | light | `#F2521E` | 4.60 | 13.99 | 5.46 | 4.60 |
| `spectrum-wheel` | Spectrum Wheel | light | `#F94144` | 4.64 | 10.51 | 4.58 | 4.76 |
| `midnight-gold` | Midnight Gold | **dark** | `#FFC300` | 5.19 | 15.00 | 12.50 | 11.97 |
| `electric-violet` | Electric Violet | light | `#FF0054` | 4.64 | 13.81 | 4.67 | 5.11 |
| `signal-flag` | Signal Flag | light | `#E63946` | 4.58 | 10.22 | 4.57 | 5.71 |
| `warm-clay` | Warm Clay | light | `#F28482` | 4.64 | 8.20 | 6.29 | 4.60 |
| `field-slate` | Field Slate | light | `#FE7F2D` | 4.59 | 8.78 | 6.07 | 4.56 |
| `deep-mint` | Deep Mint | light | `#1F6F71` | 4.60 | 6.78 | 5.77 | 7.90 |
| `cyan-ember` | Cyan Ember | **dark** | `#FF5666` | 4.58 | 7.89 | 5.21 | 6.11 |
| `candy-pop` | Candy Pop | light | `#FF70A6` | 4.60 | 13.06 | 6.77 | 4.62 |
| `teal-punch` | Teal Punch | light | `#FF1654` | 4.60 | 10.56 | 4.56 | 5.31 |
| `cobalt-cream` | Cobalt Cream | light | `#F95738` | 4.67 | 7.81 | 4.63 | 4.61 |
| `sage-fog` | Sage Fog | light | `#38795C` | 4.62 | 7.63 | 5.05 | 6.47 |

Every number is a measured WCAG ratio, and every one clears 4.5:1.

- **Muted min** / **Body min** — `--text-muted` / `--text-primary` against the
  *worst* of that scheme's three light grounds (`--surface-card`,
  `--surface-page`, `--surface-sunken`). `--surface-sunken` is almost always
  the tightest, and it is what window status bars and hovered list rows use.
- **On-accent** — `--text-on-accent` on a `--signal` fill: primary buttons,
  accent badges, accent icon buttons, the checked checkbox glyph. Note that
  even `Button size="xl"` is 20px/600, under the large-text threshold, so this
  pair needs the full 4.5:1.
- **Accent-text** — `--text-accent` (= `--signal-text`) as type on the worst
  light ground: caption plate numbers, links, the active mobile tab.

Not in the table but clamped the same way per scheme:
`--status-critical-text` (4.55–4.63), `--status-positive-text` (4.55–5.92),
`--status-caution-text`, `--status-info-text`, and the on-fill pairs
`--text-on-critical` / `--text-on-positive` / `--text-on-caution` /
`--text-on-info` (4.59–12.12 against their own fill).

**Two token families, and the split matters.** `--status-critical` and friends
are *fill* colors — the 6px band on an Alert, a Card's status edge, an invalid
field's border, a progress fill. They are never type. When a status color has
to be read as text, use the `-text` variant; when type sits *on* a status
fill, use the `--text-on-*` variant. Both are computed per scheme, not chosen.
Re-measure all of them if you touch an `--ink-*`, `--paper-*`, `--signal*`,
or `--status-*` value.

Two palettes (`warm-clay`, `candy-pop`, `teal-punch`, `sage-fog`) supplied no
usable ink step and one supplied no saturated accent; those ramps carry
DERIVED neutrals noted inline in `tokens/themes.css`.

**Scheme switching is a preview affordance, not a product feature.** The
`ThemeSwitcher` component and the theme card exist so every scheme can be
inspected; do not ship a scheme picker inside a product UI unless the product
is specifically about themes.

---

## 7. Iconography

**Font Awesome kit `559791bdc6`** is the icon system. Nothing else. Load it
once per document:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

- **Style.** Solid (`fa-solid`) everywhere, on all five surfaces — it holds up
  against a moving pattern where a thin stroke does not. Brands
  (`fa-brands`) for third-party marks. Never mix solid and regular in one row,
  and never carry state on glyph style: an active mobile tab is distinguished
  by color and its label, not by a switch to `fa-regular`.
- **Sizes.** 12 / 14 / 16 / 20 / 24 px, matched to the adjacent type size.
  Icon-only hit targets are `--control-md` (40px) on desktop and `--touch-min`
  (44px) on mobile and game UI.
- **Color.** Icons inherit `currentColor`. An icon is never the only carrier of
  meaning — pair it with a label or a mono status word.
- **Optical alignment.** Inline icons get `--optical-icon-lift` (-0.08em) so
  they sit on the x-height, not the baseline. Triangular glyphs
  (`fa-play`, `fa-caret-right`) inside a circular button shift 4% right.
- **Custom SVG.** Don't. The only vector artwork in the system is the supplied
  pattern and form set in `assets/`.
- **Emoji.** Never used, in any surface.
- **Unicode as icon.** Permitted for exactly two marks: the multiplication sign
  `×` as a close affordance where a Font Awesome load isn't guaranteed, and
  the middle dot `·` as a metadata separator. Nothing else.

The kit is a CDN dependency. Components accept an `icon` prop containing a Font
Awesome class string (`"fa-solid fa-circle-half-stroke"`) and render
`<i className={icon} />`, so a component never hardcodes a glyph. Both the
webfont and the SVG-replacement modes of the kit are supported: every rule that
positions an inline icon targets `i` and `svg`.

**Preview fallback.** A Font Awesome kit is domain-restricted, so on hosts that
are not on the kit's allowlist the glyphs silently fail. Every card, UI kit, and
template in this project therefore loads the kit **and**, after it, the free
Font Awesome 6 CDN stylesheet:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/css/all.min.css">
```

Drop that line in production if the kit's allowlist covers your host. Every
glyph used in this system exists in the free solid set.

---

## 8. Index

**Root**
- `styles.css` — global CSS entry, `@import` list only
- `readme.md` — this file
- `thumbnail.html` — homepage tile
- `component-styles.css` — the `oi-*` class layer every component renders
- `tokens/` — 7 files, see §4
- `assets/` — see §5
- `guidelines/` — foundation specimen cards
- `components/` — reusable primitives, see below
- `ui_kits/` — full-screen product recreations, see below
- `templates/` — copyable starting folders, see below

**Components** (`window.DesignSystem_3b8b2c.<Name>`)

| Group | Components |
| --- | --- |
| `components/core/` | Button, IconButton, Badge, Tag, Card, Divider, Marquee, OpticalSurface |
| `components/forms/` | Input, Textarea, Select, Checkbox, Radio, Switch, Slider |
| `components/navigation/` | NavBar, SideNav, Tabs, Breadcrumb, Pagination, Menu |
| `components/feedback/` | Alert, Toast, Tooltip, ProgressBar, Spinner, Dialog |
| `components/data/` | Table, StatBlock, Avatar, ListRow |
| `components/chrome/` | MacWindow, WindowsWindow, LinuxWindow, WindowToolbar |
| `components/mobile/` | IOSFrame, AndroidFrame, MobileAppBar, MobileTabBar |
| `components/game/` | HUDPanel, HealthBar, AbilityButton, ObjectiveCard, GameMenu |
| `components/print/` | Masthead, PullQuote, CaptionBlock |
| `components/theme/` | ThemeSwitcher |

**Intentional additions** (no source defined a component inventory, so the set
is authored; these are the entries that go beyond a standard web inventory and
exist because the brief names five target surfaces):
- `OpticalSurface`, `Marquee` — the pattern system needs a component wrapper so
  consumers don't hand-write `repeating-linear-gradient`.
- `chrome/*` — desktop window chrome for macOS, Windows, and Linux, including
  document, dialog, and utility window types.
- `mobile/*` — iOS and Android device frames and platform bars.
- `game/*` — HUD, health, ability, objective, and menu primitives.
- `print/*` — masthead, pull quote, and caption blocks for print layout.
- `theme/ThemeSwitcher` — preview-only scheme picker (see §6).

**UI kits**

| Kit | Surface |
| --- | --- |
| `ui_kits/web/` | Marketing site — hero, features, pricing, article |
| `ui_kits/desktop/` | Desktop app — macOS, Windows, and Linux chrome; document, dialog, utility, palette windows |
| `ui_kits/mobile/` | iOS and Android app screens side by side |
| `ui_kits/game/` | In-game HUD, pause menu, loadout screen |
| `ui_kits/print/` | Poster, editorial spread, data sheet |

Each kit is `{README.md, index.html, screen-*.jsx}`. `index.html` is the
interactive shell; the `screen-*.jsx` files are loaded as Babel scripts and
register themselves on `window` (they are deliberately lower-case so the
compiler does not mistake them for components).

**Templates** — starting folders a consuming project can copy. Each is a Design
Component that loads this system through a sibling `ds-base.js`; edit the one
`base` line in that file to point at the bound design-system folder.

| Template | Entry |
| --- | --- |
| Web page | `templates/web-page/WebPage.dc.html` |
| Desktop app | `templates/desktop-app/DesktopApp.dc.html` |
| Mobile screen | `templates/mobile-screen/MobileScreen.dc.html` |
| Game HUD | `templates/game-hud/GameHud.dc.html` |
| Print poster | `templates/print-poster/PrintPoster.dc.html` |

Templates are built from the shipped `oi-*` class layer in
`component-styles.css` rather than the React components, so they paint
immediately and every heading, label, and figure is directly editable.

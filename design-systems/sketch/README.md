# Sketch — Design System

**Sketch is an ink-on-paper interface language.** Every surface is a sheet of warm cream
stock; every edge is a pen line that does not quite close; every piece of tone is hatching
rather than fill. Nothing in it pretends to be manufactured. Corners wobble, boxes sit at
half-degree angles, corrections stay visible, and the moment something is uncertain it is
drawn in pencil instead of ink.

It is built to work at five very different scales without changing its voice: a marketing
site, a desktop application on three operating systems, a phone app on two platforms, a
game HUD, and a printed page. The same tokens, the same components, the same rules.

---

## Sources

This system was derived from reference material supplied by the user. It is an original
system built in the *spirit* of those references, not a copy of any of them; no supplied
image, logo, name, or line of copy is reused, and nothing here identifies a source.

| Source | What was taken from it |
|---|---|
| `https://tiagofragoso.com/` (linked as inspiration) | The overall idea of an interface *drawn by hand*: warm paper ground, ink line-work, hand-lettered display type, torn note scraps, visible strike-through corrections, hand-drawn picture frames and label plates. |
| `uploads/hand-drawn-mobile-website-layout-sketch-...jpg` | Mobile wireframe vocabulary: wobbled screen bezels, hatch-filled bars, cross-boxed image placeholders, drawn tab bars. |
| `uploads/website-sketch-hand-drawn-wireframe-...webp` | Web layout vocabulary: drawn nav bars, card grids, form plates, arrow controls, subscribe blocks. |
| `uploads/set-hand-drawn-graphic-seamless-patterns-...jpg` | The hatching library — 45°, cross-hatch, vertical, dense, dotted — reinterpreted as pure-CSS texture tokens. |
| `uploads/hand-drawn-websites-camellie.jpg`, `uploads/pixelmind.jpg`, `uploads/1_ADZ9qa8vaiLllHFDlLa0EQ.jpg` | Tone and posture: line-art illustration over a flat tinted ground, a single ink weight doing all the work, hand-lettered navigation, drawn signatures and margin notes. |

No codebase, Figma file, or slide deck was supplied. There were therefore no component
definitions to import: the component inventory below was authored from scratch against the
five target surfaces the brief names. No font binaries were supplied either — see
*Type substitutions* under Visual Foundations.

---

## CONTENT FUNDAMENTALS

Sketch copy sounds like a person who draws for a living talking about the work in front of
them. Plain, present tense, slightly dry, willing to admit a thing is unfinished.

**Voice**

- **Second person for instructions, first person for opinions.** "Drop the file here."
  "I'd cut the third column." Never "Users may wish to…".
- **Say what it is, then stop.** One clause is usually enough. "Saved." "Bleed missing."
  "Two layers, one locked."
- **Unfinished is a legitimate state, and it is stated out loud.** "Not decided yet."
  "Draft — numbers not final." "this bit still isn't right." Placeholder copy is written as
  a real human note, not as lorem ipsum.
- **Corrections are shown, not hidden.** Where a word changed, the old one may stay struck
  through with the new one written above it. This is a content pattern, not just a visual one.
- **No hype, no metadiscourse, no "seamless", "delightful", "powerful".** No exclamation
  marks except in an interjection ("Hey.").
- **Numbers are specific.** "3mm bleed", "120gsm", "2,400 copies" — not "high quality stock".

**Casing**

| Where | Rule | Example |
|---|---|---|
| Display headlines | Sentence case | *Ink, then decide* |
| Section eyebrows, field labels, table headers, badges, folios | ALL CAPS, mono, `--ls-caps` | `SECTION 02 — VISUAL FOUNDATIONS` |
| Buttons | Sentence case, verb first | *Send it*, *Discard*, *Keep working* |
| Captions, tooltips, errors, placeholders | lower case, handwritten | *first pass, ink only* |
| Nav items | Sentence case, one word where possible | *About*, *Work*, *Links* |

**Length budgets** — button 1–3 words; badge 1–2; nav item 1; card title ≤ 5; caption ≤ 12;
error one sentence; tooltip ≤ 6 words plus a shortcut.

**Punctuation** — periods on full sentences including single-word confirmations ("Saved.").
No Oxford-comma crusade. En dash with spaces for asides — like this. No emoji, ever: every
glyph in the system is a Font Awesome icon, because emoji render in someone else's style
and this system only has one hand.

**Examples, verbatim from the kit**

> Bleed missing — Add 3mm before sending to press.
> Discard sketch? Three unsaved passes will be lost. This cannot be undone.
> quantities are per signature
> Every line on this thing is a guess.
> untitled sketch

---

## VISUAL FOUNDATIONS

### Colour is scheme-scoped, deliberately

Any token derived from `--accent` (`--surface-accent`, `--text-link`, `--focus-ring`,
`--shadow-accent`, `--hatch-accent`, `--marker`, …) is **re-declared inside every
`[data-palette]` block** in `tokens/palettes.css`, not aliased once on `:root`. A `var()`
inside a custom property resolves on the element where it is *declared*, so an alias that
lived only on `:root` would stay frozen to the default scheme and descendants would inherit
the wrong colour. If you add an accent-derived token, add it to every scheme block — the
generator comment in that file explains the pattern.

### Colour

Ink and paper are constant; only the accent ramp changes. That single decision is what lets
twelve colour schemes ship without twelve design systems.

- **Ink** `--ink-1 #1c1a17` → `--ink-5 #cfc9bd`. Text, strokes, hatching. Pure black is
  never used; `--ink-1` is a warm near-black, the colour of a fibre-tip on cream.
- **Paper** `--paper-1 #e9e4d6` → `--paper-5 #ffffff`. `--paper-3` is the page,
  `--paper-4` is a card, `--paper-5` is a fresh sheet (dialogs, fields, frames).
- **Graphite** `--graphite` is the pencil under-drawing: drafts, placeholders, anything
  non-committal. If it is drawn in pencil, it is not decided.
- **Accent** — one per scheme, exposed as `--accent`, `--accent-deep`, `--accent-soft`,
  `--accent-wash`, `--accent-on`, plus `--highlight` (the marker swipe).
- **Semantics** — `--success --warning --danger --info`, each with `-on` and `-soft`.
  A scheme with no colour in the right hue band falls back to an ink-mixed default, so
  semantics never collapse into the accent.
- **Ramp** — `--c-1` … `--c-10` is the scheme in its published order, for charts and
  category coding. Ten slots always resolve, even in a four-colour scheme.

**The twelve schemes** (`data-palette="…"` on `<body>` or any subtree):

`field-notes` (default) · `crayon-box` · `midnight-gold` · `neon-marker` · `blueprint` ·
`pastel-chalk` · `sea-glass` · `moss-neon` · `bubblegum` · `poster-paint` · `cardstock` ·
`slate-mint`

Pick **one** per product and set it once on `<body>`. Nothing else in a shipped design
should ever change scheme at runtime.

**Previewing the schemes.** `scheme-switcher.js` (project root) is a deliberately plain dev
control — native `<select>`, system mono, flat grey chrome, fixed in the bottom-left corner
and tagged `data-docs-only`. It is built from *none* of this system's tokens or classes,
precisely so it cannot be mistaken for a component and so it is obvious it must be removed
before ship. It reads `?scheme=<id>`, remembers the last pick, exposes
`window.SketchScheme.set(id)`, and steps schemes with the `[` and `]` keys.

```html
<!-- preview only; delete this line to ship -->
<script src="../../scheme-switcher.js" defer></script>
```

All five UI kits load it, so every kit can be viewed in all twelve schemes.
`guidelines/palette-preview.html` shows one screen's worth of components under the live
switch; `guidelines/color-schemes-in-use.html` shows the same controls under all twelve
schemes at once, statically. The `PaletteSwitcher` React component is the same idea for
embedding inside a documentation page — also never product UI.

### Type

Four faces, each with one job. Substituted from Google Fonts (see below).

| Role | Face | Used for |
|---|---|---|
| Display `--font-display` | **Cabin Sketch** 700 | Headlines, wordmark, stat numbers, dialog titles. A sketched outline face — it does the "drawn by hand" work so nothing else has to. |
| Body / UI `--font-ui` | **Shantell Sans** 300–800 | Everything readable: prose, controls, table cells, nav. An ink face regular enough to hold a paragraph. |
| Annotation `--font-hand` | **Caveat** | Margin notes, captions, tooltips, slider read-outs, field placeholders, error messages, game dialogue. Always means "written by a person, later". |
| Label / mono `--font-mono` | **Courier Prime** | Caps labels, eyebrows, table headers, hints, folios, code. |

Scale: `--fs-1` 13 · 15 · 17 · 21 · 27 · 34 · 44 · 58 · `--fs-9` 76px. Odd numbers on
purpose — hand-measured intervals, not a computed ratio. **Do not snap to a 4px grid.**
Composed shorthands (`--type-display`, `--type-body`, `--type-note`, `--type-label`, …) are
what components reference.

Line height: 1.05 display, 1.22 headings, 1.55 body. Letter-spacing: −0.01em on display,
0.14em on mono caps. Measure: 66ch default, 34ch tight, 78ch wide.

**Type substitutions (flagged):** no font binaries were supplied. All four faces are
nearest-match public Google Fonts loaded from the Google CDN in `tokens/fonts.css`.
**If real brand faces exist, send the files and this is a one-file change.**

### Spacing and layout

Fibonacci: `--sp-1` 3 · 5 · 8 · 13 · 21 · 34 · 55 · 89 · `--sp-9` 144px. Card padding is
21, stack gap 13, inline gap 8, section gap 34–55.

Controls: 31 / 41 / 51px (`--control-sm/md/lg`), never below `--touch-min` 44px on touch.
Page max 1180px, gutter 34px, print margin 16mm.

Layout is honest about being a page: content sits in a measured column, headers are sticky
only when the view is a tool (app, editor, game), and nothing floats over content except
dialogs, menus, toasts and the game HUD.

### Backgrounds and texture

Flat cream, plus a barely-visible CSS fibre grain on `<body>` (`--paper-grain`) — two
crossed repeating gradients at 5% ink. **No photographic backgrounds, no gradients as
decoration, no blurred colour blobs.** Where a region needs to read as different stock, it
gets ruled (`--paper-ruled`), gridded (`--paper-grid`) or dotted (`--paper-dots`) paper.

Tone is hatching: `--hatch-45`, `--hatch-135`, `--hatch-cross`, `--hatch-vert`,
`--hatch-dense`, `--hatch-accent`. Hatching means *shaded by hand* and is used for disabled
controls, filled meters, image placeholders and print tint blocks. All of it is pure CSS
gradients — there is no raster texture file in this system.

### The drawn line — borders, corners, shadows

- **Strokes** 1px hairline (table rules) · **1.5px default** (cards, fields) · 2.5px bold
  (buttons, tabs, window chrome) · 4px heavy (dialogs, dialogue boxes, device bezels).
- **Corners wobble.** `--wob-sm/md/lg/xl/pill/circle` each set four different corner arcs
  plus four vertical arcs, which is what makes a CSS box read as drawn. Never write a plain
  `border-radius: 8px`; always use a `--wob-*` token.
- **Shadows are flat ink offsets**, never blurred: `--shadow-1` 2×3px, `--shadow-2` 4×5px
  (default card/button), `--shadow-3` 7×8px (raised/hover), `--shadow-ink` a solid 3×4px
  black offset for primary buttons, `--shadow-inset` for fields and wells.
  There is no soft grey drop shadow anywhere in Sketch.
- **Tilts** `--tilt-a` −0.6° · `--tilt-b` 0.7° · `--tilt-c` −1.4° · `--tilt-d` 1.9°.
  At most two tilted elements per view; a page where everything is crooked reads as broken,
  not as drawn.

### Cards

Paper `--paper-4`, 1.5px ink border, `--wob-md` corners, `--shadow-2`, 21px padding, header
separated by a solid ink rule and footer by a hairline. Variants: `flat` (no shadow, for
grids), `raised`, `sunken` (inset well), `draft` (dashed pencil, no shadow, transparent —
the standard way to show unfinished content), `accent` (accent wash). Interactive cards lift
and tilt on hover.

### Transparency and blur

Almost never. Three sanctioned uses: the dialog scrim (42% ink + 1.5px blur, just enough to
push the page back), the game HUD (`--paper-a90` paper at 92% or ink at 82% so gameplay
stays readable), and `--paper-a90` label plates over hatched artwork. No frosted-glass
panels, no translucent nav bars.

### Motion

Nothing glides. Things are **placed**, **nudged**, or **pressed**.

- Durations 80 / 130 / 190 / 320ms. Anything longer is wrong.
- `--ease-ink` is the default; `--ease-settle` (overshoot) is the signature — used by
  anything that appears: toasts, menus, dialogs, the checkbox tick.
- **Hover** = `translate(-1px,-2px)` and a bigger flat shadow — the sheet lifts off the desk.
  Ghost buttons and links instead gain a wavy underline. Never a colour fade alone.
- **Press** = `translate(1px,2px)` and the shadow collapses to `--shadow-press` — pushed
  into the desk. Nothing scales down.
- **Focus** = `--focus-ring`, a paper gap then a 4px accent loop drawn around the element.
- **Disabled** = hatched fill, `--ink-4` border, no shadow, no transform. Never a low
  opacity: a faded control looks like bad printing, a hatched one looks struck out.
- `prefers-reduced-motion` zeroes every duration and both offsets.

### Imagery

There is none supplied, and the system is designed to be honest about that: `Frame` with no
`src` renders a cross-hatched box with a caps label, and that is a finished-looking state.
When real imagery arrives it goes inside a `Frame` — warm, slightly desaturated, never
bled off the edge of a card, always with a handwritten caption.

---

## ICONOGRAPHY

**All icons are Font Awesome, from the project kit. There are no icon files in this repo
and no hand-rolled SVGs anywhere in the system.**

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

- Load the kit **once per page**, in `<head>`. Every card, UI kit and template in this
  project already does.
- Render through the `Icon` component (`components/media/Icon.jsx`), or write
  `<i class="fa-solid fa-pen-nib">` directly in plain HTML.
- **Family:** `fa-solid` at UI sizes (15–21px) — it holds up against a 1.5px ink border.
  `fa-regular` for decorative glyphs at 27px and above, where the thinner line reads closer
  to pen. `fa-brands` for third-party marks. If the kit is upgraded to Pro, `fa-thin` at
  large sizes is the best match for the brand line and should be preferred.
- **Boxed glyphs** (`<Icon boxed>`) put the glyph in a wobbled box — used for alert icons,
  toolbar affordances and empty-state marks.
- **Recurring glyph set** (use these before inventing others): `pen-nib` (draw / create),
  `pencil` (edit), `eraser`, `ruler-combined` / `compass-drafting` (layout), `scissors`
  (crop, trim), `paperclip` (attach), `stamp` (approve), `layer-group` (layers),
  `bezier-curve` (paths), `crop-simple`, `printer`, `palette` (colour scheme), `file-lines`,
  `folder-open`, `image`, `magnifying-glass`, `xmark` (close), `check` (confirm),
  `chevron-down` (select), `arrow-left` / `arrow-right` (paging), `ellipsis` (more),
  `triangle-exclamation`, `circle-info`, `circle-exclamation`, `trash`, `rotate-left` (undo),
  `user` / `user-secret` (avatar fallbacks), `signal` / `wifi` / `battery-three-quarters`
  (device status bars), `caret-down` (dialogue advance).
- **No emoji.** No Unicode pictographs as icons. The two Unicode characters the system does
  use as *typography* are the ellipsis in a pager (…) and the multiplication sign in an
  inventory quantity (×2).
- **Substitution note:** the references contain no icon set at all, so Font Awesome is the
  user's own choice rather than a match to a source. Icon *line weight* is therefore heavier
  than the surrounding ink work; this is accepted deliberately so glyphs stay legible at
  15px, and is the one place the system's line is not hand-drawn.

---

## Index

### Root
| File | What it is |
|---|---|
| `readme.md` | This file — context, sources, content, visual foundations, iconography, index. |
| `styles.css` | The single stylesheet consumers link. `@import` list only. |
| `thumbnail.html` | Homepage tile for the design system. |
| `scheme-switcher.js` | Preview-only colour-scheme control. Not part of any design — delete the script tag before ship. |
| `tokens/` | `fonts.css`, `colors.css`, `palettes.css`, `typography.css`, `spacing.css`, `lines.css`, `textures.css`, `motion.css`, `semantic.css`, `base.css`, plus `palettes.json` (the twelve schemes as data). |
| `components/components.css` | The class layer (`.sk-*`) behind every component; usable in plain HTML. |
| `guidelines/` | 23 foundation specimen cards + `palette-preview.html`. |
| `assets/README.md` | Why there is no logo file, and what to do instead. |
| `ui_kits/` | Five product recreations — web, desktop, mobile, game, print. |

### Components (45 exports, 11 directories)

- **`components/core/`** — `Button`, `IconButton`, `Input`, `Textarea`, `Select`,
  `Checkbox`, `Radio`, `RadioGroup`, `Switch`, `Slider`
- **`components/surfaces/`** — `Card`, `Panel`, `TornNote`, `Divider`, `Frame`
- **`components/feedback/`** — `Badge`, `Tag`, `Alert`, `Toast`, `ToastStack`, `Tooltip`,
  `ProgressBar`, `Spinner`
- **`components/navigation/`** — `NavBar`, `Tabs`, `Breadcrumb`, `Pagination`, `Menu`
- **`components/data/`** — `Table`, `DefinitionList`, `Stat`, `Avatar`, `AvatarStack`
- **`components/overlay/`** — `Dialog`
- **`components/media/`** — `Icon`, `Hatch`
- **`components/chrome/`** — `WindowFrame` (mac / Windows / Linux), `DeviceFrame` (iOS / Android)
- **`components/game/`** — `HUDPanel`, `MeterBar`, `DialogueBox`, `InventorySlot`
- **`components/print/`** — `PrintSheet`
- **`components/utility/`** — `PaletteSwitcher`, `SKETCH_PALETTES` *(documentation only)*

Each directory has one `@dsCard` HTML showing its states, and each component has a
`.d.ts` props contract and a `.prompt.md` usage note.

**Intentional additions.** No source defined a component inventory, so the whole set is
authored. Three families exist because the brief names surfaces that need them, and are
called out so nobody mistakes them for source-derived primitives: `Icon`/`Hatch` (a wrapper
for the Font Awesome kit and the hatching tokens), `WindowFrame`/`DeviceFrame` (desktop and
mobile chrome), and `HUDPanel`/`MeterBar`/`DialogueBox`/`InventorySlot` + `PrintSheet`
(game and print surfaces).

### UI kits
| Kit | What it shows |
|---|---|
| `ui_kits/web/` | Marketing site: hero, work grid, about, contact, footer — click-through. |
| `ui_kits/desktop/` | A drawing app in mac, Windows and Linux window chrome, with menus, palettes, dialogs. |
| `ui_kits/mobile/` | The same app on iOS and Android: list, detail, compose, settings. |
| `ui_kits/game/` | Point-and-click adventure UI: HUD, dialogue, inventory, pause menu. |
| `ui_kits/print/` | Editorial spread, poster and business card at real paper sizes. |

### Guidelines
Colour (ink, paper, accent, semantics, all twelve schemes, schemes in use), Type (four
faces, scale, composed roles), Spacing (scale, in use, control heights), Brand (wordmark,
wobbled corners, stroke weights, shadows, paper & hatching, interaction states, tilts).

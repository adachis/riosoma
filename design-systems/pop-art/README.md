# Pop Art — Design System

A print-first visual system built on the language of 1960s pop art and newsstand comics:
black ink outlines, flat unmixed colour, ben-day dot screens, sunburst rays, hard offset
shadows that read as a mis-registered press plate, and drawn display lettering that shouts.

It is a **generic, brand-agnostic system**. It carries no company identity — no logo, no
product name, no proprietary copy. "Pop Art" is the name of the system itself. It is
designed to be applied to any product across five surfaces:

| Surface | UI kit |
| --- | --- |
| Web pages (marketing, editorial, commerce) | `ui_kits/web/` |
| Desktop apps — macOS, Windows, Linux window chrome | `ui_kits/desktop/` |
| Mobile apps — iOS and Android | `ui_kits/mobile/` |
| Video game UI / HUD | `ui_kits/game/` |
| Print design and layout | `ui_kits/print/` |

---

## Sources

Everything in this system was derived from material the user supplied. Nothing was copied
from, and nothing identifies, any of the referenced works.

**Attached local codebase — `Pop Art Assets/`** (a licensed graphic-asset and font library,
mounted read-only). Used for: the display typefaces, the comic vector elements, and the
halftone/sunburst background plates. Files actually copied into this project are listed in
`assets/` below. The library also contains large sets of `.eps`/`.ai` artwork and
illustrated character clipart that were **not** copied — they are figurative illustration
rather than system assets.

**Uploaded reference images — `uploads/`** (30 files: comic-panel artwork, pop-art poster
frames, halftone portrait effects, a pop-art website concept, WPAP-style vector portraits).
Read as visual direction only. Per the brief, **none of them are used in the system** and
none of their branding, names or copy appears anywhere.

**CSS techniques studied** (linked by the user, used as technique reference only):
- `https://codepen.io/franquicio/pen/OJXwRVo`
- `https://dev.to/alexandrevacassin/warholizer-ee0` — the single-colour "plate" filters in
  `tokens/utilities.css` (`.pop-plate-*`) follow this grayscale → contrast → sepia →
  saturate → hue-rotate approach.

**Iconography** — Font Awesome, user's own kit `559791bdc6`:
`<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>`

**No logo was supplied, so none was created.** Wherever a mark would go, the system sets the
product name in the brush display face (`--font-display`) — see `Navbar`'s `brand` prop and
`thumbnail.html`. Do not draw one.

---

## Content fundamentals

**The voice is a newsstand barker with a straight face.** Display type shouts; body copy is
plain, short and factual. The contrast between the two is the whole effect — if the body
copy also shouts, nothing lands.

- **Display / headline copy**: 1–4 words, always uppercase, always an event.
  `WOW!` · `KAPOW!` · `SOLD OUT` · `LATE EDITION` · `ONE NIGHT ONLY`
- **Sub-lines and section heads**: sentence case, 4–10 words, concrete.
  "Four colours, one plate at a time." · "Everybody's a critic."
- **Body copy**: plain declaratives, 8–18 words a sentence, no hedging and no metadiscourse.
  "Flat rate, everywhere." · "Miss one pass and the whole run's scrap."
- **Labels, kickers, table heads**: uppercase, condensed newsprint face, 1–3 words.
  `ISSUE 04` · `ON PRESS` · `PLATE` · `MEANWHILE`
- **Marginalia, captions, figures, small print**: monospace, often numbered.
  `Fig. 4 — Magenta plate, second pass. Registration off by 2mm.`
- **Buttons**: uppercase, imperative, 1–3 words. `GET IT NOW` · `READ MORE` · `KEEP IT`
- **Empty and error states**: state the fact, then the way out. No apology paragraphs.
  "No panels yet. Your first panel shows up here."

**Person**: address the reader as *you*; the product speaks as *we* only when it must own an
action ("We only send the good stuff."). Never first-person singular.

**Casing**: uppercase is a design tool, not an emphasis tool — it belongs to display faces,
kickers and buttons. Never uppercase a full sentence of body copy.

**Punctuation**: exclamation marks are permitted, but only inside display type and bursts —
one per view. Body copy takes a full stop. No ellipses as a mood device. Em dashes sparingly.

**Emoji: never.** The icon language is Font Awesome; the exclamation language is the burst
and the speech bubble. Emoji undercut both.

**Numbers** are always figures, always in the monospace face when they sit next to text
(`$18`, `128,400`, `12:04`, `#0412`).

---

## Visual foundations

### Colour
Flat, unmixed, and few. A view uses **ink + paper + one accent + one supporting accent** —
no more. There are no soft gradients anywhere in the system; the only "blends" are the
patterns (dots, rays, stripes), which are hard-edged.

- `--ink` (#0E0E0E in the signature theme) draws every outline in the system. It is a
  constant, not decoration.
- `--paper` is warm newsprint stock (#FFF6E5), not white. `--panel` (#FFFFFF) is the
  brighter card surface that sits on top of it.
- Accents are press plates: red, cyan, yellow, magenta, violet. Each ships with its own
  `--on-accent-*` text colour so contrast holds when themes swap.
- **Imagery is never full-colour.** Photographs run through a single-plate filter
  (`.pop-plate-red`, `.pop-plate-cyan`, …) with a dot screen multiplied over them
  (`.pop-screened`). Colour vibe: hot, high-contrast, slightly dirty — warm reds and
  yellows against cold cyan, never pastel unless the palette is (`sherbet`, `sage`).
- Repeat-portrait grids (`.pop-quad`) put four different plates on the same image.

### Type
Four jobs, four kinds of face:
- **Display** (`--font-display`, brush comic caps): hero words only, 1–4 words.
- **Headline** (`--font-headline`, fat slab): section heads and sub-lines.
- **Newsprint / marquee** (`--font-newsprint`, `--font-marquee`): kickers, table heads,
  window titles, poster lockups.
- **Text** (`--font-ui` / `--font-body`, Chivo): every functional string. Weight 900 for
  controls, 400 for prose.
- **Mono** (`--font-mono`, Courier Prime): captions, figures, IDs, times, small print.

Display type is tracked tight (`--tracking-display` −0.02em) and set to `--leading-tight`
0.92. Kickers are tracked wide (`--tracking-caps` 0.14em). Body copy sits at 1.45.

### Spacing and layout
4px base, 13 steps. Panels are gutter-generous: the signature layout device is
`.pop-page` — a grid of outlined panels on a **black plate** with a 12px white/ink gutter
between them, exactly like a comic page. Content columns cap at
`--container-lg` 1140px / `--container-xl` 1360px. Page padding is fluid:
`--page-pad: clamp(20px,5vw,64px)`.

Fixed elements: sticky top bars (`Navbar sticky`), fixed phone status bar and tab bar,
absolutely-positioned HUD panels in game views. Everything else scrolls.

### Backgrounds
Never a photographic hero behind text without a plate and a screen. The four legitimate
grounds are:
1. flat accent fill,
2. ben-day dots (`.pop-benday`, `.pop-benday-fine`, `.pop-benday-coarse`),
3. sunburst rays (`.pop-rays`, `.pop-rays-tight`),
4. diagonal stripes (`.pop-stripes`).

Set the fill with `background-color`, never the `background` shorthand: the `.pop-*`
pattern classes carry only `background-image`, and a shorthand — especially an inline one —
resets it to `none`.

Bitmap halftone and ray plates ship in `assets/backgrounds/` for full-bleed use.
No gradient meshes, no blurred colour washes, no noise overlays other than the dot screen.

### Borders, corners, cards
- Outlines: 2px (small chips), 3px (default), 4px (large controls, windows, HUD),
  6px (posters), 10px (device bezels, pull-quote rules).
- Radii: **panels, tables and comic frames are square (0)**. Inputs 4px, buttons 8px, soft
  cards 14px, tags/avatars/switches pill, speech bubbles `26px 26px 26px 6px`.
- A card is: `--panel` fill, 3px ink border, `--shadow-md` (5px 5px 0 ink), square corners,
  optional screened media plate along the top edge, optional sunk footer strip.

### Shadows
**No blur, ever.** Shadows are hard offset copies of the shape in ink — a plate that didn't
register. The ladder is 2 / 3 / 5 / 8 / 12px. Two special cases:
- `--shadow-misprint` — cyan at 4px, magenta at 8px. One per view.
- `--shadow-inset` — a 4px inner darkening at the bottom edge, for pressed/sunk surfaces.

There is exactly one soft-edge effect in the system and it is `--shadow-inset`. Everything
else is hard.

### Type on a patterned ground
A ray or dot ground shows **two** colours — the fill and the pattern colour — so text on it
must be legible against both. In practice that means `--ink`, which clears 4.5:1 on every
accent in every palette. Display type is the one exception: it may be knockout `--paper`
**only** with a 4px+ ink stroke (`paint-order: stroke fill`), which is what carries the
lockup. Never put `--on-accent` white or `--paper` small type on a pattern —
`PosterBlock` enforces this by switching `sub` and `footer` to ink whenever `pattern` is set.

### Transparency and blur
Almost never. The only sanctioned transparency is the modal scrim —
`color-mix(in srgb, var(--ink) 62%, transparent)` **with a dot screen over it**, so even the
scrim reads as printed. No `backdrop-filter`, no frosted glass, no protection gradients over
imagery: if text needs to sit on an image, put it in a bubble, a caption box or a knockout
lockup with an ink stroke — a capsule, never a gradient.

### Animation and interaction
Motion is mechanical, short and physical. Nothing eases gently.
- Durations: 80 / 120 / 200 / 340ms. Anything longer feels wrong.
- Easing: `--ease-pop` `cubic-bezier(.2,1.5,.35,1)` — a small overshoot, like a stamp
  bouncing; `--ease-slam` for the return.
- **Hover**: the object *lifts* — `translate(-2px,-2px)` and the shadow grows one step.
  Never an opacity fade, never a colour lightening.
- **Press**: the object *slams* — `translate(2px,2px)` and the shadow collapses to 1px.
- **Entrance**: `pop-in` — scale 0.7 → 1.06 → 1 with a −6° rotate. Toasts, modals, bursts.
- **Attention**: `pop-shake`, two 260ms cycles. Errors only.
- Both live in `.pop-press` / `.pop-anim-in`; `prefers-reduced-motion` disables them.

### Focus
4px solid `--focus-ring` outline at 2px offset. It is deliberately loud — this system has
no subtle states.

---

## Iconography

- **Font Awesome 6** via the user's kit `559791bdc6`. Load it once per page:
  `<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>`
- **Solid** (`fa-solid`) is the default weight — its heavy, closed forms match the ink
  outlines. `fa-regular` is permitted only for unselected/empty states (empty star, empty
  heart, unchecked square).
- Icons are passed as class strings, never as inline SVG:
  `<Button icon="fa-solid fa-bolt">`, `<IconButton icon="fa-solid fa-xmark" label="Close" />`.
- Sizes: 13px inside chips, 18–21px in toolbars and lists, 32px in `EmptyState` medallions,
  ~0.42× the button diameter in `IconButton`.
- Icons frequently sit inside an **ink chip** — a 26–52px square or circle with a 2–3px ink
  border and an accent fill. That chip, not the glyph, is the brand gesture.
- **No hand-drawn SVG icons.** No emoji. No Unicode dingbats as icons.
- The system also ships **licensed comic vector elements** (speech bubbles, burst words,
  lightning bolts, arrows, hearts, shock lines) in `assets/elements/`. These are *artwork*,
  not icons — use them at 60px and up, as decoration or lettering, never as a control glyph.

---

## Colour scheme variants

13 palettes ship with the system: the signature press palette on `:root`, plus 12 supplied
schemes. Every component reads only role tokens, so switching a palette is one attribute:

```html
<html data-theme="voltage">        <!-- whole document -->
<div data-theme="midnight"> … </div>  <!-- any subtree -->
```

`signature` · `spectrum` · `midnight`* · `voltage` · `newsprint` · `sherbet` · `dockside` ·
`mint` · `jungle`* · `bubblegum` · `lagoon` · `pressroom` · `sage`

\* `midnight` and `jungle` are dark schemes — they override `--paper`/`--panel` to dark
values and flip `--text-body` to a light ink. Everything else keeps a light stock.

Where a supplied palette has no hue for a semantic role (most have no green), the semantic
token falls back to a tuned colour of the right hue at the palette's saturation — noted in
`tokens/themes.css` per theme. `--ink` also varies: several palettes use their own darkest
colour as the outline ink rather than near-black.

Preview them with the `ThemeSwitcher` component, the **Palette variants** card in the
Design System tab, or the switcher built into every UI kit's `index.html`.
`ThemeSwitcher` is a documentation control — do not ship it inside a product UI.

---

## Index

**Root**
- `styles.css` — the single entry point consumers link. `@import` list only.
- `readme.md` — this file.
- `thumbnail.html` — homepage tile.

**`tokens/`** — `fonts.css` (@font-face + Google Fonts), `colors.css` (signature roles),
`themes.css` (12 palette variants), `typography.css`, `spacing.css`, `effects.css`
(borders, hard shadows, print patterns, motion), `base.css` (element defaults),
`utilities.css` (the `.pop-*` effect classes).

**`assets/`**
- `fonts/` — 12 licensed display faces (`.otf`), copied from the attached library.
- `elements/` — comic vector elements: speech bubbles (speech, blue, shock white, shock
  yellow, heart thought, splash), burst words (wow, boom, omg, cool, love), lightning
  (yellow/blue/pink), arrows (red/blue/yellow), hearts, shock lines, bomb, music note,
  `burst-star.svg`.
- `backgrounds/` — `halftone-{yellow,pink,blue,green}.jpg`, `rays-{yellow,pink,blue}.jpg`.

**`guidelines/`** — 21 foundation specimen cards feeding the Design System tab, grouped
Colors / Type / Spacing / Brand.

**`components/`** — 53 components in 9 groups. Each has `<Name>.jsx`, `<Name>.d.ts` and
`<Name>.prompt.md`; each directory has one `@dsCard` HTML.

- `core/` — **Button, IconButton, Badge, Tag, Card, Panel, SpeechBubble, Burst, Avatar,
  Divider, DisplayText**
- `forms/` — **Field, Input, Textarea, Select, Checkbox, Radio, Switch, Slider,
  SegmentedControl**
- `feedback/` — **Alert, Toast, Modal, Tooltip, ProgressBar, EmptyState, Spinner**
- `navigation/` — **Navbar, Tabs, Breadcrumb, Pagination, SideNav, Stepper**
- `data/` — **DataTable, StatTile, ListRow, Accordion**
- `chrome/` — **WindowFrame, PhoneFrame, MobileStatusBar, AppBar, TabBar**
- `game/` — **MeterBar, HudPanel, AbilityButton, DialogueBox, ScoreTicker**
- `print/` — **ComicPanel, PosterBlock, PullQuote, CaptionStrip, PriceFlag**
- `theme/` — **ThemeSwitcher** (+ the `POP_THEMES` list)

**`ui_kits/`** — `web/`, `desktop/`, `mobile/`, `game/`, `print/`. Each has an
`index.html` that runs as an interactive click-through, a `README.md`, and one `.jsx` per
screen.

**`templates/`** — copy-and-go starting folders for consuming projects. Each has its own
`ds-base.js` (one line to repoint at a bound design system) and loads the Font Awesome kit.
- `poster/Poster.dc.html` — US Letter pop-art poster. Tweaks: palette, burst size, burst tilt.
- `landing-page/LandingPage.dc.html` — full marketing page. Tweak: palette.

### Intentional additions

No source defined a component inventory (the attached library is graphic assets and fonts,
not a component library), so the standard set was authored from scratch and sized to the
five target surfaces (53 components across 9 groups). Three groups exist specifically because the brief named those
surfaces: `chrome/` (desktop window types for macOS/Windows/Linux plus iOS/Android
shells), `game/` (HUD primitives), `print/` (comic panel, poster, editorial). `theme/`
holds the palette-preview control the brief asked for.

### Known substitutions

- **Text and slab faces come from Google Fonts** — Alfa Slab One (headline), Chivo (UI and
  body), Courier Prime (mono). The attached library contains only display/novelty faces,
  none of which is usable at body sizes. If you have licensed text faces you would rather
  use, drop them in `assets/fonts/` and repoint `--font-headline` / `--font-ui` /
  `--font-mono` in `tokens/typography.css`.
- Display faces ship as `.otf` (not subset `.woff2`), as supplied. They are 30–120KB each
  and only `--font-display`, `--font-headline` and `--font-newsprint` are needed on a
  typical page; the rest are opt-in.

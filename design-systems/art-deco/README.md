# Art Deco — design system

A complete interface system built on the visual language of Art Deco: geometric display
type at wide tracking, near-black lacquer grounds, brass hairlines, stepped and
chamfered silhouettes, sunburst and fan ornament, and hard cast shadows. It is designed
to be applied to five very different surfaces without changing its mind: **web pages,
desktop applications (macOS / Windows / Linux), mobile apps (iOS / Android), video-game
UI, and print**.

The system carries **thirteen colour schemes**. Every component, every ornament and
every screen re-themes from one attribute: `data-ad-theme="cabaret"`.

---

## Sources

Everything here was derived from material the client supplied. Nothing was copied from
it, and no supplied image, logo, wordmark or copy appears in the system.

| Source | What it was | How it was used |
|---|---|---|
| `Art Deco Assets/` (attached local folder) | ~1,540 files: 18 licensed Art Deco display typefaces (OTF/TTF), gilt frame sets, ziggurat corner clipart, sunburst and star SVGs, vintage badge PNGs, seamless fan/shell and pastel geometric patterns, stained-glass panel renders, sequin "glam" textures | Fonts copied into `assets/fonts/` and declared in `tokens/fonts.css`. A curated ornament, pattern and texture set copied into `assets/`. Everything else left in place. |
| 23 reference images (`uploads/`) | Art Deco web-design screenshots, a game-UI asset sheet, a game HUD screenshot, a game-concept skill tree, poster reproductions, seamless-pattern product shots, museum-site mock-ups | Read for visual grammar only — composition, ornament placement, tracking, HUD structure, elevation behaviour. **No reference image is used in the system and no source brand, name, wordmark or copy is reproduced.** |
| Font Awesome Kit `559791bdc6` | The client's own icon kit | The system's only glyph set. See ICONOGRAPHY. |
| Twelve `coolors.co` palettes | Client-specified colour schemes | Implemented verbatim as twelve of the thirteen themes in `tokens/themes.css`. |

**There is no logo.** The sources contained no brand mark, so none was invented. Wherever
a mark would go the system sets the product name in the display face at 0.3em tracking
(see `NavBar`'s `mark` prop, and `thumbnail.html`). Do not draw one.

Demo product names inside the UI kits — *Meridian*, *Atelier*, *Vesper*, *The Gilded
Circuit* — are neutral placeholders invented for the kits. They are not a brand.

---

## Index

**Foundations**
- `styles.css` — the single entry point. Import lines only; consumers link this one file.
- `tokens/` — `fonts.css`, `colors.css`, `themes.css`, `typography.css`, `spacing.css`,
  `geometry.css`, `elevation.css`, `motion.css`
- `css/` — `base.css`, `ornament.css`, `buttons.css`, `forms.css`, `surfaces.css`,
  `navigation.css`, `feedback.css`, `chrome.css`, `game.css`, `mobile.css`, `print.css`
- `guidelines/` — 24 specimen cards (Type, Colors, Spacing, Motifs), including `themes.html` — all thirteen palettes with a live component sample each
- `assets/` — `fonts/`, `ornaments/`, `patterns/`, `textures/`, `stained-glass/`,
  `badges/`, `motifs/`, `icons/README.md`

**UI kits** — one per application surface
- `ui_kits/web/` — *Meridian*, a public arts-venue website (4 screens)
- `ui_kits/desktop/` — *Atelier*, one app in macOS, Windows and Linux chrome
- `ui_kits/mobile/` — *Vesper*, an iOS and Android companion app (5 screens, both platforms)
- `ui_kits/game/` — *The Gilded Circuit*, six game-UI scenes
- `ui_kits/print/` — poster, programme spread, invitation, gallery label, ticket stub

**Other**
- `thumbnail.html` — the project tile
- `assets/icons/README.md` — the Font Awesome contract

---

## Components

48 components in nine groups. Each has a sibling `.d.ts` (props contract) and
`.prompt.md` (one-line "what & when", usage example, variant notes).

**`components/core/`** — `Icon` · `Button` · `IconButton` · `Badge` · `Tag` · `Rule` ·
`Eyebrow` · `SectionHeading`

**`components/forms/`** — `Field` · `Input` · `Textarea` · `Select` · `Checkbox` ·
`Radio` · `Switch` · `Slider`

**`components/surfaces/`** — `Card` · `Panel` · `OrnamentFrame` · `StatBlock` · `DataTable`

**`components/navigation/`** — `NavBar` · `Tabs` · `Menu` · `Breadcrumb` · `Sidebar`
(`Menu.jsx` also exports `MenuItem`, `MenuSeparator`, `MenuLabel`)

**`components/feedback/`** — `Dialog` · `Toast` · `Tooltip` · `ProgressBar` · `EmptyState`

**`components/chrome/`** — `MacWindow` · `WindowsWindow` · `LinuxWindow`

**`components/game/`** — `GameMenu` · `HudMeter` · `ResourceReadout` · `ItemSlot` ·
`KeyPrompt` · `SkillNode` · `DialogueBox`

**`components/mobile/`** — `PhoneFrame` · `StatusBar` · `AppBar` · `TabBar` · `ListRow` ·
`Segmented`

**`components/theme/`** — `ThemeSwitcher` (also exports `AD_THEMES`)

### Intentional additions

No component library was supplied, so the standard set was authored (Button, IconButton,
Input, Select, Checkbox, Radio, Switch, Card, Badge, Tag, Tabs, Dialog, Toast, Tooltip)
and extended only where one of the five required surfaces demanded it:

| Addition | Why |
|---|---|
| `Icon` | Wrapper over the client's Font Awesome kit, so no screen hand-rolls an `<i>` |
| `Rule`, `Eyebrow`, `SectionHeading` | Deco carries hierarchy in rules and micro-caps, not in font weight; these three are used more than any heading tag |
| `Panel`, `OrnamentFrame`, `StatBlock`, `DataTable` | App regions, the licensed gilt frames, and figure/table display |
| `Field`, `Textarea`, `Slider` | Form completeness; `Slider` is required by desktop preferences and game options |
| `Menu`, `Breadcrumb`, `Sidebar` | Desktop and web navigation |
| `ProgressBar`, `EmptyState` | App states |
| `MacWindow`, `WindowsWindow`, `LinuxWindow` | The three desktop window chromes the brief asked for |
| `GameMenu`, `HudMeter`, `ResourceReadout`, `ItemSlot`, `KeyPrompt`, `SkillNode`, `DialogueBox` | Game UI |
| `PhoneFrame`, `StatusBar`, `AppBar`, `TabBar`, `ListRow`, `Segmented` | iOS/Android shells and touch lists |
| `ThemeSwitcher` | Documentation affordance for browsing the thirteen palettes. **Never ship it inside a product UI.** |

---

## CONTENT FUNDAMENTALS

Deco copy is a **printed notice, not a conversation**. It states, it does not persuade.
Confidence comes from brevity and from being specific about materials, dates and places.

**Voice.** Third person and impersonal by default. Institutional "we" only when the
institution is acting ("We close on Mondays"). "You" only in instructions the reader must
follow ("Arrive within fifteen minutes of your slot"). Never "I". Never chummy.

- Yes: *"Admission is by half-hourly slot. Members and children under twelve enter without charge."*
- No: *"We'd love to see you! Just grab a slot that works for you 🎟️"*

**Casing.** Three registers, and they are not interchangeable:
1. **UPPERCASE + wide tracking** — display headings, eyebrows, buttons, nav, labels, tabs.
   Everything set in `--font-display`, `--font-heading` or `--font-label` is uppercase.
2. **Sentence case** — body copy, list rows, hints, tooltips, table cells.
3. **Title Case** — never. It belongs to a different century.

**Length.** Eyebrows: three or four words (tracking is 0.34em; five words wrap).
Buttons: one or two words, a verb first — *Reserve*, *Confirm reservation*, *Plan your
visit*. Card titles: under six words. Body paragraphs: two to four sentences.

**Register and detail.** Prefer the concrete noun to the abstract one, and give the fact
rather than the adjective. *"Sixty pieces of pressed, wheel-cut and acid-etched glass"* —
not *"a stunning collection of exquisite glassware"*. Superlatives are absent from this
system's copy; the ornament is doing that job already.

**Numbers.** Arabic for anything the reader must compare (counts, prices, percentages,
capacities). **Roman numerals are house style** for dates, hours, floors, room numbers,
chapters and edition numbers — *Gallery III*, *Est. MCMXXIV*, *X — XVIII*, *No. XVII*.
Never Roman for a quantity.

**Punctuation.** Em dash with spaces for the aside — like this. Ampersands only inside
short label pairs (*Talks & tours*). Serial commas. Full stops in body copy; never on a
label, badge, eyebrow or button.

**Emoji: never.** Not in UI, not in copy, not as an icon, not in marketing. There is no
exception. Icons are Font Awesome glyphs.

**Sample voice**
> *Eyebrow* — NOW SHOWING
> *Heading* — GEOMETRIES OF SPLENDOUR
> *Standfirst* — A landmark survey assembling two hundred and forty objects across four floors, eighteen galleries.
> *Button* — RESERVE
> *Empty state* — NOTHING CATALOGUED / Objects appear here once accessioned.
> *Error* — NOT RECOGNISED
> *Toast* — SAVED / Catalogue entry 118 committed.

---

## VISUAL FOUNDATIONS

### Colour

Thirteen themes, one structure. Each theme declares 24 palette anchors plus the 16
semantic aliases; components only ever read the aliases, so nothing needs to know which
theme is active.

- **Grounds** are near-black (or, in light themes, warm paper) — `--surface-deep`,
  `--surface-page`, `--surface-panel`, `--surface-inset`. Never mid-grey.
- **One accent per theme**, in three values plus a 12% wash. The accent is the only
  saturated colour on a screen. Two saturated fills in one region is a bug.
- **Text** is three values on the ground: `--text-strong`, `--text-body`, `--text-muted`.
  All clear 4.5:1 on `--surface-page`.
- **Metal leaf** (`--metal`) is a six-stop gradient standing in for gilding. It is for
  bars, plinths, key caps, knobs, meter fills and *one* hero button per screen. It never
  sits behind body copy; `.ad-gilt` (gradient-clipped text) is headline scale only.
- **Status** colours are deliberately muted so they sit beside brass instead of shouting
  over it.

Default theme is **Lacquer** (brass on ink). Light themes: Boudoir, Pastille, Pavilion,
Verdigris — use these for print and for daytime documents.

### Type

| Role | Face | Notes |
|---|---|---|
| Display (hero → D3) | **Nyxar** (`--font-display`) | Clean geometric deco caps with a hairline inline detail. Uppercase, 0.06–0.14em tracking. |
| Headings, UI titles | **Modern** (`--font-heading`) | Solid at small sizes where the inline cut would muddy. Uppercase. |
| Posters, game titles | **Junia** (`--font-title`) | Heavy outlined poster face. Never below 28px. |
| Ornamental one-liners | **Monsante Inline** (`--font-inline`) | Invitations, game menu titles. One line at a time. |
| Labels, buttons, nav | **Emoritz** (`--font-label`) | 300/400/500. Uppercase at 0.22em (labels) or 0.34em (eyebrows). |
| Body, UI text | **Jost** (`--font-body`) | ⚠️ Google Fonts substitution — see below. |
| Editorial, spoken lines | **Cormorant Garamond** (`--font-serif`) | ⚠️ Substitution. Long-form print, gallery labels, game dialogue. |
| Data | **IBM Plex Mono** (`--font-mono`) | ⚠️ Substitution. Counts, times, accession numbers, status rails. |

Alternates also shipped and declared: Cleveland, Metrobrew, Haarlem Sans (+ italic),
Inline Heritage, Decohead, Decohead Display, Brodo, Brodo Inline, Art Deco, Monsante.

> **⚠️ Font substitution — needs your input.** The supplied pack is entirely display
> faces; none has a text-grade lowercase, real numerals and multiple weights. Body,
> editorial and data type are therefore **Jost**, **Cormorant Garamond** and **IBM Plex
> Mono** from Google Fonts, chosen for period sympathy (Jost is a Futura revival —
> Futura is 1927). If you have licensed text faces, send them and they drop straight into
> `tokens/fonts.css`.

**Tracking is the system's main dial.** 0.34em eyebrows → 0.22em labels → 0.14em hero →
0.10em display → 0.06em headings → 0.005em body. Hover *widens* tracking by 0.03em; that
is the house hover.

### Layout

Deco composition is **axial and tiered, not columnar**. The system deliberately ships no
12-column grid.

- `.ad-axis` — everything hangs from one vertical centre line. The default for heroes,
  section heads, posters, invitations, game menus.
- `.ad-tiers` — vertical bands separated by `--tier-gap` (64px) / `--tier-gap-lg` (96px).
  Sections are tiers, not rows in a grid.
- `.ad-split` / `.ad-split--spine` — a 62/38 asymmetric split, optionally with a
  double-hairline spine down the seam. The argument gets 62%, the ornament 38%.
- `.ad-steps` — a 14px ziggurat indent applied per child; the stepped setback used as a
  layout device.
- `.ad-columns` — two- or three-column text flow with a hairline column rule (print).
- Fixed elements: only the toast stack (`.ad-toaststack`, bottom-right), the modal scrim,
  the game HUD overlay and the mobile FAB. Nothing else is pinned.

Measure is `--measure` (66ch) for body, `--measure-tight` (48ch) for standfirsts.
Page shell is `--page-max` 1280px with a fluid `--page-gutter` (20 → 72px).

### Spacing

2px base, widening to roughly a 1.5 step: 2 · 4 · 6 · 8 · 12 · 16 · 24 · 32 · 48 · 64 ·
96 · 128 · 192. Hairline-tight *inside* a tier, generous *between* tiers.

Control heights: 28 / 36 / 46 / 56px, with a hard 44px floor (`--touch-min`) on mobile
and in game UI. Icons: 14 / 18 / 22 / 28 / 40px.

### Corners, borders and silhouettes

**`border-radius` is 0.** The one exception is a pill for game HUD controls
(`--radius-pill`) and the arch (`--arch`) for arch-topped panels. Corners are handled
instead by clipping: `.ad-chamfer` (two corners), `.ad-chamfer-4` (four), `.ad-notch-top`
(a small pediment notch), `.ad-shield`, `.ad-lozenge`. Sizes 5 / 10 / 18 / 28px.

Borders are **layered hairlines**, not one thick line: `--line-hairline` inside
components, `--line-rule` on component edges, `--line-strong` on buttons, window frames
and active states. `.ad-rule--double` and `--triple` stack 1px lines with 2px gaps.
`.ad-corners` draws four bracket corners on any box; `.ad-corners--inset` nests a second,
finer set 6px in.

### Elevation and shadow

Deco casts a **hard offset shadow with no blur** — that is the period's elevation, and it
is what `--shadow-cast-sm` (3px), `--shadow-cast` (6px) and `--shadow-cast-lg` (12px)
provide. Blur is reserved for things genuinely floating above the page:
`--shadow-panel` for app regions, `--shadow-float` for modals and menus.

Two bevels do the rest. `--bevel` (light top edge, dark bottom) makes a plate look
raised, like brass. `--bevel-inset` (dark top, faint light bottom) makes a control look
**engraved** — every input, track and slot in the system is inset, never raised.
`--gild` and `--gild-glow` add a 1px accent frame, the latter with a soft accent halo
used only on active game nodes.

### Backgrounds, imagery and transparency

- **Geometric grounds are generated in CSS**, not drawn: `.ad-sunburst` (repeating conic
  gradient, from below / from top / radial), `.ad-fluting`, `.ad-lattice`, `.ad-chevron`,
  `.ad-zigzag`. These are the workhorses.
- **Seamless patterns** are licensed raster tiles (`assets/patterns/`): fan/shell repeats
  for dark themes, pastel geometrics for light. Tile at 300–420px, and on dark grounds
  drop to **7–15% opacity** behind content. Above that they compete with the type.
- **Ornament** — gilt frames, ziggurat corners, sunbursts, stars, arches — is licensed
  art in `assets/ornaments/`. Use one ornament frame per screen, no more.
- **Photography** should be graded cool-to-neutral with slightly lifted contrast:
  `filter: saturate(.82) contrast(1.06)` (the `.ad-card__media` default). Warm, saturated
  imagery fights the brass.
- **Transparency and blur** appear in exactly three places: the modal scrim
  (`--bg-scrim` + `--blur-scrim`), the game HUD top bar (a vertical fade from
  `--surface-deep` to transparent), and the `--accent-wash` hover ground. There is no
  frosted-glass card, no translucent panel. Protection under text is a **hard veil**
  (`.ad-veil`, a gradient to `--surface-deep`), not a blur.

### Cards and panels

`Card` is flat: `--surface-panel`, a 1px `--line-rule` inset edge, no radius, no blur.
`variant="cast"` adds the hard 6px offset shadow. `variant="gilt"` nests a hairline
inside a 5px reveal, reading as a mounted plate. `variant="inset"` recesses the card.
`corners` adds bracket corners. Interactive cards translate **−1px, −1px** on hover and
brighten their edge — they do not lift, scale or glow.

`Panel` is the app-region container: an inset head rail with a heading-face title and
an actions slot, over a padded body. `gilt` adds a 3px metal-leaf bar across the top.

### Motion

Machine-age: precise, faintly mechanical, never springy. Durations 120 / 200 / 320 / 600
/ 1200ms. Easing `--ease-out` `cubic-bezier(.2,.7,.2,1)` for entries, `--ease-mech`
`cubic-bezier(.36,0,.16,1)` for anything that should feel geared (switch knobs, sliders).

- **Hover** — widen tracking 0.03em, brighten the accent, or expand a 1px rule from the
  centre outward (`.ad-navlink`, `.ad-btn--ghost`). Never a colour inversion.
- **Press** — `translateY(1px)` and swap the raised bevel for the inset one. No scale-down.
- **Entry** — modals open with a **shutter wipe** (`clip-path: inset(46% 0)` → `0`);
  toasts rise 10px; nothing bounces, nothing overshoots.
- **Focus** — 2px `--focus-ring` at 2px offset. In game UI, `data-focus="true"` gets the
  same treatment as hover plus a triangular pointer.
- `prefers-reduced-motion: reduce` collapses every duration to 1ms.

---

## ICONOGRAPHY

The system ships **no glyph set of its own**. Every icon is a Font Awesome 6 glyph from
the client's kit, referenced by name through the `Icon` component. Full contract,
head snippet, fallback behaviour and the glyph shortlist: **`assets/icons/README.md`**.

Head snippet, required on every page:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
```

Line 1 is the kit (Pro families, authoritative in production). Line 2 is the FA6 Free
webfont as a fallback, because **kits are domain-locked and do not render in sandboxes,
local files or preview environments** — this is a flagged substitution: in a
kit-authorised context `fa-light` / `fa-thin` / `fa-duotone` / `fa-sharp` work; with only
the fallback, restrict yourself to `fa-solid`, `fa-regular` and `fa-brands`.

Rules:
- Default family `fa-solid`. The system's line quality comes from the **ornament** assets,
  not from thin-weight icons.
- Size in `em` so glyphs track their label.
- **No emoji, ever.** No Unicode dingbats standing in for icons. No hand-drawn SVG icons.
- Ornament (frames, corners, sunbursts, stars, arches) is *not* iconography — it is
  licensed art in `assets/ornaments/`, used decoratively and always with
  `aria-hidden` / empty `alt`.
- `Icon` always renders `aria-hidden="true"`; `IconButton` requires a `label`.

---

## Themes

| id | Mode | Character |
|---|---|---|
| `lacquer` *(default)* | dark | Brass on ink — the house theme |
| `midnight-gold` | dark | Navy depths, high-chroma gold |
| `carnival` | dark | Ten-colour spectrum on slate; full semantic range |
| `cabaret` | dark | Violet, magenta and hot pink |
| `atlantic` | dark | Prussian blue, ice and a red accent |
| `boudoir` | light | Warm blush paper, sage rules |
| `terrace` | dark | Petrol blue, orange and citron |
| `lagoon` | dark | Teal depths, mint accent |
| `conservatory` | dark | Deep green with an electric cyan accent |
| `pastille` | light | Pale sky paper, candy accents |
| `promenade` | dark | Deep cyan, celadon, a hot red accent |
| `pavilion` | light | Cream paper, ink-blue type, vermilion accent |
| `verdigris` | light | Cool grey-green paper, quiet and archival |

```html
<body data-ad-theme="cabaret">   <!-- whole page -->
<section data-ad-theme="pavilion">  <!-- one region -->
```

Themes nest: a `pavilion` print sheet inside a `lacquer` page works, because every theme
scope re-declares both the palette anchors and the semantic aliases.

Browse them live in the **Colour-scheme variants** card
(`components/theme/theme.card.html`), or with `ThemeSwitcher` + `AD_THEMES`.

---

## Using the system

```html
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
<script src="_ds_bundle.js"></script>
```

```jsx
const { Button, Card, SectionHeading } = window.ArtDecoDesignSystem_4281ea;
```

### Known gaps / open questions

1. **Text-face licensing** — body, editorial and mono type are Google Fonts stand-ins.
   Send licensed text faces and they drop into `tokens/fonts.css` unchanged.
2. **Starting points vs templates** — the five UI kits are tagged `@startingPoint`.
   Consuming projects now read `templates/<slug>/` instead. Say the word and each kit
   becomes a template a consuming project can copy in one click.
3. **No logo** — deliberate; the sources had none. If you have a mark, drop the SVG in
   `assets/` and it replaces the type-set wordmark in `NavBar` and `thumbnail.html`.

`.ad-root` or `.ad-page` on the body element establishes the ground, ink and body face.
Every class in `css/` is prefixed `ad-`; every token is a `--`-prefixed custom property.

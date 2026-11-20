# Pixel Art Game — Design System

A complete pixel-art interface system: a 2px notched outline, a one-pixel bevel, zero
border radius, three bitmap-derived typefaces, thirteen interchangeable colour schemes,
and a component set that carries the same look across web pages, desktop apps, mobile
apps, game HUDs and print.

It is **not** a re-skin of any product. It was built by reading the sources below,
extracting the *rules* they follow — sprite geometry, state behaviour, exact pixel
values — and rebuilding those rules in CSS and React. No source art, branding, naming
or copy appears anywhere in it.

---

## Sources

Everything here derives from three attached sources plus one uploaded sheet.

**1. A pixel-art UI library for the Phaser game engine** (attached codebase, mounted as
`phaser-pixui-main/`). MIT-licensed TypeScript. This is the primary source and it
defines the component inventory.

- `src/primitives/` — `Container`, `Image`, `Rectangle`, `Text`, `Interactive`
- `src/widgets/` — `Button`, `Modal`, `PageStack`, `ProgressBar`, `RadioGroup`,
  `ScrollArea`, `Slider`, `Toggle`
- `src/behaviours/` — `clickable`, `draggable`, `hoverable`, `scrollable`
- `src/layout/` — a faithful subset of CSS flexbox, box model, anchoring and z-index
- `example/src/ui/` — the theme layer: `constants.ts` (three colours, three fonts),
  `visuals.ts` (frame, header, chat bubble), `controls.ts` (button, checkbox,
  radiogroup, slider, health bar, tab group), `settings_dialog.ts`, `load_dialog.ts`,
  `log_panel.ts`
- `example/assets/ui.yaml` — the nine-slice insets and sprite-state maps that gave us
  every exact pixel value in this system

Its stated design principle is *"No built-in look or theme; appearance is fully defined
by the assets used."* This design system is the look that library deliberately omits.

**2 & 3. Two commercial pixel tile-set packs** (attached, mounted as
`moderninteriors-win/` and `modernexteriors-win/`). Used two ways. Their
`Palettes/palette_interiors.png` and `Palette.png` were sampled programmatically
(132 and 174 unique colours) to establish the cool lavender-slate neutral ramp and the
warm saturated accent range the default scheme sits in. And their **character sheets and
premade room designs are used directly**: six character sheets from
`2_Characters/Character_Generator/0_Premade_Characters/32x32/` and two flattened room
designs from `6_Home_Designs/` now live in `assets/` and drive the system's animated
sprite components. The band map in
`2_Characters/Character_Generator/Spritesheet_animations_GUIDE.png` is what
`CharacterSprite` implements.

**4. A pixel item-icon sheet** (`uploads/MV Icons Complete Sheet Free - ALL.png`,
512 x 4768, 32px grid, ~2,100 populated cells). Shipped as `assets/icons/items.png` and
used directly as the system's **content iconography** via `ItemIcon`.

See `assets/README.md` for the full asset inventory, the measured sheet geometry, and
the sprite-to-CSS mapping table. All four sources are third-party licensed and require
attribution to their authors.

---

## Content fundamentals

The source's own copy is terse, literal and slightly dry, and that is the register the
system keeps. Real strings from the source example: `"There are no saved games"`,
`"New game is already started!"`, `"Inventory component is still under construction"`,
`"There is no escape :)"`, `"Catch me if you can!"`, `"Ha-ha!"`.

- **Sentence case in prose, UPPERCASE in chrome.** Every button, tab, label and table
  header is uppercase because the UI face is a caps-friendly bitmap font. Body copy is
  ordinary sentence case.
- **Second person for instructions, third person for state.** "Read the board before you
  press anything." / "There are no saved games."
- **State the fact, not the feeling.** No "Oops!", no "Great job!", no exclamation marks
  except where a character is speaking. An empty state says what is absent
  ("There are no saved games"), never apologises and never offers three next steps.
- **Numbers are literal and unrounded.** `64 x 48 tiles`, `tile 16px`, `4 of 5 layers
  visible`, `x 41 y 22 tile 138`. Status bars read like a debug line because that is
  what players and tool users actually want.
- **Two words maximum on a control.** `New game`, `Load game`, `Settings`, `Exit`,
  `Done`, `OK`, `Use`, `Drop`. Never `Get started now`.
- **Admit the unfinished.** The source shipped a tab that says the inventory is under
  construction. Placeholders in this system say `Item art`, `Screenshot`, `Plate` — they
  name what is missing rather than faking it.
- **Dry humour is allowed, at most once per screen**, and only in-world (an NPC bark, a
  disabled Exit button that logs "There is no escape :)"). Never in an error.
- **No emoji, ever.** The type is a bitmap face and emoji are full-colour vector art;
  mixing them breaks the pixel grid on every platform differently.
- **No em dashes in UI strings** — the bitmap faces render them at inconsistent widths.
  Use a middot separator (`Chapter 3 · 62%`) instead.

---

## Visual foundations

### The frame is the whole system

One idea carries everything: **every surface is a nine-slice sprite frame**. A 2px hard
outline with the four corner pixels bitten out, then a 1px bevel inside it — light on
the top and left, dark on the bottom and right.

`.px-frame` paints that with eight non-repeating background layers on a single element
(four outline edges, two highlight bars, two shade bars), so a frame is one `div` and
nests freely. There are four painted recipes — **raised**, **sunken** (bevel inverted),
**dark** and **flat** (outline only). Every other variant changes only
`background-color` and `color`, so retheming an instance is one property.

Because the outline leaves the four corner squares unpainted, `.px-frame` and
`.px-outline` are also **masked to that exact stepped silhouette** — a rectangle with an
`--edge`-sized square bitten out of each corner. Nothing the element fills can reach the
corner gap: not its own background, not a variant fill, not a coloured child such as a
health-bar fill. Colour never appears outside the border. Drop shadows use
`filter: drop-shadow()` rather than `box-shadow` so they follow the notched silhouette
instead of squaring the corners back off.

**Swapping the highlight and shade is the entire state language.** Raised means
actionable. Sunken means a field, a track or a well. That inversion also *is* the press
state.

### Colour

- 13 complete schemes. `:root` carries the default (**Parchment Keep** — warm parchment
  panels, dark ink, coral accent, amber secondary, deep slate desk, derived from the
  source theme layer's `light: 0xfbe4af / dark: 0x3d2817 / disabled: 0x4a3c2d` plus the
  tile-set palette study). The other twelve are `[data-theme="slug"]` scopes generated
  from the twelve supplied palettes: Spectrum, Midnight Gold, Neon Arcade, Deep Harbor,
  Sunbaked, Campfire, Verdant, Bioluminescent, Candy Coast, Lagoon, Ember Keep,
  Moss Stone. Four are dark-panelled; nine are light-panelled.
- Each scheme resolves the same 34 semantic tokens, so any component works in any scheme
  with no per-theme code. Body ink clears 7.4:1 on every surface in every scheme, and
  every accent and semantic colour ships a paired `-ink` token at 4.5:1 or better.
- **Five-step surface ramp**: `--surface-0` the dark desk a panel floats on, `--surface-3`
  sunken wells and tracks, `--surface-1` the default panel, `--surface-2` a raised inner
  card, `--surface-hi` the hover wash.
- **One accent per screen.** The accent marks the single action that matters. The
  secondary is reserved for currency, XP and rewards — never a second call to action.
- No gradients. Nowhere. Not in a hero band, not on a button, not behind a modal. Depth
  comes from the bevel and from dithering.

### Type

Three faces, each with one job, all sizes integer multiples of the art pixel.

| Role | Face | Sizes | Where |
| --- | --- | --- | --- |
| Display | **Micro 5** | 96 / 64 / 40 | Hero titles, chapter titles, big numerals. 40px floor. |
| UI | **Silkscreen** | 32 / 24 / 16 / 12 / 8 | Every button, tab, label, table cell, HUD readout. Uppercase, `0.04em` tracked. |
| Body | **Pixelify Sans** | 20 / 16 / 14 | The only face allowed to run in sentences. 64ch measure. |
| Mono | **Silkscreen** | 16 / 12 | Stats, coordinates, code, tabular numbers. |

`-webkit-font-smoothing: none` globally: antialiased pixel type is the one mistake that
destroys the whole aesthetic.

### Spacing and geometry

- `--px` is the atom (2px at the 2x default). Every gap is a whole number of art pixels:
  2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96. Set `--px: 1px` for fine print work or `3px`
  for a console HUD and the entire system rescales without touching a component.
- `--edge: 2 art px` outline. `--notch: 2 art px` corner bite. **`--radius: 0`, always.**
- `--tile: 32px` is the sprite module the page grid derives from; `--grid-col: 80px`.
- `--hit-min: 44px` on any touch surface.
- Two levels of frame nesting is the maximum. A third bevel inside a bevel reads as noise.

### Backgrounds

Flat colour first. When a surface must read as further back, **dither it** — never tint,
blur or fade it. Four textures ship: `.px-dither` (2px checker at 14% over the outline
colour), `.px-scanlines` (1px lines at 12%), `.px-grid` (a `--tile` keyline grid at 10%),
`.px-checker` (a solid two-tone tile checker). Game screens, desktop canvases and hero
bands all sit on `.px-desk` (`--surface-0`) with one texture over it.

No photography. No illustration. Raster art appears only through `Sprite`, always at an
integer scale with `image-rendering: pixelated`, and this system ships none of it.

### Shadows, transparency, blur

- One shadow recipe: a **hard offset**, down-right, in the outline colour, blur radius 0,
  drawn with `filter: drop-shadow()` so it takes the frame's notched silhouette.
  `.px-drop` (4px) and `.px-drop-lg` (8px). Shadows lift modals and floating panels off
  the desk; they are not applied to every card.
- No inner glow, no ambient shadow, no elevation scale.
- Transparency appears in exactly one place: `--scrim`, the modal backdrop
  (`rgba(20,16,12,.62)` light schemes, `rgba(4,6,12,.74)` dark). **`backdrop-filter` is
  never used** — a blurred pixel grid is mush.

### Interaction

| State | What changes |
| --- | --- |
| Hover | Fill lightens to `--surface-hi`. Nothing else. |
| Press | Bevel inverts **and** the label drops exactly one art pixel (`--press-offset`). |
| Disabled | Fill and ink drop to the disabled pair, **and the 1px drop is kept** — that retained offset is the source's own tell that a control is dead rather than merely quiet. |
| Selected | Takes the panel fill; a selected tab additionally shifts its label 7 art pixels right. |
| Focus | A 2px hard keyline in `--focus`, offset one pixel clear of the frame. |

Nothing scales. Nothing floats. Nothing fades.

### Motion

Pixel art steps; it does not ease. `--frame` is 66ms (~15fps) and every duration is a
multiple: `--dur-tick` 132ms, `--dur-beat` 264ms, `--dur-scene` 528ms. Easings are
`steps(2)`, `steps(3)`, `steps(4)`, `steps(8)` — there are no cubic-beziers in the
system. Transforms move in whole pixels only. `prefers-reduced-motion` zeroes all three
durations.

---

## Iconography

**Iconography is two-tier, and the tiers never mix inside one row.**

**Tier 1 — content: the 32px pixel item sheet** (`assets/icons/items.png`, ~2,100 cells),
via the `ItemIcon` component. Anything the user collects, buys, equips, reads about or
presses on a keyboard uses these: inventory rows, loot, shop shelves, quest markers,
stat readouts, bestiary entries, keycaps. About 120 cells are named (`potion_red`,
`chest`, `key`, `coins`, `lantern`, `orb_blue`, `pickaxe`, `storm`, `key_up`,
`key_ctrl`, …); everything else is addressable by `row`/`col`. Integer scale only —
1x, 2x, 3x.

**Tier 2 — chrome: Font Awesome via the supplied kit**, snapped to the pixel size scale
by the `Icon` component. Toolbars, nav, window controls, tabs, disclosure chevrons,
platform marks. These are the parts of an interface that are not "in the world".

The rule of thumb: if a player or user could hold it, it is an `ItemIcon`. If it is a
control, it is an `Icon`.

Every page loads two things:

```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css" crossorigin="anonymous">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

The kit (Pro, v7.3.1, JS/SVG method) is the primary and gives access to the full Pro
set. The free webfont stylesheet is a deliberate fallback: the kit's second-stage bundle
(`ka-f.fontawesome.com`) is blocked in some sandboxed preview environments, and without
the fallback every icon in this design system would silently vanish there. Every icon
name used across the components, cards and UI kits exists in the free tier, so the
fallback is complete rather than partial.

Rules

- Use the `Icon` component, never a bare `<i>`. It snaps `size` to 12 / 16 / 24 / 32 /
  48px so glyphs land on the grid, and it handles the aria-hidden/aria-label split.
- Set `window.PX_ASSETS` to the relative path back to the project root so `ItemIcon`
  resolves its default sheet URL, or pass `sheet` explicitly.
- **`solid` family for everything.** `regular` only for the empty counterpart of a filled
  state (empty heart, unstarred). `brands` for platform and social marks. Never `light`
  or `thin` — hairline strokes disappear against a 2px outline.
- One icon per control, on the left of its label unless it is a trailing chevron.
- **No emoji.** **No hand-drawn SVG.** **No second icon set.**
- Unicode is used as a glyph in exactly two places, both platform conventions: `⌘` in
  macOS shortcut hints, and `·` as a separator in status lines.

---

## Characters and environments

The system does not stop at static art. Two components make an interface **inhabited**:

- **`CharacterSprite`** plays one figure from a 32 x 64 character sheet. Twenty action
  bands ship — idle, walk, sit, phone, book, pushCart, pickUp, gift, lift, throw, hit,
  punch, stab, grabGun, gunIdle, shoot, hurt, sleep — each in four facings, in the order
  **right, up, left, down** (measured off the sheets). Frames step on a fixed clock at
  8fps walking, 5fps for idles.
- **`CharacterScene`** puts a cast inside one of the room environments. Each agent walks
  to each waypoint in turn, holds there for N ticks performing an action, then continues;
  the route loops. One whole art pixel per 90ms tick, facing derived from travel
  direction, depth sorted on `y`. No easing, no interpolation, no physics.

Where it is used, and why that is a design rule rather than a demo:

| Surface | Use |
| --- | --- |
| Game title screen | The room lives behind the menu at half opacity. A title screen with nothing moving on it reads as a mock. |
| Game HUD | The world is a real scene with three agents on routes; the HUD panels sit in the scene's `overlay`. |
| Web hero | A scene band on the right, masked into the dark desk. It is the product demo, not an illustration. |
| Desktop editor canvas | The map being edited *is* a live scene, with the tile-grid overlay on top. |
| Mobile quest detail | A small clipped scene stands in for the location the quest describes. |
| Print poster | The same scene with `running={false}`, frozen at frame zero. |

Beyond the scenes, art is used **decoratively** across the non-game surfaces — a walking
figure beside the site wordmark, two characters reading in the web footer and the docs
sidebar, one per pricing tier, mascots in the editor's sidebar and rules panel, a figure
in the mobile title bar and a scene strip above the quest list. Room art is also tiled at
8–14% opacity as a page or desk background behind the web footer, the pricing page, the
desktop shell and the mobile shell.

Rules for decorative art:

- Every decorative sprite is `aria-hidden` with `pointerEvents: "none"`. It is never a
  control and never conveys state.
- It sits in slack space — beside a wordmark, under a nav list, at the end of a row —
  never in a content column and never overlapping type.
- Tiled room art stays between 8% and 14% opacity. Above that it competes with copy.
- One or two figures per screen region. A crowd is a scene, and a scene belongs in
  `CharacterScene`.

Three rules:

1. **A scene is a backdrop, never a control.** Nothing in it is clickable and nothing in
   it conveys state the UI does not also state in words.
2. **Freeze it for print.** `running={false}` plus `playing={false} frame={0}`.
3. **Never scale a sprite by a fraction.** Integer `scale` only, at every size.

---

## Font substitutions — please confirm or replace

The source rendered all text with **bitmap fonts baked into sprite atlases**, not
webfonts: `pypx` (Pyrious, CC0) for UI text, `mana_trunk` and `mana_branches`
(tiopalada, CC0) for titles, all consumed as PNG glyph sheets by the game engine via
`example/assets/fonts.yaml`. They cannot be used on the web as-is.

These three Google Fonts are the substitution, chosen for closest metrics and character:

| Source font | Substitute | Notes |
| --- | --- | --- |
| `tiopalada/mana_trunk` (16px display bitmap) | **Micro 5** | Extreme pixel display face. Legible only at 40px+, which is where the source used its title font. |
| `pyrious/pypx` (16px UI bitmap) | **Silkscreen** | 8px em box, near-monospaced, caps-friendly — the closest web equivalent to a UI bitmap font. |
| — (source had no prose face) | **Pixelify Sans** | Added because every non-game surface needs running copy. |

**If you have webfont builds (WOFF2/TTF) of the original bitmap faces, or you want a
different pairing, say so and I will swap them** — the change is three lines in
`tokens/typography.css` plus the `@import` in `tokens/fonts.css`.

---

## Index

### Root

| File | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` lines only. |
| `readme.md` | This file. |
| `thumbnail.html` | Homepage tile. |
| `assets/README.md` | Asset inventory, sheet geometry, and the sprite-to-CSS mapping. |

### Tokens and patterns

| File | Contents |
| --- | --- |
| `tokens/fonts.css` | The webfont `@import`. |
| `tokens/palette.css` | Raw source palette anchors, for reference. |
| `tokens/themes.css` | 13 schemes, 34 semantic tokens each. |
| `tokens/typography.css` | Faces, sizes, line heights, tracking, type-role shorthands. |
| `tokens/spacing.css` | `--px`, the 12-step spacing scale, edge, notch, tile, hit-min, measure. |
| `tokens/motion.css` | Frame clock, four durations, four stepped easings. |
| `patterns/base.css` | Element defaults: body, headings, links, tables, focus, selection. |
| `patterns/pixel.css` | The four frame recipes, textures, drop shadows, desk, type utilities. |
| `patterns/controls.css` | Hover / press / select / disabled state rules for every control. |

### Components — 29 exports in 8 groups

`components/frames/` — **Frame**, **FrameHeader**, **ChatBubble**
`components/controls/` — **Button**, **IconButton**, **Checkbox**, **RadioGroup**, **Slider**, **TextField**, **Badge**
`components/display/` — **PixelText**, **Icon**, **ItemIcon**, **Sprite**, **ProgressBar**, **HealthBar**
`components/sprites/` — **CharacterSprite**, **CharacterScene**
`components/layout/` — **Stack**, **ScrollArea**, **LogPanel**
`components/navigation/` — **TabGroup**, **PageStack**, **MenuList**
`components/overlay/` — **Modal**, **Dialog**, **Tooltip**
`components/chrome/` — **WindowFrame**, **ThemeSwitcher** (plus the **THEMES** metadata export)

Each directory holds `<Name>.jsx`, `<Name>.d.ts`, `<Name>.prompt.md` and one
`@dsCard`-tagged preview HTML.

#### Mapping to the source inventory

| Source | This system |
| --- | --- |
| `Container` | `Stack` |
| `Text` | `PixelText` |
| `Image` | `Sprite` |
| `Rectangle` | folded into `Frame` variants |
| `Button` | `Button` |
| `Toggle` | `Checkbox` |
| `RadioGroup` | `RadioGroup` |
| `Slider` | `Slider` |
| `ProgressBar` | `ProgressBar` + `HealthBar` (the example's vertical `health_bar`) |
| `ScrollArea` | `ScrollArea` |
| `PageStack` | `PageStack` |
| `Modal` | `Modal` + `Dialog` (the example's `load_dialog`) |
| `frame` / `frame-header` / `chat_bubble` | `Frame` / `FrameHeader` / `ChatBubble` |
| `tabgroup` | `TabGroup` |
| `LogPanel` | `LogPanel` |
| `Interactive` / behaviours | folded into the control state CSS |

#### Intentional additions

Six components have no counterpart in the source. Each exists because the brief covers
surfaces the source library does not.

| Addition | Why |
| --- | --- |
| **Icon** | Font Awesome wrapper for chrome glyphs; keeps sizes on the grid and accessibility consistent. |
| **ItemIcon** | The supplied 2,100-cell item sheet needed an addressable, name-mapped accessor. |
| **CharacterSprite** | The supplied character sheets have 20 action bands and four facings; playing them needed a component. |
| **CharacterScene** | Environments plus a walking cast are what make these surfaces feel inhabited rather than illustrated. |
| **IconButton** | Toolbars and window chrome need a square single-glyph target. |
| **TextField** | The source has no text entry at all, and every web, desktop, mobile and print form needs one. |
| **Badge** | Status and count markers appear on every non-game surface. |
| **MenuList** | Sidebars and title screens need a vertical nav list; the source built these ad hoc. |
| **WindowFrame** | The brief requires macOS / Windows / Linux window chrome; a game UI toolkit defines none. |
| **Tooltip** | Icon-only controls (an addition themselves) need labels. |
| **ThemeSwitcher** | A documentation aid for previewing the 13 schemes. Not a product component. |

### UI kits

| Kit | Entry | Screens |
| --- | --- | --- |
| `ui_kits/web/` | `index.html` | Overview, documentation, pricing — a fictional tile-map editor's marketing site |
| `ui_kits/desktop/` | `index.html` | One editor window in all three native title-bar conventions |
| `ui_kits/mobile/` | `index.html` | A quest-tracker app in iOS and Android device frames, side by side |
| `ui_kits/game/` | `index.html` | Title screen, in-world HUD, inventory, settings, event log |
| `ui_kits/print/` | `index.html` | US Letter event poster and a two-page manual spread |

Each kit has its own `README.md` explaining how the system translates to that surface.
All five carry a live theme switcher so any screen can be previewed in any scheme.

### Guidelines cards

22 specimen cards in `guidelines/`, grouped **Colors** (surfaces, ink, accent, semantic,
bevel, all 13 themes, theme playground), **Type** (display, UI, body, scale ladder),
**Spacing** (pixel unit, spacing in use, edges and hit targets) and **Brand** (frame
anatomy, state language, textures, drop shadow, Font Awesome iconography, item icons,
character sheets, stepped motion).

---

## Using it

```html
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css" crossorigin="anonymous">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

```jsx
<div data-theme="midnight-gold">
  <Frame drop>
    <FrameHeader title="Save game" />
    <TextField label="Slot name" value={name} onChange={setName} />
    <Button variant="primary">Write</Button>
  </Frame>
</div>
```

Four rules that matter more than the rest:

1. **Never round a corner.** `--radius` is 0 and there is no exception.
2. **Never antialias the type.** Keep `-webkit-font-smoothing: none`.
3. **Never scale by a fraction.** Art, sprites and `--px` move in whole integers.
4. **Put something alive in it.** A surface with real item icons and a moving cast reads
   as a product; the same surface with grey placeholders reads as a wireframe. Keep the
   decoration in the slack space, `aria-hidden`, and out of the reading path.

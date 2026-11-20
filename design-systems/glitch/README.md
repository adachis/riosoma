# GLITCH — design system

A broadcast-failure design language: monospaced type, hairline rules, zero corner radius, one
loud accent, and controlled signal-decay artefacts (RGB split, slice tears, scanlines, grain).
It is built to be applied unchanged across five surfaces — web pages, desktop apps (macOS,
Windows, Linux), mobile apps (iOS, Android), video-game UI, and print — and to be re-coloured
by thirteen interchangeable palettes without any component being touched.

There is no company behind this system. "Glitch" is the name given in the brief; the wordmark is
type, not a logo (see *Brand & logo* below).

---

## Sources this was built from

| Source | What it gave us |
| --- | --- |
| `Glitch/` (attached local folder) | The only *code* source: a complete CV/portfolio HTML template under `Glitch/html/template/` with LESS sources (`less/setting.less`, `glitche-basic.less`, `glitche-layout.less`), six accent-swap stylesheets in `css/template-colors/`, and a dark theme in `css/template-dark/dark.css`. Every base value in this system (13px mono body, 23px line, 30px rhythm, 42px buttons, 60px fields, 1px `#DDD` rules, `border-radius: 0`, the 30px fixed page frame, the `inset 0 -6px` highlighter, and the original two-copy `clip`-based glitch keyframes) is lifted from those files. |
| `Glitch/` vector + raster packs | Glitch background plates, moiré/tear textures, dusty print textures, seamless cyber-grid and technical-geometric patterns, monochrome vector art (crashed PC, retro windows, glitched signal, system error) and four full-colour pixel-art characters. The usable subset is copied into `assets/`. |
| `Glitch/Security/SVG/` | A 36-icon security SVG set. Ten representative glyphs copied to `assets/glyphs/`; **not** the system's icon language (see *Iconography*). |
| Reference links in the brief | `awge-unofficial.webflow.io`, `css-glitch-effekt.webflow.io`, `hover-terminal-effect.webflow.io`, `eloyb.design`, plus the CSS-glitch write-ups at `freefrontend.com/css-glitch-effects`, `muffinman.io/blog/css-image-glitch` and `deloughry.co.uk/field-notes/building-glitch-effects-with-css`. Used as *directional* reference only — for the terminal/caret idiom, hover-tear behaviour and the general severity of the aesthetic. No markup, copy, imagery or branding from any of them appears here. |
| Uploaded reference images (`uploads/`) | Mood only. Per the brief, none are used in the system and none are copied into `assets/`. |
| Colour brief | Twelve Coolors palettes, implemented verbatim as schemes (`tokens/schemes.css`). |
| Font Awesome kit `fde87cf732` | The system's icon language. |

Nothing in this system reproduces the source template's structure, page copy, author identity or
branding; it reuses the measurable design decisions (scale, rhythm, weights, mechanics) and
rebuilds everything else.

---

## Content fundamentals

**Voice.** Flat, technical, unhurried. The system talks like an operator's log, not like a
product. State facts and numbers; never sell. No exclamation marks anywhere.

**Person.** "We" for the studio/organisation, "you" only in direct instructions
("Install the relay with the antenna clear of the roof line"). Never "I".

**Casing — this is the load-bearing rule.**

| Where | Casing | Example |
| --- | --- | --- |
| Display headlines | UPPERCASE, display face | `DEAD AIR` |
| Section titles, buttons, tabs, chips, HUD labels | UPPERCASE, tracked 0.04–0.28em | `SELECTED WORK`, `RUN SEQUENCE` |
| Body copy, dialogue, list rows, article text | Sentence case | `Carrier holds at 2.4 GHz with 0.4% loss.` |
| Machine output — status strips, logs, terminals, preloaders | all lowercase | `acquiring signal`, `utf-8`, `ln 42`, `live` |

**Length.** Button labels 1–3 words. Section titles ≤ 2 words. Body paragraphs 2–4 sentences.
Alert titles ≤ 4 words, alert bodies one sentence plus a consequence
("Packet loss above 2%. Falling back to narrowband.").

**Numbers.** Always concrete and always formatted: zero-padded indices (`04`, `01 / 09`), units
attached (`38 ms`, `2.4 GHz`, `18.4k`), percentages to one decimal. Pagination pads under ten.
Numbers are the system's decoration — do not invent them where you have none.

**Metaphor set.** Signal, carrier, relay, node, feed, channel, sweep, tear, drop, dead air. Use
it for placeholder content and demo data; it keeps mock UI coherent. Do not extend it into
mystical or cyber-punk-flavoured naming ("neural", "quantum", "matrix").

**No emoji.** Not in UI, not in copy, not in demo data. Status is a coloured square dot, a
Font Awesome glyph, or a word.

**Punctuation.** Slashes separate metadata (`Motion / 2026`, `22:04 / 3m 12s`). Em dashes are
used sparingly in prose and never in labels. Terminal lines end with a blinking `_`, never a
period.

---

## Visual foundations

**Colour.** One accent per scheme, used for exactly three jobs: the active/hover fill, the
1px accent rule, and small metadata (chip borders, key names, status strip "live"). A second
colour — the highlighter — only ever appears as a 6px inset underline behind text. Surfaces are
derived from four anchors (`--gl-anchor-deep / mid / pale`) with `color-mix`, which is why a
scheme can re-colour the whole system by declaring anchors only. Status colours
(`--gl-ok / warn / err / info`) are deliberately identical in every scheme so meaning survives
re-theming. Two glitch channels (`--gl-chan-a`, `--gl-chan-b`) drive every RGB-split effect.
Dark is the default mode; light mode is a full peer, not an afterthought. Max two background
values in a layout — page and panel.

**Type.** Two families, both from Google Fonts: **Archivo Black** for display only (42–132px,
uppercase, `-0.02em`), **Azeret Mono** for absolutely everything else (300/400/500/700).
Body is 13px on a fixed 23px line. The tracking ladder is the system's tone control: the smaller
the type, the wider the tracking (11px micro at 0.12em, 9px tab labels at 0.28em). No italics.
No third family. No serif.

**Spacing & layout.** 5px unit, 30px rhythm, 40px under section titles, 90–150px between page
sections, 80px page gutters (40px under 960px, 20px under 480px), 1060px wrapper. The signature
layout device is a **30px fixed accent frame** around the viewport (`.gl-frame-bars`, 15px under
840px) — the page reads as a monitor inside a bezel. Grids use flex/grid with `gap`; tile grids
use a 3% gutter.

**Backgrounds.** Full-bleed monochrome glitch plates (`assets/backgrounds/`) behind heroes,
game screens and desktop wallpapers, always with a scanline overlay on top and an opaque type
plate behind headlines. Seamless patterns (`assets/patterns/`) for large flat areas. Dusty
textures (`assets/textures/`) as a 22% overlay grain for print-feeling surfaces. No photographic
imagery is supplied — swap plates for real photography by replacing files, not layouts. No
gradients as decoration; the only gradient in the system is the 14%-tall scan sweep and the
5px CSS select caret.

**Imagery colour vibe.** Two families. Most plates are saturated RGB-channel glitch — hot
magenta and cyan tearing through a dark frame, cool overall, high contrast, video rather than
photographic (`glitch-bg-01`, `-02`, `-06`). One plate is pure black-and-white moiré
(`glitch-bg-03`) and is the right choice for print and for anything that has to stay neutral
under a scheme. Imagery is never tinted to match the accent — the scheme owns the interface,
the plate owns itself. The four pixel-art characters are full-colour and are never recoloured.

**Corner radii.** `0`, everywhere. The only exceptions in the whole system are `Avatar`
(fully round) and `Radio` (round mark, to distinguish it from `Checkbox`).

**Borders.** 1px solid is the default; 2px for the accent rail on sheets and active tabs; 1px
dashed for empty slots. Panels are bordered, never borderless-with-shadow.

**Shadows.** No blur, ever. Elevation is expressed as a **hard 4px offset**
(`--gl-shadow-hard`, accent or ink) and used on at most one element per view. Inset shadows do
two jobs only: the highlighter underline and a 1px hairline. `--gl-glow` exists for HUD
emphasis and is the one place a soft edge is allowed.

**Cards.** There are none in the usual sense. A "card" here is `Panel`: square, 1px border,
`--gl-surface` fill, 30px padding, optional ruled header with an uppercase micro title, optional
10px accent corner block. No rounded corners, no drop shadow, no coloured left border as
decoration (a coloured left rail means *status*, on `Toast` and `DialogueBox` only).

**Transparency & blur.** Reserved for three cases: modal scrims (`blur(6px)`), the pause overlay
(`blur(14px)`), and game HUD panels (`--gl-hud-fill`, backdrop-blurred). Never on content
surfaces, never on web pages.

**Animation.** Two grammars, deliberately incompatible. *State* transitions are smooth —
80ms press, 150ms hover/focus, 300ms colour and border, 600ms meters and reveals, with
`cubic-bezier(.2,.7,.3,1)`. *Glitch* effects are stepped — every glitch keyframe uses
`steps(1,end)` so the tear jumps between discrete positions and never interpolates. Loops sit at
2.4–3.6s with long quiet stretches; the artefact is an interruption, not a texture. One glitching
element per view. Everything is suppressed under `prefers-reduced-motion`, and no information
depends on motion.

**Hover states.** The system inverts rather than tints: outline controls fill with the accent and
switch to `--gl-accent-ink`. Links go accent. Icon buttons fill. Tiles reveal an accent overlay
that scales 0.5 → 1 at 0.94 opacity. Rows take an inset background. No opacity fades, no
lightening/darkening of fills.

**Press states.** `translate(1px,1px)` — the control moves into its own shadow — plus the deeper
accent (`--gl-accent-deep`). Keycaps drop their 2px offset entirely.

**Focus states.** 1px accent outline at 2px offset, on every interactive element. Fields move
their 1px underline to the accent.

**Protection.** Text over imagery is protected by an opaque plate behind the type
(`background: var(--gl-bg)` on the headline), not by a gradient scrim. Only the game HUD uses a
translucent capsule.

**Fixed elements.** The accent frame, the page header, and the footer are fixed on web; window
title bars, toolbars and status strips are pinned in desktop; status bar / app bar / tab bar are
pinned in mobile; HUD corners are pinned in game. Print pins nothing except folio and slug.

---

## Iconography

**The system's icon language is Font Awesome**, via the kit supplied in the brief:

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

- **Style:** `fa-solid` for all interactive and status glyphs; `fa-regular` for inert/secondary
  states; `fa-brands` for social links only.
- **Sizing:** 12–14px inside rows and toolbars, 17–22px in headers and tab bars, 30px for the
  service/feature glyph, 38px in tile hover overlays. Icons inherit `currentColor` — they are
  accent-coloured only when the whole control is.
- **API:** every component that takes an icon takes a Font Awesome **class string**
  (`icon="fa-solid fa-play"`), never an imported node. There is no `<Icon>` wrapper.
- **Recurring set:** `tower-broadcast`, `satellite-dish`, `wave-square`, `sliders`,
  `location-crosshairs`, `box-archive`, `triangle-exclamation`, `circle-info`, `terminal`,
  `bolt`, `tv`, `signal`, `wifi`, `battery-three-quarters`, `chevron-right`, `xmark`, `plus`,
  `caret-right`, `circle-dot`, `film`.
- **No emoji, ever.** Unicode characters are used as *typography*, not as icons: `>` as a field
  prefix and menu caret, `/` as a metadata separator, `_` as the terminal caret, `—` / `□` / `✕`
  in Windows window controls (they are chrome glyphs, matching the OS).
- **The source kit's own icon font (Ionicons) was not carried over** — it is an abandoned set and
  the brief specifies Font Awesome. This is a deliberate substitution, flagged here.
- The ten security SVGs in `assets/glyphs/` are the only other icon-shaped assets. They are
  32px, single-colour, and intended as **spot illustration** (feature marks, empty states), not
  as UI icons. Use `.gl-art` so they invert correctly per mode.

Vector art in `assets/illustrations/` is monochrome black; `.gl-art` inverts it to white in dark
mode. The four `*.png` characters are full-colour with transparency and are used as-is.

---

## Brand & logo

**No logo or brand mark exists in the sources**, so none was drawn. Wherever a mark would go, the
name is set in type:

- **Primary lockup** — `GLIT` + `CH` in Archivo Black, uppercase, `-0.02em`, the second half in
  `--gl-accent` (`AppHeader brand="GLIT" accentPart="CH"`).
- **Secondary lockup** — `g l i t c h` in Azeret Mono at `--gl-track-widest`, for footers,
  print colophons and small applications.

If a real mark is supplied later, it replaces the `.gl-header__brand` span and the
`thumbnail.html` mark; nothing else changes.

---

## Colour schemes

Thirteen schemes live in `tokens/schemes.css`, one single-selector scope each. Apply with two
attributes on `<html>`:

```html
<html data-mode="dark" data-scheme="overdrive">
```

`signal` (the default identity — orange `#f26b38` + highlighter `#ede574`, inherited from the
source template's `@active-color` / `@extra-active-color`), then the twelve palettes from the
brief: `spectrum`, `nightwatch`, `overdrive`, `bulletin`, `faded`, `campfire`, `coolant`, `vhs`,
`candy`, `beacon`, `kiosk`, `moss`. Both modes work in every scheme.

Preview them live: **`guidelines/color-schemes.html`** switches all thirteen against a real UI
sample in light and dark. Per the brief, scheme switching is a *documentation* affordance — the
UI kits do not ship a theme picker.

---

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | The only file consumers link. Import list, nothing else. |
| `tokens/fonts.css` | Google Fonts import + family tokens |
| `tokens/colors.css` | Ink ramp, accents, status, anchor-derived semantic surfaces (dark + light) |
| `tokens/schemes.css` | The thirteen colour schemes |
| `tokens/typography.css` | Size, line-height, tracking, weight and role tokens |
| `tokens/spacing.css` | Spacing scale, frame, section, control and chrome dimensions |
| `tokens/effects.css` | Radius, borders, marker, hard shadows, motion, blur, z-layers |
| `tokens/glitch.css` | Glitch keyframes and the ten FX utility classes |
| `tokens/base.css` | Element defaults and layout utilities |
| `css/controls.css` | Button, icon button, chip, badge, field, choice, slider styles |
| `css/surfaces.css` | Panel, section title, meter, table, stat, overlay, media styles |
| `css/nav.css` | Header, nav, tabs, window chrome, sidebar, mobile shell styles |
| `css/domains.css` | Game HUD and print/page styles |
| `guidelines/*.html` | 28 specimen cards (Colors, Type, Spacing, Effects, Brand) + the live scheme switcher |
| `components/<group>/` | 53 React primitives, each with `.d.ts`, `.prompt.md`, and one group card |
| `ui_kits/web/` | Studio marketing site — 4 click-through screens |
| `ui_kits/desktop/` | `signal.monitor` desktop app in macOS / Windows / Linux chrome |
| `ui_kits/mobile/` | Field-recorder app, iOS + Android |
| `ui_kits/game/` | *Dead Air* — main menu, in-game HUD, pause/loadout |
| `ui_kits/print/` | Poster, editorial spread, technical spec sheet |
| `templates/web-page`, `desktop-app`, `mobile-app`, `game-screen`, `print-sheet` | Copy-to-start templates, one per surface, each with mode + scheme tweaks |
| `assets/` | Backgrounds, patterns, textures, illustrations, glyphs |
| `SKILL.md` | Agent-skill entry point |

---

## Components

53 primitives in ten groups. Every one is a named export on `window.GlitchDesignSystem_b2386b`.

**core** — `Button`, `IconButton`, `Chip`, `Badge`, `GlitchText`, `Mark`, `Panel`, `SectionTitle`

**forms** — `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`

**data** — `Meter`, `DataTable`, `KeyValueList`, `StatReadout`

**navigation** — `AppHeader`, `MenuButton`, `NavList`, `Tabs`, `FilterBar`, `Pagination`,
`Breadcrumb`

**feedback** — `Preloader`, `Modal`, `Toast`, `Tooltip`, `Alert`

**media** — `BoxItem`, `Avatar`, `GlitchImage`

**desktop** — `WindowFrame`, `Toolbar`, `SidebarNav`, `StatusStrip`

**mobile** — `StatusBar`, `AppBar`, `TabBar`, `ListRow`, `Sheet`

**game** — `HudMeter`, `HudPanel`, `GameMenu`, `KeyCap`, `DialogueBox`, `ObjectivePanel`

**print** — `PrintPage`, `Masthead`, `PullQuote`, `Caption`

### Intentional additions

The source is a static marketing template, so it defines markup for buttons, fields, nav, tiles,
meters, tables, chips, timeline items, a popup and a preloader — but nothing for the four
non-web surfaces the brief requires. These families have no counterpart in the source and were
authored to cover it, and are listed here so nobody mistakes them for recreations:

- **Desktop** — `WindowFrame`, `Toolbar`, `SidebarNav`, `StatusStrip`
- **Mobile** — `StatusBar`, `AppBar`, `TabBar`, `ListRow`, `Sheet`
- **Game** — `HudMeter`, `HudPanel`, `GameMenu`, `KeyCap`, `DialogueBox`, `ObjectivePanel`
- **Print** — `PrintPage`, `Masthead`, `PullQuote`, `Caption`
- **App-shell gaps** — `Tabs`, `Toast`, `Tooltip`, `Switch`, `Slider`, `Select`, `Breadcrumb`,
  `StatReadout`, `GlitchImage` (the source has no equivalents; every one is built from the
  source's own vocabulary — 1px rules, square corners, accent inversion)

Each addition follows the source's measured values rather than any framework default.

---

## Substitutions & caveats

1. **Typefaces.** The source template loads **Roboto Mono** from Google Fonts and ships no font
   binaries. Rather than clone it, this system uses **Azeret Mono** (mono, same role) and
   **Archivo Black** (display, no equivalent in the source — the template set its 68px headline
   in Roboto Mono Bold). Both are Google Fonts, loaded by `@import` in `tokens/fonts.css`. **If
   you have licensed brand faces, send the files** and only that one file needs to change.
2. **Icon font.** Ionicons → Font Awesome kit `fde87cf732`, per the brief.
3. **Glitch mechanics.** The source animates the legacy `clip` property; this system uses
   `clip-path` with `steps(1,end)` and adds `prefers-reduced-motion` suppression. Visually
   equivalent, mechanically modern.
4. **Two textures were too large to copy** (the >30MB `Glitch Texture 003/007.jpg` plates).
   `assets/textures/` carries the dusty print textures instead. `assets/backgrounds/glitch-bg-04.jpg`
   is a flat colour-block plate that reads as a palette test rather than a glitch — it is kept for
   completeness but is not used in any kit.
5. **Four vector illustrations were unusable** as SVG (flattened to opaque artboards). Their
   transparent PNG versions are used instead.
6. **No photography.** The system has no photographic imagery and none was invented; glitch
   plates stand in for it everywhere.

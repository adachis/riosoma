# PSOne Design System

A design language for interfaces that look like they booted off a 32-bit optical disc in 1997:
black substrate, a deep blue panel gradient, double-ruled plates, hard-stamped drop shadows,
squashed uppercase titles, bitmap labels and sweep-fill buttons.

It is **not** a reproduction of any real console, publisher or game. Nothing identifying any
source is included — no logos, marks, face-button glyphs, packaging trade dress, screenshots or
copy from the reference material. The reference images supplied with the brief were used to read
the era's visual conventions and were then set aside; none ship in this project.

---

## Sources this system was built from

| Source | What was taken from it |
|---|---|
| `PSone.css-master/` (attached codebase, read-only mount) | The entire structural vocabulary and every literal value: panel gradient `#0D2289 → #06093B`, 1px `#C6C6C6` outline plus 2px white inner rule at radius 8/7, `inset 0 0 2px 2px rgba(0,0,0,.3)`, button sweep gradients and the 3px gradient border rules, the five status pairs, 12px progress bars with a stretched caption, the 30px dashed input baseline, the `scale(1,0.5)` squashed title, `cubic-bezier(.25,.8,.5,1)` easing with a 1ms colour hop, the `0 2px 5px black` hardware drop, and the grey plastic ramp `#29292A → #5F5E60`. |
| 36 reference images (`uploads/`) | Era conventions only: receding grid floors, horizon gradients, scanline overlays, bitmap HUD readouts, mono timers, corner-anchored party meters, caret menu cursors, jewel-case back-insert layout, magazine-spread typography. Not reused, not traced, not copied. |
| Brief | The name **PSOne**, the five required application surfaces, the Font Awesome kit, and twelve supplied colour palettes. |

The attached codebase was a small CSS framework: one stylesheet, four webfonts, one demo page.
It defines ten component families — button, container, title, paragraph, progress bar, radio,
field, input, icon and link — and nothing else. Everything beyond that ten is listed under
[Intentional additions](#intentional-additions) with a reason.

---

## Index

| Path | What it is |
|---|---|
| `styles.css` | Global entry point. `@import` lines only — link this one file. |
| `tokens/` | `fonts.css` · `colors.css` · `themes.css` · `typography.css` · `spacing.css` · `effects.css` · `motion.css` · `base.css` |
| `components/` | 34 React primitives in seven groups (below) |
| `ui_kits/web/` | Catalogue website — home, filtered catalogue, editorial article |
| `ui_kits/desktop/` | Disc-library app in macOS / Windows / Linux chrome, prefs, transfer palette |
| `ui_kits/mobile/` | iOS and Android side by side — feed, detail, settings |
| `ui_kits/game/` | Title, main menu, memory-card browser, in-game HUD and pause |
| `ui_kits/print/` | Editorial spread, event poster, jewel-case back insert |
| `guidelines/` | 20 foundation specimen cards + `theme-explorer.html` |
| `assets/fonts/` | `Play-Regular.woff` / `.ttf` (OFL, copied from the source framework) |
| `templates/app-screen/` | Consumer starting point — application shell (`AppScreen.dc.html`) |
| `templates/game-screen/` | Consumer starting point — game surface (`GameScreen.dc.html`) |
| `thumbnail.html` | Homepage tile |

### Components

**core** — `Button` · `IconButton` · `Glyph` · `Badge` · `Tag` · `Divider`
**surfaces** — `Panel` · `PanelTitle` · `Card` · `Dialog`
**forms** — `Field` · `Input` · `Textarea` · `Select` · `Checkbox` · `Radio` · `Switch` · `Slider`
**feedback** — `Progress` · `Meter` · `Toast` · `Spinner`
**navigation** — `MenuList` · `Tabs` · `Pager` · `HintBar` · `Breadcrumb`
**chrome** — `WindowFrame` · `AppBar` · `StatusBar` · `TabBar`
**game** — `Hud` · `DialogueBox`
**print** — `PullQuote` · `SpecTable`

Every component directory carries a `<Name>.prompt.md` with a one-line "what & when", a usage
snippet and its variants, plus one `@dsCard` HTML showing all its states.

### Intentional additions

The source framework defined ten families. These were added because the brief requires full
coverage of five application surfaces that ten primitives cannot reach:

- `IconButton`, `Glyph`, `Badge`, `Tag`, `Divider` — the source's `.icon` class was a fixed set of
  hardware sprites. Those specific sprites are trademarked hardware iconography, so they were
  replaced with a generic moulded-key wrapper (`IconButton`) and a moulded-disc wrapper (`Glyph`)
  that hold any Font Awesome glyph. `Badge`/`Tag`/`Divider` cover states and metadata the source
  expressed only in prose.
- `Card`, `Dialog` — needed for web grids and every confirm flow.
- `Textarea`, `Select`, `Checkbox`, `Switch`, `Slider` — the source shipped one text input and one
  radio; no settings screen is possible with that.
- `Meter`, `Toast`, `Spinner` — the source had one progress bar; live gauges, non-blocking messages
  and indefinite waits are distinct jobs.
- `MenuList`, `Tabs`, `Pager`, `HintBar`, `Breadcrumb` — the source had no navigation at all.
- `WindowFrame`, `AppBar`, `StatusBar`, `TabBar` — required by the desktop and mobile surfaces.
- `Hud`, `DialogueBox` — required by the game surface.
- `PullQuote`, `SpecTable` — required by the print surface.

---

## Content fundamentals

**Voice.** Flat, technical, declarative. It reads like a manual page written by someone who
respects the reader's time. State the thing; do not sell it.

**Casing.** This is the single loudest content rule. Interface chrome is **uppercase**: buttons,
titles, menu rows, labels, badges, tags, hint legends, status bars, table headers. Body copy and
help text are **sentence case**. Nothing is title case, ever.

- Button: `LAUNCH` · `COPY SAVE` · `ERASE ALL SAVE DATA`
- Label: `PILOT NAME` · `MAX BLOCKS` · `INTEGER SCALE`
- Body: `Block 3 already holds data. This cannot be undone.`

**Person.** Second person for instructions (`Insert a card in slot 1`), no person at all for state
(`15 of 15 blocks free`). Never first person — the system does not have a personality, it has a
status. No "we", no "let's", no "oops".

**Numbers.** Always set in the mono face, always padded to a fixed width so readouts do not jitter:
`003 RESULTS`, `02 / 12`, `0'42"18`, `014200`, `1998.11.26`. Units are separate and shortened:
`3 BLK`, `612 MB`, `72%`.

**Length.** Labels are one or two words. Hint-bar entries are one word (`SELECT`, `BACK`).
Body paragraphs run 2–4 sentences. A dialog explains the consequence in one sentence and stops.

**Empty and error states** name the physical cause, not the abstraction:
`Block 04 holds no data.` · `No second unit detected on the port.` · `Insert a card in slot 1.`

**Emoji: never.** Not in UI, not in docs, not in commit messages. Iconography is Font Awesome only.
Unicode is used for two things and no more: the en dash in ranges (`1–2 players`) and the middot as
a metadata separator (`RACING · 1998 · 3 BLK`).

**Vibe.** Confident hardware. Nothing apologises, nothing celebrates. `PRESS START` is the tonal
centre of the whole system: an instruction, in caps, with no punctuation.

---

## Visual foundations

### Colour

Three layers. **Substrate** is near-black (`--ink-void #000`, `--ink-abyss #05060F`) — the app
background is always the darkest thing on screen. **Panels** sit on it as a vertical blue gradient
(`--surface-panel-top #0D2289` → `--surface-panel-bottom #06093B`). **Hardware** parts — window
chrome, keys, markers, selects — use the grey plastic ramp (`--grey-900 #29292A` → `--grey-500
#5F5E60`), lit top-to-bottom so they read as moulded.

Status colours always ship in pairs, base and hover-brightened: accent `#3E8CA5`/`#49A7C6`,
positive `#4EA35B`/`#5DC66D`, caution `#F19C42`/`#FFB544`, critical `#B62F28`/`#E93F36`. Links are
pure yellow; placeholders are olive `#C6C843`. Four marker hues (`--glyph-a…d`) exist for input
prompts and legends — never render more than four in one view.

Colour is *never* the only signal. A critical button is red **and** says `DELETE`; a disabled
control is grey **and** loses pointer events.

**Themes.** 13 palettes live in `tokens/themes.css`, applied with `data-theme="<id>"` on any
ancestor: `core` (default), `spectra`, `midnight`, `hyperdrive`, `coolant`, `sunbleach`,
`cartridge`, `aquifer`, `biohazard`, `bubblegum`, `arcade`, `mission`, `static`. A theme re-points
the chromatic and panel aliases only — the neutral hardware ramp, every structural token name, and
every component stay identical. `data-surface="paper"` inverts the substrate for print without
touching the accents. See `guidelines/theme-explorer.html`.

### Type

Four faces, four jobs, no overlap.

- **Display — Play** (self-hosted, OFL). Titles, buttons, menu rows, table row titles. Always
  uppercase, tracked out `.06–.14em`, weight 700 for headings.
- **Bitmap — Silkscreen**. Labels, HUD readouts, hint bars, status bars, table headers, eyebrows.
  11px or 13px only, uppercase, tracked out to `.14–.24em`. Never body copy — it is unreadable
  past a few words, which is the point.
- **Body — Chakra Petch**. The only mixed-case face. 16px at 1.5 for paragraphs, 600 for emphasis.
- **Data — Share Tech Mono**. Numbers, timers, counters, sizes, dates, breadcrumbs.

**The squash.** Panel headings are scaled to 62% of their height (`transform: scale(1,.62)`,
origin left) and stamped with a 4px hard black shadow. The source framework used `scale(1,0.5)`;
62% keeps the same silhouette while staying legible at web sizes. This is the system's signature —
if a layout feels wrong, the title is usually unsquashed.

Scale: 11 · 12 · 13 · 14 · 16 · 20 · 24 · 28 · 40 · 64 · 96. Bitmap sizes stay on whole even
pixels so the face never resamples soft.

### Space, radii, borders

Spacing runs 2 · 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64. Panels take a 16px gutter on all sides,
screens 24px — both inherited from the source's `1rem` rhythm.

Radii are deliberately few: `0` for flat data (badges, meters, progress gutters, table cells),
`4px` for hardware keys and chips, the `8px/7px` pair for the panel and its inner rule, and
`--radius-pill` for marker discs. Nothing else gets rounded.

Three border weights: 1px hairline (`#C6C6C6` panel outline), 2px inner rule (white), 3px
gradient rule (`transparent → rgba(255,255,255,.2) → transparent`, used on buttons and dividers so
they fade out at both ends). Text inputs have no box at all — a 30px repeating dash at the baseline
is the entire control.

### Cards and panels

Every grouped region is the same object: 1px light-grey outline at radius 8, a 2px white inner
rule at radius 7 drawn as an absolutely-positioned overlay, and `inset 0 0 2px 2px rgba(0,0,0,.3)`
so the plate looks pressed into the screen. Four skins: `default` (blue gradient), `dark`
(black 40%, for nesting), `light` (white 20%, over imagery), `hardware` (grey plastic).
Nested panels drop to dark or light so the double rule still reads.

Cards add a cover slot above the text and a footer strip below it. On hover an interactive card
lifts 2px and gains the hardware drop — no scale, no glow.

### Shadows

Two systems, kept apart. **Text is stamped**: `2px 2px 0 #000` for body and buttons, `4px 4px 0
#000` for titles. Hard offsets, zero blur — a blurred text shadow is the fastest way to make this
system look wrong. **Objects get one tight drop**: `0 2px 5px #000` for hardware parts, a layered
soft drop on press, `0 12px 32px rgba(0,0,0,.6)` for windows and modals. Panels get an inner
vignette rather than an outer shadow.

### Backgrounds and texture

No photography, no illustration, no gradients-as-decoration. Four CSS-generated textures do all
the work: a 32px **grid** (masked so it fades out), a 3px **scanline** overlay, a 4px **dither**,
and the **horizon** gradient (panel-top → panel-bottom → black at 55%). The grid always fades
rather than terminating at an edge.

Two overlay treatments: a **scrim** (`rgba(0,0,0,.72)`) behind modals, and a **protection
gradient** (`linear-gradient(180deg, rgba(0,0,0,.85), transparent)`) wherever bitmap type sits over
imagery or the horizon. Capsules are not used for text protection — the gradient is.

Transparency and blur are rationed. `backdrop-filter: blur(2px)` appears in exactly two places:
the sticky site header and toasts. Panels use flat alpha (40% black, 20% white), never blur.

### Motion

One easing for everything mechanical: `cubic-bezier(.25,.8,.5,1)`, lifted from the source
framework. Durations: 120ms (hover), 300ms (state change), 600ms (screen), 1200ms (loading loop).

**Colour transitions are instant** — 1ms, straight from the source CSS. The era did not cross-fade
hues, and honouring that is a large part of why this reads as period-correct rather than retro-
flavoured. Positions, widths and opacities animate; colours cut.

Five keyframes ship: `psone-indeterminate` (the source's sweeping bar), `psone-blink` (1-step
square wave for `PRESS START` and advance carets), `psone-cursor` (4px caret nudge), `psone-spin`,
`psone-fade-up`. No bounces, no springs, no easing-out overshoot.

### Interaction states

- **Hover** — brighten the fill to the paired `-hi` colour. Never darken, never change opacity.
- **Press** — swap the tight hardware drop for the layered soft drop. No scale, no translate.
- **Selected** — a horizontal sweep (`transparent → accent → transparent`) plus a caret cursor in
  the placeholder hue on the left. The sweep is the system's selection idiom, from menu rows to
  table rows to switches.
- **Focus** — 2px solid outline in the placeholder olive, 2px offset. Visible, never removed.
- **Disabled** — grey plastic fill, `--text-disabled` ink, `pointer-events: none`.

### Layout

Content maxes at 1120–1200px on web with a 24px screen gutter; prose maxes at 68ch. Fixed elements:
the site header is sticky, mobile status and tab bars are pinned, hint bars pin to the bottom of
game and mobile screens, and the article aside is sticky at 80px.

Everything except the print artboards and mobile device frames is fluid — `max-width` not `width`,
`minmax(0,1fr)` grid tracks, wrapping flex rows. Print pages are fixed at 595×842 (A4 at 72dpi) so
PDF export sizes to the page.

Touch targets never go below 44px. Bitmap type never goes below 11px, body never below 14px.

---

## Iconography

**Font Awesome is the icon system.** The kit is embedded in every card and UI kit page:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

**One thing to know about the kit.** It is a Pro kit, and Pro kits only serve their icon payload to
domains on their allowlist. On preview, sandbox and localhost origins it loads its config and then
draws nothing. So `tokens/fonts.css` also `@import`s the Font Awesome **free** webfont CSS from
jsDelivr as a fallback, which means `fa-solid` / `fa-regular` / `fa-brands` classes render anywhere
the design system's `styles.css` is linked. Every glyph used across this system is in the free set,
so nothing changes visually. On an allowlisted domain the kit takes over and the fallback is inert.
If you would rather not ship the fallback, add your production domains to the kit and delete the
second `@import` in `tokens/fonts.css`.

Rules:

- **Solid style only.** No regular, no light, no thin, no duotone. Two exceptions, both for
  toggle-state clarity: `fa-regular fa-square` (Windows maximise key) and `fa-regular
  fa-bookmark` / `fa-regular fa-circle` (unfilled state next to a filled one).
- **Sizes.** 12px inside a 28px key, 16px in a tab bar, 19–20px in a marker disc or standalone,
  ~42–44% of the container edge when mounted in `IconButton` or `Glyph`.
- **Mounting.** Icons almost never float free. They sit in a moulded key (`IconButton`, square,
  4px radius) or a moulded disc (`Glyph`, pill radius, coloured glyph on grey plastic). Free-
  standing icons appear only inline in menu rows, tabs, buttons and toasts.
- **Colour.** `--grey-100` on hardware keys; the four marker hues on `Glyph`; status hues on
  toasts and validation. Icons never carry a text shadow — the stamp is for type only.
- **Brand icons** (`fa-brands`) are used for platform tabs and share rows.

**What is not used:** no icon font from the source (the framework's `.icon` classes were inline
base64 GIF sprites of specific hardware controls and game assets — trademarked, and excluded per
the brief), no hand-rolled SVG, no PNG icons, no emoji, no unicode symbols as icons. The only
unicode characters in the system are the en dash and the middot.

**Substitution flagged:** the source's four face-button glyphs, D-pad arrows, shoulder-button chips
and `START`/`SELECT` pills are hardware trade dress and were not reproduced. `Glyph` is the
replacement — same role (a coloured marker on moulded plastic mapped to an action in `HintBar`),
generic form, any Font Awesome glyph.

---

## Logo and imagery

**No logo was supplied and none was created.** Wherever a mark would go, the brand name is set in
the display face — `PS` in white, `One` in the olive placeholder hue. This appears in
`ui_kits/web/SiteShell.jsx` (`Wordmark`), the poster and back-insert layouts, the theme explorer
sidebar and `thumbnail.html`. If a real mark arrives, replacing `Wordmark` and the four literal
instances covers the whole system.

**No imagery ships either.** The system contains no photography or illustration. `ArtSlot` in the
web kit and the equivalent inline blocks elsewhere are texture-filled stand-ins that label what
belongs in the space. Replace them with real art rather than designing around them.

---

## Font substitutions — action needed

The source framework shipped four webfonts. Only one could be carried over:

| Source font | Status |
|---|---|
| `Play-Regular` | **Copied in** — `assets/fonts/Play-Regular.woff` / `.ttf`. OFL, safe to redistribute. Declared as `PSOne Display Local` and used as the offline fallback behind the Google Fonts copy of Play (which adds weight 700). |
| `Final Fantasy Script Collection – Final Fantasy VII` | **Not used.** A specific commercial game font and a direct identifier of the source. Substituted with **Chakra Petch** (body) and **Play** 700 (display). |
| `Pixel Cyr Normal` | **Not used.** Substituted with **Silkscreen** for all bitmap labels and HUD type. |
| `RationalTWDisplay` | **Not used.** It existed only to letter hardware key caps (`L1`, `START`) — those components are not reproduced. |

Google Fonts substitutions are loaded from `tokens/fonts.css`. **If you hold licensed files for
period-correct faces — particularly a bitmap face to replace Silkscreen and a squarish sans to
replace Chakra Petch — send them and I will self-host them and rewrite the `@font-face` rules.**

---

## Using this system

```html
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
<script src="_ds_bundle.js"></script>
<script type="text/babel">
  const { Panel, Button, MenuList } = window.PSOneDesignSystem_9ecbb5;
</script>
```

Set a theme on any ancestor: `<body data-theme="hyperdrive">`. Set `data-surface="paper"` on a
print artboard. Do not restyle a component from the outside — every component reads its colours,
spacing and shadows from the tokens, so change the token.

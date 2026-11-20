# Retro Neo Future — Design System

A retro-futurist hardware brand system: portable gaming devices, the desktop software that tunes them,
a companion phone app, in-game overlays, and printed collateral. The aesthetic is **platinum-era desktop
computing** — warm beige plastic, 1px ink hairlines, beveled chrome, hard offset shadows, bitmap chrome
labels, and a lit screen inset for anything that "displays" — carried forward with modern type and layout
discipline. Paper-first, mono-numeric, square-cornered, built so a single accent scheme can be swapped for
any of twelve without touching a component.

**This is an original system, not a recreation.** It was authored from an aesthetic brief plus a set of
reference links (below). No logo, wordmark, copy, image, font file, or component implementation was taken
from any referenced source; nothing in this project identifies any real company.

## Sources given to the author

Reference links (visual/tonal direction only — read for structure, page rhythm and product-page conventions):

- `https://ayaneo.com/`
- `https://ayaneo.com/product/AYANEO-Pocket-VERT`
- `https://ayaneo.com/support/video`
- `https://ayaneo.com/product/AYASpace-3`

Also supplied: an icon kit (Font Awesome kit `fde87cf732`) and thirteen Coolors palette URLs (one duplicated →
twelve unique schemes, all implemented in `tokens/themes.css`).

No codebase, Figma file, slide deck, or image asset was attached. Consequently: there is **no logo file**
(the brand name is set in display type wherever a mark would go), **no photography** (every image position is a
labelled `MediaFrame` placeholder), and **no supplied slide template** (so no slide kit was built).

## Products represented

| Surface | Kit | What it is |
|---|---|---|
| Marketing website | `ui_kits/website/` | Hero-led product marketing, filterable product grid, product detail page, support video row, footer |
| Desktop app — "Control Deck" | `ui_kits/desktop-app/` | Device management: library, performance telemetry, controller mapping |
| Mobile companion app | `ui_kits/mobile-app/` | Remote device status, quick power controls, store, profile |
| Game UI | `ui_kits/game-ui/` | In-game HUD, quick-settings overlay, big-picture library |
| Print | `ui_kits/print/` | Letter product one-sheet (paper mode) and a launch poster |

---

## CONTENT FUNDAMENTALS

**Voice.** Specification-first. State what a thing does and what it costs in watts, grams, hertz or hours.
Confidence comes from numbers, never adjectives.

- **Person.** Second person for instructions ("Press the menu button to summon quick settings"),
  no first person plural in product copy. The brand does not say "we believe".
- **Casing.** Sentence case nearly everywhere, including display headlines and button labels. UPPERCASE is
  reserved for kickers, micro-labels, badges and bitmap chrome labels — driven by CSS `text-transform`,
  never typed in caps.
- **Headlines.** 2–6 words in sentence case ("Handheld, rebuilt for the desk"). Archivo is a normal-width
  grotesk, so a headline can carry a clause; it still never runs to a full paragraph.
- **Kickers.** A category, not a tease: "New hardware", "Software", "Support", "Pre-order open".
- **Subheads.** One or two sentences, concrete: *"A vertical handheld built for the commute. Six-inch AMOLED,
  hall-effect sticks, and a 12-hour idle standby."*
- **Numbers.** Always mono, always with the unit: `54 W`, `120 Hz`, `640 g`, `3 h 10 m`, `88 °C`.
  Thin space before the unit, never "54W".
- **Feature names** are proper nouns and get quoted on first use: the "SnowZone" engine, "Smart Control" centre.
- **Buttons** are verbs: Pre-order, Install, Save layout, Scan again, Restart device. Never "Learn more"
  where "Full specs" is true.
- **Errors** state cause then remedy, no apology: *"Update failed — device disconnected at 62%."* + Retry.
- **Empty states** name the cause and offer one action: *"No games detected. Connect a device to sync your library."*
- **Emoji: never.** Not in UI, not in marketing, not in support copy. Iconography is Font Awesome.
- **Vibe.** A spec sheet that happens to be beautiful. Enthusiast, not childish; technical, not corporate.

---

## VISUAL FOUNDATIONS

### Colour
Paper-first. The default scheme ("Platinum Amber") is a warm platinum ramp — `#e9e3d3` desktop base,
`#fbf8f0` panels, `#ffffff` elevated, `#dad3c0` sunken — with ink `#1a1815` type, burnt amber `#e2661e`
as the single accent and a muted slate blue as secondary. Exactly one accent is live at a time.
Semantic colours (ok / warn / danger / info) are separate tokens and never double as brand colour.

Twelve interchangeable schemes ship in `tokens/themes.css`, applied with `data-theme="…"` on any ancestor:
`spectrum`, `arcade`, `cadet`, `sorbet`, `ember`, `coolant`, `cathode`, `bubblegum`, `seasignal`, `kiosk`,
`fatigue`, plus the unattributed default. Each scheme moves the paper tint, the accent trio, the semantics
and the screen colour together, so components need no per-theme code.
`data-mode="dark"` (alias `data-mode="crt"`) inverts the neutral ramp to a lit phosphor screen while accents
hold; `data-mode="light"` restores paper, so a two-way toggle works from any state.
**`assets/theme-switcher.js`** is a drop-in control (scheme select + Paper/Phosphor toggle, persisted in
localStorage) already wired into every UI kit `index.html`.

There is also a dedicated **screen** trio — `--screen-bg`, `--screen-fg`, `--screen-dim` — for anything
depicted as a display: device screens, boot sequences, HUD readouts, terminal panes. Screen insets stay dark
in paper mode; that contrast (beige case, black screen) is the core brand image.

### Type
- **Display + core: Archivo** (Google Fonts) — headlines at 600/700 with `-0.03em` tracking, sentence case;
  lead 19px, body 16px/1.6, small 14px.
- **Bitmap: Silkscreen** — chrome labels, wordmark lockups, boot screens, game-UI titles. 12px and 22px only,
  uppercase, never body copy.
- **Mono: IBM Plex Mono** — every number, spec value, timestamp, serial, and every micro-label.
- **Screen: VT323** — copy set inside a screen inset (`--text-crt`, 20px).
- **Serif: Bitter** — print body, spec-sheet prose, product-manual voice.
- **Labels** are mono, uppercase, `0.1em` tracked; **kickers** the same at `0.22em`.

### Spacing & layout
4px base scale, 14 steps. 24px inside cards, 24/48px gutters, 128px between marketing sections.
Content maxes at 1240px (1600px for full-bleed bands, 820px for prose). Controls are 30/38/48/58px;
touch targets never below 44px. Desktop rail 248px, collapsed 68px; title bar 44px; mobile tab bar 56px.
Fixed elements: the site header, the desktop title bar and rail, the mobile tab bar, and HUD corners.

### Backgrounds
No photographic backgrounds are shipped (none supplied). The system's own background language is
**flat platinum paper**, optionally a 24px hairline grid field (`.rnf-grid-bg`) or 4px horizontal
**pinstripes** (`.rnf-pinstripe`, the classic drag-bar texture). Screen areas use `.rnf-screen` and may add
`.rnf-scanlines` at 4–5% opacity. Full-bleed imagery sits behind a protection gradient
(`--grad-protect`) when type sits on it. Panels take a top-down white sheen (`--grad-panel`) rather than a
colour shift; chrome surfaces use `--grad-chrome` (white → platinum → sunken). No blurred-blob gradients,
no purple-to-blue meshes, no neon glow fields.

### Transparency & blur
Used sparingly — this is an opaque, physical system. Glass (`--glass-bg` + 6px blur + 1px ink stroke) is
reserved for things floating **over** content: sticky site header, HUD readouts, quick-settings overlay,
modal scrims. Never for a static panel in normal page flow.

### Borders, corners, shadows
1px ink hairlines everywhere (`--stroke-1` 28% for rules, `--stroke-2` 55% for controls, `--stroke-strong`
solid ink for window chrome and anything beveled); 2px only for focus and controller focus. Radii are small:
0 for chrome and screen insets, 2–3px chips and inputs, 4px controls and cards, 6px overlays, 10px large
panels, pill only for tags. **No chamfers** — `--chamfer` is 0 and the clip-path tokens resolve to a plain
rectangle (kept only so older markup still renders square).

Depth is **bevels and hard offset shadows**, never blur:
`--bevel-out` (1px white top-left, 1px ink bottom-right) raises chrome; `--bevel-in` recesses wells, inputs,
slider and segment tracks; `--sh-1`…`--sh-4` are hard `Npx Npx 0` ink offsets (`sh-4`, 5px, is the dialog
shadow). `--glow-accent` is no longer a glow: it is a 2px solid accent ring used for focus and active fills.

### Cards
Solid `--bg-panel`, 1px hairline, 4px radius, `sh-2` hard offset. Interactive cards go to `sh-3` and swap
the border to `--accent-line`. Optional 3px accent bar on the leading edge. Never stack more than two card
levels — use a `sunken` inner well instead of a third border.

### Motion
Fast and mechanical. 140ms for control feedback, 220ms for panels, 380ms for page-level transitions.
`--ease-out` for entrances, `--ease-snap` for overlays, `--ease-hard` for HUD elements.
Hover: 4% brightness, no lift, no hue change. Press: the bevel inverts (`--bevel-in`) and the fill darkens
10% — the classic push-in, not a scale. Focus: 2px ink/accent ring. No bounces, no springs, no parallax.
`prefers-reduced-motion` zeroes every duration.

### Platform chrome (desktop apps)
Two mutually exclusive components: **`TitleBar`** (classic-Mac pinstriped drag bar, close box left, zoom and
collapse boxes right) and **`TitleBarWin`** (Windows caption bar, app icon and title left, beveled
minimise / maximise / close right, caption filled with `--accent-2`). A product picks one at implementation
time; they are never rendered together. The desktop UI kit exposes the choice as a toggle purely to
demonstrate both.

### Imagery direction (for whoever supplies photography)
Warm, evenly lit studio product shots on light neutral seamless or platinum paper; long soft shadows,
slight film grain, colour grading warm-neutral. Screens photographed lit, never off. No cool blue rim-light
gaming looks, no lifestyle stock, no people mid-laugh.

---

## ICONOGRAPHY

Font Awesome, loaded from the supplied kit:

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

- **Style:** `fa-solid` for all UI, HUD and navigation. `fa-regular` only for decorative/marketing
  contexts (star, bookmark, user). `fa-brands` only for social links in the footer.
- **Sizing:** icons inherit `currentColor` and are sized in px alongside their label (11–19px in UI,
  26px in empty states). Never scaled above 26px as decoration.
- **API:** every component that takes an icon takes a **Font Awesome class string**
  (`icon="fa-solid fa-bolt"`), so consumers can use any glyph in the kit without new component code.
- **No SVG sprite, no icon font of our own, no PNG icons, no emoji, no unicode glyphs as icons** — with
  two deliberate exceptions in `ButtonPrompt`, where the Start/Select/system buttons use `≡ ⧉ ◎` because
  no controller glyph exists in the kit. Face buttons use letters (A/B/X/Y) in mono, colour-coded.
- **Recurring glyph vocabulary:** `bolt` power/TDP · `fan` cooling · `temperature-half` thermals ·
  `battery-three-quarters` battery · `gamepad` controller/library · `sliders` tuning · `microchip` silicon ·
  `display` screen · `snowflake` suspend/freeze · `download` updates · `gauge-high` frame rate.
- **Assets:** `assets/` holds no logos or photography — none were supplied. Do not invent a mark; set
  "Retro Neo Future" in bold Archivo (or Silkscreen for a chrome lockup) where a logo would go.
  `assets/theme-switcher.js` is the only shipped asset.

---

## Index

**Root**
- `styles.css` — the single entry point consumers link (imports only)
- `tokens/` — `fonts` · `colors` · `themes` (12 schemes + paper mode) · `typography` · `spacing` · `shape` · `elevation` · `motion` · `base`
- `guidelines/` — 25 specimen cards (Colors, Type, Spacing, Shape, Brand)
- `assets/theme-switcher.js` — drop-in scheme + Paper/Phosphor switcher

**Components** (each with `.jsx`, `.d.ts`, `.prompt.md`; one `@dsCard` per directory)
- `components/core/` — Button, IconButton, Badge, Tag, Card, StatBlock, Divider
- `components/forms/` — Input, Textarea, Select, Checkbox, Radio, Switch, Slider, SegmentedControl
- `components/navigation/` — TopNav, SideNav, Tabs, Breadcrumbs, TitleBar (macOS), TitleBarWin (Windows), TabBar
- `components/feedback/` — Dialog, Toast, Tooltip, ProgressBar, Spinner, EmptyState
- `components/data/` — SpecTable, DataGrid, Meter
- `components/media/` — MediaFrame, VideoCard, HeroBanner
- `components/game/` — ButtonPrompt, HudMeter, GameTile, QuickTile
- `components/print/` — Masthead, PullQuote

**Templates** (starting folders consuming projects copy — `templates/<slug>/<Slug>.dc.html`)
- `marketing-page` · `app-shell` (macOS chrome) · `app-shell-windows` (Windows chrome) · `mobile-screen` · `game-hud` · `print-one-sheet`

**UI kits** — `ui_kits/website` · `ui_kits/desktop-app` · `ui_kits/mobile-app` · `ui_kits/game-ui` · `ui_kits/print`
(each has its own README.md and an interactive `index.html`)

### Intentional additions
No source defined a component inventory, so a standard set was authored, plus five brand-specific families
the products require: **StatBlock** and **Meter** (the spec/telemetry readouts the brand is built on),
**MediaFrame** (owns aspect ratio + protection gradient so type never sits on bare imagery),
the **game** group (ButtonPrompt, HudMeter, GameTile, QuickTile — controller-first surfaces have no
web equivalent), and the **print** group (Masthead, PullQuote).

### Substitutions to flag
- **Fonts:** no font files were supplied. Archivo / Silkscreen / IBM Plex Mono / VT323 / Bitter are
  Google-hosted and imported by URL in `tokens/fonts.css` — no binaries ship. They stand in for the
  platinum-era originals (Chicago, Geneva, Monaco), which are not licensable here. Replace with real brand
  files if they exist.
- **Icons:** the supplied Font Awesome kit is used directly from its CDN; nothing was substituted.
- **Imagery:** all image positions are placeholder wells.

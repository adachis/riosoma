# Synthwave Design System

A complete, theme-able design language built on the visual grammar of 1980s retro-futurism: neon tube type over a deep indigo void, a banded sun on a scrolling perspective grid, chrome-airbrush display lettering, CRT scanlines and colour that behaves like light rather than paint.

It is deliberately **not** a music-scene skin. Every token, component and kit is generic: the same system dresses a marketing site, a desktop audio tool, an iOS app, an in-game HUD and a printed poster without changing its rules.

---

## Sources

This system was built from material supplied by the user. It is an **original design informed by** those references — no supplied artwork, logo, brand name or copy appears in the output.

| Source | What it is | How it was used |
| --- | --- | --- |
| `Synthwave Assets/` (attached local folder) | A licensed graphic-asset library: 16 display fonts, ~150 raster backdrops, a vector city skyline, a retro-futurist SVG element bundle, product mockups | Fonts and a curated subset of imagery were copied into `assets/`. Everything else was reference only. |
| 35 uploaded reference images (`uploads/`) | Screenshots and artwork: a synthwave radio web template, retrowave landing pages, arcade cabinets, CRT/TV frames, Photoshop text-effect previews, handheld-console poster art | Read for visual grammar (layout rhythm, glow behaviour, type treatment, colour relationships). None are shipped. |
| 12 Coolors palettes (URLs in the brief) | Colour scheme variants the user asked to support | Each became a `data-theme` variant. See **Themes** below. |
| Community CSS references (speckyboy synthwave snippet roundup, freefrontend pure-CSS synthwave animation, CodePen `Sam_sh/QWMGyJj`, gist `DerTyp7214/7adf2c816dd2…` synthwave.css, dashron.com V5 write-up, voidcomputing.hu synthwave-slides) | Technique references for layered neon `text-shadow`, banded sun masking, perspective grid animation and VHS chromatic split | Techniques informed `css/effects.css` and `css/controls.css`. No code was copied verbatim. |

**There is no logo.** The sources contain no brand mark, so none was invented. Wherever a mark would go, the system sets the product name in the display face — that is what `Wordmark` is for.

---

## Themes

Thirteen palettes. Every colour in the system resolves through semantic tokens, so switching is one attribute:

```html
<html data-theme="voltage">
```

| id | Name | Character |
| --- | --- | --- |
| `synthwave` | Synthwave *(default)* | Magenta / cyan / violet on indigo void |
| `spectrum` | Spectrum | Full warm-to-cool ramp on slate |
| `midnight` | Midnight Gold | Gold on navy — highest contrast, best for data |
| `voltage` | Voltage | Hot pink and amber on deep purple |
| `signal` | Signal | Red / powder blue on ink navy |
| `peach` | Peach Motel | Muted coral and sand — the softest variant |
| `dune` | Dune | Orange and mustard on petrol |
| `lagoon` | Lagoon | Mint and teal, low-aggression |
| `mint` | Mint Circuit | Aqua on near-black with coral alarms |
| `bubblegum` | Bubblegum | Pink / sky / peach, the most playful |
| `reef` | Reef | Crimson accent over sea-green |
| `ember` | Ember | Vermilion and butter on ocean blue |
| `sage` | Sage | Desaturated greens — quietest variant |

All thirteen are **dark-first**. The three palettes that are natively light (Signal, Peach Motel, Sage) were re-based onto a dark ground drawn from their own darkest hue, because neon depends on a dark field to read as light. There is no light mode; see *Caveats* in the project handoff.

Preview them in `guidelines/themes-overview.card.html` and `guidelines/themes-live.card.html`, or with the `ThemeSwitcher` component. **`ThemeSwitcher` is a documentation control — never ship it inside a product UI.** A product picks one theme and stays there.

---

## Content fundamentals

**Voice.** Confident, terse, slightly clipped — the register of equipment labelling and racing telemetry, not marketing. Short declaratives. No hedging, no exclamation, no jokes in system copy.

**Person.** Address the user as *you*. The product never says *I*. Never *we* in UI copy (only in marketing prose, sparingly).

**Casing.** This is the system's strongest content rule and it is mechanical:

| Element | Casing | Example |
| --- | --- | --- |
| Display / hero headline | ALL CAPS | `MIDNIGHT RUN` |
| Section heading, card title, button, nav item | ALL CAPS | `INSERT COIN`, `LATEST SIGNALS` |
| Eyebrow, field label, table header, status badge, tab, HUD label | ALL CAPS, mono, wide tracking | `NOW PLAYING`, `CHANNEL LEFT` |
| Body copy, hints, descriptions, dialogue | Sentence case | `Tune one in and it will appear here.` |
| Data values, timestamps, IDs | As-is, mono | `SW-0042-XR`, `00:42:18` |

If a string is set in `--font-heading` or `--font-mono`, it is uppercase. If it is set in `--font-body` at 14px or larger and forms a sentence, it is sentence case. There are no exceptions.

**Length.** Buttons: one or two words, verb first. Badges: one word or a version string. Eyebrows: two to four words. Card titles: under 40 characters. Empty states: one sentence plus a next step. Alerts: a 2–4 word title, one sentence of detail.

**Numbers.** Always numerals, never spelled out — `3 lives`, not *three lives*. Use the readout face for anything live or measurable. Thousands separators in scores and counts; none in IDs.

**Punctuation.** No terminal period on labels, buttons, badges, captions or single-sentence hints. Full stops inside multi-sentence prose. Use the middot `·` as the separator in metadata runs (`Cassette Nova · 1987 · 4:12`), never a pipe or a slash.

**Emoji: never.** Not in UI, not in marketing, not in docs. Every glyph in this system is Font Awesome or a typographic character. Unicode symbols are allowed only where they are functionally standard: `⌘`, `⌥`, `⇧`, `▶`, `×`, `·`.

**Words the system uses.** *Signal, relay, channel, session, run, archive, feed, deck, terminal, station.*
**Words it avoids.** *Awesome, magic, simply, just, seamless, delightful, effortless, unleash, supercharge.*

**Examples that are correct:**

> Eyebrow: `NOW PLAYING` — Title: `Night Patrol` — Meta: `Cassette Nova · 1987 · 4:12`
> Empty state: `No stations yet` / `Tune one in and it will appear here.` / button `Add a station`
> Alert: `Signal lost` / `Relay 4 stopped responding. Retrying in 30 seconds.`
> Destructive confirm: `Eject cartridge?` / `Unsaved progress in this session will be lost.` / `Cancel` `Eject`

---

## Visual foundations

### Colour

Colour is treated as **emitted light on a dark field**, not pigment on paper. The ground is always the darkest thing on screen; accents are the only saturated elements; neutral greys barely exist — the "greys" are desaturated tints of the theme's own base hue, generated by mixing the base toward white.

Six background steps (`--bg-void` → `--bg-overlay`), four ink steps (`--text-primary` → `--text-faint`), three accents, four semantics. Accent 1 (magenta in the default theme) is the action colour. Accent 2 (cyan) is the *information* colour — links, focus rings, labels, readouts. Accent 3 (violet) is structural: it tints surfaces, grids and glass, and rarely appears at full strength.

Never more than **two saturated colours on a single surface**. Never a saturated background behind body copy.

### Type

Five roles, and each one has exactly one job:

| Token | Face | Job |
| --- | --- | --- |
| `--font-display` | Static Surge | Hero headlines, 40px and up. Uppercase. |
| `--font-heading` | Neon Sugarez | H1–H6, buttons, nav, card titles, tabs. Uppercase, +0.06em. |
| `--font-body` | Chakra Petch *(Google Fonts)* | All running copy, inputs, list rows. |
| `--font-mono` | JetBrains Mono *(Google Fonts)* | Labels, code, eyebrows, metadata. Uppercase where it is a label. |
| `--font-readout` | Mono Circuit | Live numerics — clocks, telemetry, BPM, coordinates. Glows. |
| `--font-pixel` | Pixelvolt | Game scores only. Nowhere else. |

Four alternate display faces (Playback, Binko, Redsun, Vapor Synth) ship for campaign work. One per artefact, never mixed.

Scale is a 1.25 major third off 16px, 10px → 140px. Line height: `.92` on display, `1.2` on headings, `1.6` on body. Body copy never goes below 14px on screen or 12pt in print; slide text never below 24px.

### Spacing and layout

4px grid, `--sp-1` (4px) → `--sp-14` (176px). Control heights are 28 / 38 / 50px with a 44px minimum touch target on mobile. Containers: 640 / 900 / 1180 / 1440px with a 24px gutter (48px above 1180).

Layout is **orthogonal and edge-aligned**. Content sits in hard rectangles; nothing floats at an angle except deliberate HUD skew (18°) and the perspective floor. Sticky headers are 60px; desktop title bars 34px; sidebars 248px.

### Backgrounds

Three registers, and a screen uses one of them:

1. **Flat void** — `--bg-base`, optionally with `--flat-grid` at 13% opacity. The default for anything with reading or working in it.
2. **The horizon** — `GridHorizon`: banded sun, glowing horizon line, scrolling perspective floor, twinkling starfield. Full-bleed, one per screen, only behind heroes, splash screens, game menus and section breaks.
3. **Photographic** — a licensed backdrop from `assets/img/` at 40–60% opacity under a `--bg-void` scrim, with `--scanline` over it. Only when the image is the content.

Repeating patterns (`--scanline`, `--grain`, `--hatch`, `--flat-grid`) are all textures, never focal. Gradients are used for the sky, the sun, the neon rule and the chrome type fill — never as a decorative panel background, and never the bluish-purple "SaaS gradient".

### Borders, radii, corners

Corners are mostly **sharp**: 3px (`--r-sm`) is the working default, 5px for cards, 0 for anything inside a HUD. Pills (`--r-pill`) are reserved for tags, switches and progress tracks. The **chamfer** — a diagonal cut on the top-left and bottom-right corners — is the arcade-cabinet edge; it belongs on game UI, hero CTAs and HUD panels, nowhere else.

Borders are 1px hairlines. `--border-subtle` separates; `--border-default` encloses an interactive control; `--border-strong` marks an emphasised or focused edge. A 2px border only ever appears as a bottom edge on a keycap.

### Shadow and glow

Neutral drop shadow exists (`--sh-1` → `--sh-4`) but it is structural, not expressive: a 1px white inset highlight plus a soft black cast. **Elevation that matters is expressed as coloured bloom**, not as a darker shadow. `--glow-accent` / `--glow-accent-2` are a 1px coloured ring plus two blur radii. Recessed surfaces use `--sh-inset`.

Text glow (`--text-glow`) is a two-layer shadow; the full four-layer tube glow lives in `.sw-neon` and is reserved for `NeonSign`.

### Transparency and blur

Used in exactly three places: chrome bars and tab bars (`backdrop-filter: blur(14px)` over a 4–6% accent-3 tint), modal scrims (68% black + 6px blur), and HUD panels over live gameplay (6px blur). Never on cards, never on body text, never as a decorative "glassmorphism" panel.

Text on top of imagery gets a **scrim, not opacity** — a `--bg-void` gradient behind the text block. Type is never dimmed with alpha; it stays at full opacity so contrast holds.

### Motion

Everything animates on the **CRT model**: hardware snaps on, light decays off.

- `--ease-out` `cubic-bezier(.16,.84,.3,1)` — reveals, entrances, hovers
- `--ease-in` — exits
- `--ease-inout` — loops and sweeps
- `--ease-snap` `cubic-bezier(.2,1.5,.4,1)` — the switch thumb, and nothing else

Durations: 80 / 140 / 220 / 380 / 640ms. Hovers are 140ms. Panels 220ms. Nothing crosses 640ms except idle loops.

Idle loops belong to the brand, not to interaction: `sw-flicker` (failing tube, 5.5s), `sw-scroll-grid` (3s), `sw-pulse`, `sw-marquee`, `sw-sweep`, `sw-typewriter`. Use at most one per screen. Everything respects `prefers-reduced-motion`.

### Interaction states

| State | Treatment |
| --- | --- |
| Hover, filled | Lighten the fill 18% and add a two-radius accent bloom. Never darken. |
| Hover, outline / ghost | Fill at 12–14% accent, brighten the border and the label. |
| Hover, card | `translateY(-2px)`, border shifts to cyan, shadow deepens and gains bloom. |
| Hover, link | Colour brightens, underline goes to full accent, text picks up cyan glow. |
| Press | `translateY(1px)`, fill darkens 18%, **bloom removed** — the light goes out under the finger. |
| Focus | 2px base-coloured ring + 2px cyan ring + a 16px cyan halo. Always cyan, in every theme. |
| Selected | Accent fill at 13% plus a 2px inset accent rail on the leading edge. |
| Disabled | `opacity: .38`, pointer events off, all glow removed. |

### Imagery

Cool-dominant, high-saturation, high-contrast: magenta and cyan light sources against near-black, wet reflective surfaces, atmospheric haze, visible film grain. Warm colour appears only as sunset gradient or sodium street light. No daylight, no white studio backgrounds, no stock-photo people. Images are usually masked to a hard rectangle with a hairline border and given a `--scanline` overlay.

---

## Iconography

**Font Awesome 6, via the user's kit `559791bdc6`.** The source library shipped no icon set of its own — the only vector assets were illustration-scale SVGs, not UI glyphs — so Font Awesome is the system's icon family. This is a documented substitution, not a set lifted from the sources.

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Every card, kit and template in this project loads that line.

- **Weight:** `fa-solid` is the default and covers ~95% of usage. `fa-regular` marks the *off* state of a toggleable icon (bookmark, heart, star). `fa-brands` for platform marks only. Light/thin/duotone are not used.
- **Size:** icons inherit `font-size` from their context. 14px in dense chrome, 16–17px in nav and tab bars, 19px on toolbars, 26–30px in empty states. Never below 12px.
- **Colour:** icons take `--text-secondary` at rest and `--accent-2` on hover, except inside a filled button where they take the button's ink colour. Accent-coloured icons signal state, not decoration.
- **Pairing:** an icon beside a label sits 10px from it (`--gap-inline`) and never replaces the label in primary navigation. Icon-only controls always carry an `aria-label` — that is why `IconButton.label` is required.
- **Wrapper:** use the `Icon` component rather than raw `<i>` tags so the family stays swappable.
- **Never:** emoji, hand-drawn SVG glyphs, PNG icons, or Unicode pictographs. The three approved non-Font-Awesome glyphs are `⌘ ⌥ ⇧` in keycaps and `·` as a metadata separator.
- **Illustration** is a separate concern: the vector scenes in `assets/img/*.svg` (city skyline, grid horizon, HUD elements, vehicles, retro gadgets) are decorative artwork, sized 200px and up, never used as interface icons.

---

## Assets

| Path | Contents |
| --- | --- |
| `assets/fonts/` | Eight licensed display/mono faces (see Type). Body and code faces come from Google Fonts. |
| `assets/img/*.jpg` | Photographic backdrops — cosmic, city lights, geyser, grid paper, city paper |
| `assets/img/*.png` | Cut-out synthwave landscapes with transparent skies |
| `assets/img/*.svg` | Vector illustration scenes: city skyline, city horizon, grid horizon, HUD elements, vehicles, retro gadgets |

---

## Components

Fifty-four React primitives. No source defined a component inventory, so this is an authored standard set sized to the five target surfaces (web, desktop, mobile, game, print).

**Core** — `Button` · `IconButton` · `Icon` · `Badge` · `Tag` · `Kbd` · `Divider`

**Brand** — `Wordmark` · `NeonSign` · `GridHorizon` · `ThemeSwitcher`

**Forms** — `Field` · `Input` · `Textarea` · `Select` · `Checkbox` · `Radio` · `Switch` · `Slider` · `SearchField`

**Surfaces** — `Card` · `Panel` · `StatTile` · `Modal` · `Drawer` · `Tooltip`

**Navigation** — `NavBar` · `Sidebar` · `Tabs` · `SegmentedControl` · `Breadcrumbs` · `Pagination` · `Menu`

**Feedback** — `Alert` · `Toast` · `ProgressBar` · `Spinner` · `Skeleton` · `EmptyState`

**Data** — `Table` · `ListRow` · `Avatar` · `MetricReadout`

**Chrome** — `MacWindow` · `WindowsWindow` · `LinuxWindow` · `PhoneFrame` · `MobileTabBar` · `AppBar`

**Game** — `HUDPanel` · `StatBar` · `GameMenu` · `ScorePanel` · `DialogueBox` · `AbilitySlot`

**Print** — `PrintSheet` · `PullQuote` · `Caption`

### Intentional additions

- `Icon` — a wrapper over the Font Awesome kit, so the glyph family is swappable in one place.
- `ThemeSwitcher` — documentation-only control for previewing the thirteen palettes.
- `GridHorizon`, `NeonSign`, `Wordmark` — brand primitives. They encode the signature motifs so they are reproduced identically rather than hand-rolled per project.
- The `chrome/`, `game/` and `print/` groups exist because the brief names desktop apps, game UI and print as first-class surfaces.

---

## Index

| Path | What it is |
| --- | --- |
| `readme.md` | This file — context, sources, content and visual foundations, iconography, index |
| `styles.css` | Global entry point. `@import` list only — link this one file |
| `tokens/` | `fonts.css` `themes.css` `typography.css` `spacing.css` `effects.css` `motion.css` `base.css` `utilities.css` |
| `css/` | Component stylesheets: `controls` `forms` `surfaces` `navigation` `feedback` `data` `chrome` `game` `effects` `print` |
| `components/<group>/` | React primitives — `.jsx`, `.d.ts` props contract, `.prompt.md` usage note, one `@dsCard` preview per group |
| `guidelines/` | 25 foundation specimen cards (Colors, Themes, Type, Spacing, Brand, Motion) |
| `ui_kits/<product>/` | Full-screen recreations — see below |
| `assets/` | Fonts and imagery |
| `thumbnail.html` | Homepage tile |

### Templates

Copy a `templates/<slug>/` folder into a consuming project and edit the `base` line in its `ds-base.js`.

| Template | Entry | What it starts you with |
| --- | --- | --- |
| Marketing Page | `templates/marketing-page/MarketingPage.dc.html` | Grid-horizon hero, metric row, feature grid, split showcase, CTA, footer |
| Desktop App | `templates/desktop-app/DesktopApp.dc.html` | Window chrome (switchable macOS / Windows / GNOME), sidebar, toolbar, table, inspector |
| Mobile App | `templates/mobile-app/MobileApp.dc.html` | iOS feed screen and Android player screen, side by side |
| Game HUD | `templates/game-hud/GameHud.dc.html` | 16:9 overlay — vitals, countdown, score, minimap, hotbar, dialogue |
| Print Poster | `templates/print-poster/PrintPoster.dc.html` | 18 × 24 in poster, print-ready at 1:1 |

### UI kits

| Kit | Surface |
| --- | --- |
| `ui_kits/web/` | Marketing site — hero, programme grid, article, footer |
| `ui_kits/desktop/` | Desktop application in all three window chromes, plus dialog and palette window types |
| `ui_kits/mobile/` | iOS and Android app, side by side, with platform-correct chrome |
| `ui_kits/game/` | Title screen, in-game HUD, pause menu |
| `ui_kits/print/` | Poster, editorial spread, event flier |

# Gamer Design System

A cross-surface design system for competitive-gaming products: esports and tournament
sites, game-launcher desktop apps, companion mobile apps, in-game HUD and menu screens,
and printed event collateral. The visual language is **dark, high-contrast, angular and
loud** — deep indigo surfaces, one saturated accent doing all the emphasis work, wide
uppercase display type, chamfered panel silhouettes, and glow instead of shadow.

"Gamer" is the system's own name. It is not a real company's brand, and it deliberately
carries no product identity of its own beyond the wordmark set in type.

---

## SOURCES

Two purchased HTML site templates were supplied as the visual reference, uploaded as zips
and expanded into the project:

| Source | Path in project | What was read |
| --- | --- | --- |
| Esports / gaming site template ("bonx", HTML version, 2025-08-28) | `uploads/bonx-gaming-website-template-html-version-2025-08-28-06-39-43-utc/bonx/` | `assets/scss/_variabls.scss`, `assets/scss/_common.scss`, `assets/scss/section/*.scss`, `index.html`, page inventory |
| Metaverse / IGO launchpad template ("gameon" v2.0, 2025-03-24) | `uploads/gameon-metaverse-igo-launchpad-html-template-2025-03-24-16-28-49-utc/gameon-template-v2.0/` | `assets/css/style.scss` (3,610 lines — root tokens, buttons, cards, header, modal, blog), `index.html` |

No Figma file, repository, or brand book was supplied. There is no source of truth beyond
those two codebases, so everything here is derived from their **CSS and markup**, not from
screenshots.

### What was deliberately NOT carried over

Per the brief, this system is *inspired by* the sources and must not identify them:

- **No source imagery.** Not one `.webp`/`.jpg`/`.png` from either template was copied.
  All picture areas in the cards and UI kits are neutral placeholder wells
  (`components/media/ImageWell`) that a consuming project fills with its own art.
- **No source logos or brand marks.** Neither template's mark was copied, and none was
  drawn from scratch. Wherever a mark would sit, the system renders the wordmark
  **"GAMER"** in `--font-display` (see `components/brand/Wordmark`). *If you want a real
  logo, supply an SVG and it drops into `assets/logo.svg` — the Wordmark component and
  `thumbnail.html` pick it up.*
- **No source copy, product names, or names of people.** All sample copy in this system
  was written fresh for it.
- **No source fonts.** Both templates ship licensed commercial faces (a wide sci-fi
  display face and a squarish techno grotesque, plus a grunge display used for hero
  headlines). Those `.otf`/`.ttf`/`.woff` binaries were not copied. See
  **FONT SUBSTITUTIONS** below.

---

## PRODUCT SURFACES COVERED

The sources are websites, so the web surface is the closest recreation; the other four
surfaces are the *same* visual language applied without softening it, as instructed.

| Surface | UI kit | Notes |
| --- | --- | --- |
| Web pages | `ui_kits/web/` | Marketing home, tournament/leaderboard, article, auth. The most literal reading of the sources. |
| Desktop app | `ui_kits/desktop/` | Game-launcher shell inside macOS, Windows 11 and Linux (GNOME-style) window chrome — all three chrome types, plus dialog and utility-window variants. |
| Mobile app | `ui_kits/mobile/` | Companion app in iOS and Android frames: match feed, profile, live match, bottom-sheet. |
| Game UI | `ui_kits/game/` | In-match HUD, pause menu, loadout/inventory, end-of-match scoreboard. Same tokens, no re-styling toward conventional game-art idiom. |
| Print | `ui_kits/print/` | Event programme spread, poster, ticket, roster sheet — CMYK-safe variants of the same palette. |

---

## CONTENT FUNDAMENTALS

### Voice

Terse, second-person, competitive. The system talks to a player who is already in the
scene and does not need the category explained. It never apologises, never hedges, and
never uses corporate softeners ("we're excited to", "simply", "just").

### Casing rules (these are load-bearing)

| Element | Casing | Example |
| --- | --- | --- |
| Eyebrow / kicker | ALL CAPS, `--ls-eyebrow` (0.24em) | `SEASON 07` · `HOW IT WORKS` · `LIVE NOW` |
| Display + H1–H3 | ALL CAPS | `BEST OF FIVE STARTS NOW` |
| H4–H6, card titles | Title Case | `Upcoming Matches` · `Verify Your Roster` |
| Body copy | Sentence case | `Stake your entry before the lobby locks.` |
| Buttons / CTAs | Title Case, 1–3 words | `Play Now` · `Join Queue` · `Load More` |
| Labels, table headers, stat captions | ALL CAPS, `--ls-label` (0.08em) | `K/D` · `WINRATE` · `PRIZE POOL` |
| Numerals, timers, scores | `--font-mono`, tabular | `02:41:09` · `1,284 PTS` |

### Length discipline

- Eyebrow: one or two words. Never a sentence.
- H1/display: 3–7 words. It is set at 72–120px; anything longer breaks the layout.
- Supporting paragraph under a heading: one sentence, 12–22 words. Two at most.
- Card body: 15–30 words.
- Button: 1–3 words, verb-first. `Participate`, not `Click here to participate`.
- Empty states: one line, no apology. `No matches queued.` not `Sorry, we couldn't find…`

### First / second person

Second person for anything the user acts on ("Your roster", "Join queue", "Verify wallet").
First-person plural only in legal/support prose ("We hold entry fees in escrow until the
bracket closes."). Never first-person singular.

### Numbers and units

Always numerals, never spelled out — `3 rounds`, not `three rounds`. Thousands separators
in scores (`12,480`). Timers are always `HH:MM:SS` or `MM:SS`, monospace, zero-padded.
Percentages have no space (`64%`). Currency and token amounts keep the ticker after the
value (`0.89 USDC`, `1,200 GC`).

### Emoji

**Never.** Not in UI, not in marketing copy, not in empty states. Icons are Font Awesome
glyphs (see ICONOGRAPHY). Unicode symbols are used only as typographic furniture: `·`
between metadata items, `→` never (use the Font Awesome arrow so it inherits the icon
sizing), `/` in stat pairs (`K/D`).

### Punctuation

- No exclamation marks in UI. One is permitted per marketing page maximum, and only in a
  display headline.
- No em dashes in UI labels; they're fine in long-form editorial copy.
- Headlines take no terminal period. Body paragraphs do.
- Ellipsis only for in-progress states (`Matchmaking…`), never for suspense.

### Worked examples

```
EYEBROW      SEASON 07
HEADLINE     THE BRACKET IS OPEN
SUPPORT      Sixty-four teams, one weekend, a single-elimination run to the final.
CTA          Enter Team          (secondary: View Bracket)
```

```
EYEBROW      HOW IT WORKS
HEADLINE     THREE STEPS TO THE LOBBY
CARD TITLE   Verify Your Roster
CARD BODY    Every player signs in once. Substitutes are locked when the bracket seeds.
```

```
STAT BLOCK   PRIZE POOL   $250,000
             TEAMS        64
             STARTS IN    02:41:09
```

Bad, and why:

- `Welcome to our amazing tournament platform! 🎮` — first person, exclamation, emoji.
- `Simply click here to get started` — softener, non-verb CTA, vague.
- `Three matches remaining` — number should be a numeral.
- `Sorry, no results found.` — apology in an empty state.

---

## VISUAL FOUNDATIONS

### Colour

The system is **one accent, many surfaces**. A screen shows four to five steps of the
indigo surface stack, one accent used sparingly, and status colours only where status
actually exists. Two accents appear together only in the gradient (`--gradient-accent`,
135°/150° accent-2 → accent) which is reserved for: the primary button fill, gradient
text on a display headline, active pagination/tab, and the animated top border of a
featured card. Never as a page background — the sources never do this, and neither do we.

Surfaces step, they don't shade: `--surface-base` (page) → `--surface-1` (section band) →
`--surface-2` (card) → `--surface-3` (control inside card / hover). Because each step is a
real token, a card on a card on a card still reads.

**Amount of accent on screen: under 5% of pixels.** If a mock looks accent-heavy, the
problem is usually that a surface step was skipped.

Twelve alternative schemes ship as `[data-theme]` scopes in `tokens/themes.css` — ten dark
and two light (`soft-arcade`, `moss`). Every component reads the semantic aliases in
`tokens/semantic.css` only, so all twelve work everywhere without component changes. Light
schemes are the correct choice for the print surface.

### Type

Three faces, strict division of labour:

- `--font-display` (Michroma) — the wordmark, hero display lines, and nothing else. Wide,
  monoline, all-caps, no lowercase permitted. Never below 24px. Never for more than one
  line of running text.
- `--font-heading` (Oxanium) — H1–H6, buttons, nav, labels, tabs, table headers. Squarish
  and slightly condensed; carries the "gamer" register at small sizes where the display
  face would be illegible.
- `--font-body` (Exo 2) — all running text and form fields. `--ls-body` 0.02em and a
  generous 30px line-height on 16px body, carried over from the source.
- `--font-mono` (JetBrains Mono) — scores, timers, IDs, wallet strings, code.

The scale is not a modular ratio; it's the source's own ladder
(`120 / 72 / 55 / 32 / 25 / 19 / 16`). Do not interpolate new steps.

### Spacing and layout

The spacing ladder is a **5px step scale** (`--sp-1`…`--sp-19` = 5…150px), matching the
source's utility classes. It is not a 4/8 grid — do not snap values to powers of two.

- Section rhythm: `--section-pad-y` 130px top and bottom, 150px when a section follows a
  hero. This is large on purpose; sections read as separate screens.
- Content container: `--container-max` 1200px, narrow variant 970px, gutter 15px.
- Full-bleed layouts inset from the viewport edge by `--page-pad-x` 92px on wide screens,
  collapsing to 15px on tablet and 0 on mobile.
- Fixed elements: the header is the only fixed chrome on web. It starts transparent over
  the hero, then on scroll becomes `position: fixed` with an 0.9-alpha surface tint, a
  1px `--shadow-xs`, and enters with `gds-fade-in-down` over 900ms
  (`--ease-entrance`). Mobile uses a 290px left off-canvas drawer, not a fixed nav.

### Backgrounds

Layered, never flat, never a raw gradient sheet:

1. A dark base colour (`--surface-base`).
2. A photographic or artwork layer, always behind a scrim
   (`linear-gradient(0deg, base, base 5% transparent)` → `--gradient-scrim`) so text
   contrast is guaranteed. The sources set these `background-attachment: fixed`,
   `background-size: cover`, `background-position: center` — keep that.
3. Optional decorative shapes: hard-edged angular slabs and thin diagonal rules in
   `--surface-2`/`--surface-3`, plus a slow `gds-float` (±30px over 3s,
   `--ease-float`) on one or two of them. No blobs, no mesh gradients, no noise-blur
   soup.
4. A faint repeating diagonal hatch at 3–5% opacity is the only texture the system uses.

Imagery direction: **cool and contrasty.** Blue-shifted shadows, hard rim light, crushed
blacks, saturated highlights. Portrait crops are tight and shot from slightly below. No
warm filmic grades, no beige, no lifestyle stock. Grain is acceptable at low amounts on
full-bleed hero art; never on UI.

### Borders

The system's structural device. `--border-width` is **2px**, not 1px — a 2px
`--border-subtle` line is how a card, input, tab or panel is defined. 1px is reserved for
hairline dividers inside a card (`--border-hairline`, white at 12%) and for the fixed
header's bottom edge. Dashed 1px is used for `hr` only.

### Corners and the chamfer

Two silhouette families, used deliberately:

- **Rounded** — radii `5 / 8 / 10 / 15 / 38 / 50 / pill`, all straight from the source.
  10px is the default for inputs and small cards, 15px for panels, 38px for large media
  and feature cards, 50px for hero/profile slabs, `--r-pill` for buttons and chips.
- **Chamfered** — `--cut-sm/md/lg/tr/br/tab/blade` clip-paths in `tokens/shape.css`. The
  house cut is a **14px 45° notch on the top-left and bottom-right** corners. Use it for
  HUD frames, game menu panels, desktop-app side rails, tier/rank plates, and any panel
  that should read as "system" rather than "content".

Never mix both on the same element. Never chamfer body-copy containers.

### Shadow, glow, transparency and blur

Shadows are almost absent: `--shadow-xs` on the sticky header, `--shadow-sm`
(`0 3px 20px rgba(0,0,0,.14)`) on resting cards, `--shadow-md` on hover, `--shadow-lg`
on modals only. There is no shadow ladder for decoration.

**Emphasis is glow, not shadow.** `--glow-ring` (2px accent ring) marks focus and
selection; `--glow-md`/`--glow-lg` mark live, active or primary; `--glow-inner` lights the
inside of a HUD frame. `gds-pulse-glow` (2s) marks a live/recording state and nothing else.

Transparency and blur appear in exactly four places: the scrolled header tint (0.9 alpha,
no blur), modal scrims (`--surface-overlay`, 0.82–0.88 alpha), glass overlays on top of
imagery (`--surface-glass` + `--blur-md`), and the mobile bottom-sheet handle area. Blur is
never applied to a solid-surface panel.

Protection: text over imagery always gets a **gradient scrim**, not a capsule. Capsules
(`--r-pill` chips on `--surface-overlay`) are used only for small metadata badges pinned
onto a thumbnail corner.

### Cards

The default card: `--surface-2` fill, no border, `--r-md` 8px, `--pad-card` 24px,
`--shadow-sm`, and on hover `translateY(-5px)` plus `--shadow-md` over 300ms with
`--ease-out`. A feature card takes 38px radius and 40px/32px padding instead. A "system"
card takes `--cut-md`, a 2px `--border-subtle`, and no lift on hover. Cards never carry a
coloured left border, and never a rounded-corner-plus-accent-stripe treatment.

Card internals: media well flush to the top with a 6px inner radius, 35px gap to the body,
footer separated by a 1px hairline with 30px vertical padding.

### Animation

- Standard transition: `all 300ms ease` (`--t-base`). Emphasis: `400ms
  cubic-bezier(.645,.045,.355,1)`.
- Entrances: fade + 20px translate, 900ms, `--ease-entrance`. Staggered 80ms per item in a
  grid. Section content animates in once, on first scroll into view.
- Ambient: `gds-float` on decorative shapes and hero art (3s, ±30px). `gds-wave` —
  two expanding rings behind a circular play button, 4s, 0.5s apart. `gds-spin` for the
  8em preloader ring. `gds-scan` for a loading sweep across a progress bar.
- Never: bounce/elastic easing, spring physics, parallax scroll-jacking, page-transition
  wipes, animated gradients on large areas.

### Hover and press states

| Element | Hover | Press |
| --- | --- | --- |
| Primary button | Gradient stays, `--shadow-md` appears, contained icon slides `--nudge-x` 6px right | `scale(0.97)`, no colour change |
| Ghost / bordered button | Fill animates in from transparent to accent, text flips to `--on-accent` | `scale(0.97)` |
| Card | `translateY(-5px)`, `--shadow-md`, footer hairline brightens to white 25% | none (whole card is the target) |
| Nav link | Colour → `--accent`; 2px accent underline grows from left | Colour → `--accent-lo` |
| Icon button | Background → `--surface-3`, icon → `--accent` | `scale(0.94)` |
| Text link | Colour → `--accent-hi` | Colour → `--accent-lo` |
| Thumbnail | Image `scale(1.06)`, scrim opacity 0 → 0.6, action chip fades in | none |
| Disabled anything | `opacity: 0.4`, `cursor: not-allowed`, no state changes at all |

Hover *never* works by lowering opacity on interactive elements — the one exception is the
source's own primary-button treatment, kept at `--hover-opacity` 0.8 for the
image-backed legacy button variant. Hover never changes an element's size except the
card lift and thumbnail zoom.

### Focus

`outline: 2px solid var(--accent); outline-offset: 2px` globally, plus `--glow-ring` on
form controls. Focus is never removed. Keyboard focus on a game-UI element also brightens
its chamfer border to `--accent`.

---

## ICONOGRAPHY

### The set

**Font Awesome 6 (Pro kit `fde87cf732`), loaded from the user's kit CDN.** Both source
templates use icon *fonts* — one bundles an `icofont` webfont (`.eot/.ttf/.woff/.woff2`),
the other loads Font Awesome plus a small custom `icons.min.css` set. Rather than ship
either licensed set, this system standardises on the Font Awesome kit supplied with the
brief, which is the closest match in weight and metaphor to what the sources use.

Load it once per page, in `<head>`:

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

Then use the `Icon` component (`components/core/Icon`), which wraps `<i class="fa-…">` so
sizing, optical alignment and colour inheritance are consistent:

```jsx
<Icon name="rocket" style="solid" />
<Icon name="arrow-right" size="sm" />
```

### Rules

- **Style:** `fa-solid` is the default and covers ~90% of usage — it matches the filled,
  chunky icons in both sources. `fa-regular` for toggled-off states (unfavourited,
  unwatched). `fa-brands` for platform and social marks only. No `fa-light`/`fa-thin` —
  they read as a different brand.
- **Size:** icons inherit `font-size` from their label. Standalone icon buttons use 16px
  (small), 20px (default), 24px (large). Never below 12px. Never scale an icon
  non-uniformly.
- **Colour:** icons inherit `currentColor`. An icon is accent-coloured only when it marks
  state (live, verified, locked) or sits inside a feature block; decorative icons in
  running text are `--text-muted`.
- **In buttons:** icon before the label, 8px gap (`me-2` equivalent). Arrow icons go
  *after* the label and slide 6px right on hover. Both patterns come straight from the
  sources.
- **Feature icons:** 32–48px, accent-coloured or gradient-clipped
  (`.gds-gradient-text` works on a glyph), optionally inside a 64px `--cut-md` plate on
  `--surface-3`.
- **Never:** emoji as an icon, hand-drawn inline SVG, PNG icons, or two icon sets on one
  screen.

### Common glyph vocabulary

`trophy` (tournament) · `crosshairs` (match) · `users` (team) · `user-astronaut`
(player) · `bolt` (live/energy) · `fire` (streak/hot) · `medal` (rank) ·
`chart-line` (stats) · `coins` (currency) · `wallet` (account) · `gamepad` (game) ·
`headset` (comms) · `lock`/`unlock` (tier gating) · `shield-halved` (verified) ·
`clock` (countdown) · `rocket` (launch/enter) · `arrow-right` (advance) ·
`chevron-down` (disclosure) · `bars` (menu) · `xmark` (close) · `play` (video) ·
`circle-dot` (live indicator) · `plus`/`minus` (quantity) · `magnifying-glass` (search).

### Assets present

`assets/` contains no bitmap imagery and no logo, by design (see SOURCES → *What was
deliberately NOT carried over*). It holds the placeholder-well pattern only. **If you
supply a logo SVG and hero/thumbnail art, drop them in `assets/` and the Wordmark
component plus every `ImageWell` in the UI kits will use them.**

---

## FONT SUBSTITUTIONS — ACTION NEEDED

The source templates' display faces are licensed commercial fonts and were not copied.
Google Fonts stand-ins were chosen for shape, not name:

| Role | Source used | This system uses | Why |
| --- | --- | --- | --- |
| Display / wordmark | A wide monoline sci-fi face, plus a grunge display for hero lines | **Michroma** | Same very-wide monoline all-caps proportions |
| Headings / UI | A squarish techno grotesque with a 900 weight | **Oxanium** | Closest squarish-terminal geometric sans on Google Fonts, with 400–800 |
| Body | Exo / Poppins | **Exo 2** | Direct successor to the face one source used |
| Mono | none | **JetBrains Mono** | Tabular figures for scores and timers |

**If you have the real font files, send them and I'll swap the `@font-face` block in
`tokens/fonts.css`; nothing else needs to change.**

---

## INDEX

### Root

| File | What it is |
| --- | --- |
| `styles.css` | Global entry point. `@import` list only — link this one file. |
| `readme.md` | This document. |
| `thumbnail.html` | Homepage tile for the system. |
| `assets/` | Logo slot (empty — supply your own) and placeholder patterns. |

### `tokens/`

`fonts.css` · `palette.css` · `themes.css` (12 scheme variants) · `typography.css` ·
`spacing.css` · `shape.css` (radii + chamfer clip-paths) · `elevation.css` (shadow, glow,
blur, z-index) · `motion.css` (durations, curves, keyframes) · `semantic.css` (the alias
contract components read) · `base.css` (element defaults).

### `components/`

- **`brand/`** — `Wordmark`
- **`core/`** — `Button`, `IconButton`, `Icon`, `Panel`, `Badge`, `Tag`, `Avatar`, `Divider`, `Spinner`
- **`forms/`** — `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Toggle`, `SearchField`, `FieldGroup`
- **`navigation/`** — `Navbar`, `NavLink`, `Dropdown`, `Tabs`, `Breadcrumb`, `Pagination`, `SliderNav`
- **`data/`** — `StatBlock`, `ProgressBar`, `Countdown`, `DataTable`, `LeaderboardRow`, `TierPlate`
- **`feedback/`** — `Modal`, `Accordion`, `Tooltip`, `Alert`, `EmptyState`
- **`media/`** — `ImageWell`, `MediaCard`, `PlayerCard`, `MatchCard`, `PlayButton`
- **`game/`** — `HudFrame`, `ResourceBar`, `AbilitySlot`, `Crosshair`
- **`chrome/`** — `MacWindow`, `WindowsWindow`, `LinuxWindow`, `PhoneFrame`
- **`theming/`** — `SchemeSwitcher`

### `ui_kits/`

`web/` · `desktop/` · `mobile/` · `game/` · `print/` — each with its own `README.md` and
`index.html`.

### `guidelines/`

Foundation specimen cards (colour ramps, theme variants, type roles, spacing, shape,
elevation, motion, iconography, content rules) plus `scheme-explorer.html`, a live
switcher across all thirteen schemes.

---

## INTENTIONAL ADDITIONS

The sources are marketing/site templates, so they define no components for three of the
five target surfaces. These families have no counterpart in the sources and were authored
to make those surfaces buildable. Everything else maps to something the sources define.

| Addition | Why |
| --- | --- |
| `core/Icon` | Wrapper so Font Awesome glyph sizing/alignment is consistent; the sources used raw `<i>` tags. |
| `chrome/MacWindow`, `WindowsWindow`, `LinuxWindow` | Required by the desktop-app surface. Chrome geometry follows each OS's real conventions; only the content area is brand-styled. |
| `chrome/PhoneFrame` | Required by the mobile surface (iOS and Android status bars / gesture bars). |
| `game/HudFrame`, `ResourceBar`, `AbilitySlot`, `Crosshair` | Required by the game-UI surface. Built from the same tokens, chamfer and glow language — not restyled toward conventional game art. |
| `theming/SchemeSwitcher` | Preview-only control for the twelve colour schemes. Not intended to ship inside a product UI. |
| `feedback/Alert`, `feedback/EmptyState` | The sources have no inline messaging or empty states at all; both surfaces need them. |

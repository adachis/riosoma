# Destiny Design System

The visual and interaction language for **Destiny** — a personal AI assistant that lives across macOS, iPhone, and (conceptually) Apple Watch. This system was derived from the Destiny Mac and iPhone product design work in this project.

Destiny is a single assistant with many surfaces: a chat workspace, a coding-session runner, a file browser, a bookmarks/blog reader, a Life dashboard (health, financial, calendar, home), a TV & movies guide, a Media Workshop (image generation), and usage/bug tools. The design system's job is to make all of those feel like one calm, spectrum-lit product.

## Sources
- `Destiny for Mac v2.dc.html` — canonical macOS window (rail + list + panes for every feature).
- `Destiny for iPhone.dc.html` — the iOS adaptation (single column, context switcher, persistent voice bar).
- `Destiny Mac - Directions.dc.html` — early window-direction explorations.

These live in the project root as the ground-truth product recreations.

---

## Content fundamentals — how Destiny writes
- **Voice:** second person, direct, competent. Destiny talks to *you* like an assistant who already has the context ("Found it — the drawer used a fixed min-width…"). Never marketing, never bubbly.
- **Casing:** Sentence case everywhere except the uppercase eyebrow labels (section headers, card kickers). Titles are Title-free — "New chat", not "New Chat".
- **Numbers lead.** Dashboards open with the number (`$247.80`, `3 events`, `6h 48m`) then a quiet unit/subtitle. Heavy 800 weight, tight negative tracking.
- **Density:** compact, macOS-native. Meta lines ("Code session · 4m ago") are muted and terse. Em dashes and mid-dots (·) separate clauses.
- **Emoji:** none. Meaning is carried by FontAwesome glyphs and spectrum color, never emoji.
- **Tone example:** *"This window is separate from your notch, phone, and watch thread. Start a conversation with Destiny."*

## Visual foundations
- **Backgrounds:** true-black OLED voids (`#050508`–`#0a0a0f`). The app never uses light-grey surfaces. Behind windows sits the *desk gradient* — layered blue/violet/teal radial glows fading into near-black.
- **Surfaces lift by hairline + gradient, not brightness.** Cards are `#0A0A12` (flat) or a subtle `180deg #0c0c15→#08080e` top-light, with a single `#191926` hairline border.
- **Signature color:** cyan `#38F7FF` → violet `#6C5CFF`. This gradient is progress bars, active accents, focus. A second **action** gradient (teal→blue `#4defc9→#2ea9ff`) is the primary CTA fill on dark ink.
- **Spectrum semantics:** one hue per meaning — green=feature/positive, blue=macOS/info, amber=design/spend, pink=bug/alert, red=health/critical, lavender=AI voice. Applied as `hue14` fill + `hue66` border + full-strength glyph/dot.
- **Type:** the system font (`-apple-system`/SF Pro), SF Mono for code & tool calls. Weights run heavy (600 UI, 700 titles, 800 display). Eyebrows are 10px/700/uppercase/.12em tracking, muted `#61617a`.
- **Radii:** chips 6, rows 9, buttons/inputs 11, cards 12–14, hero 16, pills full, phone screen 42, window 14.
- **Elevation:** large, soft, near-black ambient shadows (`0 24px 60px -24px #000`) — depth from darkness, not grey drop shadows. Sidebars and titlebars are **glass**: `backdrop-filter: blur(30px) saturate(160%)` over the desk gradient.
- **Glow is reserved.** Neon cyan drop-shadow belongs to the orb and the active listening/voice state only — it is an identity cue, not decoration.
- **Motion:** slow orb spin while thinking; gentle glow pulse while listening; simple fades on content. Standard ease `cubic-bezier(.4,0,.2,1)`; press states shrink to ~.97.
- **Imagery:** the product is largely chrome + data; real imagery (article heros, movie posters, generated art) appears as full-bleed panels behind a bottom-up black protection gradient. Placeholders use diagonal repeating-stripe fills.
- **Hover:** rows lighten by a 3% white wash; active rows get a cyan inset bar (`inset 2px 0 0 #38F7FF`) plus faint cyan tint.

## Iconography
- **FontAwesome 6.5.1 Solid** is the entire icon set, loaded from cdnjs. Glyphs are colored by spectrum meaning and usually seated in a 22px tinted `GlyphIcon` square (hue at ~13% background).
- No emoji, no unicode-symbol icons, no hand-drawn SVG UI icons.
- Two brand SVGs only: `assets/orb.svg` (the iris orb) and `assets/clover.svg` (the compact 4-ring mark). These are the *only* bespoke vector art in the system.
- Common glyphs: `fa-comment` (chat), `fa-terminal` (code sessions), `fa-folder` (files), `fa-bookmark` (blog), `fa-heart-pulse` (life), `fa-tv` (TV), `fa-palette` (studio), `fa-microphone` (voice), `fa-wand-magic-sparkles` (AI action).

---

## Index / manifest
- `styles.css` — global entry (import list only). Consumers link this.
- `tokens/` — `colors.css`, `typography.css`, `spacing.css`, `radius.css`, `effects.css`, `base.css`.
- `assets/` — `orb.svg`, `clover.svg` (the two brand marks).
- `guidelines/` — foundation specimen cards (Colors, Type, Spacing, Effects, Brand) shown in the Design System tab.
- `components/` — reusable React primitives:
  - **brand/** — `Orb`
  - **core/** — `Button`, `IconButton`, `Pill`, `SectionLabel`, `ProgressBar`, `GlyphIcon`
  - **surfaces/** — `Card`, `StatCard`, `ListRow`
  - **controls/** — `SegmentedControl`, `Composer`
- `ui_kits/mac/` — Destiny macOS window recreation (rail · list · chat + composer).
- `ui_kits/iphone/` — Destiny iOS recreation (orb home · briefing feed · voice bar).
- `Destiny Design System.html` — the examples showcase page (foundations, type, components, brand, both device views).

## Intentional additions
The source products don't ship a formal component library, so the primitives above were factored *out of* the recurring patterns in the Mac/iPhone screens (every list is a `ListRow`, every tile a `StatCard`, etc). `Composer` and `SegmentedControl` generalize the message bar and the Life dashboard tab switch respectively.

## Notes / substitutions
- **Fonts:** Destiny is a native Apple product and wears the **system font** (San Francisco) — no webfont is bundled. On non-Apple platforms the stack falls back to Helvetica Neue / sans-serif. If you want a portable rendering, substitute *Inter* — flag this to the team.

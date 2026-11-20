# Palette — design system

Palette is a colour-tool brand: a generator, a browsable community library, an image extractor, a contrast checker, and export tooling, shipped as a website, a desktop app and a mobile app. The product's subject matter *is* colour, so the system is built the opposite way round from most: the chrome is deliberately quiet neutral, and saturated colour is reserved almost entirely for user content. Twelve interchangeable colour schemes ship with the system so the same components can carry any brand, product theme, or game skin.

**This design system was built from a brief, not from an existing codebase or Figma file.** No product code, Figma link, screenshots, fonts, logo files or copy were provided. Everything here is an original interpretation of the brief's description of a colour-palette platform.

## Sources given

| Source | Access | Notes |
| --- | --- | --- |
| Written brief (chat) | Read | Named the system "Palette", listed the five target application types and the twelve colour schemes |
| `https://coolors.co/?home` | Fetched — metadata only, no design tokens or code | Used as a high-level genre reference (a palette generator / browser). Nothing from the source's branding, wording, logo, layout or imagery is reproduced here |
| Twelve `coolors.co/palette/...` URLs | Hex values read from the URLs | The hex sets are used verbatim as the twelve colour-scheme variants; the schemes were named by us |

Nothing in this system carries the source's identity. If you have real Palette product code, Figma files, fonts or a logo, attach them — the tokens and kits here should then be reconciled against them.

## Applications covered

1. **Web** — marketing and app pages (`ui_kits/web`)
2. **Desktop app** — three-pane library window (`ui_kits/desktop`)
3. **Mobile app** — 390 × 844 screens (`ui_kits/mobile`)
4. **Game UI** — in-game HUD and pause menu (`ui_kits/game`)
5. **Print** — A4 spec sheet and specimen poster (`ui_kits/print`)

---

## Content fundamentals

**Voice.** Plain, practical, second person. The product does one thing per screen and the copy says what that thing is. No exclamation marks, no jokes, no metaphors about "bringing colour to life".

**Person.** "You" for instructions and empty states ("Point at anything to sample five colours"). "We" almost never appears. First person only in user-owned labels ("My palettes" is avoided in favour of "Saved").

**Casing.** Sentence case for everything a human reads: headings, buttons, menu items, dialog titles. Uppercase is reserved for two things — small tracked eyebrows/section labels (12px, `--tr-caps`) and hex values. Never title case.

**Numbers and colour values.** Hex is uppercase, six digits, with the leading `#`: `#43AA8B`. Always mono. Contrast ratios read `4.62:1`. Counts read "5 colours", not "5 Colors". Colour names are single words where possible (Coral, Maize, Jungle) and are treated as helpful labels, never as the primary identifier — the hex is the identifier.

**Length.** Buttons 1–2 words ("Generate", "Export", "Save & quit"). Dialog descriptions one sentence. Explanatory paragraphs cap at about 25 words. Empty states are one line plus one action.

**Examples of house copy**

- Section intro: "Thousands of palettes from the community. Filter by mood, copy any colour, open one to edit it."
- Hint: "press Space to shuffle"
- Toast: "Copied #43AA8B"
- Dialog: "Export palette" / "Formats keep the colour order."
- Field hint: "Enter a 6-digit hex value"
- Status bar: "128 palettes · Recents · ⌘K to search"

**Emoji.** Never — not in UI, not in marketing copy, not as icons. The one exception is a heart glyph (♥ / ♡) used as the like affordance, which is a typographic character rather than an emoji.

---

## Visual foundations

**Colour philosophy.** The interface is neutral so user colour reads truthfully. Chrome uses the 13-step `--n-*` ramp; the house accent is the Spectrum teal `#43AA8B` (`--brand-500`), applied through a single family (`--accent`, `--accent-hover`, `--accent-press`, `--accent-soft`) and appears on at most one filled element per view plus selection states. Status colours (`--ok-500`, `--warn-500`, `--danger-500`) are fixed in every scheme so a pass/fail verdict never changes meaning when the theme changes. Palette content colours are never tinted, overlaid or blended — a swatch shows the exact value.

**Colour schemes.** `data-palette="<name>"` on any element switches scheme. Each scheme is two blocks in `tokens/palettes.css`, which is what makes it compose with dark mode rather than fight it:

| Block | Selector | What it sets |
| --- | --- | --- |
| Light | `[data-palette="x"]` | `--accent` family, the ramp `--p-*`, `--palette-name`, `--palette-count`, **and** the light surface tint: `--bg-page`, `--bg-sunken`, `--surface-card/-raised/-inset`, `--border-subtle/-strong`, `--accent-soft`, `--focus-ring`, `--overlay` |
| Dark | `[data-palette="x"][data-mode="dark"]` | a dark surface stack mixed from the same hue, plus the text tokens and dark shadows |

The scoping is load-bearing: `palettes.css` is imported after `colors.css`, so the light block would otherwise beat the neutral `[data-mode="dark"]` block and leave dark mode with a light page. The dark block's `(0,2,0)` specificity is what makes the tinted dark stack win, so every surface token in the light block is restated there.

Switching a scheme therefore re-tints the whole interface — page, sunken, card, inset, borders, focus ring — not just the accent. `data-mode="dark"` stays an independent axis: any of the twelve schemes × either mode is a legible combination. The two dark-native schemes (`midnight`, `fathom`) carry their dark stack in the first block, so they read dark in either mode by design.

The twelve schemes: spectrum, midnight, voltage, cadet, blush, timber, seafoam, fathom, sherbet, lagoon, ember, fieldstone.

**Ramp depth is not uniform.** `--palette-count` reports how many steps the active scheme defines: 10 for `spectrum`, 5 for most, 4 for `sherbet`. Only `--p-1 … --p-4` are guaranteed in every scheme, so anything that must survive a theme switch — component defaults, documented examples, HUD meter fills — stays inside that range. Use `--p-5 … --p-10` only where the surface pins a scheme that defines them.

**Type.** Space Grotesk for display (700, `--tr-tight` / `--tr-tighter` above 30px, line-height 1.02–1.2); Instrument Sans for body and all UI labels (400/500/600, line-height 1.45); IBM Plex Mono for every value the user could copy — hex, RGB, CMYK, ratios, degrees, counts, page folios, keycaps. Mono is a semantic choice, not decoration: if it is a value, it is mono.

**Spacing and layout.** A 2 → 128px scale (`--sp-*`); 4/8/12/16/24/32 do most of the work. Page max width 1240px with 24px gutters. Control heights are 30 / 38 / 46px, with a 44px minimum touch target on mobile. Desktop chrome is denser (32px nav rows, 13px labels) than web (38px controls, 14–16px text). Fixed elements: the web header is sticky and translucent, the mobile tab bar is fixed and translucent, the desktop title and status bars are fixed, and game HUD panels are anchored to the four corners.

**Backgrounds.** Flat colour, always. `--bg-page` for content, `--bg-sunken` for chrome and inset areas. No decorative gradients, no illustration, no patterns or textures, no noise. The only gradients in the system are functional: slider tracks that show hue/saturation/lightness, the two scrim tokens (`--scrim-top`, `--scrim-bottom`) used to protect text over imagery, and game HUD backdrops. Imagery, when present, is user content (photos being sampled) shown unfiltered — no duotone, no grain, no warm/cool grade.

**The band motif.** The house graphic device is a palette shown as flush, gapless vertical or horizontal bands. No gaps, no borders between bands, no radius on individual bands — radius belongs to the container, which clips them. Hex labels sit inside bands in a computed light or dark ink (`#14171c` or `#ffffff`, chosen from the band's luminance) so they read on any colour. This motif scales from a 22px logo lockup to a 460px generator screen to a 300px poster header.

**Borders.** 1px hairlines (`--bw-hair`) in `--border-subtle` separate surfaces; `--border-strong` is for interactive field and button edges. 2px (`--bw-thick`) marks selection — active tab underline, selected swatch ring, checked control. 3px (`--bw-heavy`) is used only for a card's top accent edge, a toast's leading status rule, and keycap depth. Every swatch carries a 1px inset hairline (`inset 0 0 0 1px rgba(20,23,28,.10)`) so white and near-white colours stay visible on white.

**Corner radii.** 4px checkboxes and small chips · 6px badges and table cells · 10px controls and swatches · 14px cards and windows · 20–28px sheets and mobile modals · pill for tags, toggles, avatars and marketing CTAs. Game UI replaces radius with a 14px corner notch (`clip-path`). Print pages have square corners.

**Shadows.** Four steps, all neutral-tinted (never coloured): `--shadow-1` resting cards, `--shadow-2` hover and popovers, `--shadow-3` modals and windows, plus `--shadow-inset` for fields and `--shadow-press` for depressed buttons. Hover promotes an element exactly one step and lifts it 1px. Game meters and glowing HUD panels are the only place a coloured shadow appears, and it is a glow of the element's own colour.

**Cards.** `--surface-card` fill, 1px `--border-subtle`, 14px radius, `--shadow-1`, 24px padding. Interactive cards lift 1px to `--shadow-2`. When a card contains a palette strip or image, padding drops to zero and the media runs edge to edge. Cards never nest.

**Transparency and blur.** Used in exactly three situations: sticky/fixed navigation (88–92% surface + 12–14px blur), modal scrims (`--overlay`, 55% ink + 2px blur), and game HUD panels (78% ink + 10px blur over gameplay). Never on static content panels.

**Motion.** Short and unfussy. 90 / 140 / 200 / 300 / 480ms with `--ease-out` for essentially everything; `--ease-snap` (a slight overshoot) only on switch knobs and sheets. Hover and press transitions are 140ms. Colour bands animate their `flex` on hover at 200ms. No bounce, no spin, no parallax, no scroll-triggered reveals. Nothing loops except a progress indicator.

**States.**
- *Hover*: buttons darken one step (`--accent-hover`), lift 1px, gain `--shadow-2`; ghost controls fill with `--accent-soft`; rows fill with `--bg-sunken`; colour bands reveal their controls.
- *Press*: darken again (`--accent-press`), drop the lift, swap to `--shadow-press`; icon buttons scale to 0.97.
- *Focus*: a 3px `--focus-ring` halo plus an accent border. Never removed, never a browser default outline.
- *Selected*: 2px accent border with `--accent-soft` fill — never a solid accent fill, which reads as a button.
- *Disabled*: `--surface-inset` fill, `--text-muted` label, no shadow, `not-allowed` cursor. No opacity-only disabling on filled controls.

---

## Iconography

**Set.** Lucide, loaded from CDN (`https://unpkg.com/lucide@0.470.0/dist/umd/lucide.js`), wrapped by the `Icon` component. **This is a substitution and is flagged as such:** no icon font, sprite or SVG set was supplied with the brief, and Lucide's 2px-stroke geometric outline style is the closest match to this system's type and geometry. If the real product has its own icons, drop them into `assets/icons/` and repoint `Icon`.

**Style rules.** Outline only, 2px stroke (2.25 at 16px when a glyph needs weight), round caps, no filled glyphs, no two-tone icons, no icon backgrounds except when an `IconButton` is `solid`. Icons inherit `currentColor` and never carry their own colour.

**Sizes.** 15–16px inside `sm` controls and dense desktop rows · 18px in default toolbars and `IconButton` · 20px default · 22–24px in the mobile tab bar and game HUD.

**Vocabulary in use.** shuffle, lock / lock-open, copy, download, upload, share, bookmark, heart, link, sliders-horizontal, search, plus, x, camera, compass, swatch-book, folder, clock, trash-2, chevron-right, sun, moon, sparkles, crosshair.

**Unicode and emoji.** No emoji anywhere. Three typographic characters are used deliberately: `♥`/`♡` for likes, `×` for dismiss affordances inside tags and dialogs, and `/` as the breadcrumb separator. Keyboard hints use real characters in `KeyCap` (⌘, Esc, Space).

**Logo.** No logo files were provided, so **no mark was invented**. Wherever a logo would sit, the system sets the word "Palette" in Space Grotesk 700 with `--tr-tighter` tracking, optionally preceded by a 22px four-band square built from the active palette ramp (the band motif, not a mark). `assets/` therefore contains no logo file; see `assets/README.md`.

---

## Index

**Root**

| File | What it is |
| --- | --- |
| `styles.css` | Global entry point — `@import` lines only. Consumers link this one file. |
| `readme.md` | This document. |
| `SKILL.md` | Agent-skill front matter for use outside this project. |
| `thumbnail.html` | Homepage tile for the system. |
| `tokens/` | `fonts.css`, `colors.css`, `palettes.css`, `typography.css`, `spacing.css`, `radii.css`, `elevation.css`, `motion.css`, `base.css` |
| `guidelines/` | 21 foundation specimen cards (Colors, Type, Spacing, Brand) |
| `components/` | Reusable primitives, grouped by concern |
| `ui_kits/` | Five product recreations |
| `assets/` | `theme-switcher.js` plus asset notes; no vendor binaries were supplied |
| `templates/` | Four starting folders: mobile screen, desktop window, game HUD, print sheet |

**Components** (27 — each with `.jsx`, `.d.ts`, `.prompt.md`, plus one card per directory)

- `components/core/` — **Button**, **IconButton**, **Card**, **Badge**, **Tag**, **Icon**
- `components/forms/` — **Input**, **Select**, **Checkbox**, **Radio**, **Switch**, **Slider**
- `components/navigation/` — **Tabs**, **Breadcrumbs**, **Pagination**
- `components/feedback/` — **Dialog**, **Toast**, **Tooltip**, **ProgressBar**
- `components/color/` — **Swatch**, **PaletteStrip**, **PaletteCard**, **ContrastBadge**
- `components/game/` — **HudPanel**, **MeterBar**, **KeyCap**
- `components/chrome/` — **TitleBar** (`platform="macos"` / `platform="windows"`)

**Intentional additions.** No source defined a component inventory, so the standard set was authored from scratch. Four families exist because the brand's subject matter demands them (`Swatch`, `PaletteStrip`, `PaletteCard`, `ContrastBadge`), three because game UI was a required application (`HudPanel`, `MeterBar`, `KeyCap`), one to wrap the substituted icon set (`Icon`), and one because the desktop application needs native window chrome on two operating systems (`TitleBar`).

### Window chrome — the two title-bar variants

`TitleBar` ships as two platform variants rather than one restyled bar, because the two conventions differ in more than decoration:

| | `platform="macos"` | `platform="windows"` |
| --- | --- | --- |
| Height | 46px | 32px |
| Window buttons | three 12px traffic lights at the leading edge; glyphs fade in on hover of the group | three 46 × 32px buttons at the trailing edge; each fills on hover, close fills `#c42b1c` with white ink |
| Title | centred, display face, 13px semibold | leading, after a 16px app mark, 12px caption |
| Window radius | `--r-lg` (14px) | `--r-sm` (6px) |

Shared in both: `--bg-sunken` surface, hairline bottom border, the `--p-*` band mark, and the trailing control slot. Pick the variant that matches the target OS; never mix traffic lights with trailing controls. The desktop UI kit exposes a live macOS / Windows switch above the window, and the `Desktop window` template exposes the same choice as a `platform` tweak.

### Theme changer

Every example in this system — all 21 foundation cards, all 7 component cards, all 5 UI kits and all 4 templates — carries `<theme-switcher>` (`assets/theme-switcher.js`), a dependency-free web component. It writes `data-palette` and `data-mode` onto `<html>`, persists the choice in `localStorage` and broadcasts a `palettethemechange` event, so any of the twelve schemes and either mode can be checked against any component without editing a file.

- Foundation cards use `<theme-switcher compact>` (24px) so it stays out of the specimen; everything else uses the 30px default. `position="inline"` drops the fixed placement.
- `window.PaletteTheme` is the scripting API: `get()`, `setPalette(name)`, `setMode("dark")`, `toggleMode()`. The web kit's own moon button and the game kit's HUD-skin picker both route through it, so in-product controls and the changer never disagree.
- The two dark-native schemes (`midnight`, `fathom`) carry their own surfaces, so `data-mode` is largely redundant on them; the changer notes this in its tooltip.

**UI kits**

| Kit | Entry | Contents |
| --- | --- | --- |
| Web | `ui_kits/web/index.html` | Sticky header, generator, explore grid, palette detail, export dialog, copy toast |
| Desktop | `ui_kits/desktop/index.html` | macOS / Windows title bar switch, sidebar library, grid/list browser, inspector, status bar |
| Mobile | `ui_kits/mobile/index.html` | Generate, Explore, Extract, Saved screens, tab bar, share sheet |
| Game UI | `ui_kits/game/index.html` | HUD with meters and hotbar, pause/settings overlay, live palette skinning |
| Print | `ui_kits/print/index.html` | A4 colour spec sheet, A4 specimen poster |

**Templates** (starting folders for consuming projects — each is a `.dc.html` entry plus a one-line `ds-base.js` loader)

| Template | Folder |
| --- | --- |
| Web page | `templates/web-page/WebPage.dc.html` |
| Desktop window | `templates/desktop-window/DesktopWindow.dc.html` |
| Mobile screen | `templates/mobile-screen/MobileScreen.dc.html` |
| Game HUD | `templates/game-hud/GameHudScreen.dc.html` |
| Print sheet | `templates/print-sheet/PrintSheet.dc.html` |

The `ui_kits/` folders remain the interactive, click-through recreations; the templates are the static starting points a consuming project copies.

## Known gaps

- **Fonts are Google Fonts substitutes**, not vendor files: Space Grotesk, Instrument Sans, IBM Plex Mono, loaded via `tokens/fonts.css`. Supply real font binaries and they can be self-hosted with `@font-face`.
- **Icons are substituted** (Lucide via CDN).
- **No logo, illustration or photography** was supplied, so none is included and none was drawn.
- CMYK values on the print spec sheet are illustrative, not measured against a profile.

## Decisions made without a source

Nothing about the brand was specified beyond the name, the five application types and the twelve schemes, so these calls were made here and can be overturned:

- **Default accent** is Spectrum's teal `#43AA8B` (`--brand-500`), with the house ramp derived from it. Applying `data-palette` overrides it.
- **Type pairing**: Space Grotesk / Instrument Sans / IBM Plex Mono.
- **Scheme names** (spectrum, midnight, voltage, cadet, blush, timber, seafoam, fathom, sherbet, lagoon, ember, fieldstone) are ours; the source URLs were unnamed.
- **Accent choice within each scheme** is the step with the best contrast behaviour, not simply the first colour.
- **Products**: generator / explore / detail on web, a library window on desktop, a four-tab mobile app, one game HUD + pause menu, and two A4 print pages.

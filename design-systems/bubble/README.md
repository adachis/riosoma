# Bubble — Design System

Bubble is a high-contrast, capsule-shaped design system for products that want to feel loud and physical. Ink-black and paper-white do the structural work; one saturated accent per surface does the shouting. Every interactive element is a capsule, every container has a large radius, and type is set in a heavy rounded display face at display sizes.

It is built to cover five delivery surfaces from one token set:

1. **Web** — marketing pages, product sites, editorial
2. **Desktop apps** — window chrome, sidebars, panels, dense lists
3. **Mobile apps** — sheets, tab bars, media players, settings
4. **Video game UI** — HUDs, menus, loadouts, stat meters
5. **Print** — posters, editorial spreads, covers, one-sheets

## Sources given

- `uploads/original-fd9a7adb65530834dab6abe87adc197b.webp` — a bold black/white marketing page reference: floating pill nav, ultra-heavy uppercase display headline, service list with small geometric glyphs, oversized footer wordmark, one neon accent shape.
- `uploads/original-ccdf4134f70b17ab6969307e49fbff52.webp` — a dark mobile app reference sheet: true-black screens, thick rounded EQ and ring meters, mono numerals, service lists, a circle-cluster theme picker, one yellow promo block, violet accent.
- `uploads/Screenshot 2026-08-31 at 10.02.28.png` — two mobile screens from the same reference: a light neumorphic player (soft puff shadows, squared album tile, pill scrubber) and a dark equalizer screen (vertical lanes, mono dB readouts, violet markers).

No codebase, Figma file, or component library was supplied. **No slide deck was supplied, so no slide templates were authored.** Bubble is therefore an original system *inspired by* the shared visual logic of those references — capsule geometry, ink/paper contrast, heavy rounded display type, mono numerals, one loud accent — and contains none of their branding, copy, marks, or images. None of the uploaded images are shipped in this system.

**No logo was supplied, so none was drawn.** Wherever a mark would go, Bubble sets the word "Bubble" in the display face (see `guidelines/brand-wordmark.html`). `assets/` holds no logo file by design.

## Index

| File | What it is |
|---|---|
| `styles.css` | Global entry point — nothing but `@import` lines |
| `tokens/fonts.css` | `@font-face` declarations + Google Fonts import |
| `tokens/colors.css` | Ink/paper ramps, house accents, semantic aliases, dark mode |
| `tokens/themes.css` | 13 `data-theme` palettes |
| `tokens/typography.css` | Face stacks + display/heading/body/label scales |
| `tokens/spacing.css` | Space scale, layout maxima, print margins |
| `tokens/radius.css` | Radii, including per-role aliases |
| `tokens/elevation.css` | Puff + press shadow families, glass fill |
| `tokens/motion.css` | Easings, durations, hover/press deltas |
| `tokens/base.css` | Element defaults (body, headings, links, selection, focus) |
| `guidelines/*.html` | 22 foundation specimen cards (Colors, Themes, Type, Spacing, Shape, Motion, Brand) |
| `components/core` | Button, IconButton, Icon, Badge, Tag, Card, Avatar |
| `components/forms` | Input, Select, Checkbox, Radio, Switch, Slider, SegmentedControl |
| `components/feedback` | Dialog, Toast, Tooltip, ProgressBar, Meter |
| `components/navigation` | Tabs, PillNav, ListRow, BottomNav |
| `ui_kits/theme-switcher.js` | Floating demo control on every kit: 13 palettes × light/dark |
| `ui_kits/web` | Marketing site recreation |
| `ui_kits/desktop` | Desktop media/library app — macOS (`index.html`) and Windows (`index-windows.html`) chrome variants |
| `ui_kits/mobile` | Mobile player, equalizer, settings |
| `ui_kits/game` | In-game HUD and loadout menu |
| `ui_kits/print` | Poster + editorial spread at print geometry |

### Intentional additions

The references define no formal component library, so Bubble authors a standard primitive set. Four additions beyond that set are load-bearing for the five target surfaces:

- **Slider** — the source surfaces are built around continuous controls (scrubbers, EQ lanes, dB dials).
- **Meter** — thick-arc ring charts appear as the primary data readout.
- **ListRow** — every source screen is list-driven.
- **Icon** — a thin wrapper so FontAwesome sizing stays token-driven.

## Content fundamentals

**Voice.** Short, declarative, a little brash. Bubble copy states what a thing does and stops. No hedging ("might", "helps you to"), no throat-clearing preamble, no exclamation marks.

**Person.** Second person for actions the user takes ("Choose a source", "Your library"), first-person plural only for the company's own promises ("We ship in 48 hours"). Never first-person singular.

**Casing.** This is the system's strongest verbal signal:

- Display headlines: **ALL CAPS**, one to four words. "MY OFFER", "PICK A THEME", "SOUND, SORTED".
- Buttons, nav pills, badges, eyebrows: **UPPERCASE**, tracked. "BOOK A CALL", "LIVE", "STORAGE".
- Headings, list titles, card titles: **Sentence case**. "Bass boost", "Connie Hawkins", "Storage and sources".
- Body: sentence case, no terminal period on single-line fragments.

**Length.** Headlines ≤ 4 words. Eyebrows ≤ 3 words. Button labels 1–3 words, verb first. Body paragraphs ≤ 3 sentences. Empty states one line.

**Numbers.** Always mono, always the real unit, no rounding-for-cuteness: `04:30`, `+8dB`, `48.5 GB free`, `192 kHz`, `0.25 GB`. Percentages get no decimal.

**Emoji.** Never. Icons come from FontAwesome; there is no decorative emoji use anywhere in the system.

**Examples, in voice:**

- Eyebrow / headline / body: `NOW PLAYING` · "SOUND, SORTED" · "Twelve palettes, two modes. Pick one and the whole interface follows."
- Empty state: "Nothing here yet. Add a source to start."
- Destructive confirm: title "Delete playlist?" · body "This removes 42 tracks from your library." · buttons "CANCEL" / "DELETE".
- Error: "Source unreachable. Check the connection and try again."
- Marketing CTA: "BOOK A CALL" · support line "Subscribe today. Post tomorrow."

## Visual foundations

**Colour.** Two structural colours (`--ink-1000`, `--paper-0`) and one accent per surface. Neutrals are slightly cool-warm-neutral greys stepped 900→300 for ink and 300→0 for paper. The accent is never used for large fields — it appears on one primary control, on active states, on data arcs, and on focus glow. House accent is violet `#8b2cf5` with lime, lemon and coral as secondary data colours. Semantic colours are borrowed from the Spectrum palette (`--success #43aa8b`, `--warning #f8961e`, `--danger #f94144`, `--info #4d908e`) and always shown as a solid glyph colour on a soft tinted pill, never as a full-bleed field.

**Themes.** Thirteen palettes (`data-theme`) remap five slots `--p1`..`--p5`; `--p1` becomes `--accent` and its hover/press/soft derivatives are computed with `color-mix`, so themes never need per-component overrides. Themes compose with `data-mode="light|dark"`. Light is the default; dark is true black (`#000`) page with charcoal `#121214` cards — the same shapes, inverted ink, never a "dimmed grey" middle ground.

**Type.** Display face is a heavy rounded grotesque, set 800 weight, uppercase, −3% tracking, 0.88 leading — headlines are meant to nearly touch. Text face is a geometric-humanist sans at 500/700/800; body is 500 so it doesn't disappear next to the display face. Mono carries every readable number. Type never sits below 12px in UI, 24px on a 1920 slide, 9pt in print.

*Font substitution (flag):* no font binaries were supplied. Bubble ships Google Fonts stand-ins — **Baloo 2** (display), **Manrope** (text), **JetBrains Mono** (numerals) — aliased behind `Bubble Display` / `Bubble Text` / `Bubble Mono` so real binaries can be dropped in without touching components. **If you have the intended faces, send the files and I'll swap them in.**

**Spacing & layout.** 4-based scale to 24, then 32/40/48/64/80/96/128 for section rhythm. Cards pad 24 (18 in dense desktop panels). Control gaps 8–12. Page max 1240 with 24px gutters; text measure 66ch. Touch targets never below 44px. Fixed elements: the web nav floats (sticky, 16px from top, glass fill), mobile tab bars pin to the bottom with a glass fill, desktop sidebars are fixed-width 248px, game HUD elements anchor to the four corners with 24px insets.

**Backgrounds.** Flat fields — paper white, sunken `#efeff1`, or true black. No gradient backgrounds, no photographic wallpaper, no noise or grain, no repeating pattern. The only gradients in the system are two-stop accent fills on a single hero shape or a data arc; there are no purple-blue "AI" gradients. Where imagery appears it is full-bleed inside a rounded media well (22px) and cropped square or 16:9 — never floated with a drop shadow. Imagery direction is high-contrast and slightly cool, or straight monochrome; no warm film grain, no soft-focus stock.

**Cards.** Large radius (26px), soft wide shadow, no border, generous padding. That is the default. The alternates are a flat card with a 2px ink border (editorial and print), and an inset well with an inner shadow (panels inside panels). Never a 1px grey box, never a rounded card with only a coloured left border.

**Shadows.** Two families, never mixed on one element. *Puff* casts outward and soft (`0 2px 6px / 0 12px 28px` at 6–8% ink) and belongs to floating things: cards, nav bars, sheets, knobs. *Press* is inset (`inset 0 2px 6px` at 16%) and belongs to tracks, wells and inputs — anything the eye should read as recessed. In dark mode both families deepen to near-opaque black. Accent glow (`--puff-glow`) is reserved for one element per screen.

**Borders.** 1px hairline `--border` for separators only. 2px ink `--border-strong` is the real border of the system — outlined pills, stroke cards, focus. 3px heavy for print rules and game frames.

**Radii.** 8 / 12 / 18 / 26 / 36 / 48 / pill. Rule: anything the user clicks, drags or types into is a **pill**; anything that contains content is 26 or 36; media wells are 22; the only intentionally square-ish control is the checkbox at 8. Sheets round only their top corners (36 36 0 0).

**Transparency & blur.** Used in exactly two places: the floating web nav and the mobile tab bar (`--glass-fill` = 68% background + `saturate(140%) blur(18px)`), and the modal scrim (62% ink + 6px blur). Nothing else is translucent — no frosted cards, no ghosted panels. Text is never placed on an image without an opaque capsule behind it; Bubble uses capsules, not protection gradients.

**Animation.** Motion is inflation: quick departure, soft overshoot on arrival. `--ease-squish` `cubic-bezier(.34,1.56,.64,1)` for anything entering or a knob travelling; `--ease-out` for colour and shadow. Durations 110 / 180 / 280 / 460ms. Things scale and translate; they do not fade in isolation (a fade always accompanies a scale). No bounce loops, no parallax, no scroll-jacking. All of it collapses to 0ms under `prefers-reduced-motion`.

**Hover.** Lift 2px, brighten 8%, deepen to `--puff-2`. Ghost controls gain a `--surface-inset` fill instead of lifting. Never a colour inversion on hover.

**Press.** Scale to 0.965, drop the shadow, no colour change. The control feels squeezed rather than repainted.

**Focus.** 3px solid ink (white in dark mode) outline offset 2px, plus a 35% accent halo on controls that carry `--ring`.

## Iconography

Icons come from the project's **FontAwesome kit `fde87cf732`**, embedded once per page:

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

- **`fa-solid` only** for interface glyphs — transport, settings, navigation, status. Solid weight matches the heavy display face; `fa-regular` and `fa-light` are not used, and stroke styles are never mixed inside one surface.
- **`fa-brands`** for third-party services and social rows (`fa-spotify`, `fa-dropbox`, `fa-google-drive`, `fa-steam`, `fa-discord`), always inside a 44px ink or paper capsule.
- Sizes: 14px in dense rows, 16–19px in nav and toolbars, 24px+ in empty states. Icon colour is always `currentColor` — it inherits from its capsule, and only the active/primary glyph takes `--accent`.
- Icons live in capsules. A bare glyph on a background is the exception (list-row leading glyph); a glyph next to a label always shares the label's colour.
- **No emoji. No unicode glyph substitutes** (no ▸ ✕ ★). No custom SVG icon set was supplied and none was drawn — the `Icon` component is the only sanctioned wrapper.
- There is no icon binary in `assets/`: the kit is CDN-hosted, which is the flagged substitution — if you have a bespoke icon set, send it and it will replace the kit references.

## Using Bubble

```html
<html data-theme="candy" data-mode="dark">
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

Then compose from `window.BubbleDesignSystem_0e7eb4` (or import the JSX directly in a build). Every component reads its colour from the custom properties, so switching `data-theme` on any ancestor re-themes the subtree.

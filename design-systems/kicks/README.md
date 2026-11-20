# Kicks — design system

Kicks is a footwear brand: technical trail, court and road silhouettes sold direct, in limited drops, to people who care what an outsole is made of. The system covers five surfaces from one set of tokens — a commerce **website**, a **desktop** studio app, an **iOS/Android** app, a **game UI**, and **print**.

The visual language is sportswear graphic design: hard-edged blocking, oversized condensed display type, technical mono micro-labels, offset "print" shadows, geometric pattern tiles, and one loud accent against warm near-black and off-white paper. Twelve interchangeable accent schemes ship with it.

---

## Sources this was built from

| Source | Type | What was taken |
| --- | --- | --- |
| `Kicks/` (mounted local folder) | Licensed stock asset packs — `.ai` / `.eps` / `.svg` / `.psd` / `.jpg` | All real artwork in `assets/`: flat vector sneaker illustrations, footwear line-icon sets, geometry grid patterns, black-geometry and halftone backgrounds, shoe silhouettes |
| Uploaded reference images (`uploads/`) | Sportswear posters, campaign layouts, sneaker editorial | **Mood only.** Read for composition, type scale, colour blocking and micro-copy rhythm. Nothing was copied, traced or reproduced, and no third-party brand marks, product names or copy appear anywhere in this system. |
| Colour scheme list | 12 published palettes supplied in the brief | `tokens/themes.css`, verbatim hex values |
| Font Awesome kit `fde87cf732` | Icon kit supplied in the brief | The whole interface icon set |

There was **no codebase, Figma file or existing component library** in the sources — the packs are artwork, not software. The component inventory below is therefore an authored standard set sized to the five named surfaces, not a recreation of an existing library. Every screen in `ui_kits/` is likewise an original composition in this system's language, not a recreation of a real product.

**No logo file exists in the source material.** Kicks signs itself in type: `Logotype` sets the word in Anton with the second half in an accent slab. Nothing was drawn, reconstructed or approximated. If a real mark exists, drop it into `assets/` and replace `Logotype`.

---

## Content fundamentals

**Voice.** Flat, factual, specific. The brand states numbers and lets them do the persuading. It never sells the feeling of running; it tells you the compound, the lug depth and the gram count.

- **Person.** Second person for instructions and state (“Order before 18:00”, “Pick a size to continue”, “Your entry will be released to the queue”). First person only in the user's own voice, inside opt-ins (“Keep me on the drop list”). The brand never says “we” in UI copy — it says what happens.
- **Casing.** Display type and mono labels are uppercase **by CSS, never by typing**; write copy in sentence case so it survives a change of treatment. Body copy is sentence case. Product names are title case (`Trail 03`, `Block 88`). Colourways are title case (`Core Black`, `Signal`, `Volt`).
- **Length.** Buttons 1–3 words. Badges 1–3 words, no full stop. Banner titles are a fact, not a warning (“Cut-off in 42 minutes”, not “Hurry!”). Body paragraphs stay under 3 sentences on screens; editorial can run long.
- **Numbers.** Always concrete and always in mono: `291 g`, `4 mm`, `8 mm drop`, `£145`, `UK 9`, `0:41.6`, `1,840 km`, `KX-D091`. Prefer a measurement to an adjective.
- **Codes.** Everything gets a reference: drops `KX-D091`, documents `KX-POS-014`, SKUs `TR03-SIG-090`. Codes appear in mono, uppercase, often as an eyebrow or in the colophon.
- **Punctuation.** Middle dot `·` separates facts in a single line (`Signal · UK 9 · 291 g`). Slashes separate hierarchy (`Trail / Low`). En dashes for ranges (`Sizes 6 – 12`). No exclamation marks. No ellipses in UI.
- **Emoji.** Never. Not in UI, not in copy, not in marketing.
- **Errors.** Say what happened and what to do: “No order found — check the code on your receipt.” Never apologise twice, never blame the user.
- **Empty states.** State the fact, then the next action: “Nothing in the locker yet. Save a pair and it lands here.”

Sample voice, exactly as it appears in the kits:

> **Drop 09.14** · Raffle open · 38 hrs left
> **RUN THE BLOCK**
> Trail 03 lands in Signal. Wet-granite compound, 4 mm lugs, 291 grams.

> **Cut-off in 42 minutes** — order before 18:00 for next-day delivery.

> Grip is not a rubber problem. It is a drainage problem. — Inês Faria, outsole lead

---

## Visual foundations

**Colour.** Warm-neutral ink ramp (`--k-ink-1000` `#0b0b0c` → `--k-paper` `#faf9f5`) carries every surface, border and text colour. Accent is a five-slot contract (`--k-accent-1…5`, with `--k-accent` mirroring the CTA slot) redefined by each of the twelve schemes; nothing else in the system hardcodes a hue. Status colours (`--k-success/-warning/-danger/-info`) are deliberately scheme-independent so a warning never reads as decoration. Dark mode (`data-mode="dark"`) swaps only the neutrals; the accents ride through.

**Type.** Three voices, no exceptions. **Anton** (display, single weight, uppercase, tracking −0.015em, leading 0.88) for anything that shouts. **Manrope** 400–800 for body — never uppercase. **Space Mono** 700 uppercase, tracking 0.14em for micro-labels, codes, prices, times and data. The mono label is the brand's tell: it appears as an eyebrow above almost every headline.

**Spacing.** 4px grid (`--k-space-*`) with two intentional off-grid steps, 2px and 6px, for label spacing. 24px gutters, `clamp(16px, 4vw, 64px)` page padding, 1440 content cap. Controls are 34 / 44 / 56 / 64px; **44px is the floor on every platform, desktop included**.

**Corner radii.** Effectively zero — `--k-radius-control` is 2px, cards are 0. Pills (`--k-radius-pill`) are reserved for tags, chips and avatars, and are the only rounded shape in the system. The graphic energy comes from blocking, not rounding.

**Borders.** 1px hairline inside dense lists, **2px ink as the structural default**, 3px on modals, 6px as a status slab on the leading edge of banners and toasts. Borders are ink or paper — never a tinted mid-grey.

**Shadows.** Solid offset "print" shadows: `2px 2px 0`, `4px 4px 0`, `8px 8px 0` in ink (or accent). Blur is allowed **only** on floating overlays — dialogs, toasts, tooltips, window chrome — where it reads as physical depth. No shadow ever sits under body text or a section.

**Cards.** 2px ink border, square corners, optional 4px offset shadow, media area with a 2px bottom rule, mono eyebrow, Anton title, footer separated by a rule. No inner glow, no left-border accent stripe, no gradient fill.

**Backgrounds.** Three options, one per composition: flat paper/ink, a licensed pattern tile at low contrast (`assets/patterns/`), or a full-bleed halftone / black-geometry photo texture (`assets/backgrounds/`). Never two textures in one composition. Diagonal stripe and caution-band motifs are CSS (`--k-stripe-*`) for tickers and warnings.

**Imagery.** Flat vector sneaker art on paper, or hard-cropped high-contrast photographic texture — cool, near-monochrome, grainy rather than warm and glossy. Product art is `object-fit: contain` with 8% padding and **never cropped**. Type over imagery sits on a solid plate or an ink scrim, never on a soft protection gradient.

**Transparency and blur.** Only three places: the modal scrim (72% ink + 14px blur), game panels (82% ink + 6px blur), and the OS-native window bars. Nothing else is translucent.

**Motion.** Short and mechanical: 80 / 120 / 180 / 280ms, `cubic-bezier(.2,.8,.2,1)` out and `cubic-bezier(.4,0,0,1)` snap. Movement is translation, not fade — things slide into place like a printing plate. No bounce, no spring overshoot, no parallax. `prefers-reduced-motion` zeroes every duration.

**Hover.** Blocks lift up-left by 2px and grow the offset shadow to 8px. Non-block controls fill with `--k-accent-soft`. Ghost controls gain a border. Opacity is never used as a hover state.

**Press.** The block pushes 2px down-right and the shadow collapses to nothing — the plate hits the paper. No colour change on press; the shift is the feedback.

**Focus.** 2px solid `--k-focus` outline at 2px offset on every interactive element; form fields additionally paint a 2px accent inset.

**Selected / active.** Solid ink plate with paper text (tabs, pagination, size grid, filter chips) or a 4px accent slab on the leading edge (side rail, bottom nav, active tab). Never a tint alone.

**Layout.** Sticky elements: the 72px web nav bar, the listing facet rail, the checkout summary card, and mobile bottom nav. Sections are separated by a `Divider variant="slab"` — a 6px accent rule — not by whitespace alone. One accent block per viewport; if two want the accent, one becomes ink.

**Game UI.** Same tokens, unchanged. The only addition is a 10–18px corner cut on panels and slots and an 8° shear on game buttons and meters. Nothing is glossed, gradiented or softened to look like conventional game UI.

---

## Iconography

**Interface icons: Font Awesome, kit `fde87cf732`, solid family.** Every glyph in the system comes from it — search, bag, heart, bookmark, sliders, truck, arrows, chevrons, status circles, brand marks in the footer. Regular family only inside dense data tables where solid reads too heavy. Brands family only for social links. Nominal size 16px in UI, 11–13px inside mono label rows, 18–20px in mobile bottom nav.

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

Use the `Icon` component (or a bare `<i className="fa-solid fa-…">`). **Do not hand-roll SVG paths and do not use emoji or unicode characters as icons** — the only unicode used decoratively is the middle dot `·` as a copy separator, and `/` in breadcrumbs.

*Sandbox note:* the kit runs in SVG+JS mode and fetches glyphs from `ka-p.fontawesome.com`, which is blocked inside this preview sandbox. Every card and kit therefore also links `https://unpkg.com/@fortawesome/fontawesome-free@6.7.2/css/all.min.css` as a webfont fallback so icons render here. **In production, keep only the kit script.**

**Footwear silhouettes are not Font Awesome.** `assets/icons/footwear/` holds 25 licensed single-colour SVGs (trainers, running shoes, boots, sole/front/back/side views, care items) used as `<img>` at 24px and up — category icons, empty-state art, technical-sheet views. `assets/silhouettes/` holds 11 solid black shoe silhouettes for print and mono graphic use.

---

## Colour schemes

Set `data-theme` on `<html>` or any wrapper. `riot` is the default and is also declared on `:root`, so an untagged document is fully themed.

`riot` · `spectrum` · `voltage` · `court` · `peach` · `field` · `mint` · `flux` · `candy` · `lagoon` · `press` · `sage`

```html
<html data-theme="voltage" data-mode="dark">
```

`guidelines/theme-switcher.card.html` is the implementation reference; every UI kit carries a bottom-left **Preview scheme** selector. Those selectors are review affordances — they are not part of the product UI and should not ship.

---

## Index

### Root
| File | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` list only |
| `readme.md` | This document |
| `SKILL.md` | Agent-skill front matter for use outside this project |
| `thumbnail.html` | Homepage tile |

### `tokens/`
`fonts.css` (Google Fonts + family tokens) · `colors.css` (ink ramp, semantic roles, status, dark mode) · `themes.css` (the 12 schemes) · `typography.css` · `spacing.css` · `shape.css` (radii, borders, shadows) · `motion.css` · `texture.css` (pattern/stripe motifs) · `base.css` (element defaults, link colours, text and structural utilities)

### `assets/`
`illustrations/` — 9 flat vector sneakers (`sneaker-art-01…09.svg`) · `icons/footwear/` — 25 footwear line icons · `silhouettes/` — 11 solid shoe silhouettes · `patterns/` — 18 geometry grid and motif tiles · `backgrounds/` — 4 black-geometry, 3 halftone textures

### `components/` — 52 exports across 8 groups

**core/** — `Button` `IconButton` `Badge` `Tag` `Card` (+ `CardMedia` `CardBody` `CardFoot`) `Avatar` `Icon` `Logotype` `Stat` `Marquee` `ProgressBar` `Divider`

**forms/** — `Field` `Input` `Textarea` `Select` `Checkbox` `Radio` `Switch` `Slider` `SizePicker` `SwatchPicker`

**navigation/** — `Navbar` `Tabs` `Breadcrumbs` `Pagination` `SideNav` `BottomNav` `Stepper`

**feedback/** — `Toast` (+ `ToastStack`) `Banner` `Dialog` `Tooltip` `Spinner` `EmptyState`

**data/** — `Table` `PriceTag` `ProductTile`

**chrome/** — `WindowFrame` (+ `WindowToolbar`) `MobileFrame`

**game/** — `HudMeter` `GamePanel` `GameButton` `InventorySlot`

**print/** — `PrintSheet` `PosterHeadline` `Colophon`

Each directory holds `<Name>.jsx`, `<Name>.d.ts` (props contract), `<Name>.prompt.md` (what & when, usage, variants) and one `@dsCard` preview page.

Components are compiled into `_ds_bundle.js` and reached from plain HTML as `const { Button } = window.KicksDesignSystem_e10ed3` — never `<script src>` a `.jsx` directly.

**Intentional additions** beyond a minimal set, each earning its place from a named surface: `Icon` (wrapper for the supplied Font Awesome kit), `Logotype` (there is no logo file), `SizePicker` and `SwatchPicker` (footwear commerce), `ProductTile` and `PriceTag` (catalogue), `Marquee` (the ticker band motif), `WindowFrame` and `MobileFrame` (desktop and mobile surfaces), the four game primitives, and the three print primitives.

### `guidelines/` — 24 specimen cards
Colours (ink ramp, accent slots, semantic roles, status, all 12 schemes, interactive switcher) · Type (display, body, mono, three-voices-in-use) · Spacing & shape (scale, control heights, gutters in use, radii, borders, shadows, motion) · Brand (wordmark, patterns, CSS motifs, footwear icons, Font Awesome set, illustration, imagery treatment)

### `ui_kits/`
| Kit | Entry | Contents |
| --- | --- | --- |
| `web/` | `index.html` | Home, listing, product, checkout, editorial — click-through |
| `desktop/` | `index.html` | Kicks Studio in macOS / Windows / Linux chrome, six views, dialog + utility windows |
| `mobile/` | `index.html` | iOS and Android side by side: shop, product, drops, locker, bag, account |
| `game/` | `index.html` | Block Run: menu, in-race HUD, loadout, results, options |
| `print/` | `index.html` | A3 poster, A4 lookbook spread, DL hangtag, A5 shelf talker, A4 technical sheet |

Each kit has its own `README.md` describing screens, interactions and the rules it demonstrates.

---

## Known substitutions and gaps

- **Fonts.** No binaries were supplied. Anton, Manrope and Space Mono are served from Google Fonts and chosen as the nearest match to the reference material's condensed-display / geometric-body / technical-mono structure. Supply licensed files and swap the `@import` in `tokens/fonts.css` for `@font-face` rules.
- **Logo.** None in the sources. See above.
- **Photography.** The packs contain no product or lifestyle photography. Screens use the licensed flat vector sneakers and the geometry/halftone textures instead. Real photography will need its own treatment rules added to *Imagery* above.

# Shabby Chic — Design System

A complete, cross-medium design system built on the aesthetics of shabby chic: aged paper, watercolour washes, faded botanicals, distressed vintage type and hairline mats. It is deliberately **medium-agnostic** — the same tokens and primitives drive web pages, desktop applications on three platforms, iOS and Android apps, game interfaces and printed layout.

There is no client, no company and no real brand behind it. "Maison Blanche", "Atelier" and "The Frost Garden" are placeholder products invented purely to demonstrate the system in use; swap them for whatever a consuming project needs.

---

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | Global entry point. Import-only; reaches every token, font and component stylesheet. |
| `tokens/` | `fonts.css`, `colors.css`, `themes.css`, `typography.css`, `spacing.css`, `elevation.css`, `texture.css`, `motion.css`, `base.css` |
| `components/` | 47 React primitives in nine groups, plus the `controls.css` / `surfaces.css` / `kits.css` stylesheets they reference |
| `ui_kits/web/` | Maison Blanche — commerce site and journal (4 screens) |
| `ui_kits/desktop/` | Atelier — studio manager in macOS, Windows and Linux shells |
| `ui_kits/mobile/` | Atelier — iOS and Android app, side by side (5 screens) |
| `ui_kits/game/` | The Frost Garden — title screen, in-world HUD, inventory |
| `ui_kits/print/` | Catalogue spread, invitation suite, workshop poster |
| `ui_kits/theme-switcher.js` | Preview harness that injects a colour-scheme picker. Not part of any product UI. |
| `templates/landing-page/` | Design Component template: aged-paper marketing page |
| `templates/invitation-card/` | Design Component template: printable 5 × 7 stationery card, front and reverse |
| `guidelines/` | 28 foundation specimen cards (Colors, Type, Spacing, Brand) |
| `assets/fonts/` | Nine licensed display faces shipped with the system |
| `assets/textures/` | Aged paper scans, seamless florals, watercolour wash squares |
| `assets/florals/` | Transparent botanical cut-outs, wreaths, banners |
| `assets/objects/` | Watercolour object cut-outs used as product and item imagery |
| `assets/photos/` | Full-bleed photographic grounds |
| `thumbnail.html` | Homepage tile |

---

## Sources supplied

- **Attached codebase (asset library)** — `Shabby Chic Assets/`, mounted read-only. 422 files: eleven watercolour / junk-journal image packs, one watercolour element pack (florals, wood elements, wreaths and banners, seamless patterns, card templates), a watercolour-squares set, and five type families. Nothing in it was code — there were no components, no CSS and no design-token definitions, so every component contract in this system was authored here rather than transcribed.
- **Uploaded reference images** — ten screenshots and photographs of shabby-chic web templates, stationery, junk-journal spreads and product graphics, in `uploads/`. Used only as directional reference for layout, density and colour temperature.
- **Icon kit** — Font Awesome kit `559791bdc6`, embedded from `https://kit.fontawesome.com/559791bdc6.js`.
- **Colour-scheme briefs** — twelve external palettes (coolors.co) supplied as hex sets, plus the house palette derived from the asset library. All thirteen are implemented in `tokens/themes.css`.

No image, logotype, name or line of copy from any supplied reference appears in the system. All product names and copy are invented.

**No logo was supplied, and none has been drawn.** Wherever a mark would go, the system sets the brand name in the display face (see `Shell.jsx`, `thumbnail.html`, the print kit). The `Ornament` component's `monogram` variant is the closest thing to a mark: an ornament-font frame around a letter. If a real logotype arrives, drop it into `assets/` and replace those display-type lockups.

---

## Content fundamentals

The voice is a well-kept English shop that has been trading a long time and does not need to convince you of anything. Dry, specific, quietly funny, never precious about itself.

**Rules**

- **Second person for instructions, first-person plural for the house.** "You'll have a note when it's wrapped." "We matched the green over two afternoons." Never "I".
- **Sentence case everywhere** except three places: eyebrows, button labels and micro-labels, which are uppercase with wide tracking; display headlines, which are uppercase because the display face is caps-only; and price/figure read-outs.
- **Concrete over aspirational.** Say the measurement, the material, the number of days. "190 gsm washed linen, cut and hemmed within four working days" — not "beautifully crafted with care".
- **Admit the flaw; it is the product.** "Uneven slubs and a soft ivory that will fade a shade further in the first year, which is the point." "We got it wrong eleven times."
- **Dry understatement instead of exclamation.** "Do come." "Six or seven a year. Never more." No exclamation marks anywhere in the system.
- **British spelling and idiom** — colour, metre, wrapping, fortnight, "rather".
- **No emoji. Ever.** Not in UI, not in marketing copy, not in game dialogue. Every glyph is Font Awesome or the ornament font.
- **No marketing scaffolding.** No "Discover", "Unlock", "Elevate", "Introducing", "Game-changing". No em-dash-and-restate constructions.
- **Empty states explain, then offer.** "Clippings and notes collect here." + one action.
- **Errors state the fact, not the blame.** "We don't ship to this region." "Payment declined" + the way forward.

**Length**

| Slot | Budget |
| --- | --- |
| Eyebrow | 2–5 words |
| Headline | ≤ 6 words on display, ≤ 12 on serif |
| Button | 1–4 words, no trailing punctuation |
| Card body | 1 sentence |
| Alert body | ≤ 14 words |
| Pull quote | ≤ 20 words (the 34ch measure) |
| Hand annotation | ≤ 8 words, always lowercase |

**Hand-annotation register** is its own voice: lowercase, fragmentary, personal. "aunt vi's roses, july", "swatches posted free — just write", "the third floor, finally", "tea in the yard — do come".

---

## Visual foundations

### Colour

Two layers, always. **Surfaces are aged paper; palette arrives as a wash.** That single rule is what keeps a neon brief looking shabby.

- **Paper ramp** `--paper-0…5` (#FDFBF7 → #C7B49E): every surface. Warm, high-key, never white.
- **Ink ramp** `--ink-0…5` (#2E2724 → #D6CBC0): all type. Sepia-black, never a neutral grey.
- **Heirloom hues**: faded `rose`, `sage`, `porcelain`, `wisteria`, `gilt`, `clay` — five steps each. The house palette.
- **Semantic layer** is what components reference: `--surface-page/card/sunken`, `--text-heading/body/muted/faint`, `--rule-hair/rule/rule-strong`.
- **Status tones** are muted to paper: `--ok/warn/alert/info` at steps 1 / 3 / 5. Step 1 is a background, step 5 is text.
- **Accent derivation**: a theme declares exactly one `--accent`; the seven working tints (`-soft`, `-soft-2`, `-mid`, `-strong`, `-deep`, `-hair`) are computed with `color-mix` in oklab. **Fills use `--accent`; type and borders use `--accent-strong`.** Never set small type in `--accent` on paper.
- Maximum **two background colours per artefact** — the paper and one tinted band.

**Thirteen colour schemes**, applied with `data-theme` on `<html>`, `<body>` or any subtree. Each states five raw palette slots (`--pal-1…5`) plus one accent, and inherits tinted paper automatically:

`heirloom` (default) · `peony` · `harbour` · `provence` · `spectrum` · `orchard` · `seaglass` · `meadow` · `eucalyptus` · `fernlight` · `sorbet` · `carnival` · `midnight-gilt`

### Type

Seven roles, five of them from the shipped faces.

| Role | Family | Where |
| --- | --- | --- |
| Display | **SC Claire** (shipped) | Headlines, figures, brand lockups, stat values. Caps-only, `0.06em` tracking. |
| Display alt | **SC Penelope** (shipped) | Posters, packaging, heavier titling. |
| Serif | **Cormorant Garamond** | Headings and all body copy. 17px / 1.62 default. |
| Interface | **Karla** | Labels, buttons, chrome, table headers, meta. |
| Hand | **La Belle Aurore** | Margin notes, taglines, photo annotations. Never UI or body. |
| Label | **SC Lace** (shipped) | **Decorative only.** A colour font — it paints its own pale pink and ignores CSS `color`, so it can never carry readable text. Display sizes, as ornament. |
| Playful | **SC Enamored** (shipped) | Game titles, novelty ranges. |
| Ornament | **SC Flourishes** (shipped) | Dividers and monogram frames. A–Z each give a different ornament. |

Tracking carries the period feel: `--ls-eyebrow` `.24em`, `--ls-label` `.16em`, `--ls-button` `.11em`, `--ls-display` `.06em`, body `.005em`.

**Two substitutions were needed and should be reviewed** — see Caveats.

### Space, measure, radius

4px root, but the useful values are the odd ones between: `2 4 6 9 12 15 20 26 34 44 58 76 100 132`. Insets are stated, not derived: controls `9 / 18`, cards `22`, panels `26`, large cards `34`.

Measure is capped hard: `--measure` 68ch for body, `--measure-tight` 46ch for alerts and dialogs, 34ch for pull quotes.

**Corners are mostly square.** `--r-xs` 2, `--r-sm` 3, `--r-card` 4, `--r-window` 8. Pills exist only for tags, switches and the Android tab indicator. Nothing in the system uses a 12px+ radius except the phone bezel.

### Backgrounds and texture

Never a flat colour alone, and never a gradient as decoration.

- **Aged paper**: flat paper colour with a real scan multiplied over it at 10–20% opacity (`--tex-lace`, `--tex-porcelain`, `--tex-damask`, the journal scans). `.sc-paper` does it in one class.
- **Seamless florals** tile at 340px for page grounds and endpapers, at `--tex-opacity-soft`.
- **Watercolour wash** is the fill primitive: theme colour as `background-color`, a wash PNG as `background-image`, `background-blend-mode: multiply`. Every primary button, checkbox, switch, progress fill and HUD meter is built this way, which is why they all reskin with the theme.
- **Full-bleed photography** is standard for heroes, always with `--img-grade` and always with a paper veil or scrim under type.
- **Botanical cut-outs** are transparent PNGs from the library — never drawn shapes.

### Imagery

Warm, high-key, gently faded, slightly desaturated. `--img-grade` = `sepia(.10) saturate(.82) contrast(.94) brightness(1.03)`; `--img-grade-deep` for game scenes and background plates. `--img-vignette` is available but used sparingly. No black-and-white, no heavy grain, no cool casts.

### Borders, edges, shadow

- **Hairlines only**: 1px `--rule-hair` inside surfaces, 1px `--rule` between them, 2px `--bw-thick` for emphasis.
- **The signature edge** is a white keyline plus a warm hairline — `--edge-mount` (mounted photograph), `--edge-double` (letterpress card), `--edge-plate` (inset plate). Applied as `box-shadow`, so it composes with elevation.
- **Shadows are warm, wide and low**: `rgb(74 63 58 / .05–.10)` for the contact shadow and a very soft `-14px` to `-30px` spread beneath. Five steps, `--sh-1…5`. No shadow is tighter than 6px blur; none is grey.
- **Inner shadows** define wells: `--inset-well` on every input, switch track and progress track.
- **Protection**: `--scrim-bottom` and `--scrim-flat` for light type on photography; `--veil-paper` for dark type on photography. Type never sits directly on an image.
- **The only glow** in the system is `--glow-accent`, on equipped game item slots.

### Transparency and blur

Sparingly, and only where something floats over content: sticky navbars, mobile bars, dialog scrims, HUD panels. Always `--surface-veil` (paper at 82%) plus `--blur-frost` (`blur(7px) saturate(.88)`) — the desaturation is what stops it looking like glass.

### Motion

Unhurried, and nothing bounces, springs or overshoots. One easing for everything: `--ease-settle` `cubic-bezier(.22,.61,.36,1)`.

| | |
| --- | --- |
| Durations | 90 / 150 / **240** / 380 / 520 ms |
| Hover | `translateY(-1px)` on controls, `-2px` on cards; shadow steps up one; wash shifts position; accent hairline appears |
| Press | `translateY(+1px)`, `--sh-press` inset, wash returns to origin. **Never a scale.** |
| Focus | `--focus-ring` — a paper gap then a 2px accent-soft ring. Always visible, never removed. |
| Disabled | `opacity: .44` plus `saturate(.5)`, no transform |
| Entrance | fade, or fade + 10px rise for dialogs and toasts |
| Reduced motion | all durations and deltas zeroed |

### Layout

- Web page measure `--width-page` 1180px, gutters `--sp-9` (34px), section rhythm `--sp-12` (76px).
- Prose columns `--width-prose` 720px.
- Desktop app `--width-app` 1440px; sidebar 224px, list column 316px, detail fluid.
- Fixed elements: sticky navbar (web), sticky summary card (basket), frosted action bar (mobile product), HUD clusters pinned 20px from each corner (game).
- Print pages carry 64px margins on Letter, 44px on smaller stock.
- Hit targets never below `--hit-min` 44px on touch surfaces.

---

## Iconography

**Font Awesome, kit `559791bdc6`.** Every icon in the system comes through the `Icon` component, which emits the kit's class names and nothing else. Consuming pages load the kit once:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

- **House default is `variant="solid"`.** The brand prefers the thinner outline on large isolated glyphs, so pass `variant="regular"` there — but solid is the default because it is the one weight present in every Font Awesome tier, and a missing weight renders as nothing at all.
- **The kit runs in SVG+JS mode**, which fetches each glyph from `ka-p.fontawesome.com`. That host is unreachable from some sandboxes, so `tokens/fonts.css` also imports the Font Awesome **CSS/webfont** build as the rendering path that always works. Where the Pro kit does load, the kit takes over and the Pro-only names resolve. If you switch the kit to webfont mode in the Font Awesome dashboard, the CSS import in `tokens/fonts.css` can be dropped.
- **`brands`** for social links only.
- **Never hand-rolled SVG.** The asset library contained no icon set, no sprite and no icon font, so there was nothing to copy in; Font Awesome is the substitution and is documented as such.
- **Ornaments are type, not icons.** Dividers, flourishes and monogram frames come from the shipped `SC Flourishes` dingbat face via the `Ornament` component, so they recolour, scale and print like text. Letters A–Z each map to a different ornament — vary the glyph between sections rather than repeating one.
- **Illustration is photographic, not vector.** Empty states, item slots, frames and product imagery use transparent watercolour PNGs from `assets/florals/` and `assets/objects/`.
- **Unicode as glyph** appears in exactly two places: the `…` in Pagination and the `❧` marker on game dialogue choices.
- **No emoji anywhere.**

---

## Components

47 primitives, nine groups. Each has `<Name>.jsx`, `<Name>.d.ts` and `<Name>.prompt.md`, and each directory carries one `@dsCard` thumbnail.

**core** — `Icon`, `Button`, `IconButton`, `Badge`, `Tag`, `Avatar`, `Ornament`

**forms** — `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`

**surfaces** — `Card`, `Panel`, `Frame`, `Ribbon`, `Dialog`, `Accordion`

**navigation** — `Navbar`, `Tabs`, `SidebarNav`, `Breadcrumbs`, `Pagination`

**feedback** — `Alert`, `Toast`, `Tooltip`, `ProgressBar`, `EmptyState`

**data** — `Table`, `StatBlock`, `ListRow`, `PriceTag`

**chrome** — `WindowFrame`, `MobileStatusBar`, `AppBar`, `TabBar`

**game** — `VitalBar`, `ItemSlot`, `DialogueBox`, `ObjectiveList`

**print** — `DropCap`, `PullQuote`, `Caption`, `PageFolio`

### Intentional additions

No source defined a component inventory, so the set above was authored from scratch against the five required application types. Three families exist specifically because of that brief and are worth calling out:

- **`Icon`** — a wrapper over the Font Awesome kit, so consumers never hard-code kit class names and the kit can be swapped in one file. It also means the solid/regular policy is one default, not a per-call decision.
- **`Ornament`** — the system's ornament face is a dingbat font; this component is what makes dividers and monogram frames usable without anyone remembering which letter draws which flourish.
- **`WindowFrame` / `MobileStatusBar` / `AppBar` / `TabBar` / `VitalBar` / `ItemSlot` / `DialogueBox` / `ObjectiveList` / `PriceTag` / `DropCap` / `PullQuote` / `Caption` / `PageFolio`** — the desktop, mobile, game and print families the brief explicitly asked for. They are not standard web-app primitives; they exist because the system has to cover five media.

### Styling contract

Components carry semantic `sc-` class names and reference CSS custom properties only — no CSS-in-JS, no npm packages, no inline theme values. Pseudo-state styling (`:hover`, `:active`, `:focus-visible`, `:checked`) lives in `components/controls.css`, `surfaces.css` and `kits.css`, all reachable from `styles.css`, so a consuming project gets the full interaction model from one stylesheet link.

---

## Caveats

**Two font substitutions.** The asset library shipped five display and script families but no text face and no interface sans. `Cormorant Garamond` (body serif) and `Karla` (interface sans) are loaded from Google Fonts as the nearest match to the reference material. `La Belle Aurore` is likewise a Google substitution for the handwritten annotation role — the shipped `SC Lace` face reads as a light typewriter rather than a hand. **If licensed replacements exist, supply the files and only `tokens/fonts.css` and `tokens/typography.css` need to change.**

**Icon set substituted.** No icon assets existed in the library; Font Awesome is used per the supplied kit.

**No logo.** None was supplied and none was drawn. Brand marks are display-type lockups.

**`SC Lace` is a colour font.** It renders its own pale pink regardless of the `color` property, which puts it under 3:1 on paper at any size. It is therefore scoped to decoration (`.sc-label` at display size) and every label, tag, price line and read-out that once used it now sets in Karla. If you want a delicate lace *text* face, that is a gap worth filling.

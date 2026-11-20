# Brutalist Neo — Design System

A **Neo-Brutalist** design system: flat saturated colour, near-black outlines on everything, hard offset shadows with no blur, oversized display type, and a small amount of deliberately off-axis decoration. It is built to cover five very different surfaces with one visual language — websites, desktop applications on three platforms, iOS and Android apps, video-game UI, and print.

Neo-Brutalism, not Brutalism. The 2010s "brutalist web" look — unstyled HTML, default blue links, monospace on white, deliberate ugliness — is **not** what this system does. Neo-Brutalism is a *designed* style: the raw structure is exaggerated and celebrated rather than hidden, but every decision (colour, weight, offset, corner) is intentional and consistent.

## Sources this was built from

Nothing here is copied from an identifiable product or brand. The system was designed from the material below and from published descriptions of the style.

**Attached asset library** (mounted read-only as `Neo-Brutalism Assets/`) — a licensed pack of generic Neo-Brutalist graphic assets and display fonts. Copied into `assets/`:

| Source folder | Copied to | Count |
|---|---|---|
| `Neo-Brutalism Fonts/{Rayone, Nomine, Song, Zenitha, Neonova, Vectra, Brodish, Brutelo}` | `assets/fonts/` | 10 TTF files |
| `NEO-BRUTALISM-STICKER-PACK-VOL-115354498/SVG` | `assets/stickers/sticker-1…20.svg` | 20 |
| `NEO-BRUTALISM-ABSTRACT-SHAPE-BUNDLE-115351135/SET 1 BUNDLE/SVG` | `assets/shapes/shape-1…22.svg` | 22 |
| `ARROW-NEO-BRUTALISM-ELEMENTS-SET-115351164/SET 1/SVG` | `assets/arrows/arrow-1…35.svg` | 35 |
| `Neo brutalism seamless pattern/Png` | `assets/patterns/pattern-1…5.png` | 5 |
| `Pattern-with-heart-star-and-86230569` | `assets/patterns/pattern-shapes-1…3.png` | 3 |

**Reference imagery** — 39 screenshots and moodboards supplied in `uploads/`. Used only to read the style (structure, colour behaviour, shadow language, type scale). No image, mark, name or line of copy from any reference appears anywhere in this system, and none of the uploads is linked from a design-system file.

**Style references read**
- `https://www.behance.net/gallery/164728311/How-can-I-design-in-the-Neo-Brutalism-style`
- `https://code.grida.co/community/file/1209478811951634271`
- `https://design.tutsplus.com/articles/trend-watch-neo-brutalism-typography--cms-108748`
- CSS helper libraries reviewed for conventions: `matifandy8.github.io/NeoBrutalismCSS`, `neobrutalism.dev`, `github.com/quak-smauga/Neo-brutalism-CSS`, `neubrutalism.com`, `theplusaddons.com/blog/neo-brutalism-web-design`

**Not read.** The asset pack also contains two mobile-app UI kits — `NewsWave-Neo-Brutalism-News-85697037` and `SnapNews-Neo-Brutalism-News-85696646` — supplied only as `.fig`, `.sketch` and `.xd` binaries. Those formats could not be opened from the mounted folder, so **no component, screen, token or value in this system derives from them.** If you want the system aligned to those kits, re-attach one of them as a `.fig` import and they can be read properly.

**No logo was supplied.** There is no brand mark anywhere in this system. Wherever a mark would go, the name is set in `--nb-font-display` (see `guidelines/type-lockup.card.html`). Do not draw one.

## Icons, and one fallback to flag

The supplied Font Awesome kit (`559791bdc6`) is the documented icon source and every page loads it. The kit renders SVG and needs its origin allow-listed, which the design-system sandbox is not — so `tokens/icons.css` also `@import`s the **Font Awesome 6 Free webfont from a public CDN** as a fallback. Same class names, so no markup changes; when the kit loads, its SVG replacement wins. **Delete that one `@import` line from `styles.css` once your domains are allow-listed on the kit.** The system only uses `fa-solid`, `fa-regular` and `fa-brands`, all of which are in the free set.

## Fonts, and one substitution to flag

Eight display faces ship from the asset pack (`tokens/fonts.css`). All are caps-leaning display faces — none is usable as a UI or body face, and the pack contains no text face and no monospace.

Two Google Fonts fill that gap, loaded by remote `@import` at the top of `tokens/fonts.css`:

- **Space Grotesk** → `--nb-font-ui`, every interface label and paragraph in the system.
- **DM Mono** → `--nb-font-mono`, all micro-labels, table headers, data and shortcuts.

**Please supply your own licensed text and mono faces if you have them.** Swapping them is a two-line change in `tokens/fonts.css`; nothing else needs to move.

---

## CONTENT FUNDAMENTALS

**Voice.** Plain, concrete, slightly blunt. State the fact, then stop. The layout is loud, so the writing does not have to be — copy that shouts as well as the design reads as noise. Never explain the joke, never add a second sentence that restates the first.

- Yes: "Two hundred pressed. When they're gone the die is retired."
- No: "We're SO excited to announce our incredible new limited-edition drop!!"

**Person.** Second person for anything the reader does (`Add to bag`, `Keep me signed in`, `Choose a plan`). First-person plural for the organisation's own actions and decisions (`We stopped sanding the edges`). Never first-person singular, and never the passive when an actor exists.

**Casing.** This is the one place the system is strict, because casing carries hierarchy:

| Element | Casing | Face |
|---|---|---|
| Display headlines, mastheads, hero lockups | UPPERCASE | display / poster |
| Section headings | UPPERCASE | display-alt |
| Button and tab labels | UPPERCASE | UI bold, `--nb-tracking-wide` |
| Eyebrows, table headers, status strips, HUD labels | UPPERCASE | mono, `--nb-tracking-widest` |
| Card titles, list rows, field labels *inside* the label chip | Sentence case | UI bold |
| Body copy, hints, captions | Sentence case | UI regular |
| Badges | UPPERCASE | mono |
| Tags | Sentence case | UI medium |

**Length.** Button 1–3 words. Badge 1–2. Eyebrow ≤ 5. Toast one line, one clause. Alert title ≤ 6 words with the detail underneath. Empty-state title ≤ 4 words. Hero headline ≤ 6 words, broken across 2–3 lines so the display face can crush its leading. Body paragraphs 2–4 sentences, `max-width: 68ch`.

**Punctuation.** Full stops in body copy and hints; none in labels, badges, eyebrows or button text. No exclamation marks except inside a `Sticker`, where one is allowed ("Sale!"). Em dashes sparingly, as an aside in prose only — never as a substitute for a colon in a label. Use `·` (middot) to join mono micro-facts: `Issue 14 · Autumn · £6`.

**Numbers.** Always figures, never words: `3 items`, not `three items`. Group thousands with a comma. Zero-pad arcade counters (`ScoreTicker digits={7}`). Units go in the small suffix slot (`StatTile unit`, `PriceTag unit`), not in the figure.

**Emoji: never.** Not in copy, not in UI, not in labels, not as a bullet, not as an icon. Every glyph in this system comes from the Font Awesome kit. Unicode symbols are permitted only as *typography* — `·`, `✦`, `→`, `“` — never as a stand-in for an icon.

**Error and empty copy.** Say what happened and what to do next, in one line each, with no apology. `Check the last four digits.` not `Oops! Something went wrong with your card.` Empty states name the thing and what will fill it: "No messages / When someone writes, it lands here."

**The vibe.** Confident and slightly deadpan. A workshop that knows its work is good and does not need to sell it twice.

---

## VISUAL FOUNDATIONS

### The three rules everything follows

1. **Flat fill.** Every surface is one solid colour. No gradients anywhere — not in backgrounds, not in bars, not in buttons, not in overlays.
2. **Ink outline.** Everything that is an object has a near-black border. 3px is the default (`--nb-border`), 2px for dense hairlines, 4–6px for chrome and game panels, 10px for print slab rules.
3. **Hard offset shadow.** Elevation is a solid ink rectangle offset down-right. `box-shadow: 4px 4px 0 0 var(--nb-ink)`. **No blur, no spread, no alpha.** Ever.

### Colour

Twelve palettes, one contract (`tokens/colors.css`). Switch with `data-nb-theme` on `<html>` or any container; `signal-jade` is the house default and also lives on `:root`.

`signal-jade` · `spectrum` · `midnight-gold` · `voltage` · `coral-slate` · `sherbet` · `clay-ember` · `mint-stack` · `bubble-pop` · `reef-flare` · `harbor-flame` · `sage-fog`

Structure is always the same three-layer stack:
- `--nb-paper` — the page. Often **saturated**: a full-yellow or full-cyan page is correct here, not a mistake.
- `--nb-surface` — cards and sheets, almost always white, so they separate from the loud page.
- `--nb-surface-alt` — banded regions: table headers, modal headers, tab troughs, status bars.

Loud colour is rationed: **one primary action per view.** Two `variant="primary"` buttons side by side is a bug. Pair `primary` with `ghost` or `surface`.

Every fill has a paired `--nb-on-*` text token. **Every pair in every one of the twelve palettes clears 4.5:1**, audited programmatically — so "use the pair" is safe at any size, including a 10px `Badge` or a 12px `Button size="sm"`, which are the smallest text this system puts on a colour fill. Never guess an `on-` colour yourself.

Two layers, and the difference matters:

- **`--nb-c1` … `--nb-c10` are the supplied palette, verbatim.** Never adjusted. Use them for charts, confetti, swatch strips, decoration — anything that carries no text.
- **The semantic fills (`--nb-primary`, `--nb-secondary`, `--nb-accent`, status colours) are contrast-solved.** Where a supplied hex could not carry small text against any legible pairing, the semantic token uses a minimally deepened or lightened derivative of it. Nine of the twelve palettes needed at least one such adjustment; the largest is `harbor-flame`'s primary (`#F95738` → `#CD482E`, because navy-on-orange topped out at 3.3:1 and white-on-orange at 3.26:1). The palette itself is untouched in the ramp.

Colour is never the only signal. Status is fill + glyph + label (`Alert`, `Badge`). A failed objective is a danger fill *and* a cross *and* a strike-through.

**The pairing rule.** If a style sets `background: var(--nb-<role>)`, the `color` in that same style object must be `var(--nb-on-<role>)`. Never `var(--nb-ink)` and never `var(--nb-ink-soft)` — those two are audited against `--nb-paper`, `--nb-surface` and `--nb-surface-alt` only. This applies to nested children too: a muted subtitle inside a row that goes `--nb-highlight` when selected must switch to `--nb-on-highlight`, because `--nb-ink-soft` on a saturated fill drops to around 3:1. Four components broke this rule independently before it was written down, so it is worth checking by hand: search a diff for `background` and `color` in the same object.

### Type

| Role | Token | Face |
|---|---|---|
| Hero headlines | `--nb-font-display` | Rayone — wide heavy caps |
| Section headings, eyebrow tabs, mastheads | `--nb-font-display-alt` | Nomine — condensed slab caps |
| Print mastheads and posters | `--nb-font-poster` | Song |
| Game HUD numerals and labels | `--nb-font-techno` | Neonova |
| Pull quotes, sticker-adjacent display | `--nb-font-round` / `--nb-font-soft` | Brutelo / Brodish |
| Decorative accents, one word at a time | `--nb-font-quirk` / `--nb-font-zen` | Vectra / Zenitha |
| **All interface text and body copy** | `--nb-font-ui` | Space Grotesk |
| Micro-labels, data, shortcuts | `--nb-font-mono` | DM Mono |

Scale runs `--nb-text-2xs` (10px) → `--nb-text-7xl` (120px), plus `--nb-text-hero` (`clamp(44px,9vw,140px)`). Display type uses crushed leading (`--nb-leading-crush` 0.82 to `--nb-leading-tight` 0.95) and negative tracking; body uses 1.45 and zero tracking; mono micro-labels use `--nb-tracking-widest` (0.18em) — that combination *is* the house label.

### Spacing and layout

4-based scale, `--nb-space-1` (2px) → `--nb-space-15` (128px). Containers 640/880/1120/1360px with a fluid `--nb-gutter` of `clamp(16px,4vw,48px)`.

Sections are separated by **full-width rules and colour changes, not whitespace alone** — a 4px ink border or a change of paper is what ends a section. Density is moderate: cards get `--nb-space-8` (24px) of padding, generous but not airy. Bento grids (2–3 columns, mixed spans) are the house arrangement for feature blocks.

Fixed elements: sticky `Navbar`, sticky mobile `AppBar` and `TabBar`, desktop `MenuBar` / `Toolbar` / `StatusBar` pinned inside `WindowFrame`, `Fab` absolutely positioned bottom-right, HUD panels absolutely positioned into screen corners.

### Corners

`--nb-radius-md` **8px is the house default** — this is the softer, friendlier branch of Neo-Brutalism, not the zero-radius branch. `--nb-radius-pill` for tags, nav links and switches. `--nb-radius-sharp` (0) is a deliberate mode switch, used for: all game HUD chrome, tables, print artwork, and any `radius="sharp"` control that has to read as machinery.

### Shadows and elevation

`xs 1px` → `sm 2px` → `md 4px` (default) → `lg 6px` → `xl 10px` → `slab 16px`. There is exactly one exception to the single-shadow rule: `--nb-shadow-stack`, which layers an accent-coloured shadow behind the ink one — **one hero element per view, at most.**

`--nb-shadow-inset` exists for pressed chrome. `--nb-shadow-up` (offset up-left) is for docked elements whose light logically comes from below.

Inner shadows are otherwise unused. There is no ambient shadow, no elevation overlay, no "surface tint at depth 3".

### Motion

Mechanical and short. `--nb-dur` 140ms for transforms and shadows, 90ms for colour, 220ms for sheets and modals. `--nb-ease-snap` `cubic-bezier(.2,.9,.3,1)` is the default; `--nb-ease-overshoot` `cubic-bezier(.34,1.56,.64,1)` is for things that pop in (toasts, stickers, switch knobs); `--nb-ease-step` `steps(3,end)` for loaders and counters.

Nothing fades in. Opacity transitions are used only for dimming disabled and inactive states. The `Loader` steps round in eight notches rather than spinning smoothly, because smooth rotation is the one motion this system does not own. The only continuous motion is `Marquee`. Everything honours `prefers-reduced-motion`, which zeroes the durations and the travel distances in `tokens/motion.css`.

### Hover, press, focus, disabled

This is the system's signature and it is identical on every control, on every surface:

| State | What happens |
|---|---|
| Rest | sits on `--nb-shadow-md`, `translate(0,0)` |
| Hover | **lifts up-left** `translate(-2px,-2px)`, shadow grows to `lg`. Ghost/transparent controls instead fill with `--nb-highlight`. |
| Press | **sinks into its own shadow** `translate(4px,4px)`, shadow to zero |
| Focus-visible | `3px dashed` ink outline at `3px` offset — a dashed ring, never a soft glow, never a colour change |
| Disabled | opacity `0.45`, shadow removed, no transform, `cursor: not-allowed` |

Links are the exception in form but not in spirit: 3px underline in the accent colour, and on hover the whole link fills with `--nb-highlight` like a marker pen.

### Backgrounds, imagery and texture

Backgrounds are, in order of preference: flat `--nb-paper`; a CSS grid or dot field (`.nb-grid-bg`, `.nb-dot-bg`) at ~12% ink; a seamless pattern PNG from `assets/patterns/`; hazard stripes (`.nb-stripe-bg`) for section breaks and empty slots.

Photography is used **inside a hard-outlined plate** (`CaptionedFigure`) — never full-bleed behind text, never with a protection gradient. There is no protection-gradient pattern in this system at all; if type must sit over an image, it sits in an opaque capsule (`Badge`, `Sticker`, `Card`) on top of it. Image treatment stays warm and high-contrast; no duotone, no grain overlay, no desaturation.

`CaptionedFigure` without a `src` renders a hatched placeholder. Ship that rather than a hand-drawn SVG stand-in.

### Transparency and blur

Almost none. Two tokens exist and that is the entire allowance:
- `--nb-veil` — ink at 12%, for grid/dot fields and for knocking back a busy pattern under content.
- `--nb-scrim` — ink at 62%, for modal and bottom-sheet backdrops. The `Modal` scrim also carries a dot field, because a flat wash alone looks like a mistake here.

**`backdrop-filter` is not used anywhere.** No frosted glass, no blur behind sheets, no translucent nav bar. If something needs to sit above content, it gets an opaque fill and a border.

### Decoration

Stickers, shapes and arrows are the system's release valve, and they are rationed: **one or two stickers per view, never three.** They sit off-axis (`--nb-tilt` helpers, or `tilt` props, typically −6° to +12°), overlap their container's border, and carry a `drop-shadow(4px 4px 0 ink)` so the offset shadow reads on a die-cut edge. Decoration never carries information a user needs.

### What this system never does

Aggressive gradients · blurred or coloured soft shadows · glassmorphism and `backdrop-filter` · rounded cards with a coloured left border and nothing else · emoji · hand-drawn SVG icons · bevels, embosses or inner glows · a second primary button in the same view · type below 4.5:1 on its background · smooth continuous spinners · full-bleed photography behind body copy · protection gradients.

---

## ICONOGRAPHY

**One system: Font Awesome**, via the supplied kit. Every page that renders components must load it:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Use the `Icon` component rather than raw `<i>` tags in React (`components/core/Icon.jsx`); it maps `variant` → family and `size` → the `fa-*` size classes.

- **`fa-solid` is the interface weight.** Every control, menu row, status glyph and HUD marker is solid. This matches the system's flat-fill logic — an outline icon next to a 3px ink border reads as unfinished.
- **`fa-regular`** appears in exactly one place: an inactive `TabBar` item, which switches to `fa-solid` when selected. That weight change is the selection cue alongside the highlight fill.
- **`fa-brands`** for third-party marks only — platform sign-in buttons, social links, the platform selector in the desktop kit. Never restyle a brand glyph's colour.
- **`fa-duotone` / `fa-light` / `fa-thin` / `fa-sharp`** are supported by the `Icon` component but unused by the system. Introduce them only with a documented reason.

**Sizing and placement.** Icons inherit `currentColor` and the local font size; do not colour them independently except through an `--nb-on-*` pair. Set `fixedWidth` in any vertical list (`Menu`, `SideNav`, `ObjectiveList`) so glyphs align. Icons in buttons sit at the label's size with `--nb-space-4` (8px) of gap.

**Boxed icons.** The house treatment for a "featured" glyph is a small outlined square with a fill behind it: 30–62px, `--nb-radius-xs`, 2–3px ink border, `--nb-shadow-sm`. See `Alert`, `ListRow`, `EmptyState`, `ResourceBar`.

**No SVG icons.** There are no hand-drawn icons in this system, and you should not add any. The shipped SVGs in `assets/` are *illustration*, not iconography, and they serve different jobs:

| Folder | Count | Job |
|---|---|---|
| `assets/stickers/` | 20 | Die-cut labels — `Sticker`, `EmptyState`, onboarding, stationery |
| `assets/shapes/` | 22 | Abstract layout accents — bento cells, onboarding, poster and title art |
| `assets/arrows/` | 35 | Direction and emphasis in editorial and poster layouts |
| `assets/patterns/` | 8 | Seamless background tiles (PNG). **Character-heavy** — they are cartoon-face collages, so the UI kits deliberately do not use them (the system's no-emoji rule applies to imagery too). They are shipped because they are part of the licensed library; reach for `.nb-grid-bg`, `.nb-dot-bg` or `.nb-stripe-bg` for backgrounds instead. |

**No emoji, ever.** No unicode glyph substitutes for icons. Unicode is allowed only as typography (`·`, `✦`, `“`, `→`).

---

## Components

Fifty-nine exports across ten groups. Every component reads only CSS custom properties, so all of them work in all twelve palettes with no change. Each directory carries a `@dsCard` preview, and each component has a sibling `.d.ts` (props contract) and `.prompt.md` (what and when).

**`components/core/`** — `Pressable`, `Icon`, `Button`, `IconButton`, `Badge`, `Tag`, `Card`, `Sticker`, `Marquee`, `Avatar`, `Rule`

**`components/forms/`** — `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`, `SegmentedControl`

**`components/feedback/`** — `Alert`, `Toast`, `Modal`, `Tooltip`, `ProgressBar`, `Loader`, `EmptyState`

**`components/navigation/`** — `Navbar`, `Tabs`, `Breadcrumbs`, `Pagination`, `SideNav`, `Menu`, `Accordion`

**`components/data/`** — `Table`, `StatTile`, `ListRow`, `KeyValue`

**`components/chrome/`** (desktop) — `WindowFrame`, `MenuBar`, `Toolbar`, `StatusBar`

**`components/mobile/`** — `PhoneFrame`, `MobileStatusBar`, `AppBar`, `TabBar`, `BottomSheet`, `Fab`

**`components/game/`** — `HudPanel`, `ResourceBar`, `AbilitySlot`, `InventoryGrid`, `DialogueBox`, `ScoreTicker`, `ObjectiveList`

**`components/print/`** — `Masthead`, `PullQuote`, `PriceTag`, `StatBand`, `CaptionedFigure`

**`components/theme/`** — `ThemeSwitcher` (also exports `NB_THEMES`)

### Intentional additions

No source defined a component inventory (the asset pack is fonts and graphics; the two bundled mobile kits were unreadable binaries), so this is an authored set sized to the five mandated surfaces. Three entries are worth calling out as deliberate additions rather than conventions:

- **`Icon`** — a Font Awesome wrapper. Added so the kit ID and family/size mapping live in one place instead of being repeated as raw class strings.
- **`Pressable`** — the lift/sink interaction extracted as a primitive, plus `usePress` and `pressStyle`. Added because that interaction is the system's signature and hand-rolling it drifts.
- **`ThemeSwitcher`** — a documentation and preview control, **not** a product UI element. Do not ship it inside an application unless the product genuinely offers twelve schemes.

---

## Index

| Path | What it is |
|---|---|
| `styles.css` | **The single entry point.** `@import` list only — link this one file. |
| `tokens/fonts.css` | Google `@import` + 10 local `@font-face` rules |
| `tokens/icons.css` | Font Awesome CDN webfont fallback (see above) |
| `tokens/colors.css` | Twelve palettes, semantic contract, status colours. Every `--nb-on-*` pair audited at 4.5:1. |
| `tokens/typography.css` | Families, size scale, weights, leading, tracking |
| `tokens/spacing.css` | Spacing scale, radii, control heights, containers, z-index |
| `tokens/borders.css` | Border widths, the hard-shadow ladder, focus ring, lift/sink distances |
| `tokens/motion.css` | Durations, easings, keyframes, reduced-motion overrides |
| `base/reset.css` | Element defaults, link styling, table and blockquote defaults |
| `base/utilities.css` | `.nb-press`, `.nb-stroke`, `.nb-shadow*`, type helpers, background fills, marquee, tilts, print overrides |
| `components/<group>/` | 59 components — see the list above |
| `guidelines/*.card.html` | 31 foundation specimen cards (Colors, Type, Spacing, Borders, Motion, Brand) |
| `guidelines/themes.html` | Colour-scheme playground: live switcher + all twelve applied to the same UI |
| `ui_kits/web/` | Marketing and commerce site — home, shop, product, journal, auth |
| `ui_kits/desktop/` | Desktop app across macOS / Windows / Linux — editor, files, preferences, all dialog types |
| `ui_kits/mobile/` | iOS and Android side by side — onboarding, feed, detail, filter sheet, profile |
| `ui_kits/game/` | Title, HUD, pause/loadout, dialogue, results |
| `ui_kits/print/` | A3 poster, tabloid spread, A4 price list, stationery sheet |
| `assets/fonts/` | 10 TTF display faces |
| `assets/stickers/`, `shapes/`, `arrows/`, `patterns/` | 85 illustration assets |
| `thumbnail.html` | Homepage tile |

Each `ui_kits/<name>/README.md` documents that kit's screens, its working interactions, and what changes for that surface.

## Using it

```html
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Set a scheme on the document, or scope one to a container:

```html
<html data-nb-theme="voltage">
<section data-nb-theme="midnight-gold"> … </section>
```

Then build against the semantic tokens — `--nb-ink`, `--nb-paper`, `--nb-surface`, `--nb-primary` / `--nb-on-primary`, `--nb-stroke`, `--nb-shadow-md`, `--nb-radius-md` — and never hard-code a hex value.

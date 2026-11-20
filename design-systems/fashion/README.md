# Fashion — design system

A design system for a contemporary fashion label: editorial, high-contrast, image-led,
and deliberately restrained in colour until an accent does the work. It covers five
surfaces from one token set — **web, desktop apps, mobile apps, game UI, and print** —
and ships twelve interchangeable colour schemes.

The brand it describes is a small studio label: garments made in runs of two hundred,
sold direct online and through a handful of stockists, with an internal tool for line
sheets and an app for members. That fiction exists only to make the kits concrete; every
component is generic enough to carry any apparel or lifestyle brand.

---

## Sources

Everything here was derived from material supplied by the user. Nothing in this system
reproduces imagery, marks, names or copy from any of it.

**Attached codebase — `Fashion/`** (read-only mount, not included in this project):

| Path | What it is | How it was used |
| --- | --- | --- |
| `glamics-the-fashion-apparel-e-commerce-html-2025-05-21-09-48-57-utc/main-file/` | HTML/SCSS apparel storefront template. Read `assets/scss/main/_variables.scss`, `_global.scss`, `_components.scss`, `sections/_hero.scss`, `sections/_products.scss`, `index.html` | Primary source of numbers: the fluid `clamp()` rhythm, pill button geometry, 10/20/30/40 radius ladder, tinted-panel product grid, 0.25em eyebrow, 0.4s ease transitions, breadcrumb panel, pagination, accordion |
| `package/Mollee - Fashion Store HTML Template/` | HTML/LESS fashion store template. Read `assets/less/variables/base.less`, file tree | Second reference for type structure (display serif + geometric sans pairing, h1 80px / h2 40px ladder) and for the component inventory (brands strip, advantages row, quote, order icons) |
| `Astro_v1.0.0/`, `Couturio_v1.0.0/`, `Ellsi_v1.0.0/`, `Fashen_v1.0.0/`, `casano-…/`, `brightwear-…/`, `glam-…/` | Shopify themes, distributed as `.zip` only | **Not readable.** Their guide `index.html` and folder names were the only signal. See CAVEATS |

**Reference images** (`uploads/`, ten files): fashion e-commerce and lookbook screens used
for high-level direction only — full-bleed portrait imagery, oversized type crossing the
subject, letterspaced uppercase navigation, generous whitespace, one saturated accent.
None was traced, sampled or copied.

**Colour schemes**: twelve Coolors palettes supplied by the user, listed in
`tokens/themes.css` in the order given.

**Iconography**: the user's Font Awesome kit, `fde87cf732`.

---

## CONTENT FUNDAMENTALS

How copy is written in this system. The voice is a maker describing work, not a shop
selling stock.

**Person.** Third person for the label ("the studio", "two hundred were made"), second
person for the customer ("your bag", "two left in your size"). First person plural is
allowed in editorial ("we keep the pattern for two seasons"), never in UI.

**Register.** Plain, concrete, slightly clipped. Facts over adjectives. Numbers are
specific: "720 gsm", "two hundred each", "ready in two hours" — never "premium",
"luxurious", "curated", "elevated".

**Casing.** Sentence case for everything you write. Uppercase is applied by CSS, not
typed — buttons, eyebrows, labels, nav links and tabs all uppercase themselves. Write
`Add to bag`, not `ADD TO BAG`. Serif display headings stay sentence case.

**Length.**

| Slot | Limit | Example |
| --- | --- | --- |
| Eyebrow | 1–4 words, no punctuation | `Autumn edit` · `New arrivals` |
| Statement / poster headline | 2–4 words, breaks by line | `The long coat` |
| Serif display heading | up to 8 words | `Cut once, fit twice, finish by hand` |
| Section title | 2–6 words | `Straight from the atelier` |
| Product title | 2–3 words | `Wool overcoat` |
| Button | 1–3 words, verb first | `Shop the edit` · `Add to bag` |
| Toast | one clause, no title | `Added to your bag` |
| Alert | title + one sentence | `Low stock — two left in your size.` |
| Caption | one sentence | `Wool overcoat, hand-finished hem.` |

**Punctuation.** Full stops in sentences and captions; none in labels, eyebrows, buttons
or badges. Middle dot (`·`) separates metadata, never a pipe or slash: `Autumn 26 · Look 04`,
`Member since 2019`. En dashes for ranges (`XS–XL`), em dashes sparingly.

**Numbers and money.** Prices always mono, always with the symbol, thousands separated:
`$780`, `$1,060`. Quantities in UI are zero-padded mono (`02`, `04 / 12`). Spelled-out
numbers in editorial prose ("two hundred were made"), figures everywhere else.

**Emoji.** Never. Not in UI, not in copy, not in marketing. Icons come from Font Awesome.

**What the voice avoids.** Exclamation marks. "Discover". "Effortless". Urgency theatre
("Hurry!", "Don't miss out") — a countdown states the time and stops there. Rhetorical
questions. Anything that names a feeling the customer is supposed to have.

**Sample strings**, for tone calibration:

> Free shipping over $150
> Two hundred of each, then the pattern is retired
> Studio pickup — ready in two hours
> Cut generously through the shoulder. Size down for a close fit.
> Complimentary repairs for the first two years.
> Your bag is empty. Saved pieces stay for 30 days.

---

## VISUAL FOUNDATIONS

### Colour

Neutral by default, one accent doing all the work. The base layer is a warm-neutral ink
ramp (`--ink-1` `#0d0d0f` through `--ink-6`) on a paper ramp (`--paper-1` white through
`--paper-5`); pure black is reserved for device bezels. Colour arrives through six role
tokens — `--brand`, `--brand-strong`, `--brand-soft`, `--brand-wash`, `--accent`,
`--accent-2` — plus four semantics drawn from the same palette. Swap `[data-theme]` on any
ancestor and every component re-colours; there are twelve schemes, two of them dark
(`midnight`, `neon`).

Ratios in practice: roughly 70% paper, 25% ink, 5% brand. A screen with more than two
brand-filled elements is over-coloured. Tinted panels use `--brand-wash` (5% alpha) or
`--surface-sunken`, never a saturated fill.

### Type

Four families, each with one job.

| Token | Family | Used for |
| --- | --- | --- |
| `--font-display` | Instrument Serif | Editorial headlines, hero titles, dialogue lines, print titles, dialog titles |
| `--font-poster` | Antonio | Condensed uppercase statement type: campaign headlines, game titles, posters, wordmark |
| `--font-ui` | Hanken Grotesk | Every heading, label, body string and control in product surfaces |
| `--font-mono` | JetBrains Mono | Prices, counts, timers, SKUs, specs, game stats — anything a user compares |

Scale is fluid `clamp()` throughout, lifted from the source template's rhythm. Headings
run tight (`-0.03em`), display tighter (`-0.02em`), body at 1.75 line-height. The signature
detail is the eyebrow: 11–14px, `0.25em` letterspacing, uppercase, brand-coloured, sitting
above almost every heading. Micro labels use `0.12em`. Uppercase is always applied by CSS.

### Spacing and layout

A 5px-rooted scale that keeps the source's exact steps — 5, 8, 10, 12, 15, 20, 25, 30, 40,
50, 60, 80, 120 — plus seven fluid `clamp()` pairs for section and card rhythm. Two
containers: a wide fluid shell (`clamp(1100px, 93.8vw, 1785px)`) for shop and app, and a
narrower one (`clamp(1100px, 73.3vw, 1395px)`) for editorial. Text measure caps at 68ch.
Sections breathe at 40→80px vertical; grids gutter at 15→30px.

Fixed elements are rare: the header can be sticky, drawers and dialogs are fixed, game HUD
is absolutely positioned in a nine-slot grid. Nothing else pins.

### Corner radii

Chunky and stepped, and the step carries meaning: **10px** inputs, chips and media inside
cards · **20px** cards and dialogs · **30px** standalone media · **40px** full-bleed panels ·
**999px** buttons, badges and pills. Fluid variants collapse toward square on mobile, as the
source does. Avatars and icon buttons are circles.

### Cards and surfaces

The core surface pattern: a **tinted panel** (`--surface-sunken` or `--brand-wash`, 40px
radius) holding **white cards** (20px radius, no shadow, no border) whose media is clipped
at 10px. A card only gains a hairline border when it sits directly on page white — reviews,
inspector panels. Nothing in the content layer casts a shadow.

### Elevation and shadow

Nearly shadowless by design. Depth reads through hairlines (`--line-1` 10%, `--line-2` 20%,
`--line-3` 42% alpha), tinted surfaces, and image scale. Shadows exist only for layers that
genuinely float: `--shadow-raise` on hover chips, `--shadow-pop` on menus, `--shadow-float`
on dialogs and windows, `--shadow-drawer` on off-canvas panels. Focus is a 3px
`--brand-soft` ring. Dark schemes and game UI may add `--glow-brand` on a selected item.

### Imagery

Portrait-led and full-bleed. Brand ratios: **3:4** product and editorial portrait, **1:1**
category tiles, **4:5** social and mobile hero, **16:9** campaign film, **21:9** desktop hero.
Colour treatment is cool-neutral and clean — no grain, no heavy filter, no duotone; warmth
comes from the garments. Faces and figures are allowed to be cropped by type.

Over imagery, text is protected with a **gradient scrim**, not a capsule:
`--scrim-bottom` (transparent → 72% ink) is the default, `--scrim-flat` (38% flat) for
even washes, and `PromoBanner tone="brand"` for a transparent → brand gradient — the one
gradient this system uses. Capsules appear only as small glass tags (`Tag tone="glass"`).

**This system ships no photography and no logo.** Every image slot is a labelled
`Placeholder` with a hatch fill. See `assets/README.md`.

### Transparency and blur

Used sparingly and only where something overlays something else: dialog scrims
(`--blur-md`), drawer scrims (`--blur-sm`), glass tags, and game HUD panels
(`--glass-bg-inverse` + `--blur-md`). Never on a static page surface, never behind body text.

### Motion

One easing — `cubic-bezier(0.33, 0, 0.2, 1)` — and two durations that matter: **400ms**
for everything interactive (the source template's flat 0.4s, kept deliberately) and
**1000ms** with a 200ms stagger for scroll reveals. No bounce, no spring, no overshoot,
no parallax. `prefers-reduced-motion` zeroes every duration and both scale deltas.

### Interaction states

| State | Behaviour |
| --- | --- |
| Link hover | tint to `--brand` |
| Outline button hover | fill with `--brand`, border matches, label flips to `--on-brand` |
| Primary button hover | darken to `--brand-strong` |
| Ghost button hover | label tints brand, no fill |
| Nav link hover | underline grows from the centre outward |
| Card hover | media scales `1.05`, action row fades in and rises to centre |
| Press | `scale(0.97)` — never a colour change alone |
| Focus | 2px `--brand` outline at 2px offset; form controls also take the ring |
| Disabled | 40% opacity, pointer-events off; sold-out sizes also strike through |
| Selected (swatch) | double ring; selected size inverts to ink |
| Open (accordion / filter) | plus glyph rotates 45° to a cross and tints brand |

---

## ICONOGRAPHY

**Font Awesome, via the user's kit.** Add this to `<head>` before anything that renders an icon:

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

Every component that takes an icon takes a **class string**, not a component:
`icon="fa-solid fa-arrow-right"`. That keeps the system free of an icon dependency and lets
consumers use any style their kit includes.

**Style rules**

- `fa-solid` for actions and current state — bag, search, arrows, plus, close, check, sliders, coins.
- `fa-regular` for saved, optional or not-yet states — heart, eye, user, clock, image, circle.
- `fa-brands` for social and payment marks only.
- Icon size tracks the type beside it: 9–12px inside labels, 13–18px in controls, 18–26px in empty states and HUD.
- Icons are monochrome and inherit `currentColor`. Never a coloured icon on a coloured chip.
- 44px minimum hit target on every icon-only control (`--hit-min`).

**What is not used**

- No emoji, anywhere.
- No unicode characters as icons (`→`, `✓`, `★`) — the middle dot `·` as a text separator is the one exception.
- No hand-drawn or generated SVG icons. If a glyph is missing from Font Awesome, ask for a real asset.
- No PNG icons, no icon sprites, no custom icon font.

**Source note.** The reference templates carried their own icon fonts (a Flaticon-derived
set) and decorative brand SVGs. Neither was copied — both would identify the source, and
the brief specifies Font Awesome. The glyph inventory the system actually relies on is
shown on the **Brand → Iconography** card.

**Logo.** No mark ships and none was invented. Use `Logotype`; see `assets/README.md`.

---

## Index

### Root

| File | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` lines only |
| `readme.md` | This file |
| `thumbnail.html` | Homepage tile for the system |

### Tokens — `tokens/`

`fonts.css` (four families + Google import) · `colors.css` (ink/paper ramps, hairlines,
scrims, semantic aliases) · `themes.css` (**twelve colour schemes**) · `typography.css`
(fluid scale, eyebrow tracking, type shorthands) · `spacing.css` (5px scale + fluid pairs) ·
`radius.css` · `elevation.css` (shadows, blur, glass) · `motion.css` (easing, durations,
reduced-motion) · `layout.css` (containers, breakpoints, z-ladder, platform chrome metrics,
print sheet sizes, HUD insets) · `base.css` (element defaults) · `utilities.css`
(`.fx-container`, `.fx-eyebrow`, `.fx-statement`, `.fx-ph` placeholder, `.fx-scrim`, `.fx-panel`)

### Components — `components/`

| Group | Components |
| --- | --- |
| `core/` | Button, IconButton, Eyebrow, SectionHeading, Badge, Tag, StarRating, Marquee, Logotype, Placeholder |
| `forms/` | FormField, Input, Textarea, Select, Checkbox, Radio, Switch, SwatchGroup, QuantityStepper, RangeSlider, SearchField |
| `commerce/` | ProductCard, PriceBlock, CategoryCard, PromoBanner, CountdownTimer, CartLine, OrderSummary, FilterGroup, ReviewCard |
| `navigation/` | SiteHeader, NavBar, MegaMenu, Breadcrumb, Pagination, Tabs, Drawer, SiteFooter, SliderNav |
| `feedback/` | Accordion, Dialog, Toast, Tooltip, Alert, ProgressBar, EmptyState |
| `chrome/` | MacWindow, WindowsWindow, LinuxWindow, AppSidebar, AppToolbar, PhoneFrame, MobileTabBar |
| `game/` | HudPanel, StatBar, InventorySlot, ObjectiveList, GameMenuButton, DialogueBox, ScoreReadout |
| `print/` | PrintPage, PullQuote, Caption, Colophon, SpecList |
| `theme/` | ThemeSwitcher (+ `FASHION_THEMES`) — documentation control only |

Components are React, but every one of them is a thin wrapper over classes in that
group's stylesheet. Consumers who aren't using React can write the markup directly —
that is exactly what the templates do.

Each directory holds `<Name>.jsx`, `<Name>.d.ts`, `<Name>.prompt.md`, one `<group>.css`
carrying the classes, and one `@dsCard` HTML preview.

### UI kits — `ui_kits/`

| Kit | Entry | Screens |
| --- | --- | --- |
| `web/` | `index.html` | Home, shop listing, product, bag + 3-step checkout, journal post |
| `desktop/` | `index.html` | Fashion Studio in macOS / Windows 11 / GNOME / KDE chrome; line sheet, looks, fabric, settings |
| `mobile/` | `index.html` | Shop app on iOS and Android side by side; feed, product, bag, account |
| `game/` | `index.html` | Title screen, in-game HUD, inventory |
| `print/` | `index.html` | Lookbook cover, editorial spread, line sheet, A4 price list, poster |
| `themes/` | `index.html` | All twelve schemes applied to real components, single and side-by-side |

### Templates — `templates/`

Starting points a consuming project copies wholesale — one `.dc.html` per folder plus a
`ds-base.js` that loads this system. Covers all five surfaces: `storefront-page/`,
`mobile-screen/`, `desktop-app/`, `game-hud/`, `print-page/`. See `templates/README.md`.

### Foundations — `guidelines/`

23 specimen cards across four groups: **Type** (display, poster, UI ladder, mono,
eyebrows, editorial column), **Colors** (brand roles, ink ramp, paper ramp, semantics,
hairlines & scrims, all twelve schemes), **Spacing** (scale, fluid pairs, radii, spacing in
use, containers & breakpoints), **Brand** (wordmark, imagery & placeholders, elevation,
motion & states, iconography, card anatomy).

### Assets — `assets/`

Documentation only; no binaries ship. See `assets/README.md` for what to drop in and where.

---

## Intentional additions

The source templates are static HTML themes with no formal component library, so the
inventory above was reconstructed from their markup and stylesheets. Four families have no
direct counterpart in the sources and were added because the brief asks for surfaces the
templates never covered:

- **`chrome/`** — desktop window chrome and phone shells. Required by the brief's desktop and mobile targets; the sources are web-only.
- **`game/`** — HUD, inventory, dialogue, menu rows. Required by the game-UI target.
- **`print/`** — page frame, columns, pull quote, caption, colophon, spec list. Required by the print target.
- **`theme/ThemeSwitcher`** — a preview control for the twelve schemes, requested explicitly. Not for product UI.

Everything else (buttons, eyebrows, section headings, product cards, promo banners,
countdowns, filters, accordions, pagination, breadcrumbs, drawers, mega menus, reviews,
newsletter forms, swatches, steppers) maps to something the source templates define.

---

## CAVEATS

1. **Seven of the nine attached themes were unreadable.** `Astro`, `Couturio`, `Ellsi`,
   `Fashen`, `casano`, `brightwear` and `glam` ship only as `.zip` archives inside their
   folders, and archives can't be opened from the mount. The system is therefore grounded
   in the two extracted HTML templates (Glamics, Mollee) plus the reference images. If those
   seven matter, unzip them into the folder and the tokens can be reconciled against them.
2. **Fonts are substitutions.** No font binaries were supplied. Instrument Serif, Antonio,
   Hanken Grotesk and JetBrains Mono are Google Fonts chosen to sit in the same territory as
   the sources' Jost / Josefin Sans / Raleway pairing while giving the system a distinct
   editorial voice. Send real licensed files and `tokens/fonts.css` becomes `@font-face`
   rules against local `.woff2`.
3. **No logo, no photography.** By instruction. The brand mark is typeset; every image is a
   labelled placeholder.
4. **Semantic colours are approximations in some schemes.** Four of the twelve palettes
   contain no green or no red, so `--success` / `--danger` reuse the nearest palette member.
   Contrast was chosen by eye, not measured, in `blush`, `candy` and `lagoon` — worth a
   check if you need documented WCAG figures.

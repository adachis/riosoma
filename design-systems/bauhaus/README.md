# Bauhaus Design System

A geometric, print-derived design system for building interfaces across five surfaces: web pages, desktop applications, mobile apps, game UI, and printed matter. It is built on right angles, flat colour, structural rules, hard offset shadows, and a small family of geometric primitives — circle, semicircle, quadrant, triangle, square.

The system is deliberately **not** a recreation of any existing brand. It was developed from a supplied library of Bauhaus-idiom fonts, illustrations and pattern assets plus a set of visual references, and it is intended to be applied to any product.

---

## Sources

| Source | What it gave us |
| --- | --- |
| `Bauhaus Assets/` (attached local folder, read-only) | All shipped fonts, 12 monochrome geometric illustration tiles, seamless pattern and poster grounds. Most of the folder is `.ai` / `.eps` / `.psd` print artwork that cannot be used on the web; only the `.otf`, `.ttf`, `.svg`, `.jpg` and `.png` derivatives were copied in. |
| `uploads/*` (37 reference images) | Visual direction only — website, mobile-app, poster, book-cover and game-menu references in the Bauhaus idiom. **No uploaded image is used in the system itself**, and no name, logo or copy from any reference appears anywhere. |

No Figma file, GitHub repository or product codebase was supplied. There was therefore **no existing component inventory to replicate**, so the system authors a standard cross-platform set (see *Components*), sized to the five named application areas.

### Brand mark

The asset library contained **no logo file**. Nothing has been drawn or reconstructed. Where a mark would go, `Logotype` renders the product name in Geobau (lowercase) next to a two-part geometric lockup assembled from the system's own primitives — a bar and a quadrant. Swap in a real logo when one exists; keep the wordmark's lowercase setting.

### Flagged substitution

The asset pack ships **no monospace face**. `--font-mono` resolves to **Space Mono** from Google Fonts, loaded by `tokens/fonts.css`. It is a geometric, wide-aperture mono that sits comfortably beside Corbert. **If you have a licensed mono, send it and it will be swapped in** — this is the one non-supplied typeface in the system.

---

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | The single global CSS entry point. Consumers link this. Imports only. |
| `tokens/` | `fonts.css`, `colors.css`, `schemes.css`, `typography.css`, `spacing.css`, `effects.css`, `base.css` |
| `styles/` | Component CSS: `controls`, `surfaces`, `navigation`, `feedback`, `chrome`, `game` |
| `components/` | 47 React primitives in seven groups — see below |
| `guidelines/` | 27 foundation specimen cards + the colour-scheme playground |
| `ui_kits/` | Five product recreations: `web`, `desktop`, `mobile`, `game`, `print` |
| `templates/` | Five starting-point templates consuming projects can copy: `web-page`, `desktop-app`, `mobile-screen`, `game-hud`, `print-poster` |
| `assets/fonts/` | 19 webfont binaries (Corbert, Finis Grotesk, Geobau, Dekart, Red Thinker) |
| `assets/illustrations/` | 12 monochrome geometric tiles (`element-01`…`element-12.svg`) |
| `assets/patterns/` | 9 pattern and poster grounds (`.svg`, `.jpg`) |

---

## CONTENT FUNDAMENTALS

**Voice.** Declarative and material. Say what a thing is and what it does; do not sell it. The reference point is a workshop notice, not marketing copy.

- Good: *"Tubular steel, canvas sling. Stacks four deep."*
- Bad: *"Reimagine the way you sit with our revolutionary seating solution."*

**Person.** Second person for instructions and controls (*"Choose a workshop"*, *"You have four sheets in review"*). First person plural only when the organisation is genuinely acting (*"We print Tuesdays"*). Never first person singular.

**Casing.** Sentence case for everything a person reads as language: headings, body, hints, menu items, tags, card titles. UPPERCASE is structural, applied by CSS, and reserved for four things: button labels, field labels, eyebrows, and tab-bar labels. Write those in sentence case in your source and let the stylesheet shout — never type in caps.

**Length.** Headlines one line, ideally two or three words. Body paragraphs under 60 words. Hints under 12 words. Empty states two sentences: what is missing, what to do.

**Numbers and units.** Always specific, always with units, always monospaced (`--font-mono`). *"0.4mm off"*, *"1,842 sheets"*, *"1919–1933"*. En dash for ranges, no space. Never "many", "several" or "a few" when a number is known.

**Punctuation.** Full stops in body copy and hints. No full stop on labels, buttons, badges, eyebrows or single-line card titles. No exclamation marks. No ellipses except on a menu item that opens a dialog (*"Open…"*). Em dashes sparingly — at most one per paragraph.

**Emoji: never.** Not in UI, not in copy, not in documentation. Iconography is Font Awesome solid, and geometric primitives do the decorating.

**Error copy** names the object, states the fact, gives the fix, in that order: *"Plate C is 0.4mm off. Re-pull before the run."* No apologies, no "oops", no blame.

**Vibe.** Confident, plain, unhurried. A person reading this system's copy should feel that someone measured before they wrote.

---

## VISUAL FOUNDATIONS

### Colour

Thirteen interchangeable palettes, all built on the same six role tokens: `--ink` (structural foreground), `--canvas` (page), `--paper` (panels), `--line` (keylines), `--accent-1..5`, and `--on-accent-1..5` for text placed on each accent. Semantic aliases (`--text-primary`, `--surface-card`, `--border-strong`, `--state-danger`…) derive from those, so setting `data-scheme="midnight"` on any container restyles everything inside it. `--scheme-mode` reports `light` or `dark`.

The default scheme, **Werkbund**, is the classic reading: near-black ink `#14110D`, warm cream canvas `#F2EBDC`, paper `#FBF7EE`, and the three primaries — red `#E12B20`, yellow `#F4C60D`, blue `#1E4FA1` — plus a green `#2E7D5B` for the success role. The twelve alternates are Spectrum, Midnight, Voltage, Atelier, Terracotta, Harvest, Lagoon, Neon Moss, Sorbet, Seafoam, Signal and Sage; Midnight and Neon Moss are dark schemes. Where a palette has no natural hue for a semantic state (there is no green in Voltage) one harmonised bridge hex is defined and marked `bridge` in `tokens/schemes.css`.

Neutrals are never a separate grey family — they are `color-mix` of ink into canvas (`--ink-70`, `--ink-24`…), so greys always carry the scheme's temperature.

**No gradients.** Colour is flat and unbroken. The only exceptions in the whole system are the two CSS gradients that draw the select chevron, the 45° hatch on a striped progress bar, and the deliberate `halfsplit` figure.

### Typography

Six faces, one job each. Never two display faces in one composition.

- **Finis Grotesk Cd Black** (`--font-display`) — poster headlines, the loudest line on a page.
- **Finis Grotesk** (`--font-headline`) — section heads, UI titles, app-bar titles.
- **Corbert** (`--font-core`) — everything else: body, UI, labels, buttons. 300–900.
- **Geobau** (`--font-geometric`) — logotype scale only, always lowercase, never below 16px cap height.
- **Dekart** (`--font-stencil`) — numerals, stat values, scores, game titling.
- **Red Thinker** (`--font-editorial`) — print covers and pull quotes.
- **Space Mono** (`--font-mono`) — data, code, timestamps, technical labels. *Substituted, see above.*

Body is 15px/1.5. The ramp doubles: 10, 11, 12, 13, 15, 17, 20, 24, 30, 38, 48, 64, 84, 112, 152. Display type is tracked tight (−0.02em); uppercase micro-type is tracked wide (0.14em labels, 0.24em eyebrows). Headline leading is 0.92–1.05; body 1.5. Slide text never below 24px; print never below 12pt.

### Spacing and layout

4px base unit, doubling scale (`--space-1` … `--space-32`). Twelve-column grid, 24px gutters, 48px page margins. Containers 640 / 960 / 1280 / 1600. Control heights 32 / 44 / 56px; touch targets never below 44px.

Layout is grid-first and asymmetric within the grid: a heavy element pushed to one side, a large void left deliberately empty. Fixed elements are limited to navigation bars, tab bars, toast stacks and modal scrims. Whitespace is a component, not leftover.

### Backgrounds

Flat colour first: `--canvas` for pages, `--paper` for panels, `--ink` for inverted bands. Full-bleed colour bands separated by 6–12px rules are the house device for sectioning a long page.

Imagery is used sparingly and always inside a keylined frame. Two kinds ship with the system:

1. **Geometric motif tiles** — the twelve monochrome grids in `assets/illustrations`, applied as a CSS mask so they take any scheme accent. One per view.
2. **Pattern grounds** — the licensed `.jpg` / `.svg` patterns in `assets/patterns`. At most one per view, never behind body copy.

No photographic house style is defined because the asset library contained no photography. When product photography is introduced, crop it hard to a rectangle, keep it warm and high-key, and place it flush inside a 2px keyline — no rounded corners, no drop shadows on images, no duotone overlays.

### Borders, radii, cards

Rules carry the structure. Six widths: 1, 1.5, 2 (the default keyline), 3, 6 (poster rules and section dividers), 12px (colour slabs). Radius is **zero everywhere**. The only exceptions are `--radius-pill` for deliberate capsule buttons and tags, `--radius-circle` for dots, radios and avatars, and the `quadrant` / `arch` motif radii. There is no 4px or 8px "soft" radius in the system — if you find one, it is a bug.

A card is a rectangle of `--paper` with a 2px ink keyline and a solid offset shadow (`4px 4px 0 var(--ink)`). Flat cards drop to a 1px hairline. Ink cards invert. Cards are separated by rules or by grid gaps, never by shadow alone.

### Elevation and shadow

Elevation is a **solid block of ink offset down-right**, not a blur: 2, 4, 6, 10px. `--shadow-block-accent` offsets in `--accent-1` instead, for a single emphasised card. There is exactly one blurred shadow in the system, `--shadow-overlay`, and it is only permitted under a modal or overlay layer. No inner shadows except `--shadow-inset-hair`, which draws a control's inset keyline.

### Transparency and blur

Rare and purposeful. `--scrim` (72% ink) sits under modals; `--scrim-light` (32%) under transient sheets; `--blur-overlay` (3px) is available for a background behind a full-screen game pause menu. Nothing else in the system is translucent. Frosted glass, glassmorphism and tinted overlays on colour are out of vocabulary.

### Motion

Mechanical: no bounce, no spring, no overshoot, nothing elastic. `--ease-mech` `cubic-bezier(.3,0,.2,1)` is the default; `--ease-out` for entrances, `--ease-in` for exits, `--ease-linear` for rotation and marquees. Durations: 80ms instant, 140ms hover, 220ms state change, 380ms overlay entry, 600ms full-bleed wipe. Fades are used only for scrims; everything else moves or wipes. `prefers-reduced-motion` zeroes every duration and disables the lift.

### Hover and press states

The signature interaction is physical. On hover a block translates `-2px,-2px` and its offset shadow **grows** one step, as if lifting off the page. On press it translates `+2px,+2px` and the shadow collapses to nothing, as if pushed flat. Ghost and bare controls skip the lift and instead take a `--surface-hover` (6% ink) wash, deepening to `--surface-active` (12%) on press. Links change colour only — from `--accent-3` to `--accent-1` — never underline weight.

Navigation is different: a nav link's accent underline wipes in from the left with `scaleX`, and a game menu item slides right.

### Focus

`--focus-ring`: a 3px canvas gap then a 3px `--accent-3` ring, so focus reads on any ground. Never removed, never replaced with a colour change alone.

### Protection

The system uses **capsules, not protection gradients**. Text over a pattern or image sits in a solid `--paper` or `--ink` block with a keyline. There are no scrim gradients over imagery anywhere.

---

## ICONOGRAPHY

**Font Awesome is the system's only icon set**, solid style by default. The asset library contained no icon font, sprite or icon SVGs at all, so there is nothing house-made to copy in — this is an explicit, documented substitution rather than a match to an existing set.

Load the kit once per page, before the components:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Then use the `Icon` wrapper, never a raw `<i>`:

```jsx
<Icon name="arrow-right" />
<Icon name="triangle-exclamation" size="lg" />
<Icon name="spinner" spin label="Loading" />
```

Rules:

- **Solid only.** `regular`, `light`, `thin` and `duotone` are available on `variant` but are off-brand; use them only when a client brand requires it. `brands` is allowed for third-party marks.
- Icons inherit `currentColor` and optical size from their container. Set `size` only when an icon stands alone.
- Icons are never the sole label on a control — `IconButton` requires a `label`, which becomes `aria-label` and `title`.
- **No emoji, ever.** No Unicode pictographs as icons either.
- A handful of system glyphs are deliberately drawn as **geometric blocks rather than icons**, because that is the house idiom: mobile status-bar indicators, the select chevron, the dialogue advance triangle, the game menu marker, the switch knob, and the checkbox ✕. Do not replace these with Font Awesome glyphs.
- Illustration is **not** iconography here. Anything larger than ~24px is built from `Figure` primitives or a `Motif` tile, never from an enlarged icon.

---

## Components

47 React primitives, in seven groups. Each has a sibling `.d.ts` (props contract) and `.prompt.md` (what & when, usage, variants). Each directory has one `@dsCard` HTML preview.

**`components/core/`** — Button, IconButton, Icon, Badge, Tag, Card, Divider, Figure, Motif, Logotype

**`components/forms/`** — Field, Input, Textarea, Select, Checkbox, Radio (+ RadioGroup), Switch, Slider, SegmentedControl

**`components/navigation/`** — Navbar (+ NavLink), SidebarNav (+ NavItem), Tabs, Breadcrumbs, Pagination, Menu (+ MenuItem)

**`components/feedback/`** — Alert, Toast (+ ToastStack), Tooltip, Progress, Spinner, Modal, EmptyState

**`components/data/`** — DataTable, StatBlock, ListRow, Avatar

**`components/chrome/`** — WindowFrame, MenuBar, PhoneFrame, StatusBar (+ HomeBar, NavRail), AppBar, TabBar

**`components/game/`** — HudPanel, Meter, GameMenu, DialogueBox, InventoryGrid

### Intentional additions

No source defined a component inventory, so the set above is authored. Four entries deserve a note because they exist to serve the five named application areas rather than a generic web app:

- **Icon** — a wrapper over the Font Awesome kit, so the icon set can be swapped in one place.
- **Figure / Motif** — the geometric primitive and the tinted motif tile. Without these, consumers would hand-draw SVG, which this system forbids.
- **`components/chrome/`** — desktop window frames and mobile system bars, so a desktop or mobile mock does not need hand-built bezels.
- **`components/game/`** — HUD plate, meter, menu, dialogue box and inventory grid, so game UI applies the same geometry instead of drifting to genre convention.

---

## UI kits

Five recreations under `ui_kits/`, each with its own `README.md` and `index.html`:

- **`web/`** — marketing site: home, work index, article, contact
- **`desktop/`** — a document application, shown in macOS, Windows and Linux chrome, with standard, dialog, utility and palette windows
- **`mobile/`** — the same app on iOS and Android
- **`game/`** — title menu, in-game HUD, inventory and pause overlay
- **`print/`** — A2 poster, editorial spread, trifold panel and business card

Every kit carries a preview-only scheme switcher **outside** the mocked interface, so all thirteen palettes can be seen applied to a real screen. The switcher is demo chrome; it is never part of the design being shown.

`guidelines/scheme-playground.html` is the dedicated cross-scheme preview: one composition, thirteen palettes, side by side.

---

## Templates

Five starting points a consuming project can copy, one per application area. Each lives in `templates/<slug>/` with a `<Slug>.dc.html` entry and a sibling `ds-base.js` — the single file whose `base` line points at this design system.

| Template | Folder | What it starts you with |
| --- | --- | --- |
| Web page | `templates/web-page/` | Nav, poster hero with a tinted motif, stat band, four-card catalogue grid, ink call-to-action band, footer |
| Desktop app | `templates/desktop-app/` | macOS window: menu bar, sidebar groups, toolbar, zebra data table, inspector panel, status bar |
| Mobile screen | `templates/mobile-screen/` | iOS and Android phones side by side: status bars, large titles, segmented filter, list rows, tab bars |
| Game HUD | `templates/game-hud/` | 16:9 stage with status plate, objective plate, dialogue box and inventory hotbar |
| Print poster | `templates/print-poster/` | A2 poster artboard plus a business card, on a desk ground |

The UI kits are the fuller, click-through recreations; the templates are the trimmed starting points.

# Diagram — design system

**Diagram** is a design system built on the visual language of technical drawing: exploded assembly views, blueprints, patent plates, wiring schematics, instruction-manual line art and architectural plans. It treats an interface the way a draughtsperson treats a sheet — bounded by hairlines, annotated in mono, dimensioned, and signed off in a title block.

It is deliberately **generic**: no company, product or industry owns it. Everything in this repository is original work produced for this system. The sample product used throughout the UI kits — a drawing-management platform also called *Diagram* — is fictional, invented purely to give the components somewhere real to live.

## Where this came from

The brief supplied a name (*Diagram*) and 25 reference images in `uploads/`: mechanical exploded views, engineering drafts, an architectural plan, blueprint-style abstract vector plates, line-art anatomy and face diagrams, mid-century monoline geometry sets, a product instruction manual, wireframe tooling screenshots and an architecture-of-a-system diagram.

Those images were used **only** as directional reference. Nothing was traced, copied, extracted or embedded. No logo, mark, colour, photograph, illustration or copy from any reference appears in this system, and no reference is shipped as an asset.

The twelve colour schemes were supplied as Coolors palettes and are reproduced faithfully. Their source URLs are listed under [Colour schemes](#colour-schemes).

- Source codebase: none supplied.
- Figma file: none supplied.
- Slide template: none supplied — so this system ships no sample slides.
- Logo / brand mark: **none supplied**. Per the rules of this build no mark was invented. Wherever a logo would go, the word *Diagram* is set in Archivo with a rule beneath it (see `guidelines/brand-wordmark.card.html`).

---

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. Nothing but `@import` lines. |
| `tokens/` | `fonts.css`, `palette.css`, `color.css`, `typography.css`, `space.css`, `line.css`, `surface.css`, `motion.css`, `base.css` |
| `components/` | 12 groups of React primitives + `components.css` which imports each group's stylesheet |
| `ui_kits/` | `web/`, `desktop/`, `mobile/`, `game/`, `print/` — full click-through recreations |
| `templates/` | Five starting points consuming projects can copy: `web-page/`, `desktop-app/`, `mobile-screen/`, `game-hud/`, `print-sheet/` |
| `guidelines/` | 23 foundation specimen cards (Colors, Type, Spacing, Line, Motion, Brand) |
| `thumbnail.html` | Homepage tile |
| `readme.md` | This file |

---

## Content fundamentals

Diagram's copy sounds like a competent engineer explaining something to a colleague who is also competent. Plain, specific, unhurried, faintly dry. It never sells, never performs enthusiasm, and never hedges.

**Person and address.** Second person for instruction ("Torque all fasteners to 4.5 Nm"). First person plural only when the organisation is genuinely the actor ("We stopped arguing about which drawing was current"). Never "I". Never a chatty aside.

**Sentences.** Declarative and finished. Diagram will write a long sentence if the thought is long. It does not write fragments for rhythm, does not open with "And" or "But" for effect, and does not use the "X, not Y" construction. Rhetorical questions are absent.

**Casing.**
- Sentence case for headings, buttons, list rows, menu items and body copy. `Publish revision`, not `Publish Revision`.
- **UPPERCASE, letterspaced 0.12em, in the mono** for annotation labels only: field labels, card headers, table headers, legends, status badges, title-block keys. `WALL THICKNESS`, `REV C`, `SHEET 1 OF 3`.
- Never all-caps a sentence. Never all-caps for emphasis.

**Numbers.** Always exact, always in the mono, always with a unit where one exists: `0.025 mm`, `±0.05`, `4.5 Nm`, `1:2`, `412 g`, `99.95%`. Diagram never writes "a few", "several" or "some" where a figure exists. Rounded marketing numbers are permitted only when labelled as such.

**References.** Anything identifiable gets an identifier, set in mono: `DWG-0412`, `PN-2201`, `REV C`, `FIG. 04`, `TAB. 01`, `Section B — B`. This is the single most recognisable habit in Diagram's copy.

**Errors and warnings.** State what happened and what the reader can do. No apology, no exclamation. "Feature 12 exceeds the ±0.05 band." "Revisions cannot be deleted. Withdrawing marks a revision withdrawn and keeps it readable."

**Empty states.** Say what will appear and how to make it appear. "Sheets you create appear here with their revision history."

**Emoji: never.** Not in UI, not in docs, not in marketing. The only non-alphabetic glyphs Diagram uses are the drafting marks it draws itself (`Ø`, `±`, `×`, `—`, `▲`, `▼`) and Font Awesome icons.

**Example voice, side by side.**

| Off-brand | Diagram |
| --- | --- |
| "Oops! Something went wrong 😅" | "Export failed. Plate 3 references a missing part." |
| "Supercharge your workflow!" | "Every number on the drawing, agreed before anything is made." |
| "Pretty fast sync" | "Median review time 4.1 hrs" |
| "Are you sure?" | "REV C will be superseded and stays readable in the archive." |

---

## Visual foundations

### Colour

Every surface resolves to **paper** and **ink**. A colour scheme declares only twelve anchors — `--paper`, `--ink`, `--accent`, `--accent-ink`, `--accent-2`, `--accent-2-ink`, `--hi`, `--ok`, `--warn`, `--danger`, `--info`, plus the raw ramp `--p-1…--p-n`. Everything else (`--surface-raised`, `--text-mute`, `--rule-hair`, `--accent-wash`, `--danger-ink`, …) is derived from those with `color-mix` in `tokens/color.css`. Swap the scheme and the whole interface re-derives; nothing is hardcoded downstream.

Accent is used sparingly and always to mean *this one*: the selected item, the focused control, the current step, the released revision. A screen with accent on six things is wrong.

Imagery in Diagram is **line art on paper** — cool, high-contrast, no grain, no photographic warmth. Where a photograph must appear, it is placed inside a `Figure` plate so the grid frames it.

### Type

Two families, no more.

- **Archivo** (`--font-core`) — every reading and interface surface. Tight tracking (`-0.02em` to `-0.045em`) above 20px, normal below. Weights 300–800.
- **IBM Plex Mono** (`--font-annotate`) — anything that behaves like an annotation on a drawing: labels, measurements, references, timestamps, table figures, code, captions, status text. Tabular figures always.
- **Archivo Narrow** (`--font-condensed`) — display only, for poster and flier headlines.

The pairing is the system's tell. A Diagram screen is grotesque prose interrupted by mono annotation, exactly as a drawing is geometry interrupted by dimensions.

Scale runs `--fs-2xs` 10px to `--fs-9xl` 128px. Interface lives between 10 and 23; display starts at 28.

### Spacing and layout

A 2px drafting increment: 2, 4, 6, 8, 12, 16, 20, 24, then doubling — 32, 40, 48, 64, 80, 96, 128, 160. Named layout tokens fix the recurring widths: `--col-sidebar` 248px, `--col-inspector` 296px, `--col-rail` 56px, `--page-max` 1240px, `--measure` 68ch.

Layout is **orthogonal and edge-aligned**. Content sits inside frames; frames butt against each other and share a hairline rather than floating apart with a gap. Sticky headers and docked panels are normal; free-floating cards over a background are not.

### Line — the load-bearing device

Diagram builds structure out of **1px rules**, not shadows, fills or rounded containers. Five weights (`0.5 / 1 / 1.5 / 2 / 3px`) and five rule colours (`--rule-ghost` through `--rule-ink`). Line *style* carries meaning, borrowed directly from drafting:

| Style | Means |
| --- | --- |
| Solid | A real boundary — cards, inputs, tables, windows |
| Dashed (`--rule-mid`) | Provisional, empty, disabled, drop target, hidden edge |
| Dashed (`--rule-ghost`) | Construction line — alignment only, never load-bearing |
| Solid accent | Selected, focused, active |
| Centre line (long-short-short) | An axis or symmetry marker |

### Corner radius

**Zero is the default.** `--radius-1` (2px) is permitted on controls to keep them from looking laser-cut; `--radius-2` (3px) is the ceiling. The only genuinely round things in the system are circles that mean something: callout bubbles, radio dots, timeline markers, status dots, and platform-mandated chrome (macOS traffic lights, Android nav pill).

### Cards and elevation

A card is a hairline rectangle on `--surface-raised` with an optional mono header row (`LABEL` left, reference code right) and an optional footer. **No drop shadow.** Depth, where genuinely needed, comes from a second hairline plus a low cool shadow:

- `--lift-0` flush content
- `--lift-1` seated / pressed
- `--lift-2` menus, popovers, floating toolbars
- `--lift-3` dialogs, windows, sheets

For pinning emphasis, a card gets **corner registration ticks** (`ticks` prop) rather than a heavier shadow. One or two per screen, never more.

### Transparency and blur

Used only where a surface genuinely sits over something else: sticky web headers, the macOS menu bar and title bar, iOS nav and tab bars, and game HUD panels. `--blur-panel` is `saturate(140%) blur(10px)`. Never used decoratively, never on a card sitting on flat paper.

### Backgrounds and substrates

Four paper patterns, all tokenised: `--paper-grid-fine` (8px), `--paper-grid-major` (64px), `--paper-dots`, `--paper-hatch`. Grid is for drawing plates and canvases; dots for empty states and blank slates; hatch for placeholders and unavailable regions; a 45° accent hatch (`--paper-section`) marks a cut or selected region.

**No gradients as decoration.** The only gradients in the system are the two-stop scrim (`--scrim-ink`) used to protect text over imagery, and the GNOME header bar, which is copying a platform. Protection is by scrim or by an opaque capsule — never by a soft glow.

### States

- **Hover** — border moves to `--accent`, fill moves to `--accent-wash`, text moves to `--text-strong`. Never a scale change, never a shadow bloom.
- **Press** — fill deepens to `--accent-press` / `--accent-wash-strong`. Nothing moves, nothing shrinks. Instruments do not bounce.
- **Focus** — `2px` solid `--focus-ring` (the secondary accent, so it never collides with the accent-coloured selected state) at `2px` offset. Always visible, never removed.
- **Selected** — accent border plus an accent edge marker (2–3px on the leading edge for list rows and nav items).
- **Disabled** — 35–40% opacity; dashed border where the element is a container.

### Motion

Short and mechanical: 80 / 120 / 180 / 280ms, plus 520ms for line-draw reveals. Easing is `cubic-bezier(.2,0,.2,1)` — fast out, settled, **no overshoot and no bounce anywhere in the system.** Things appear by drawing in (`dg-draw`, `dg-sweep`) or by simply being there; they do not fade up from 0 with a scale. `prefers-reduced-motion` zeroes every duration.

---

## Colour schemes

Twelve variants ship. Apply with `data-theme="<id>"` on `<html>`, `<body>` or any container — they nest, so a single component can be previewed in a different scheme inside a page.

| id | Name | Source palette |
| --- | --- | --- |
| `drafting` | Drafting *(default)* | https://coolors.co/palette/e63946-f1faee-a8dadc-457b9d-1d3557 |
| `spectrum` | Spectrum | https://coolors.co/palette/f94144-f3722c-f8961e-f9844a-f9c74f-90be6d-43aa8b-4d908e-577590-277da1 |
| `midnight` | Midnight *(dark)* | https://coolors.co/palette/000814-001d3d-003566-ffc300-ffd60a |
| `voltage` | Voltage | https://coolors.co/palette/390099-9e0059-ff0054-ff5400-ffbd00 |
| `bisque` | Bisque | https://coolors.co/palette/f6bd60-f7ede2-f5cac3-84a59d-f28482 |
| `field` | Field | https://coolors.co/palette/233d4d-fe7f2d-fcca46-a1c181-619b8a |
| `lagoon` | Lagoon | https://coolors.co/palette/22577a-38a3a5-57cc99-80ed99-c7f9cc |
| `reactor` | Reactor *(dark)* | https://coolors.co/palette/00fddc-2e5339-495f41-ff5666-ffccc9 |
| `bubblegum` | Bubblegum | https://coolors.co/palette/70d6ff-ff70a6-ff9770-ffd670 |
| `tidewater` | Tidewater | https://coolors.co/palette/247ba0-70c1b3-b2dbbf-f3ffbd-ff1654 |
| `archive` | Archive | https://coolors.co/palette/083d77-ebebd3-f4d35e-ee964b-f95738 |
| `sagebrush` | Sagebrush | https://coolors.co/palette/3c493f-7e8d85-b3bfb8-f0f7f4-a2e3c4 |

Every palette is reproduced exactly. Where a palette contains no hue for a semantic role — several have no green, and `midnight` has no red — that one anchor is derived to sit harmoniously with the palette rather than pulled from an unrelated ramp. Derived anchors are listed in `tokens/palette.css`.

`ThemeSwitcher` previews all twelve. It is a **documentation device**: put it in specimens, kit previews and demos, never inside a product surface you are designing.

---

## Iconography

**Font Awesome, via the supplied kit.** Add this to `<head>`:

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

- **Default style is `fa-regular` (outline).** It matches Diagram's hairline weight. Reach for `fa-solid` only for filled state markers (check ticks, carets, status glyphs, small chrome glyphs below ~12px where the outline breaks up).
- If the kit has Pro enabled, `fa-thin` and `fa-light` are better still for icons above 18px — substitute freely; nothing in the system depends on the weight.
- Icon sizes come from the type scale, not arbitrary px. The `Icon` wrapper enforces this.
- Icons are `--text-faint` or `--text-mute` at rest and take `--accent` when their element is active. An icon is never the only signal for state.
- **Emoji are never used.** Unicode is used as a glyph only for typographic marks that Font Awesome does not carry: `Ø ± × — ▲ ▼ ✕ ▸`.
- Diagram's own graphic marks — corner ticks, callout bubbles, leader lines with dot terminators, dimension caps, centre lines — are drawn in **CSS, not SVG**, so they inherit tokens and scale with the layout. They live in the `annotation` component group; do not hand-draw replacements.

No icon assets are bundled, because the kit is CDN-delivered and no source set was supplied. `assets/` therefore contains no icons or logos by design.

---

## Components

70 exports in 12 groups. Each directory holds `<Name>.jsx`, `<Name>.d.ts`, `<Name>.prompt.md`, one `@dsCard` HTML, and the group's stylesheet.

**Core** (`components/core/`) — `Button`, `IconButton`, `Icon`, `Badge`, `Tag`, `Stat`, `Divider`, `Kbd`

**Forms** (`components/forms/`) — `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`

**Surfaces** (`components/surfaces/`) — `Card`, `Panel`, `Dialog`, `Sheet`, `Figure`, `TitleBlock`

**Annotation** (`components/annotation/`) — `GridFrame`, `Callout`, `LeaderNote`, `DimensionLine`, `Legend`

**Navigation** (`components/navigation/`) — `Tabs`, `Breadcrumb`, `Menu`, `SideNav`, `Toolbar`, `ToolbarSeparator`, `ToolbarSpacer`, `ToolbarLabel`, `Stepper`

**Feedback** (`components/feedback/`) — `Alert`, `Toast`, `Tooltip`, `Progress`, `StatusDot`, `EmptyState`

**Data** (`components/data/`) — `Table`, `KeyValue`, `Timeline`, `Tree`

**Desktop chrome** (`components/chrome/`) — `MacWindow`, `WindowsWindow`, `LinuxWindow`, `MenuBar`

**Mobile** (`components/mobile/`) — `PhoneFrame`, `IOSNavBar`, `IOSTabBar`, `AndroidAppBar`, `AndroidNavBar`, `ListRow`, `SegmentedControl`, `Fab`

**Game** (`components/game/`) — `HUDPanel`, `ResourceMeter`, `AbilitySlot`, `DialogueBox`, `ObjectiveTracker`, `Crosshair`

**Print** (`components/print/`) — `PrintPage`, `Masthead`, `PullQuote`, `Caption`

**Theme** (`components/theme/`) — `ThemeSwitcher` (plus the `DIAGRAM_THEMES` data export)

### Intentional additions

No source defined a component inventory, so the standard set was authored from scratch. Beyond the usual primitives, four groups exist because the brief names four extra surfaces:

- **Annotation** — the family that makes this system what it is. Without `GridFrame`, `Callout`, `LeaderNote`, `DimensionLine` and `Legend`, Diagram is just a tidy grey UI kit.
- **Desktop chrome** — the brief asks for window chrome on all three platforms and for every window type.
- **Mobile** — iOS and Android bars are platform-accurate in geometry and behaviour; only the styling is Diagram's.
- **Game** — the brief explicitly asks that game UI keep the system's language rather than adopt conventional game-UI conventions, so the HUD is built from frosted drawing plates, gauges and centre marks.

`Icon` is a thin Font Awesome wrapper, added so glyph sizing stays on the type scale.

---

## UI kits

Each kit is a click-through recreation, composed from the primitives above — no component is re-implemented inside a kit.

| Kit | Entry | Screens |
| --- | --- | --- |
| Web | `ui_kits/web/index.html` | Marketing overview, API documentation, pricing |
| Desktop | `ui_kits/desktop/index.html` | One workspace in macOS, Windows 11 and GNOME chrome |
| Mobile | `ui_kits/mobile/index.html` | Field app on iOS and Android, side by side |
| Game | `ui_kits/game/index.html` | In-game HUD and full-screen manifest |
| Print | `ui_kits/print/index.html` | Report page, component spec sheet, A4 flier |

Every kit carries a `ThemeSwitcher` so all twelve schemes can be checked against real screens. Each kit has its own README describing what it demonstrates and which interactions work.

No sample slides ship, because no slide template was supplied.

## Templates

Five starting points, one per surface the brief names. Each is a Design Component that loads this system through its sibling `ds-base.js`, so a consuming project only edits one path line.

| Template | Entry | Starts you with |
| --- | --- | --- |
| Web page | `templates/web-page/WebPage.dc.html` | Sticky header, annotated hero plate, capability grid, title-block footer |
| Desktop app | `templates/desktop-app/DesktopApp.dc.html` | macOS-framed three-pane workspace with tree, canvas and inspector |
| Mobile screen | `templates/mobile-screen/MobileScreen.dc.html` | iOS and Android list screens side by side |
| Game HUD | `templates/game-hud/GameHud.dc.html` | Vitals, objectives, reticle, hotbar and dialogue over a schematic scene |
| Print sheet | `templates/print-sheet/PrintSheet.dc.html` | A4 component specification sheet ending in a title block |

## Assets

`assets/` is intentionally empty. No logo, icon set, illustration or photograph was supplied with the brief, and nothing was invented or extracted from the reference images. Iconography comes from the Font Awesome kit over CDN; Diagram's own graphic marks are drawn in CSS by the `annotation` components.

---

## Using it

```html
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
<body data-theme="drafting"> … </body>
```

Then import components, or read the tokens directly. Every visual decision in this system is reachable as a CSS custom property; if you find yourself writing a literal colour, radius or shadow, the token you want already exists.

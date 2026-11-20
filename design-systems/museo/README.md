# Museo Design System

Museo is the design system of a fictional contemporary art museum — **Museo, Museum of Modern Practice** — built as a general-purpose "cultural institution" system. It is deliberately quiet, typographic and rule-based: paper and ink, one hot accent, square corners, thin keylines, generous air. It is designed to survive being applied to very different surfaces without changing its manners: a public website, a collections-management desktop app, a visitor phone app, a game interface, and printed matter.

Nothing in this system is copied from a real institution. It was developed as an *interpretation* of the shared visual language of large art-museum digital properties (see Sources), not a replica of any one of them.

## Sources given in the brief

- Reference sites named in the brief: `https://www.moma.org/`, `https://www.thebroad.org/`, `https://www.walkerart.org/`, `https://www.getty.edu/`. These were used as a description of a *category* (editorial grotesque type, ink-on-paper neutrals, one saturated accent, rule-driven layout, full-bleed imagery). No code, screenshot, asset, name, logotype or copy from any of them is present in this project.
- Colour-scheme references: twelve Coolors palettes supplied in the brief, implemented verbatim as the twelve alternate schemes in `tokens/themes.css` (plus the default **Gallery** scheme, which is Museo's own).
- Iconography: the user's Font Awesome kit, **ID `fde87cf732`**, loaded as `<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>`.
- Image references were mentioned in the brief but **no image files were attached to the project**, so none were read and none are used. See Caveats.
- No codebase, Figma file or slide deck was attached. There was therefore no existing component inventory to mirror; the component list is the from-scratch standard set plus the platform/game additions listed under "Intentional additions".

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. Nothing but `@import` lines. |
| `tokens/fonts.css` | Google Fonts import for Syne, Public Sans, Martian Mono. |
| `tokens/colors.css` | Base palette, the 15-value theme channel, semantic aliases. |
| `tokens/themes.css` | 13 colour schemes as `[data-theme="…"]` scopes. |
| `tokens/typography.css` | Font stacks, weights, the 11-step type scale, measures. |
| `tokens/spacing.css` | Spacing scale, radii, control heights, layout + z-index. |
| `tokens/elevation.css` | Hairlines, three shadows, protection gradients, blur veils, grain. |
| `tokens/motion.css` | Durations, easings, shared transitions. |
| `tokens/base.css` | Reset, body defaults, link colours, `.museo-*` type utilities. |
| `components/**` | React primitives, one directory per concern, each with a `@dsCard` sheet. |
| `guidelines/**` | Foundation specimen cards, the 13 per-scheme example cards, and the live colour-scheme switcher. |
| `ui_kits/web` | Museum website: home, exhibition, collection search, visit. |
| `ui_kits/desktop` | Collections app in macOS / Windows / Linux chrome, three window types. |
| `ui_kits/mobile` | Visitor app on iOS and Android. |
| `ui_kits/game` | *Museo: After Hours* — title, HUD, pause, codex. |
| `ui_kits/print` | Poster, gallery-guide spread, wall-label sheet, invitation. |
| `assets/README.md` | Why there is no logo file, and where imagery goes. |

## Content fundamentals

Museo writes like an institution that respects the reader's time and doesn't oversell the art.

- **Voice**: plain, concrete, slightly dry. Facts before adjectives. "Twelve rooms of atmosphere, humidity and light, built by nine artists over two years." Not "An unmissable, immersive journey."
- **Person**: second person for anything the visitor does ("Plan your visit", "Arrive within 30 minutes of your slot"); first-person plural only when the museum is acting ("Our conservators spent a year measuring it"). Never first-person singular.
- **Casing**: sentence case for every heading, title, card title and dialog. UPPERCASE is a *typographic role*, not a writing style — it appears only in the mono label style (eyebrows, buttons, metadata, footers) and is applied by CSS, so the source copy stays in sentence case.
- **Length**: page headlines under 6 words; exhibition blurbs 20–35 words; body paragraphs 2–4 sentences at a 64ch measure. Buttons are 1–3 words, verb first: "Buy tickets", "Book a time", "Read the essay".
- **Numbers and dates**: 24-hour clock with an en dash for ranges ("10:00 — 18:00"), day-month for dates ("Thu 18 Sept", "12 June — 14 September 2026"), thousands separated with commas ("212,480"), prices with the symbol and no trailing zeroes ("£14", "From £68 a year").
- **Object copy follows the tombstone order** and never deviates: maker, italic title + year, medium, dimensions, credit line, accession number.
- **Practical information is stated, not softened**: "Level 3 closed. Reinstallation through 12 October." No apology paragraph, no exclamation marks.
- **Emoji: never.** Not in UI, not in marketing copy, not in game text. Unicode symbols are limited to typographic marks — em/en dashes, ×, °, middots as separators (" · ").
- **Terms to avoid**: "immersive", "journey", "unlock", "experience" as a noun, "curated" for anything a curator did not curate, "delight".

## Visual foundations

**Colour.** Ink-on-paper neutrals do the structural work; a single hot accent (vermilion `#D93A14`) marks the one thing that matters on a page. Support colours (deep teal, ochre) appear in data and diagrams, not in chrome. Feedback colours are for state only. A page uses at most **one** accent-filled panel and at most two background values (paper + one of sunken/inverse). Components only ever read semantic aliases (`--surface-raised`, `--text-muted`, `--accent`), never raw palette values, which is what lets all 13 schemes drop in cleanly.

**Type.** Three faces, sharply separated by job: **Syne** (display, 800/600) for exhibition-scale headlines and card titles; **Public Sans** for everything read at length and all UI text; **Martian Mono** for uppercase tracked labels — eyebrows, buttons, metadata, footers, accession numbers, HUD readouts, folios. Display sizes carry negative tracking (−0.03em at 76px); the label style carries +0.14em. Body copy sits at a 64ch measure with `text-wrap: pretty`. Italic is reserved for object titles.

**Spacing and layout.** 12-column grid, 20px gutter, 1360px maximum, 28px page padding. Editorial spans are 6/6, 8+4 or 4/4/4; hero and imagery break the grid entirely and go full bleed. Vertical rhythm comes from the spacing scale (2, 4, 6, 10, 14, 20, 28, 40, 56, 80, 112, 160). Section starts are marked with a 2px ink rule and a mono eyebrow, not with a coloured band.

**Backgrounds.** Flat paper. No gradients as decoration — the only gradients in the system are *protection* gradients (ink to transparent) placed under type that sits on imagery, and one radial vignette in the game HUD. A subtle grain texture token exists (`--texture-grain`) for print-adjacent surfaces; it is off by default. Imagery is treated as documentation: neutral-to-cool daylight photography, real installation views, credited in mono type. No stock warmth, no duotones, no filters.

**Borders, corners, cards.** Corners are effectively square: 2px is the default radius, 3–8px exists for platform chrome, and the pill radius is reserved for `Tag` and media buttons. Cards are a 1px hairline box on raised paper with **no shadow**; alternates are a 2px top-rule-only card (transparent background), an ink-filled card, and an accent-filled card. A card hover darkens its rule and turns the title accent — it does not lift, scale or glow.

**Elevation and shadow.** Rules first, shadow only for things that genuinely float: `--shadow-2` for popovers and floating windows, `--shadow-3` for modals and print sheets. `--shadow-1` is almost invisible by design. There is no inner-shadow system; inset hairlines (`--shadow-hairline`) do that job.

**Transparency and blur.** Used in exactly two situations: a veil over moving imagery or artwork (game HUD panels, in-scene prompts) and the scrim behind a modal. Interface chrome over static paper is never translucent.

**Motion.** Short and unshowy: 120ms for control hover/press, 200ms fades, 320ms panel rises (10px, never more), 520ms for progress. Easing is `cubic-bezier(.2,.7,.2,1)` for almost everything, with a slightly softer entrance curve for panels. No bounce, no spring, no scale-up-on-hover, no parallax. `prefers-reduced-motion` collapses every duration to 1ms.

**Interaction states.** Hover: primary buttons darken one step; secondary buttons *invert* to a solid ink fill; quiet controls take a 5% ink wash; links change colour and their underline goes accent; card titles go accent. Press: 1px downward translate plus the next colour step down — never a scale. Focus: a 2px paper offset ring plus a 2px accent ring (`--shadow-focus`), on every interactive element. Disabled: 40% opacity, no other change. Selected states fill **ink**, not accent, so filter rows stay calm.

**Fixed elements and layout rules.** The utility strip and header sit at the top of the page and scroll away; only the mobile tab bar and the desktop status bar are truly fixed. Modals scrim their nearest positioned ancestor. Game HUD elements hug a 48px safe-area inset at 1280×720. Print pieces keep a 14mm minimum margin and 12pt minimum body size.

## Iconography

- **System**: Font Awesome, via the user's kit `fde87cf732`. Every page in this project loads it from the CDN; there is no local icon font, sprite or SVG set, because none was supplied. The `Icon` component wraps the `<i class="fa-…">` convention so usage stays consistent.
- **Loading**: two tags, in this order — a Font Awesome 6 stylesheet as a resolvable fallback, then the kit script:

  ```html
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css" crossorigin="anonymous">
  <script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
  ```

  The kit alone did not inject its stylesheet in the preview sandbox (kit scripts are domain-scoped), which left every glyph invisible. The fallback stylesheet keeps the icon layer visible everywhere; in a production environment on your own domain the kit takes over and the `<link>` can be dropped.
- **Families**: `fa-solid` for controls, chrome, wayfinding and anything a user acts on; `fa-regular` for content metadata (dates, bookmarks, images, users); `fa-brands` for social links only. Duotone, thin and light are not used.
- **Sizing**: icons inherit the text size in buttons and labels; standalone icons are 13px (small controls), 17px (default), 20px (feature lists). Icon-only controls are always 30/38/46px squares with an accessible label.
- **Colour**: icons take `currentColor`. Accent-coloured icons appear only in feature lists and banner tones.
- **Never**: emoji as icons, unicode dingbats as icons, hand-drawn SVG substitutes, or two icon styles in one control group.

## Components

Grouped by concern; every directory has a `@dsCard` sheet showing states and variants, and every component has a `.d.ts` props contract and a `.prompt.md` usage note.

- **`components/core`** — `Button`, `IconButton`, `Icon`, `Logotype`
- **`components/forms`** — `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`
- **`components/display`** — `Card`, `Badge`, `Tag`, `Stat`, `WallLabel`, `ImageFrame`
- **`components/navigation`** — `NavBar`, `SideNav`, `Tabs`, `Breadcrumb`, `Pagination`
- **`components/feedback`** — `Dialog`, `Toast`, `Tooltip`, `Banner`, `ProgressBar`
- **`components/platform`** — `WindowChrome`, `PhoneFrame`, `StatusBar`, `AppBar`, `TabBar`
- **`components/game`** — `HudMeter`, `ObjectivePanel`, `GameMenu`

### Intentional additions

No source defined a component inventory, so the standard set was authored, plus these additions with a reason each:

- `Icon` — a wrapper so the Font Awesome kit is used one way everywhere.
- `Logotype` — the brand signature has to exist somewhere, and it must be live type rather than an image, since no logo file was supplied.
- `WallLabel` — the object tombstone is the one piece of content every museum surface shares (web, in-gallery, app, print, game codex); leaving it to ad-hoc markup guarantees drift.
- `ImageFrame` — ratio locking plus an honest placeholder, so screens can be built before photography exists.
- `WindowChrome`, `PhoneFrame`, `StatusBar`, `AppBar`, `TabBar` — required by the brief's desktop (mac/Windows/Linux, all window types) and mobile (iOS/Android) targets.
- `HudMeter`, `ObjectivePanel`, `GameMenu` — required by the brief's game-UI target.

## Colour schemes

`tokens/themes.css` defines 13 schemes: **gallery** (default), **spectrum**, **midnight**, **voltage**, **archive**, **terracotta**, **depot**, **verdigris**, **nocturne**, **playbill**, **lagoon**, **bauhaus**, **sage**. Twelve of them are the Coolors palettes from the brief; `gallery` is Museo's own ink-and-vermilion default.

Apply one by setting `data-theme` on any element — `<html>`, `<body>` or a single subtree:

```html
<body data-theme="midnight">          <!-- whole product -->
<section data-theme="bauhaus">…</section>  <!-- one block -->
```

Each scheme rewrites only the 15-value theme channel (`--t-paper`, `--t-ink`, `--t-accent`, …). The semantic aliases are declared twice — on `:root` and on `[data-theme]` — so a scheme applied to a subtree recomputes the aliases from that element's own channel. Every component follows automatically. Dark schemes (`midnight`, `nocturne`) invert paper and ink in the same channel, so no component needs a dark-mode branch.

Preview surfaces (documentation only — the UI kits ship in the default scheme):

- `guidelines/scheme-<id>.html` — **one card per scheme**, showing the source palette with hex values above a full component composition (buttons, badges, tags, card, banner, inverse panel, progress, accent trio).
- `guidelines/theme-switcher.html` — live switcher across all 13 over a single composition.
- `guidelines/colors-themes.html` — all 13 as compact strips for side-by-side comparison.

## Caveats

- **Fonts are Google Fonts substitutions.** No font binaries were supplied, so Museo uses Syne (display), Public Sans (text) and Martian Mono (labels), loaded from Google Fonts in `tokens/fonts.css`. If Museo has licensed faces, send the files and the swap is a one-file change.
- **No logo exists.** Nothing in the brief contained a mark, so none was drawn. `Logotype` renders the name in type; `assets/` holds no brand files.
- **No imagery.** The brief mentioned attached image references, but no image files reached the project. Every image is an `ImageFrame` placeholder awaiting real photography.

# Graffiti — Design System

A street-art design language for any surface: web pages, desktop apps, mobile apps, game UI and print. It is built from one idea — **paint on a wall, paper slapped over paint** — expressed as opaque black keylines, hard offset shadows, poster-scale condensed type, real graffiti display faces, and a colour system that can be swapped wholesale between twelve crew palettes.

Graffiti is not a recreation of any existing product. It was authored from a supplied library of street-art fonts, textures and cut-out graphics plus a set of visual reference images, and it is deliberately generic: no reference brand, wordmark, slogan or artwork is reproduced anywhere in it.

---

## 1. Sources

| Source | What it was | How it was used |
| --- | --- | --- |
| `Graffiti Assets/` (local folder, mounted read-only) | Commercial street-art asset packs: 10 display fonts (OTF/TTF), 60 drip wall-art JPGs, seamless comic/street/brick pattern tiles, 20 graffiti backgrounds, cut-out clipart PNGs, digi-stamp overlays, bookmark sets, stencil frames, punk doodles, an urban t-shirt SVG/PNG bundle | Fonts and a curated selection of textures, backgrounds and cut-out graphics were copied into `assets/`. Everything else was left in place. |
| ~29 reference images supplied in chat | Graffiti posters, street-art paintings, seamless letter patterns, four real graffiti-adjacent website screenshots, four game-UI screens, two zine/infographic layouts | Read as visual direction only. **None are included in this project** and none of their branding, wordmarks or copy appears anywhere. |

**Reference-image caveat:** the uploads did not reach the filesystem on the first pass (`uploads/` was empty when the run started) and were later supplied as inline images. They were legible enough to direct the system but were never available as files, so nothing was traced or sampled from them.

### What the sources did *not* contain

- **No logo or brand mark.** None was supplied, so none was created. Wherever a mark would go, the name is set in type (`--gf-font-marker` for the primary lockup, `--gf-font-tag` for signatures). See `guidelines/brand-wordmark.html`.
- **No component library, Figma file or codebase.** The asset folder is graphics and fonts only. The component inventory below was therefore authored from scratch against the five required application domains, rather than transcribed from a source.
- **No product copy.** Sample copy throughout the kits is invented placeholder for a fictional wall-logging product ("Wallworks"), written to the tone rules in section 3.

### Fonts — all real, no substitutions

All ten display faces ship as the original binaries from the supplied pack (`assets/fonts/`). The three text faces are Google Fonts, chosen to match the reference posters:

| Role | Face | Source |
| --- | --- | --- |
| Poster headline | Anton | Google Fonts |
| Heavy UI display | Archivo Black | Google Fonts |
| Body / interface | Archivo | Google Fonts |
| Mono / technical | Space Mono | Google Fonts |

If you have licensed alternatives for the text faces (a Druk-class condensed, a wide grotesque), send them and they will drop straight into `tokens/fonts.css`.

---

## 2. Products represented

Five surfaces, each with its own UI kit under `ui_kits/`:

1. **Web** — a marketing/editorial site for a fictional wall-logging platform. Full-bleed poster hero, tape marquees, pasted-up card grids, editorial article layout.
2. **Desktop** — a wall-cataloguing studio app, shown in macOS, Windows and Linux/GNOME chrome, with app / dialog / utility / inspector window kinds.
3. **Mobile** — the same product as an iOS app and an Android app, side by side, with platform-correct status bars, app bars, tab bars and FABs.
4. **Game** — a spray-tagging game: main menu, in-run HUD, ability bar, dialogue/briefing, results screen. Same tokens, sheared.
5. **Print** — poster, flyer, zine spread and ticket, laid out on paper ground at print proportions.

---

## 3. Content fundamentals

**Voice: second person, imperative, present tense.** The system talks to the person holding the can. "Log a spot", "Pick your wall", "Bring caps." Never "Users can log spots."

**Casing carries the hierarchy.**
- Display and headline type: UPPERCASE, always.
- Buttons, tabs, nav items, section labels: UPPERCASE.
- Kickers, specs, credits, status: UPPERCASE mono with `--gf-track-caps`.
- Body copy and descriptions: normal sentence case. Never shout a paragraph.

**Length.** Headlines 2–5 words. Buttons 1–3 words. Kickers under 6 words. Body paragraphs under 3 sentences before a break.

**No exclamation marks, no marketing throat-clearing, no metadiscourse.** State the thing.

> Do: `Every wall is a page` · `Log a spot` · `Permit expires Friday` · `48 m² · East Yard · bay 3`
>
> Don't: `Discover the power of wall documentation!` · `Here's why walls matter` · `Get started today 🚀`

**Numbers are facts, set in mono with tabular figures.** `1,284 walls` · `48 m²` · `03:12` · `Edition 02 of 250`. Never round a real figure to make it prettier.

**Technical furniture is part of the voice.** Edition numbers, dates in `2026.04.02` form, dimensions, barcodes, `© 2026`, crew initials in four caps (`NRTH`, `SLAB`). Borrowed from record sleeves and permit paperwork; it grounds the loud type.

**Emoji: never.** Not in copy, not in UI, not in place of an icon. Font Awesome covers every pictogram need.

**Vibe.** Confident, unsentimental, slightly institutional-deadpan against very loud graphics — the contrast between a permit form and the piece it authorises is the joke the system runs on. It is celebratory of the craft, never edgy-for-its-own-sake, and never romanticises property damage: the sample content is about sanctioned walls, permits and crews.

---

## 4. Visual foundations

### Colour

Two grounds and one keyline, plus a swappable chroma layer.

- **Ink** (`--gf-ink` `#0A0A0A`) is the keyline and never a soft grey. Every bordered element uses it, on both grounds.
- **Wall** (`--gf-wall-0…4`) is warm-black concrete, not blue-black. It is the default surface.
- **Paper** (`--gf-paper-0…4`) is off-white newsprint. Never `#fff` except as a top-of-stack highlight.
- **Chalk** (`--gf-chalk-1…3`) is type on wall.
- **Crew colours** (`--gf-c1…c5`) are the theme's raw palette. Components never reference them directly; they reference **roles**: `--gf-accent`, `--gf-accent-2`, `--gf-accent-deep`, `--gf-on-accent`.
- **Semantics are fixed** (`--gf-danger`, `--gf-warn`, `--gf-go`, `--gf-info`) and do not move with the theme, so a warning always reads as a warning.

**Twelve colour schemes** live in `tokens/themes.css`, applied by attribute: `<body data-gf-theme="riot">`. Riot is the default. The others: Spectrum, Midnight, Alarm, Peach, Slate, Mint, Neon, Bubble, Lagoon, Cobalt, Sage. Each supplies five crew colours, the three accent roles, an `--gf-on-accent` that meets contrast on that accent, and its own wall and paper grounds. Preview all twelve in `guidelines/colors-themes.html`; the web and game kits carry a live theme switcher.

**Surface mode** is separate from theme: `data-gf-surface="paper"` flips the entire semantic layer to ink-on-newsprint without touching the palette. Print uses it; light web sections use it.

**Imagery colour vibe.** Saturated and warm-leaning, high-contrast, halftone or spray grain over everything. Photography is never left flat — it gets a scrim and a grain pass. Duotone is acceptable (accent + ink). Never desaturate to grey-blue "corporate photography"; never apply a soft pastel wash.

### Type

Nine display faces from the wall (`--gf-font-wall`, `-marker`, `-tag`, `-throwie`, `-wildstyle`, `-broken`, `-sound`, `-sonic`, `-impact`), plus `--gf-font-poster` (Anton), `--gf-font-heavy` (Archivo Black), `--gf-font-ui` (Archivo) and `--gf-font-mono` (Space Mono).

Rules that matter:
- **One display face per composition.** Two if the second is `--gf-font-tag` acting as a signature.
- **`--gf-font-wildstyle` never sets a sentence.** One word, headline scale, or not at all.
- **Headlines stack at `--gf-leading-solid` (0.82)** so the letters read as mass. Body copy never does.
- **Anton for headlines, Archivo Black for anything under 24px that must still shout.** Archivo Black is the button and label face; Anton is too condensed at small sizes.
- Scale runs 10 → 148px in 13 steps and climbs fast at the top: posters are the primary artefact.
- 24px is the floor for slide/poster text, 12pt for print, 13px for UI body.

**Headline treatments** (`guidelines/type-headline-treatments.html`): accent fill with a 3px ink `-webkit-text-stroke`; chalk fill with a 5px hard `text-shadow` in the accent; knockout band (`box-decoration-break: clone`); and the strike-through correction, a rotated danger-coloured bar across a word.

### Spacing and layout

4px-based, 14 steps, 2 → 120px. Controls are 32 / 44 / 56 (44 is the touch minimum, enforced). Gutter 24, wide gutter 48, body measure 66ch, page max 1280.

Layout is **grid with `gap`**, and then things are deliberately pushed off it: stickers overhang their container by 10–20px with negative margins, tape overhangs a panel edge, a headline breaks the column. The grid is the substrate; the paint ignores it. Fixed elements are limited to the sticky navbar, the mobile tab bar, and the game HUD corners.

### Backgrounds

Four registers, and a composition picks one:
1. **Flat wall** — `--gf-bg`, most UI.
2. **Full-bleed photograph** — a wall or drip texture from `assets/backgrounds/`, always under a scrim.
3. **Seamless pattern tile** — `assets/patterns/`, at 180–240px repeat, used behind hero bands and game menus, usually knocked back to 15–35% or overlaid with an ink scrim.
4. **Halftone field** — `--gf-halftone` / `--gf-halftone-loose`, a gradient-built dot screen that inherits `currentColor`, so it tints with the theme.

No aggressive multi-stop gradients. Linear scrims only, and only for legibility protection. Never a purple-to-blue hero gradient.

### Borders, radii, shadows

- **Keylines:** 1 / 2 / 3 / 5 / 8px. 3px (`--gf-stroke-2`) is the default; 1px hairline is print rules only. Always `--gf-ink`, always opaque.
- **Radii:** 0 by default — a sticker cut. `--gf-radius-bubble` (18px) and `--gf-radius-blob` (irregular) are for throw-up shapes. `--gf-radius-pill` for pill buttons, radios, avatars-in-rosters and badges. Cards are square. Always.
- **Outer shadows are hard offsets with no blur:** `press` 2px, `sticker` 4px, `tag` 7px, `slab` 12px, all solid ink. This is the single most identifying move in the system. Soft blurred shadows exist only as `--gf-shadow-lift` and `--gf-shadow-paper`, for floating sheets and print mockups on a desk.
- **Inner shadow** (`--gf-shadow-inset`) means recessed: input fields at rest, progress channels, HUD meters.
- **Protection is a gradient scrim, not a capsule.** Type over photography gets a full-width linear scrim (`--gf-scrim-ink-*`) plus grain. Capsules and pills are for labels and controls, never for protecting text.
- **Focus is a double ring** (`--gf-focus` / `--gf-focus-wall`): a 3px ground-coloured gap then a 3px accent ring, so it reads on wall and paper alike. Browser default outlines are always replaced.

### Transparency and blur

Used sparingly and only where a real overlay exists: the `Dialog` scrim (`--gf-scrim-ink-70` + `--gf-blur-sm`), iOS action sheets, a sticky nav crossing photography, and game pause overlays. **Solid panels are never translucent** — a card is opaque paint. Alpha is never used to mute type; muted text uses `--gf-chalk-3` / `--gf-text-muted`, which are real, contrast-checked values.

### Animation

Snap in, don't drift. `--gf-dur-fast` 130ms for state changes, `--gf-dur-base` 210ms for entrances, `--gf-dur-slow` 380ms for bars filling. Nothing slower than 380ms. `--gf-ease-snap` is the default; `--gf-ease-bounce` is reserved for stickers landing and game feedback. Marquees are the one continuous animation, linear and slow. No parallax, no scroll-jacking, no fade-up-on-scroll cascades.

### Hover / press / disabled

- **Hover:** the element *lifts* — `translate(-1px,-1px)` and the shadow deepens one step (`sticker` → `slab`). Colour does not change. Flat variants (ghost, outline) change colour instead, from `--gf-text-body` to `--gf-accent`.
- **Press:** the element *sinks* — `translate(2px,2px)` and the shadow shrinks to `press`. It looks pushed into the wall.
- **Disabled:** `opacity: .4`, `cursor: not-allowed`, shadow retained. Never a grey repaint.
- **Selected/active:** an accent fill with an ink keyline, not an underline or a tint.

### Cards

Opaque fill (`--gf-surface-card`), 3px ink keyline, 4px hard offset shadow, **zero radius**, no gradient, no coloured left border. Media sits above the body with a keyline between. On hover (`hoverable`) they lift into a 12px shadow. In a grid of three or more, tilt **at most half** of them by `--gf-tilt-a/b/c` (all under 4°) so it reads as pasted-up rather than broken.

---

## 5. Iconography

**Font Awesome, kit `559791bdc6`.** The supplied asset library contained no icon font, sprite sheet or UI icon set — only illustrative artwork — so Font Awesome is the sanctioned icon system and this substitution is deliberate, not a fallback.

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Rules:
- **`fa-solid` is the default style.** `fa-regular` only where an outline/filled pair carries meaning (saved vs unsaved, square vs checked).
- Always render through the `Icon` component (`<Icon name="fa-solid fa-spray-can" />`), which normalises sizing to `1em` and colour to `currentColor`. Bare names (`"spray-can"`) are accepted and prefixed with `fa-solid`.
- Icons inherit their parent's colour. Set colour on the parent, not the glyph.
- **Never hand-draw an SVG icon**, never use emoji as an icon, never use a Unicode dingbat as an icon. The one exception is the `✳` separator inside `Marquee`, which is typography, not an icon.
- Icons inside a sheared game element are counter-sheared so the glyph stays upright — see `HudBar`.

Recurring glyph vocabulary: `spray-can`, `spray-can-sparkles`, `paint-roller`, `brush`, `palette`, `crown`, `bolt`, `star`, `location-dot`, `layer-group`, `users`, `bookmark`, `stamp`, `fire`.

**Illustrative artwork** is a separate matter and ships as real files, not SVG code: cut-out street-art PNGs in `assets/graphics/`, full-bleed wall photography in `assets/backgrounds/`, seamless tiles in `assets/patterns/`. Use them; do not draw replacements.

---

## 6. Index

### Root

| Path | What it is |
| --- | --- |
| `styles.css` | Global entry point. `@import` list only — link this one file. |
| `readme.md` | This document. |
| `thumbnail.html` | Homepage tile. |

### Tokens (`tokens/`, `base/`)

`fonts.css` (all `@font-face` + Google import) · `colors.css` (ink, wall, paper, chalk, fixed semantics, scrims) · `themes.css` (the 12 colour schemes) · `typography.css` (families, scale, leading, tracking) · `spacing.css` (space scale, control sizes, layout maxima) · `effects.css` (keylines, radii, shadows, textures, tilt/shear, blur, motion) · `semantic.css` (the aliases components actually use, plus the `paper` surface mode) · `base/elements.css` (element defaults, link colours, `.gf-kicker`, `.gf-grain`).

### Components (`components/`) — 44 in 9 groups

**core** — `Icon`, `Button`, `IconButton`, `Tag`, `Badge`, `Sticker`, `Marquee`
**forms** — `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`
**surfaces** — `Card`, `Panel`, `Poster`, `Dialog`, `Tape`
**navigation** — `Navbar`, `Tabs`, `Sidebar`, `Pagination`, `Breadcrumb`
**feedback** — `Alert`, `Toast`, `ProgressBar`, `Spinner`, `Tooltip`, `EmptyState`
**data** — `Table`, `Stat`, `Avatar`
**chrome** — `WindowChrome`, `Toolbar`, `StatusBar`
**mobile** — `PhoneFrame`, `AppBar`, `TabBar`, `Fab`
**game** — `HudBar`, `GameButton`, `ResourceChip`, `DialogueBox`

Each has a `.d.ts` props contract and a `.prompt.md` with a usage example. Each directory has one `@dsCard` preview HTML showing its states.

**Intentional additions.** No source defined a component inventory, so the set above was authored to cover the five required domains. Three entries exist for reasons worth stating: `Icon` wraps the Font Awesome glyph set so icon usage stays consistent; `Tape` and `Sticker` are not conventional primitives but are the two decorative moves the visual language depends on, and codifying them stops them being re-improvised per screen.

### Guidelines (`guidelines/`) — 33 specimen cards

Colours (9): ink · wall · paper · chalk · crew colours · accent roles · fixed semantics · scrims · **all 12 theme variants, switchable**
Type (9): display faces · secondary display faces · poster · heavy · body · mono · scale · leading + tracking · headline treatments
Spacing (3): scale · control heights · spacing in use
Effects (7): hard shadows · keyline weights · radii · textures · tilt + shear · motion · interaction states
Brand (5): wordmark · graphic assets · backgrounds + patterns · iconography · wall vs paper

### UI kits (`ui_kits/`)

`web/` · `desktop/` · `mobile/` · `game/` · `print/` — each with its own `README.md`, an interactive `index.html`, and per-screen JSX.

### Assets (`assets/`)

`fonts/` (10 display faces, OTF/TTF) · `backgrounds/` (6 full-bleed wall + drip photographs) · `patterns/` (6 seamless tiles: comic letters, street art, brick) · `graphics/` (19 cut-out PNGs and JPGs: street-art clipart, stamps, tags, bookmarks, stencil frames, punk doodles)

---

## 7. Using it

```html
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
<body data-gf-theme="riot">          <!-- one of 12 -->
<body data-gf-theme="mint" data-gf-surface="paper">   <!-- theme + light ground -->
```

Build with semantic tokens (`--gf-accent`, `--gf-surface-card`, `--gf-text-body`), not raw palette values (`--gf-c3`). That is what makes all twelve schemes work without touching a component.

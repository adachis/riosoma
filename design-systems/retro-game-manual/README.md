# NES Design System

An instruction-booklet design system. It takes its voice from mid-1980s console **print** — game manuals, control decks, fold-out map inserts — rather than from the pixel art those manuals documented. Heavy oblique display type, two-colour spot printing on warm paper, 4px keylines with stepped corners, hard shadows with no blur. The bitmap type and scanline surfaces are held back for one place only: game UI.

There is no client, no real product and no supplied brand mark. The system is an original interpretation built for five surfaces at once — web, desktop, mobile, game UI and print — so a single set of tokens and primitives can carry all of them.

**Namespace:** `window.NESDesignSystem_9087ab`
**Global CSS entry:** `styles.css` (imports only)

---

## Sources given

| Source | What it is | How it was used |
| --- | --- | --- |
| `NES.css-2.3.0/` (attached codebase) | An open-source CSS kit that recreates 8-bit console UI. Read in full: `scss/base/variables.scss`, `scss/base/color-palette.scss`, `scss/elements/*`, `scss/form/*`, `scss/utilities/*`. | **Ground truth for numbers.** Every padding, border width, bevel offset and state colour below is lifted from it verbatim — `6px 8px` buttons, `0.5rem 1rem` fields, `1.5rem 2rem` panels, `inset -4px -4px` bevels deepening to `-6px -6px` on hover and inverting to `4px 4px` on press, `0 0 0 6px rgba(shadow,.3)` focus rings, the 4px border, the stepped corner geometry, and the 54-slot console hardware palette. Its own class names, mixins and pixel-art sprites were **not** copied. |
| ~40 scanned reference images (`uploads/`) | Instruction booklets, cover art, control-deck manuals, fold-out map inserts, cartridge photography, disk-system pages. | **Ground truth for the look.** Read for typographic voice, page grid, spot-colour behaviour, plate and callout conventions, folio treatment. No image is used in the system; nothing was traced or reproduced. |
| ~40 pixel TTF/OTF font files (`uploads/`) | Third-party bitmap faces. | Three were adopted and re-aliased under project-local family names — see **Typography**. |
| `Game Boy Instruction Manual Template v5.fig` (mounted) | A print artboard file: 11 cover variants, 10 interior pages, back covers and cartridge stickers at 1200x900. It defines **no components, no Figma Variables and no text styles** — `/METADATA.md` reports 0 component families and 0 text styles, so there was nothing to materialise. | **Ground truth for the print grammar.** Read `/METADATA.md`, `/Pages/Page-3`, `/Pages/Page-4` (+ its `TheStory` and `AButtonLoremIpsumDolor` text nodes) and `/Pages/Front-Cover-GB`. Everything in **Sheet geometry** below is transcribed from it verbatim, and the `booklet` theme was retuned to its palette. |
| ~20 illustration JPGs (`uploads/`) | Sample box art, character turnarounds and spot illustrations supplied as placeholders. | 15 copied into `assets/art/` and wired into every image plate across the five kits and the templates. |

Nothing here reproduces a logo, mark, character, title, screenshot or copy from any source. All sample content is invented (`Cavern Bell`, `Starfall`, `Double Circuit`, `Wardens`). Where a mark would go, the system sets the name in plain type.

---

## Index

**Root**
- `styles.css` — the only file consumers link. `@import` list, no rules of its own.
- `thumbnail.html` — homepage tile.
- `readme.md` — this file.

**Tokens** — `tokens/`
`fonts.css` (Google import + five local `@font-face`) · `typography.css` · `spacing.css` · `borders.css` · `motion.css` · `colors.css` (hardware palette, derived states, semantic aliases) · `themes.css` (13 colour schemes + dark mode)

**Base** — `base/`
`reset.css` · `utilities.css` (surfaces, patterns, rules, CRT) · `print.css`

**Assets** — `assets/fonts/` (5 local pixel faces) · `assets/art/` (15 placeholder illustrations: `cover-*.jpg` box art, `hero-turnaround.jpg`, `enemy-bombs.jpg`, `spot-*.jpg`). No logo files: none were supplied.

### Sheet geometry — transcribed from the reference file

| Value | Token | Source |
| --- | --- | --- |
| Page | `--ds-sheet-w` 1200px x `--ds-sheet-h` 900px, landscape, white | every page frame |
| Margin | `--ds-sheet-margin` 60px (1080px content measure) | Page 3, Page 4 |
| Section head | y=60, heavy oblique **uppercase**, 34px / 42px, black | `TheStory`, `Controls` text nodes |
| Head rule | y=125, **0.5px** hairline, 1080px wide | "Header underline" |
| Body starts | y=185 | Page 3, Page 4 |
| Body copy | 30px / 42px, **roman** (not italic) | `AButtonLoremIpsumDolor` |
| Caption | 26px / 34px | Page 3 |
| Image plate | 510x459 at x=630 — flat #CCCBCB, **no keyline** | Page 3 "Placeholder" |
| Spec column | 700px wide, hairline dividers | Page 4 |
| Hardware plate | 319x529 at x=60, y=185 | Page 4 illustration |
| Cover | 250px light sidebar (#CCCBCB) + 950px dark field (#4D4D4D), rotated vertical logotype, cover line 50px / 60px italic centred at y=800, 131x176 cartridge plate at x=1039 y=30 | Front Cover (GB) |

The interior pages carry **no notched corners, no 4px keylines, no tint boxes and no pattern fills**. That decoration belongs to the screen surfaces; print is white stock, hairlines and one spot colour. The first build had it backwards.

**Components** — `components/`

| Directory | Exports |
| --- | --- |
| `core/` | `Frame` (+ `pixelNotch`), `Button`, `IconButton`, `Icon`, `Container`, `Badge`, `Tag`, `Divider` |
| `forms/` | `Field`, `Input` (+ `fieldSurface`), `Textarea`, `Select`, `Checkbox`, `Radio` (+ `RadioGroup`), `Switch` |
| `feedback/` | `Dialog`, `Balloon`, `Progress`, `Alert`, `Toast` |
| `data/` | `Table`, `List`, `FigurePlate`, `Avatar` |
| `navigation/` | `NavBar` (+ `Tabs`, `Breadcrumb`), `Menu` (+ `Pagination`) |
| `chrome/` | `MacWindow`, `WinWindow`, `LinuxWindow`, `WindowSheet` (+ `MenuBar`) |
| `mobile/` | `PhoneFrame`, `MobileNavBar` (+ `TabBar`, `ListRow`, `BottomSheet`) |
| `game/` | `GameScreen` (+ `HUD`, `MeterBar`), `DialogueBox` (+ `MenuCursorList`, `ItemGrid`), `TitleCard` |
| `print/` | `Sheet` (+ `Plate`, `SpecList`), `ManualHeading` (+ `TitleType`, `BannerHeading`), `Callout` (+ `Folio`, `ManualColumns`), `KeyDiagram` (+ `StepBlock`) |
| `theme/` | `ThemeSwitcher` (+ `NES_THEMES`) |

**UI kits** — `ui_kits/`
`web/` (home, catalogue, manual entry, sign-in) · `desktop/` (macOS, Windows, GTK) · `mobile/` (iOS + Android) · `game/` (title, file select, in-play, sub screen) · `print/` (cover, spread, fold-out insert). Each has its own `README.md` and an `index.html` that runs the click-through.

**Templates** — `templates/`
Starting folders a consuming project can copy. Each is a Design Component that loads this system through a sibling `ds-base.js`: `web-landing/WebLanding.dc.html` · `desktop-app/DesktopApp.dc.html` · `mobile-app/MobileApp.dc.html` · `game-ui/GameUi.dc.html` · `manual-page/ManualPage.dc.html`.

**Guidelines** — `guidelines/` — 22 specimen cards feeding the Design System tab (Type, Colors, Spacing, Brand).

---

## Content fundamentals

Copy is written the way a printed instruction booklet is written: plain, declarative, patient, slightly formal, and completely free of marketing lift. It assumes the reader is holding the thing and wants to know what the buttons do.

**Voice and person.** Second person for instructions; no first-person plural anywhere in product UI. *"Press SELECT to open the sub screen."* Not *"We'll take you to your items."* Editorial copy on the web surface may use "we" sparingly for the publisher's voice — *"Where a page was missing, we say so rather than filling the gap"* — never inside a control or a form.

**Mood.** Instructional, occasionally wry, never jokey. The manuals' charm came from earnestness under constraint, not from winking. Sample: *"Slide the cartridge in until it stops. Do not force it."*

**Casing.**
- UI labels, buttons, tabs, badges, small headings: **UPPERCASE** display type at `0.14em` tracking. *SIGN IN · CAUTION · SECTION 3.1*
- Headlines and page titles: **Sentence case**, set in heavy oblique. *"Using the controller"*
- Body copy: sentence case, full stops on complete sentences including single-line hints.
- In-game text: **UPPERCASE** bitmap type, always. *IT IS DANGEROUS TO GO ALONE.*

**Sentence shape.** Short declaratives. One idea per sentence. Instructions lead with the verb. Hints are one sentence and start with a concrete fact, not a hedge. Numbers are written as digits (`x3`, `042100`, `8 characters`), ordinals are zero-padded in lists (`01`, `02`).

**Editorial furniture.** Every long page carries a folio: page number, an italic one-line hint, and a section marker. The hint line is the system's signature — it is the manual's marginal aside promoted to a component (`Folio`). Write it as a genuinely useful fact, e.g. *"Here's a useful little hint. You can change over to the sub screen even during a fight."*

**Callout titles** are fixed and short: `Useful hint` · `Caution` · `Warning` · `Note` · `Before you start` · `Which way to go?`

**Errors** name what is wrong, then what to do. *"Not recognised. Check the address and try again."* No apologies, no exclamation marks.

**Emoji: never.** Not in UI, not in copy, not in headings. Icons come from Font Awesome; symbols in game UI come from the bitmap fonts.

**Things to avoid:** "seamlessly", "effortlessly", "powerful", "revolutionary", em-dash asides stacked three deep, questions as headings (except the fixed callout title above), and any sentence that describes the product's own significance.

---

## Visual foundations

### Colour
Two-colour spot printing is the governing idea. Each scheme fields **one cool primary and one warm accent** over warm paper, with three semantics behind them. `tokens/themes.css` declares 16 base slots per scheme; every state colour (`-hover`, `-shadow`, tints, `--ds-muted`, `--ds-line-soft`) derives from them with `color-mix(in oklab, …)`, so adding a scheme is 16 declarations and nothing else.

- **Surfaces:** `--ds-paper` (page, warm off-white), `--ds-paper-2` (panel, near white), `--ds-paper-3` (sunk/zebra), `--ds-plate` (near-black screen ground), `--ds-deep` (title bars, insert grounds).
- **Ink:** `--ds-ink` for everything readable, `--ds-ink-2` for captions and meta, `--ds-muted` for disabled. Body ink is always full opacity — never alpha-faded type.
- **Spot:** `--ds-primary` cool (headings, links, primary controls), `--ds-accent` warm (chapter heads, active nav, danger-adjacent emphasis).
- **Semantic:** `--ds-success` / `--ds-warning` / `--ds-danger`, each with `-hover` (84% toward black) and `-shadow` (56% toward black) for the bevel.
- **Tints:** 12–22% mixes into `--ds-paper-2` for callout and alert grounds only. Never as a fill behind type smaller than 13px.
- **Hardware palette:** `--ds-hw-*`, 28 named slots from the console's fixed palette. Use for game screens and sprite work. Never for print or web chrome.

14 schemes ship: `booklet` (default, retuned to the reference file: white stock #FFFFFF, black ink, #4D4D4D grey, #CCCBCB plate grey, **#E40520** red accent, **#433B8E** indigo primary, #6EB122 green, #DAAC06 gold), `newsprint` (the warm cream stock the first build shipped as default, kept for the older console-manual look), `spectrum`, `midnight`, `neon`, `issue`, `sunbleached`, `fieldguide`, `aqua`, `circuit`, `bubblegum`, `signal`, `letterpress`, `sage`. Set with `data-theme` on any element. Where a supplied palette had no green or no red, that semantic slot is derived in the palette's own hue family and is marked as such in `themes.css`. `midnight` additionally has its `--ds-accent` derived (`#f2731c`, a warm orange stepped off its gold): the source palette holds only two warm values, and those are taken by primary and warning, so an undestructive accent had to be built rather than borrowed.

In six schemes — `booklet`, `issue`, `signal`, `circuit`, `letterpress` and `spectrum`-adjacent variants — `--ds-accent` and `--ds-danger` resolve to the same hex. That is deliberate, not an oversight: two-colour spot printing gives a page one warm plate, and on a booklet page the colour that shouts is the same colour that warns.

**Dark mode** is one rule, not thirteen: `[data-mode="dark"]` promotes each scheme's own `--ds-plate` into the page role and inverts ink. Keylines stay 4px and stay full-contrast.

### Typography
Four families, four jobs.

| Role | Family | Token |
| --- | --- | --- |
| Display | **Archivo** 900, `font-stretch: 100%`, **italic**, uppercase | `--ds-font-display` |
| Title | **Archivo** 900, `font-stretch: 78%`, **italic**, uppercase, 60-180px | `.ds-display-cond` / `TitleType` |
| Text | **Archivo** 400/600, roman and italic | `--ds-font-text` |
| Mono | **IBM Plex Mono** | `--ds-font-mono` |
| Bitmap | **Press Start 2P** (web) + three local faces | `--ds-font-pixel`, `--ds-font-pixel-ui`, `--ds-font-pixel-wide`, `--ds-font-pixel-narrow` |

- **Display is always oblique.** The reference file sets every heading in a heavy grotesque italic; that slant is the single most recognisable thing about the type. Do not set a headline upright.
- **Two widths, two jobs.** Section heads run at normal width (the file's Black Italic, 34px). Cover and chapter titles run **condensed** (the file's Condensed Black Italic, 60-180px). The first build had display type *expanded*, which was the largest single miss against the reference.
- **Oblique body copy carries narrative** (story pages, hero paragraphs, captions, folio hints). **Roman body copy carries reference** (control charts, tables, form help). This split is deliberate and is what makes long pages read like a booklet.
- Body columns are justified with hyphenation (`.ds-justify`) at a 44–66ch measure. Never justify anything narrower than 40ch.
- Scale: twelve steps, `--ds-text-3xs` 10 → `--ds-text-5xl` 84. Minimums: 12px print, 13px UI body, 10px bitmap.
- Bitmap type is for game UI, wordmarks and counters. It never sets a sentence of prose outside a game screen.

### Space and grid
Eleven-step scale doubling from 2px; everything from step 2 up lands on the 4px pixel grid. Component paddings are the kit's, verbatim — see `guidelines/spacing-paddings.html`. Print pages use a 48px margin, 28px column gutter, and a two-column grid with a narrow outer column reserved for asides. Fixed pixel widths belong only to print sheets, device frames and game screens; every other surface reflows.

### Borders, corners, shadows
- **One weight does the work: 4px.** 2px for internal table rules, field indicators and secondary keylines. 1px never appears.
- **Corners are notched, never rounded.** `--ds-radius` is `0` and stays `0`. The stepped corner is produced by a `clip-path` polygon that cuts a `--ds-notch` square out of each corner of a bordered box (`.ds-frame`, `pixelNotch(n)`), so it re-colours with the theme — unlike the source kit's baked-in `border-image` SVG. 4px notch is standard, 2px on fields and small badges, 8px for emphasis, square for window chrome and full-bleed bars.
- **Shadows have no blur, ever.** Two behaviours only: a hard offset (`--ds-shadow-hard` 4px, `-lg` 8px) for a raised sheet, and an inset bevel (`inset -4px -4px`) for a pressable surface. No ambient shadows, no layered elevation ramps, no `filter: blur`.
- **Transparency and blur:** modal scrims are flat `rgba(0,0,0,.30–.35)`. `backdrop-filter` is not used anywhere. Translucent panels are not used anywhere. Where something needs to sit over imagery, it gets a solid plate, not a gradient scrim.

### Backgrounds and imagery
No photographic or illustrative assets were supplied, so the system leans on **flat colour plus structural pattern**: `.ds-paper-grain` (3px dot screen at 7% ink) for paper, `.ds-halftone` (5px spot-colour dot screen) for tinted panels, `.ds-dither` (8px 45° checker) for retro fills, `.ds-checker` (16px conic) for placeholder screen contents, `.ds-scanlines` / `.ds-crt` for game viewports. Gradients are not part of the system — the one exception is the 45° hatch inside a patterned progress fill, lifted from the kit.

Real imagery, when supplied, always goes inside a plate: dark ground, 4px keyline, `image-rendering: pixelated`, corner label, italic caption below (`FigurePlate`). Screenshot plates keep their native aspect. Colour vibe of imagery should be **warm and saturated with visible print dot** — booklet stock, not modern photography. Nothing is desaturated, nothing is duotoned blue-purple.

### Motion
Stepped, never smooth. `--ds-ease-step` is `steps(4,end)`; `--ds-ease-step-2` is `steps(2,end)`. Durations are `80 / 140 / 280ms`, plus a `900ms` blink. Three canonical animations: **blink** (advance markers, `PRESS START`), **bob** (attention on a small object), **cursor** (menu selection arrow). Nothing fades in. Nothing scales on entry. Nothing bounces with a spring. `prefers-reduced-motion` disables all three.

### Interaction states
Taken from the kit and applied everywhere:
- **Hover** — the fill steps one stop darker (`-hover`, 84% toward black) *and* the inset bevel deepens from `-4px` to `-6px`. Hover never changes opacity.
- **Press** — the bevel inverts to `inset 4px 4px`, which reads as the surface pushing in. Nothing translates or scales.
- **Focus** — `0 0 0 6px` of the shadow colour at 30% alpha. Outline is suppressed in favour of the ring; the ring is always visible, never removed.
- **Selected** — a moving marker, not a heavy fill: a caret glyph in `Menu` and `MenuCursorList`, a 4px accent edge on tabs and tab bars, an accent keyline on the selected inventory cell.
- **Disabled** — `--ds-disabled` fill, `--ds-disabled-shadow` bevel, `opacity: .6`, `cursor: not-allowed`. Exactly the kit's values.

### Cards and panels
A card is a `--ds-paper-2` box with a 4px ink keyline, notched corners, no radius and no ambient shadow. It gains a hard 4px offset shadow only when it genuinely floats (dialogs, window frames, print sheets). `Container` adds the kit's signature: a title tab that breaks the top keyline, set in uppercase display type. Panels never nest more than two deep.

### Fixed elements and layout rules
Top bars and mobile tab bars are full-bleed with a 4px keyline on the inner edge. Window chrome is square-cornered so it can sit flush at a screen edge. Nothing is sticky by default. Mobile hit targets are 44px minimum (`IconButton size="lg"`, `TabBar`, `ListRow`). Body text holds 4.5:1 against its ground in every scheme; headline-scale spot colour holds at least 3:1.

---

## Iconography

**Font Awesome is the icon system**, loaded from the project kit:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Every component that draws a glyph goes through the `Icon` wrapper (`<Icon name="floppy-disk" />`), which maps a `style` prop to the `fa-solid` / `fa-regular` / `fa-brands` prefixes.

- **One weight: solid.** Regular is allowed only where solid reads as a filled state's opposite (e.g. the maximise square in `WinWindow`). Light, thin and duotone are available through the kit but are not part of the system.
- **Sizes:** 10px inline, 13px in controls, 16–18px in callouts and section markers. Icons inherit `currentColor` unless deliberately set to a spot colour.
- **What the source kit provided instead:** NES.css ships its own icons as CSS `box-shadow` pixel-art sprites (`scss/icons/*.scss`) plus decorative character sprites (`scss/pixel-arts/*.scss`). Those are hand-built recreations of third-party marks and characters, so **none were copied**. Its two cursor PNGs (`assets/cursor.png`, `cursor-click.png`) were also left behind; the system uses the platform pointer.
- **No hand-drawn SVG.** Do not author icon paths in this system. If a needed glyph is missing from Font Awesome, use a bitmap-font character inside a game screen, or a plain typographic mark (`×`, `▶`, `/`) elsewhere.
- **Unicode as icons:** allowed in two places only — the `▶` cursor in `MenuCursorList` and `×` as a multiplier in counters (`x3`). Everything else is a glyph or a CSS shape.
- **Emoji: never**, in any surface.
- **CSS-shape "icons":** the stepped select indicator, the radio centre block, the dialogue advance triangle and the iOS notch are drawn as plain divs and `clip-path` polygons rather than glyphs, so they scale with the 4px grid and re-colour with the theme.

---

## Intentional additions

The attached kit defines a flat inventory — avatar, badges, balloons, buttons, containers, dialogs, lists, progress, tables, text, checkboxes, inputs, radios, selects, textarea, icons, cursors, pixel-art sprites. All of it is represented above except the pixel-art sprites and the recreated third-party icon marks, which were deliberately excluded (see **Iconography**).

Everything below is an addition, required because the brief asks the system to cover five surfaces the kit does not address:

| Addition | Why |
| --- | --- |
| `Frame`, `Divider`, `Tag`, `IconButton`, `Icon` | Primitives the kit expresses only as ad-hoc CSS; extracted so the notch, rule, chip, square control and glyph have one implementation each. |
| `Field`, `Switch`, `Toast`, `Alert` | Form scaffolding and inline/transient messaging with no kit counterpart, needed by every app surface. |
| `NavBar`, `Tabs`, `Breadcrumb`, `Menu`, `Pagination` | The kit has no navigation layer at all; web and desktop surfaces cannot exist without one. |
| `MacWindow`, `WinWindow`, `LinuxWindow`, `WindowSheet`, `MenuBar` | Explicitly requested: window chrome for all three desktop platforms. |
| `PhoneFrame`, `MobileNavBar`, `TabBar`, `ListRow`, `BottomSheet` | Explicitly requested: iOS and Android surfaces. |
| `Sheet`, `Plate`, `SpecList`, `TitleType` | The reference file's page shell, image box, control list and title voice, at its exact numbers. |
| `GameScreen`, `HUD`, `MeterBar`, `DialogueBox`, `MenuCursorList`, `ItemGrid`, `TitleCard` | Explicitly requested: game UI, expressed in the existing design language rather than in conventional game-UI idiom. |
| `ManualHeading`, `BannerHeading`, `Callout`, `Folio`, `ManualColumns`, `KeyDiagram`, `StepBlock`, `FigurePlate` | Explicitly requested: print design and layout. These carry the booklet grammar the reference scans supplied. |
| `ThemeSwitcher` | Explicitly requested: a way to preview all 13 schemes. **Demo only** — never ship it inside a product UI. |

---

## Substitutions to confirm

- **Display and text face.** No brand font was supplied. The reference scans use a heavy grotesque and its oblique — Helvetica Bold Oblique and a Futura-adjacent extra bold in the covers. **Archivo** (Google Fonts) is the substitute: it has a width axis, a true italic, and the right blunt terminals. If you own the real faces, replace `--ds-font-display` / `--ds-font-text` in `tokens/typography.css` and drop the `@import` in `tokens/fonts.css`.
- **Mono face.** No mono was supplied. **IBM Plex Mono** substituted for codes, paths and status bars.
- **Bitmap faces.** Adopted from the uploaded files and re-aliased so no third-party family name appears in the CSS: `NES Pixel` ← `pixelmix` (regular/bold), `NES Pixel Wide` ← `DePixelBreit`/`DePixelBreitFett`, `NES Pixel Narrow` ← `DePixelSchmal`. **Press Start 2P** is loaded from Google Fonts as the primary in-game face because it is what the source kit specifies. Check the licences on the three local faces before shipping; swap the files in `assets/fonts/` and the family names stay valid.
- **No logo.** None was supplied and none was invented. The name is set in `NES Pixel Wide` (or the display face on print covers) wherever a mark would go — see `guidelines/brand-wordmark.html`.
- **No imagery.** No photography or illustration was supplied. Every image position in the UI kits is a labelled plate with a pattern fill standing in. Supply real assets and they drop straight into `FigurePlate` / `KeyDiagram` children.

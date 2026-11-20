# Art Nouveau — Design System

A complete visual language drawn from turn-of-the-century decorative-arts printing, rebuilt as a working design system for five surfaces: **web, desktop applications, mobile applications, video-game UI, and print**.

It is a *style system*, not a company brand. There is no client, no product, no proprietary identity — the fictional publication *Atelier* appears in the UI kits purely as sample content so the components can be seen doing real work. Swap the copy and the system carries any subject.

## Sources

| Source | Path / link | What was taken |
| --- | --- | --- |
| Graphic asset & font library (attached local folder) | `Art Nouveau Assets/` — read-only mount, not committed here | 18 font binaries, ornament SVGs, seamless patterns, isolated floral PNGs, paper textures, figure imagery. Copied selectively into `assets/`. |
| Reference images (uploads) | `uploads/` (24 files) | Studied for colour, layout, type proportion, ornament placement and game-UI structure. **None are used in the system**, and no identifying mark, name, logo or line of copy from any reference appears anywhere. |
| Colour schemes | Twelve palettes supplied by the user as coolors.co links | Implemented verbatim as `data-theme` scopes in `tokens/themes.css`. |
| Iconography | Font Awesome Kit `559791bdc6` | The single icon source for every surface. |

No Figma file, no codebase and no slide deck were supplied, so there was no pre-existing component inventory to mirror. The component set below was authored from scratch and sized to the five named surfaces.

### There is no logo
The sources contain no logo or brand mark, so **none was created**. Wherever a mark would sit, the system renders the name in the display face (`--font-display`) as plain type — see `NavBar`'s `brand` prop, `thumbnail.html`, and the print mastheads. Do not draw one.

### Fonts — one gap
Every face in the system is a real supplied binary except the monospace role. The library contains no monospaced font, so `--font-mono` resolves to the **platform monospace stack** — no webfont is claimed and none is loaded. It is used only for token readouts in the guideline cards; stencil-style numerals inside controls have their own real face (`--font-stencil`). **If you have a monospaced face you want here, send the file and it will be wired in as a proper `@font-face`.**

---

## CONTENT FUNDAMENTALS

The voice is a printer's voice: plain, concrete, slightly dry, and never impressed with itself. It describes the object and the process, then stops.

**Person.** Third person for facts about the work, first-person plural for decisions the studio made, second person only in instructions and controls. Never "I".
> *"The first plate was pulled in the autumn."* — fact
> *"We stopped this run at two hundred and fifty."* — decision
> *"Type an address without an @ to see the error state."* — instruction

**Register.** Declarative sentences of ordinary length. No exclamation, no rhetorical questions, no "unlock", "seamless", "delight", "elevate", "supercharge". The most emphatic thing the system says is a flat statement of consequence: *"Editions close without notice."*

**Numbers.** Spelled out in prose (*two hundred and fifty*), set as figures in UI and data (*250*, *No. 251*, *1,284*). Dates and years are figures. Roman numerals for plate and chapter numbers (*Plate XII*, *Chapter One*).

**Casing.** Sentence case for headings, titles, body and buttons' underlying text. The label face then renders buttons, tabs, table heads, field labels and eyebrows in **uppercase with tracking** — that is a typographic transform, not a copy decision, so write the string in sentence case and let the CSS do it. Never write SHOUTING copy.

**Length.** Eyebrows 2–5 words. Headlines under nine words. Button labels one or two words (*Subscribe*, *Pull proof*, *Send to proof*). Card body one or two sentences. Helper text one clause: *"We write once a season."*

**Empty and error states** name the thing that is missing and nothing else: *"Nothing here by that name."*, *"That address is missing an @"*, *"No plates match that description."* No apologies, no emoji, no "Oops".

**Emoji: never.** Not in copy, not in labels, not as icons. Iconography is Font Awesome; ornament is drawn artwork. Unicode dingbats are not used as icons either — the only decorative characters in use are the middle dot (`·`) as a metadata separator, the em dash sparingly, and the `•` bullet the required-field label draws via CSS.

**Vibe.** A well-run workshop writing down what it actually does. Confident about craft, uninterested in hype.

---

## VISUAL FOUNDATIONS

### Type
Six working roles, each a real supplied face. Family names in CSS are role-based; the source binary is listed here.

| Token | Family | Source file | Used for |
| --- | --- | --- | --- |
| `--font-display` | AN Display | `VelvetCarousel-Regular.otf` | hero and poster headlines, stat figures, brand wordmark |
| `--font-poster` | AN Poster | `ArtNouveau.ttf` | condensed decorative capitals: eyebrows, kickers, poster lines |
| `--font-title` | AN Title | `Cajoles-{Light,Regular,Semibold,Bold}.ttf` | h1–h4, card and screen titles |
| `--font-text` | AN Text | `Bankslab-ArtNouveau.otf` | body copy, forms, tables, list rows |
| `--font-editorial` | AN Editorial | `Things-{Regular,Italic}.ttf` | long-form print columns, lead paragraphs |
| `--font-label` | AN Label | `Sauvage-{Regular,Bold}.ttf` | buttons, tabs, table heads, field labels, metadata |
| `--font-accent` | AN Accent | `Capires-{Regular,Italic}.ttf` | captions, credits, placeholders, pull quotes |
| `--font-ornate` | AN Ornate | `Melvca.ttf` | drop caps, game titles, cartouche plaques |
| `--font-vine` | AN Vine | `Mosswick.ttf` | signatures, marginalia |
| `--font-stencil` | AN Stencil | `Klear-Regular.otf` | every numeral inside a control; folios, counts, hotkeys |

Scale: 11 → 104px on a 1.26 ratio (`--fs-3xs` … `--fs-7xl`). Line heights 0.98 / 1.12 / 1.35 / 1.6 / 1.78. Tracking 0 for reading, **0.14em** for labels, **0.22em** for eyebrows, −0.012em for display. Prose measure caps at 62ch. Minimums: 11px on screen, 8pt in print, 24px on a 1920×1080 slide.

### Colour
The constant ground is **cream lithograph stock and warm black ink** — never pure white, never pure black. House accents are forest green, terracotta, brass, peacock and lilac, with oxblood for danger.

Semantics are the only thing components reference: `--surface-page / -card / -raised / -sunken / -inverse / -accent-soft`, `--text-title / -body / -muted / -inverse / -accent / -on-accent`, `--line-hairline / -rule / -strong / -gilt`, `--accent` plus `--accent-2…5`, `--gilt` / `--gilt-2`, `--status-good / -warn / -bad / -info`.

**Fourteen colour schemes** re-declare that whole set: the house `atelier` (light) and `noir` (dark, gilded), plus the twelve supplied palettes — `spectrum`, `midnight-gold`, `violet-vermilion`, `delft`, `apricot`, `slate-ember`, `verdigris`, `absinthe`, `bonbon`, `lagoon`, `saltire`, `sage-stone`. Apply with `data-theme` on `<html>` or any container. Because every scheme declares the full set, no component needs theme-aware code. Preview them all in **`guidelines/theme-lab.html`**.

One accent leads a screen; the rest support. Gilt is a *finish*, not a fill — rules, inner frames, switch knobs, meter rails, and at most one hero action per view. Never gilt body text.

### Corners and contours
The signature move is the **whiplash corner**: one corner opens wide, its diagonal opposite stays tight (`--radius-whip: 22px 3px 22px 3px`). A uniform radius on a primary surface is off-brand. Supporting shapes: `--radius-arch` (doorway tops, hero actions), `--radius-petal` (avatars, orbs), `--radius-lozenge` (badges, cartouches), `--radius-pill` (tracks, tabs pills).

Lithography draws a contour first, so **nearly everything carries a visible line**: `--stroke-hair` 1px, `--stroke` 1.5px, `--stroke-bold` 2px, `--stroke-heavy` 3px, `--stroke-plate` 4px. The house divider is a **double rule** — a 1px line and a hairline 3px below it, not a single stroke.

### Cards and panels
A card is cream paper with a 1.5px ink contour, a whiplash corner and a **hard offset plate shadow** (`--shadow-letterpress` 3px, `--shadow-plate` 6px, no blur). Precious content adds `framed` — a hairline inner rule 5px inside the contour. `Panel` is the same construction with a sunken title bar and is used for tools; `Card` is used for content. Blur is reserved for things that genuinely float: `--shadow-lifted` on dialogs, `--shadow-sheet` on bottom sheets, tooltips. `--shadow-sunken` is the only inner shadow, for recessed tracks and inventory grounds.

### Backgrounds and texture
Three grounds, in order of preference: flat `--surface-page`; `--ground-paper` (a real scanned paper texture); `--ground-damask` (a seamless drawn tile). Pattern goes behind headers, hero plates, game panels and print covers — never behind body copy at full strength. Gradients are only ever a two-stop vertical shade between two adjacent surface tokens (`--ground-plate`); there are no colourful, diagonal or multi-hue gradients anywhere, and none in the accent hues.

Full-bleed imagery is used deliberately and sparingly: one hero plate per web screen, one per game screen, the cover and poster in print.

### Imagery
Warm, slightly desaturated, visible grain, ink-contoured. `--filter-plate` (`saturate(.88) contrast(1.04) sepia(.06)`) is applied to every photograph and illustration so mixed sources read as one printing. `--filter-duotone` is available for archive treatments. Images are never cropped to a plain circle in web, desktop or print — the petal cut or the arch is used instead; Android surfaces are the one place round crops are correct.

### Type over imagery
Two devices, chosen by length. **Capsules** (`--capsule-scrim`, a solid card-coloured chip) for short labels and metadata. **Protection gradients** (`--scrim-bottom`, `--scrim-top`, `--scrim-flat`) for headlines sitting on a plate. Full-opacity ink on either — never alpha-faded type over a photograph.

### Transparency and blur
Used in exactly three places: the modal scrim (`rgba` ink + `--blur-veil` 14px), the game cooldown veil, and ornament opacity (`--opacity-ornament` 0.16, `--opacity-texture` 0.22). Nothing else is translucent. No frosted panels, no glassmorphism.

### Motion
One curve carries the brand: `--ease-whiplash: cubic-bezier(.62,.03,.31,1)` — slow entry, decisive sweep, soft settle, exactly like the line it is named after. `--ease-tendril` adds a small overshoot for game feedback; `--ease-out-soft` for hover and colour; `--ease-in-soft` for press. Durations: 140ms hover/press, 240ms reveals, 420ms dialogs and sheets, 700ms page transitions. Everything collapses to 0ms under `prefers-reduced-motion`.

Nothing bounces except `--ease-tendril` accents. Nothing spins. There is no indeterminate spinner in the system — progress is always determinate.

### Hover and press states
**Hover** deepens rather than lightens: the accent moves to `--accent-strong`, and the plate shadow *grows* from 3px to 6px, as if the card lifted off the stone. Secondary surfaces move to `--surface-sunken`. Ghost controls gain a 1px underscore instead of a fill. Nav links draw a gilt rule that sweeps out from the centre.

**Press** displaces, never scales: `transform: translate(2px,2px)` and the shadow collapses to none, so the plate sits down into its own shadow. Game orbs additionally take `--shadow-glow-gilt`.

**Focus** is a two-ring halo — `--focus-ring` puts the page colour then the accent around the control, so it reads on any ground.

**Disabled** is 42% opacity with the shadow removed and no transform.

### Layout
`--max-content` 1180px, `--max-prose` 680px, `--page-margin` 40px (20px mobile), `--gutter` 24px, print margin 18mm. Spacing is a 4px scale (`--space-1` … `--space-32`); when in doubt take the larger step. Control heights 30 / 38 / 48px, with 48px the mobile minimum. Fixed elements are limited to: the web NavBar (static, not sticky), desktop window bars and status strips, mobile status bar / header / tab bar, and game HUD corners. Nothing else pins itself to the viewport, and print layouts contain no viewport units at all.

---

## ICONOGRAPHY

**One source: Font Awesome, Kit `559791bdc6`.** Every surface loads it the same way and no other icon set, sprite or hand-drawn SVG glyph is used.

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

- **Style:** `fa-solid` everywhere. The only exceptions are `fa-regular fa-square` (the Windows maximise glyph, which must read as an outline) and `fa-regular fa-circle` for an incomplete quest step.
- **Size:** 0.92em inside buttons, 18px in side navigation and tab bars, 22px in specimen grids. Icons inherit `currentColor` and are tinted `--accent` in navigation and `--gilt` in game chrome.
- **Passing icons:** components take a Font Awesome class string, not a node — `icon="fa-solid fa-leaf"`. All decorative glyphs are `aria-hidden`, and every icon-only control requires a `label`.
- **The recurring set:** `leaf` (breadcrumb separator, dialogue choices), `feather` (studio/brand), `stamp` (proofs), `images` (plates), `box-archive`, `scroll`, `flask`, `gem`, `key`, `champagne-glasses`, plus the standard chevrons, `xmark`, `plus`, `ellipsis`, `magnifying-glass`.
- **Ornaments are not icons.** `assets/ornaments/*.svg` are drawn artwork — leaves, butterflies, panels, emblems — mounted through the `Ornament` component as decoration. They are always `aria-hidden`, never interactive, never substituted for a functional glyph, and capped at two per screen. Corner ornaments mirror themselves, so one file serves all four corners.
- **No emoji, ever. No unicode dingbats as icons.**

---

## Index

### Root
| File | What it is |
| --- | --- |
| `styles.css` | the single entry point consumers link — `@import` lines only |
| `readme.md` | this document |
| `thumbnail.html` | homepage tile: wordmark on forest green with an accent swatch strip |

### Tokens — `tokens/`
`fonts.css` (17 `@font-face` rules) · `colors.css` (base palette + semantic aliases) · `themes.css` (14 `data-theme` scopes) · `typography.css` (families, ramp, ready-made type roles) · `spacing.css` · `borders.css` (strokes, whiplash radii, shadows, focus ring) · `motion.css` (easing, durations, reduced-motion) · `surfaces.css` (textures, patterns, scrims, filters) · `base.css` (element defaults, link colours)

### Components — `components/`
**core/** — `Button` · `IconButton` · `Badge` · `Tag` · `Card` · `Panel` · `Divider` · `DropCap` · `Ornament`
**forms/** — `Input` · `Textarea` · `Select` · `Checkbox` · `Radio` · `Switch` · `Slider`
**navigation/** — `NavBar` · `SideNav` · `Tabs` · `Breadcrumb` · `Pagination`
**feedback/** — `Dialog` · `Toast` · `Tooltip` · `ProgressBar` · `Alert`
**data/** — `Table` · `StatBlock` · `ListRow` · `Avatar`
**chrome/** — `MacWindow` · `WindowsWindow` · `LinuxWindow`
**mobile/** — `StatusBar` · `MobileHeader` · `TabBar` · `ActionSheet`
**game/** — `GameFrame` · `ResourceMeter` · `SkillOrb` · `InventorySlot` · `DialogueBox`
**print/** — `Sheet` · `Masthead` · `PlateFigure` · `PullQuote`

Every component ships `<Name>.jsx`, `<Name>.d.ts` (props contract) and `<Name>.prompt.md` (what & when, usage, variants). Each directory has one `@dsCard`-tagged HTML preview and one `.css` file, all reachable from `styles.css`.

**Intentional additions** (authored because the sources define no component library, and these five surfaces need them):
- `Ornament` — the library supplies drawn ornament *files* rather than a component; every surface needs one predictable way to hang them.
- `MacWindow` / `WindowsWindow` / `LinuxWindow` — the desktop surface was explicitly requested with chrome for all three platforms and all window types.
- `StatusBar` / `MobileHeader` / `TabBar` / `ActionSheet` — likewise for iOS and Android.
- `GameFrame` / `ResourceMeter` / `SkillOrb` / `InventorySlot` / `DialogueBox` — the game surface, styled in the existing language rather than conventional game-UI idiom.
- `Sheet` / `Masthead` / `PlateFigure` / `PullQuote` — the print surface.

### UI kits — `ui_kits/`
| Kit | Entry | Screens |
| --- | --- | --- |
| Web | `ui_kits/web/index.html` | issue home, essay, archive, subscribe |
| Desktop | `ui_kits/desktop/index.html` | plate library, proof editor, preferences — in macOS / Windows / GNOME frames, plus dialog, utility, inspector and inactive windows |
| Mobile | `ui_kits/mobile/index.html` | sign-in, portfolio feed, plate detail, profile — iOS beside Android |
| Game | `ui_kits/game/index.html` | title screen, in-game HUD, satchel, chronicle |
| Print | `ui_kits/print/index.html` | issue cover, essay spread, exhibition poster, certificate |

Each kit has its own `README.md` listing the screens, the interactions worth trying, and the platform rules it follows.

### Templates — `templates/`
Five starting folders a consuming project can copy. Each is a Design Component whose entry loads this system through a sibling `ds-base.js`; edit the one `base` line in that file to re-point it at a bound copy of the system.

| Template | Entry | Screen |
| --- | --- | --- |
| Web page | `templates/web-page/WebPage.dc.html` | editorial page: nav, hero, plate cards, studio letter |
| Desktop app | `templates/desktop-app/DesktopApp.dc.html` | macOS-framed app: side nav, toolbar, grid, inspector, status strip |
| Mobile app | `templates/mobile-app/MobileApp.dc.html` | phone screen: status bar, large title, cards, list rows, tab bar |
| Game UI | `templates/game-ui/GameUi.dc.html` | in-game HUD on `noir`: vitals, quest cartouche, dialogue plate, skill row, hotbar |
| Print sheet | `templates/print-sheet/PrintSheet.dc.html` | A4 essay page: masthead, running head, two columns, pull quote, plate, folio |

### Guidelines — `guidelines/`
26 specimen cards populating the Design System tab, grouped **Type** (display, poster caps, title, body, editorial, label, accent, decorative, size ramp), **Colors** (paper & ink, house accents, semantic surfaces, status, gilt, all fourteen schemes, and the interactive **`theme-lab.html`**), **Spacing** (scale, spacing in use, radii, strokes & rules, shadows) and **Brand** (motion, ornaments, patterns, imagery treatment, iconography).

### Assets — `assets/`
`fonts/` 18 binaries · `ornaments/` 12 SVGs (leaves, butterflies, panel, emblems) · `patterns/` 3 seamless SVG tiles + 2 paper textures · `illustrations/` floral and gold PNGs with transparency, plus two magic overlays · `imagery/` 5 photographic plates. No logo — see above.

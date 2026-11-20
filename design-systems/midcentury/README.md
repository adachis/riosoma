# Midcentury — design system

A mid-century modern design system for any surface: web, desktop apps, mobile apps, game
interfaces and print. It is an original system built **in the idiom of** post-war graphic
design — flat geometric shapes on tinted paper stock, saturated screen-print inks, heavy
grotesque display type over geometric-sans UI text, hard offset shadows instead of blur,
and illustrated period spot art. Nothing in it reproduces, copies or references the
branding, marks, names or copy of any real company.

There is **no logo**. The sources contained no brand mark, so none was invented: wherever a
mark would go, the system sets the word *Midcentury* (or the consuming product's name) in
the display face. See "Wordmark" below.

## Sources given to us

| Source | What it was | How it was used |
| --- | --- | --- |
| Local folder `Midcentury/` (attached codebase mount) | ~60 commercial mid-century asset packs: seamless vector patterns (.ai/.eps/.svg/.png), 15 texture plates, 32 retro background plates, a 40-icon "fifties lifestyle" SVG set, and a dozen rubber-hose character/mascot packs | The visual ground truth. Patterns, plates, spot icons and illustrations were copied into `assets/`. **No code, tokens, fonts or component definitions existed in this folder** — it is an art library, not a codebase, so the component inventory below was authored from scratch. |
| 30 reference images in `uploads/` | Mid-century book covers, posters, magazine/appliance advertising, retro web pages, one game key art | Read for aesthetic direction only. **Not used in the system**, not copied into `assets/`, and no branding, lettering or copy from them appears anywhere. |
| 12 Coolors palette links | Five-to-ten step colour ramps | Became the twelve named colour schemes. |
| Font Awesome kit `fde87cf732` | Icon font kit | The system's only UI icon source. |

No Figma file, repository or product code was provided; there is nothing further to read.

## Twelve colour schemes

Every scheme maps the same eleven semantic tokens, so a component written once renders
correctly in all of them. `atomic` is the default on `:root`; the rest are scoped by
`[data-theme="…"]` and can be applied to `<html>` or to any subtree.

| Scheme | Character | Mode |
| --- | --- | --- |
| `atomic` | Navy ink on cream stock, vermilion CTA, mustard accent — the default | light |
| `nightfall` | Midnight blues, signal yellow | dark |
| `neon-noir` | Violet ground, hot pink, amber | dark |
| `harbor` | Naval blues with a single red alarm | light |
| `apricot` | Powdered pastels, sage counterweight | light |
| `cabin` | Slate blue, olive, campfire orange | light |
| `lagoon` | Deep teal into mint | light |
| `jukebox` | Forest ground, aqua neon, coral | dark |
| `candy` | Sherbet brights on warm white | light |
| `poolside` | Chlorine greens with a hot red stripe | light |
| `spectrum` | Full ten-step travel-poster ramp | light |
| `sage` | Quiet greys and greens, mint accent | light |

```js
document.documentElement.dataset.theme = "nightfall";   // whole page
panel.dataset.theme = "candy";                          // one subtree
```

Scheme switching is a **specimen and documentation facility**, not a product feature. Ship
one scheme per product; the switcher appears in the guideline cards and in each UI kit's
dark specimen strip, always outside the mocked interface.

---

## CONTENT FUNDAMENTALS

The voice is a 1961 catalogue writer: plain, specific, faintly dry, never excited. It
states what a thing is and what it does, then stops.

**Person.** Third person and imperative. "Stacks six high." "Order by wire." Second person
only in instructions ("Leave at the goods door"). First person plural is rare and reserved
for the works speaking about itself ("We hold spares for fifty years"). No "we believe",
no mission statements.

**Sentence shape.** Short declaratives, often with a concrete number or material in them.
Facts are allowed to carry the emotion:

> One piece, four legs, no upholstery to speak of. The shell chair weighs less than the
> catalogue it arrived in.

> Vermilion outsold walnut two to one, which surprised nobody in the drawing office and
> everybody in accounts.

**Casing.** Sentence case for headlines, body and buttons-in-prose. Tracked UPPERCASE for
structural labels only: nav links, buttons, table headers, eyebrows, tab labels, key hints.
Never uppercase a full sentence. Display headlines may be uppercase when they are three
words or fewer ("SIT LIGHTLY", "SET TWELVE").

**Numbers and units.** Always specific, always mono: `4.1 kg`, `430 mm`, `18,402 units`,
`£38`, `35¢`, `MC-4021`, `Vol. IV / No. 2`. Catalogue numbers, prices, folios, timecodes
and table figures are set in Space Mono. Never round a spec to make it prettier.

**Labels.** Nouns, not verbs: "Finish", "Delivery", "Lead time", "Colourways". Buttons are
verb + object: "Add to order", "Request catalogue", "Send to press". Never "Learn more",
"Get started", "Discover".

**Microcopy examples.**
- Empty state: "Nothing on this shelf yet."
- Error: "Plate number does not match the ledger."
- Success toast: "Saved to the archive."
- Lead-time notice: "Vermilion is on a six-week lead. Chalk and ink ship from stock."

**Emoji: never.** Not in UI, not in docs, not in marketing copy. Icons are Font Awesome
glyphs; decorative character comes from the illustrated spot art. Unicode is used only for
real typographic marks — ‹ › × ¢ £ ° — and for platform glyphs in window chrome (— □ ✕).

**One flourish per layout.** The script face (Grand Hotel) is allowed exactly one phrase
per page or screen — a signature, a tagline, a plate note. Two is a mistake.

---

## VISUAL FOUNDATIONS

**Colour.** Flat fills only. A layout draws from paper (ground), ink (text and outlines) and
at most two of primary / accent / secondary. Support is a fourth, used sparingly as a spot.
Gradients are used in exactly one place: a top-to-bottom black wash over a full-bleed
period plate so type can sit on it. There are no colour gradients anywhere in the UI, and
never a bluish-purple one.

**Which tokens may carry text.** This is the one pairing rule that breaks silently across
twelve schemes, so it is worth stating flatly:

- `--ink` and `--ink-2` are the **only** text colours safe on any paper tint. `--ink` is
  guaranteed against `--paper`, `--paper-2` and `--paper-3` in every scheme.
- `--primary`, `--secondary`, `--accent` and `--support` are **fill** tokens. They are not
  text colours. In the dark schemes `--secondary` is a dark surface (`#003566` in nightfall,
  `#9e0059` in neon-noir) and setting it as a colour on a dark ground makes the text vanish.
  A coloured script line, drop cap or link wants `--ink`; if you want colour there, verify
  it in nightfall, neon-noir and candy, which are the three that break first.
- Each fill has a matching text token — use `--primary-ink` **on** `--primary`, never
  anywhere else. `--paper` is the text colour on an `--ink` ground.

**Links on coloured grounds.** `a` is `--ink` with a `--primary` underline, which is correct
on paper and invisible on an ink or primary band. Use `.mc-link-inv` there: it takes
`currentColor`, so it adopts whatever the band already set, and its hover pairs `--accent`
with `--accent-ink`. Add `--quiet` to drop the resting underline (footer columns, nav rows).

Do **not** hand-roll an inline `color` on a link to solve this. An inline style outranks
every stylesheet rule including `a:hover`, so the hover state then paints its `--accent`
background underneath your inline colour — cream on gold, around 1.2:1. This is the trap
`.mc-link-inv` exists to close, and it is the reason no `<a>` in the kits or templates
carries an inline colour.

Contrast today: `--ink` on any paper clears AA everywhere, and every filled control clears
AA Large. `--ink-2` at 12–13px sits between 3.1:1 and 4.4:1 in seven of the light schemes,
and the filled primary button between 3.1:1 and 3.9:1 — both clear AA Large but not AA.
Raising them means retuning `--ink-2` and `--primary-ink` per scheme, which shifts nothing a
reader would call the palette but does change the look of muted labels and primary buttons.
Flagged, not silently changed. Two schemes that fell *below* the 3:1 floor have been fixed:
`cabin` now takes its `--ink` as `--primary-ink`, and `lagoon`'s `--primary` was darkened to
`#197476`.

**Type.** Five faces, no more.
- `--font-display` **Archivo Black** — poster headlines, stats, mastheads, window and panel
  titles. Uppercase at large sizes, tracking −0.03em.
- `--font-ad` **Anton** (News Gothic Extra Condensed stand-in) — the shouted advertising
  headline. Section shouts, product names, price flashes, catalogue plate numbers. This is
  the era's advertising voice; use it where a 1961 magazine page would have raised its
  volume, not for body copy or UI. Roles: `.mc-ad`, `.mc-ad-sm`.
- `--font-core` **Jost** (Futura stand-in) — all UI text and body copy, 300–700.
- `--font-script` **Grand Hotel** — one phrase per layout.
- `--font-mono` **Space Mono** — figures, catalogue numbers, captions, status strips, key hints.

Scale runs 11px → 148px in seventeen steps. Leading is tight at display sizes (0.92–1.05)
and generous in body (1.5). Tracking is the main structural signal: 0.22em eyebrows, 0.09em
labels, −0.03em posters.

**Spacing and layout.** 4px spine (2px and 1px exist for hairlines), 16 steps to 160px.
Page max 1240px, 56px page padding on web, 24px in apps. Sections are divided by 3px ink
rules, not by shadow or background change alone. Web nav is sticky only in the specimen
chrome; product headers scroll. Cards and panels sit on a grid of 2–4 columns; content is
never centred in a full-width column.

**Backgrounds.** Four kinds, never mixed in one band:
1. Flat paper tint (`--paper`, `--paper-2`, `--paper-3`) — the default for anything with copy.
2. **Era motif** (`components/motifs.css`, classes `.mc-mo--*`, or the `Motif` component) —
   the system's primary ground treatment. See "Cut paper, motifs and print texture" below.
3. **Seamless pattern tile** (`assets/patterns/`, tokens `--tile-*`) at 90–240px repeat — for
   media wells, card media, editor grounds, desktop wallpaper.
4. **Full-bleed period plate** (`assets/textures/`, `assets/backgrounds/`, tokens `--plate-*`,
   `--field-*`) — sunbursts, ray fields, banded curtains, concentric rings, printed on visible
   paper grain. Reserved for covers and title screens; the CSS motifs are preferred anywhere
   the ground has to theme across all twelve schemes, because the plate images cannot.

Body copy never sits directly on a tile or plate. It sits on paper next to it, or inside a
panel over it, or over a `wash` colour passed to `PatternField`. Imagery in this system is
warm, flat and printed: cream and ochre grounds, visible grain, no photographic depth of
field. Cool schemes (harbor, lagoon, sage) tint the same plates cooler by placing them under
their own paper and ink.

**Borders.** The system's defining device. 1px hairline for row separators and column rules,
**2px for every outline** (buttons, inputs, cards, panels, bars), 3px for section rules and
game panels, 5px for slab markers (masthead underline, callout top edge). Border colour is
always `--line` (the scheme's ink), never a tint of the fill.

**Art wells.** The spot-icon and illustration SVGs are flat vector art with dark outlines,
so any surface that backs them uses the scheme-independent `--art-well` / `--art-well-2`
fills with `--art-well-ink` text, never a scheme surface token — otherwise the art vanishes
in `nightfall`, `neon-noir` and `jukebox`. This applies to item slots, dialogue portraits,
framed/circle spot icons and product/artwork panels. Status that would otherwise tint such a
well (item rarity, selection) is signalled on the ring or outline instead.

The same rule governs **type set directly on a plate**: plates are fixed-colour art, so text
over one uses `--art-well-ink` (with an `--art-well` offset shadow for poster display type),
never `--ink` or `--paper` — those invert with the scheme while the art does not. Text that
must use scheme tokens goes inside an opaque panel over the plate instead.

**Shadows.** Hard ink offsets, zero blur: 2px (resting controls), 4px (cards), 7px (raised
panels, dialogs, posters), 1px (pressed). The only blurred shadow in the system is
`--shadow-print`, used exclusively on paper sheets in print mocks. There are no inner
glows. `--shadow-inset` exists for pressed wells and is used sparingly.

**Corner radii.** Mostly square: 0 and 3px do 90% of the work; 6px and 14px for larger
surfaces; pill for tags, chips, switches and marketing CTAs; circle for radios, lights and
avatars. Two era signatures: `--r-arch` (999px 999px 0 0) for artwork wells, portraits and
product panels, and `--r-leaf` for accents. Nothing in the system uses a uniform 8px radius
"card" look.

**Cards.** Flat paper-2 fill, 2px ink outline, 3px radius, 4px hard shadow. Media sits at the
top, separated by a 2px rule. Header and footer strips are divided by rules, not by tint.
Variants: `flat` (no shadow, for dense lists), `lift` (7px shadow), `arch` (half-round top),
`tinted` (paper-3 fill). No card ever uses a coloured left border as its only marker — tone
lives in a 5px **top** slab (see `Callout`, `Alert`).

**Animation.** Short and mechanical. 110ms for hover, 180ms for toggles, 260ms for bars and
panels, 420ms maximum. `--ease-snap` for controls, `--ease-boomerang` (slight overshoot) for
switches and knobs, `--ease-flat` for borders. **Fills are never transitioned** — a hover is a shadow step plus a 1px shift, and animating background-color would also animate every scheme change. No fades on controls, no scale-in modals, no
parallax, no scroll-triggered reveals. One looping animation exists: the dialogue-box caret
nudge (900ms alternate). All durations collapse to 0 under `prefers-reduced-motion`.

**Hover states.** An element shifts −1px/−1px and its hard shadow grows one step; solid-fill
buttons instead brighten 6–12% via filter. Ghost buttons and links take the accent fill with
ink text. Rows tint to paper-3. Nothing changes opacity on hover except deliberately faded
affordances (a toast dismiss ×).

**Press states.** The inverse: +1px/+1px with the shadow collapsing to 1px, so the element
appears to sit down onto the page. Game menu rows slide 4px right and invert instead.

**Focus.** 3px solid `--focus` (the scheme's primary) at 2px offset, on every interactive
element. Never removed, never replaced with a subtle inner ring.

**Transparency and blur.** Almost none. Transparency is limited to `--overlay` (62% warm ink)
behind dialogs, 8%/16% ink washes for zebra rows and meter wells, and a multiply-blended
grain overlay (`.mc-grain`, 14%). There is **no backdrop blur** and no frosted glass anywhere;
the era had ink and paper, not glass. Protection over imagery is done with an opaque panel or
a solid/gradient wash, not a blur.

**Fixed and sticky elements.** Only the specimen strip in the kits is sticky. Product chrome
(window bars, phone status bars, tab bars, HUD panels) is fixed by layout, not by `position:
fixed`, so mocks compose predictably.

---

## CUT PAPER, MOTIFS AND PRINT TEXTURE

This is what makes the system mid-century rather than merely colourful and flat. Palette
alone reads as generic minimalism. The era's identity is in three things: shapes that hold
content, patterns that cover ground, and ink that sits on paper with visible tooth.

### 1. Shapes are structure, not decoration

`components/shapes.css` is the cut-paper kit — the forms era covers, packaging and posters
were trimmed from coloured stock: `dome`, `qtr-tl`/`tr`/`br`/`bl`, `half-l`/`half-r`,
`lozenge`, `leaf`, `screen`, `kidney`, `blob`, `wedge`, `diamond`, `trapezoid`, `chevron`,
`ring`, `arc` (the boomerang), `star` (the atomic asterisk), plus `tab`. Fill comes from
`--sh`; screened fills (`dotted`, `striped`, `hatched`) take a second ink in `--sh-2`.

**The rule that matters: a shape should contain something.** Pictures go under an arch
(`--r-arch`). Labels go inside a lozenge. Panels are kidneys. A shape parked beside the
content as a sticker is the failure mode — it looks like a modern flat illustration, not a
1961 cover. Free-floating shapes are legitimate only as a composed plate (a poster, a title
screen, an empty artwork well), where the shapes *are* the picture.

Supporting devices: `.mc-wire` (the hairline-and-bead of a Calder mobile — use it as a
divider, a connector between stats, a rule that trails off), `.mc-offset` and
`.mc-card--plate` (a second impression printed slightly out of register, coloured with
`--offset-ink`), `.mc-collage` / `.mc-cut` / `.mc-fg` (a stage whose children may bleed the
trim), and `.mc-trim-*` (hard diagonal cuts of a two-colour run).

### 2. Motifs cover ground, tone on tone

`components/motifs.css` draws twelve era patterns in pure CSS: `lattice` (cane screen),
`diamond-line`, `sticks` (pick-up sticks), `barkcloth`, `tilework`, `harlequin`, `triangles`,
`arcade`, `scallop`, `ribbon`, `sputnik`, `starburst`. Because they are gradients on
`currentColor` they theme across all twelve schemes and scale freely — which the bitmap
tiles and plates cannot.

A motif is a **layer, never a surface for text.** Put it inside a `.mc-ground` as a sibling
behind the content, or pass `motif` to `Card`, or use the `Motif` component:

```html
<div class="mc-ground">
  <span class="mc-mo mc-mo--starburst" style="--mo-op:.09;--mo-size:64px;--mo:var(--secondary)"></span>
  <h2>Copy sits above it</h2>
</div>
```

`.mc-ground` handles the stacking: the motif goes to `z-index:0`, every other child to `1`.

**Opacity is the whole discipline.** `--mo-op` .06–.14 behind content; up to .3 inside a
shape or a media well, where there is no text to fight. Above that it stops being a ground
and starts being a pattern sample. Line motifs (`lattice`, `sticks`, `barkcloth`) read
lighter than filled ones (`harlequin`, `triangles`, `arcade`) at the same value — drop the
filled ones a few points. One motif per band. Two motifs in one band is a quilt.

### 3. Texture is a whisper

`tokens/texture.css`. `.mc-stock` lays paper tooth over a ground (`--faint` ≈ .16,
default .3, `--tooth` ≈ .52); `.mc-plate` does the same above absolutely-positioned collage
art. Halftone screens (`.mc-screen-dots`, `-fine`, `-coarse`, `-hatch`, `-bars`, `-rules`)
are how the era got a midtone out of one ink — reach for them instead of lowering opacity
on a fill. `.mc-overprint` offsets a second colour behind display type by a few hundredths
of an em.

**Restraint is not optional here.** `--faint` is the default for any surface carrying copy;
full `.mc-stock` suits a poster or a printed sheet; `--tooth` is for a single deliberate
plate. Grain that you notice as grain has been overdone, and it makes type look dirty
rather than printed. Overprint stays under .1em and appears once per layout.

---

## ICONOGRAPHY

**UI glyphs: Font Awesome, kit `fde87cf732`.** This is the system's only control-icon source.
Load once per page, then use the `Icon` component or raw `<i>`:

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```
```jsx
<Icon name="record-vinyl" size={18} />
<Icon name="gear" style="sharp-solid" fixedWidth />
```

Solid is the default weight. **Sharp Solid** is preferred in window chrome, toolbars and
dense app UI — the squarer terminals sit better under the geometric type. Regular is used
for outline states (unfilled heart/star). Duotone and thin are not used. Icons never appear
below 14px or above 26px in UI; at larger sizes use spot art instead.

**Spot art: 28 illustrated period objects** copied from the source library into
`assets/spot-icons/` (jukebox, tv, telephone, vinyl-record, diner, car, cocktail, camera,
clock, sputnik, chair, toaster, gramophone, popcorn, scooter, bowling, soda, hamburger,
stars, watch, amplifier, table, mixer, coffee-grinder, microwave, gas-station,
electric-guitar, hula-hoop). Flat multi-colour vector SVGs. These are **decoration and
category art** — service bands, empty states, item slots, catalogue figures, brand marks in
nav — never control glyphs. Use `SpotIcon`, and set its `base` to the correct relative path.

**Illustration cast.** `assets/illustrations/` holds a rubber-hose shape-mascot family
(`cartoon-01` circle, `cartoon-02` heart, `cartoon-03` triangle — thick black outline, cream
gloves and shoes, cast shadow), a TV-robot mascot, a vintage drummer, six flat vector object
illustrations and a 50s-professions plate. Used for game portraits, dialogue speakers, hero
figures and editorial spots. All copied from the provided library; none drawn here.

**Unicode.** Used only for typographic marks (‹ › × … ¢ £ °) and window-chrome glyphs
(— □ ✕), where a font glyph is more honest than an icon. **Emoji are never used.**

**No hand-drawn SVG.** Nothing in this system draws illustration in code. Every picture is a
copied asset; every glyph is Font Awesome; CSS is used only for pure geometry (chevrons,
diamonds, ticks, carets).

## Wordmark

There is no logo file. Set the product or system name in `--font-display`, uppercase, at
`--ls-display` or tighter, optionally preceded by a single `SpotIcon`. Examples in use:
`HALDEN` + `chair` spot icon in the web kit nav, `MIDCENTURY` on the project thumbnail.
If a real mark is later supplied, drop it in `assets/logo.svg` — the thumbnail picks it up.

## Fonts — substitutions to confirm

The asset library shipped **no font binaries**, so all four faces are nearest-match Google
Fonts served over CDN (`tokens/fonts.css`), not licensed originals:

| Role | Used | Standing in for |
| --- | --- | --- |
| Display | Archivo Black | A heavy post-war grotesque (Aurora/Standard/Futura Black weight) |
| Core | Jost | Futura / Erbar geometric sans |
| Script | Grand Hotel | 1950s brush-script signature lettering |
| Mono | Space Mono | Typewriter / technical annotation |

**Please send licensed font files if you have them** — drop the binaries in `assets/fonts/`
and replace the `@import` in `tokens/fonts.css` with local `@font-face` rules; nothing else
needs to change.

---

## Index

### Root
- `styles.css` — the single entry point consumers link. `@import` lines only.
- `readme.md` — this file.
- `thumbnail.html` — homepage tile.

### `tokens/`
`fonts.css` (webfont imports) · `colors.css` (12 schemes + status inks) · `typography.css`
(faces, 17-step scale, leading, tracking, weights, measures) · `spacing.css` (4px spine,
gutters, control heights, tap target) · `shape.css` (radii incl. arch/leaf, border weights,
hard shadows, rules) · `motion.css` (durations, easings, reduced-motion) · `patterns.css`
(tile / plate / field asset tokens) · `base.css` (element defaults, link colours, focus
rings, typographic role classes, grain overlay).

### `components/` — 50 components in 10 groups
Each directory holds `<Name>.jsx`, `<Name>.d.ts`, `<Name>.prompt.md`, a group stylesheet, and
one `@dsCard` HTML specimen.

- **core** — `Button`, `IconButton`, `Badge`, `Tag`, `Card`, `Divider`, `Callout`
- **forms** — `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`
- **navigation** — `NavBar`, `Tabs`, `Breadcrumbs`, `Pagination`, `SideNav`
- **feedback** — `Alert`, `Toast`, `Dialog`, `Tooltip`, `ProgressBar`
- **data** — `Table`, `Stat`, `ListRow`, `Avatar`
- **brand** — `Icon`, `SpotIcon`, `PatternField`, `Motif`, `ThemeSwitcher`
- **desktop** — `WindowFrame`, `MenuBar`, `Menu`, `Toolbar`
- **mobile** — `PhoneFrame`, `MobileNavBar`, `MobileTabBar`, `MobileRow`, `Fab`
- **game** — `GamePanel`, `Meter`, `DialogueBox`, `GameMenu`, `ItemSlot`
- **print** — `PrintSheet`, `Masthead`, `PullQuote`, `Caption`

Usage: `const { Button, Card } = window.MidcenturyDesignSystem_72d14d` after loading
`_ds_bundle.js`, or import the `.jsx` directly in a bundled project.

### Intentional additions
The source library defined no components, so the inventory above was authored to cover the
five required surfaces. Three entries exist to serve the assets rather than a convention:
`Icon` (Font Awesome wrapper, so the kit is used consistently), `SpotIcon` (illustrated
period art with a correct-path prop) and `PatternField` (pattern/plate grounds with the
mandatory wash). `ThemeSwitcher` is a documentation control and must not ship in a product.

### `ui_kits/`
- `web/` — **Halden Works** marketing site: home, product, journal.
- `desktop/` — **Halden Studio**: library, plate editor, preferences, in macOS / Windows / Linux chrome.
- `mobile/` — **Halden Radio / Catalogue**: iOS and Android builds side by side.
- `game/` — **Set Twelve**: title screen, in-game HUD, inventory.
- `print/` — catalogue spread (Letter ×2), tabloid poster, A4 trade price list.

Each kit has its own README and an `index.html` with a dark specimen strip (screen switcher
+ scheme switcher). The strip is documentation chrome and is not part of the design. "Halden
Works" and "Set Twelve" are invented placeholder products, used so the kits show real
content instead of lorem ipsum.

### `guidelines/` — 23 specimen cards
Colours (roles, grounds, status inks, all twelve schemes, live switcher) · Type (display,
core, script, mono, 13-step scale, roles) · Spacing (scale, in use, control heights) ·
Shape (radii, border weights, shadows) · Motion (easing) · Brand (tiles, plates, spot icon
library, illustration cast, Font Awesome).

### `assets/`
- `patterns/` — 15 seamless mid-century tiles (SVG + PNG).
- `textures/` — 3 vector plates (sunburst, flames, swirl).
- `backgrounds/` — 4 grained period fields (rings, bands, rays, curtain).
- `spot-icons/` — 28 illustrated period objects (SVG).
- `illustrations/` — 3 shape mascots (PNG), TV-robot and drummer mascots, 6 vector objects, professions plate (SVG).

All copied verbatim from the provided `Midcentury/` library. No asset was generated, traced
or redrawn, and no uploaded reference image was used.

### `templates/` — starting folders for consuming projects
Each is a Design Component with a `scheme` tweak covering all twelve colour schemes.

- `marketing-page/MarketingPage.dc.html` — **Marketing page**: split hero on a period plate, colourway marquee, card grid, service band, editorial block, ink footer.
- `app-screen/AppScreen.dc.html` — **App screen**: menu bar plus three-pane window (sidebar, list, detail with stats and ledger table); `platform` tweak switches macOS / Windows / Linux chrome.
- `print-poster/PrintPoster.dc.html` — **Print poster**: tabloid sheet at true paper size, full-bleed plate, poster wordmark, primary band with script signature. Prints edge to edge.

Each template folder carries its own `ds-base.js`; a consuming project only edits the `base`
path in that file to point at the bound design-system tree.

### Starting points
Ten components are tagged as starting points for consuming projects: `Button` and `Card`
(Core), `Input` (Forms), `NavBar` (Navigation), `Alert` (Feedback), `Table` (Data),
`ThemeSwitcher` (Brand), `WindowFrame` (Desktop), `PhoneFrame` (Mobile), `GamePanel` (Game),
`PrintSheet` (Print).

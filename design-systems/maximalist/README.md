# Maximalist — design system

**Maximalist** is a loud, print-derived design language for screens, paper and games. It is built for products that want to be seen from across the room: flat saturated colour, high-contrast deco display type, ink borders on everything, hard offset shadows with no blur, seamless op-art tiles and torn photographic cutouts instead of stock photography, and stickers and tickers doing work that a subtle badge used to do badly.

It composes by **collage**, not by grid. Pieces overlap, rotate a few degrees, bleed off the edge and compete for the eye. `patterns/collage.css` is the layer that makes that a system rather than a mood, and it carries three rules that keep a collage from becoming mud: one element per view is the loudest, rotation stays between ±2° and ±9°, and body copy never sits directly on artwork — it sits on a `Plaque`.

It is not a mood board. Every decision below is a token, a class or a component, and the same set drives five surfaces: web pages, desktop apps, mobile apps, game UI and print layout.

## Where this came from

- **Source material:** a maximalist asset library supplied by the user — two display/text typefaces, three seamless op-art tiles, twenty-five op-art illustration plates, one hundred line ornaments, twenty geometric collage sheets and a set of photographs. The typefaces, tiles, plates, ornaments, backdrops and photographs used are shipped in `assets/`; the colour system is sampled directly from that artwork.
- **No brand was cloned.** There was no codebase, no Figma file, no component inventory, no logo and no copy in the sources. Nothing identifying any referenced studio, publication, artist or agency appears anywhere in this system. Names, copy and component inventory are original to this project; colour, type and artwork come from the supplied library.
- **Because no source defined a component inventory,** the component set below is an authored standard set, sized to the five target surfaces.
- **No logo exists.** No mark was supplied, so none was drawn. Wherever a logo would go, the brand name is set in the display face — see `guidelines/brand-wordmark.html` for the sanctioned lockups.
- **Two source SVGs were dropped** from the ornament set because their path data ran to 80–130KB each; the sixteen that ship are all under 7KB.

## Content fundamentals

**Voice.** Declarative, present tense, slightly deadpan. It states a fact and stops. It never explains that it is being bold.

- Yes: "Four rooms, one press, no encores." · "Ink is cheap. Restraint is expensive." · "11 of 250 left in A1."
- No: "Get ready to experience the ultimate…" · "We're excited to announce…" · "Unleash your creativity!"

**Person.** Second person for anything the user does ("Pick a plate", "Add to bag"). First-person plural only for the organisation's own commitments ("We'll come back within one working day"). Never first-person singular.

**Casing.**
- Display headlines: UPPERCASE, no terminal punctuation. `PRINT IT LOUDER`
- Section headings and card titles: sentence case. `Selected work`
- Labels, kickers, metadata, folios, status: UPPERCASE mono with wide tracking. `ISSUE 04 · SUMMER · SOLD OUT`
- Button labels: uppercase, one or two words, verb first. `SEE THE SHOP`, `RAISE DOCKET`
- Accent-face callouts: mixed case on purpose — it is the one place the system relaxes. `Extremely`

**Length.** Headlines under five words. Decks one sentence. Body paragraphs two to four sentences. Buttons never more than three words. Empty states are one line and say what is missing, not how sorry we are.

**Numbers are content.** Quantities, prices, coverage percentages, edition sizes and lead times are printed at display size rather than hidden in prose. `£64`, `284%`, `Ed. 250`, `72h`.

**Punctuation.** The interpunct `·` separates metadata items. The asterisk-star `✱` is the marquee separator. Em dashes are used sparingly, for an aside inside a sentence. No exclamation marks in UI copy.

**No emoji.** Not in UI, not in copy, not in docs. Icons come from Font Awesome; see Iconography.

## Visual foundations

**Colour.** Twelve complete schemes ship as `[data-theme]` scopes in `tokens/colors.css`; `oi-prime` is the default. **Nothing in the palette is invented.** Every hue is sampled from a shipped asset, from three source families:

| Family | Hues | Sampled from |
| --- | --- | --- |
| OI acid | `#ff00aa` `#00aaff` `#aa00ff` `#aaff00` `#ffaa00` over `#00344f` | the op-art plates — every channel is 00, AA or FF |
| Geo print | `#ff4818` `#3090ff` `#f078d8` `#a8d8c0` `#f0d8c0` `#304860` | the geometric collage sheets |
| Sport | `#f03060` `#00d8ff` `#ffd830` over `#183048` | the extreme-sport sheet |

Six schemes are built on the acid set (`oi-prime`, `oi-noir`, `violet-shock`, `lime-siren`, `cyan-blast`, `amber-alarm`), three on the print set (`geo-riot`, `geo-slate`, `bubble-mint`), two on the sport set (`sport-strip`, `sport-dark`), and `mist-clash` pairs the pastel mist grounds with acid accents. Each scheme declares its source ramp verbatim (`--p-1` … `--p-n`) plus a full semantic layer: `--ink`, `--paper`, `--surface`, `--surface-2`, `--text`, `--text-soft`, four accents with paired `--on-accent*` foregrounds, and `--ok` / `--warn` / `--danger` / `--info`. Three schemes (`oi-noir`, `geo-slate`, `sport-dark`) are dark: paper goes dark and ink becomes the bright line colour, which is why nothing hard-codes black.

**The pair rule, and it is not optional:** never put `--text`, `--ink` or `--paper` directly on a fill colour — use that fill's `--on-*` token. Eight fills (`--accent` … `--accent-4`, `--ok`, `--warn`, `--danger`, `--info`) each ship a paired `--on-*` foreground, and all 96 pairs across the twelve schemes — plus all 60 text-on-ground pairs — are computed to clear WCAG 4.5:1, measured minimum 4.60, so 11px badge and label text stays legible everywhere. Because the acid hues are mid-value, roughly half the pairs resolve to `var(--ink)` and half to `var(--paper)`; **no pair needs a non-brand fallback**. Violet `#aa00ff` is the only acid hue that takes a light foreground. The raw `--p-*` ramp is verbatim from the source artwork. Change a fill and you must recompute its partner. Maximum two background colours per composition; the rest of the noise comes from accents, textures and type.

**Type.** Three families with strict jobs (`tokens/typography.css`):

| Role | Family | Used for |
| --- | --- | --- |
| `--font-display` | Anegra | Posters, heroes, big numbers, stat values, game titles |
| `--font-accent` | Banky Sans | Stickers, pull quotes, one-word interruptions |
| `--font-text` | Banky Sans | All UI, headings, body copy |
| `--font-mono` | Space Mono | Labels, kickers, metadata, data readouts, folios |

**Anegra and Banky Sans are single-weight.** There is no weight ramp, so `700` renders as synthesised bold and `600` / `800` / `900` all resolve to the same thing. Emphasis comes from size, case, colour and the **type treatments** instead: `.mx-type-outline` (ink contour, no fill), `.mx-type-cased` (paper fill plus contour, for busy grounds), `.mx-type-pattern`, `.mx-type-photo`, `.mx-type-echo`, `.mx-type-squash` / `--stretch`, `.mx-type-vert`. Stack two or three on a page and one display face reads as several competing voices — see `guidelines/type-treatments.html`. None of them is legible below `--fs-title-2` (25px).

Scale runs 9 → 118px on a 1.333 ratio, rounded to whole pixels and never snapped to a 4px grid. Display leading is 0.86 with -0.02em tracking; body is 1.55 at 15px, measured to 66ch. Anegra is a high-contrast deco face — **never set it below 25px**; its thin strokes disappear.

**Spacing.** Base **5px**. The odd base is deliberate — the measurements come from the sheet, not from a framework default. Ramp: 5 / 10 / 15 / 20 / 30 / 45 / 65 / 90 / 130 / 180. Control heights 32 / 44 / 56 with 11×17px default padding. Minimum hit target 44px everywhere, including game HUD.

**Backgrounds.** Never a gradient. Four layers are available, in rising order of loudness:

1. Flat `--paper` or a flat accent block.
2. One of five pure-CSS pattern fills — halftone, stripe, checker, grid, zigzag (`tokens/texture.css`).
3. One of three **source tiles**, masked so they take any scheme colour: `.mx-mask-houndstooth`, `.mx-mask-chevron`, `.mx-mask-blade`. These are real seamless artwork, not CSS approximations, and because they are masks rather than images one file serves all twelve schemes.
4. A **raster backdrop** — six dense `geo-*` collage sheets and two pale `mist-*` grounds (`Backdrop`). Geo sheets are the loudest thing in the system: one per screen, and everything on one needs a `Plaque`, because the sheets contain every value from white to near-black and no text colour clears 4.5:1 against them. The `mist-*` grounds are pale enough to take `--text` directly, which makes them the right choice behind long-form copy.

Full-bleed bands separated by 9px brick borders are still the page rhythm; collage piles sit inside them. Photographs go in a `Cutout` — clipped out of their rectangle with an ink edge that follows the tear, in torn / blade / arch / circle shapes, with `duo` forcing a clashing photograph into `--accent`. Op-art `Plate`s stand in wherever a layout wants a picture and there is no real photograph; they carry their own fixed colour and ignore the scheme.

**Why masks are inlined.** `tokens/masks.css` holds every tile and ornament as a base64 SVG data URI. CSS masks obey same-origin rules and this system's files can be served from a different origin than the page loading them, so file references silently fail and the masked box paints solid. The `.svg` files under `assets/patterns` and `assets/marks` are the editable originals; regenerate `masks.css` from them if you change one.

**Borders.** The primary hierarchy device. Weights 1 / 2 / 3 / 5 / 9px, always solid `--ink`. Dashed 3px only for placeholders and drop zones.

**Shadows.** Hard offset blocks in `--ink` at 3 / 5 / 9 / 14px, zero blur, plus a two-colour `--shadow-stack` (accent then ink). There is exactly one inner shadow, `--shadow-inset`, used for form wells. No blurred shadow exists in the system.

**Radii.** 0 by default. 3px on controls, 7 and 14px for occasional soft cards, 999px for pills, avatars and stickers. Roundness is a signal, never a default.

**Transparency and blur.** Almost never. The only sanctioned uses are the modal scrim (`--scrim`, 62% ink plus a halftone), the `color-mix` tints behind alert bodies, and the duotone multiply on images. No frosted glass, no backdrop-filter, no protective gradients — labels over imagery get an opaque ink capsule instead.

**Animation.** Snappy and mechanical. Durations 70 / 130 / 210 / 380ms. `--ease-overshoot` (a 1.56 overshoot) on transforms, `--ease-snap` on shadows and colour, `--ease-step` (6 steps) for the spinner so it reads as a mechanism rather than a smooth spin. Marquees loop at 22s or 11s. Elements pop in from 0.86 scale with a -3° rotation; nothing fades in slowly, nothing dissolves. All of it collapses under `prefers-reduced-motion`.

**Hover.** Lift `translate(-2px,-2px)` and grow the shadow one step. Secondary pattern: swap the fill to `--accent-3` with its paired foreground. Never an opacity change, never a lighten/darken filter.

**Press.** Drop `translate(3px,3px)` onto zero shadow — the element visually lands on the page. No scale-down.

**Focus.** `--ring-focus`: a 2px paper gap then a 6px `--focus` (accent-3) ring, stacked on top of whatever shadow the element already has. Never removed, never a subtle glow.

**Disabled.** Surface-2 fill with a diagonal ink stripe over it, no shadow, soft text. Struck through with texture rather than faded to invisibility.

**Cards.** Flat colour block, 3px ink border, 3px radius, `--shadow-2`, 20px padding. Optional accent tone (fill plus paired foreground), `stack` shadow, or a -2.5° tilt — at most one tilted card per view. Clickable cards add the lift-on-hover.

**Layout rules.** `.mx-page` is 1240px max with a 30px gutter; long-form narrows to 820px. Grids are auto-fit `minmax(0,1fr)` so everything reflows.

**Collage layout** (`patterns/collage.css`) sits on top of that:
- `.mx-pile` is the canvas and `.mx-piece` a layer — position with `--x`/`--y`, size with `--w`, rotate with `--r`, stack with `--z`. A pile needs an explicit height; pieces are absolutely positioned.
- `.mx-lap` / `.mx-lap-y` overlap siblings without absolute positioning; `.mx-jumble` is a card grid that refuses to look like a grid; `.mx-split` is a deliberately lopsided editorial split; `.mx-bleed*` pulls a block past its gutter.
- `.mx-plaque` is the opaque copy panel, `.mx-strip` a hard band of colour, `.mx-tape` a stuck-down strip, `.mx-veil` the only sanctioned way to put text on a photograph without a plaque.
- Rotation steps are `.mx-tilt-1` … `.mx-tilt-6` (-2.5° / 2° / -5° / 4.5° / -8° / 7°). Nothing sits at a round angle — -5 and 4.5 look deliberate where -5 and 5 look like a grid that slipped.
- Piles **cannot reflow on their own** — fixed height, absolutely-positioned children. `.mx-pile--collapse` turns one into a normal column below 760px; tag the background layers `.mx-piece--ground` (first one stays, rest drop out), the artwork worth keeping `.mx-piece--art`, and the corner-fillers `.mx-piece--drop`. Marks and tape hide automatically. Pair it with the fluid display sizes `--fs-hero` / `--fs-hero-2` / `--fs-hero-3` — a flat 118px headline wraps to three lines in a narrow column and eats whatever sits under it. Fixed-size paper does not get `--collapse`: a 672×950 sheet is supposed to stay 672×950.

One tilted element per view was the old rule and it is now the opposite: tilt is the default and `0°` is the exception. What stays scarce is **prominence** — one piece per pile above `--z:40`.

## Iconography

- **Font Awesome only.** Every page and card in this project loads two lines, in this order:

  ```html
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer">
  <script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
  ```

  **Substitution flag — read this.** Kit `559791bdc6` loads and reports itself as a Pro SVG+JS kit, but in this environment it performs no icon replacement: `<i class="fa-*">` elements stay zero-size and empty, and the kit's `.css` (webfont) endpoint returns nothing usable. So the **Font Awesome 6.7.2 Free webfont CSS is the layer actually rendering glyphs**, with the kit script kept after it so that SVG mode takes over wherever the kit does work. Two consequences while the kit is inert: Pro-only glyphs are unavailable, and `fa-regular` only resolves for the ~160 icons in the free regular set (which is why `guidelines/brand-iconography.html` demonstrates the regular register with free-set glyphs). **If Pro icons are needed, check the kit's domain allowlist and subsetting settings — once it replaces icons, both lines can stay as they are and nothing else needs to change.**
- Use the `Icon` component (`components/core/Icon.jsx`) rather than raw `<i>` tags in React: `<Icon name="bolt" />`.
- **Solid (`fa-solid`) is the default** — actions, toolbars, HUD, status. **Regular (`fa-regular`)** for decorative rows and lighter editorial use. **Brands (`fa-brands`)** for social links. Duotone, light and thin are available through the kit but are not part of the brand's normal register.
- Icons inherit `font-size` and `currentColor` and sit on the text baseline. In buttons they are 1em with a 10px gap; in HUD slots they run at `--fs-title-2`.
- **No emoji. No hand-drawn SVG. No second icon set. No PNG icons.** If a glyph does not exist in Font Awesome, use a mono character or a text label — the system prefers a word to an invented picture.
- Unicode is used for three specific glyphs, deliberately: `·` metadata separator, `✱` marquee separator, `▶` dialogue advance caret.
- `assets/` contains no icon binaries because the icon set is served from the kit CDN and no source icons were supplied.

## Assets

`assets/` ships the supplied artwork, downscaled for the web:

| Folder | Contents |
| --- | --- |
| `assets/fonts/` | `Anegra.woff2`, `BankySans.otf` — the two local faces |
| `assets/patterns/` | `tile-houndstooth.svg`, `tile-chevron.svg`, `tile-blade.svg` — seamless mask originals |
| `assets/marks/` | `orn-01` … `orn-16.svg` — line ornament mask originals |
| `assets/panels/` | thirteen op-art plates, 900×900 PNG |
| `assets/grounds/` | `geo-01` … `geo-06.jpg` (1500px collage sheets), `mist-01` / `mist-02.jpg` (900px pastel grounds) |
| `assets/photos/` | seven photographs, 1200px long edge |

No logo binary was supplied, so none was invented — the wordmark is type. No icon binaries ship; icons come from the Font Awesome kit.

The plates, backdrops and photographs are **fixed artwork** and do not follow the scheme. Only the tiles and ornaments are theme-aware, because they ship as masks.

## Fonts

**Anegra** (display) and **Banky Sans** (text) are the supplied faces and ship as local files, declared in `tokens/fonts.css`. **Space Mono** (mono) is the one substitution, loaded from the Google Fonts CDN for labels and readouts, because no monospace face was supplied and the system needs tabular alignment for HUD readouts, folios and tables. Both local faces are single-weight — see the Type section for what that means in practice. **If a brand mono exists, send the file and `--font-mono` repoints in one line.**

## Index

Root:

| File | What it is |
| --- | --- |
| `styles.css` | Global entry — `@import` list only. This is the file consumers link. |
| `readme.md` | This document. |
| `SKILL.md` | Agent-skill front matter for use outside this project. |
| `thumbnail.html` | Homepage tile for the design system. |
| `tokens/` | `fonts.css`, `colors.css`, `typography.css`, `spacing.css`, `shape.css`, `motion.css`, `masks.css`, `texture.css`, `base.css` |
| `patterns/` | `layout.css`, `collage.css`, `controls.css`, `forms.css`, `surfaces.css`, `nav.css`, `feedback.css`, `media.css`, `window.css`, `game.css`, `print.css` — the class layer behind the components, usable from plain HTML |
| `guidelines/` | Foundation specimen cards (Colors, Type, Spacing, Shape, Motion, Brand) |
| `assets/` | Fonts, mask originals, plates, backdrops, photographs |
| `components/` | React primitives, grouped by concern |
| `ui_kits/` | Five full product recreations |
| `templates/` | Three copyable starting folders for consuming projects |

### Components

Every component is `<Name>.jsx` + `<Name>.d.ts` + `<Name>.prompt.md`, exported on `window.MaximalistDesignSystem_2f2ec1`.

- **`components/core/`** — `Button`, `IconButton`, `Icon`, `Badge`, `Tag`, `Sticker`, `Marquee`, `Rule`, `KeyCap`
- **`components/forms/`** — `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`
- **`components/surfaces/`** — `Card`, `Panel`, `Dialog`, `Accordion`, `Table`, `StatBlock`
- **`components/navigation/`** — `NavBar`, `Tabs`, `Breadcrumbs`, `Pagination`, `SideNav`, `Menu`
- **`components/feedback/`** — `Alert`, `Toast`, `ProgressBar`, `Spinner`, `Tooltip`
- **`components/media/`** — `Avatar`, `ImageFrame`, `TextureBlock`
- **`components/collage/`** — `Pile`, `Piece`, `Plaque`, `Plate`, `Cutout`, `Backdrop`, `Mark`, `Strip`
- **`components/window/`** — `WindowFrame` (macOS / Windows / Linux dialects; window, dialog, palette and inactive types)
- **`components/mobile/`** — `PhoneFrame`, `TabBar` (iOS and Android dialects)
- **`components/game/`** — `Meter`, `ActionSlot`, `DialogueBox`, `ScorePlate`
- **`components/theming/`** — `ThemeSwitcher` (plus the `MAXIMALIST_THEMES` export)

#### Intentional additions

No source defined a component inventory, so the whole set is authored. Three entries are worth calling out because they exist for this brand specifically rather than out of convention:

- `Icon` — a thin Font Awesome wrapper, so no screen ever hand-rolls an SVG.
- `TextureBlock` / `ImageFrame` — the CSS pattern field and the stated placeholder, kept for cases where no source artwork fits.
- `Pile` / `Piece` / `Plaque` — the collage layer as components. `Plaque` is the load-bearing one: it is what makes it legal to put copy over artwork, and it carries its own `--on-*` foreground so the copy stays at 4.5:1.
- `Plate` / `Cutout` / `Backdrop` / `Mark` — the four ways the source artwork enters a layout. They resolve their own file paths from the URL of `_ds_bundle.js`, so they work at any page depth without configuration; override with `data-mx-assets` on `<html>` if the bundle is loaded from somewhere unusual.
- `Sticker`, `Marquee`, `KeyCap` — the loud small elements the reference material relies on, promoted to real components so they stay consistent.
- `ThemeSwitcher` — a demo-only control for specimens and preview harnesses. Do not ship it inside a product UI.

### UI kits

| Kit | Surfaces |
| --- | --- |
| `ui_kits/web/` | Studio marketing site: hero, work grid, shop with filters, long-form article, booking form |
| `ui_kits/desktop/` | One app in macOS, Windows and Linux chrome, plus dialog, palette and inactive windows |
| `ui_kits/mobile/` | One shopping app in iOS and Android dialects: feed, product, profile |
| `ui_kits/game/` | Title screen, in-game HUD, inventory grid, settings |
| `ui_kits/print/` | A2 gig poster, A4 magazine spread, two-sided A5 flier |

Each kit has its own `README.md` and an interactive `index.html`; all five carry a live colour-scheme switcher so any of the twelve palettes can be previewed against a real interface.

### Templates

Starting folders a consuming project can copy. Each is a single editable file plus a `ds-base.js` that points at this system.

| Template | What it is |
| --- | --- |
| `templates/poster/Poster.dc.html` | A2 event poster — masthead, burst sticker, texture band, line-up, ticker, folio |
| `templates/landing-page/LandingPage.dc.html` | Full marketing page — nav, poster hero, ticker, work cards, ink stats band, form, footer |
| `templates/app-dashboard/AppDashboard.dc.html` | App shell — side nav, toolbar, stat row, queue table, coverage meters, alerts |

### Colour-scheme previews

The switching examples live outside the product UIs, as required: `components/theming/theming.card.html` (live switcher across real components), `guidelines/color-all-schemes.html` (all twelve ramps), `guidelines/color-scheme-gallery.html` (all twelve rendered simultaneously), and the switcher strip at the top of each UI kit.

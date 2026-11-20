# Maximalist — design system

**Maximalist** is a loud, print-derived design language for screens, paper and games. It is built for products that want to be seen from across the room: flat saturated colour, heavy display type, ink borders on everything, hard offset shadows with no blur, halftone and checker textures instead of stock photography, and stickers and tickers doing work that a subtle badge used to do badly.

It is not a mood board. Every decision below is a token, a class or a component, and the same set drives five surfaces: web pages, desktop apps, mobile apps, game UI and print layout.

## Where this came from

- **Source material:** a set of maximalist graphic-design reference images supplied by the user (posters, magazine covers, risograph work, two agency websites, editorial spreads). They live in `uploads/` and were used as *aesthetic* reference only.
- **No brand was cloned.** There was no codebase, no Figma file, no component inventory, no logo, no copy and no font binaries in the sources. Nothing identifying any referenced studio, publication, artist or agency appears anywhere in this system. Names, colours, type, copy and component inventory are all original to this project.
- **Because no source defined a component inventory,** the component set below is an authored standard set, sized to the five target surfaces.
- **No logo exists.** No mark was supplied, so none was drawn. Wherever a logo would go, the brand name is set in the display face — see `guidelines/brand-wordmark.html` for the sanctioned lockups.

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

**Colour.** Twelve complete schemes ship as `[data-theme]` scopes in `tokens/colors.css`; `sunbaked` is the default. Each scheme declares its source ramp verbatim (`--p-1` … `--p-n`) plus a full semantic layer: `--ink`, `--paper`, `--surface`, `--surface-2`, `--text`, `--text-soft`, four accents with paired `--on-accent*` foregrounds, and `--ok` / `--warn` / `--danger` / `--info`. Two schemes (`midnight-gold`, `acid-fern`) are dark: paper goes dark and ink becomes the bright line colour, which is why nothing hard-codes black.

**The pair rule, and it is not optional:** never put `--text`, `--ink` or `--paper` directly on a fill colour — use that fill's `--on-*` token. Eight fills (`--accent` … `--accent-4`, `--ok`, `--warn`, `--danger`, `--info`) each ship a paired `--on-*` foreground, and all 104 pairs across the twelve schemes are computed to clear WCAG 4.5:1 — measured minimum 4.51 — so 11px badge and label text stays legible everywhere. About half the pairs resolve to `var(--ink)` or `var(--paper)`; where neither brand token could clear 4.5:1 against a mid-value hue, the pair falls back to a near-black or white literal. One source hue was darkened to make a pair possible (`lagoon --danger #d64545 → #d43d3d`); the raw `--p-*` ramp is untouched and stays verbatim. Change a fill and you must recompute its partner. Maximum two background colours per composition; the rest of the noise comes from accents, textures and type.

**Type.** Four families with strict jobs (`tokens/typography.css`):

| Role | Family | Used for |
| --- | --- | --- |
| `--font-display` | Bowlby One | Posters, heroes, big numbers, stat values, game titles |
| `--font-accent` | Shrikhand | Stickers, pull quotes, one-word interruptions |
| `--font-text` | Figtree | All UI, headings, body copy |
| `--font-mono` | Space Mono | Labels, kickers, metadata, data readouts, folios |

Scale runs 9 → 118px on a 1.333 ratio, rounded to whole pixels and never snapped to a 4px grid. Display leading is 0.86 with -0.03em tracking; body is 1.55 at 15px, measured to 66ch. Display treatments are offset shadow, two-colour stack, ink outline and knockout band — see `guidelines/type-treatments.html`.

**Spacing.** Base **5px**. The odd base is deliberate — the measurements come from the sheet, not from a framework default. Ramp: 5 / 10 / 15 / 20 / 30 / 45 / 65 / 90 / 130 / 180. Control heights 32 / 44 / 56 with 11×17px default padding. Minimum hit target 44px everywhere, including game HUD.

**Backgrounds.** Never a photograph by default and never a gradient. The background layer is either flat `--paper`, a flat accent block, or one of five pure-CSS patterns — halftone dots, diagonal stripe, checkerboard, grid, zigzag (`tokens/texture.css`). Full-bleed bands separated by 9px brick borders are the standard page rhythm. When a real photograph is used it goes in an `ImageFrame`: hard crop, 5px ink border, optional duotone (greyscale + accent multiplied at 62%). Imagery reads warm, high-contrast and slightly overinked; no cool desaturated stock look, no soft focus.

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

**Layout rules.** `.mx-page` is 1240px max with a 30px gutter; long-form narrows to 820px. Grids are auto-fit `minmax(0,1fr)` so everything reflows. Sticky elements: nav bar, filter rails and article sidebars only. Rotation is reserved for stickers, one card per view, and the occasional image frame; rotation angles are tokens (`--tilt-a/b/c`) so they stay consistent.

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

`assets/` is intentionally near-empty. No logo, illustration, photograph or icon binary was present in the supplied sources, so none was invented. Where the system needs a visual field it uses a CSS texture (`TextureBlock`) and where it needs a photograph it uses a stated placeholder (`ImageFrame` with no `src`, or `.mx-placeholder`). Substitute real imagery by dropping files in and passing `src`.

## Fonts — substitution flag

**All four families are Google Fonts substitutions.** No font binaries were supplied, so faces were chosen to match the reference material's register: a chunky rounded poster grotesque (Bowlby One), a fat display serif for sticker voice (Shrikhand), a neutral variable UI sans (Figtree) and a plain typewriter mono (Space Mono). They are loaded from the Google Fonts CDN in `tokens/fonts.css`; no local files ship. **If there are real brand faces, send the files and the four `--font-*` tokens can be repointed in one file.**

## Index

Root:

| File | What it is |
| --- | --- |
| `styles.css` | Global entry — `@import` list only. This is the file consumers link. |
| `readme.md` | This document. |
| `SKILL.md` | Agent-skill front matter for use outside this project. |
| `thumbnail.html` | Homepage tile for the design system. |
| `tokens/` | `fonts.css`, `colors.css`, `typography.css`, `spacing.css`, `shape.css`, `motion.css`, `texture.css`, `base.css` |
| `patterns/` | `layout.css`, `controls.css`, `forms.css`, `surfaces.css`, `nav.css`, `feedback.css`, `media.css`, `window.css`, `game.css`, `print.css` — the class layer behind the components, usable from plain HTML |
| `guidelines/` | 23 foundation specimen cards (Colors, Type, Spacing, Shape, Motion, Brand) |
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
- **`components/window/`** — `WindowFrame` (macOS / Windows / Linux dialects; window, dialog, palette and inactive types)
- **`components/mobile/`** — `PhoneFrame`, `TabBar` (iOS and Android dialects)
- **`components/game/`** — `Meter`, `ActionSlot`, `DialogueBox`, `ScorePlate`
- **`components/theming/`** — `ThemeSwitcher` (plus the `MAXIMALIST_THEMES` export)

#### Intentional additions

No source defined a component inventory, so the whole set is authored. Three entries are worth calling out because they exist for this brand specifically rather than out of convention:

- `Icon` — a thin Font Awesome wrapper, so no screen ever hand-rolls an SVG.
- `TextureBlock` / `ImageFrame` — the brand's answer to stock imagery; a pattern fill or a stated placeholder instead of invented artwork.
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

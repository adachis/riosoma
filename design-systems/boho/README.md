# Boho — Design System

Boho is an earthy, hand-made design language for products that want to feel slow, warm and
made by a person. It takes its shapes from bohemian folk art — doorway arches, suns and
moons, waves, woven patterns, open hands — and applies them to five very different surfaces
without softening into decoration.

The system is deliberately surface-agnostic. The same arch radius that crops a product
photograph on the web crops an item slot in a game HUD. The same letterspaced label caps
that head a table column head a poster. **Nothing in here is specific to one product, one
industry, or one platform.**

## What this is built from

This is an original design system built *in the spirit of* the references supplied, not a
copy of any of them. No supplied image, logo, brand name or copy appears in the system. The
demo brand throughout the UI kits (`Wanderweave`, `Atelier`, `The Loom House`, and their
people) is invented for the purpose of showing the system in use.

| Source | What it gave us |
| --- | --- |
| `Bohemian Assets/` (attached local folder) | The entire visual vocabulary: arch vignettes, flat PNG ornaments, hand-drawn SVG line art, seamless patterns, and six retail typefaces |
| `uploads/*.jpg|png|webp|avif` (18 reference images) | Mood and layout reference for the earth palette, arch-and-rainbow motifs, and the letterspaced-caps + display-serif + script pairing |
| Font Awesome kit `559791bdc6` | The icon system |
| coolors.co palettes (12 URLs supplied in the brief) | The twelve alternate colour schemes in `tokens/palettes.css` |

There was **no codebase, Figma file or existing component library** in the sources — the
assets are a raw art pack. The component inventory below is therefore an authored standard
set sized to the five target surfaces, not a recreation of an existing library.

### No logo was supplied
The sources contain no brand mark, so **none was drawn**. Wherever a logo would go, the
system sets the name in the display face as plain type (see `guidelines/brand-wordmark.html`).
If you have a real mark, drop it at `assets/logo.svg` and swap the wordmark blocks in the
UI kits.

### Fonts — what shipped and what was substituted
Five of the six faces are the real retail files from the asset pack, copied into
`assets/fonts/` and declared in `tokens/fonts.css`:

| Role | Token | File | Source |
| --- | --- | --- | --- |
| Display | `--font-display` | `warna.otf` | Warna (asset pack) |
| Editorial serif | `--font-editorial` | `malgods-bohemian.ttf` | Malgods Bohemian (asset pack) |
| Script accent | `--font-script` | `bohemy-script.otf` | Bohemy Font Duo (asset pack) |
| Label caps | `--font-label` | `bohemy-sans.otf` | Bohemy Font Duo (asset pack) |
| Poster alt | `--font-poster` | `la-sierra.woff2` | la Sierra (asset pack) |
| UI sans | `--font-sans` | Google Fonts | **Substitution — Figtree** |
| Text serif | `--font-serif` | Google Fonts | **Substitution — Spectral** |
| Mono | `--font-mono` | Google Fonts | **Substitution — JetBrains Mono** |

> **Flagged substitutions.** The asset pack's faces are single-weight display faces — none of
> them can carry interface body copy, long-form print copy or tabular figures. Three Google
> families were added for those roles: **Figtree** (UI text, 300–900), **Spectral** (long-form
> and print body), **JetBrains Mono** (figures and hotkeys). If you own licensed text families
> you'd rather use, drop the files in `assets/fonts/` and change three lines in
> `tokens/fonts.css` — nothing else references the families directly.
> Also note the retail faces ship as `.otf`/`.ttf`, not `.woff2`. Only la Sierra had a web
> build. Subsetting the other five to woff2 before production would cut a lot of weight.

---

## CONTENT FUNDAMENTALS

**The voice is a maker describing their own work, plainly.** It states what a thing is, how
it was made, and what will happen next. It never sells, never exclaims, and never explains
its own significance.

**Casing carries most of the tone.**
- **Labels, buttons, nav, eyebrows, table heads, folios: UPPERCASE, letterspaced.** Write
  them in sentence case in code and let the component uppercase them — `Shop the collection`,
  not `SHOP THE COLLECTION`.
- **Headlines: sentence case.** "Objects for a slower home." Not title case, except on printed
  covers and posters where Title Case Is Used For The Display Lock-Up.
- **Body copy: sentence case, ordinary punctuation.**
- **Script accents: lowercase, always.** `let's explore`, `slow post`, `come and see`.

**Person.** Second person for anything the reader does ("your basket", "we will hold it for
48 hours"). First person plural for the studio. Never first person singular, and never the
imperative-with-exclamation ("Shop now!").

**Length.** Eyebrows 2–4 words. Headlines under 8 words. Body paragraphs 2–4 sentences.
Button labels 1–3 words, except the one primary CTA per screen which may run to four.

**Specifics over adjectives.** The voice earns warmth with facts, not modifiers.
- Yes: "Nothing is produced in a run larger than forty."
- Yes: "Posted twice a week from the studio."
- Yes: "Hand wash cool. Food safe, not dishwasher safe."
- No: "Beautifully crafted premium artisan homeware."
- No: "Discover our stunning new collection!"

**Numbers are literal and unrounded.** `$74.00`, `4 / 9`, `72 / 100`, `No. 04`, `week 34`.
They set in the mono face so they line up. Never "hundreds of makers" when the number is 120.

**Empty and error states apologise for nothing and tell you the next move.**
"Nothing saved yet — tap the heart on anything you love and it will wait here."
"That address looks incomplete."

**Emoji: never.** Not in UI, not in copy, not in marketing. The ornament and icon sets do
that job. Unicode glyphs are used only as typographic marks — `/` in breadcrumbs, `·` as a
meta separator, `+` on accordions, `›` on list rows, `✕` on dismiss, `↵` on hotkeys.

**Vibe, in one line:** a hand-written parcel label, set properly.

---

## VISUAL FOUNDATIONS

### Colour
The default palette is **clay and sage on linen**: a warm cream page (`#F7F1E8`), terracotta
primary (`#A76141`), sage secondary (`#7C8C6F`), ochre tertiary (`#D9A05B`), and a
brown-black ink (`#2E2A26`). The semantic `--brand-primary` is a step darker than the
`--clay-500` ramp swatch it comes from: a mid-tone terracotta fails 4.5:1 against *both* a
light and a dark label ink, so the accent — not the ink — has to move. There is no pure white and no pure black anywhere in the
system — the lightest surface is `#FFFBF5` and the darkest ink is `#1C1916`. Greys are
warm; every neutral has red in it.

**Every palette is contrast-derived.** `--text-muted` clears 4.5:1 against all four light
surfaces in its palette, `--brand-primary` clears 4.5:1 against its own
`--text-on-accent` — which is why some palettes carry a dark on-accent ink (`desert`,
`candy`, `peach`, `saffron`, `lagoon`, `spectrum`) and some a light one — and
`--text-link` clears 4.5:1 against `--surface-page`, so it is sometimes a step darker
than the accent. Re-tune those four together or not at all.

Colour is used **sparingly and structurally**: one accent per view for the primary action,
tint grounds for section bands, and status colour only where status exists. Large fields of
saturated colour appear in exactly three places — the accent hero band, the inverse
footer/CTA band, and printed covers/posters. Maximum two background colours per page.

**Thirteen palettes.** Every semantic token is redefined under `[data-palette="…"]`, so
setting one attribute re-skins a whole tree:

```html
<html data-palette="desert">
```

`clay` (default) · `spectrum` · `midnight` · `electric` · `coastal` · `peach` · `desert` ·
`lagoon` · `fern` · `candy` · `reef` · `saffron` · `eucalyptus`

`midnight` is a dark theme (near-black page, gold accent); the rest are light. Where a
supplied palette had no sensible positive/critical/info hue, those four status tokens were
derived in oklch to sit harmoniously with the palette rather than borrowed from another one.
See `guidelines/color-switcher.html` for a live switcher and `guidelines/color-palettes.html`
for all thirteen at once. The palette selector at the bottom-left of every UI kit is preview
chrome (`ui_kits/palette-bar.js`) — it is never part of a product UI.

### Type
Six roles, and each has exactly one job:
- **Display (Warna)** — h1/h2, hero and poster headlines, stat figures, wordmarks. High
  contrast, slightly irregular. `-0.015em` tracking; line-height `1.04` at hero size.
- **Editorial serif (Malgods Bohemian)** — h3/h4, card titles, accordion headers, pull
  quotes. Lighter and quieter than the display face.
- **UI sans (Figtree)** — all interface and body copy, 13–19px, weights 300–700.
- **Text serif (Spectral)** — long-form article body, print body, and game dialogue. This is
  the only body serif and it never appears in interface chrome.
- **Label caps (Bohemy Sans)** — every uppercase micro-label at 9–13px with `0.16em`
  tracking (`0.28em` for the widest interstitials).
- **Mono (JetBrains Mono)** — figures, prices, counts, hotkeys, token names. Never prose.
- **Script (Bohemy Script)** — one accent per screen, always above the headline, always
  lowercase, never in a control.

Minimums: 13px UI captions, 15px UI body, 7pt print, 24px on 1920×1080 slide-scale artwork.

### Space and layout
Scale: `4 · 8 · 12 · 18 · 26 · 36 · 52 · 72 · 104 · 144`. Card padding is `--sp-5` (26px),
label-to-title gap `--sp-2`, between cards `--gutter-md` (36px), page bands
`--section-y-md` (104px). Containers 640 / 920 / 1180 / 1440. Text never runs wider than
`64ch`.

Layout is **generous and asymmetric**. Web pages are bands stacked full-width, alternating
page / tint / inverse grounds, with the content inside a centred container. Hero and feature
sections are split roughly 1 : 0.9, never 50/50. Only two things are ever fixed: the sticky
top nav (web) and the sticky buy bar / tab bar (mobile). Everything else scrolls.

### Backgrounds, imagery and texture
- **Flat vector art, not photography.** The imagery set is arch vignettes, flat PNG
  ornaments, and hand-drawn SVG line art. Colour vibe is warm, matte and low-contrast —
  terracotta, ochre, cream and near-black on a sand ground. No cool tones, no glossy
  highlights, no drop-shadowed objects.
- **Full-bleed is reserved for pattern.** Seamless woven tiles appear as the ground of
  printed covers (`--pattern-opacity-print`, 10%, over a tint), as a
  `--pattern-opacity-veil` (10%) overlay on game scenes, and via `Panel pattern` /
  `PrintSheet bleedPattern` on app and print surfaces. Never behind body copy at full
  strength.
  **Tiles are passed as an explicit path, never through a token.** A relative `url()`
  inside a CSS custom property resolves against the *document*, not the declaring
  stylesheet, so a `--pattern-*` url token silently 404s at every directory depth but one.
  Write `background-image:url(<your relative path>/assets/patterns/seamless-01.jpg)` and
  take `background-size` / `background-blend-mode` / opacity from
  `--pattern-tile-sm|md|lg`, `--pattern-blend`, `--pattern-opacity-veil|print`.
  The supplied seamless JPGs are **dark-ground** tiles (`seamless-01` averages ~`#60595c`),
  which is why both opacity tokens sit at 10% — enough to read as texture, low enough to
  keep body ink above 4.5:1 on a cream ground. If you add a lighter tile, re-derive the
  opacity from its mean luminance rather than reusing these values.
- **A very fine warm grain** (`--grain`, 2% at 115°) sits on desk/scene grounds. It is
  texture, not noise — invisible until you look for it.
- **No aggressive gradients.** The only gradients in the system are (a) `--wash-warm`, a
  page-to-sunken vertical wash, (b) the game-scene ground, (c) the two protection gradients.
  There is no purple, no blue-violet, and no gradient on a button, ever.

### Shape and corners
Radii: `3 · 6 · 10 · 18 · 28 · 44 · pill`. Controls are pills; cards and panels are 18px;
dialogs 28px; inputs, checks and small chrome 6–10px.

The **signature silhouettes** are what make something look like Boho:
`--r-arch-soft` (a soft doorway, 180px top corners) · `--r-dome` (half-round top, flat base)
· `--r-arch-plate` (22px arch for game plates) · `--r-leaf` · `--r-lozenge` · `--r-blob`.
Featured imagery is arched by default; a plain rectangle is the exception. Never nest two
arches directly.

### Borders and cards
A card is **hairline-bordered paper**: `1px solid var(--line-hairline)` on
`var(--surface-raised)`, `--r-lg`, and `--shadow-1` — a shadow so soft it reads as a paper
edge rather than elevation. Border weights: 1px hairline (dividers, cards, inputs), 1.5px
medium (secondary buttons, checks, radios), 2px thick (active tab underline, game plates),
3px frame (the accent art frame). Tables have horizontal rules only — never vertical ones.
Dotted 1.5px rules are used for decorative interstitials.

### Shadow and inset
Four outer steps, all tinted to bark (`rgba(46,42,38,…)`) and all with negative spread so
they stay tight: `--shadow-1` (rest), `-2` (hover), `-3` (floating panels, arch frames),
`-4` (modals, windows). Two inner treatments do real work: `--shadow-inset-top` (a 55%
white 1px highlight that makes inputs read as pressed into the paper — do not remove it) and
`--shadow-inset-well` (slider and progress tracks). `--shadow-press` replaces the outer
shadow on active press.

Protection gradients (`--protect-top`, `--protect-bottom`) are used for text over imagery
and game scenes. Capsules — a pill of `--surface-raised` behind the text — are preferred
whenever the text is short (a badge, a count, a label). Rule of thumb: **capsule for a word,
gradient for a sentence.**

### Transparency and blur
Blur is rare and load-bearing. It appears in exactly four places: `NavBar tone="veil"`,
`Panel tone="veil"`, the iOS `TabBar`, and the mobile sticky buy bar — plus the game
`DialogueBox` and `ObjectivePanel`, which float over a scene. Everything blurred is a
`color-mix` of a real surface token at 72–90%, never a raw `rgba` white. Elsewhere, alpha
is only used for hairlines and ornament opacity. **Body text is never set on a
partially-transparent colour** — contrast is measured against the real ground.

### Animation
Small, soft and short. `--ease-soft` (`cubic-bezier(.32,.72,.24,1)`) is the default for
colour and shadow at 140–220ms. `--ease-out` for panels and progress at 220–380ms.
`--ease-settle` — a slight overshoot — is used for exactly one thing: the switch knob.
There are no bounces, no spring cards, no scroll-triggered reveals, no parallax. The only
looping animation in the system is the `Spinner` ring (720ms linear). Everything collapses
to 0ms under `prefers-reduced-motion`.

### Interaction states
- **Hover.** Filled controls darken one step (`--brand-primary-hover`) and gain
  `--shadow-2` plus `translateY(-1px)`. Outline controls swap their border to the accent.
  Ghost controls take an `--surface-accent-soft` ground. Cards lift 3px and their media
  scales to 1.03 over 380ms. Links move to `--text-link-hover` and their underline goes to
  full opacity. Never opacity-fade a control on hover.
- **Press.** `scale(.985)` plus `translateY(0)` and `--shadow-press` — the control sinks
  into the paper. Game plates translate +1px instead of scaling.
- **Focus.** `--ring-focus`: a 2px page-coloured gap then a 4px 70% accent ring. Always
  visible, never removed.
- **Selected.** A filled accent pill (tags, pagination) or a raised paper chip
  (`SideNav`, pill tabs) — never a coloured left border.
- **Disabled.** 45% opacity and `not-allowed`. No greyscale filter.

### Anti-patterns
No emoji. No purple or blue-violet gradients. No cards with a coloured left border. No pure
black or white. No neutral-grey shadows. No hand-drawn SVG substituted for a real icon or
illustration — copy from `assets/`. No title-case interface labels. No exclamation marks.

---

## ICONOGRAPHY

**One system: Font Awesome**, via the supplied kit. Load it once per page:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Use the `Icon` component rather than raw `<i>` tags:

```jsx
<Icon name="feather" size="20px" />
<Icon name="moon" label="Night mode" />
```

- **Default style is `solid`** — it is the only style guaranteed in a free kit. With a Pro
  kit, prefer `light` or `thin` for large decorative glyphs and `regular` for body-scale UI;
  the component takes `variant="solid|regular|light|thin|duotone|brands|sharp"`.
- **There is no icon font or SVG sprite bundled with this system** and none existed in the
  sources. Nothing is copied in; the kit is the source of truth.
- **Preview fallback.** Every card and UI kit page in this project also links the Font
  Awesome 6.7.2 CDN stylesheet. This is because the supplied kit renders via runtime SVG
  fetches that the preview sandbox blocks — the CDN webfont keeps the specimens legible.
  In your own product, the kit script alone is enough; drop the CDN link.
- **Sizes:** 14px (dense rows, badges), 18px (list rows, form affordances), 22px (toolbars,
  tab bars), 30px+ (decorative, usually tinted `--brand-primary`).
- Icons inherit `currentColor`. Decorative glyphs may take `--brand-primary`; functional
  glyphs stay in body ink.
- **Emoji are never used as icons.** Unicode marks are used only as typographic punctuation
  (`/`, `·`, `+`, `›`, `✕`, `↵`, `▼`, `◆`).
- **Ornaments are not icons.** `assets/elements/*.png` (suns, moons, hands, rainbows,
  spirals, macramé) and `assets/illustrations/*.svg` (line art and colour vignettes) are
  decorative art. Use them in empty states, dividers, print, and inventory slots — never as
  a button glyph.

---

## Index

### Root
| File | What it is |
| --- | --- |
| `styles.css` | Global entry point. `@import` list only — link this one file |
| `readme.md` | This document |
| `SKILL.md` | Agent-skill front matter for use outside this project |
| `thumbnail.html` | Homepage tile |
| `_dev_preview_shim.js` | Preview-only fallback that loads component sources when `_ds_bundle.js` has not been compiled yet. Harmless in production; delete if you don't want it |

### `tokens/`
`fonts.css` (`@font-face` + family tokens) · `colors.css` (base earth ramps) ·
`palettes.css` (13 palettes × 30 semantic tokens) · `typography.css` · `spacing.css` ·
`radii.css` · `elevation.css` · `motion.css` · `texture.css` (pattern sizing, grain, washes) ·
`base.css` (element defaults and two utility classes)

### `assets/`
`fonts/` (6 retail faces) · `arches/` (8 arch vignettes, PNG) · `elements/` (24 flat
ornaments, PNG) · `illustrations/` (22 SVG line-art and colour vignettes) ·
`patterns/` (6 seamless tiles)

### `components/` — 47 components in 9 groups
| Group | Components |
| --- | --- |
| `core/` | Button · IconButton · Icon · Badge · Tag · Avatar · Divider · ArchFrame |
| `forms/` | FormField · Input · Textarea · Select · Checkbox · Radio · Switch · Slider |
| `layout/` | Card · Panel · Hero · Stat |
| `navigation/` | NavBar · SideNav · Tabs · Breadcrumbs · Pagination · TabBar |
| `feedback/` | Alert · Toast · Tooltip · Dialog · ProgressBar · Spinner · EmptyState |
| `data/` | Table · ListRow · Accordion |
| `chrome/` | MacWindow · WindowsWindow · LinuxWindow · PhoneFrame |
| `game/` | GameButton · ResourceBar · InventorySlot · DialogueBox · ObjectivePanel |
| `print/` | PrintSheet · PullQuote |

Each component ships `<Name>.jsx`, `<Name>.d.ts` (props contract) and `<Name>.prompt.md`
(what & when, usage example, variants). Each directory has one `@dsCard` HTML showing its
states.

**Intentional additions** — components with no counterpart in the sources, added because the
brief named five target surfaces:
- `Icon` — a wrapper over the Font Awesome kit, so glyph style and sizing stay consistent.
- `ArchFrame` — the system's signature silhouette needed a component, or every consumer
  would re-derive the radius by hand.
- `MacWindow` / `WindowsWindow` / `LinuxWindow` / `PhoneFrame` — the brief asks for desktop
  window chrome on three platforms and both mobile platforms.
- `GameButton` / `ResourceBar` / `InventorySlot` / `DialogueBox` / `ObjectivePanel` — the
  brief asks for game UI in this design language.
- `PrintSheet` / `PullQuote` — the brief asks for print design and layout.

### `ui_kits/` — five surfaces
| Kit | What it shows |
| --- | --- |
| `web/` | Wanderweave marketplace: home, product, journal, basket. Click-through |
| `desktop/` | Atelier studio app inside macOS / Windows 11 / GNOME chrome, switchable |
| `mobile/` | The app on iOS and Android side by side: shop, piece, profile |
| `game/` | The Loom House: title menu, HUD with dialogue, satchel screen |
| `print/` | Catalogue cover, editorial spread, poster, stationery sheet |

**Grounds come from the four semantic surfaces only.** `--surface-page` / `-raised` /
`-sunken` / `-accent-soft` are the grounds `--text-muted` and the ink tokens are
contrast-validated against. The base ramps in `tokens/colors.css` (`--linen-*`, `--bark-*`,
`--stone-*`, `--clay-*`) exist to *derive* palettes and to fill the ramp specimen cards —
using one as a page or panel background puts text on a ground outside the measured
contract.

Each has its own `README.md`. `ui_kits/palette-bar.js` is the shared preview-only palette
selector.

### `templates/` — five starting folders
Consuming projects see these in the template picker. Each is a Design Component
(`<Slug>.dc.html`) plus a `ds-base.js` that loads this system — change one line in
`ds-base.js` to point at the bound design-system folder.

| Template | Starting point for |
| --- | --- |
| `web-page/WebPage.dc.html` | Marketing/landing page: veil nav, arch hero, product grid, editorial band, inverse CTA, footer |
| `desktop-app/DesktopApp.dc.html` | Desktop app in macOS chrome: sidebar rail, toolbar, stat row, data table |
| `mobile-app/MobileApp.dc.html` | iOS screen: feed header, filter chips, arch feature, two-up grid, tab bar |
| `game-ui/GameUi.dc.html` | 1280×720 HUD: resource bars, objective tracker, dialogue plate, hotbar |
| `print-layout/PrintLayout.dc.html` | A4 editorial page: running head, two-column serif body, pull quote, three-up row, folio |

### `guidelines/` — 29 specimen cards
Colours (7, including the live palette switcher) · Type (7) · Spacing (3) · Shape (3) ·
Elevation (2) · Motion (1) · Brand (5) · Iconography (1).

## Using the system

```html
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
<script src="_ds_bundle.js"></script>
<script>const { Button, Card, ArchFrame } = window.BohoDesignSystem_5da2b1;</script>
```

Then set a palette on the root if you want anything other than `clay`:
`<html data-palette="coastal">`.

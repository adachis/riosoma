# Brutalist — design system

A general-purpose design system built on the graphic language of web and print **brutalism**: enormous condensed capitals, a three-colour palette, drawn rules instead of shadows, zero corner radius, and photography crushed to two or three tones. It is deliberately not neubrutalism — there are no offset "sticker" shadows, no thick candy-coloured outlines on pastel cards, no playful rounded blocks. See [Non-goals](#non-goals).

It is a *style* system rather than a company system: there is no client brand behind it. Anything that needs a name uses the placeholder studio **Substrate** and the exhibition **Load Bearing** so the UI kits read as real products.

## Surfaces this system covers

| Surface | Kit |
| --- | --- |
| Websites and web apps | `ui_kits/web/` |
| Desktop apps — macOS, Windows, Linux chrome | `ui_kits/desktop/` |
| Mobile apps — iOS and Android | `ui_kits/mobile/` |
| Video game UI — title, HUD, loadout, pause | `ui_kits/game/` |
| Print design and layout — posters, editorial spreads | `ui_kits/print/` |

## Sources supplied for this build

- **Attached asset library** (read-only mount): `Brutalism Assets/` — a purchased library of brutalist fonts, vector packs, seamless patterns, halftone textures and streetwear/poster templates. Fonts, three seamless geometric patterns, six grain/halftone texture plates, and twenty-four structural glyph SVGs were copied into `assets/`.
- **Reference articles** given as style direction:
  - `https://www.mockplus.com/blog/post/brutalism-web-design-examples-and-templates`
  - `https://blog.spoongraphics.co.uk/tutorials/videos/brutalism-graphic-design-why-its-ugly-bold-and-trending-in-2025`
  - Poster grid reference: `https://blog.spoongraphics.co.uk/wp-content/uploads/2025/01/preview.jpg`
- **Thirty reference images** in `uploads/` (poster grids, brutalist websites, editorial layouts). Used only to read the style. **No supplied image, logo, wordmark or line of copy appears anywhere in this system.**
- **Colour scheme sources** — twelve coolors.co palettes supplied by the user, listed under [Colour](#colour).

There is no client logo in any source, so **no logo was drawn**. The brand mark is the word `BRUTALIST` set in Concrete Condensed inside an 8px rule (`guidelines/brand-wordmark.card.html`). Do not invent a mark.

---

## Content fundamentals

**Voice.** Flat, technical, declarative. The system writes like a works order, not like marketing. Sentences state what is true and stop.

- *Yes:* "Thirty-two plates, three colours." / "Replies within two working days." / "The plate will be locked once it is queued."
- *No:* "We're passionate about bold design!" / "Let's make something amazing together."

**Person.** "We" for the studio, "you" only in instructions. Never "I". Never a first-person anecdote.

**Casing.** Uppercase is structural, not emphatic:
- Headlines, buttons, labels, badges, table headers, nav items, tab labels, folios, game menus — **always caps**.
- Running body copy and dialogue — **sentence case**, because it has to be read.
- Never Title Case. Never sentence case on a label.

**Numbers.** Zero-padded and used as identifiers wherever possible: `04`, `AB-0412`, `Plate 18`, `Edition 04 / 32`, `85 lpi`. Numbers are content in this system — they carry the "documented object" feeling. Use tabular figures in data (`--font-mono`).

**Length.** Micro-labels are 1–4 words. Headlines are 1–4 words at poster scale. Body paragraphs run 2–4 sentences. Nothing is padded to fill a box; an empty-feeling block gets a rule or a pattern, not filler copy.

**Punctuation and symbols.** `//` separates a code from its qualifier (`AB-0412 // halftone`). `—` for ranges in caps rows (`04 Sep — 12 Nov`). No exclamation marks. **No emoji, ever** — not in copy, not in UI, not in commit-style notes.

**Error and status copy** names the condition in words, because colour alone is never the message: "Registration off", "Out of range by 2mm", "Taking work", "On press".

**Sample strings** to lift for mocks: `Structural print + interface works` · `Nothing hidden` · `Load Bearing` · `Plate 04 // duotone, 85 lpi` · `Send to press` · `No booking` · `Unit 04, North Yard` · `Build 0.4.12 // pre-alpha`.

---

## Visual foundations

### Colour
Three roles, and only three: **`--paper`** (ground), **`--ink`** (everything you read), **`--accent`** (one loud voice per view). Every grey in the system is a `color-mix` of those two. The derived and semantic layer is declared on **both `:root` and `[data-theme]`**, because a `color-mix` custom property resolves against the element it is *declared* on — that duplication is what makes a theme swap actually re-derive the palette instead of freezing every grey to the default theme. `--ink-mute` (88% ink) and `--ink-faint` (76% ink) are mixed deliberately close to ink: seven of the thirteen themes reverse out of a saturated ground, where `--ink` is the *light* value, so a shallower mix lands mid-tone and fails 4.5:1 against its own paper. Measured across all thirteen themes: ink 6.58–17.2:1, `--ink-mute` 5.5–12.7:1, `--ink-faint` 4.6–8.5:1 — every text token clears the 4.5:1 minimum in every scheme. `--on-accent` is set per theme for type sitting on the accent, and is always the *darker* of the two available inks so 11px caps clear 4.5:1 against a saturated ground (the one exception is `navy-flare`, whose accent is itself near-black).

Thirteen schemes ship in `tokens/themes.css`, applied with `data-theme="…"` on any container. Ten are strict three-colour; three (`spectrum`, `clay`, `candy`) carry extra accents for variety. In three-colour schemes `--accent-2` … `--accent-6` alias back to ink and accent, so any component compiles in any theme.

| Theme | Roles | Source palette |
| --- | --- | --- |
| `raw` (default) | newsprint / near-black / signal red | system default |
| `spectrum` (6) | bone / black / red + 5 | `f94144 f3722c f8961e f9844a f9c74f 90be6d 43aa8b 4d908e 577590 277da1` |
| `navy-flare` | deep blue / yellow / near-black | `000814 001d3d 003566 ffc300 ffd60a` |
| `violent` | violet / amber / hot pink | `390099 9e0059 ff0054 ff5400 ffbd00` |
| `civic` | off-white / navy / red | `e63946 f1faee a8dadc 457b9d 1d3557` |
| `clay` (4) | warm sand / brown-black / coral | `f6bd60 f7ede2 f5cac3 84a59d f28482` |
| `terra` | slate / yellow / orange | `233d4d fe7f2d fcca46 a1c181 619b8a` |
| `lagoon` | teal / pale mint / green | `22577a 38a3a5 57cc99 80ed99 c7f9cc` |
| `toxic` | forest / cyan / coral | `00fddc 2e5339 495f41 ff5666 ffccc9` |
| `candy` (4) | sky / near-black / pink | `70d6ff ff70a6 ff9770 ffd670` |
| `signal` | acid paper / teal / magenta | `247ba0 70c1b3 b2dbbf f3ffbd ff1654` |
| `dossier` | manila / navy / vermilion | `083d77 ebebd3 f4d35e ee964b f95738` |
| `concrete` | grey-green / off-white / mint | `3c493f 7e8d85 b3bfb8 f0f7f4 a2e3c4` |

Preview every scheme live against a full interface in **`guidelines/theme-preview.html`**; the print kit has its own scheme selector.

### Type
- **Display — `--font-display` (Concrete Condensed).** The system voice. Caps only, set solid (`--lh-crush` **1.0**) with `-0.045em` tracking, from 48px to 208px. That 1.0 is a hard floor, not a preference: the face sets capitals **0.98em** tall (measured ascent .966 + descent .015), so any display line-height below 1.0 makes consecutive lines of caps physically overlap. `--lh-solid` is 1.05, `--lh-tight` 1.12. Alternates for editions: Railtown, Skyliner, Voltage.
- **Poster faces — `--font-slab` (Beinhart), `--font-heavy` (Heavy Brutalist), `--font-poster` (Brutalist Bold), `--font-edge` (Base Edge).** One word per composition, never a paragraph.
- **UI — `--font-ui` (Timun, 400/500/700/900).** Small headings, buttons, nav, app bars.
- **Body — `--font-body` (Helvetica Neue / Helvetica / Arial).** Raw browser grotesque, used on purpose: brutalist web design leans on the default face rather than a bespoke text family.
- **Editorial — `--font-editorial` (Times New Roman).** Print and long-form columns.
- **Labels and data — `--font-label` / `--font-data` (system monospace).** Caps with `0.08em`–`0.28em` tracking. Every card strip, badge, folio and table header uses this.

Scale: `--fs-2xs` 11 → `--fs-9xl` 208, plus three fluid steps for hero type. **Concrete Condensed has a 1.18em em-box**, so at `--lh-solid` or `--lh-crush` the glyph ink sits above the content box; `h1`, `h2`, `.bru-slab`, `.bru-stat__value` and `.bru-empty__title` all carry `padding-top: .2em` to recover it. Any hand-rolled display heading needs the same, or a caps label placed directly above it will be struck through. There is no comfortable middle — the middle of the scale exists only for prose.

### Space and layout
`--sp-1` 4 → `--sp-11` 192. Padding is either flush (0) or generous; there is no cosy in-between. **Gutters are hairlines, not air:** grids use `gap: var(--gutter-hair)` (2px) so neighbouring 3px rules collide into a single line and the whole page reads as one drawn grid. Twelve columns, `--page-max` 1440, `--page-gutter` `clamp(16px, 4vw, 64px)`. Fixed elements: the site header is sticky; game HUD blocks are pinned to the four corners; folios are pinned to the page foot.

### Borders, radii, shadows
- **Radius is 0 everywhere.** `--radius: 0`. There is no rounded variant of anything, including switches and radios.
- **There are no shadows.** `--shadow-none`. Depth is made with rule weight, inversion and overlap. Offset "hard shadows" are a neubrutalist device and are excluded.
- Rules come in six weights: `--rule-hair` 1 (table rows) · `--rule-thin` 2 (small controls) · `--rule` 3 (default) · `--rule-thick` 5 (frames, nav, window chrome) · `--rule-slab` 8 (sections) · `--rule-monument` 14 (chapters). Always solid, always ink or accent.
- **Cards** are a 3px ink rule on flat paper with an optional solid ink header strip carrying a caps label. No rounding, no shadow, no hover lift.

### Backgrounds and imagery
No photographic hero images and no gradients as decoration. Grounds are: flat paper, flat ink, flat accent, or one of the drawn screens — `--pat-hatch`, `--pat-bars`, `--pat-rule-grid`, `--pat-scanline`, `--pat-checker`, `--halftone-fine/coarse` — plus three licensed geometric pattern plates and six scanned grain plates in `assets/`. The three geometric plates are full-colour source art — run them through a `Plate` treatment (`posterize`, `duotone`, `mono`) whenever palette discipline matters, and use them raw only as incidental texture. Pattern grounds sit **behind panels, never behind loose small-caps text**: any element carrying 11px caps over a patterned surface needs its own opaque paper or ink plate — `Card`, `ObjectivePanel`, `DialogueBox`, `HUDMeter` and `KeyPrompt` all supply one.

**Imagery is always processed.** Five treatments in `base/treatments.css`, exposed through the `Plate` component: `posterize` (hard two-tone crush), `duotone` (shadows take `--duotone-base`, highlights take `--duotone-flood`; the base must be the darker of the pair, since the flood multiplies over it — the six schemes that reverse out of a dark ground set the pair explicitly in `tokens/themes.css`, since their `--ink` is the light value), `halftone` (posterised then broken by a dot screen; `--halftone-dot` sets the ruling, 5–9px), `mono` (flat colour knocked out of the silhouette), plus `grain` and `scan` overlays. Colour vibe: high-contrast, cool, gritty — never warm, never soft-focus, always with visible process. **No photography was supplied**, so the kits use the geometric pattern plates as stand-ins and show the labelled empty-plate state where a real image belongs.

### Motion
A cut, not a curve. `--dur-snap` 60ms and `--dur-quick` 110ms are the only interaction durations; the default easing is `linear` (`--ease-flat`) and stepped (`--ease-cut`) for blinks and loaders. **Nothing fades in, slides up, bounces, or eases out.** Longer timings exist only for the marquee (22s) and blink (1.05s). Loading is four blocks cutting between ink and accent — the system has no spinner and nothing ever rotates. `prefers-reduced-motion` freezes the marquee and blink.

### States
- **Hover:** inversion. An outlined control fills with ink and its label goes to paper. Never a tint, never a lift, never a shadow.
- **Active / pressed:** the accent fills the control. No shrink, no translate.
- **Focus:** a 3px accent outline at 2px offset (`--focus-outline`), plus the control's own rule moving to the accent.
- **Selected:** accent fill (nav, tabs, pagination, game menu, loadout slot).
- **Disabled:** rule and label drop to `--ink-faint`; ground stays paper; pointer events off. Never reduced opacity on the whole control.
- **Links:** ink with a 2px underline; hover moves to accent and thickens to 4px; active inverts to an accent block.

### Transparency and blur
Used almost never. The only sanctioned uses: the dialog scrim (flat ink at 90% opacity — **no backdrop blur**), pattern overlays via `mix-blend-mode`, and the scanline overlay at 18% in game screens. Glass, frost and translucency are not part of this system.

---

## Iconography

**Interface icons: Font Awesome**, kit `559791bdc6`.

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6/css/all.min.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

**Both lines are required.** Font Awesome kits are domain-locked: on any origin not in the kit's allowed-domains list the kit script loads its loader but no icon payload, and every glyph renders 0x0. The public Free CDN stylesheet is linked alongside it as the fallback so icons always draw. **Add your preview/staging domains to the kit's allowed-domains list** (Font Awesome account -> Kits -> 559791bdc6 -> Settings) and the kit will take over, including any Pro families you have.

Use the `solid` family as the default (`fa-solid fa-xmark`); `regular` only for the outlined square used in window caption buttons. If the kit has Pro enabled, `fa-sharp fa-solid` is the preferred family because its square terminals match the system — the components ship on `fa-solid` so they work on a Free kit. Wrap glyphs in the `Icon` component so the family can be swapped in one place. Prefer blunt geometry: bars, squares, arrows, chevrons, triangles, plus/minus. Avoid rounded pictograms, duotone, and anything illustrative. Never colour an icon anything but `currentColor`.

**Brand glyphs: 24 flat SVGs** in `assets/icons/` — brutalist towers, blocks, stairs, shutters, ornaments, stars, crosses, skulls — copied from the supplied library. Flat black fills, no strokes, so they recolour with a CSS filter or an inline `fill`. Use them large as graphic marks, not as UI affordances (`guidelines/brand-icons.card.html`).

**Unicode** is used sparingly for typographic marks: `//`, `—`, `▶` (game menu caret), `■` (marquee separator), `▲`. **Emoji are never used.**

No icon font was present in the source library, so no substitution was needed for the brand glyph set. Font Awesome is the user-specified interface icon system.

---

## Fonts — flags for the user

All display and UI faces are the real files from the attached library (`assets/fonts/`, `tokens/fonts.css`). Two gaps were filled with system stacks rather than guesses:

1. **No monospace face exists in the library.** `--font-mono` is a system stack (`ui-monospace`, SF Mono, Menlo, Consolas). This face carries every label, badge and table header in the system, so it matters. **Send a monospace file if you have a preference** — otherwise the nearest Google Fonts matches would be *Space Mono* (closest in feel) or *JetBrains Mono* (more neutral).
2. **Body and editorial text use raw browser defaults on purpose** — Helvetica/Arial and Times New Roman — which is authentic to brutalist web design. If you would rather ship webfonts here, say so and I will swap in real files.

Timun is a geometric display-leaning sans; it is used for UI and small headings, not for running prose, because it gets uncomfortable below about 15px.

---

## Non-goals

Explicitly excluded, so nothing drifts in later:

- Offset / "hard" drop shadows on cards and buttons (neubrutalism).
- Rounded corners of any radius.
- Pastel candy palettes with thick black outlines (neubrutalism).
- Gradient backgrounds and glassmorphism.
- Cards with a coloured left border only.
- Emoji, illustrated empty states, hand-drawn marks.
- Spinners, bounce easing, fade-in-on-scroll.

---

## Index

### Root
| Path | What it is |
| --- | --- |
| `styles.css` | The only file consumers link — `@import` list, nothing else |
| `readme.md` | This guide |
| `thumbnail.html` | Homepage tile for the system |

### Tokens and base
| Path | What it is |
| --- | --- |
| `tokens/fonts.css` | `@font-face` rules + family role tokens |
| `tokens/colors.css` | Role primitives, derived greys, semantic aliases |
| `tokens/themes.css` | The thirteen `data-theme` colour schemes |
| `tokens/typography.css` | Scale, weights, line heights, tracking, composed type roles |
| `tokens/spacing.css` | Spacing scale, control insets, grid, control heights |
| `tokens/structure.css` | Rule weights, radius 0, shadow none, patterns, halftone fields. Split like `colors.css`: static primitives on `:root`, everything that references `--ink`/`--accent` (border composites, focus outline, all generated grounds) repeated on `[data-theme]` so it re-derives |
| `tokens/motion.css` | Durations and easings |
| `base/elements.css` | Element defaults and small utilities (`.bru-label`, `.bru-slab`, …) |
| `base/treatments.css` | Image process treatments, grounds, marquee, blink |
| `base/components.css` | Class layer for every component (`.bru-btn`, `.bru-card`, …) |

### Assets
`assets/fonts/` 13 files · `assets/icons/` 24 brand SVGs · `assets/patterns/` 3 seamless geometric plates · `assets/textures/` 6 grain/halftone plates.

### Components — 55, in ten groups

Each directory holds `<Name>.jsx`, `<Name>.d.ts`, `<Name>.prompt.md`, and one `@dsCard` specimen page.

- **`components/core/`** — `Button`, `IconButton`, `Icon`, `Badge`, `Tag`, `Card`, `Rule`, `Stamp`
- **`components/media/`** — `Plate`, `Marquee`, `PatternBlock`
- **`components/forms/`** — `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`, `SearchField`
- **`components/navigation/`** — `NavBar`, `SideNav`, `Tabs`, `Breadcrumb`, `Pagination`, `Menu`
- **`components/feedback/`** — `Notice`, `Toast`, `Dialog`, `ProgressBar`, `Loader`, `Tooltip`, `EmptyState`
- **`components/data/`** — `Table`, `DataList`, `Stat`, `Meter`, `CodeBlock`
- **`components/chrome/`** — `WindowMac`, `WindowWindows`, `WindowLinux`
- **`components/mobile/`** — `PhoneFrame`, `AppBar`, `TabBar`
- **`components/game/`** — `HUDMeter`, `GameMenu`, `ObjectivePanel`, `DialogueBox`, `KeyPrompt`, `LoadoutSlot`
- **`components/print/`** — `Masthead`, `ColumnSet`, `PullQuote`, `Folio`, `CreditBlock`

#### Intentional additions
No source defined a component inventory, so this is an authored set. Three groups exist beyond a standard web kit because the brief names those surfaces: `components/chrome/` (desktop window types), `components/mobile/` (platform shells), `components/game/` (HUD and menu furniture), and `components/print/` (page furniture). `Icon` is a wrapper over the Font Awesome kit so the family can be changed in one place. `Plate` and `PatternBlock` exist because image treatment is a load-bearing part of this style, not decoration.

### UI kits
| Path | Product |
| --- | --- |
| `ui_kits/web/` | Substrate studio site — home, work index, journal article, enquiry form |
| `ui_kits/desktop/` | Plate Editor — one app in macOS / Windows / Linux chrome, utility windows, menus, modal |
| `ui_kits/mobile/` | Register app — iOS and Android side by side, four screens each |
| `ui_kits/game/` | Load Bearing — title screen, in-game HUD, loadout, pause / settings |
| `ui_kits/print/` | Load Bearing exhibition — three A2 posters, A4 editorial spread, live scheme switcher |

### Templates
Starting folders a consuming project can copy. Each has its own `ds-base.js` (one line to repoint at a bound design system) and a colour-scheme prop.

| Path | Template |
| --- | --- |
| `templates/poster/Poster.dc.html` | A2 poster — type-led, halftone plate, caps information row |
| `templates/landing-page/LandingPage.dc.html` | Landing page — ruled nav, split hero, stat band, work grid, marquee footer |
| `templates/app-screen/AppScreen.dc.html` | App screen — status bar, app bar, ruled list rows, tab bar |

### Guidelines and specimens
24 specimen cards in `guidelines/` covering Colors, Type, Structure, Spacing, Motion and Brand, plus `guidelines/theme-preview.html` — the full colour-scheme switcher applied to a live interface, game HUD and data views.

---

## Using the system

```html
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
<body data-theme="navy-flare">
```

Pattern tokens that tile (`--pat-rule-grid`, `--pat-checker`, `--halftone-fine-img`, `--halftone-coarse-img`) ship with a matching `*-tile` size token; set both `background-image` and `background-size`.

Then either use the class layer directly (`class="bru-btn bru-btn--primary"`) or the React components from the compiled bundle. Rules of thumb: one accent voice per view, one display face per composition, radius 0, no shadow, hover inverts, and every image goes through a `Plate`.

# Magazine — Design System

**Magazine** is an editorial design system. It takes the grammar of printed magazine and portfolio layout — a hard grid, hairline rules, oversized display type, kickers, drop caps, folios, pull quotes, full-bleed image blocks and a single loud accent colour — and applies it consistently to screens: websites, desktop applications, mobile apps, game interfaces, and print.

It is not a "web design system with a serif font." The rules run the other way round. Geometry is square, ink is flat, shadows are rare, and hierarchy is carried by *scale and rule weight* rather than by cards, elevation, or colour fills.

---

## Sources

This system was derived from a set of licensed print-layout source files supplied by the project owner. Nothing from those files is reproduced here — no imagery, no logos, no names, no copy. Only structural and typographic conventions were abstracted.

| Source | What was taken from it |
| --- | --- |
| `uploads/magazine-layout-2024-07-05-22-10-38-utc/` (INDD + IDML, 16pp magazine) | Paragraph-style ramp read directly from `Resources/Styles.xml`: *Big* — Libre Baskerville Bold 34pt / −10 tracking; *Page Title* — Libre Baskerville 32/36pt; *Body Copy* — Montserrat 9/15pt. Swatch set was CMYK-only, built around `C=10 M=88 Y=75 K=1` and `C=15 M=100 Y=100 K=0` (two reds) on Paper. |
| `uploads/magazine-layout-2025-08-11-21-49-23-utc/` (INDD) | Column structure and help-file conventions. |
| `uploads/magazine-layout-2026-08-31-20-37-05-utc/` (INDD/IDML/INDT + Canva) | Font brief: Bricolage Grotesque, Allison, Ballet. Confirms the display-grotesque + script pairing pattern. |
| `uploads/vintage-magazine-template-2026-08-30-02-16-24-utc/` (INDD, packaged) | Packaged-fonts report: Century Gothic (Reg/Bold/Bold Italic) + Minion Pro. 4-process-ink CMYK, no spot inks. Cover pattern: white page, huge letterspaced accent-red display word, boxed wordmark bottom-right, black interior spreads. |
| `uploads/portfolio-layout-2026-03-11-22-28-15-utc/` | Poppins-only portfolio layout. |
| `uploads/portfolio-layout-2026-03-28-00-06-59-utc/` | Poppins + Oswald. Condensed-for-labels pattern. |
| `uploads/portfolio-layout-2026-06-23-15-25-07-utc/` | Archivo + Open Sans. |
| `uploads/portfolio-layout-2025-09-30-20-05-32-utc/` | INDD/IDML portfolio, 300dpi CMYK. |
| `uploads/proposal-layout-2023-11-27-05-14-46-utc/` | Proposal/document layout conventions. |
| 11 reference JPEG/WEBP/AVIF spreads in `uploads/` | Visual language: oversized outlined display letterforms, rotated vertical captions, colour-block underlays behind images, halftone/duotone photography, four-column grids, red and ochre accents. |

**Not supplied:** a logo, a brand mark, photography we are licensed to redistribute, brand copy, or any product codebase. No logo has been invented. Wherever a mark would sit, the system sets the word **Magazine** in Playfair Display Black. Image areas in every card, kit and template are rendered as *token-drawn placeholders* (halftone fill + diagonal rule), never as borrowed photography.

---

## Content fundamentals

Magazine writes like a print desk, not like a product team.

**Voice.** Declarative, specific, unhurried. It states what a thing is and moves on. It never sells inside the interface.

**Person.** Second person for instructions to the reader (*"Set the measure to 66 characters."*). First-person plural only in editorial bylines and letters (*"We ran this cover twice."*). Never first-person singular from the product itself — an interface has no "I".

**Casing.** This is the loudest content rule in the system, and it is mechanical:

- **Kickers / eyebrows / section labels / folios / nav items / button labels / table headers** — `UPPERCASE`, letterspaced `0.22em` (kickers) or `0.14em` (folios), condensed or sans. *`ISSUE 14 — FIELD NOTES`*
- **Headlines and decks** — sentence case, always. *`The last analogue darkroom in the city`* — never Title Case, never a full stop unless the headline is a complete sentence with a second clause.
- **Body** — sentence case, serif, no bold runs inside paragraphs. Emphasis is *italic*.
- **Captions and credits** — sentence case, ends in a full stop, photographer credit in mono after an em dash. *`Third-floor composing room, 6am. — Photograph by staff`*

**Numbers.** Always figures, never spelled out: `3 issues`, `12 themes`, `1 rule`. Dates set as `14.03.26` in mono for meta, and as `14 March 2026` in body. Page numbers ("folios") are bare figures, no "Page" prefix, no zero padding above 9.

**Length.** A deck is one sentence, 12–24 words. A caption is one sentence. A kicker is 1–4 words. Body paragraphs run 40–80 words; the first paragraph after a drop cap runs long, the ones after it run short.

**Punctuation.** Em dashes set closed (`word—word`) in display, spaced (`word — word`) in body. Serial comma on. Quotation marks are curly. Ellipses are the single character.

**Emoji: never.** Not in UI, not in editorial, not in game HUD. There is no case for them in this system. Status and tone are carried by rule weight, colour and Font Awesome glyphs.

**Examples of the house style**

| Slot | Yes | No |
| --- | --- | --- |
| Kicker | `LONG READ` | `Long Read 📖` |
| Headline | `Nobody is coming to save the printing press` | `Saving The Printing Press: A Guide` |
| Deck | `Three shops, two owners and a machine that has not stopped since 1974.` | `Discover the amazing story...` |
| Button | `SUBSCRIBE` | `Subscribe now!` |
| Empty state | `No issues yet. The first one starts here.` | `Oops! Nothing to see here 🙈` |
| Error | `That address did not take. Check it and send again.` | `Something went wrong!` |
| Caption | `Type cases, west wall. — Photograph by staff` | `A cool photo of type cases!` |

---

## Visual foundations

### Colour

The system runs on a **19-slot semantic contract** that every theme fills identically, so any component works under any theme with no per-theme code:

`--ink` `--ink-2` `--ink-3` · `--paper` `--paper-2` `--paper-3` · `--accent` `--accent-2` `--accent-3` · `--accent-text` · `--on-accent` · `--rule-color` · `--field` · `--inverse-paper` `--inverse-ink`

plus a four-token **dark-surface set** that exists because the fourteen above are all chosen for legibility on *paper*:

`--hud-panel` `--hud-ink` · `--accent-on-ink` `--accent-2-on-ink`

The default theme, **Press**, is espresso ink `#1A1614` on bright paper `#FAFAF8`, with a signal red `#D92B32` and an ochre second `#E4B33A` — a direct read of the source templates' two-ink CMYK reds and the yellow-accent fashion spreads.

**Why the dark-surface set exists.** `--ink` is a *text* colour, so in the three dark themes it resolves light. Deriving a dark panel from it (`color-mix(--ink 78%, transparent)`) therefore produced a **light** panel in `midnight`, `voltage` and `neonpine`, and any accent placed on it disappeared. The fix is not a per-theme patch but a second, explicitly dark ground:

- `--hud-panel` — the theme's darkest surface, dark in all thirteen themes. Composited at 90% so gameplay still reads underneath.
- `--hud-ink` — the light ink that belongs on it.
- `--accent-on-ink` / `--accent-2-on-ink` — the two accents that survive on that panel. Sometimes identical to `--accent` / `--accent-2` (the dark themes), often not (`press`, `sage`, `verdigris`, `broadsheet`).

Every combination in this set is verified at or above 4.5:1 for text and 3:1 for meter fills, in all thirteen themes. **Never place `--accent` on `--hud-panel`, or `--ink` under `--hud-ink`** — that is the exact mistake the set exists to prevent.

### The same rule on the paper side: `--accent-text`

The twelve supplied palettes are *print* palettes. Their saturated stops were chosen to sit next to each other on a page, not to carry 11px type — `apricot`'s `#F28482` reads 2.16:1 on its own paper. So `--accent` is a **fill and background** token, and a second slot carries accent wherever it must be *perceived* against paper:

| Token | Use it for |
| --- | --- |
| `--accent` | Solid fills where `--on-accent` carries the legibility: accent buttons, accent tags, badges, toasts, inverse masthead grounds, full-bleed blocks. |
| `--accent-text` | Everything that must read against paper: kickers, links, hover heds, drop caps, big display figures, rules, focus rings, active tabs, sidebar and tab-bar active edges, progress fills, slider thumbs, switch tracks. |
| `--accent-on-ink` | The same job on `--hud-panel`. |

`--accent-text`, `--on-accent` and `--ink-3` were not hand-picked — they were **solved** per theme by pushing each colour along the axis toward its own theme's ink, paper, black or white until it cleared threshold, so the derived values stay on-palette. Where the raw accent already passed (`midnight`, `voltage`, `verdigris`, `neonpine`, `sage`, `press`) `--accent-text` is identical to `--accent`.

**Measured, all thirteen themes:** `--ink` 9.91–17.86 · `--ink-2` 5.58–11.42 · `--ink-3` 4.62–5.82 · `--accent-text` 4.61–13.63 · `--on-accent` on `--accent` 4.62–13.63 · `--inverse-ink` on `--inverse-paper` 9.91–17.86. Nothing in the system's text palette falls below 4.5:1.

Twelve additional themes ship (`data-theme="…"` on any ancestor): `spectrum`, `midnight`, `voltage`, `broadsheet`, `apricot`, `almanac`, `verdigris`, `neonpine`, `sherbet`, `lagoon`, `signal`, `sage`. Three of them (`midnight`, `voltage`, `neonpine`) are dark-paper themes; the rest are light. Raw palette stops are exposed as `--p-1 … --p-n` in the palette's published order.

**Colour is used sparingly and structurally.** Accent appears as: the rule under a masthead, a full-bleed block behind a pull quote, a kicker, an active state, one word in a headline — as `--accent` when it is the ground, as `--accent-text` when it is the mark. It is never a page background gradient and never a decorative wash. **Never more than two accent surfaces in one view.**

### Type

Five families, each with one job:

| Token | Family | Job |
| --- | --- | --- |
| `--font-display` | Playfair Display | Headlines, covers, drop caps, pull quotes, big figures |
| `--font-text` | Libre Baskerville | Long-form reading copy, print body |
| `--font-sans` | Archivo | All UI: controls, labels, tables, app chrome |
| `--font-condensed` | Oswald | Kickers, folios, nav, HUD, anything letterspaced-uppercase |
| `--font-mono` | JetBrains Mono | Metadata, timestamps, credits, code, numeric readouts |

The scale is a magazine scale, not an `h1…h6` ramp: `--size-poster` 132 · `--size-cover` 92 · `--size-hed-1` 64 · `--size-hed-2` 46 · `--size-hed-3` 34 · `--size-hed-4` 26 · `--size-deck` 21 · `--size-body` 17 · `--size-caption` 13 · `--size-kicker` 11 · `--size-micro` 10.

Display line-height is tight (`0.86`–`0.98`) and tracking is negative (`−0.045em` to `−0.02em`); body line-height is loose (`1.62`) and tracking is zero. **The contrast between the two is the system's signature.** Measure is capped at `66ch` for single-column text and `34ch` inside a four-column grid.

### Spacing and grid

4px unit, 8px baseline. Screen layout is a **12-column grid**, 24px gutters, 1320px max. Print is a **4-column grid** on A4 with mirrored margins — 18mm top, 16mm outer, 22mm inner (gutter allowance), 20mm bottom, 3mm bleed. Vertical rhythm is generous: `--space-9` (96px) between article sections, `--space-11` (176px) above a section break on a landing page.

### Backgrounds and imagery

Flat paper. **No gradients as decoration** — the only gradient in the system is `--overlay-protection`, a bottom-up ink scrim used strictly to keep type legible over an image. Textures are two, both drawn from tokens so they re-theme: `--texture-halftone` (a 4px dot screen, for image placeholders and empty states) and `--texture-rules` (an 8px ruled-paper stripe, for sunken panels).

Photography direction, where real imagery is supplied: **high-contrast, desaturated or duotoned toward the accent**, warm grain, generous negative space, one subject. Colour photography is allowed on covers and full-bleeds; interior thumbnails go monochrome. Images are always hard-edged rectangles — never rounded, never circle-cropped except for a byline portrait at 32px.

### Corners, borders, shadows

`--radius-0: 0` is the default and applies to virtually everything: buttons, inputs, cards, dialogs, images, panels. `--radius-1: 2px` exists for OS-chrome fidelity, `--radius-pill` only for tags and count badges.

Rules carry the hierarchy: `1px` hairline (table rows, list separators), `2px` thin (section heads, active tabs), `4px` heavy (masthead underline, pull-quote flag), `8px` slab (cover bands, chapter openers).

**Ink does not float.** `--shadow-lift` is a 2px hard offset rule, not a blur — the letterpress move. Real blurred shadows exist only for objects that are physically above the page: `--shadow-sheet` (modals), `--shadow-overlay` (menus, popovers), `--shadow-window` (OS windows). A card in a grid has **no shadow** — it has a hairline and whitespace.

### Motion

Fast, linear-feeling, no personality. `--ease-standard: cubic-bezier(.2,.7,.2,1)`, `--dur-fast 140ms`, `--dur-base 200ms`. **No bounce, no spring, no overshoot — paper does not spring.** Transitions are opacity, `transform: translateY(±1px)`, and rule-width growth. Page transitions are a 480ms crossfade. All durations collapse to 0 under `prefers-reduced-motion`.

### Interaction states

- **Hover** — the element moves up 1px (`--hover-shift`) and its rule thickens or inverts. Solid buttons invert ink/paper. Links pick up a full-weight underline. Never a colour tint, never an opacity fade.
- **Press** — moves down 1px (`--press-shift`), shadow-lift collapses to none. Physical, not scaled.
- **Focus** — `2px` solid accent outline, `2px` offset. Always visible, never removed.
- **Selected / active** — a `2px` accent rule on the leading edge (tabs: bottom; sidebar: left), plus ink weight going from 400 to 600.
- **Disabled** — `--ink-3` text, hairline border, no fill, `cursor: not-allowed`. Never 40% opacity on the whole element.

### Transparency and blur

Used in exactly three places: OS window chrome and mobile status bars (`--blur-chrome`), the scrim behind a modal (`--overlay-scrim`, 72% ink), and game HUD panels (90% `--hud-panel` with blur, so gameplay stays readable underneath while the panel stays reliably dark). Nowhere else — a translucent card in a document is a mistake.

### Layout rules

Mastheads are sticky on web and fixed on mobile. Folios are absolutely positioned at the bottom outer corner of print pages. Sidebars are fixed-width (`280px` desktop app, `240px` web) and never collapse below `1024px` — they become a drawer. Full-bleed elements break the grid deliberately and are always the full viewport width, edge to edge, with no margin.

---

## Iconography

**Font Awesome** is the icon system, loaded from the project's own kit:

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

Rules:

- **Style:** Font Awesome **Sharp Regular** (`fa-sharp fa-regular`) is the house style — its flat terminals and square joins match the system's zero-radius geometry. `fa-solid` is reserved for filled/active states and for game HUD, where weight matters at small size. `fa-light` for large decorative glyphs at 32px+.
- **Size:** icons are set in `em`, not `px`, so they track their label. Inline with a label: `1em`. Standalone icon button: `1.125em` at `--control-md`. Game HUD and status bars: `0.875em`.
- **Colour:** `currentColor`, always. An icon never carries its own colour token.
- **Pairing:** an icon never appears without a label in primary navigation. Icon-only is allowed for toolbars, window chrome, and media transport, and always carries an `aria-label`.
- **No brand glyphs** from `fa-brands` in editorial contexts.
- **No emoji, ever.** No Unicode dingbats as icons. The only Unicode glyphs used typographically are the em dash, the section sign `§` in folios, and `·` as a meta separator.
- **No hand-drawn SVGs.** The source templates contained no icon set and no logo, so nothing was copied in; Font Awesome is a deliberate substitution and is flagged as such.

---

## Fonts: substitution notice

The source templates specify **Century Gothic**, **Minion Pro**, **Poppins** and **Bricolage Grotesque**, none of which shipped as binaries in the packages (the packaged InDesign report lists them as "Fonts Not Packaged"). The system uses the nearest freely-licensable equivalents, served from Google Fonts:

| Source spec | Shipped here | Why |
| --- | --- | --- |
| Libre Baskerville *(specified and available)* | Libre Baskerville | Exact match, used for reading copy |
| Minion Pro / high-contrast display | Playfair Display | Nearest didone-adjacent display face with a 900 weight |
| Century Gothic / Poppins / Montserrat | Archivo | Grotesque with a real condensed axis and 100–900 range |
| Oswald *(specified and available)* | Oswald | Exact match, used for kickers and folios |
| — | JetBrains Mono | Added for metadata; no mono was specified in source |

**If you hold licences for Century Gothic, Minion Pro or Bricolage Grotesque, send the binaries and these mappings can be swapped in `tokens/fonts.css` with no other change.**

---

## Index

```
styles.css                  single entry point — @import list only
tokens/
  fonts.css                 webfont loading
  palette.css               raw stops, 13 themes (--p-1…--p-n)
  color.css                 14-slot semantic contract, per theme
  typography.css            families, magazine scale, tracking, measure
  spacing.css               4px unit, 12-col screen grid, A4 print geometry
  surface.css               radii, rule weights, shadows, textures, overlays
  motion.css                durations, easings, reduced-motion
  base.css                  element resets and defaults
guidelines/                 foundation specimen cards (Design System tab)
components/
  core/                     Button, IconButton, Tag, Badge, Kicker, Rule, Callout
  forms/                    Field, Input, Textarea, Select, SearchField, Checkbox, Radio, Switch, Slider
  navigation/               Masthead, NavLink, Tabs, Breadcrumb, Pagination, SidebarNav
  feedback/                 Dialog, Toast, Tooltip, ProgressBar, EmptyState, Spinner
  editorial/                ArticleCard, PullQuote, DropCap, Byline, Folio, Figure, StatBlock, ContentsList
  chrome/                   MacWindow, WindowsWindow, LinuxWindow, IOSFrame, AndroidFrame
  game/                     HudPanel, MeterBar, GameButton, InventorySlot, ObjectiveCard
  system/                   ThemeSwitcher (+ MAGAZINE_THEMES) — documentation chrome only
ui_kits/
  web/                      editorial website — home, article, archive
  desktop/                  desktop reader/editor app in all three window chromes
  mobile/                   iOS and Android app screens
  game/                     in-game HUD, pause menu, inventory
  print/                    A4 cover, feature spread, contents page
templates/
  editorial-article/        long-form article page (Design Component)
  app-shell/                three-pane desktop application shell (Design Component)
  print-spread/             true-A4 four-column feature spread (Design Component)
assets/                     README only — no logo, no photography (see above)
readme.md                   this file
```

### Component index

**core** — Button · IconButton · Tag · Badge · Kicker · Rule · Callout · Card
**forms** — Field · Input · Textarea · Select · SearchField · Checkbox · Radio · Switch · Slider
**navigation** — Masthead · NavLink · Tabs · Breadcrumb · Pagination · SidebarNav
**feedback** — Dialog · Toast · Tooltip · ProgressBar · EmptyState · Spinner
**editorial** — ArticleCard · PullQuote · DropCap · Byline · Folio · Figure · StatBlock · ContentsList
**chrome** — MacWindow · WindowsWindow · LinuxWindow · IOSFrame · AndroidFrame
**game** — HudPanel · MeterBar · GameButton · InventorySlot · ObjectiveCard
**system** — ThemeSwitcher (exports `MAGAZINE_THEMES`)

### Intentional additions

The source material is print layout only and defines no interactive component inventory. The component list above is therefore authored from scratch against the system's own rules. Two entries deserve a note:

- **`chrome/`** — OS window frames and mobile device frames are not "brand components" in the usual sense, but the brief requires the system to apply to desktop and mobile apps, and those surfaces have their own fixed geometry. They are provided so app screens sit in correct, non-invented chrome.
- **`game/`** — HUD primitives exist for the same reason. Per the brief they apply *this* system's rules to game UI rather than adopting game-UI convention: still square, still Oswald kickers, still one accent.
- **`system/ThemeSwitcher`** — a documentation control, not a product component. It writes `data-theme` onto an element so any specimen or kit can preview all thirteen colour schemes. Do not ship it inside an interface; to theme a real product, set `data-theme` once at the root.

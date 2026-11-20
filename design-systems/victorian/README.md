# Victorian — Design System

A design system built on the visual language of nineteenth-century commercial
printing: letterpress broadsides, chromolithograph advertising, engraved
trade cards, patent-medicine labels and the dense, rule-divided newspaper page.

It is deliberately **full**. Victorian job printing filled the sheet — every
inch carried type, rule, ornament or illustration, and white space was
understood as waste. Designs made with this system should feel composed and
crowded in the way a well-set playbill is crowded: hierarchy carried by size
and weight rather than by emptiness. If a screen built from these components
looks airy and minimal, it is wrong.

---

## Sources

Everything here derives from two supplied sets. No mark, name, wordmark or
copy from any reference appears in the system.

**Attached asset library** (read-only mount, `Victorian Assets/`) — a licensed
graphic library of period-styled stock: 39 folders of clipart, ephemera,
damask digital papers, ribbon banners, silhouettes, monograms and eight
display typefaces. Copied selections live in `assets/`.

**Reference imagery** (`uploads/`, 15 files) — photographs and scans of
Victorian advertising, playbills, broadsides, trade cards and a set of
contemporary websites built in a Victorian idiom. Used as direction only.

**No logo was supplied.** The system has no brand mark. Wherever a mark would
sit, the word *Victorian* is set in `--font-ornate` (Old Vintage Victorian).
Do not draw one.

---

## The five surfaces

The system is specified for all five, and each has a UI kit under `ui_kits/`.

| Surface | Kit | What it covers |
| --- | --- | --- |
| Web pages | `ui_kits/web/` | Marketing page, catalogue, long-form article, checkout |
| Desktop apps | `ui_kits/desktop/` | macOS, Windows and Linux window chrome around one app |
| Mobile apps | `ui_kits/mobile/` | iOS and Android screens, both platform conventions |
| Video game UI | `ui_kits/game/` | HUD, dialogue, inventory, quest log, title screen |
| Print | `ui_kits/print/` | Broadside, two-page spread, trade card, price list |

---

## CONTENT FUNDAMENTALS

Victorian commercial copy is **long, specific, and formally confident**. It
does not hint; it declares, then substantiates at length. The tone to write in
is that of a proprietor addressing the public in print, at his own expense.

**Voice: third person for the house, second person for the reader.** The
product or company is *it* or named in full; the reader is *you* only in
instructions. Never *we*. "The Company undertakes to replace any article found
defective." Not "We'll replace it if it breaks."

**Casing.** Headlines set in full capitals, tracked out. Subheads in Small
Caps. Running text sentence case, but with **liberal capitalisation of nouns
the copy treats as institutions** — the Company, the Subscriber, the Annual
Exhibition, Terms of Carriage.

**Length is a virtue.** A hero does not get six words. It gets a stack: a
capitalised claim, a qualifying line, a second qualifying line, then a rule,
then the detail. Four to seven decks of type in a headline block is normal.

**Numbers are spelled out with ceremony.** "Established 1874." "Twelve
Thousand Subscribers." "One Pound, Ten Shillings." Prices always carry their
unit and often a comparative — "reduced from Two Guineas".

**Punctuation.** Em dashes and semicolons are used as the copy's joints.
Ampersands are set freely in display type. Terminal periods appear even on
headlines and single-line labels: "GRAND OPENING."

**Guarantees, addresses and provenance are content, not fine print.** Every
composition should carry at least one line of the following kinds:
establishment date, place of manufacture, warrant or guarantee, or a
by-appointment line.

**Emoji: never.** Not in UI, not in copy, not in games. The ornamental role
emoji play is filled by printers' flowers (`--flower-*` tokens) and Font
Awesome glyphs.

**Examples in the right register**

- Button: `SUBSCRIBE.` / `ADD TO ORDER` / `PROCEED TO SETTLEMENT`
- Empty state: `The Ledger is Empty.` + "No entries have yet been recorded
  against this account. Entries added hereafter will appear in this column."
- Error: `The Entry Was Not Accepted.` + "A correspondence address is required
  before the order can be despatched."
- Loading: `Setting the Page…`
- Success toast: `Recorded. Your instruction has been entered in the Day Book.`
- Game quest: `Concerning the Matter at Blackfriars` + "Enquiries are to be
  made of the porter, and of no one else."
- Settings label: `PREFERENCES & PARTICULARS`

**What to avoid.** Contemporary product copy tics read instantly wrong here:
"Let's get started", "Oops!", "You're all set", one-word buttons like "Go",
exclamation-heavy encouragement, and any sentence beginning "Simply".

---

## VISUAL FOUNDATIONS

### Colour

The default scheme, **Parlour**, is one of thirteen. Aged stock
(`#f4ecd8`) carries a warm bottle-green black ink (`#1b2118`), with bottle
green as the working accent, oxblood as the second colour and gold leaf as the
third — the three-stone chromolithograph.

Twelve further schemes ship as scoped classes (`tokens/themes.css`). Two are
dark editions (**Gaslight**, **Absinthe**); the rest are light. Each scheme
re-declares only surfaces, text, accents and states. Rules, textures, frames
and shadows are all written in terms of those, so applying a theme class to
`<html>` or to any subtree recolours everything, ornament included.

Every scheme keeps the same structure: a paper, a panel, a card, an inset, an
invert, and four accents in descending loudness. Two constraints are enforced
across all thirteen: `--surface-invert` is always the darkest surface in the
scheme (so `--accent-3` on invert — the gilt pattern — always reads), and every
semantic pair the components actually use clears 4.5:1. Where a palette's own
amber or green is too light to sit on a card as caption-size text, the status
colour falls back to a pressroom ink (`--gold-600`, `--rubric-600`,
`--bottle-500`); this is noted in the theme's comment.

Use no more than three of a scheme's accents in one composition. The fourth
exists for charts and tag series.

### Type

Eight faces, five roles. The three ornamental alphabets are for initials only.

| Role | Token | Face |
| --- | --- | --- |
| Poster / headline | `--font-wood` | Condensed Victorian |
| Brand & ornate display | `--font-ornate` | Old Vintage Victorian |
| Titles & subheads | `--font-parlor` | Victorian Parlor (reg/bold/italic) |
| Didone alternative | `--font-didone` | Playfair Display |
| Running text | `--font-body` | Vollkorn |
| Antique text | `--font-text-old` | IM Fell English |
| Labels, UI, small caps | `--font-label` | IM Fell English SC |
| Script accent | `--font-script` | Italianno |
| Ledger / figures | `--font-mono` | Courier Prime |
| Drop capitals | `--font-initial` (+ `-alt`, `-alt-2`) | Victorian Alphabets I / VII / VIII |

Rules of setting: **capitals are always tracked** (`--track-caps`, or
`--track-caps-wide` at small sizes); lowercase never is. Headline leading is
tight to negative-feeling (`--leading-poster: .86`); body leading is generous
(`1.62`). Measure is capped at `66ch` for single columns, `48ch` in
multi-column layouts. Every long text block opens with an ornamental initial.

### Spacing

A compositor's scale in multiples of a 4px em-quad, retaining the odd 6px and
10px that real letterpress furniture gives you. Column gutters are 28px
(18px tight). Page margins clamp from 16px to 56px. Print margin is 0.75in.

Density is high by design: `--space-5` (12px) and `--space-6` (16px) do most
of the work inside components; `--space-9`/`--space-10` separate sections.
Sections are separated by *rules*, not by large gaps.

### Backgrounds

Never a flat fill alone. Three levels, in order of preference:

1. **Aged stock** — `.vic-paper`, which lays generated grain and low-frequency
   foxing over the surface colour at `--grain-strength` / `--foxing-strength`,
   in `multiply`. Tinted by the theme's ink, so it follows the palette.
2. **Damask** — `.vic-paper--damask` (light) and `.vic-paper--damask-dark`
   (gold on black) tile the shipped patterns. Reserved for chrome, dialog
   scrims, title screens and print endpapers.
3. **Engraved hatching** — `--pattern-hatch`, `--pattern-hatch-cross`,
   `--pattern-guilloche` for banknote-style panels and filled shapes.

Full-bleed photography is not part of the language. Full-bleed *illustration*
is: an engraved or chromolithograph plate, bled and overprinted with type.
Illustration imagery is warm, cream-biased and grainy; `.vic-engrave` reduces
any supplied artwork to the theme's ink so it can be reused under any scheme.

**No gradients** except two: the gilt rule
(`.vic-rule--gilt`, a horizontal fade for metallic rules) and the gaslight
glow on dark themes (`--shadow-gaslight`). Never a hue-to-hue background
gradient.

### Borders and rules

The rule is the primary structural device — it does the work that whitespace
and card shadows do in a modern system. Five weights (`--rule-hair` 1px
through `--rule-heavy` 7px) and six composites:

- `.vic-rule--double` — thick over hair, the standard section break
- `.vic-rule--triple` — the masthead break
- `.vic-rule--dotted` / `--dashed` — the coupon and the table leader
- `.vic-rule--gilt` — metallic, for invert and dark themes
- `.vic-rule-ornament` — a rule broken by a printer's flower, centred

Frames are compound: `--frame-double` (hair + 4px), `--frame-triple`
(thick–thin–thick), `--frame-gilt`. `.vic-frame--corners` sets four corner
pieces around a hairline box.

### Corner radii

**Square.** `--radius-0` through `--radius-3` top out at 4px, and 0–2px covers
almost everything: metal type and rule furniture do not round. Two exceptions:
`--radius-cameo` (`50% / 42%`, the oval portrait cameo) and `--radius-pill`
(tickets and coupon stubs only).

### Cards

A card is **a pasted label, not a floating pane**. Lighter than the page
(`--surface-card`), a 2px ink border or a compound frame, a hard 2px offset
ink shadow (`--shadow-press`), and no radius. It normally carries a rule under
its heading and a `--space-6` interior. The soft `--shadow-paper` /
`--shadow-paper-lifted` pair exists only for genuinely lifted paper: dialogs,
menus, dragged items.

### Shadows

Ink does not blur. Six shadows, and the hard ones are the defaults:

- `--shadow-press` / `-sm` / `-lg` — hard offset ink, no blur
- `--shadow-bite` — the press biting into the sheet, for inset fields
- `--shadow-emboss` — a highlight above, ink below, for raised controls
- `--shadow-paper` / `--shadow-paper-lifted` — soft, lifted paper only
- `--shadow-gaslight` — a brass glow, dark themes only

There are **no protection gradients**. Type over illustration is protected by
a capsule instead: a solid or hatched panel with a rule around it, set over
the plate. That is how the source material does it, and it is more legible.

### Transparency and blur

Used sparingly and never for its own sake. Transparency appears only as
`color-mix` tints for soft state backgrounds and rule colours. Blur appears
only on a dialog scrim (2px, over a damask overlay) — and even there the
scrim's job is done by ink opacity, not by the blur. No frosted glass.

### Animation

Nothing bounces. Two behaviours: an **ink-quick state change**
(`--dur-quick` 140ms, `--ease-ink`) and a **slow page reveal**
(`--dur-page` 640ms, `--ease-page`) used for dialogs, drawers and screen
transitions. No spring easings, no scale-in-from-0.9, no staggered entrances.

- **Hover:** the ink gets *darker*, never lighter, and rules thicken. Links go
  from `--text-link` to `--text-link-hover` and their underline goes 1px → 2px.
  Buttons move to `--accent-hover`. No opacity changes, ever.
- **Press:** the control translates `--press-offset` (2px) down and right onto
  its own hard shadow, and the shadow collapses. The press impression.
- **Focus:** a 2px `--focus-ring` outline at 2px offset, in the scheme's
  brightest accent. Never a soft glow ring.
- **Disabled:** 55% ink, hatched background (`--pattern-hatch-fine`), no
  pointer. The "cancelled" overprint, not a faded ghost.

### Layout rules

Fixed elements are rare and are always fully-inked bars, not translucent
overlays: the masthead, the mobile tab bar, a game HUD. Everything else
scrolls. Content columns are `--width-page` (1180px) or `--width-page-narrow`
(820px). Multi-column text uses `.vic-columns` with a hairline column rule —
the rule is what makes it read as a periodical rather than a CSS trick.

---

## ICONOGRAPHY

**Font Awesome is the icon system.** No icons ship in this design system. The
supplied asset library contained clipart, ephemera and ornament, but no icon
set, and hand-drawn SVG substitutes would be worse than a consistent library.

Load the kit once per page, in `<head>`:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

This is a **Pro kit, version 7.3.1**, which fetches each glyph from
`ka-p.fontawesome.com` on demand. It therefore needs that domain reachable and
the kit's referrer allow-list to include wherever the page is served from — in a
sandboxed preview the glyph fetches are blocked and icons render empty. `base.css`
holds a 1em box open for every unresolved `<i class="fa-…">` so layout never
collapses when that happens.

**Style: use the `fa-solid` family, or `fa-regular` for de-emphasised
controls.** Solid glyphs read as engraved ink and hold up against heavy type;
thin outline styles disappear next to a 4px rule. Do not mix families inside
one control group.

**Sizing.** Icons sit at the cap-height of the label beside them — set them in
`em`, never px, and let the type scale carry them. In icon-only controls the
glyph is 1em inside a `--control-h-*` square.

**Colour.** Icons take `currentColor`, always. Never an accent colour on an
icon whose label is ink.

**Where the period vocabulary beats an icon, use the period vocabulary:**

- Printers' flowers (`--flower-fleuron` ❦, `--flower-aldus` ❧,
  `--flower-asterism` ⁂) for dividers and list bullets
- The manual / pointing hand (`--flower-manual` ☞) as the "see here" marker,
  exactly as the source material uses it — this is the system's signature
  glyph, and it appears in mastheads, footnotes and call-out banners
- Unicode figure dashes and daggers (†, ‡) for footnote references
- Ornamental initials, from the three shipped alphabets, in place of any
  decorative section icon

**Shipped raster ornament** (`assets/`) is decoration, not iconography:
ribbon banners, oval frames, cartouches, damask papers, house plates and
silhouette portraits. Ribbons and cartouches are fixed-colour PNGs from the
supplied library, so they do not follow the theme — use them on Parlour,
Tearoom and Broadside, or run them through `.vic-engrave` first. Silhouettes
and the oval frame are single-colour SVGs and can be recoloured freely.

---

## Substitutions to confirm

- **Body and label text.** The supplied library's eight faces are all display
  cuts; none has a usable lowercase text weight. Running text uses **Vollkorn**
  and small-caps UI labels use **IM Fell English SC**, both from Google Fonts,
  chosen for a Victorian-era text colour. *If you hold licences for a period
  text face — Caslon, Scotch Roman, Miller — send the files and I will swap
  them in.*
- **Playfair Display** and **Courier Prime** are Google-Fonts stand-ins for a
  Didone display cut and a ledger typewriter face respectively.
- **Icons.** No icon set was supplied; Font Awesome (your kit) is used
  throughout.

---

## Index

**Foundations** — `styles.css` (the only file consumers link) imports:
`tokens/fonts.css`, `tokens/colors.css`, `tokens/themes.css`,
`tokens/typography.css`, `tokens/spacing.css`, `tokens/shape.css`,
`tokens/texture.css`, `tokens/motion.css`, and `base.css` (element defaults
plus the `vic-*` ornament utilities).

**Assets** — `assets/fonts/` (8 display faces), `assets/ornaments/`,
`assets/banners/`, `assets/silhouettes/`, `assets/illustrations/`,
`assets/textures/`.

**Guidelines** — specimen cards in `guidelines/`.

### Components

No source defined a component inventory — the supplied library is graphic
assets and typefaces only — so this is an authored set, sized to the five
surfaces the system has to cover.

- `components/core/` — **Button**, **IconButton**, **Card**, **Badge**, **Tag**,
  **Seal**, **Ribbon**, **Ornament**
- `components/forms/` — **Input**, **Textarea**, **Select**, **Checkbox**,
  **Radio**, **Switch**, **Slider**
- `components/navigation/` — **Masthead**, **Tabs**, **Breadcrumb**,
  **Pagination**, **SidebarNav**
- `components/feedback/` — **Alert**, **Dialog**, **Tooltip**, **Meter**,
  **EmptyState**
- `components/data/` — **DataTable**, **StatBlock**, **PriceList**, **Timeline**
- `components/editorial/` — **SectionHead**, **PullQuote**, **DropCap**,
  **Colophon**
- `components/chrome/` — **MacWindow**, **WindowsWindow**, **LinuxWindow**
- `components/mobile/` — **PhoneFrame**, **MobileAppBar**, **TabBar**, **ListRow**
- `components/game/` — **GameHUD**, **DialoguePanel**, **InventorySlot**,
  **QuestCard**
- `components/print/` — **PrintSheet**
- `components/theme/` — **ThemePicker**

**Intentional additions.** Four families exist because a surface in the brief
needs them and no standard primitive covers them: **Seal** and **Ribbon** (the
warrant medallion and swallowtail banner are the two ornaments the source
material uses most, and both had to be CSS so they follow the theme);
**Ornament** (rules are this system's primary structural device, so they need a
component, not just a utility class); and **ThemePicker**, which is a preview
control for inspecting the thirteen schemes and is explicitly not for product
UI.

**UI kits** — `ui_kits/web`, `ui_kits/desktop`, `ui_kits/mobile`,
`ui_kits/game`, `ui_kits/print`.


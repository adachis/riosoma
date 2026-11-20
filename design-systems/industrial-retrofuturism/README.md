# Industrial Retrofuturism

A design system for interfaces that behave like instruments. Every surface is a
panel: a moulded plate with a printed legend, hairline divisions, physical
controls that travel when pressed, and lamps that report state. It is built for
products where precision matters more than persuasion — hardware companions,
technical tools, catalogues, control software, spec-heavy marketing.

The system is deliberately **brand-neutral**. It ships no logo, no product
names, no copy about a specific company. The one variable the consuming project
sets is the accent hue.

## Sources

Supplied by the client as a mood reference, not as a brand to reproduce:

- `uploads/univers-next-pro/` — 33 Univers Next Pro TTFs (licensed retail font).
  The families used here were copied into `assets/fonts/`.
- ~40 reference photographs and scans of consumer audio hardware, retail
  packaging, silkscreened control panels, mobile OS screens and 1990s music-tech
  flyers.
- `uploads/TP-7 - teenage engineering.html` — one saved marketing page. Read for
  its **layout mathematics only**; those real values are recorded below.

Explicit client constraints, honoured throughout:

1. **No absorbed branding.** No product names, wordmarks, mission statements,
   Japanese ad copy or company references from the references appear anywhere in
   this system. Names used in the UI kits (`IR–01`, `sampler`, `studio unit 01`)
   are fabricated.
2. **No reference imagery.** Not one uploaded image is used, traced or derived.
   Photography slots in the kits are labelled placeholders.
3. **Orange is never the default.** It exists in the accent library as
   `--hue-orange` and is the only hue marked "never default". The shipped
   default is signal red.

### Values taken from the saved page

These are real measurements, not estimates, and drive `tokens/spacing.css`:

| Value | Token |
| --- | --- |
| 12 columns | `--layout-columns` |
| 980px page width | `--layout-page-w` |
| 45px page margin | `--layout-margin` |
| 10px gutter | `--layout-gutter` |
| 65px column | `--layout-column` |
| 10px baseline | `--layout-baseline` |
| `rgba(229,229,229)` body background | `--grey-100` / `--surface-page` |
| 15px body text | `--fs-15` |

## Content fundamentals

Copy is written the way a control panel is silkscreened: the shortest true
label, in the flattest voice available.

**Casing.** Three registers, and they do not mix.

- *Lowercase* for everything navigational and conversational: `products`,
  `visit store`, `cart & checkout`, `browse catalogue`, `add to cart`. Sentences
  in body copy start lowercase in UI contexts and sentence-case in prose.
- *UPPERCASE with +0.08em tracking* for anything printed onto a control:
  `VOLUME`, `TEMPO`, `SAMPLE RATE`, `ERASE`. These are legends, not headings.
- *UPPERCASE BLACK 900* for display headlines and model codes: `IR–01`,
  `SUPERTONE`, `CATALOGUE`.

**Person.** Second person is rare and never coaxing. The system prefers stating
the machine's condition to addressing the user: "device linked on usb-c", not
"You're connected!". First person plural is not used at all — there is no "we"
in a panel legend. Instructions are imperative and unpunctuated: `scan`, `link`,
`erase device`.

**Numbers carry the tone.** Values are always specific, always unit-suffixed,
always zero-padded so widths don't jump: `128 bpm`, `48 kHz / 24 bit`, `0.42 s`,
`410 g`, `3.4 ms`, `slot 04`, `REV 2.5`. A number without a unit is an unfinished
sentence. En dashes in codes (`IR–01`, `EP–133`), not hyphens.

**Length.** Button labels are one or two words. Tooltips are noun phrases, not
sentences. Body copy runs to two or three short sentences and stops; a fourth
sentence usually belongs in a spec row instead.

**What is never written:** exclamation marks, emoji, "seamless", "powerful",
"effortless", "delightful", "revolutionise", feature adjectives generally.
Superlatives are replaced with measurements. Error copy states the fault and
nothing else: "clock source lost", "slot occupied". Empty states state the
condition and offer one key: "cart is empty" + `browse catalogue`.

**Examples, verbatim from the kits:**

- `preset stored to slot 4`
- `pattern 04 will be overwritten. this cannot be undone.`
- `16 patterns and 6 samples will be removed.`
- `A single moulded enclosure, a printed panel and no menus deeper than one level.`
- `ships in 2–4 days. two year warranty.`
- `this device complies with part 15 of the fcc rules.` — compliance micro-type,
  set at 10px in the footer, is a deliberate texture in this system rather than
  legal filler.

## Visual foundations

**Substrate.** The page is never white. `--surface-page` is `#e5e5e5`, the colour
of moulded ABS. White (`--grey-025`, `--grey-000`) is a *card* or a *keycap* — a
part sitting on the plate. Black is ink and anodised aluminium. A dark chassis is
available as a scope: `data-panel="dark"` re-points every surface and ink token
without touching component code.

**Colour.** One accent per project, chosen from a nine-hue library of
high-chroma, slightly dirty, silkscreen-printable colours (`--hue-red` …
`--hue-orange`). Set it with `data-accent="cyan"` on any container — the
Storefront kit sets it *per product*, so the whole site re-themes as you move
between models. Accent appears on roughly 5% of any screen: one primary key, the
lit steps in a matrix, the value arc on the active knob, meter fill below
overload. Semantic hues (`--signal-ok/warn/alert/info`) are lamp colours and are
never used decoratively. There are no gradients anywhere except the moulded
highlight inside a keycap or knob cap, and no blur at all.

**Type.** Univers Next Pro throughout, in three cuts: core grotesque for text
and legends, the condensed cut for spec headers and long labels, Martian Mono for
any machine readout. Display sizes are set at weight 900 with `-0.03em`
tracking, tight enough that letters nearly touch. Body is 15px/1.35. Labels are
11px uppercase at `+0.08em`; compliance micro-type is 10px at `+0.14em`.

**Layout.** 12 columns × 65px, 10px gutters, 45px margins, 980px page — and a
10px baseline that everything lands on. Content is left-aligned and top-aligned;
centring is reserved for a cold-start panel or an empty state. Application
shells are fixed: a 56px function-key rail on the left, a masthead and a status
foot, both pinned, both hairline-bounded. Nothing else is fixed or sticky.

**Borders and shadows.** The hairline is the primary structural device: 1px
black rules divide sections, head spec lists, underline tabs and edge every card.
Flat UI casts **no shadow at all**. Shadow exists only to describe a physical
part — `--shadow-key` (a cap standing off the plate), `--shadow-key-press`,
`--shadow-engraved` (a well cut into the plate), `--shadow-bevel`,
`--shadow-panel`, `--shadow-display` (the inner darkness of an LCD window).
There are no protection gradients; a legend on a dark plate gets a solid plate,
not a scrim.

**Corner radii.** 0, 2, 3, 6 and pill. Cards and keycaps are 2px. Chassis panels
are 3px. Checkboxes are square by rule. Pill radius is reserved for switches,
lamps and filter chips. There is no 8/12/16px "card radius" in this system, and
introducing one breaks the language immediately.

**Cards.** A flat plate: `--surface-card`, 1px black border, 2px radius, no
shadow. An optional engraved header bar holds an uppercase micro-label at left
and mono metadata at right, separated from the body by a full-width hairline.
The `recessed` tone reverses this into a cut-in well for lists and logs.

**Imagery.** Photography only — plain-background product shots, cool and
neutral, no props, no lifestyle staging, no grain filters or duotones. Where
there is no photograph, the system uses a **perforated dot field** (`Grille`)
rather than illustration. Hand-drawn illustration, decorative SVG and stock
vectors are out of vocabulary. Full-bleed imagery is allowed only in a hero
plate bounded by hairlines.

**Transparency and blur.** Used almost nowhere. The single sanctioned use is the
modal backdrop: flat black at 72% (`--surface-overlay`) with no blur. Frosted
glass, translucent panels and layered opacity effects are not part of the
language.

**Motion.** Mechanical: 60ms for a lamp or key press, 120ms for switch travel
and hover, 180ms for panel changes, 320ms for overlays. Easing is
`--ease-mech` (`cubic-bezier(.2,0,0,1)`) for travel, `--ease-detent` for
switches, and plain `linear` for lamps — a lamp does not fade, it changes state.
Nothing overshoots, bounces or springs. Blink is a hard `steps(1)` alternation,
not an opacity fade. Long fade-ins do not exist.

**Hover.** No colour change. A keycap darkens 4% (`filter: brightness(.96)`);
a link's underline and text turn accent; a hairline row lightens its background.
**Press.** The cap moves: `translateY(1px)` plus `--shadow-key-press`, over 60ms.
No scale, no ripple. **Latched** state fills accent and stays there.
**Focus.** A 2px accent ring offset by the page colour (`--focus-ring`) — hard
edges, no glow.

## Iconography

The reference material contained **no icon library** — the source page's marks are
custom drawings that are part of that company's identity and were deliberately not
copied. Rather than hand-draw substitutes, the system adopts an open set and
**bundles it locally**:

- **Set:** [Lucide](https://lucide.dev) 0.441.0 (ISC). Geometric, 2px stroke, 24px
  grid — the closest available match to thin-line technical panel iconography.
- **⚠️ Flagged substitution.** This is a stand-in, not the brand's own set. If you
  have real icon SVGs, drop them in `assets/icons/` and paste their geometry into
  `components/core/icon-data.jsx`; nothing else changes.
- **92 glyphs, no CDN at runtime.** Geometry is inlined in
  `components/core/icon-data.jsx` and the same set sits in `assets/icons/` as
  standalone SVG files for design tools. Icons therefore work offline, in print
  and in exported HTML. (Cross-origin CSS mask images are blocked in some
  sandboxes — that is the specific reason the set is inlined rather than linked.)
- **Mechanism:** `Icon` renders the glyph as a CSS `mask` filled with
  `currentColor`, so an icon always inherits the colour of the text or key it sits
  in. Never use `<img>` for an icon here — it cannot inherit colour.
- **Unknown slugs** render as a hairline square, never a solid block, so a typo is
  visible without being ugly.
- **Sizes:** 14 inside labels, 16 in buttons, 18–20 in nav and mobile rows, 24
  standalone. Never below 14.
- **Format:** SVG only. No icon font, no PNG icons, no sprite sheet.
- **Emoji and unicode:** never. Not in labels, not in copy, not as bullets, not as
  status. State is a `Lamp`; a bullet is a hairline; an arrow is an icon.
- **Mixing families is prohibited.** One set per surface.
- **The dot field is not an icon.** `Grille` is texture and image stand-in only.
- **Game HUD exception:** the reticle is built from plain boxes (`Reticle`), not an
  icon or an SVG, so its spread can animate.

## Applications

The foundations are medium-agnostic; each medium adds geometry and density, never
new colours or typefaces. `tokens/media.css` holds all four sets, and
`guidelines/media-*.html` shows them.

### Mobile apps

390 × 844 as the design width. Body text rises to 17px (`--fs-m-body`) and titles
to 22px, but **labels stay 11px uppercase micro-caps** — the silkscreen voice does
not get friendlier on a phone. Safe areas are real: 44px top, 34px bottom, both
occupied by `StatusBar` and `TabBar`. **No control shrinks below 44px**, even where
the desktop version is 32px. Bars are 56px. Modals become `Sheet` (bottom sheet,
180ms travel, hairline grab rule — not a rounded pill handle). Rows are the mobile
`SpecTable`: `ListRow` at 56px with a mono value at the right edge. Working screens
go dark (`data-panel="dark"`) so the phone reads as the panel itself.

### Desktop apps

The densest end of the system: 13px body, 26px rows (22px dense), 22–28px controls,
hairlines instead of padding. Chrome heights are fixed — 28px title bar, 24px menu
bar, 38px tool strip, 22px status foot, 220px sidebar, 260px inspector. Window
chrome comes in three dresses via `TitleBar`'s `platform` prop — `system` (the
system's own three square hairline keys, 28px), `mac` (round keys at the left,
38px bar, 10px window radius) and `windows` (full-height keys flush right,
alert-red close hover). Traffic lights use the system's own
`--signal-alert/warn/ok`, not Apple's palette: enough platform convention that a
mockup reads correctly, none of the impersonation.
Selection **inverts to black**; there is no tinted highlight anywhere. Menus drop
hairline-edged plates with mono shortcut legends. The window itself gets 6px
corners (`--win-radius`) — the only place a 6px radius is used.

### Video game UI

HUD elements float over a rendered scene, so they carry **their own scrim**
(`--hud-panel`, black at 74%) rather than relying on a page substrate — and still
no blur, ever. Every element is pinned to a screen edge at `--hud-edge` (28px);
nothing floats centre-screen except the reticle. HUD panels take a 10px chamfer on
one corner (`--hud-corner`) and a **light** hairline (`--hud-hair`) instead of the
black one used on light panels. Lit meter cells glow via `--hud-glow`; that is the
only glow in the system. Front-end menus use the condensed cut at 26–42px with an
accent focus bar and zero-padded index numbers. Objective states use a **square**
status box, never a tick-in-a-circle. Settings screens deliberately leave the HUD
idiom and return to the light chassis, because a settings screen *is* a control
panel. `Scene.jsx` in the game kit is an honest placeholder — a graded field with
the system's dot pattern, there so HUD contrast can be judged, not as art.

### Print layouts

Type is specified in **points**: 48pt display, 18pt heads, 10pt body, 7.5pt
captions, 7pt floor for compliance micro-type. Rules are 0.5pt hairline and 1pt
structural. Pages are real trim sizes (`PrintSheet`: A4, Letter, Tabloid, 18×24in),
15mm margins, 5mm gutters. Body copy is justified in two columns; every figure is
numbered (`Caption`); crop marks are real production furniture (`CropMarks`), used
as both aid and signature. The only tint is `--ink-tint` at 100% — no screens, no
gradients, no duotones, and two inks maximum (black plus the accent). `@media print`
in `tokens/media.css` flips the substrate to paper white and drops the desk;
`PrintSheet` sets its own `@page` size, so Cmd-P produces the right sheet with no
extra work.

## Assets

- `assets/fonts/` — 14 Univers Next Pro TTFs (core, condensed, italics).
  Delivered as TTF; the browser loads them directly. Convert to WOFF2 before
  shipping to production for the file-size win.
- `assets/icons/` — 92 Lucide SVGs (ISC), one file per glyph, mirrored as inline
  geometry in `components/core/icon-data.jsx`. Replace both to swap icon sets.
- **No logo.** The references contained no logo that could be used generically,
  and inventing one would be inventing a brand. Wherever a mark would go, set the
  name in plain type — two lines, lowercase, regular weight, `line-height: 1.05`
  (see `guidelines/brand-wordmark.html`). The `NavBar` `brand` prop takes that
  string.

## Index

| Path | What |
| --- | --- |
| `styles.css` | Global entry point — `@import` list only |
| `tokens/fonts.css` | `@font-face` for Univers + the Martian Mono import |
| `tokens/colors.css` | Greys, accent library, signals, surfaces, ink, lines, theme scopes |
| `tokens/typography.css` | Families, weights, 14-step scale, tracking, semantic roles |
| `tokens/spacing.css` | 10px baseline scale, layout chassis, control geometry |
| `tokens/border.css` | Radii, border widths, dot/grid patterns |
| `tokens/elevation.css` | Part-describing shadows, focus ring |
| `tokens/motion.css` | Durations, easings, composed transitions |
| `tokens/media.css` | Mobile, desktop (incl. mac/windows chrome), game and print geometry + `@media print` |
| `tokens/base.css` | Resets, link colours, three utility classes |
| `guidelines/*.html` | 24 specimen cards (Type, Colors, Spacing, Brand, Media) |
| `components/**` | 53 components in 9 groups, each with `.d.ts` + `.prompt.md` |
| `ui_kits/console/` | Device-control application (desktop-web), 4 screens |
| `ui_kits/storefront/` | Product site, 4 screens |
| `ui_kits/mobile/` | Phone companion app, 4 screens, 390×844 |
| `ui_kits/desktop/` | Desktop librarian window, 3 panes, 1240×760 |
| `ui_kits/game/` | Game front end + HUD, 4 surfaces, 1280×720 |
| `ui_kits/print/` | Spec sheet, manual spread, poster, packaging panel |
| `templates/control-panel/` | Template — device-control application screen |
| `templates/product-page/` | Template — spec-led product page |
| `templates/mobile-screen/` | Template — 390×844 phone screen |
| `templates/desktop-window/` | Template — desktop application window |
| `templates/game-hud/` | Template — 1280×720 in-game HUD |
| `templates/print-spec-sheet/` | Template — A4 spec sheet, print-ready |
| `thumbnail.html` | Homepage tile |

### Components

**`components/core/`** — Icon, Button, IconButton, Badge, Tag, Card, Rule
**`components/forms/`** — Field, Input, Select, Checkbox, Radio, Switch, Fader, Knob
**`components/feedback/`** — Lamp, Meter, Toast, Tooltip, Dialog
**`components/navigation/`** — Tabs, NavBar, SideRail
**`components/hardware/`** — Panel, Readout, StepGrid, SpecTable, PortStrip, Grille
**`components/mobile/`** — StatusBar, AppBar, TabBar, ListRow, Sheet, SegmentedControl
**`components/desktop/`** — TitleBar, MenuBar, Toolbar, StatusStrip, Inspector, TreeRow
**`components/game/`** — HUDPanel, HUDMeter, KeyPrompt, MenuList, ObjectiveRow, Reticle
**`components/print/`** — PrintSheet, RunningHead, Caption, PrintTable, CropMarks, Colophon

### Intentional additions

No source defined a component inventory, so the standard set was authored, plus
seven hardware-idiom primitives without which the language cannot be written:

- **Panel** — the chassis every application surface sits on.
- **Knob**, **Fader** — rotary and linear parameter controls.
- **Lamp**, **Meter** — state and level, replacing dots and progress bars.
- **Readout** — recessed machine display for numerics.
- **StepGrid** — keycap matrix for step/slot/channel selection.
- **PortStrip** — chassis-edge connector row, reused for connection state.
- **SpecTable** — hairline spec list, the default for structured facts.
- **Grille** — perforated dot field standing in for imagery.
- **Rule**, **Field** — hairline divider and form label wrapper, both used
  constantly enough to be primitives.

The medium groups (`mobile/`, `desktop/`, `game/`, `print/`) are additions of the
same kind: each holds only the parts a medium cannot borrow from another.
`Sheet` exists because a phone has no room for `Dialog`; `TitleBar`/`MenuBar`/
`StatusStrip` because a window has chrome a web page does not; `HUDPanel`/
`HUDMeter`/`Reticle`/`KeyPrompt` because HUD elements sit over a scene with no
substrate; `PrintSheet`/`CropMarks`/`Colophon`/`Caption` because a page has a trim
edge and a folio. Everything else — buttons, faders, lamps, spec tables, readouts,
grilles — is shared across all four media unchanged.

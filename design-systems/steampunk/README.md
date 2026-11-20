# Steampunk — Design System

A Victorian-industrial interface system: brass plate over parchment and iron, engraved
type, riveted frames, gauges instead of progress numbers, and gear ornament used
sparingly. It is built to carry the same material language across five very different
surfaces — the web, desktop applications on three operating systems, iOS and Android
handsets, game UI, and print — without changing its rules for any of them.

There is no client brand behind this system. "Steampunk" is the system's own name, and
the reference material was mood, not identity: no logo, wordmark, copy, product name or
image from any source appears here. Where a brand mark would go, the system sets its
name in the display face (`Machine Engraved`). **There is no logo file in this project,
by design** — see *Iconography* below.

## Sources given

| Source | What it was | How it was used |
| --- | --- | --- |
| `Steampunk Assets/` (attached local folder) | ~360 files: 11 display font families (OTF + TTF), a 14-gear SVG/PNG bundle, two rusty/vintage frame sets, watercolour Victorian pattern and city background packs, and clipart sets (transportation, library, books, posters, figures) | Fonts and a curated subset of art were copied into `assets/`; the gear sheet was split programmatically into 14 individual ornaments |
| 23 uploaded reference images (`uploads/`) | Steampunk web pages, an e-commerce concept, two game UI kits (window set, preferences screen, hero-select screen), a pixel-art frame sheet, and book/poster covers | Read for structure and material logic only — panel construction, control anatomy, HUD layout, type hierarchy. **No uploaded image is used in the system.** |
| 12 Coolors palette links | Colour scheme variants | Implemented verbatim as the 12 named themes in `tokens/themes.css`, alongside the native Brass & Soot default |
| Font Awesome Kit `559791bdc6` | Icon set | The system's only icon source; loaded from the user's kit script |

Nothing was withheld or inaccessible.

## What the references actually taught

The reference material splits into two families, and the system takes something
different from each.

**Painted/illustrative steampunk** (the web pages, the airship illustrations, the
watercolour city plates) supplies the palette and the surfaces: warm sepia parchment,
brown ink linework, cut-out contraptions floating on paper with no cast shadow, and a
comfortable amount of empty space around a single large object.

**Fabricated steampunk** (the two game UI kits and the window set) supplies the control
anatomy, and this is the more important half. Controls in those references are *objects*:
a button is a plate with a bevel, a top highlight and a hard bottom edge; a slider is a
recessed track with a cog for a thumb; a toggle is a lever; a meter is segmented; a
number is on a dial. Panels are frames with rivets at the corners and an engraved
header. Nothing floats on a soft shadow, and nothing is a flat rectangle.

The system is that second logic applied everywhere, with the first family's palette.

---

## CONTENT FUNDAMENTALS

**Register: technical and plain, with period vocabulary.** Copy is written as if by an
engineer filing a report — concrete nouns, present tense, no salesmanship. Say what a
thing is and what it does. The Victorian flavour comes from *word choice* (manifest,
dispatch, ledger, boiler, depot, works, colophon), never from mock-archaic grammar. No
"prithee", no "steam-powered wonder", no exclamation marks.

**Person: second person for instruction, third for status.** Instructions address the
reader — "Vent the forward boiler within the hour." Status is impersonal — "Pressure
held at nine bar." The system never speaks as "we" in UI copy; "we" appears only in
marketing body copy, and rarely.

**Casing is structural, and it is the strictest rule in the system.**

| Element | Casing | Face |
| --- | --- | --- |
| Buttons, nav links, labels, badges, tabs, table headers, tab-bar items | UPPERCASE, tracked | Oswald (`--font-ui`) |
| Titles, plates, headings, speaker names | Title Case | Machine Engraved (`--font-display`) |
| Body copy, list rows, dialogue, hints | Sentence case | EB Garamond (`--font-text`) |
| Figures, timestamps, units, shortcuts, paths | As written, uppercase units | Courier Prime (`--font-mono`) |

Sentence-case Oswald is not part of the system. Neither is uppercase body copy.

**Length.** Buttons one or two words ("Depart", "Vent", "Seal the manifest" is already
too long). Badges never more than three words. Tooltips two or three words, uppercase.
Alert titles under five words, body one sentence. Tab-bar labels one word. Field labels
two words at most; anything longer belongs in the hint.

**Numbers carry units, always, and always in mono.** "9.4 bar", "1,204 tons", "04:12".
Round to one decimal for pressures, whole numbers for counts, 24-hour clock. A bare
number with no unit is a bug.

**Voice examples, drawn from the kits in this project:**

- Button: `DEPART` · `VENT` · `SEAL` · `ENQUIRE` — not "Let's go!" or "Submit"
- Empty state: "No entries since 04:12." — not "Nothing here yet 🙂"
- Error: "Above safe limit." / "Valve two is unresponsive." — the fault, then the fact
- Confirm dialogue: "The 4:12 to Aldergate is at nine bar and holding. Release the brake?"
- Alert: **Pressure rising** — "Vent the forward boiler within the hour."
- Toast: **Dispatched** — "Manifest sent to Aldergate."
- Marketing hero: "Instruments for people who read the dial." — a claim about the
  reader, not an adjective about the product
- Colophon: "Set in Machine Engraved and EB Garamond. Est. 1874."
- Game dialogue: "Valve two will not hold past nine bar. We vent now, or we walk home."

**Emoji are never used**, in any surface, including marketing. Unicode symbols are not
used as icons either — every glyph comes from Font Awesome. The one decorative
non-icon character permitted is the middle dot (`·`) as a separator in mono readouts and
metadata lines.

---

## VISUAL FOUNDATIONS

### Palette

Three materials and five pigments. **Brass** (`--brass-100…700`) is the only interactive
material: anything the user can press, drag or throw is brass. **Iron/soot**
(`--iron-100…600`) is chrome, HUD housing and footers — dark, never used for a control
face. **Parchment** (`--parch-50…500`) is every light ground. The pigments — verdigris,
oxblood, moss, lamp glow, copper, ink blue — carry meaning only: verdigris = info,
oxblood = danger, moss = success, lamp glow = focus and emitted light, copper = links.

Components never read a ramp value. They read the 19-variable semantic layer
(`--m-hi/-mid/-lo/-edge`, `--paper/-2`, `--panel/-2`, `--deep/-2/-3`, `--ink/-2/-3`,
`--on-metal`, `--on-deep`, `--line/-2`, `--glow`, `--ok/--warn/--bad/--info`, `--link`),
which is what the 12 theme variants override. Themes never change structure, bevels,
gradients, radii or type — only hue. Schemes with no light swatch mix their light
surfaces from their own lightest palette value; semantic slots a palette has no hue for
(a palette with no red, for instance) intentionally fall through to Brass & Soot.

At most two grounds appear on one screen: parchment and iron. A third ground is a bug.

### Type

Four brand faces, all shipped locally, plus three Google faces for text work:

- **Machine Engraved** — engraved caps with fine internal detail. H1–H4, plates, hero
  titles, speaker names, window titles at display size.
- **Trill Plaque** — fat-serif signage. Section heads and print subheads.
- **Izumi Poster** — heavy poster caps. Print and game titles only.
- **Underdove Blackletter** — mastheads, certificates, game logotypes. Never below 28px,
  never more than six words, never in UI.
- **EB Garamond** — all prose. 16px default, 18px long reads, 1.55 leading, 68ch measure.
- **Oswald** — every uppercase UI label. 0.14em tracking at 12–18px, 0.22em at 11px.
- **Courier Prime** — every figure, timestamp, unit, shortcut and path, tabular numerals on.

The scale runs 64 / 48 / 40 / 32 / 24 / 20 / 18 / 16 / 14 / 12 / 11. Slide and hero type
never goes below 24px; print never below 12pt; handset labels never below 9px and only
in tracked caps.

### Spacing, radii, borders

Machined, not a 4/8 grid: `2, 4, 6, 10, 14, 18, 24, 32, 44, 60, 80, 112`. 6px is the
default gap between controls, 10px the default inset, 24px the section rhythm. Radii are
small — 2px badges, 3px controls and panels, 5px cards, 8px cut HUD corners, 14px only
for the pill on a switch. Border widths: 1px rules, 2px rails, 3px game frames, 6px dial
rims. Controls are 28 / 36 / 46 / 56px tall; touch targets never below 44px.

### Backgrounds

Grounds are flat colour plus one of two gradient textures — `--tex-paper` (a two-angle
1px repeating hatch that reads as paper tooth) and `--tex-iron` (a diagonal hatch with a
top-left sheen). Both are pure CSS, so they re-tint with the theme and cost nothing.

Bitmap art is used in three places only: painted city plates as full-bleed hero and game
grounds, watercolour instrument patterns as print grounds and hero bands at 8–14%
opacity behind type, and cut-out illustrations as objects. **Any type over photography
gets the protection wash** — `linear-gradient(180deg,rgba(20,12,4,.15),rgba(20,12,4,.78))` —
never a blurred capsule. Gear ornaments sit at 8–12% opacity behind content, three per
screen maximum.

Imagery is warm throughout: sepia and brass, brown ink linework, no cool cast, no grain
overlay, no duotone. Illustrations are cut out with no drop shadow.

### Elevation, borders, transparency

Raised objects carry three things at once: a 1px top highlight in a lightened `--m-hi`, a
2px hard bottom edge in `--m-edge`, and one soft warm shadow (`rgba(28,16,4,.45)`).
Pressed objects drop all three and take an inset instead (`--sh-plate-press`). Recessed
things — inputs, tracks, sockets, meters — use `--sh-well`. There is no neutral grey
shadow anywhere, and no ambient "elevation-1/2/3" scale: a thing is raised, flush, or
recessed.

Panels are outlined, not shadow-separated: 1px `--line-2` on parchment, 1px pure black on
iron, with `--frame-inner` adding a brass inner rule where a frame needs weight.

Transparency and blur are rationed. `--glass` + `--glass-blur` (6px, 0.9 saturation)
appear only where a panel sits over photography or a game scene — HUD housings, modal
scrims. UI on a flat ground is always opaque.

### Interaction states

- **Hover** — `filter: brightness(1.07)` on metal, opacity 1 on dimmed nav items. Never a
  colour change, never a size change.
- **Press** — plate swaps to `--sh-plate-press` and the element moves `translateY(1px)`.
  It looks like a key going down.
- **Focus** — 2px `--glow` outline at 2px offset. The only glow in the system.
- **Active/selected** — brass fill where the resting state was parchment; a lamp lights
  where a lamp exists (radio, tab bar, meter segment).
- **Disabled** — opacity 0.45, no filter, cursor `not-allowed`. Never grey-out by
  desaturating the brass.
- **Inactive window** — `saturate(.6)` and the drop shadow removed.

### Motion

Fast engage, hard settle, nothing bounces. `--ease-engage` (`cubic-bezier(.2,.8,.2,1)`)
for everything, `--ease-detent` (14% overshoot) only for levers and needle settle.
Durations: 90ms presses, 150ms hovers and toggles, 220ms panels, 380ms needles and dials.
Gears turn linear and forever (`sp-gear-cw`, 14s default). Lamps flicker
(`sp-flicker`) at 2–2.4s. Steam rises (`sp-steam`) as an accent only. All of it collapses
under `prefers-reduced-motion`.

### Layout

Page max 1200px, prose max 68ch, gutter 24px, rail 264px. Headers and title bars are
fixed brass rails with a hard bottom edge; footers are iron plinths. Content is
symmetrical and centred — the references are Victorian, and Victorian layout is
axial. Asymmetric editorial grids are used only in the print kit, where an axial
masthead sits over a three-column body.

---

## ICONOGRAPHY

**Font Awesome, from the supplied kit, is the system's only icon source.**

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Rules:

- **Solid family only** (`fa-solid`). Regular is permitted for a hollow state (an unfilled
  bookmark); brands only in footers.
- Icons are sized at 1em of their label (11–19px in practice) and inherit `currentColor`.
  Never a coloured icon on a coloured plate.
- Prefer mechanical and Victorian-adjacent glyphs: `gear`, `gauge`, `fire`, `wind`,
  `train`, `scroll`, `compass`, `key`, `bell`, `envelope`, `lock`, `bolt`, `clock`,
  `flask`, `anchor`, `screwdriver-wrench`, `user-tie`.
- `fa-gear` is reserved: it is the loading indicator (`Spinner`), the breadcrumb
  separator, and the slider thumb. Do not use it as a generic settings icon in the same
  view as a Spinner.
- Wrap icons in the `Icon` component rather than writing `<i class="fa-…">` by hand — it
  is the one intentional addition to the component inventory (see below).
- **No emoji. No Unicode pictographs. No hand-drawn SVG icons.** If a needed glyph is
  missing from Font Awesome, use a word.

**Ornament is separate from iconography.** The 14 gear silhouettes in
`assets/ornament/gear-01…14.png` are decoration: black-on-transparent PNGs, tintable via
CSS mask, used as background ornament or as a spinning object. `assets/ornament/gears-sheet.svg`
holds all 14 as vectors. The painted frames in `assets/frames/` (two rings, two plates)
are for print, game and hero use — they are not UI containers, and a `Panel` should never
be replaced by a frame bitmap.

**No logo exists.** The reference material contained none that could be used, and none
was invented. Wherever a mark is needed, set the system name in `--font-display` — see
`thumbnail.html` and the `Navbar` usage in the web kit.

---

## Index

### Root

| File | What it is |
| --- | --- |
| `styles.css` | The only file consumers link. `@import` list, nothing else. |
| `readme.md` | This document. |
| `SKILL.md` | Agent-skill front matter for use outside this project. |
| `thumbnail.html` | Homepage tile. |
| `tokens/` | `fonts` · `colors` · `themes` · `typography` · `spacing` · `surfaces` · `motion` · `base` |
| `assets/` | `fonts/` (4 TTF) · `ornament/` (14 gears + SVG sheet) · `frames/` (4) · `textures/` (2) · `backgrounds/` (2) · `illustrations/` (6) |
| `guidelines/` | 25 specimen cards — the Design System tab's Colors, Type, Spacing and Brand groups |
| `components/` | 42 primitives in 8 groups (below) |
| `ui_kits/` | 5 product recreations (below) |
| `templates/` | Starting folders a consuming project can copy |

### Components

**core** — `Button` · `IconButton` · `Card` · `Panel` · `Badge` · `Tag` · `Divider` ·
`Plate` · `Icon`
**forms** — `Field` · `Input` · `Textarea` · `Select` · `Checkbox` · `Radio` · `Switch` ·
`Slider`
**feedback** — `Alert` · `Toast` · `Tooltip` · `Modal` · `Progress` · `Gauge` · `Spinner`
**navigation** — `Navbar` · `SideNav` · `Tabs` · `Breadcrumb` · `Pagination` · `Footer`
**data** — `Table` · `Stat`
**chrome** — `WindowFrame` · `MenuBar` · `Toolbar`
**mobile** — `PhoneFrame` · `AppBar` · `TabBar` · `ListRow`
**game** — `HudPanel` · `StatBar` · `ItemSlot` · `DialogueBox`

Each directory holds `<Name>.jsx`, `<Name>.d.ts`, `<Name>.prompt.md` and one
`@dsCard`-tagged HTML showcase.

#### Intentional additions

No attached source defined a component inventory — the references were images, fonts and
art, not a component library — so the inventory above is the standard set, sized to the
five surfaces this system has to cover. Three groups exist because the brief named the
surfaces explicitly: `chrome` (desktop windows on three operating systems, four window
types), `mobile` (iOS and Android parts), and `game` (HUD, inventory, dialogue). One
component is a wrapper rather than a design element: **`Icon`**, which exists so that
Font Awesome class strings appear in exactly one place.

### UI kits

| Kit | Surface | Screens |
| --- | --- | --- |
| `ui_kits/web/` | Marketing and content website | Home · Catalogue · Article · Enquiry |
| `ui_kits/desktop/` | Desktop application, macOS + Windows + Linux chrome, four window types | Workbench · Dialogue set |
| `ui_kits/mobile/` | iOS and Android handset app | Manifest list · Detail · Settings, both platforms |
| `ui_kits/game/` | Game UI | HUD · Inventory · Preferences · Title |
| `ui_kits/print/` | Print layout | Broadsheet page · Poster |

Every kit composes the primitives above; none re-implements them.

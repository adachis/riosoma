# Colorful Minimalist — design system

A flat, color-first interface and print system. Big geometric display type, saturated
full-bleed color fields, hairline rules instead of shadows, square containers and pill
controls. It ships **twelve interchangeable color schemes** over one unchanging geometry,
and covers five surfaces: web, desktop apps (macOS / Windows / Linux), mobile apps (iOS /
Android), game UI, and print.

The system carries no client identity. Sample content throughout is a fictional studio,
**Northline**, and a fictional product, **Ledger** — placeholders so the components can be
seen doing real work. Replace both before shipping anything.

---

## 1. Where this came from

**Brief.** "Colorful Minimalist" — build a system inspired by, not copied from, a set of
supplied visual references; make it applicable to any design type; include twelve named
color palettes; use the client's Font Awesome kit for iconography.

**Sources supplied.** 30 raster reference images, uploaded to `uploads/` in this project.
No Figma file, no codebase, no logo, no fonts, no copy deck, and no live URL were
provided. Everything below is therefore an interpretation of the references plus the
brief, not a recreation of an existing product. The references fell into four groups:

| Group | Files | What it contributed |
| --- | --- | --- |
| Minimalist studio and product sites | `Minimalist-website-design-*.jpg` (7) | Whitespace-first layout, mono uppercase micro-labels, hairline nav, single-color full-bleed hero |
| Flat-design marketing sites | `*-flat-website-design-example.png.webp` (6), `flat-website-design-header.png` | Saturated one-color pages, oversized geometric display type, pill CTAs, no depth cues |
| Data-table and dashboard UI | `nutrition-table-with-pagination`, `data-table-ui-challenges-icons`, `infinite-scroll-user-table`, `expandable-row-table-ui`, `assignment-task-table-ui`, `flat-design-dashboard-ui` | Table anatomy: mono uppercase headers, no vertical rules, expandable rows, sortable columns, pagination furniture, colored stat tiles |
| Bauhaus / geometric poster and illustration plates | `abstract-bauhaus-*`, `abstract-geometric-arch-*`, `minimalist-abstract-art-poster-*`, `colorful-flat-minimalist-landscape-*`, `291_flat_design_illustration_blog-1.png`, `10.jpg`, `ce08c5e*`, `original-a23d15c*`, `toptal-blog-image-*` | The shape vocabulary: circle, arch (half-round), 45° line-stripe field, dot field, hard-edged color block |

**Color schemes.** Twelve Coolors palettes were supplied and are implemented verbatim as
theme scopes (see §4). Their source URLs are recorded in `tokens/themes.css`-adjacent form
here:

```
spectrum    f94144 f3722c f8961e f9844a f9c74f 90be6d 43aa8b 4d908e 577590 277da1
midnight    000814 001d3d 003566 ffc300 ffd60a
neonviolet  390099 9e0059 ff0054 ff5400 ffbd00
signal      e63946 f1faee a8dadc 457b9d 1d3557
apricot     f6bd60 f7ede2 f5cac3 84a59d f28482
field       233d4d fe7f2d fcca46 a1c181 619b8a
mint        22577a 38a3a5 57cc99 80ed99 c7f9cc
fernpop     00fddc 2e5339 495f41 ff5666 ffccc9
candy       70d6ff ff70a6 ff9770 ffd670
lagoon      247ba0 70c1b3 b2dbbf f3ffbd ff1654
ember       083d77 ebebd3 f4d35e ee964b f95738
sage        3c493f 7e8d85 b3bfb8 f0f7f4 a2e3c4
```

**Iconography.** Font Awesome **Pro 7.3.1**, the client's own kit, id `fde87cf732`.

**No logo.** The sources contained no mark, so none was drawn. Wherever a logo would go,
the system sets the name in display type — see `guidelines/brand-wordmark.html` and §7.

---

## 2. Content fundamentals

How copy is written in this system. These rules apply to marketing pages, app UI, game
text and print alike; only the length changes.

**Voice.** Plain, declarative, slightly dry. The system states what a thing is and stops.
It never sells the reader on the fact that it is selling them something.

**Person.** "We" for the organization, "you" for the reader. Never "I". Never the
third-person corporate voice ("Northline believes…").

**Sentence shape.** Short declaratives, and one longer sentence per paragraph to break the
rhythm. No sentence fragments used as punchlines. No "This, not that." constructions. No
rhetorical questions as headings.

**Casing.**
- Display headlines: **sentence case**, with a full stop when the line is a statement —
  `Born flat. Built loud.` Uppercase display is reserved for game UI and posters.
- Micro-labels, nav links, table headers, badges, credits: **UPPERCASE**, mono, wide
  tracking — `SELECTED WORK`, `MONTHLY RECURRING`, `PHOTO — R. MENON`.
- Buttons and body copy: **sentence case** — `Start a project`, not `Start A Project`.
- Section eyebrows: uppercase mono, often carrying an issue or index number — `ISSUE 04 — COLOR`.

**Numbers.** Always specific, always short in display positions. `$12.4k`, `14wk`, `212`,
`2%`. Long numbers move into mono and out of display type. Currency and identifiers are
set in DM Mono with tabular figures so columns align.

**Length ceilings.**
- Display headline: 8 words, hard stop.
- Micro-label: 4 words.
- Badge: 2 words.
- Button: 4 words, verb first.
- Body paragraph: 3 sentences on a marketing page, 2 in an app.
- Empty state: one sentence.
- Alert body: one sentence, and it says what to do next.

**Emoji: never.** Not in UI, not in marketing copy, not in the game HUD. Status is carried
by a Badge, a colored dot, or a Font Awesome glyph.

**Unicode as punctuation, not decoration.** The system uses `·` as a separator
(`Lisbon · Copenhagen · Montréal`), `—` for editorial asides, `–` in ranges (`21 – 28 March`),
`↗` never (use `Icon name="arrow-up-right"`).

**Specific examples, taken from the kits.**

| Slot | Written like this | Not like this |
| --- | --- | --- |
| Hero headline | `Born flat. Built loud.` | `Transforming brands through bold design` |
| Hero support | `We make identities, books and interfaces that hold their shape at any size. No gradients, no drop shadows, no apologies.` | `We're a passionate team of creatives on a mission to elevate your brand.` |
| Section eyebrow | `SELECTED WORK` | `Our Amazing Portfolio` |
| CTA | `Start a project` | `Let's Get Started! 🚀` |
| Stat label | `AVERAGE ENGAGEMENT` | `Time we typically spend` |
| Empty state | `Nothing filed yet` / `Invoices you send will collect here.` | `Oops! It looks like there's nothing here yet.` |
| Alert | `Two seats left` / `Add more before the next cycle.` | `Warning: You are approaching your seat limit!` |
| Pricing plan blurb | `Two weeks, one surface, one decision-maker.` | `Perfect for teams who want to move fast and iterate!` |
| Table state | `OVERDUE` | `Payment is late 😬` |
| Game objective | `Restore power` · `2/3` | `Head to the generator and turn the power back on!` |
| Print credit | `PHOTO — R. MENON` | `Photography by Ravi Menon` |
| Footer | `© 2026 Northline Studio` | `Made with ❤️ in Lisbon` |

**Vibe, in one line.** A Swiss print studio that learned to build software and refuses to
add a gradient.

---

## 3. Visual foundations

### Color
Color is the system's primary structural device, not decoration. A page is organized by
**flat fields**: a hero on `--accent`, a stats band on `--invert`, a CTA on `--accent-3`.
Fields are edge-to-edge and hard-edged. **There are no gradients anywhere in the token
layer** — not in backgrounds, not in buttons, not in charts, not in overlays.

Each scheme provides four fields (`--accent`, `--accent-2`, `--accent-3`, `--pop`), and each
field ships a paired `--on-*` text color. **Those pairings are measured, not chosen by eye:
every `field / --on-field` pair in every scheme clears WCAG AA 4.5:1**, which is why some
saturated fields carry dark text rather than white (`spectrum` sets `#111a20` on `#f94144`;
white would be 3.58:1). `--ink-3`, the micro-label color, also clears 4.5:1 against every
surface in its scheme. `--pop` is the one exception — it is an attention color for dots,
rules and 3px accents, and must not be used to set type. One consequence worth knowing: on
several schemes the hero headline is now **dark ink on a saturated field** rather than white.
That is closer to the flat-design references than white was, and white remains legitimate on
those fields for display type at 24px and above (large text needs only 3:1) — but the token
holds the small-text-safe value, so opt into white explicitly when you want it. Rule of thumb
per view: one
dominant field, one secondary field, `--pop` in doses under 5% of the area.

Neutrals are warm-tinted per scheme rather than pure gray — `spectrum` paper is `#ffffff`
over `#f6f4f1`, `signal` sits on `#f1faee`, `ember` on `#ebebd3`. Ink is never `#000`; it
is the palette's darkest hue (`#16232b`, `#083d77`, `#1b0347`).

Status colors are **derived in each palette's own hue family** when the source palette had
no green or amber, rather than borrowed from another scheme. This is deliberate: a green
that belongs to `mint` would look imported in `apricot`.

### Type
Three families, three jobs — set in `tokens/typography.css`.

- **Instrument Sans** (display) — 600/700 only, tracking `-0.035em` to `-0.045em`,
  line-height 0.93–1.02. Used at 20px and above, never below.
- **DM Sans** (text) — 400/500. Body 17px/1.55, secondary 15px, capped at 66 characters.
- **DM Mono** (micro) — 400/500, uppercase, tracking `0.14em` (`0.22em` in game UI).
  Every label, table header, badge, credit, timestamp, keybind and figure in the system.

The mono uppercase micro-label is the system's single most recognizable move. Paired with a
hairline running to the container edge (`<Divider label="…">`) it is how every section is
titled — in preference to a small heading.

Scale: 11 · 12 · 13 · 15 · 17 · 20 · 24 · 32 · 44 · 64 · 92 · 132. Print floor is 12pt
(16px at 96dpi); interface floor is 13px; slide floor would be 24px.

### Spacing and layout
4px base, but weighted hard to the large end: section padding is 96–160px, not 32px.
`--page-pad` 56px, `--gutter` 24px, `--max-content` 1360px, `--max-prose` 66ch. Whitespace
is the system's only luxury signal, so it is never traded for another card.

Layout rules: a sticky page header (74px) on web; a fixed dark rail (248px) in apps; a
fixed bottom tab bar (60px) on iOS and a fixed FAB on Android; HUD panels pinned to
viewport corners in game UI; 56–64px margins on print artboards. Grids are 12-column on
web, 2-up or 4-up for card rows, and 2-column for editorial body copy.

### Backgrounds
Flat color, full-bleed. No photographic backgrounds, no hero images behind text, no
blurred glass panels, no noise, no mesh. Where a page needs texture it uses one of two
token-level motif fields: `--stripe` (45° 1px lines, 7px pitch) or `--dots` (1px radial
dots, 12px grid), both at 14–50% opacity. Where a page needs form it uses the shape
vocabulary drawn from the Bauhaus references: **circle, arch (half-round), square block,
line-stripe field** — composed from plain divs with `border-radius`, never from an SVG
illustration.

### Imagery
The system ships **no photography and no illustration**. `Figure` renders a labeled
placeholder describing what the picture should be (`"Studio floor, wide"`), and the kits use
it honestly rather than substituting artwork. When real photography arrives it should read
**cool-neutral and un-graded** — daylight, matte, no warm filter, no grain overlay, no
duotone. Crops are square or hard rectangles; images are never rounded, never feathered,
never given a shadow. Full-bleed 21:9 plates are the one large-image treatment.

### Borders and rules
Three weights, and they carry all the structural work shadows would normally do:
- `--border-hairline` 1px `--line` — row separators, field borders, card edges, footers.
- `--border-strong` 2px `--line-strong` — table header underline, active tab, pull-quote rule.
- `--border-heavy` 3px `--accent` — card top rules only.

No vertical rules in tables, ever.

### Shadows
Two, and only two:
- `--shadow-block` — a **hard 4px offset block, zero blur**, in ink. One per screen maximum,
  on the hero card. This is the system's entire concept of lift.
- `--shadow-overlay` — the one soft shadow, reserved for things that genuinely float:
  `Modal`, `Menu`, `Toast`, `FAB`, and the desktop window frames.

Cards are otherwise perfectly flat. There is no `--shadow-sm`. There are no inner shadows
except `--shadow-inset-field`, which exists only to draw a field border on a colored
surface. **No card in this system has a colored left border**; emphasis is `topRule` or a
full color field.

### Transparency and blur
Used in exactly three places, and named:
1. `Modal` scrim — 58% ink, 2px blur.
2. `Sheet` scrim — 52% ink, no blur.
3. `HudPanel` — 86% fill with a 3px blur, because gameplay must read through it.

Everywhere else, transparency appears only as the `--tint-4 / --tint-8 / --tint-14` ink
washes used for hover states and zebra rows. No frosted-glass navigation, no translucent
cards, no protection gradients — where text sits on color it sits on a **solid capsule or
a solid field**, never on a fade.

### Corner radii
Deliberately bimodal, with nothing in between:
- Containers — **0px**. Cards, sections, tables, figures, artboards.
- Fields and badges — **2px**. Inputs, checkboxes, badges, table cells, ability slots.
- Interactive controls — **999px**. Buttons, icon buttons, tags, chips, switches, avatars.
- Window frames — 10px (macOS), 4px (Windows), 14px (GNOME), 0px (KDE).
- Devices — 46px (iOS), 28px (Android). One exception: `Sheet` rounds its top edge 14px so
  it reads as sliding in from off-screen.

### Cards
`--surface` fill, one 1px `--line` border, 0px radius, 28px padding, no shadow. Optional
`topRule` (3px accent) and `lift` (hard block shadow). A card can instead become a flat
color field (`tone="accent"`), which swaps its text to the paired `--on-*` value and drops
its border. Two colored cards per view is the ceiling.

### Motion
Short, near-linear, and mostly confined to color.
- Durations: 80 / 140 / 220 / 400 / 700ms.
- Easing: `cubic-bezier(.2,0,.2,1)` as standard; **linear** for anything continuous
  (spinner, health bar).
- **No bounce, no spring, no overshoot, no parallax, no scroll-triggered reveals, no
  staggered entrances.** `prefers-reduced-motion` zeroes every duration.
- Geometry moves in only three places: the 1px press translate, the 2px card hover rise,
  and the 10px slide on a focused game menu row.

### Hover states- Solid buttons: field darkens 14% toward ink (`color-mix`), never lightens, never glows.
- Outline buttons and icon buttons: **invert to a solid ink field** — the signature hover.
- Ghost buttons and menu rows: 8% ink wash, or a full ink field for menu items.
- Table rows: 4% ink wash. List rows: same.
- Work-index rows and cards: the whole row becomes an `--accent` field.
- Links: color shifts to `--accent`; the 1px accent underline is present at rest.
- Icons and images: nothing. Icons do not scale or spin on hover.

### Press states
`transform: translateY(1px)` and nothing else — no scale, no shadow change, no color flash.
Disabled is `opacity: 0.38` with the field retained.

### Focus
`--focus-ring` = 2px paper gap + 2px `--focus` ring. Applied on `:focus-visible` only.
Fields also darken their border to full ink on focus.

### Opacity and readable text
`opacity` is never used to dim text that has to be read. A micro-label sitting on a color
field carries the **full** `--on-*` value, because the pair is already contrast-verified and
a 12px uppercase mono label is not competing with the display type beside it. `opacity`
survives in only two roles, both with a **0.7 floor**: genuine de-emphasized state
(completed objectives, inactive nav) and non-text furniture (hairlines inside HUD panels,
motif fields, decorative shapes). If a label looks too loud at full weight, change the token
it uses — do not fade it.

---

## 4. Color schemes

Twelve schemes, one geometry. Every scheme sets the identical token contract, so switching
is a single attribute:

```html
<html data-theme="ember">        <!-- whole document -->
<section data-theme="mint">…</section>  <!-- or any subtree -->
```

`spectrum` is the default, applied to `:root`. Scheme ids: `spectrum`, `midnight`,
`neonviolet`, `signal`, `apricot`, `field`, `mint`, `fernpop`, `candy`, `lagoon`, `ember`,
`sage`.

Preview them in `guidelines/theme-gallery.html` (all twelve at once, pure CSS) and
`guidelines/theme-switcher.html` (real components, click to switch). **The UI kits are
deliberately single-scheme** — switching chrome belongs in the guidelines, not inside a
product mock.

`.cm-invert` re-maps surfaces and ink for a full-bleed dark section while leaving the
accent fields untouched. Use it for footers, stats bands, and the entire game UI.

---

## 5. Files

```
styles.css                  the one file consumers link — @import list only
tokens/
  fonts.css                 Instrument Sans / DM Sans / DM Mono (Google-hosted)
  colors.css                color contract + alpha ramps
  themes.css                the twelve scheme scopes
  typography.css            scale, tracking, weights, semantic type roles
  spacing.css               4px scale, page and section rhythm
  shape.css                 radii, border weights, the two shadows, motif fields
  motion.css                durations, easing, hover/press constants
  base.css                  element defaults, .cm-label, .cm-invert, .cm-container
assets/
  icons/icons.css           Font Awesome Pro webfont route (kit fde87cf732)
  icons/sprite.svg          166 icons as <symbol>s
components/…                see §6
ui_kits/…                   see §7
templates/…                 see §10
guidelines/…                specimen cards, scheme gallery, scheme switcher
thumbnail.html              homepage tile
readme.md                   this file
```

---

## 6. Components

53 components in nine groups. Each has `<Name>.jsx`, `<Name>.d.ts` and
`<Name>.prompt.md`; each directory has one `@dsCard` HTML showing its states.

**core/** — `Icon`, `Button`, `IconButton`, `Badge`, `Tag`, `Card`, `StatTile`, `Divider`, `Avatar`

**forms/** — `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`

**navigation/** — `TopBar`, `SideNav`, `Tabs`, `Breadcrumb`, `Pagination`, `Menu`

**feedback/** — `Alert`, `Toast`, `Modal`, `Tooltip`, `ProgressBar`, `Spinner`, `EmptyState`

**data/** — `DataTable`, `KeyValueList`, `BarChart`, `DonutChart`, `Legend`

**chrome/** — `MacWindow`, `WindowsWindow`, `LinuxWindow`, `IOSFrame`, `AndroidFrame`

**mobile/** — `AppBar`, `TabBar`, `ListRow`, `Sheet`, `FAB`, `SegmentedControl`

**game/** — `HudPanel`, `ResourceMeter`, `AbilitySlot`, `ObjectiveTracker`, `GameMenuItem`

**editorial/** — `PullQuote`, `Figure`

Usage:

```html
<link rel="stylesheet" href="styles.css">
<script src="_ds_bundle.js"></script>
<script type="text/babel">
  const { Button, Card, DataTable } = window.ColorfulMinimalistDesignSystem_4eff31;
</script>
```

### Intentional additions
No source defined a component inventory, so the set was authored from the brief. Three
groups exist only because the brief named the surfaces they serve, and are flagged here so
nobody mistakes them for observed components:

- **`chrome/`** — the brief asks for window chrome for macOS, Windows and Linux plus iOS and
  Android shells. None appeared in the references; the frames follow each platform's real
  conventions (control placement, bar heights, corner radii) but are drawn in this system's
  vocabulary and colored from theme tokens rather than platform palettes.
- **`game/`** — the brief asks that the existing design be applied to game UI without
  drifting toward game-industry convention. These five components are therefore the flat
  system with two concessions: translucent panel fills, and one chamfered corner.
- **`core/Icon`** — a wrapper so the Font Awesome glyph set is reachable from JSX without a
  network request.

---

## 7. UI kits

Five kits, one per surface named in the brief. Each is a click-through recreation built
from the components above — no component is re-implemented inside a kit.

| Kit | Entry | Screens |
| --- | --- | --- |
| **Web** | `ui_kits/web/index.html` | Marketing home (color-field hero, work grid, stats band, services, CTA), work index with filters, editorial article, pricing + contact. Nav is live. |
| **Desktop app** | `ui_kits/desktop/index.html` | "Ledger" — dashboard, file library with inspector, settings. Switchable macOS / Windows / Linux chrome. Compose modal and toast are live. |
| **Mobile app** | `ui_kits/mobile/index.html` | iOS (large title, bottom tabs, detail push, filter sheet) and Android (app bar, FAB, compose sheet) side by side. Both clickable. |
| **Game UI** | `ui_kits/game/index.html` | Main menu, in-game HUD over a flat color-band scene stand-in, loadout screen. |
| **Print** | `ui_kits/print/index.html` | A3 exhibition poster, A4 journal spread, A4 quarterly report. Shown at reduced scale; body copy never below 12pt. |

Each kit directory has its own `README.md` covering what it covers and what it fakes.

**Wordmark.** All five kits set the brand name in Instrument Sans 700 with tight tracking,
because the sources contained no mark. Options are shown in
`guidelines/brand-wordmark.html`: plain type, type in an ink capsule, a pill monogram, and a
square color-field monogram. Substitute the client's real logo before use — do not treat
the monogram as a mark.

---

## 8. Iconography

**Font Awesome Pro 7.3.1**, the client's kit `fde87cf732`. Nothing was drawn by hand and no
substitute icon set is used.

**Weights carry meaning.**
- `fa-regular` — the default for all UI: nav, toolbars, table actions, form affordances.
- `fa-light` — display and marketing use at 1.5em and above.
- `fa-solid` — filled states, status dots, chart legends, and the entire game HUD.
- `fa-brands` — platform marks only (`apple`, `windows`, `linux`, `android`, `github`, `figma`).
- `fa-thin` and `fa-duotone` are not used.

**Three delivery routes, all present in the project.**

1. **JSX** — `Icon` (`components/core/Icon.jsx`). 166 icons with their real Font Awesome
   path data baked in, rendered as inline SVG. No network, works offline, survives static
   capture. `<Icon name="arrow-right" />`, `<Icon name="bolt-solid" />`,
   `<Icon name="apple-brand" />`. `ICON_NAMES` lists the set.
2. **Webfont** — `assets/icons/icons.css`, which imports the kit's Pro CSS and gives the
   *full* Pro library on a web page: `<i class="fa-regular fa-house"></i>`. Link this file,
   not `styles.css`, and only on pages that need it.
3. **Sprite** — `assets/icons/sprite.svg`, the same 166 icons as `<symbol>`s:
   `<svg class="cm-icon"><use href="assets/icons/sprite.svg#bell"/></svg>`.

**Production embed.** On a domain allow-listed in the kit, the canonical snippet is the
kit's own loader:

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

**Flagged substitution — none, but one workaround.** The kit's JS loader does not complete
its SVG-replacement pass inside sandboxed preview frames, so this project uses the kit's
**webfont CSS** and a baked path map instead of the JS embed. Same kit, same Pro icons, same
license; only the delivery differs. Nothing was swapped for a free set.

**Sizing and color.** Icons inherit `currentColor` and are sized in `em` so they track the
text beside them. UI icons are 13–19px; never below 12px. Display icons are 22–44px.
An icon is never the only label on a control — `IconButton` requires a `label`.

**Emoji: not used.** Unicode characters are used as punctuation (`·`, `—`, `–`) and never as
icons.

---

## 9. Caveats

- **No client fonts were supplied.** Instrument Sans, DM Sans and DM Mono are Google Fonts
  chosen to match the references' geometric-grotesque feel. `tokens/fonts.css` imports them
  from Google; if you need self-hosted binaries, drop them into `assets/fonts/` and replace
  that file with local `@font-face` rules. The compiler reports "Fonts: none" because the
  `@font-face` rules live behind a remote `@import` — that is expected, not a fault.
- **No logo exists.** See §7.
- **No photography or illustration ships.** `Figure` placeholders describe the intended
  picture instead.
- **The references were screenshots only.** No source code or Figma file was available, so
  numeric values (paddings, radii, sizes) are authored to be internally consistent rather
  than measured from an original.

---

## 10. Templates

Starting folders a consuming project can copy. Each is a Design Component whose sibling
`ds-base.js` loads this system; changing the `base` line in that file is the only edit
needed to re-point it at a bound copy.

| Template | Entry | Gives you |
| --- | --- | --- |
| Marketing page | `templates/marketing-page/MarketingPage.dc.html` | Sticky header, color-field hero with the shape composition, 2-up work grid, inverted stats band, accent CTA, inverted footer |
| App dashboard | `templates/app-dashboard/AppDashboard.dc.html` | Dark 248px rail, search + primary action header, 4-up stat tiles, bar chart with legend, donut, data table |

---

## 11. Guidelines cards

38 specimen cards populate the Design System tab, grouped as **Colors** (accent fields,
neutrals, status, chart ramp, text-on-color, inverted section, the twelve schemes, gallery,
switcher), **Type** (display, hero sizes, body, micro-label, pairing, weights), **Spacing**
(scale, section rhythm), **Shape** (radii, rules, shadows, motifs), **Motion** (durations and
easing), **Brand** (wordmark, iconography), **Components** (one per group), and one card per
UI kit under **Web / Desktop / Mobile / Game / Print**.

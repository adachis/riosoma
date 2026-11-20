# Neumorph — design system

Neumorph is a **soft-UI (neumorphic) design system**: one surface colour shared by the page and
every component, a single light source fixed at the top-left, and depth carried entirely by a pair
of opposing shadows — a light highlight above-left, a dark shade below-right. Interaction flips
that pair inward so the element looks dented into the page.

It is built to be applied to five very different surfaces without changing its own rules:

1. **Web** — marketing pages, article/journal layouts, pricing, in-browser consoles.
2. **Desktop apps** — macOS, Windows and Linux window chrome around one shared app body.
3. **Mobile apps** — iOS and Android, with each platform's own conventions respected.
4. **Video game UI** — HUDs, inventories and main menus built from the *same* wells and pucks, not re-styled toward conventional game-UI tropes.
5. **Print & layout** — reports, editorial spreads and posters, where shadows become tone steps.

## Sources this system was derived from

This system was built **from references, not from a codebase or Figma file.** Nothing here is a
copy of any source; no supplied imagery, branding, names or copy was used.

| Source | What it contributed | Access note |
| --- | --- | --- |
| `https://neumorphic-ui.webflow.io/` | High-level layout and component inventory of a neumorphic component library | Public demo site; not accessed as code |
| `https://www.setproduct.com/blog/neumorphism-design-guide` | Anatomy of the style, the dual-shadow CSS recipe, radius range (12–20px), the accessibility critique and the 7:1 contrast floor this system adopts | Public article; read in full |
| 18 reference images in `uploads/` | Component vocabulary observed across many neumorphic mockups: rotary dials, vertical faders, round transport pucks, inset wells, pill switches, notched sliders, dark-surface variants, embossed poster covers | Uploaded by the user. **Deliberately not used as assets** — inspiration only |

**No logo, wordmark file or brand asset was supplied.** Per the brief, none was invented: wherever a
mark would go, the name "Neumorph" is set in the display face (Outfit 800, −0.025em). See
`guidelines/brand-wordmark.card.html` for the four approved lockups.

## Index

| Path | What's there |
| --- | --- |
| `styles.css` | The single entry point consumers link. Imports only. |
| `tokens/` | `fonts.css`, `palettes.css` (all 13 schemes), `typography.css`, `spacing.css`, `elevation.css`, `motion.css` |
| `css/` | Component stylesheets, split by concern, plus `print.css` |
| `components/core/` | Button, IconButton, Card, Badge, Tag, Avatar (+AvatarGroup), Divider, ThemeSwitcher |
| `components/forms/` | Field, Input, Textarea, Select, Checkbox, Radio (+RadioGroup), Switch, Slider, SegmentedControl, Stepper, Knob |
| `components/navigation/` | Tabs, Breadcrumbs, Pagination, MenuList, NavRail (+Sidebar), TabBar, Topbar |
| `components/feedback/` | Dialog, Toast (+ToastStack), Alert, Tooltip, ProgressBar, ProgressRing, Spinner (+Skeleton) |
| `components/data/` | StatTile, ListRow (+List), DataTable, Gauge |
| `components/chrome/` | WindowChrome (mac / windows / linux), PhoneShell (ios / android) |
| `components/game/` | MeterBar, SkillSlot (+SlotBar, SlotGrid), RadialGauge, HudPanel |
| `ui_kits/web/` | Landing, pricing, article, dashboard — one shell, live theme switching |
| `ui_kits/desktop/` | Neumorph Studio in all three window chromes; mixer + library panels |
| `ui_kits/mobile/` | iOS and Android side by side: rooms, player, settings |
| `ui_kits/game/` | HUD, inventory, main menu (defaults to Midnight Gold) |
| `ui_kits/print/` | Letter report, editorial spread, 18×24in poster (defaults to Marigold) |
| `templates/` | Five copy-and-go starting folders consuming projects pick from: `web-page`, `desktop-app`, `mobile-screen`, `game-hud`, `print-report` |
| `guidelines/` | 19 foundation specimen cards — colour, type, depth, spacing, motion, brand, iconography |
| `thumbnail.html` | Homepage tile |

Each `templates/<slug>/` folder holds a Design Component entry plus a `ds-base.js` that points at
this system. In a consuming project, edit the one `base` line in `ds-base.js` to point at the bound
`_ds/<folder>` tree and everything else resolves.

Every component directory also carries `<Name>.d.ts` (props contract) and `<Name>.prompt.md`
(one-line "what & when", a usage example, and the variants that matter).

### Intentional additions

Nothing in the references defined a component inventory, so the standard set was authored. Three
additions are worth naming:

- **ThemeSwitcher** — a 13-scheme system needs a first-class way to preview and apply schemes. It toggles `neu-theme-<id>` on any container.
- **Knob** — the rotary dial appears in nearly every neumorphic reference and is the style's most characteristic control. Treated as a primitive, not a one-off.
- **WindowChrome / PhoneShell** — shells rather than widgets, but the brief requires window chrome for three desktop platforms and both mobile platforms, so they are primitives here.

---

## Content fundamentals

**Voice: a manual for an instrument, written by the people who built it.** Plain, specific,
slightly technical. It states what a thing does and what it costs. It does not sell.

- **Person.** Second person for instructions ("Pass `label` — the shadow carries no meaning for AT"). First-person plural is avoided. Marketing copy addresses the reader directly but sparingly: "Controls that feel pressed out of the page."
- **Casing.** Sentence case everywhere — headlines, buttons, menu items, field labels. The **only** uppercase is the 11px eyebrow / HUD-title style at 0.13em tracking ("INSTRUMENT PANEL", "HULL", "CHARGE"). Never uppercase a sentence.
- **Length.** Headlines run 3–7 words. Body paragraphs run 2–4 sentences. Captions are one clause. Button labels are 1–3 words and start with a verb: "Run scene", "Commit scene", "Choose Studio".
- **Numbers.** Always concrete, always in the mono face when they change: "41 ms", "14.2 kWh", "412 / 600", "6 / 6". Units are separated and set in the muted tone at a smaller size.
- **Honesty about limits.** The system documents where it fails, in the product copy as well as the docs: "Data-dense tables, long reading flows and screens with several competing calls to action. The soft palette is an instrument finish, not a general-purpose chrome."
- **Emoji: never.** Not in UI, not in docs, not in marketing. Every glyph is Font Awesome.
- **No exclamation marks. No rhetorical questions. No "just", "simply", "effortlessly", "seamlessly".** No "X, not Y" constructions in body copy.
- **Empty states** name the action, not the absence: "Add a zone to start" rather than "Nothing here yet".
- **Errors** say what happened and what happens next: "Hub unreachable — retrying in 30s", not "Something went wrong".

Sample microcopy, verbatim from the kits:

> **Eyebrow** STUDIO · ZONE 2
> **Headline** Controls that feel pressed out of the page.
> **Body** Depth comes only from shadow, never from fill.
> **Button** Commit scene
> **Toast** Scene saved — applied to 4 devices.
> **Alert** Hub offline. Scenes will run locally until it reconnects.
> **Folio** NEUMORPH · SYSTEMS REPORT — Q1 · PAGE 1 OF 6

---

## Visual foundations

### Colour

- **One surface colour per scheme**, used by the page *and* every component. There are no contrasting panels. `--neu-surface` is the whole palette's anchor; `--neu-surface-2` is a ±2% sibling used only for table row hover and print tone steps.
- **Two shadow stops** per scheme: `--neu-light` (highlight) and `--neu-dark` (shade), plus `--neu-dark-strong` for level-4 shadows. In light schemes the highlight is white or near-white. In dark schemes it is a **lighter grey, never white**, and the shade is a **darker grey, never black** — pure stops turn soft moulding into hard plastic.
- **One accent does all interactive work.** `--accent` appears on primary buttons, active tabs, checked switches, slider fills, focus rings and links. `--accent-2` and `--accent-3` are for data only (second series, secondary meters). If an element can be touched, it gets accent; if it cannot, it stays neutral.
- **Four semantics** per scheme (`--success`, `--warning`, `--danger`, `--info`), drawn from that scheme's own palette so status never looks imported.
- **13 schemes**, applied by class: `slate` (default), `spectrum`, `midnight` ◗, `voltage` ◗, `harbor`, `apricot`, `ember` ◗, `lagoon`, `mossneon` ◗, `candy`, `meadow`, `marigold`, `sage`. (◗ = dark scheme.) Each block redeclares the derived aliases and the whole shadow set — a custom property that references another resolves where it is *declared*, so a scheme that only redefined `--neu-*` would leave every alias stuck on Slate.
- **Contrast floor: 7:1 for body text**, above the WCAG AA 4.5:1 minimum. Where the aesthetic wants a lighter grey, the aesthetic loses. `--text-muted` holds 4.5:1+; `--text-faint` is decorative only and never carries meaning.

### Type

- **Display: Outfit** — 800 for display and h1/h2/h3, tracking −0.02em at display size. Geometric and slightly rounded, which suits moulded hardware.
- **UI & body: Manrope** — 500 body, 600 secondary, 700 labels and buttons. **Never below 500** on a soft surface; lighter weights disappear into the shadow.
- **Mono: JetBrains Mono** — every number that changes: meters, readouts, table numerics, folios, keybinds, status strips. `font-variant-numeric: tabular-nums` throughout.
- **Scale:** display 44/1.06 · h1 32/1.14 · h2 24/1.2 · h3 20/1.25 · lead 18/1.55 · body 16/1.6 · sm 14/1.5 · caption 13/1.45 · micro 11/1.35. Body never below 16px on screen, 11pt in print, 24px on a 1920 slide.
- **Fonts are loaded from Google Fonts** via `tokens/fonts.css`. No binaries were supplied — see Caveats.

### Spacing, radii, layout

- 4px base scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96.
- **Soft shadows need room.** 24px is the default gap between raised siblings; anything under 16px lets adjacent shadows collide and read as a single blur.
- Card padding 24 (16 tight, 40 roomy). Stack gap 16. Control gap 12. Grid gutter 24.
- **Radii 8 → 36**: xs 8 (icon tiles), sm 12 (inputs), md 16 (buttons, controls), lg 20 (wells, panels), xl 28 (cards), 2xl 36 (dialogs, sheets), pill 999 (chips, rails, tracks). Corners are restrained on purpose — sharp breaks the moulded illusion, and 24–32px everywhere overshoots into balloon territory.
- Control heights 36 / 44 / 56. **Hit targets never below 44px.**
- Fixed elements: `Topbar` (72px, optionally floating with 16px margins), `NavRail` (76px), `Sidebar` (264px), mobile `TabBar` (56px rows). Sticky article sidebars pin at 24px.

### Depth system

Four raise levels and their inset twins — distance and blur scale together:

| Level | Geometry | Used for |
| --- | --- | --- |
| 1 | 3px / 7px | Badges, chips, tags, rail hovers, table rows |
| 2 | 6px / 14px | Buttons, icon pucks, switches, stat tiles |
| 3 | 10px / 24px | Cards, sidebars, rails, sheets |
| 4 | 16px / 38px (strong shade) | Dialogs, toasts, floating menus, device shells |
| Dish | Raise 2 + a 2px inner dip | Knob faces, radial hubs, player platters |
| Flush | 1px inset hairline | Disabled controls |

**Inner vs outer.** Outer shadow = the element sits on top of the page. Inset = the element is a
container for something else (input wells, tab trays, lists, sliders, table wraps) **or** it is
being pressed. Hierarchy is built from raise-versus-inset, never from a second fill colour.
A raised card must never contain another raised card — put a sunken well between them.

There are no protection gradients and no capsules over imagery in this system; text always sits on
the flat surface. Blur is used in exactly one place: the 6px `backdrop-filter` on the dialog scrim.
Transparency is used only for the shadow stops' `color-mix` derivatives (hairlines, washes, glows) —
never for panels.

### States

| State | Treatment |
| --- | --- |
| Hover | `translateY(-1px)` + next raise level up. Ghost variants gain an accent wash instead. |
| Active / pressed | `translateY(0)` + the **same shadow flipped to inset**. This inversion is mandatory — without it a press feels dead. |
| Focus-visible | 2px accent ring plus a 3px accent wash halo, on top of the resting shadow. Never a soft glow alone. |
| Selected / current | Inset shadow + accent-coloured label or icon. Colour and ARIA carry state; shadow alone never does. |
| Disabled | Flush hairline, `--text-faint`, no transform. |
| Checked (switch, checkbox) | Accent fill on thumb or box + `aria-checked`. |
| Loading | Inset well with a single accent arc (Spinner) or an inset block with a highlight sheen (Skeleton). |

### Motion

- `--ease-press` `cubic-bezier(.34,.8,.28,1)` at **160ms** — buttons, toggles, slots.
- `--ease-soft` `cubic-bezier(.4,.14,.3,1)` at **240ms** — surface, colour and shadow settles.
- `--ease-out` `cubic-bezier(.22,1,.36,1)` at **380ms** — modals rising, slider and progress fills.
- **Nothing bounces, nothing overshoots.** The only entrance animations are `neu-fade` (scrim) and `neu-rise` (14px + 0.97 scale). Spinner and skeleton loops are linear. All durations collapse to 0 under `prefers-reduced-motion`.

### Imagery

The system ships **no photography or illustration**, and none was generated. Image areas in the
kits are labelled placeholders that state what belongs there ("3:2, warm neutral, soft directional
light"). When real imagery is added, the guidance is: warm-neutral, low-contrast, single soft
directional source matching the top-left lamp, no hard specular highlights, no grain. Photos sit in
a 20px-radius inset well so they read as set into the surface rather than pasted on.

---

## Iconography

- **Font Awesome, kit `fde87cf732`**, loaded from `https://kit.fontawesome.com/fde87cf732.js`. This was the user's own kit and is the system's only icon source.
- **`fa-solid` is the default.** `fa-regular` is used only for unchecked/outline states (window maximise glyph, empty circles). `fa-brands` for platform and social marks.
- Every component that takes an icon takes a **Font Awesome class string** (`icon="fa-solid fa-bolt"`), never an SVG node — so consumers swap styles without touching component code.
- Icons sit in one of two containers: a **36–46px inset tile** (radius 12, muted colour) for decorative/labelling use, or **inside a raised puck** (`IconButton`, radius 50%, accent on press) when interactive. Bare icons appear only in `ListRow` leads and trailing chevrons.
- Icon size tracks the type scale: 1em of the parent, so a 14px button label gets a 14px glyph. HUD and transport glyphs run 16–26px.
- **No hand-drawn SVG. No emoji. No Unicode glyphs as icons** — the one exception is the "…" in `Pagination`, which is text, not an icon.
- No icon files are vendored into `assets/`: the kit is CDN-hosted and versioned by Font Awesome. Consumers offline should self-host the kit rather than substitute another set.

Full glyph inventory in use: see `guidelines/iconography.card.html`.

---

## Using it

```html
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
<script src="_ds_bundle.js"></script>
```

```jsx
const { Button, Card, Switch, ThemeSwitcher } = window.NeumorphDesignSystem_e23090;
```

Apply a scheme by putting `class="neu-theme-voltage"` on `<html>`, `<body>`, or any container —
schemes nest, so two schemes can sit side by side on one page.

### Rules that are not optional

1. Surfaces match the page. Depth comes from shadow, never from fill.
2. The light is at the top-left. Every element on screen agrees.
3. Every interactive element carries a non-shadow cue: accent colour, hairline, or accent label.
4. Pressed state flips the shadow to inset **and** sets the matching ARIA attribute.
5. Body text clears 7:1. Hit targets clear 44px. Focus is a visible 2px accent ring.
6. Never nest a raised surface inside a raised surface.
7. One accent. Adding a second saturated colour to interactive elements destroys the calm.

### Where not to use it

Data-dense dashboards and long tables, extended reading flows, screens with many competing CTAs,
and any audience where low vision is common. The `DataTable` and `ArticleScreen` in this system
push those limits deliberately so the failure mode is visible rather than theoretical.

---

## Caveats

- **No font binaries were supplied.** Outfit, Manrope and JetBrains Mono are loaded from Google Fonts as the closest match to the reference material's clean geometric sans. If the intended faces differ, send the files and `tokens/fonts.css` is a one-file swap.
- **No logo was supplied**, so none was drawn. The wordmark is plain type.
- **No imagery ships with the system** — placeholders are labelled, not filled.
- The colour-scheme list in the brief contained the first palette twice; it is included once, as `spectrum`.

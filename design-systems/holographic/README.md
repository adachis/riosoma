# Holographic — design system

A frosted-glass, full-spectrum interface system built to run unchanged across five
surfaces: web pages, desktop apps (macOS / Windows / Linux), mobile apps (iOS /
Android), game UI, and print. It ships twelve interchangeable colourways; every
component, every screen, and every specimen page renders correctly in all twelve.

The look: a near-black **field** carrying four soft accent blooms, with **frosted
glass panels** floating over it. Panels are never opaque and never flat — each one
has a hairline stroke, a lit top edge, and a long soft shadow. Colour reaches a
surface only through the material: as a bloom behind the glass, as a one-pixel
iridescent hairline along its edge, or as a spectrum-clipped fill on type and
glyphs. Iridescent 3D primitives and Y2K foil stickers are the system's only
decorative props.

---

## Sources

Everything in this system was derived from one attached asset library, mounted
read-only as `Holographic/`. It is an **asset pack, not a codebase** — no
components, no stylesheets, no product screens. Contents used:

| Source folder | What it gave us |
| --- | --- |
| `glass-morphism-geometric-backgrounds-…/JPG` | The core aesthetic: dark canvas, saturated grainy orbs, translucent glass shapes → `assets/bg/glass-geo-*.jpg` |
| `Files/`, `Files 2/` | Grainy iridescent mesh gradients → `assets/bg/mesh-*.jpg` |
| `10-holographic-foil-backgrounds-…` | Seamless diamond foil tile → `assets/bg/foil-*.jpg` |
| `Holographic 3D shapes collection/` | Transparent-PNG iridescent primitives (cone, torus, sphere, knot…) → `assets/shape/shape-*.png` |
| `Y2k Hologram sticker/SVG/` | Y2K foil sticker set → `assets/stickers/*.svg` |
| `psd-web-interface-mockup-with-glass-morphism-…` | Reference for glass panel treatment on a web hero (mockup JPGs only — read, not shipped) |
| `Hologram-Stickers/Font Links.rtf` | Documented typeface: **Unbounded** |
| `social-media-app-glass-morphism-design-style-…/Social Media App fonts.txt` | Documented typefaces: **Plus Jakarta Sans**, Inter, Montserrat, Cabinet Grotesk, SF Pro Text |
| `glass-morphism-geometric-backgrounds-…/FIG/*.fig`, `social media _ glass envato.fig`, `*.psd`, `*.ai`, `*.eps` | **Not opened** — binary design files with no reader available in this environment. See Caveats. |

Uploaded reference images (`uploads/`) were used for visual orientation only, per
the brief, and are not referenced by any file in this system.

No logo, wordmark, brand name, or product copy exists in the sources. **No logo was
created.** Wherever a mark would go, the word "Holographic" is set in Unbounded with
a spectrum-clipped fill (see `guidelines/brand-wordmark.html`). Do not draw one.

---

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` lines only. |
| `tokens/` | `fonts.css`, `palettes.css` (the twelve colourways), `color.css`, `typography.css`, `spacing.css`, `radius.css`, `glass.css`, `elevation.css`, `motion.css` |
| `base/primitives.css` | `.holo-field`, `.holo-glass-1/2/3`, `.holo-edge`, `.holo-text`, `.holo-eyebrow`, link and focus defaults |
| `base/components.css` | All component styling (`hx-*`), so the JSX stays thin and hover/press/focus are real CSS states |
| `components/` | 43 React primitives in nine groups (list below) |
| `ui_kits/web/` | "Prism" — home, pricing, journal article, app console, sign-in |
| `ui_kits/desktop/` | "Prism Studio" — one editor in macOS / Windows / Linux chrome, plus dialog, palette and preferences window types |
| `ui_kits/mobile/` | "Aperture" — six screens rendered side by side on iOS and Android |
| `ui_kits/game/` | "REFRACT" — title screen, in-run HUD, loadout, pause settings |
| `ui_kits/print/` | Report cover, two-column editorial page, full-bleed poster |
| `guidelines/` | 25 specimen cards: colour, type, glass, spacing, motion, brand, iconography |
| `assets/bg/` | 13 backgrounds — mesh gradients, glass-geometry orb fields, foil tiles |
| `assets/shape/` | 8 iridescent 3D primitives (transparent PNG, 560px) |
| `assets/stickers/` | 10 Y2K foil stickers (SVG) |
| `thumbnail.html` | Homepage tile |

### Components

**core** — Button, IconButton, Input, Textarea, Select, Checkbox, Radio, Switch, Slider
**surfaces** — GlassPanel, Card, Sheet, Dialog, Divider, Sticker
**data** — Badge, Tag, Avatar, ProgressBar, RingMeter, StatTile
**navigation** — NavBar, SideNav, Tabs, SegmentedControl, Breadcrumbs, Pagination
**feedback** — Toast, Tooltip, Spinner, EmptyState
**chrome** — DesktopWindow, PhoneFrame, StatusBar, TabBar, AppBar
**game** — VitalBar, AbilitySlot, GameMenu, Crosshair
**print** — PrintSheet
**theme** — ThemeSwitcher

Each directory holds `<Name>.jsx`, `<Name>.d.ts`, `<Name>.prompt.md`, and one
`@dsCard`-tagged preview HTML.

#### Intentional additions

The sources define no components at all, so the whole inventory is authored. Two
choices worth flagging:

- **`ThemeSwitcher`** is a documentation control, not product UI. It exists so all
  twelve colourways can be audited in place. Do not ship it inside an interface.
- **JetBrains Mono** is an added third typeface. The source font manifests name no
  monospace, but the system needs one for ammo counts, timers, wavelengths, token
  names and tabular figures.

---

## Visual foundations

**Colour.** Every colourway sets only five things: a dark anchor (`--tone-deep`),
four accents, the ink that sits on accent fills, and a spectrum stop list. Canvas,
glass, text, strokes and gradients all derive from those with `color-mix()`. Switch
colourway by setting `data-theme` on `:root` or any subtree.

Status colours (`--status-pos/neg/warn/info`) are deliberately **palette-independent**
— twelve palettes cannot each carry four legible statuses, so status reads the same
everywhere and only its glow picks up the theme.

**Type.** Unbounded for display (500–700 weight, `-0.03em` tracking, never lighter
than 500 at large sizes). Plus Jakarta Sans for everything read in sentences — 17px
/ 1.45 for long-form, 15px for UI. JetBrains Mono, tabular, for figures. Ten steps,
11px to 104px. Eyebrows are 11px semibold uppercase at `0.18em`.

**Backgrounds.** Not images by default. `--field` is four accent radials over
`--canvas-void`, `background-attachment: fixed`, so panels appear to move across the
field rather than carry it. Film grain sits on top at 5.5% in overlay blend, because
every gradient in the source library is dithered and clean gradients look synthetic
beside them. Real imagery (`assets/bg/`) appears only as media inside a panel, as a
game backdrop, or as a poster ground — always under a protection gradient before
text sits on it.

**Transparency and blur.** Three tiers: 10px blur for ambient chrome (rails, tab
strips, table headers), 22px for content panels and cards, 40px for anything over
content (sheets, dialogs, toasts, popovers). Saturation is fixed at 165% at every
tier — that is what keeps the field's colour alive through the glass. Inputs invert
the logic: they are *sunken* (darker fill, inset shadow), so a form reads as cut
into the panel rather than stacked on it.

**Borders and shadows.** One hairline (`--stroke-1`, white at 14%) on every panel;
`--stroke-2`/`-3` for chrome and heavy frost. Panels also carry `--glass-lip`, an
inset top highlight — the specular line of a lit edge — and `--glass-floor` beneath.
Four shadow steps, all long, soft and low-opacity. `.holo-edge` adds a 1px spectrum
gradient border via `mask-composite: exclude`; it means *this is the focused, active
or hero element* and belongs on one or two elements per screen.

**Corner radii.** Nothing is square except full-bleed media and print rules. 16px
for controls, 28px for cards, 36px for panels, 48px for sheets, 12px for desktop
windows, 44px for phone screens. Buttons are always full capsules.

**Cards.** Glass panel, 28px radius, 24px padding, hairline stroke, lit edge, soft
shadow. Never a coloured left border. Interactive cards lift 4px and brighten one
frost tier on hover.

**Layout.** 1240px container, `clamp(20px, 4vw, 64px)` page padding, 68ch measure.
Top nav is a floating capsule inset from the viewport edge, never flush. Sidebars are
252px. Fixed elements (nav, kit switcher, toast stack) are tier-3 frost.

**Animation.** Glass has mass: it glides, it never bounces hard. `--ease-glide`
`(.22,1,.36,1)` for panels and sheets, `--ease-out` for hover and colour,
`--ease-spring` for the switch knob and nothing else. Durations 90–800ms; the
spectrum gradient drifts on a 6s linear loop in progress fills. Reduced-motion zeroes
every duration.

**Hover, press, focus.** Hover raises 2px and brightens — solid fills use
`brightness(1.09)`, glass fills step up one frost tier, ghost buttons gain
`--glass-fill-1`. Press sinks to `scale(.985)` with a slight desaturation. Focus is a
two-ring shadow: a dark spacer ring then a 78%-opacity accent ring, so it reads on
both light and dark grounds. Game menu items slide 10px right on hover and pick up
the iridescent stroke — the same language, scaled up.

**Imagery.** Cool-leaning and saturated: violet, magenta, cyan, with warm oranges
used as a counterpoint rather than a base. Always grainy, never crisp. Never
recolour a 3D prop or a foil texture — they are physical captures, and tinting them
breaks the conceit.

**Protection vs capsule.** Text over imagery gets a linear protection gradient (top
and bottom, `rgba(4,5,11,.32–.86)`). Small floating read-outs over imagery get a
glass capsule instead. Never both.

---

## Content fundamentals

**Register.** Matter-of-fact and physical. The system describes what something *is*
and what it *does*, in the vocabulary of optics — field, bloom, foil, frost, edge,
diffraction, wavelength. It does not describe how it feels.

**Person.** Second person for instructions and empty states ("Invite a collaborator
and their threads will land here"). Third person, no subject, for descriptions
("Records how light met a surface"). First person plural only where a human is
genuinely speaking ("Talk to us").

**Casing.** Sentence case for everything readable: headlines, buttons, nav links,
card titles, menu items, tooltips. UPPERCASE with `0.18em` tracking only for
eyebrows, micro-labels, form labels, stat labels, and mono footers. Never title case.
Game screens are the one exception: the game title is set in caps as a display
device, not as a casing rule.

**Length.** Headlines under 8 words. Body paragraphs 2–4 sentences. Card body one or
two sentences. Empty states: one sentence of explanation, one action, nothing else.
Tooltips one to four words, no full stop. Badge labels one or two words.

**Numbers.** Always figures, never spelled out. Always with a unit or a qualifier
(`532nm`, `41s`, `24.8k`, `68 / 100`, `build 4.2.1188`). Deltas always signed
(`+12.4%`, `-6.1%`).

**Punctuation.** Middle dot ` · ` separates metadata (`Spectral · 2m ago`). Em dashes
sparingly, for a genuine aside. No exclamation marks. No trailing full stop on
labels, badges, or single-clause captions.

**What it never does.** No emoji, anywhere — not in copy, not in UI, not as icons.
No exclamatory marketing ("Blazing fast!", "Supercharge your…"). No metadiscourse
("Here's why this matters"). No "just", "simply", or "easily". No lorem ipsum: every
string in this system is real, specific, and finite.

**Examples in use.**
- Hero: "Light, sorted into its parts"
- Sub: "Prism is a colour engine for interface teams. Author one spectrum, render it across twelve colourways."
- Button: "Open the console" · "Read the notes" · "Choose Atelier"
- Eyebrow: "Field notes 04" · "Live spectrum" · "Workspace · Atelier"
- Empty: "Nothing shared yet — when a studio shares a colourway with you it lands here."
- Toast: "Lagoon build finished · desktop · 41s · 12 surfaces"
- Status: "Live" · "Building" · "Failed" · "Draft"

---

## Iconography

**FontAwesome is the only icon source.** Kit `559791bdc6`, embedded as:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/css/all.min.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Both lines, in that order. The kit is the intended source; the Free CDN stylesheet
ahead of it is a safety net so glyphs still paint on any origin the kit has not been
authorised for. **Every glyph used in this system exists in FontAwesome Free 6**, so
nothing depends on Pro.

Every component that takes an icon takes a FontAwesome class string
(`icon="fa-solid fa-bolt"`), never an SVG node or a component reference.

- **`fa-solid`** for controls, navigation, HUD, status glyphs — the default.
- **`fa-regular`** only as the unselected half of a filled/unfilled pair
  (`fa-regular fa-star` beside `fa-solid fa-star`), and for the Windows maximise
  glyph (`fa-regular fa-square`).
- **`fa-brands`** for third-party sign-in only.
- **Spectrum-clipped icons** (background-clip: text over `--spectrum-linear`) appear
  in exactly three places: the active mobile tab-bar glyph, the empty-state glyph, and
  feature-card glyphs on marketing pages. Nowhere else.

Icons inherit their optical size from the control (`0.92em` inside buttons, 18px in
side nav, 14px in dense rows) and always carry `aria-hidden="true"` with the
accessible name on the control.

**No emoji. No Unicode characters used as icons.** The only non-FontAwesome glyphs in
the system are the middle dot ` · ` as a metadata separator and `···` in pagination.

**The source pack contains no icon set.** It contains 10 Y2K foil *stickers*
(`assets/stickers/`), which are decoration, not iconography — use them through the
`Sticker` component, one or two per screen, always tilted. Copied in as SVG; nothing
was drawn or reconstructed.

---

## Using this system

Link one file:

```html
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/css/all.min.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Put the field on a wrapper, set a colourway, and compose:

```html
<html data-theme="lagoon">
  <body>
    <div class="holo-field">
      <div class="holo-glass holo-edge" style="padding: var(--s-8)">…</div>
    </div>
  </body>
</html>
```

For light grounds (documents, print, pale-frost screens) set
`data-surface="light"` on the subtree — every token flips, including glass fills and
shadows. `PrintSheet` does this for you.

---

## Caveats

1. **Binary design files were not read.** The source pack contains two `.fig` files,
   six `.psd` files, and several `.ai`/`.eps` files. This environment has no reader
   for them, so they were skipped; the system was derived from the flattened JPG/PNG
   exports and the pack's own font manifests. If those `.fig`/`.psd` files contain
   layer structure, exact values, or components worth matching, re-attach them in a
   readable form and this system can be corrected against them.
2. **Fonts are loaded from Google Fonts, not shipped as files.** Unbounded and Plus
   Jakarta Sans are the pack's documented faces and both are on Google Fonts, so
   `tokens/fonts.css` imports them from there rather than bundling binaries. The pack
   also names Cabinet Grotesk (not on Google Fonts, licence-restricted) and SF Pro
   Text (Apple, not redistributable) — neither is used. If you have licensed files
   for those, drop them in and the display face can be swapped.
3. **JetBrains Mono is a substitution**, not a source font — see Intentional
   additions above.
4. **No logo exists.** The wordmark is type. Nothing was drawn.
5. **Icons stay inside FontAwesome Free 6.** Kit `559791bdc6` is loaded on every page,
   but no glyph in the system depends on Pro, so the kit can be swapped or removed
   without breaking anything. Two originally Pro-only glyphs were replaced during the
   build: the game HUD's ammo icon (`fa-gun` → `fa-bullseye`) and its weapon-slot
   indices (`fa-1/2/3` → mono digits, which read better anyway).

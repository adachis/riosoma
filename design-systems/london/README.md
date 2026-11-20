# London Design System

A public-information design language: bold flat colour, one heavy geometric display face, thick keylines,
square corners and hard printed-ink shadows. It comes from the tradition of transport wayfinding and
mid-century British poster design — signage that has to be read at a glance, from a distance, at speed —
and it is applied here, unchanged, to five very different media.

**Products covered**

| Surface | Kit | Entry |
| --- | --- | --- |
| Web pages | `ui_kits/web/` | Marketing home, live status, report article, fares |
| Desktop apps | `ui_kits/desktop/` | One operations tool in Mac, Windows and Linux chrome |
| Mobile apps | `ui_kits/mobile/` | Four screens, iOS and Android conventions side by side |
| Game UI | `ui_kits/game/` | Title, HUD, pause inventory, dialogue |
| Print & layout | `ui_kits/print/` | Service poster, report page, timetable leaflet |

The sample product used throughout is a fictional city transport network ("the Loop", "Old Market",
"Riverside"). It exists to exercise the system; none of it is a real operator, and no real operator's
identity, naming or copy appears anywhere in this project.

## Sources given

- A folder of 25 uploaded reference images (`uploads/`): transport signage photographs, mid-century
  public-information posters, government campaign layouts, a design-magazine cover, and contemporary
  editorial identity work. Read for aesthetic direction only.
- Twelve colour palettes supplied as coolors.co URLs. All twelve are implemented verbatim as
  `data-theme` schemes; see COLOUR SCHEMES below.
- A Font Awesome kit id (`559791bdc6`) for iconography.

No codebase, Figma file or slide template was provided, so the component inventory below is an
authored standard set sized to the five target media rather than a transcription of an existing library.

**Rules observed:** none of the uploaded images are used in the system; no name, mark, logo, wordmark,
colour pairing-as-identity or copy from any reference appears in it. The system is a new design in the
same tradition, not a reproduction of any of them.

## CONTENT FUNDAMENTALS

The voice is a public authority that respects your time. Instruction first, explanation second, personality last.

- **Person.** Address the reader as *you*; the organisation is *we*, and only when it is doing something:
  "We're clearing a signal fault." Never "our team", never "we're excited".
- **Mood.** Declarative. State the fact, then the consequence, then what to do:
  *"No service between Old Market and Quay. Replacement buses are running. Allow twenty extra minutes."*
- **Length.** Headlines under 8 words. Body sentences under 20. One idea per sentence, one job per screen.
- **Casing.** Sentence case for headlines, body and buttons ("Show routes", "Plan a journey").
  UPPERCASE only for the three typographic devices that are set in caps by rule: name plates,
  mono labels/eyebrows, and game menu items. Never uppercase a sentence.
- **Numbers.** Always numerals, always specific: "3m 40s", "94.2%", "£8.90", "09:12". Times are 24-hour.
  Units are spelled out on first use in body copy, abbreviated in tables.
- **Buttons.** Verb + object, two or three words: "Show routes", "Buy a pass", "Check status".
  Never "Submit", "Learn more", "Click here".
- **Errors and empty states.** Say what happened and what to do next, in that order, without apology:
  *"Trip 4471 departs before its previous arrival at Old Market."* /
  *"No saved routes. Save a journey and it will appear here."*
- **Emoji.** Never — not in UI, not in marketing, not in game copy. Icons carry that load.
- **Words to avoid.** seamless, effortless, journey (as a metaphor), unlock, elevate, empower,
  "we're thrilled", exclamation marks in UI copy, questions used as headlines.
- **Titles.** Noun phrases, not gerunds: "Live status", not "Checking your status".

## VISUAL FOUNDATIONS

### Colour
Two loads carry every layout: **ink** (the darkest value, used for type, keylines and inverse fields) and
**brand** (one saturated accent, used for the primary action, the disc motif and one field per view).
Everything else is paper. Five accent slots (`--accent-a`…`-e`) exist for lines, categories and charts —
they are never used for interactive state. Semantic colour is reserved strictly for status
(`--success`, `--warning`, `--danger`, `--info`) and never decorative.

Rule of thumb: **one brand field per view**, at most two background colours per document, and no
colour-on-colour type below 4.5:1. Type on brand and ink fields is always full-opacity paper or
`--on-brand`, never an alpha-muted mix.

**No gradients anywhere.** No bluish-purple anything. Colour arrives as flat blocks with hard edges;
where several colours meet, they meet in a flush band (`.ldn-swatchband`), never a blend.

### Type
- `--font-display` **Archivo** (400–900, variable width) — display, headings to h2, plates, stat values,
  game menus. Set at 900 for display, tracking `-0.03em`, leading `0.92`.
- `--font-text` **Hanken Grotesk** (300–900) — body, labels on controls, h3/h4. 16px/1.5 default, 66ch measure.
- `--font-mono` **IBM Plex Mono** — every label, eyebrow, time, code, count and table figure.
  11px uppercase with `0.12em` tracking is the system's "small caps".

Display type is set in short stacked lines (three or four words per line) as posters are, not in long
measures. The name plate is the one place letterspacing goes wide (`0.18em`).

### Space and layout
4-based scale from 2px to 128px (`--sp-1`…`--sp-14`), 12-column grid, 24px gutter, 1200px container.
Cards pad 24px, stacks gap 16px, control rows gap 12px. Print uses 6–8mm gutters on a 12-column
editorial grid. Fixed elements: the 72px navbar, the mobile tab bar, the desktop status bar, and the
bottom-centre toast stack. Nothing else is sticky.

### Backgrounds
Flat colour fields only — paper, sunken paper, ink, or brand. **No** photographic backgrounds behind type,
no repeating patterns, no textures, no noise, no gradients. Full-bleed imagery is allowed as its own block
(hero half, card media, poster panel) with type beside it rather than over it. When type must sit over an
image, it sits on a solid plate, not a protection gradient.

### Borders, corners, shadows
Corners are square: `--r-0`/`--r-1` (0–2px) for everything structural; `--r-pill` only for tags, status
badges and the switch track; `--r-round` for discs and avatars. Borders are the primary separator, at
1 / 2 / 3 / 6 / 12px (`--bw-hair`…`--bw-4`); a 6px brand rule opens a section, a 12px brand bar tops an
emphasised card.

Elevation is **hard offset shadow in ink** — `2px 2px 0`, `4px 4px 0`, `8px 8px 0` — like a printed
second impression. Soft blur appears in exactly two places: floating overlays (`--shadow-overlay`) and
toasts (`--shadow-pop`). There are no inner shadows, and no shadow is ever coloured except `--shadow-brand`.

### Transparency and blur
Used sparingly and only where something sits over unknown content: the modal veil (62% ink), HUD panel
fills (88% ink / 92% paper so type keeps contrast over any render), and `color-mix` hover/active washes at
6% / 12% ink. Blur is available (`--blur-veil`) but unused in the shipped kits — frosted glass is not part
of this language.

### Motion
100–400ms on `cubic-bezier(.2,0,0,1)` — quick out, settled arrival. No bounce, no spring, no overshoot,
no parallax, no entrance animation on page load. Transitions are limited to colour, border, shadow and
2px transforms. `prefers-reduced-motion` zeroes every duration in `tokens/motion.css`.

### Interaction states
- **Hover** — buttons lift 1px up and left while the shadow grows to 3px (the sheet lifting off the press);
  quiet surfaces take a 6% ink wash; links swap to ink.
- **Press** — the element drops 2px down and right and the shadow goes to zero, so it sits flush.
  No colour change beyond `--brand-2` on primary.
- **Focus** — 2px `--focus-ring` outline at 2px offset; inputs additionally take a 3px `--focus-halo`.
  Focus is never removed.
- **Disabled** — 45% opacity, shadow retained, cursor not-allowed.
- **Selected** — ink fill with paper type (tabs, segmented, tags), or a 3px brand left edge (side nav).

### Imagery direction
Where photography is used it should read as documentary and available-light: cool daylight, high contrast,
no filters, no shallow-focus product shots, no stock-smile portraiture. Illustration, if commissioned,
should be flat vector shapes in the palette with no outlines and no gradients. Nothing here ships with
the system — see `assets/readme.md`.

## COLOUR SCHEMES

Twelve schemes are implemented in `tokens/themes.css`. Each overrides the same eighteen raw values;
every semantic alias re-derives, so applying a scheme is one attribute:

```html
<div data-theme="nightbus"> … </div>   <!-- or on <html> -->
```

`signal` (default) · `spectral` · `nightbus` (dark) · `neon` · `terracotta` · `depot` · `verdant` ·
`mintpunch` (dark) · `sherbet` · `lagoon` · `ledger` · `sage`

Scheme switching is **documentation furniture only**. Each UI kit pins a `ThemeSwitcher` outside the
product frame so every scheme can be previewed; a real product picks one scheme and ships it.
See `guidelines/colors-schemes.card.html` and `guidelines/colors-in-use.card.html`.

## ICONOGRAPHY

- **System:** Font Awesome, kit id `559791bdc6`, loaded from the CDN in every card, kit and page:
  `<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>`
- **Wrapper:** the `Icon` component (`components/core/Icon.jsx`) takes a bare glyph name —
  `<Icon name="train-subway" />` — and maps `style` to the family prefix.
- **Family:** `fa-solid` is the default and carries almost everything; `fa-regular` marks inactive or
  secondary states; `fa-brands` only for third-party marks. Duotone and thin are unused.
- **Size:** icons inherit font-size (1em) and sit at 15px in controls, 18–19px in navigation,
  22–26px in slots and empty states, 44px in card media. Use `fixedWidth` in any vertical list.
- **Colour:** `currentColor` always. Icons never carry their own colour.
- **No hand-drawn SVG.** The system contains no bespoke icon artwork, no PNG icons and no icon sprite.
  If a glyph is missing from Font Awesome, use a word.
- **No emoji, ever**, and no Unicode characters as icons — with three deliberate exceptions used as
  *typographic marks* rather than icons: `&#9662;` in the select chevron, `&#215;` on dismiss buttons,
  and `&#8250;`/`&#9656;` in list rows and breadcrumbs.
- The disc-and-plate motif is **not** an icon and never appears inline with type at icon scale.

**Substitution flagged:** no font binaries or icon assets were supplied. Both the typefaces
(Archivo, Hanken Grotesk, IBM Plex Mono) and the icon set are loaded from public CDNs — see
`tokens/fonts.css`. If you have licensed brand fonts, drop the files in `assets/fonts/` and replace the
`@import` in that file with local `@font-face` rules; the token names will not change.

## Components

48 primitives in eight groups. Every one is `<Name>.jsx` + `<Name>.d.ts` + `<Name>.prompt.md`,
with one `@dsCard` HTML per directory.

**Core** (`components/core/`) — Button, IconButton, Icon, Badge, Tag, Card, Panel, Divider, Avatar, Plate
**Forms** (`components/forms/`) — Field, Input, Textarea, Select, Checkbox, Radio, Switch, Slider, Segmented
**Navigation** (`components/navigation/`) — NavBar, TabBar, Tabs, SideNav, Breadcrumbs, Pagination, StepTracker, RouteList
**Feedback** (`components/feedback/`) — Alert, Toast, ToastStack, Tooltip, Dialog, Progress, Spinner, EmptyState
**Data** (`components/data/`) — DataTable, Stat, ListRow, KeyValue
**Window chrome** (`components/window/`) — MacWindow, WindowsWindow, LinuxWindow
**Game UI** (`components/game/`) — HudPanel, Meter, ItemSlot, GameMenu, DialogueBox, Objective
**Theme** (`components/theme/`) — ThemeSwitcher

### Intentional additions

No source library defined an inventory, so the set above is authored. Three entries are worth calling out
because they are not generic:

- **Icon** — a wrapper over the Font Awesome kit, so glyph names stay declarative and no component
  hard-codes a class string.
- **Plate** / **RouteList** — the two motif components (name plate, disc-and-rail). They are what makes a
  layout recognisably London rather than a generic flat UI.
- **ThemeSwitcher** — documentation-only, added because the brief asks for previewable colour schemes.
  Excluded from product UI by convention, stated in its own `.d.ts` and prompt file.

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` list only. |
| `tokens/` | `fonts`, `colors`, `themes` (12 schemes), `typography`, `spacing`, `shape`, `elevation`, `motion` |
| `css/` | Class layer imported by `styles.css`: `base`, `controls`, `surfaces`, `navigation`, `feedback`, `data`, `chrome`, `game`, `print` |
| `components/` | The 48 primitives, grouped as listed above |
| `ui_kits/web`, `ui_kits/desktop`, `ui_kits/mobile`, `ui_kits/game`, `ui_kits/print` | Click-through recreations; each has its own `README.md` |
| `templates/` | Five starting frames consuming projects can copy: `web-page`, `desktop-app`, `mobile-app`, `game-hud`, `print-poster` |
| `guidelines/` | 23 specimen cards for the Design System tab: colour, type, spacing, brand, print |
| `assets/` | Empty, deliberately — read `assets/readme.md` before looking for a logo |
| `thumbnail.html` | Homepage tile |
| `SKILL.md` | Agent-skill front matter for use outside this project |

## Templates

Five starting frames live in `templates/`, each a Design Component that loads this system through a
sibling `ds-base.js`:

| Template | Entry | What it gives you |
| --- | --- | --- |
| Web page | `templates/web-page/WebPage.dc.html` | Nav bar, split brand hero, accent band, three-card section, ink footer |
| Desktop app | `templates/desktop-app/DesktopApp.dc.html` | Window shell with sidebar, toolbar, stat row, canvas and inspector |
| Mobile app screen | `templates/mobile-app/MobileApp.dc.html` | Phone frame, large-title header, list, bottom tab bar |
| Game HUD | `templates/game-hud/GameHud.dc.html` | 16:9 frame, corner HUD panels, meters, hotbar, objectives |
| Print poster | `templates/print-poster/PrintPoster.dc.html` | A-series sheet: brand masthead, image band, instruction copy, wordmark plate |

Templates carry placeholder copy on purpose — replace the words, keep the structure.

## Using it

```html
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

Then either compose the React primitives, or write markup against the class layer directly
(`.ldn-btn`, `.ldn-card`, `.ldn-plate`, `.ldn-route`…). Both paths read the same tokens, so a
`data-theme` on any ancestor re-colours either one.

Two rules that keep work on-system: **square corners and hard shadows** (if it has a soft drop shadow and
a 12px radius, it isn't London), and **one brand field per view**.

# System 7

A design system for interfaces built out of one bit: black ink on white paper, hard 1px outlines, dithered greys, and bitmap type. It is the grammar of late-1980s and early-1990s graphical computing — rules instead of shadows, inversion instead of highlight colour, dither instead of gradient — rebuilt as tokens and React components, with twelve colour schemes layered on top for work that needs to be more than monochrome.

Use it when you want an interface that feels engineered rather than styled: utilities, tools, dashboards, game HUDs, documentation, editorial pages with a technical voice. It is a poor fit for anything that needs softness, depth or photographic warmth.

## The rules that matter

1. **Everything is an outline.** Containers are 1px ink boxes. There are no rounded cards, no borders in mid-grey, no blurred shadows. The only shadow in the system is a hard 2px offset with zero blur (`--s7-shadow-hard`).
2. **Inversion is the interaction.** Pressed buttons, hovered menu items, focused fields and selected rows all swap ink and paper. Do not add hover lifts, colour washes, opacity fades or transitions — motion tokens exist (`--s7-duration-1`) but the correct value is almost always `0ms`.
3. **Tone comes from dither.** Any surface that needs to read as "grey" is a hard-edged pattern, not a fill: `--s7-pattern-desktop` (50% checker), `--s7-pattern-hatch` (45°), `--s7-pattern-stripes-heavy` (title bars). Never substitute a gradient.
4. **Paper stays light and ink stays dark in every theme.** Colour schemes drive accent, desktop, selection and status only. This is what keeps text contrast intact across all twelve palettes.
5. **Group with rules, not with space.** Reach for a `Separator` or a `DetailsBar` before adding padding or nesting another box.

## Content fundamentals

The voice is the system's own: plain, specific, mechanical, never chatty. It tells you what happened and what it will do about it.

- **Titles are nouns in Title Case.** "Sales by Region". No app name, no path, no colon-suffixed subtitle.
- **Buttons are verbs in sentence case.** "Save", "Open", "Erase Disk". Never "Submit", never "Learn more", never a bare "OK" where a verb would say more.
- **Messages state the fact, then the consequence.** "The disk is full. Delete some files before saving." Two sentences, no apology, no exclamation.
- **Labels drop trailing colons and ALL CAPS.** "File name", not "FILE NAME:".
- **Numbers carry units.** "42 items", "18.1 MB in disk", "4 of 12 files". A bare percentage or a lone integer is not a status.
- **Menu commands stay visible when unavailable** — greyed, not hidden. The presence of the command is information.
- **No emoji, no marketing adjectives, no metaphors.** If a sentence could appear in a press release, rewrite it.
- Copy is set flush left, never justified, never centred except inside dialogs and title bars.

## Visual foundations

### Colour

The base palette is four values: `--s7-white`, `--s7-black`, `--s7-grey` (#A5A5A5), `--s7-darkgrey` (#B6B7B8), plus a six-step greyscale chrome ramp (`--s7-chrome-0` … `--s7-chrome-5`) for bevelled surfaces.

Semantic tokens are what you should actually use: `--s7-paper`, `--s7-paper-alt`, `--s7-ink`, `--s7-dim`, `--s7-disabled`, `--s7-border`, `--s7-accent`, `--s7-accent-2`, `--s7-accent-3`, `--s7-accent-ink`, `--s7-desktop`, `--s7-select`, `--s7-select-ink`, `--s7-ok`, `--s7-warn`, `--s7-danger`, `--s7-info`, `--s7-link`.

**Themes.** Set `data-theme` on `<html>` or any subtree: `spectrum`, `midnight`, `voltage`, `signal`, `apricot`, `harvest`, `lagoon`, `reactor`, `bubblegum`, `seafoam`, `ledger`, `slate`. Omit it for the 1-bit default. `data-invert` flips paper and ink for dark shells and stacks with any theme.

Use accent on at most one element per view — a title bar, a progress fill, a selected row. Colour is punctuation here, not surface.

### Type

Four faces, all bitmap-derived: **Seven Display** (headings), **Seven UI** (all chrome, controls, body), **Seven Small** (12px metadata, status bars, badges), **Seven Mono** (code, paths, numeric columns).

Sizes are a fixed ladder because bitmap glyphs blur at arbitrary sizes: 12 / 14 / **18** / 24 / 32 / 48 / 64px (`--s7-text-xs` … `--s7-text-3xl`). 18px is the default UI and body size; 24px is the title bar. Set `letter-spacing: var(--s7-tracking-tight)` (-0.025em) on body copy and leave `-webkit-font-smoothing: none` alone.

### Space, borders, motion

Spacing runs 2 / 4 / 6 / 8 / 12 / 16 / 24 / 32 / 48 / 64px. Two values do most of the work: **6px** groups related controls (`--s7-grouped-element-spacing`), **8px** separates elements (`--s7-element-spacing`).

Borders: 1px default, 1.5px for fields, 2px for dialogs, 0.1em for windows. Radius is 0 everywhere except the 6px softening on a pressed button. Buttons use SVG border-image frames, so their border-width (`--s7-border-btn`) is part of the drawing — do not override it.

Hit targets: 44px minimum on touch (`--s7-hit-target`); the desktop metrics (20px buttons, 13px checkboxes) are for pointer contexts only.

### Iconography

Icons come from the **Font Awesome free** kit, **solid style only**, at 16–22px:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/css/all.min.css">
```

Pass class strings to `Icon`, `Button icon`, `ListView` rows and `IconGrid` items: `"fa-solid fa-folder"`. Regular, light and duotone styles dissolve against bitmap type — do not use them. Icons are monochrome, inherit `currentColor`, and invert with their row. Never let an icon be the only label on a destructive control. There is no vendor mark in this system; the `MenuBar leading` slot takes a neutral glyph.

## Components

Core — `Button`, `Icon`, `Badge`, `KeyCap`
Forms — `FieldRow`, `TextInput`, `Select`, `Checkbox`, `Radio`, `Slider`
Windows — `Window`, `WindowPane`, `DetailsBar`, `Toolbar`, `StatusBar`, `Separator`, `ScrollBar`
Navigation — `MenuBar`, `Menu`, `Tabs`
Dialogs — `ModalDialog`, `StandardDialog`, `AlertBox`
Feedback — `ProgressBar`, `Note`
Data — `ListView`, `IconGrid`, `IconTile`
Shell — `Desktop`

Each component directory carries a `.prompt.md` with its own usage rules; read that before composing.

**Intentional additions.** `Slider`, `Tabs`, `ProgressBar`, `Toolbar`, `StatusBar`, `Badge`, `Note`, `KeyCap`, `ListView`, `IconGrid`, `IconTile` and `Desktop` are not in the source kit. They are drawn from the era's own control panels and file browsers, and each one is built from the same primitives (1px rule, hard shadow, dither, inversion) rather than importing a modern pattern. Their prompt files say so.

**Deliberate omissions.** No toast, no tooltip card, no accordion, no avatar, no breadcrumb, no carousel, no switch. A switch is a Checkbox; a toast is a StatusBar line or an AlertBox; disclosure is a Tab or a second Window.

## Using it

```html
<link rel="stylesheet" href="styles.css">
<script src="_ds_bundle.js"></script>
<script>const { Window, WindowPane, Button } = window.System7DesignSystem_7b14ed;</script>
```

Class names are available directly for plain HTML: `.s7-window`, `.s7-btn`, `.s7-list`, `.s7-menu-bar`, and so on. Templates in `templates/` are complete starting points for the five contexts this system was tuned for — web pages, desktop apps, mobile, game UI, and print.

## Provenance

Metrics, control drawings and font choices are derived from the open-source **system.css** kit (MIT, Sakun Acharige) supplied with this project; the button, radio, checkmark and scrollbar frames are its SVGs, renamed. Typefaces are public-domain and freely licensed bitmap revivals, renamed here to Seven Display / UI / Small / Mono. Colour schemes are original assignments over twelve supplied palettes. No vendor logo, product name, icon set or screenshot artwork from any reference material is reproduced in this system.

# BitPixel Design System

BitPixel is an interface system for technical products. It comes from a developer-tooling design language: near-black or paper-flat surfaces, hairline rules instead of shadows, monospace micro-labels with zero-padded indices ("001 / capabilities"), terminal chrome, tabular numerals, and exactly one accent colour doing all the signalling. Type carries hierarchy; colour carries state.

It is built to cover five delivery surfaces from one token set and one component library:

1. **Web** — marketing pages, docs, dashboards.
2. **Desktop apps** — window chrome, rails, inspectors, status bars.
3. **Mobile apps** — 44px touch targets, large display titles, bottom sheets.
4. **Video game UI** — HUD panels, notched meters, inventory slots, dialogue, control legends.
5. **Print & layout** — editorial headers, pull quotes, numbered figures, endnotes.

## Sources given for this build

- **Design system name:** BitPixel (supplied by the user).
- **Source inspiration:** `https://www.contentarchitecture.dev/` — used only as a high-level reference for the *register* of the design language (technical, terminal-flavoured, numbered sections, mono labels). Nothing from that site's branding, copy, logo or naming appears here.
- **Iconography:** the user's own Font Awesome kit, `https://kit.fontawesome.com/fde87cf732.js` (kit id `fde87cf732`).
- **Colour scheme variants:** twelve Coolors palettes supplied by the user (one link was a duplicate, so twelve unique palettes are implemented; see *Theme variants* below).
- **No codebase, Figma file, image references, slide deck or logo file was attached.** Everything visual here was authored from the brief. There is therefore **no logo asset** — the brand mark is set in type (see *Brand mark*), and `assets/` holds no imagery.

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` list only. |
| `tokens/` | `fonts.css`, `colors.css` (raw palettes), `themes.css` (12 theme scopes), `typography.css`, `spacing.css`, `shape.css`, `motion.css`, `base.css`. |
| `components/core/` | Button, IconButton, Badge, Tag, Card, Callout, SectionLabel |
| `components/forms/` | Input, Textarea, Select, Checkbox, Radio, Switch, Slider |
| `components/navigation/` | Tabs, SideNav, Breadcrumb, Pagination, CommandBar |
| `components/feedback/` | Dialog, Toast, Tooltip, ProgressBar, Spinner |
| `components/data/` | DataTable, StatTile, CodeBlock, FileTree, KeyValueList, Terminal |
| `components/desktop/` | TitleBar (macOS), TitleBarWindows (Windows), Toolbar, InspectorPanel, StatusBar |
| `components/mobile/` | MobileHeader, TabBar, ListRow, Sheet |
| `components/game/` | HUDPanel, MeterBar, DialogueBox, InventorySlot, KeyCap |
| `components/print/` | PrintHeader, PullQuote, Figure, Footnote |
| `ui_kits/web/` | Marketing site + docs + pricing + changelog, click-through |
| `ui_kits/desktop/` | "Studio" desktop app: explorer, editor, inspector, terminal, ⌘K palette |
| `ui_kits/mobile/` | Mobile app: builds list, build detail, action sheet, settings |
| `ui_kits/game/` | "Relay" sample: live HUD, dialogue, pause menu |
| `ui_kits/print/` | "Field Notes" issue: cover page + feature spread |
| `guidelines/*.card.html` | Foundation specimen cards rendered in the Design System tab |
| `assets/fa-fallback.js` | Icon delivery shim: falls back to the kit webfont CSS if the kit's JS/SVG swap is blocked |
| `assets/theme-switcher.js` | Drop-in theme switcher used by every UI kit example page |
| `thumbnail.html` | Homepage tile |

Every component directory carries `<Name>.jsx`, `<Name>.d.ts` (props contract) and `<Name>.prompt.md` (what & when, usage example, variants), plus one `@dsCard` HTML showing states densely.

## Content fundamentals

**Register.** Matter-of-fact, technical, unhurried. The system describes what something does and what it costs. No hype verbs ("supercharge", "unleash"), no exclamation marks, no rhetorical questions.

**Person.** Product copy addresses the reader as *you*; the organisation is *we* only where accountability is being taken ("we set three numbers per surface"). Marketing headlines avoid both and name the thing: "Interfaces that ship at the speed of your build."

**Casing.** Sentence case for every headline, button, tab, list row and dialog title — "Promote build to production", never "Promote Build To Production". UPPERCASE is reserved for mono micro-labels and only there: eyebrows, table headers, field labels, status badges, HUD labels, running heads. Never uppercase a sentence.

**Numbers and metadata.** Always mono, always tabular. Zero-pad indices and short counts: `001`, `04`, `page 03 / 12`, `build 2481`. Units are set smaller and dimmer than the value: **182** `ms`. Times are 24-hour with seconds in logs (`14:22:07`), ISO dates in changelogs (`2026-08-18`).

**Labels.** Verb-first for actions ("Deploy", "Roll back to 2480", "Purge edge cache"), noun-only for destinations ("Logs", "Environment"). Mono lowercase for terminal-flavoured actions: `run task`, `esc · pause`, `copy`. Status words are single lowercase mono tokens: `passing`, `queued`, `failed`, `live`, `beta`, `stable`.

**Length.** Headline ≤ 12 words. Lead paragraph ≤ 2 sentences. Card body 1–2 sentences. Field hint one clause, ending in a period: "Lowercase, hyphenated." Empty and error states say what happened and what to do next, in that order: "Migration failed. Reverted to revision 2480."

**Emoji: never.** Not in UI, not in docs, not in marketing. Unicode is used only as functional glyphs — `⌘K`, `⏎`, `↑↓`, `/` in breadcrumbs, `>` before a dialogue choice, and the `|/-\` spinner frames. Everything else is a Font Awesome icon.

**Voice examples.**
- Button: "Start free" · "Promote" · "Talk to us"
- Badge: `passing` · `beta` · `v2.4.0`
- Callout: "Rebuilds invalidate the edge cache."
- Toast: "Build 2481 deployed — rolled out to 14 regions." meta `14:22:07 · edge-fra1`
- Docs warning: "Never reference a raw palette token such as `--bp-p2-4` in product code. Aliases carry the theme."
- Pricing fine print: "Seats are counted per active editor per month."

## Visual foundations

**Type.** Three families, no more. **Space Grotesk** for display and headings (600/700, `-0.03em` at display sizes, `-0.015em` at heading sizes, 1.02–1.16 leading). **IBM Plex Sans** for body and UI text (400/500, 15px base, 1.5–1.65 leading, 66ch measure). **JetBrains Mono** for every label, number, path, log line and code block (10–13px, `0.14em` tracking when uppercase, tabular numerals always). The 10px uppercase mono label is the system's connective tissue and appears on almost every surface.

**Colour.** Each theme exposes four surfaces (`bg`, `surface-1/2/3`), two line weights, a three-step text ramp, one accent (plus a hover accent and a secondary accent) and four semantic colours. Rules: one accent per screen; accent means "active, current or interactive", never decoration. Semantic colours only ever indicate state. Text never uses accent for body copy — only for numbers, indices and links. `--bp-accent-ink` is the only legal text colour on an accent fill.

**Theme variants (12).** `midnight` (default), `spectrum`, `voltage`, `ember`, `mint`, `matrix`, `lagoon` are dark; `signal`, `apricot`, `candy`, `cobalt`, `sage` are light. Switch with `data-bp-theme="<name>"` on `<html>` or on any subtree — scopes nest, so a dark app shell can host a light document region (the print kit does exactly this). Print output should always use a light variant.

**Spacing & layout.** 2/4/6/8/12/16/20/24/32/40/56/72/96/128. Page max 1240px, 24px gutters (40px on wide sections), 264px app rail, 32px background grid cell. Control heights 26/34/44px; 44px is also the mobile touch minimum. Fixed elements: sticky 56px web header with an 88%-opacity blurred background; desktop title bar (38px), toolbar (32px) and status bar (24px) are pinned; mobile tab bar is pinned with an 18px home-indicator inset; game HUD is absolutely positioned in the four corners.

**Borders, radii, shadows.** 1px hairlines do the structural work. Radii are near-square: 2px controls, 4px cards and panels, 6px window shells, 10px reserved for bottom sheets, pill only for switches, 0px throughout game UI. Elevation is a meaning, not a decoration: flat for cards and panels, `shadow-2` for toasts and popovers, `shadow-3` for dialogs and sheets. Inner hairline (`--bp-inset-hairline`) instead of an outer shadow when an element must read as inset. Accent glow (`--bp-glow-ring`) appears only on a selected game slot.

**Backgrounds & texture.** No photographic imagery is supplied, and no illustration is invented. Depth comes from two token textures: a 32px hairline grid (`--bp-grid-bg`) behind heroes, CTA blocks, empty figure placeholders and game scenes; and a 3px scanline (`--bp-scanline-bg`) used sparingly over game scenes only. One radial accent-tinted glow is permitted behind a game scene. **No gradients as decoration** — no purple/blue gradient washes, no gradient text, no gradient buttons.

**Transparency & blur.** Only where something floats over content: the sticky web header (88% bg + 8px blur), modal overlays (66% dark / 42% light), game HUD panels (55–75% bg + 3–6px blur), pause menu (78% + 6px blur). Never on a static card.

**Motion.** Fast and mechanical. 90ms hover/press, 140ms control transitions, 220ms bars and reveals, 380ms sheets and dialogs, 700ms only for ambient loops (cursor blink at 550ms, spinner frames at 90ms). Easing is `cubic-bezier(.2,0,0,1)` out; no bounce, no overshoot, no scale-up entrances. All durations collapse to 0 under `prefers-reduced-motion`.

**Hover states.** Filled controls move to `--bp-accent-hover`. Unfilled controls do not change fill lightness — the border becomes accent and the surface steps up one level (`surface-2` → `surface-3`), text goes from `text-2` to `text-1`. Rows tint to `surface-2`. Never opacity-based hover, never a colour ramp on text alone.

**Press states.** `translateY(1px)` and nothing else for buttons; keycaps additionally collapse their 2px bottom border. No shrink-scale, no ripple.

**Focus.** 2px accent outline at 2px offset for keyboard focus; fields add a 3px 18%-accent halo plus an accent border. Focus is never removed.

**Selection & active marks.** Active navigation is marked with a 2px accent edge (left on rails, bottom on underline tabs, top on desktop document tabs and mobile tab bar) plus a surface step — never a filled pill. Selected chips and pages use a 14–16% accent tint with an accent border.

**Imagery.** None supplied. Where a photograph or diagram belongs, `Figure` renders a labelled grid-field placeholder that says so. If imagery is added later, the intended treatment is cool, low-saturation, high-contrast, with visible grain and no colour overlays; crop to hairline-bordered rectangles, never rounded.

**Cards.** 1px `--bp-line` border, 4px radius, `surface-1` fill, flat, 16px padding, optional numbered mono eyebrow, optional footer separated by a hairline. Interactive cards recolour the border to accent on hover and change nothing else.

## Iconography

**Font Awesome is the only icon system**, via the user's kit: `<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>`. Every card, kit page and component icon prop uses kit classes; no icon SVGs were drawn, and no icon assets were copied in because none were supplied.

- **Styles:** `fa-solid` for interface actions and status; `fa-regular` for document/file objects (`fa-regular fa-file-code`, `fa-regular fa-user`); `fa-brands` only for third-party marks (`fa-brands fa-github`).
- **Sizing:** icons inherit `font-size` — 10–11px beside mono labels, 12–13px in controls, 15px in the mobile tab bar, 18px in specimen rows. Never scale a glyph above the display type it sits beside.
- **Colour:** default glyph colour is `--bp-text-3`. Accent is used only for active/selected affordances, directory nodes, semantic states and leading glyphs inside `Callout`/`Toast`. Semantic glyph mapping is fixed: check-circle = ok, triangle-exclamation = warn, circle-exclamation = danger, circle-info = info/neutral, bolt = accent.
- **Recurring glyph vocabulary:** `fa-terminal`, `fa-bolt`, `fa-cube` (build), `fa-code-branch` (branch), `fa-rocket` (deploy), `fa-sliders` (settings), `fa-folder`/`fa-folder-open`/`fa-regular fa-file` (tree), `fa-magnifying-glass`, `fa-chevron-*`, `fa-xmark`, `fa-check`, `fa-ellipsis`, `fa-shield-halved` and `fa-flask` (game items), `fa-gauge` (metrics).
- **Emoji: never.** Unicode glyphs are used only where a key or gesture must be shown literally (`⌘K`, `⏎`, `↑↓`, `⇧⌘P`), for the breadcrumb slash, the `>` dialogue-choice marker and the `|/-\` spinner frames.
- **Brand mark:** none was supplied, so nothing was drawn. Where a logo would go, the wordmark is set in Space Grotesk 700 with "Pixel" in the accent colour (see `guidelines/brand-wordmark.card.html`). `assets/` therefore contains no logo file.

## Substitutions to confirm

- **Fonts.** No font binaries were supplied. Space Grotesk, IBM Plex Sans and JetBrains Mono are loaded from Google Fonts in `tokens/fonts.css` as the closest available match to the intended technical register. Send real licensed files (woff2) and the `@import` becomes local `@font-face` rules.
- **Icons.** No icon assets were supplied; the user's own Font Awesome kit is used as instructed, so this is not a substitution — but it does require the kit script on every page.
- **Imagery and logo.** None supplied; placeholders are labelled as such rather than invented.

## Intentional additions

The brief specified surfaces rather than a component inventory, so a standard set was authored and then extended per surface. Additions beyond the usual web set, each because a listed surface cannot be built without it:

- `SectionLabel` — the numbered mono eyebrow motif, used on every surface.
- `Terminal`, `CodeBlock`, `FileTree`, `KeyValueList`, `StatTile` — technical-product data surfaces.
- `TitleBar` (macOS traffic lights, centered title), `TitleBarWindows` (app glyph, left title, 46×32 caption buttons), `Toolbar`, `InspectorPanel`, `StatusBar` — desktop window chrome.

**Platform chrome is an either/or.** `TitleBar` and `TitleBarWindows` are mutually exclusive: a product picks its platform once and uses only that component. They are never rendered together and never runtime-swapped in shipped UI — the desktop UI kit's macOS/Windows toggle exists purely to preview both.

## Theming

Twelve color schemes live in `tokens/themes.css` as `[data-bp-theme="<id>"]` scopes; `midnight` is also on `:root` as the default. Set the attribute on `<html>` (whole app) or any container (a themed region).

Dark: `midnight`, `spectrum`, `voltage`, `ember`, `mint`, `matrix`, `lagoon`. Light: `signal`, `apricot`, `candy`, `cobalt`, `sage`.

Every component reads semantic tokens only (`--bp-accent`, `--bp-surface-*`, `--bp-text-*`, `--bp-line*`), so a theme change needs no component edits. For demos, add `<script src="assets/theme-switcher.js"></script>` before `</body>`: it mounts a floating swatch bar, sets `data-bp-theme` on `<html>`, persists the choice in `localStorage` under `bp-theme`, exposes `window.bpSetTheme(id)` / `window.BitPixelThemes`, and fires a `bp-theme-change` event. It is a demo control, not a shipping component.
- `MobileHeader`, `TabBar`, `ListRow`, `Sheet` — mobile patterns with 44px minimums.
- `HUDPanel`, `MeterBar`, `DialogueBox`, `InventorySlot`, `KeyCap` — game UI.
- `PrintHeader`, `PullQuote`, `Figure`, `Footnote` — print and layout.

# Filigree — Design System

Filigree is an ornamental design system: an interface language built from **rules, frames and tracked type** rather than from illustration. It takes the vocabulary of metal filigree work and engraved ornament — hairlines, symmetry, corner brackets, lozenges, patterned grounds, gilt on ink — and rebuilds it in CSS so it can be applied to any surface: web pages, desktop apps, mobile apps, game UI and print.

The house line, and the rule that settles most arguments:

> **The rule does the work; the ornament only agrees.**

## Where this came from

There was **no codebase, Figma file, or existing product** for Filigree. The brief supplied twelve reference images and a name. They were:

| Reference | What it contributed |
| --- | --- |
| Gold filigree metalwork (close-up), gold floral mandala on black | Gilt-on-ink palette; dense symmetrical ornament; metal sheen gradient |
| Engraved Victorian florals; black-and-white ornamental seamless patterns | Line-work ornament; repeating grounds; hairline weight discipline |
| Carved rosette / ornamental medallion | Radial symmetry, centred composition |
| Ornate book cover with a centred plaque in a bordered field | The frame + plaque + centred-title pattern used by `Frame`, `Dialog` and print covers |
| Decorative filigree calligraphy / flourish sheets | Letterspaced display type; the flourish-under-title convention (`Ornament`) |
| Art-nouveau tattoo-studio lettering lockup | Wordmark treatment: display face, heavy tracking, gilt fill |
| Poster set (deep blues, gradient grounds, elegant serif display) | Full-bleed dark grounds; centred display type over a patterned field |
| Quilt-pattern cover titled "Filigree" | Name only; nothing visual was taken from it |

**Nothing from those references ships in this system** — no image, logo, name, or copy from any source. They were read for structure and translated into tokens, CSS ornament and components. There is no logo file for the same reason (see `assets/README.md`); the brand mark is the name set in type.

The fictional product used to demonstrate the system across surfaces is **Filigree Press**, a plate-cutting studio — an invented placeholder, not a real company.

## Content fundamentals

Filigree copy sounds like a studio note, not a marketing page: plain, specific, a little formal, never chatty.

- **Voice** — third person or plain imperative. The studio does things; the reader is not addressed as "you" in body copy. UI copy uses the imperative: *Strike proof*, *Request proof*, *Commission a plate*.
- **No first person.** Never "we", never "I". Where attribution matters, name the bench or the person: *Notes from the bench · Ada Lovelace*.
- **Sentence case for prose. Uppercase for labels.** Every interface label, badge, eyebrow, tab, nav link and status is uppercase and tracked (`--ls-label` / `--ls-micro`) — the casing is the ornament. Body copy and headings are sentence case; display titles are uppercased by the stylesheet, not by typing in caps.
- **Length** — hero copy is one or two sentences. Card copy is one. Hints are a fragment: *As it should appear in the colophon.* Long-form prose lives in the journal and in print, where the serif face takes over.
- **Concrete over promotional.** "Forty-two hand-cut plates, printed damp on mould-made paper", not "beautifully crafted premium plates". Numbers are specific: *1,240 impressions*, *six to nine weeks*.
- **Numerals** — Roman for editions and chapters (*Edition IV*, *MMXXVI*), Arabic with thousands separators for quantities (*12,480*), always tabular in tables and stats.
- **No emoji. Ever.** Not in UI, not in copy, not in documentation. Status is carried by a badge and a lozenge.
- **No exclamation marks**, no rhetorical questions, no "Oops!" error voice. Errors state the fact and the consequence: *Exceeds edition size.* / *Plate not archived — ornament layers are still editable.*
- **Empty states** describe what belongs there: *Nothing struck this season.* Placeholder imagery says what the picture is: *Plate 12 — second state*.
- **Terminology** — plate, impression, state, edition, proof, ledger, rule, ornament, ground, measure. Keep the register consistent; don't mix in generic SaaS words ("asset", "dashboard", "workspace" is acceptable only in tooling chrome).

## Visual foundations

### Colour
The default palette, **Gilt**, is a near-black ink ground (`--ink-900` `#08080a`) with parchment text and a champagne-gold accent (`--metal-300` `#c0a062`). Three ramps (ink, parchment, metal) plus four muted semantic hues resolve into nine semantic aliases — `--bg`, `--surface-1/2/3`, `--line-1/2/3`, `--text-1/2/3`, `--accent-1/2/3` — and **components only ever reference the aliases.** That is what makes the twelve alternate palettes work: each redefines the aliases in a `[data-theme="…"]` scope. Never hardcode a hex in a component.

`--metal-sheen` is a multi-stop gradient standing in for reflective metal. It appears on exactly three things: the gilt button, the XP meter, and gilt-filled wordmarks. One gilt element per view.

### Type
Four families, each with one job:
- **Italiana** — display. Titles, wordmarks, game menus, print titles. Uppercase, `+0.06em` (wordmarks `+0.22em`), never below 21px.
- **Bodoni Moda** — serif. Headings, card titles, dialogue, and all long-form reading in print and the journal.
- **Outfit** — UI sans. Body copy, buttons, labels, fields. Weights 400 and 500 only.
- **Space Mono** — mono. Eyebrows, metadata, counts, shortcuts, status bars, hotkeys, folios.

Contrast between families does the hierarchy work, so weight is used sparingly (there is no bold Outfit heading anywhere in the system).

### Spacing, radii, layout
14-step scale (2 → 128). Layout gaps use steps 5–9; page padding 9–12. **Corners are near-square** — `--radius-2` (2px) is the working value; ornament is drawn with rules, not curves. Pill radius exists only for status dots, avatars marked `round`, and OS-native chrome (mac traffic lights, GNOME caption buttons). Content is measured, not stretched: `--measure` is 66ch, print columns are separated by a hairline `column-rule`. Compositions are centred and symmetrical by default — heroes, dialogs, print covers and game menus all centre on the measure.

### Backgrounds
No photography, no illustration, no aggressive gradients. Grounds are either flat surface colour or one of four repeating patterns built from gradients at `--line-1`: **lattice** (crossed 45° hairlines), **hatch** (single-direction 6px hatch), **guilloche** (concentric rings), **rule-grid** (32px grid). Maximum one ground per view, always behind a framed element rather than under body copy. Hero and title areas may add a soft radial wash of `--surface-2/3` into `--bg`; never a hue-shifting gradient.

### Frames, borders, cards
The signature is a **double rule**: 1px border, a 3px gap of ground, then a second 1px inset rule (`.fg-frame`, `--inset-frame`). Cards default to a single hairline (`--line-1`) on `--surface-1`; `framed` promotes them to the double rule; `corners` adds four 16px accent brackets — one bracketed element per view. Emphasis is achieved by **doubling a rule, never by thickening it**.

### Shadow and elevation
Deliberately scarce: depth is line work. `--shadow-1` for controls that must lift a hair, `--shadow-2` for cards and toasts, `--shadow-3` for dialogs, sheets and windows. `--shadow-glow` (hairline ring + accent bloom) marks selection in game UI only. No inner shadows except the frame insets.

### Transparency and blur
Used only where something must sit over content: the nav bar (`color-mix` 82% + `--blur-veil`), the dialog scrim (72% + 3px blur), game HUD panels (74% + veil), and mobile tab bars (92%). Never on cards, never on text backgrounds. Text over a translucent panel always sits on ≥74% opacity so contrast holds.

### Animation
One easing family, `--ease-quill` `cubic-bezier(.22,.61,.36,1)`, plus `--ease-emphatic` for entrances. Durations: 110ms press, 180ms hover/focus, 280ms dialogs and sheets, 460ms bar fills, 820ms ambient loops. Motion is a fade plus a small translate (≤8px) or a width change. **No bounce, no overshoot, no spring, no parallax.** Only two things loop: the spinner and the dialogue advance caret. Everything respects `prefers-reduced-motion`.

### Interaction states
- **Hover** — the rule brightens to the accent and a 8–10% accent wash appears. Text lightens by one step. Never a colour inversion.
- **Press** — `translateY(1px)`; the FAB scales to 0.95. No colour change.
- **Focus** — `--ring-focus`: a 1px ground gap and a 3px accent ring at 62%. Always visible, never removed.
- **Selected** — accent rule (2px left inset on rows, full border on slots) plus a 12% wash.
- **Disabled** — 42% opacity, no other change.

### Imagery
There is none, by design. Where imagery belongs, `ImageSlot` draws a hatched placeholder with a ruled caption. When real imagery arrives, the house treatment is: cool or neutral, high contrast, monochrome or duotone toward the ink ramp, visible grain acceptable, no colour-popping. Photographs sit inside a hairline frame, never bleeding under text.

## Iconography

**Font Awesome, via the project kit `559791bdc6`** — the whole icon system, no exceptions:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

- **Solid** (`fa-solid`) for all interface icons; **regular** (`fa-regular`) only for empty/inactive states (`fa-regular fa-square`, `fa-regular fa-circle`).
- Icons are passed to components as class strings: `icon="fa-solid fa-feather"`. Every component that takes an icon takes it this way.
- Size follows the text: 1em in buttons and rows, `--fs-body-lg` in HUD slots and mobile tab bars. Icons are `--accent-1` in navigation, menus and alerts; `--text-2` or `--text-3` in dense chrome.
- No icon binaries are vendored — the kit is the source. No custom-drawn SVG glyphs, no icon-only branding.
- **Ornament is not iconography.** Flourishes, lozenges, brackets and grounds come from CSS (`tokens/ornament.css`), not from glyphs. The recurring motif glyph, where one is needed, is `fa-solid fa-feather`.
- **Emoji and unicode symbols are never used as icons.** The only non-Latin characters in the system are `·` in mono meta lines, `…` in pagination gaps, and `⌘`/`⇧` in keyboard shortcuts.

## Index

### Root
| File | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` lines only. |
| `readme.md` | This file. |
| `SKILL.md` | Agent-skill wrapper for using Filigree outside this project. |
| `thumbnail.html` | Homepage tile. |
| `assets/README.md` | Why this system ships no logo, imagery or font binaries. |

### Tokens — `tokens/`
`fonts.css` (Google Fonts import + family aliases) · `colors.css` (ramps + semantic aliases, default Gilt) · `themes.css` (12 alternate palettes as `[data-theme]` scopes) · `typography.css` (13-step scale, tracking, composed roles) · `spacing.css` (space, radii, containers, control heights) · `elevation.css` (shadows, insets, focus ring) · `motion.css` (easing, durations) · `ornament.css` (grounds, frames, plaques, rules, gilt text) · `base.css` (element defaults).

### Component CSS — `css/`
`controls.css` · `surfaces.css` · `navigation.css` · `feedback.css` · `chrome.css` · `mobile.css` · `game.css` · `print.css`. Class-based so hover, focus, press and pseudo-element ornament are real CSS, with the JSX components staying thin.

### Components — `components/`
| Group | Components |
| --- | --- |
| `core/` | Button, IconButton, Card, Badge, Tag, Divider, Ornament, Frame, Wordmark |
| `forms/` | Input, Textarea, Select, Checkbox, Radio, Switch, Slider |
| `navigation/` | NavBar, SideNav, Tabs, Breadcrumbs, Pagination, Menu |
| `feedback/` | Alert, Dialog, Toast, Tooltip, Progress, Spinner |
| `data/` | Table, Stat, ListRow, Avatar |
| `chrome/` | MacWindow, WindowsWindow, LinuxWindow |
| `mobile/` | IOSFrame, AndroidFrame |
| `game/` | HudPanel, Meter, GameMenu, InventorySlot, DialogueBox |
| `print/` | PageSheet, PullQuote, ImageSlot |
| `theme/` | ThemeSwitcher (+ `FG_THEMES`) |

Each has a `.d.ts` props contract and a `.prompt.md` usage note; each directory has one `@dsCard` HTML showing its states.

### UI kits — `ui_kits/`
| Kit | Surface | Screens |
| --- | --- | --- |
| `web/` | Marketing site | Home, catalogue, journal article, commission form |
| `desktop/` | Filigree Studio | One workspace inside macOS, Windows and GNOME shells (+ sheet, toast) |
| `mobile/` | Filigree Pocket | Library, plate detail, studio — in iOS and Android frames |
| `game/` | Chronicle of the Engraver | Title screen, in-game HUD, settings |
| `print/` | Ornament & Rule catalogue | Cover, editorial spread, ledger page |

Each kit has its own `README.md`.

### Templates — `templates/`
Starting folders a consuming project can copy. Each is a Design Component that loads this system through a sibling `ds-base.js`.

| Template | Entry | What it seeds |
| --- | --- | --- |
| Web Page | `templates/web-page/WebPage.dc.html` | Nav bar, framed hero on a lattice ground, stat row, plate grid, ruled footer |
| Desktop App | `templates/desktop-app/DesktopApp.dc.html` | macOS window, side nav, framed canvas, inspector, status bars |
| Mobile Screen | `templates/mobile-screen/MobileScreen.dc.html` | iOS shell, large display title, filter tags, list rows, tab bar |
| Game HUD | `templates/game-hud/GameHud.dc.html` | Translucent HUD panels, meters, quickbar, dialogue box |
| Print Page | `templates/print-page/PrintPage.dc.html` | True-size leaf: ruled border, display title, drop cap, pull quote, two-column measure |

### Guidelines — `guidelines/`
23 specimen cards across Type, Colors, Spacing and Brand, plus `palettes.html` — every palette applied to real surfaces with a live switcher.

## Palettes

`gilt` (default) · `spectrum` · `midnight-gilt` · `nocturne` · `porcelain` · `apricot` · `foundry` · `verdigris` · `absinthe` · `confetti` · `lagoon` · `ephemera` · `sagewood`

Apply one by setting the attribute on any element; everything inside re-skins:

```html
<body data-theme="midnight-gilt">
```

Seven are dark-ground, five are light-ground, one (`spectrum`) is a warm near-black carrying a ten-hue accent set. **Ship one palette per product** — the switcher is a documentation tool, not a product feature.

## Intentional additions

No source defined a component inventory, so the set above is authored from scratch. Beyond the standard primitives, these were added because the brief named five delivery surfaces:

- **`Frame`, `Ornament`, `Wordmark`** — the ornament vocabulary has to be reusable, or every consumer re-invents the frame.
- **`MacWindow` / `WindowsWindow` / `LinuxWindow`** — the brief asked for window chrome for all three desktop platforms.
- **`IOSFrame` / `AndroidFrame`** — iOS and Android shells with their respective status bars, title conventions and navigation.
- **`HudPanel`, `Meter`, `GameMenu`, `InventorySlot`, `DialogueBox`** — game UI, applying the existing language rather than adopting game-UI conventions.
- **`PageSheet`, `PullQuote`, `ImageSlot`** — print layout at true page size.
- **`ThemeSwitcher`** — required by the brief so all thirteen palettes can be previewed.

## Substitutions to confirm

- **Fonts** — no font files were supplied. Italiana, Bodoni Moda, Outfit and Space Mono are loaded from Google Fonts (`tokens/fonts.css`); they are the nearest available matches to the reference lettering (high-contrast art-nouveau display, Didone serif, geometric UI sans, mono). **Send real font files if the brand owns licensed faces** and they will be vendored into `assets/` with `@font-face` rules. Because the fonts are CDN-linked rather than self-hosted, the compiler reports zero `@font-face` rules — that is expected.
- **Icons** — the supplied Font Awesome kit is used directly from the CDN, so no icon assets are stored in the project.
- **Logo** — none supplied, none invented. `Wordmark` renders the name in type.

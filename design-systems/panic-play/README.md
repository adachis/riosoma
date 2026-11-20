# Panic Play — design system

Panic Play is a fictional maker of a small handheld game console (**Pocket One**) and the software around it: a consumer website, a desktop companion app (**Panic Play Studio**), a phone companion app, the in-game UI conventions its games follow, and printed matter (posters, owner's manuals, season inserts). This design system covers all five surfaces.

The system was authored **from a brief, not from a codebase**. It is inspired by the *aesthetic language* of small-batch indie handheld hardware — chunky black outlines, paper-cream surfaces, hard offset shadows, pixel micro-type, plain-spoken copy — but the name, wordmark, palette, type pairing, component inventory and all copy here are original to this system.

## Sources supplied

| Source | Access | Notes |
|---|---|---|
| `https://play.date` | Public site, **used as high-level aesthetic reference only** | No markup, assets, images, fonts, logos, copy or component code were taken from it. Nothing in this system identifies it. |
| 13 Coolors palette URLs | Public | Implemented verbatim as the 12 unique theme variants in `tokens/themes.css` (two of the supplied links were identical). |
| Font Awesome kit `fde87cf732` | User-supplied embed | The system's only icon source. |

No codebase, Figma file, slide deck, logo files or font binaries were provided. Consequences, all flagged again at the bottom of this file:

- **No logo exists.** Wherever a mark would go, the brand name is set in display type (`Panic` in ink, `Play` in `--brand-4`). Nothing was drawn.
- **Fonts are Google Fonts stand-ins**, not licensed brand faces.
- **No photography or illustration.** Every image area in the UI kits is a labelled placeholder.
- **No slide template was supplied, so no sample slides were built.**

---

## Content fundamentals

The voice is **dry, concrete and slightly deadpan**. It states what a thing does and stops. Enthusiasm is expressed through specificity, never through adjectives or punctuation.

- **Person:** second person for anything the reader does ("You don't pick them"), first-person plural for the company ("We answer these a lot", "we'll reply by tomorrow"). Never "we're excited to".
- **Casing:** sentence case everywhere — headlines, buttons, menu items, table headers. UPPERCASE is reserved for pixel-type micro-labels (`SEASON 02 · WEEK 04`) and eyebrows, where it is a typographic device, not emphasis.
- **Length:** headlines under 10 words and they end in a full stop ("A console the size of a coat pocket."). Body paragraphs are 2–3 sentences. Support answers give the number ("about four weeks", "about 2% a day") rather than a reassurance.
- **Buttons** name the action and, where money is involved, the amount: "Order for $219", "Send to console", "Send it", "Get". Never "Learn more", "Submit", "Click here".
- **Humour** is factual and comes from the details, not from jokes: "Games use it for fishing lines, radio tuning and, once, for aging cheese." "A loaf falls off a cart on the hill road. You are the loaf."
- **Bad news is stated plainly** and never softened: "There's no undo." "That's not normal — send us a short video and we'll replace the unit."
- **Numbers** are digits ("12 games", "$219", "2.4 / 4 GB"); durations are approximate and human ("~1 day", "about four weeks").
- **No emoji.** Ever, in product or marketing. Interpuncts (`·`) separate metadata; em dashes are used sparingly and only mid-sentence.
- **Empty and error states** are conversational and specific: "Nothing matches “fox”. Try fewer letters." not "No results found."

---

## Visual foundations

**Motif in one line:** paper-cream surfaces, 2px black outlines, solid black offset shadows, one loud accent, pixel type for the small print. Everything looks like it was printed and then cut out.

- **Colour.** Default theme *Signal*: ink `#111014`, paper `#fbf7ef`, brand red-orange `#ff4d3d`, secondary teal `#1fc7a9`, fixed lemon/grape/sky utility hues. Ramps run 1 (lightest) → 6 (darkest); `--brand-4` and `--alt-4` are the usable mid-tones. Consumers use **semantic aliases only** (`--surface-card`, `--text-muted`, `--line-1`). Status hues are fixed across all themes so a warning always reads as a warning. Max two background colours per layout: paper and one sunk tone.
- **Themes.** 12 `[data-theme]` scopes (`spectrum, midnight, arcade, ledger, peachfuzz, campfire, lagoon, moss, bubblegum, seaglass, ember, fern`) re-point every semantic alias. `midnight` is the one dark theme. Because components never hard-code colour, a theme swap is a single attribute.
- **Type.** Display **Bricolage Grotesque** 700/800 at `-0.035em` for anything over 20px; body **Figtree** 400/600 at 17px/1.45; **Silkscreen** pixel type for badges, HUD labels, running heads and key caps; **IBM Plex Mono** for versions, serials and logs. Scale is a 1.25 ratio, 11 → 76px. Prose measure caps at 64ch.
- **Spacing & layout.** 2 → 128px scale; 4/8/12/16/24 carry almost everything. 1200px web container, 56px desktop gutter, 18–24px mobile gutter, 64px section rhythm, 48pt print margin. Sections are separated by **2px ink rules**, not by shadow or background change. Fixed elements: the web header sticks; desktop title bar and sidebar are fixed while the main pane scrolls; the mobile tab bar is pinned with a 44px minimum tap target.
- **Backgrounds.** Flat colour plus a **14px dot grid** (`--texture-dots`) on sunk areas and behind device frames. No photographic backgrounds, no gradients — the only gradient in the system is the radial vignette behind a game title screen. No noise or grain.
- **Cards.** `--surface-card` fill, 2px `--line-1` outline, 22px radius, `4px 4px 0` solid black shadow, 24px padding. Media areas bleed to the card edge and are cut off by a 2px rule. Soft blurred shadows exist (`--shadow-soft*`) but are reserved for genuinely floating layers.
- **Corner radii.** 4 (chips, thumbnails) / 8 (small controls) / 14 (controls, default) / 22 (cards) / 32 (sheets, phone frames) / pill (tags, tabs, switches).
- **Borders.** One weight does most of the work: 2px `--line-1`. 3px for modal sheets, device bezels and game panels. 1px `--line-2` only for table-row dividers inside an already-outlined container.
- **Shadows.** Hard offset only, in ink, no blur, no alpha: 2px (small), 4px (default), 7px (large), 1px (pressed). Inner shadow is a single 2px top line inside inputs. Soft shadows and blur appear **only** on modal scrims and floating menus.
- **Interaction.** Hover lifts the element 1px toward the top-left and deepens the shadow one step. Press moves it 2px down-right and collapses the shadow to 1px — the object physically travels under the cursor. Focus is a 3px paper ring plus a 3px grape ring, never a colour change. Disabled is 45% opacity, never grey-out. Ghost controls have no shadow and tint the background 8% ink on hover instead of moving.
- **Motion.** 80/140/220/380ms. `--ease-out` for micro-states, `--ease-spring` (a slight overshoot) for anything that enters — dialogs pop from 92% scale, switch knobs overshoot. Nothing fades in without also moving. Blinking is used exactly once, on the dialogue-advance caret. All durations collapse to 0 under `prefers-reduced-motion`.
- **Transparency & blur.** Two places: the modal scrim (62% ink + 6px backdrop blur) and the game pause overlay. Never behind text, never on cards, no frosted panels.
- **Imagery direction.** When real photography lands it should be warm daylight, plain backgrounds, product-on-paper, no colour grading, no lifestyle blur. Game art is 1-bit black-on-white. Illustration, if any, is line work at the same 2px weight as the borders.
- **Protection.** Text never sits on imagery. Instead of a protection gradient, copy sits in an outlined capsule or card on top of the image — consistent with the cut-out motif.

---

## Iconography

**Font Awesome only**, via the supplied kit — no icon assets were provided and none were drawn.

```html
<link rel="stylesheet" href="https://ka-p.fontawesome.com/releases/v7.1.0/css/pro.min.css?token=fde87cf732">
```

**Use the kit's CSS/webfont delivery, not the `kit.fontawesome.com/…js` embed.** The JS embed swaps `<i>` elements for inline SVG via a DOM observer, which does not reliably catch elements React inserts after the initial parse — icons then measure 0×0. The stylesheet above serves the same kit through `@font-face`, so React-rendered glyphs paint with no observer and no JS.

- Always go through the `Icon` component (`<Icon name="gamepad" />`), which maps `variant` → `fa-solid | fa-regular | fa-light | fa-brands | fa-duotone`. Never inline `<i class="fa-...">` in new work, and never hand-roll an SVG.
- **Solid** is the default and covers ~95% of usage; regular is used only for large decorative glyphs (e.g. `circle-play` in a media context). Duotone and light are available but unused so far.
- Icons inherit `currentColor` and font-size; 1em inside buttons and rows, 18–22px standalone. Never coloured independently of their label.
- Recurring set: `gamepad, circle-play, arrow-rotate-right` (the Dial), `battery-three-quarters, wifi, signal, bell, cart-shopping, sliders, layer-group, floppy-disk, trophy, puzzle-piece, download, upload, magnifying-glass, chevron-down, chevron-left, xmark, check, plus, trash, terminal, truck-fast, envelope, paper-plane`.
- **No emoji, anywhere.** Unicode is used typographically, not as iconography: `·` as a metadata separator, `▼` as the dialogue-advance caret, `⌘,` in menu shortcut meta.
- Icons are decorative by default (`aria-hidden`); pass `label` to make one meaningful. `IconButton` requires `label`.

---

## Index

**Root:** `styles.css` (the only file consumers link) · `readme.md` · `SKILL.md` · `thumbnail.html`

**`tokens/`** — `fonts.css` (Google Fonts stand-ins + family tokens), `colors.css` (ramps + Signal semantics), `themes.css` (12 theme scopes), `typography.css`, `spacing.css`, `radii.css`, `shadows.css`, `motion.css`, `base.css` (element resets + `.pp-dots`, `.pp-pixel`, `.pp-eyebrow` helpers)

**`components/`** — `components.css` holds every component class; each component is a thin JSX wrapper with a `.d.ts` and `.prompt.md`.

- `core/` — **Icon**, **Button**, **IconButton**, **Card**, **Badge**, **Tag**
- `chrome/` — **TitleBar** (`platform="mac" | "windows"`, mutually exclusive)
- `forms/` — **Input**, **Select**, **Checkbox**, **Radio**, **Switch**, **Slider**
- `feedback/` — **Dialog**, **Toast**, **Tooltip**, **ProgressMeter**
- `navigation/` — **Tabs**, **MenuList**
- `game/` — **StatBar**, **DialogueBox**, **ButtonPrompt**

**`ui_kits/`** — `web/` (marketing site: console page, catalog, support) · `desktop/` (Panic Play Studio: library table + detail, settings) · `mobile/` (companion app: shelf, detail, device, account, store) · `game/` (title screen, HUD, dialogue, pause) · `print/` (Letter poster + owner's-manual page). Each has its own README.

Every kit carries a **theme switcher** (`ui_kits/theme-switcher.js`) in the bottom-right corner: pick any of the 12 palettes and the whole surface re-themes live. It is a review tool, not part of the shipped component set — don't copy it into product code.

**`guidelines/`** — 20 specimen cards feeding the Design System tab, grouped **Colors**, **Themes**, **Type**, **Spacing**, **Brand**.

### Intentional additions

No source defined a component inventory, so a standard set was authored. Beyond the usual primitives:

- **Icon** — required wrapper so the Font Awesome kit is the single icon path.
- **ProgressMeter** — battery, storage, download and season-progress readouts appear on every surface; `stepped` mode covers the segmented hardware look.
- **StatBar / DialogueBox / ButtonPrompt** (`game/`) — the brief names video-game UI as a first-class surface, which the standard web primitives don't cover.
- **MenuList** — one outlined list primitive serves desktop sidebars, mobile settings and game pause menus.
- **TitleBar** (`chrome/`) — desktop products need window chrome, and the two platform conventions differ enough (height, title alignment, caption-button geometry, close-button hover) that one component with a `platform` prop is safer than two hand-built bars. **Pick one platform per product; the two must never coexist in a single design.** The desktop kit exposes a switch only so both can be reviewed.

### Known gaps — please supply

1. **Logo files.** Nothing was drawn; the wordmark is plain type.
2. **Fonts.** Bricolage Grotesque / Figtree / Silkscreen / IBM Plex Mono are stand-ins loaded from Google Fonts. Swap `tokens/fonts.css` for licensed `@font-face` files when available.
3. **Photography, product renders, game art, illustration.** All image areas are labelled placeholders.
4. **Slide template.** None supplied, so no deck was built. Say the word and one will be.

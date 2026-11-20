# Slow Days Club — Design System

Slow Days Club is a lo-fi music label and listening platform: a weekly release schedule, a
24/7 radio livestream, artist and illustrator profiles, a merch shop heavy on vinyl, a
desktop and mobile player, a cozy companion game, and a print program of sleeves, posters
and zines. The brand's whole job is to make focused, unhurried listening feel like a place
you go rather than a feature you use.

This design system carries that identity across five surfaces:

1. **Web** — marketing home, release pages, radio, artist directory, shop
2. **Desktop apps** — a player for macOS, Windows and Linux, with real window chrome for
   each platform (standard, utility/inspector, and dialog window types)
3. **Mobile apps** — iOS and Android players, each following its own platform chrome
4. **Game UI** — HUD, dialogue, inventory and menu treatments for a cozy companion game,
   using the *same* visual language rather than genre-standard game styling
5. **Print** — vinyl sleeve, gig poster, and editorial spread layouts

## Sources this system was built from

- **Reference site:** `https://chillhop.com/` — read for information architecture, page
  inventory, section rhythm and voice only.
- **Reference imagery:** fourteen album-art, vinyl-packaging, lettering and site images
  supplied in `uploads/` at build time.

### What was deliberately *not* carried over

The brief was to build a system *inspired by* the references, never a replica. So:

- **No reference asset ships in this system.** No supplied image, illustration, logo,
  wordmark, animal character, product photo or line of copy was copied, traced, recoloured
  or re-drawn. `assets/` contains no imagery lifted from the sources.
- **No identifying brand marks.** The references' logotype is proprietary. Per the brief,
  no mark was invented in its place either — **Slow Days Club has no logo file**. Wherever
  a mark belongs, the brand name is *set in type* (see `components/core/Logotype.jsx`,
  which is exactly that: type, letter-spacing and an optional dot, nothing drawn).
- **No borrowed characters or illustration.** The reference identity leans on a recurring
  illustrated animal mascot and full-bleed painted scenes. This system replaces that with
  an abstract, procedurally-composed **artwork tile** (`components/media/ArtworkTile.jsx`) —
  flat colour fields plus grain, generated from a seed — so every screen can show
  release art without any borrowed picture. Swap in real commissioned illustration when
  you have it; the tile is a placeholder with the right *shape* and *palette*, not a
  finished asset.
- **Original names throughout.** Brand, product, release, artist and playlist names in the
  UI kits are invented.

---

## Content fundamentals

**Voice: a friendly host, not a brand.** Copy sounds like one person who runs the label
writing to one person who is about to put headphones on. Warm, plain, a little wry, never
salesy and never zany.

- **Person.** "We" for the label, "you" for the listener. *"We say it every year, but fall
  might be our favourite season."* *"Everything you need to slow the day down."*
- **Casing.** Sentence case for headlines, body and buttons. ALL-CAPS is reserved for
  small structural labels (nav groups, section eyebrows, sticker badges, tracklist column
  heads) and is always paired with the mono face and letter-spacing — caps carry
  *structure*, never emphasis.
- **Headline length.** Section headings are two to four words: "New releases", "Now
  playing", "Shop merch", "Meet the illustrators". The sentence-long writing lives one
  step down, in a 1–3 sentence deck under the headline.
- **Seasonal, sensory specifics over adjectives.** Describe the room and the hour, not the
  product. *"Listening feels like wandering under streetlights while the rest of the city
  closes its eyes."* Not *"immersive audio experiences."*
- **Numbers stay concrete.** "42 tracks · 2 h 18 m", "New every Friday", "Free shipping
  over €60". No fabricated stats, no "trusted by millions".
- **Buttons say the outcome.** "Play the radio", "Explore fall", "Add to bag", "Get the
  app". Not "Learn more", "Submit", "Click here".
- **Empty and error states apologise once and offer the next move.** *"Nothing queued yet.
  Start with the radio and we'll fill this in as you go."*
- **Emoji.** Effectively absent from product UI. The one sanctioned use is a single leading
  glyph in *user-facing playlist titles* (the reference does the same with a paw print),
  and even there it is decorative punctuation, never information. Never in buttons, nav,
  errors, headings, or marketing copy.
- **Mono voice.** Timecodes, catalogue numbers, track durations, BPM, credits, "SIDE A/B",
  and file-ish metadata are always set in the mono face. It is the system's
  liner-notes-and-tape-label register.
- **What to avoid.** Exclamation marks (one per page, maximum), "unleash / elevate /
  supercharge", em-dash-heavy rhetorical rhythm, "this, not that" constructions, hype
  numerals, and second-person imperatives stacked back to back.

---

## Visual foundations

### Palette

The default scheme, **Loft**, is a warm print palette: aged-paper cream (`--paper`
`#FBF3E4`), ink-plum near-black (`--ink` `#241F2E`), a deep **teal** primary accent
(`--accent` `#1F7A6F`), a **coral** hot accent (`--accent-2` `#E8563F`) and a **gold**
tertiary (`--accent-3` `#F0B429`). Nothing is pure white or pure black; every neutral is
tinted toward paper. Colour is used in *fields*, flat and confident — a whole panel or a
whole artwork block — not as small decorative flecks or gradients-for-depth.

Fourteen schemes ship (`tokens/themes.css`): Loft, Night, plus the twelve supplied
palettes — Boardwalk, Midnight Gold, Neon Dusk, Harbor, Soft Serve, Campfire, Tide Pool,
Fern & Flare, Bubblegum, Sea Glass, Sunset Deck and Sage. Each scheme declares only nine
values (paper, surface, ink, and three accent/ink pairs); every other semantic token —
secondary surfaces, three levels of muted ink, borders, hover/press/soft accent
variants, status tints, scrims — is derived with `color-mix()` in `tokens/colors.css`. So a
new scheme is nine lines, and a component styled against the semantic tokens is correct in
all fourteen with no per-theme CSS.

Apply a scheme with `data-theme="campfire"` on `<html>`, or on any wrapper to preview one
in place. `data-mode="dark"` flips Loft to Night. **The scheme switcher is a
documentation device only** — it appears in the specimen cards and the theme gallery,
never inside a product UI kit.

### Type

- **Display / headings:** Bricolage Grotesque, 600–800, tight tracking (`--ls-display`
  `-0.03em`). Big, wide, slightly quirky — it carries the sleeve-lettering job.
- **UI / body:** Figtree, 400–600, `1.55` line-height, `text-wrap: pretty`.
- **Meta / liner notes:** IBM Plex Mono, uppercase, `+0.06em`, at 11–13px.
- **Stickers:** display face at 800 in caps with `+0.1em`, on a pill or a hard-shadowed
  capsule. This is the "ESSENTIALS / SIDE A / LIMITED EDITION" register.

Three sizes do most of the work: 12–13px mono labels, 16px body, 30–72px display. The
middle of the scale is used sparingly, which is what keeps pages feeling like printed
matter rather than dashboards. **Substitution flagged:** the reference wordmark is a
proprietary geometric rounded sans; Bricolage Grotesque is the closest open licence match
available here. Send real font files and it is a one-line change in `tokens/fonts.css`.

### Space, layout and rhythm

4px base scale (`--s-1` … `--s-15`), 24px default gutter, `1240px` page max, `64ch`
measure. Marketing pages alternate `--paper` and `--paper-2` bands with generous
`80–128px` vertical padding; app chrome is much denser (`16–24px`). Grids are honest and
regular: 4-up release grids on desktop, 2-up on tablet, a horizontal snap-scroller on
mobile. Fixed elements are limited to two — a sticky top nav (which gains a hairline
border and a blur once scrolled) and a bottom player bar, which is the one element
allowed to persist across every route in the player products.

### Backgrounds and texture

Flat colour fields first. Full-bleed imagery is reserved for hero units and release
pages, where it sits behind a bottom-up scrim (`--scrim-bottom`) rather than an overlay
tint, so the art stays legible as art. **Grain is the signature**: a 140px turbulence
tile at 7% multiply (`.sdc-grain`, `--texture-grain`) over artwork, hero fields and game
panels. A halftone dot pattern (`--halftone`) is the print-only alternative. No
mesh gradients, no bluish-purple hero gradients, no glassmorphism as decoration. The one
sanctioned gradient is `--dusk-wash`, a single-hue paper-to-gold vertical wash.

### Radii, borders, cards

Deliberately restrained: `--r-card` 10px, `--r-control` 8px, `--r-artwork` 6px, pill only
for buttons, chips and badges. Sheets and modals go to 20px. Borders are 1px hairlines at
13% ink; a 2px border reads as "selected". Cards are the flat kind: `--surface`, hairline
border, `--shadow-2`, no border-left accent stripe, ever. On hover a card lifts 2px and
takes `--shadow-lift`. The alternate card treatment is the **sticker**: 2.5px solid ink
border plus a hard, unblurred offset shadow (`--shadow-sticker` `3px 3px 0 var(--ink)`) —
the retro sleeve motif, used for game panels, print callouts and limited-edition flags.

### Shadow system

Five soft steps (`--shadow-1` … `--shadow-4`, `--shadow-lift`) all tinted with ink via
`color-mix`, never neutral grey or black. `--shadow-inset` marks pressed and inset
surfaces. `--shadow-focus` is a 3px accent halo. Hard sticker shadows are a separate,
never-mixed family.

### Motion

Short and gentle. `--dur-2` 180ms for controls, `--dur-3` 260ms for surfaces, `--ease-out`
`cubic-bezier(.2,.7,.2,1)` for nearly everything, `--ease-spring` only for things that
appear (sheets, toasts, dialogue boxes). Fades and 2–8px translations; no bounces on
hover, no parallax, no scroll-jacking. The animated exceptions are the equaliser bars on a
playing track and the slow drift of a livestream card's art. All of it collapses under
`prefers-reduced-motion`.

### Interaction states

- **Hover:** accent mixes 14% toward ink (`--accent-hover`); surfaces go to `--surface-2`
  and lift 2px. Never opacity-only.
- **Press:** accent mixes 28% toward ink, plus `scale(.97)`. Sticker-style controls
  instead *travel into* their shadow (`translate(2px,2px)` with the offset reduced) — a
  physical button press.
- **Focus:** 2px accent outline at 2px offset, or `--shadow-focus` inside dense chrome.
- **Selected:** 2px accent border plus `--accent-soft` fill.
- **Disabled:** 45% opacity, `cursor: not-allowed`, no colour change.

### Transparency and blur

Blur is functional only, in three places: sticky nav over content (`backdrop-filter:
blur(12px)` + 78% paper), the player bar's expanded panel, and modal scrims. Translucent
capsules over artwork use a solid-ish scrim, never a frosted panel, so text contrast is
predictable across all fourteen schemes.

### Imagery direction

Warm, sun-faded, mid-day-to-dusk. Flat vector illustration with visible grain, limited to
five or six flat colours per composition, soft ambient occlusion instead of hard
rendering, and coral/gold light against teal and plum shadow. Interiors, windows,
balconies, weather and small animals doing quiet things — the *content* is a cozy
domestic moment, always. Nothing is neon-lit, high-contrast, cool-grey or photographic.
Photography, when it appears at all, is merch product shots on a cream sweep.

---

## Iconography

**Font Awesome is the icon system.** The brand has no proprietary glyph set, so this
system standardises on the user's Font Awesome kit rather than substituting a lookalike:

```html
<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>
```

**One caveat, flagged.** That kit is a domain-locked Pro kit, so inside this workspace its
glyph payload does not load and icons render as empty boxes. Every page in this system
therefore also links the free Font Awesome 6 CDN sheet immediately after the kit script, purely
so previews are legible:

```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
```

On your own domains the kit takes over and that line can be deleted. Only free-tier icon names
are used, so nothing breaks either way — but if you want Pro-only glyphs, allowlist the domain
in your Font Awesome account first.

- **Style:** solid (`fa-solid`) for controls, actions and anything inside a filled button;
  regular (`fa-regular`) for outline states of toggles (`fa-heart` empty vs solid filled);
  brands (`fa-brands`) for platform links (Spotify, Discord, Twitch, Bandcamp). Do not mix
  duotone or thin into the same view.
- **Sizing:** icons are set in `em` and inherit `currentColor`, so they track their label's
  size and colour automatically. Standard optical sizes: 12px in mono labels, 14px inline
  with body, 16px in buttons, 20px in nav and player controls, 28px for the primary
  transport play button.
- **Optical alignment:** icon-with-label pairs use an 8px gap (`--s-4`) and
  `align-items: center`; icon-only controls are square with a `--r-pill` hit area of at
  least 38px (44px on touch).
- **Never:** hand-rolled SVG paths, emoji as icons, unicode arrows or bullets as glyphs,
  or a second icon library alongside Font Awesome. If a glyph is missing, pick a
  neighbouring Font Awesome concept rather than drawing one.
- **Unicode exceptions:** the middle dot `·` as a metadata separator and the en dash in
  ranges are typography, not iconography, and are fine.
- **Emoji:** see Content fundamentals — one optional leading glyph in user-authored
  playlist titles, nowhere else.

`components/core/Icon.jsx` is an intentional addition: a thin wrapper that normalises size
and gap so kits do not sprinkle raw `<i class="fa-…">` tags with ad-hoc inline styles.

---

## Intentional additions

The brief supplied brand references but no component inventory, so the component set is
authored from scratch against these five surfaces. Two entries are worth calling out:

- **`Icon`** — wrapper over Font Awesome for consistent sizing and colour inheritance.
- **`ArtworkTile`** — procedural flat-field artwork placeholder, standing in for the
  commissioned illustration this system deliberately does not ship (see above).
- **`ThemeSwitcher`** — documentation-only control for previewing the fourteen colour
  schemes. Do not ship it inside a product.

---

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` list only. |
| `tokens/` | `fonts` · `colors` · `themes` · `typography` · `spacing` · `elevation` · `motion` · `texture` · `base` |
| `components/` | Reusable primitives, grouped by concern — see the table below |
| `ui_kits/` | Full-screen product recreations, one directory per surface |
| `templates/` | Starting-point templates consuming projects can copy |
| `guidelines/` | Foundation specimen cards for the Design System tab |
| `assets/` | Brand assets. **Intentionally contains no logo** — see above |
| `thumbnail.html` | Homepage tile for this system |
| `SKILL.md` | Agent-skill entry point |

### Components

| Group | Components |
| --- | --- |
| `components/core` | Button · IconButton · Icon · Badge · Tag · Card · Avatar · Logotype |
| `components/forms` | Input · Textarea · Select · Checkbox · Radio · Switch · Slider |
| `components/navigation` | NavBar · Sidebar · Tabs · Pagination · Menu |
| `components/feedback` | Dialog · Toast · Tooltip · Banner · ProgressBar · EmptyState |
| `components/media` | ArtworkTile · TrackRow · PlayerBar · MiniPlayer · ReleaseCard · LiveBadge · WaveformScrubber |
| `components/data` | Table · ListRow |
| `components/chrome` | MacWindow · WindowsWindow · LinuxWindow |
| `components/mobile` | PhoneFrame · TabBar · AppBar |
| `components/game` | GamePanel · GameButton · VibeMeter · DialogueBox · InventorySlot |
| `components/theme` | ThemeSwitcher *(docs only)* |

### UI kits

| Path | Surface |
| --- | --- |
| `ui_kits/web/` | Marketing home, release page, radio, shop |
| `ui_kits/desktop/` | Player app in macOS, Windows and Linux chrome + utility and dialog window types |
| `ui_kits/mobile/` | iOS and Android player screens side by side |
| `ui_kits/game/` | Cozy companion game HUD, dialogue, inventory, pause menu |
| `ui_kits/print/` | Vinyl sleeve, gig poster, editorial spread |
| `guidelines/themes.html` | All fourteen colour schemes on one component set |

### Templates

| Path | What it seeds |
| --- | --- |
| `templates/release-page/` | Marketing release page — hero, tracklist, listen-elsewhere rails |
| `templates/mobile-screen/` | iOS/Android listen screen in a device frame, mini player and tab bar |

Each template loads this system through its own `ds-base.js`; a consuming project points the
`base` line at its bound `_ds/<folder>` and nothing else changes.

### A note on kit source files

UI-kit `.jsx` files are deliberately **kebab-case** (`web-home.jsx`, not `WebHome.jsx`) so the
compiler treats them as screens rather than components. They attach their exports to `window`
instead of using `export`, because they are loaded straight into the page by Babel.

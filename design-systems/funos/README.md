# FunOS Design System

FunOS is a **playful, high-contrast neo-brutalist system** for consumer software and the material around it. It looks hand-made and confident: warm paper, everything outlined in near-black, chunky display type, and hard zero-blur shadows that make every element feel like a sticker sitting on the page.

It covers five surfaces deliberately: **marketing sites, mobile apps, desktop apps, game UI, and print.** The same nineteen colour hues, one type scale and one press gesture carry all of them, and every one of them re-skins through **thirteen colour schemes** (the house scheme plus twelve variants) without touching a component.

The system is deliberately unbranded. It carries no product names, no proprietary marks, and no content from any source product.

## Sources

| Source | What was taken |
| --- | --- |
| `https://www.playtether.app/` (public marketing page, fetched as text + a full-page screenshot supplied by the user) | The primary design language: cream/ink/flame/lime palette, pill buttons with collapsing offset shadows, outlined cards, mono-caps kickers, lime tick checklists on ink panels, oversized wordmark footer, hairline-separated FAQ rows. Content, product specifics, animated elements and branding were deliberately discarded. |
| `uploads/Screenshot 2026-08-31 at 09.17.05.png` | Above — the exact CTA block, footer and shadow treatment. |
| `uploads/depobudget-qpp-full-page.jpg`, `uploads/riAc9zMB95WrgmNjbbAVgb.png`, `uploads/1787324986705.jpg`, `uploads/1787324987013.jpg`, `uploads/unnamed.webp`, `uploads/images.jpg`, three `.avif` files | Supporting reference for the multi-colour "play palette" card runs, numbered card sets, marquee bands and lime-on-ink CTA patterns. Treated as mood reference only. |

No codebase, Figma file, font binaries, logo files or illustration assets were supplied. Nothing was reconstructed from memory — see **Gaps** at the end.

---

## Colour schemes

Set `data-theme` on any ancestor — the document element, or a single region to scope a variant to part of a page:

```html
<html data-theme="midnight">          <!-- whole document -->
<section data-theme="neon"> … </section>  <!-- one region -->
```

**See them all: `guidelines/theme-switcher.html`.** Pick any of the thirteen schemes and any of six surfaces — Foundations, Marketing, Mobile, Desktop, Game, Print — and the whole example re-skins from the `data-theme` attribute alone. That page is the fastest way to judge a scheme against real layouts, and it is the reference for whether a change to a token holds up everywhere. Selection persists across reloads.

Each variant rebinds only the **19 base hues** plus the seven on-fill text colours and four semantic aliases. Everything else — tints, tint text colours, body-on-fill colours, veils — derives from those in `tokens/colors.css` via `color-mix()`, so components re-skin with no edits and no per-theme component code.

| Scheme | `data-theme` | Character |
| --- | --- | --- |
| **Default** | *(none)* | The house scheme: cream paper, ink, flame, lime |
| Spectrum | `spectrum` | Warm rainbow spread; red primary, amber accent, cool slate neutrals |
| Midnight | `midnight` | **Dark.** Deep navy page, gold borders and display type |
| Voltage | `voltage` | Electric violet-to-amber ramp; hot pink primary on warm cream |
| Flag | `flag` | Crisp civic palette; crimson primary, pale mint accent, navy ink |
| Peach | `peach` | Soft desaturated warmth; coral primary, apricot accent, sage support |
| Field | `field` | Outdoorsy field guide; orange primary, corn accent, teal-slate ink |
| Mint | `mint` | Fresh green ramp; teal primary, spring-green accent |
| Neon | `neon` | **Dark.** Forest page, cyan borders, coral primary — built for game UI |
| Candy | `candy` | Bubblegum quartet; pink primary, butter accent, sky and melon support |
| Lagoon | `lagoon` | Lagoon blues on a chartreuse page with one hot-red primary |
| Navy | `navy` | Editorial navy on bone; vermilion primary, mustard accent |
| Sage | `sage` | The quietest variant — muted greens, near-monochrome |

**`--accent-on-dark`.** Two schemes (Midnight, Neon) invert `--ink-2` to a *light* value, so the house pattern of lime text on a dark panel fails there. Any accent-coloured **text, dot or stroke sitting on an `--ink-2` surface must use `--accent-on-dark`**, which every scheme guarantees contrasts against its own `--ink-2`; borders and hairlines on that surface use `--veil-on-dark`. Accent *fills* (a lime Button on a dark panel) are unaffected — the failure mode is only accent-on-ink-2 text. Never hardcode `--lime` on an `--ink-2` surface.

**Text that can land on any surface inherits `currentColor`.** Every component whose text sits on its *parent's* background — form labels and hints (Input, Select, Checkbox, Radio, Switch, Slider), meter and readout labels (Meter, Slider, ScorePanel), KeyCap hints — uses `currentColor` with an opacity step for secondary lines, never a hardcoded `--ink` / `--ink-3` / `--text-muted`. Emphasis comes from weight, not from a fixed colour. This is what lets a Slider sit inside a dark Card, or a Switch row inside an `--ink-2` panel, without a variant prop. Components that own their own background (a Button's fill, an Input's field, a Tabs pill) still set an explicit colour, because the pairing is known.

**Rules that hold in every scheme.** `--ink` is always the maximum-contrast line colour and is used for every border, every hard shadow and all display type; `--paper` is always the page. In the two dark schemes that inversion happens naturally — `--ink` becomes a bright hue and the hard shadows read as light offsets on a dark page, which is the same gesture in reverse. Never hard-code a hex in a component; always go through a token, or the component drops out of the theme system.

Two palettes in the supplied list were identical, so twelve unique variants were built from thirteen links. Where a source palette had fewer than five usable hues, the play-palette slots reuse palette members rather than inventing new ones, and neutral steps are derived as tints and shades of the palette's darkest colour — flagged here because those derived neutrals are the only values not literally in the source palettes.

---

## Content fundamentals

**Voice: dry, plain, faintly amused.** It never oversells and never explains the joke. The register is that of a well-written product page written by one person, not a marketing team.

- **Second person, never first.** "Before you install anything." "Everything lands where you left it." The product is referred to by name or as "it" — never "we".
- **Sentence case everywhere.** The single exception is the mono kicker (`OUT NOW`, `FAIR QUESTIONS`, `GRAVITY`), which is always caps and letterspaced.
- **Full stops in headlines.** Display lines are complete sentences and get punctuation: "Small things, done properly." "Out now." "Free entry."
- **Two-part headlines.** A short clause, a line break, a payoff: "It only does one thing. / It does it absurdly well."
- **Short declaratives for facts.** "No account, telemetry or cloud." "One purchase, no subscription." Feature lists are noun phrases, not sentences.
- **Undersell the feature, then be precise.** "It only does one thing" is followed by exact behaviour, not adjectives. No "seamless", "powerful", "revolutionary", "delightful".
- **Self-aware but never zany.** Humour comes from understatement and honest framing ("How it compares", "A record, not a scoreboard"), never from exclamation marks or wordplay.
- **Section kickers set up the heading.** `HOW IT COMPARES` → "Before, and after." The kicker names the frame; the heading lands the point.
- **FAQ questions are written as the reader would ask them.** "Does it get in the way?" "What data does it collect?" Answers open with the direct answer — "No." — then one clarifying sentence.
- **Emoji: essentially never.** The source uses one or two as illustrative glyphs inside feature tiles. In FunOS they are not part of the system: use them only as content, never as iconography or bullets. No emoji in buttons, labels, nav or headings.
- **Numbers are mono.** Counts, percentages, versions and shortcuts (`6,407`, `62%`, `Ctrl+K`, `v2.4`) always set in the mono face. Anything that counts up or changes live also gets `font-variant-numeric: tabular-nums`.
- **Microcopy under CTAs states the constraint, not a benefit.** "Version 2.4 · one-time purchase · no sign-up".

**Length discipline:** one paragraph under a display headline, three lines maximum. If it needs more, it becomes a card grid.

---

## Visual foundations

### Colour
Two brand colours do all the work. **Flame** (`#f4522b`) is the primary fill — hero blocks and primary buttons. **Lime** (`#d3f94c`) is the action accent, and appears almost exclusively *on ink*: CTA buttons inside dark panels, checklist ticks, switch-on states. The page is **paper** (`#f7f3ea`), a warm cream that is never white; white (`#ffffff`) is reserved for cards and bands sitting on top of it. **Ink** (`#141210`) is not pure black and is used for every border, every display headline, and dark panels (`--ink-2`).

The **play palette** (sun, sea, sky, grape, punch) exists only for card runs: when 3–6 cards sit in a row, cycle tones rather than repeating one. Semantic colours are aliases of the play palette — the system introduces no new hues for status. Body copy is `--ink-3`, captions `--ink-4`; mid-greys never appear in display type.

Ceiling: **two background colours per view**, plus ink for panels. Rotating three or more coloured backgrounds in one section reads as a different, noisier system.

### Type
Display and headings: a heavy friendly grotesk at **900 / 800**, tracked in to **-3.5%** with **0.93 line-height** — very tight, very large, always ink or paper. Body: a neutral humanist grotesk at 400/500, **1.55 leading**, 17px default. Mono: letterspaced +14% caps at 11px for kickers, and for all numerics.

Three sizes of display (`--display-1/2/3`), three headings, three body sizes. Nothing else. Headlines routinely run to 6.5rem on desktop; there is no timid type in this system.

### Spacing & layout
4px base scale. Container 1240px with a fluid 20–48px gutter. Sections are separated by `--section-y` (72–136px) **and a 2px ink hairline** — the system uses rules, not shadows, to divide bands. Cards get 28px padding (40px at hero scale). Layout is mostly a full-width band stack; the sticky nav is the only fixed element, 70px tall.

### Backgrounds
Flat colour only. **No gradients, no photography, no textures, no repeating patterns, no illustrations were supplied** — so FunOS uses none. The one permitted gradient is an almost-invisible paper→paper-2 wash on app desktop backgrounds. Sections alternate paper → paper-2 → white. Hero and CTA blocks are full-bleed *inset* blocks: a coloured rounded rectangle (radius 40) sitting inside the container with a 16px offset shadow, not an edge-to-edge band.

### Borders, radii, shadows
Everything is outlined: **2px solid ink** by default, **3px** on modals and hero blocks. Radii climb 8 → 12 → 18 → 24 → 32 → 40px; buttons and badges are always fully pill. Inputs are 18px and never pill.

Depth is entirely **hard offset shadows** — `Npx Npx 0 var(--ink)`, zero blur, zero opacity, at 2/4/6/10/16px. The only soft shadow in the system is on Toasts, which genuinely float. There are no inner shadows, no glows, no protection gradients — text never sits over imagery, so it never needs one.

**Card anatomy:** white (or play-palette) fill, 2px ink border, 24px radius, 6px offset shadow, 28px padding, optional two-digit ordinal ("01") in display 900 above the title.

### Animation & interaction
Two easings: `--ease-out` for anything mechanical (presses, focus, colour), `--ease-spring` (`cubic-bezier(0.34,1.56,0.64,1)`, overshoots) for anything that should feel springy — switch knobs, card lifts, progress pills, the FAQ `+` rotation. Durations 120 / 220 / 420ms. No fades on entry, no parallax, no scroll-jacking.

- **Hover:** the element lifts *away* from its shadow — `translate(-2px,-3px)` with the shadow growing by the same amount. Colour does not change. Links go ink → flame.
- **Press:** the element translates **onto** its shadow — `translate(3px,3px)` and the shadow collapses to zero. This is the system's signature gesture; every outlined interactive element does it.
- **Focus:** 3px sky outline at 2px offset; inputs additionally lift 1px onto a 2px shadow.
- **Disabled:** 45% opacity, shadow reduced to 2px, no transform. Never grey out the fill.

### Transparency & blur
Used in exactly two places: the sticky nav and the macOS menu bar, both ~86–90% opacity with a 10–12px backdrop blur. Content surfaces are always fully opaque. Translucent ink at 12% is acceptable as a chip fill *inside* a flame block.

### Imagery
None supplied, and the system does not fake it. Where artwork would go, FunOS places a play-palette Card with a labelled placeholder. If real imagery is introduced later, match the palette's warmth: warm, high-saturation, slightly punchy, no cool blue-grey casts, no grain, no duotone.

### Surface rules

The foundations above are the whole system; each surface only narrows them.

**Mobile.** Hit targets never below 44px (tab bar buttons are 48px). Row-scale elements give press feedback as a background tint, never a transform — only pill-sized elements translate onto their shadow. Grouped rows sit inside a Card with `padding: 0; overflow: hidden` so the outline clips them. Sheets replace Dialogs, rounded on the top corners only and outlined on three sides. One flame or dark Card per screen.

**Desktop.** Windows use the 3px outline, 32px radius and the largest hard shadow. Title bars are white with play-palette traffic lights — never any OS's real system colours. Navigation rows and menu items use 12px radius; pills stay reserved for buttons. Menu hover is a `paper-2` tint, never a coloured fill. Status bars are mono-caps micro type with two slots only. Blur appears in window chrome and nowhere else.

**Game UI.** HUD panels anchor to the corners at a 20px inset and never cross the centre third. Health is always `flame`, energy `sky`, progress `lime` — do not re-map them. Numbers are display weight with tabular figures. Selected slots gain the outline and the offset shadow; FunOS has no glows, so never add one. The Neon scheme is the intended default here.

**Print.** Absolute units only inside a sheet — no `vw`, `vh` or percentage heights. Body copy floor is 17px (≈12.75pt), mono micro type 11px. Columns cap at 5.5in so lines land at 60–75 characters. A 3px rule under the Masthead replaces the web system's section hairline. Hard offset shadows print correctly because they are solid ink — which is precisely why the system has no soft shadows. Coloured sheets set `bleed` and carry their own internal padding.

---

## Iconography

The source uses **almost no icon set at all**, and FunOS keeps that restraint.

- **Unicode arrows are the primary "icon" language.** `→` on forward buttons, `↗` on external links, `↓` on in-page anchors, `↑` on back-to-top, `▾` on selects, `×` on close, `+` on accordions. Set in the display face at the surrounding weight so they read as type, not as pasted glyphs.
- **One inline SVG primitive:** the tick used in feature checklists and the Checkbox — a 2.6px round-capped stroke path, lime on ink, ink on lime. It is the only vector shape the system ships.
- **Keyboard shortcuts are typography, not icons:** `⌥F`, `⌘K` set in the mono face.
- **No icon font, no sprite sheet, no PNG icons** were present in the source, so none are included here.
- **Emoji are content, never UI.** The source uses a couple as illustrative glyphs inside feature tiles; FunOS excludes them from buttons, labels and navigation entirely.

**Substitution (flagged):** when a project genuinely needs a broader glyph set, use **Lucide** from CDN at 18–20px, `stroke-width: 2`, `stroke: currentColor`, round caps — its geometry and weight are the closest match to the tick primitive. Never mix two icon families, and never scale an icon above 24px; large "icons" in FunOS are display-face glyphs or numerals instead.

```html
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
```

---

## Gaps & substitutions

- **Fonts — substituted.** No binaries were supplied. The source's display face is a heavy friendly grotesk; **Figtree (800/900)** is the nearest Google Fonts match, with **Hanken Grotesk** for text and **DM Mono** for kickers/numerals, all loaded from the Google Fonts CDN in `tokens/fonts.css`. **Please send the real font files and I will swap them in.**
- **Logo — none supplied, none invented.** No mark exists in this system. Wherever a logo would sit, the name is set in the display face at 900 with -5.5% tracking (see `guidelines/logo.html`). `assets/` holds no marks.
- **Illustrations & photography — none supplied.** Placeholders are labelled as such in the kits.
- **Exact numeric values** (paddings, radii, tracking) were derived from the full-page screenshot and the page's stated theme colour, not from source CSS — the site's stylesheets were not fetchable. Treat them as close, not authoritative.

---

## Index

**Root**
- `styles.css` — the single entry point consumers link. Import lines only.
- `thumbnail.html` — homepage tile.
- `readme.md` — this file.

**`tokens/`** — `fonts.css`, `colors.css` (base hues, derived tints, `--accent-on-dark` / `--veil-on-dark`), `themes.css` (the 12 variants), `typography.css`, `spacing.css`, `radius.css`, `shadows.css`, `motion.css`, `base.css`

**`guidelines/`** — 31 specimen cards:
- **Colors** — Brand, Paper & ink, Play palette, Semantic
- **Type** — Display, Headings, Body, Kicker & mono, Pairing in use
- **Spacing** — Scale, Section rhythm
- **Brand** — Corner radii, Hard shadows, Press & hover states, Motion, Surfaces, Lime checklist, Wordmark
- **Themes** — **Theme switcher** (all 13 schemes × all 6 surfaces, interactive), All 13 schemes (overview), plus one specimen per variant

### Components

33 primitives. Each has `<Name>.jsx`, `<Name>.d.ts` and `<Name>.prompt.md`; each directory has one `@dsCard` HTML.

- `components/core/` — **Button**, **IconButton**, **Badge**, **Tag**, **Card**
- `components/forms/` — **Input**, **Select**, **Checkbox**, **Radio**, **Switch**, **Slider**
- `components/navigation/` — **Tabs**
- `components/feedback/` — **Dialog**, **Toast**, **Tooltip**
- `components/mobile/` — **AppBar**, **TabBar**, **ListRow**, **Sheet**
- `components/desktop/` — **WindowFrame**, **Sidebar**, **Toolbar** (+ **ToolbarDivider**), **MenuList**, **StatusBar**
- `components/game/` — **Meter**, **ScorePanel**, **DialogueBox**, **KeyCap**
- `components/print/` — **PrintSheet**, **Masthead**, **PullQuote**, **DataTable**

Several cross surfaces on purpose: **ScorePanel** doubles as a dashboard stat tile, **Meter** as a progress bar, **KeyCap** as a replacement for `<kbd>`, **DataTable** as a report table, **DialogueBox** as guided-tour narration.

### UI kits

- `ui_kits/marketing/` — landing page: Nav, Hero, Marquee, FeatureGrid, Comparison, Faq, Footer
- `ui_kits/mobile_app/` — phone app: PhoneFrame, HomeScreen, DetailScreen, StatsScreen, add-sheet flow
- `ui_kits/desktop_app/` — desktop utility: MenuBar, DropPanel, Preferences, Onboarding, Workspace
- `ui_kits/game_ui/` — Hud, TitleMenu, Inventory
- `ui_kits/print/` — OnePager, Flier (letter sheets at true size)
- `ui_kits/_shared/ThemePicker.jsx` — the theme switcher every kit mounts

### Templates

Copyable starting folders for consuming projects.

- `templates/landing-page/` — the full one-page site
- `templates/mobile-screen/` — phone screen in a FunOS frame
- `templates/app-window/` — system bar, quick panel, tabbed settings window
- `templates/print-one-pager/` — letter report page that prints at size

**Intentional additions.** No source defined a component inventory, so a standard primitive set was authored for the web/core surface and extended per surface. Surface-specific additions exist because the surface cannot be built without them: **Slider** (continuous tuning controls), **Meter**, **ScorePanel**, **DialogueBox**, **KeyCap** (game HUDs), **PrintSheet**, **Masthead**, **PullQuote**, **DataTable** (print), **AppBar**, **TabBar**, **ListRow**, **Sheet** (mobile chrome), **WindowFrame**, **Sidebar**, **Toolbar**, **MenuList**, **StatusBar** (desktop chrome), and **Marquee** (kit-local, in `ui_kits/marketing/`). **Tabs** remains the only generic navigation primitive — the source has no breadcrumb or pagination pattern to copy.

**Copy.** All content in this system is placeholder copy written to demonstrate the voice. None of it is retained from the source material; the source's product, brand and content were discarded by design.

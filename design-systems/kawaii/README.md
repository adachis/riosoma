# Kawaii — Design System

Kawaii is a soft, high-contrast, sticker-shaped design language. It is built to be applied unchanged across
five very different surfaces: **web pages, desktop applications (macOS / Windows / Linux), mobile apps
(iOS / Android), video-game UI, and print**. The same tokens, the same outlines, the same press behaviour.
Nothing gets swapped out for "platform convention" — only the platform's own chrome (window controls, status
bars) keeps its native arrangement, restyled in Kawaii.

There is **no client brand behind this system**. It was developed from a supplied inspiration set (see
Sources) as an original, non-derivative language. The demo brands in the UI kits — *Mochi Mart*, *Pocket
Plush*, *Sticker Studio*, *Kawaii Notes*, *Plushie Manager*, *Cozy Room* — are invented placeholders that
exist to exercise the system.

**There is no logo.** No mark was supplied in the source material and none was drawn. Wherever a logo would
sit, the system renders the brand name as plain type in `--font-heavy` (see `thumbnail.html`,
`ui_kits/web/WebShell.jsx`). If you have a real mark, drop it into `assets/` and replace those wordmarks.

---

## Sources given to this project

| Source | What it was | How it was used |
| --- | --- | --- |
| `Kawaii Assets/` (mounted local folder) | ~440 files: 8 novelty display fonts (OTF/TTF), a pixel-art "Cute UI Kit" (9-slice panels, buttons, switches, life bars, slots, titles, banners, card decks, 141 object icons), and seven clipart families — cute portraits, sweet stickers, plants, glitter squishies, mental-health SVGs, back-to-school, cozy fall | Fonts and clipart were copied into `assets/` and are used throughout. The pixel-art UI kit was **read as reference but not used as the visual basis** — it is a raster 9-slice set at a different fidelity from the rest of the inspiration, and rasterised panels do not scale across five surfaces. The system reproduces its structural ideas (title-bar panels, slot grids, life meters, idle/press button pairs) in CSS instead. |
| 30 uploaded reference images (`uploads/`) | Kawaii shop websites, a soft-pastel decorating-game UI, a pink game-UI asset sheet, kawaii posters and product art | Primary visual reference. The thick plum outline, vertical-gradient jelly fill, top gloss, chunky flat drop, scalloped edges, pill buttons, ribbon plaques and die-cut sticker treatment all come from reading this set. |
| 12 Coolors palette URLs | Listed in the brief | Implemented verbatim as the 12 colour schemes in `tokens/palettes.css` / `tokens/themes.css`. |
| Font Awesome Kit `559791bdc6` | Icon kit | The system's only icon source. |

Nothing from any reference image is embedded in the system, and no names, marks or copy from any reference
appear anywhere in it.

---

## CONTENT FUNDAMENTALS

The voice is **warm, plain and slightly deadpan**. Kawaii looks sweet, so the writing does not have to be —
sugar in both registers reads as saccharine. Cuteness lives in the visuals; the words stay grown-up.

**Rules**
- **Sentence case everywhere.** Title Case is never used. `ALL CAPS` appears only in the label face
  (`--font-label`) for eyebrows and badges, and in the heavy face for poster headlines.
- **Second person, active voice.** "Your parcel is 2 stops away", not "The customer's parcel is en route".
  First person plural for the brand: "we stitch every candidate by hand".
- **Say the real number.** "£18", "20cm", "340g", "60-day returns", "posted flat so nothing bends".
  Vagueness is the one thing that breaks the tone.
- **One dry beat per screen, at most.** From the shipped copy: *"Machine washable at 30°C, though we would
  not."* · *"Not scientific. Never been wrong."* · *"It is not scientific but it has never been wrong."*
  · *"Collect them, name them, keep them in a little room. That's the whole app."*
- **No exclamation-mark inflation.** One per view. Toast titles get it ("Saved!", "Nice pick!"); body copy
  does not.
- **Empty and error states are kind, never scolding.** "Your basket is empty / Pick something cute and it
  will show up here." · "That address looks incomplete."
- **No emoji.** The system has a 2,000-glyph icon kit and a seven-family illustration library; emoji would
  fight both and break at print size. This is a hard rule.
- **No metadiscourse, no hype nouns.** Avoid "seamlessly", "delightful", "elevate", "curated", "journey".
- **Buttons name the action and the outcome:** "Add to basket · £18", "Sign me up", "Shop the drop",
  "Next room". Never "Submit", "Learn more", "Click here".
- **Eyebrows are two or three words:** "Spring drop", "New in", "Behind the shop", "Mochi Mart original".
- **Numbers in UI are tabular.** Counters, prices and HUD values use `--font-heavy` with
  `font-variant-numeric: tabular-nums` so they do not jitter as they change.

---

## VISUAL FOUNDATIONS

### The five moves
Everything in Kawaii is one of these, or a combination:
1. **A thick outline** in `--line` — 2px on small controls, 3px default, 4px on panels. Never black, never
   a hairline, never a 1px border.
2. **A soft vertical gradient fill** — `--fill-primary`, `--fill-surface`, etc. Nothing is flat.
3. **A gloss on the top inside edge** — `--gloss-top` on filled things, `--gloss-inset` on wells.
4. **A hard flat drop** in `--line-soft`, 2/4/6px, plus a soft ambient. The blur alone is never enough.
5. **A generous radius** — nothing sharper than 8px; controls are full pills.

### Colour
Twelve schemes, one semantic contract. Components read only roles (`--primary`, `--surface`, `--line`,
`--text`, `--accent`, `--success`…), never raw palette hexes, so every component works in every scheme.
Apply with `data-theme` on any element: `<body data-theme="mint">`. Default is **peachy**.

Nine schemes are light, three are dark (**midnight**, **arcade**, **neonmoss**). In dark schemes `--line`
flips from a deep ink to a bright rim — gold, amber, cyan — so outlines still read against a dark paper.
Where a source palette did not supply a role (a deep outline ink, a page tint, a missing semantic hue) the
system derives one that sits inside the scheme; those derivations are noted in `tokens/palettes.css`.

Colour vibe of imagery: **warm, high-value, low-saturation ground with two or three saturated accents**.
No grain, no photographic treatment, no duotone. Illustration is flat vector with a visible line, sitting
on pale grounds.

### Type
| Role | Token | Face |
| --- | --- | --- |
| Hero / numbers / wordmarks | `--font-heavy` | Kawaii Heavy (Dango) → Baloo 2 |
| Headings, buttons, panel titles | `--font-display` | Kawaii Round (Kawaii.ttf) → Baloo 2 |
| Eyebrows, badges, tabs | `--font-label` | Kawaii Label (Chibi Girls) → Baloo 2 |
| Decorative overlay titles | `--font-hollow` | Kawaii Hollow (Kawaii Cloud) |
| **All running copy** | `--font-body` | **Nunito** 300–1000 |
| Code, IDs | `--font-mono` | system mono stack |

All eight local faces are display-only novelty fonts with limited glyph coverage — none is usable for body
text, so **Nunito** (Google Fonts) carries every paragraph, label, table cell and form value. Scale runs
11 → 88px; line height 1.05 (hero) / 1.2 (headings) / 1.55 (body).

### Spacing & layout
4px-rooted ramp, but not 4px-locked: 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 56, 72, 96. Card padding 20px,
panel padding 22px, section rhythm 34–56px. Content column `--page-max` 1160px with 32px gutters; reading
measure 46–66ch. Sidebar 248px, icon rail 76px. Minimum tap target 44px. Fixed elements: the web header is
sticky (announcement strip + nav), the mobile `TabBar` is fixed to the bottom, mobile action bars are
sticky above the platform affordance, the basket summary card is sticky at `top: 120px`.

### Backgrounds
The page default is a **dot texture** (`--tex-dots`, 18px) at 12% ink over `--paper`. Panels and game stages
use **check** (26px conic, 5%); sale and print use a 135° **stripe**; celebration surfaces use **confetti**
(two offset radial dots in primary and accent). Heroes sit on `--fill-sky`, a vertical secondary→paper wash.
Full-bleed photography is not part of the system; full-bleed *colour bands* are. There is exactly one
coloured band per view.

### Edges
Section transitions are **cut, not faded**. `.kw-scallop-top` / `.kw-scallop-bottom` (22px scallops) and
`.kw-wave-bottom` (18px) mask the boundary. No protection gradients — text over a busy ground goes into an
outlined capsule (`Badge`, `HUDStat`, `Card`) instead of being scrimmed. Blur is used in exactly one place:
the `Dialog` scrim (3px).

### Corners, cards and panels
- `Card` — 3px outline, `--r-lg` 26px, `0 4px 0 --line-soft` + soft ambient, optional ±1–2.5° scrapbook tilt.
- `Panel` — 4px outline, `--r-xl` 36px, coloured centred title bar with gloss, dotted inner field.
  Cards go inside panels, never the reverse.
- `Sticker` — two treatments, and the choice matters more than any other illustration decision.
  **`frame={false}` (floating cut-out) is the default for decoration**: no ring, no outline, just a soft
  drop shadow, ±4–9° rotation, sized 2–3× larger than a framed one, free to overlap its neighbours and run
  off the edge of its container. Hero art, scene art, editorial runs, empty states and print all use this.
  The **die-cut ring** (6px white cut line, 3px outline outside it, ±2–5°) is reserved for things that
  really are stickers, and for captioned specimen grids. A ring around every illustration reads as
  arbitrary framing and wastes space. A bare `<img>` of clipart is still a bug — `Sticker` owns the
  shadow and the rotation either way.
- Transparency: used for washes only (`color-mix` at 5–30% for selection, scrims, textures). Text is always
  full-opacity ink — never alpha-muted.

### States & motion
| State | Transform | Shadow | Extra |
| --- | --- | --- | --- |
| Rest | — | `0 4px 0` | — |
| Hover | `translateY(-2px)` | `0 6px 0` | `saturate(1.08) brightness(1.03)` |
| Press | `translateY(3px)` | `0 1px 0` | the control lands on its own shadow |
| Disabled | — | unchanged | `opacity: .45`, `cursor: not-allowed` |
| Focus | — | `--ring-focus` | 3px surface gap + 6px primary halo |

Hover **lightens and lifts**; it never darkens. Press **drops** — this is the system's signature and must
not be removed. Easing: `--ease-bounce` cubic-bezier(.34,1.56,.64,1) on entry and press,
`--ease-out` for hover, 140ms for state changes, 220ms for entry, 380ms for meters filling. Named
animations: `.kw-bob` (2.6s idle float, characters and mascots), `.kw-wiggle` (2.2s, attention),
`.kw-pop-in` (220ms overshoot, dialogs and toasts). Everything collapses to 0ms under
`prefers-reduced-motion`.

---

## ICONOGRAPHY

**Font Awesome is the system's only icon source**, via the supplied kit:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
```

- **Style: `fa-solid`.** `fa-regular` is used only for the "unfilled" pair of a filled/unfilled toggle
  (`fa-regular fa-heart` → `fa-solid fa-heart`). Duotone, thin and light styles are not used — they lose
  against a 3px outline. `fa-brands` for social links.
- **Glyphs live in chips.** An icon almost never floats on the page: it sits in an outlined round or
  squircle container (`IconButton`, the `HUDStat` chip, the `Toast` chip, the `Select` chevron badge).
  Sizing inside a chip is `0.42 × chip diameter`.
- **No hand-drawn SVG icons.** The system does not ship its own icon set and none should be drawn. If a
  glyph is missing from Font Awesome, use an illustration asset instead.
- **Emoji are never used** as icons or decoration.
- **Unicode is not used as iconography.** The one exception is the middle dot `·` as a metadata separator
  in body copy ("6 min read · 12 March").
- **Illustration, not iconography, carries personality.** `assets/illustrations/` ships seven families
  (stickers, plants, squishy, school, seasonal, frames, portraits) plus `assets/ui/objects/` (12 game
  object icons). Anything larger than ~32px should be an illustration in a `Sticker`, not a scaled glyph.
  **Illustration must match its label.** The library is small and literal — if no asset depicts the thing,
  rename the thing or use a Font Awesome glyph (`RewardCard` and `EmptyState` both take `icon` for exactly
  this). Never ship art with lettering baked into it.
- `assets/ui/` also holds the raster pixel-art kit pieces (panels, buttons, switches, life bars, slots,
  titles, banners, balloons) copied from the source folder. They are **reference material**, not part of the
  live system — the CSS components reproduce their structure at any scale.

**Substitution flag:** the supplied Font Awesome kit is loaded first on every page, but the kit's domain
allowlist does not cover the preview sandbox, so glyphs did not render from it here. Every page therefore
also links the Font Awesome **6.7.2 free CDN CSS** as a fallback:

```html
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
```

Add the deployment domain to the kit's allowlist and the fallback line can be deleted — every glyph used in
this system exists in both the kit and the free set.
**Substitution flag for type:** the eight local display faces are used as-is; **Nunito and Baloo 2 are
Google Fonts substitutions** standing in for the body and fallback display roles, because the source folder
contains no text-grade typeface. If you have licensed body and display families, replace the two
`@import`ed Google families in `tokens/fonts.css` and the fallbacks in `tokens/typography.css`.

---

## Index

### Root
| File | What it is |
| --- | --- |
| `readme.md` | This document — context, content fundamentals, visual foundations, iconography, index |
| `styles.css` | The single entry point consumers link. `@import` lines only |
| `thumbnail.html` | Homepage tile: wordmark on primary + value-ordered swatch strip |

### `tokens/` — every custom property
`fonts.css` (Google imports + 8 `@font-face`) · `typography.css` (faces, scale, weights, tracking) ·
`palettes.css` (raw hexes for all 12 source palettes) · `themes.css` (12 `[data-theme]` blocks mapping
palettes to semantic roles) · `spacing.css` · `radius.css` (radii + outline weights) · `shadows.css`
(lift, ambient, gloss, focus ring, text outline) · `motion.css` · `surfaces.css` (gradient fills, textures,
scallop masks)

### `css/`
`base.css` — reset, document defaults, heading stack, link colours, focus, selection, `.kw-eyebrow`,
`.kw-hero`, `.kw-outline-text`
`patterns.css` — background/edge/layout utilities and the keyframes behind `.kw-bob`, `.kw-wiggle`,
`.kw-pop-in`, `.kw-shimmer`, `.kw-spin`

### `components/` — 40 primitives in 8 groups
Each directory holds `Name.jsx`, `Name.d.ts`, `Name.prompt.md` and one `@dsCard` HTML showing its states.

| Group | Components |
| --- | --- |
| `core/` | **Button**, **IconButton**, **Badge**, **Tag**, **Avatar**, **Divider** |
| `forms/` | **Input**, **Textarea**, **Select**, **Checkbox**, **Radio**, **Switch**, **Slider** |
| `surfaces/` | **Card**, **Panel**, **Sticker** (framed / floating), **SpeechBubble**, **Ribbon** |
| `feedback/` | **Dialog**, **Toast**, **Tooltip**, **ProgressBar**, **HeartMeter**, **Spinner**, **EmptyState** |
| `navigation/` | **TopNav**, **TabBar**, **Tabs**, **NavList**, **Pagination** |
| `window/` | **MacWindow**, **WindowsWindow**, **LinuxWindow** |
| `game/` | **HUDStat**, **ItemSlot**, **LevelBadge**, **RewardCard**, **DialogueBox** |
| `theme/` | **ThemeSwitcher** (+ `KAWAII_THEMES`) |

**Intentional additions** (no source component library defined an inventory, so a standard set was authored;
these four are the non-obvious ones):
- **Sticker** — owns both illustration treatments (floating cut-out and die-cut ring) plus the shadow and
  rotation. Without it, consumers drop bare images and the look collapses.
- **HeartMeter** — discrete pip meters are everywhere in the reference set and behave differently from a
  continuous `ProgressBar`.
- **Ribbon** — folded-tail plaques appear in the reference asset sheets as a distinct family from buttons.
- **ThemeSwitcher** — required by the brief so all 12 schemes can be previewed; explicitly documentation-only
  and must not ship inside a product UI.

### `ui_kits/` — five surfaces, all interactive
| Kit | Entry | Contains |
| --- | --- | --- |
| `ui_kits/web/` | `index.html` | Mochi Mart shop: home, product detail, basket, journal post, header + footer shell |
| `ui_kits/desktop/` | `index.html` | Sticker Studio (macOS), Kawaii Notes (Windows), Plushie Manager (Linux) |
| `ui_kits/mobile/` | `index.html` | Pocket Plush in iOS **and** Android frames: onboarding, home, detail, settings |
| `ui_kits/game/` | `index.html` | Cozy Room: title, gameplay HUD, shop, pause, options, level complete |
| `ui_kits/print/` | `index.html` | A3 poster, double-sided A5 flier, A4 zine spread, with print-specific rules |

Each kit has its own `README.md` covering its screens and surface-specific rules.

### `templates/` — starting folders for consuming projects
| Template | Entry | What it seeds |
| --- | --- | --- |
| `kawaii-landing/` | `KawaiiLanding.dc.html` | Landing page: announcement bar, nav, hero, product grid, newsletter card |
| `kawaii-game-screen/` | `KawaiiGameScreen.dc.html` | Game screen: HUD capsule row, stage on check texture, dialogue box, inventory rail |

Each folder has its own `ds-base.js`; a consuming project edits the one `base` line in it to point at the
bound design-system tree.

### `guidelines/` — 27 specimen cards
Grouped **Colors** (default scheme, light schemes, dark schemes, semantics, ink & surfaces, gradient fills,
scheme playground), **Type** (display, heavy, label/hollow, body, scale, heading stack in use),
**Spacing** (scale, radii, outline weights, spacing in use) and **Brand** (lift & shadow, rest/hover/press,
gloss & inset, textures, scallop edges, illustration treatment, iconography, illustration library, motion).

`guidelines/scheme-playground.html` is the live implementation example for the 12 colour schemes — a small
UI plus both `ThemeSwitcher` layouts.

### `assets/`
`fonts/` — 8 local display faces (TTF/OTF)
`illustrations/` — `stickers/` `plants/` `squishy/` `school/` `fall/` `frames/` `portraits/`
(the source folder's "mental health" SVG family has English lettering set into the artwork, so it is not
shipped — decorative illustration in this system must be text-free)
`ui/` — reference raster pieces from the source kit: `panels/` `buttons/` `switches/` `lifebars/` `slots/`
`titles/` `banners/` `balloons/` `iconbuttons/` `objects/`

---

## Using the system

```html
<link rel="stylesheet" href="styles.css">
<script src="https://kit.fontawesome.com/559791bdc6.js" crossorigin="anonymous"></script>
<body data-theme="peachy"> … </body>
```

```jsx
const { Button, Card, Panel, Sticker } = window.KawaiiDesignSystem;
<Card eyebrow="New in" title="Glitter Koala Plush" interactive
      footer={<Button size="sm" icon="fa-solid fa-plus">Add</Button>}>
  Squishy, 20cm, hand-stitched.
</Card>
```

**Pick one scheme per product and stay in it.** The switcher exists so a team can choose; it is not a
runtime feature.

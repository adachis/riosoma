# mOS — Design System

**mOS** is a design language for interfaces built as a working desktop operating system. Instead of
pages, it has a menubar, a wallpaper, a dock, and draggable windows. Instead of nav links, it has
file icons. Every piece of content — an about screen, a music player, a folder of documents, a
weather readout, an AI assistant — is a window.

All example copy in this system is deliberately generic placeholder text. Replace it entirely; none
of it is meant to survive into a real project.

The aesthetic is retro-90s-future: hard black outlines, three saturated brand colors on either a
near-black or warm-cream ground, monospace system chrome, and italic serif for anything editorial.
It borrows the *grammar* of a classic desktop (titlebars, traffic lights, a dock) but not its
skeuomorphism — no bevels, no glass buttons, no drop-shadowed gradients. The only gradient in the
system is the assistant's orb.

## Sources

Everything here was read from materials the user attached. Nothing was inferred from memory.

| Source | What it gave |
|---|---|
| `adamdachis.com_2026/` (mounted local folder) | Ground truth. `styles.css` (1,570 lines) supplied every token, dimension and color. `index.html` supplied the component inventory and markup structure. `README.md` supplied the architecture, theming contract and icon inventory. `apps/*/` supplied the embedded-app conventions. |
| `uploads/Screenshot 2026-08-31 at 09.29.19.png` | Dark theme, in situ. |
| `uploads/Screenshot 2026-08-31 at 09.29.35.png` | Light theme, in situ. |
| Font Awesome Kit `fde87cf732` | The production icon kit, loaded from `https://kit.fontawesome.com/fde87cf732.js`. |

Per the brief, **no images, branding or copy were carried over** — no logo, no portrait art, no
poster art, and no product or personal names. Every string in the components, cards, template and UI
kit is neutral placeholder text. The two hand-built brand icons (folder, trash) *were* carried over,
since they are UI iconography rather than brand imagery.

## Products

There is one product with three surfaces:

1. **The desktop shell** — menubar, wallpaper, windows, dock, assistant. Recreated in `ui_kits/mos-desktop/`.
2. **Widget windows** — weather, world clock, calculator, activity feed, contact form, music player. Small, single-purpose, mostly mono.
3. **Embedded apps** — small self-contained tools that open in a chrome-only window with zero body padding. Each scopes its own styles under a single class (`.myapp { … }`) and inherits the shell's tokens (`var(--pink)`, `var(--window-bg)`) with hardcoded fallbacks so it still renders standalone.

---

## Content fundamentals

**Voice.** First person, present tense, plain and slightly self-deprecating. The register is a person
talking, not a company announcing. Nothing is written like marketing; nothing is polished to the
point of sounding automated. Small imperfections are left alone rather than smoothed out.

**Person.** "I" for the author, "you" for the reader, addressed directly and informally. Rhetorical
questions work as transitions between sections.

**Casing.** Title case never appears. Headings inside documents are sentence case or all-caps. Every
mono label in the chrome is lowercase or uppercase-with-letterspacing — never Title Case. Window
titles are paths: `~/home — About`, `~/documents`. Metadata is terse and lowercase: `0 items`,
`say hello`, `notepad math`, `v1.0`.

**Length.** Short. Two or three sentences per paragraph. Lists over prose when there are more than
two of anything. Empty states are one line and slightly flat — "Nothing here." rather than a
paragraph of encouragement.

**Punctuation.** Bullet separators (`•`) in taglines, middots (`·`) in metadata rows, em dashes in
window titles. Exclamation points appear but sparingly, and usually as a joke.

**Emoji.** None. Not in copy, not in UI. Unicode symbols do appear as *glyphs* — `♪` as the music
placeholder, `>_` as a terminal prompt, `—` as an empty value — but never as decoration.

**Shape of the copy**, with the specifics removed:

- A tagline is a row of single-word roles separated by bullets, in mono caps: `LABEL • LABEL • LABEL • LABEL`.
- A note opens with a question and answers it with a list rather than a paragraph.
- Disclaimers are set in italics and state a position plainly, without hedging or apology.
- Disabled and error states are written in the same voice as everything else — a sentence explaining what happened and what to do, never a code or a shrug.

Write new copy to that shape. Do not carry any example string in this system into a real project.

---

## Visual foundations

**Color.** Three brand colors and nothing else: pink `#ff2d7a` (also aliased `--magenta`), cyan
`#2bd4c4`, yellow `#f5c518`. They are used flat, at full saturation, and never blended. Neutrals are
warm: near-black `#1a1a1a`, chrome grey `#333333`, and cream `#f4efe2` / `#f7f0d8`. There is no true
white and no cool grey anywhere in the system.

Roles are consistent and worth memorizing:

- **Cyan** = affirmative and interactive — close light, primary buttons, links on dark, active playlist row, scrub fill, focus borders, big clock readout.
- **Pink/magenta** = attention and identity — the wordmark, the featured shortcut, minimize light, required-field asterisks, form submit, links on light, document `h1`.
- **Yellow** = ambient and physical — sticky notes, folders, maximize light, weather sun, city glyphs.

**Themes.** Two, switched by `data-theme` on `<html>`, and they are not a simple inversion. Dark is a
violet desktop (`#4d3aa3`) with near-black windows and cream text. Light is a mint desktop
(`#9be3d9`) with cream-paper windows (`#f7f0d8`) and near-black text. The chrome titlebar stays
`#333333` in both. Light theme darkens yellow glyphs to `#d99a00` for legibility on cream.

**Type.** Three families, each with one job. IBM Plex Mono is the system voice: window titles,
metadata, labels, timestamps, file names, tooltips, buttons. IBM Plex Sans is the interface and body
copy. Source Serif 4 is editorial: sticky notes, document headings, the wordmark, and large numeric
readouts. Sizes are literal, not a rounded ramp — 10, 11, 12, 12.5, 13, 14, 14.5, 16, 24, 44px. Small
mono labels are uppercase and letterspaced (0.06em–0.18em); body text never is.

**The wordmark** is set in italic serif bold with a hard 4px yellow offset shadow — an offset-print
look, not a soft glow. The period between words is cyan.

**Backgrounds.** Never photographic. The desktop is a flat theme color with two soft radial lifts of
a slightly lighter tone at 20%/20% and 80%/80%. No textures, no noise, no patterns, no full-bleed
imagery. Content imagery, where it exists, is the user's own artwork shown inside a viewer window —
it is content, not decoration.

**Borders.** Everything framed carries a 1px solid border in `--window-border` (`#0a0a0a` dark,
`#1a1a1a` light) — heavy, black, and unapologetic. Dashed borders (`1px dashed`) separate the file
browser breadcrumb from its grid; dotted borders (`1px dotted`) rule off sticky-note sections. There
is no third border weight.

**Corner radii.** 4px inputs and forecast cells · 6px menubar buttons, popover rows, document icons ·
10px windows and dialogs · 12px dock tiles · 14px app icons and chat turns · 18px the dock shell ·
20px the assistant bubble. Cards, as a web pattern, do not exist here — the window *is* the card.

**Shadows.** Two systems that never mix. Floating surfaces get a soft ambient shadow plus a hard
bottom lip: `0 18px 50px rgba(0,0,0,0.45), 0 4px 0 rgba(0,0,0,0.4)`. Icons get a sticker-style hard
offset with no blur: `drop-shadow(2px 2px 0 var(--window-border))`. The featured shortcut adds a pink
halo (`0 0 8px rgba(255,45,122,0.65)`). Inner shadows are used only on the assistant's glass panel.

**Transparency and blur.** Rare and reserved. Exactly two surfaces are translucent: the dock
(`rgba(20,20,20,0.78)` + `blur(20px)`) and the assistant bubble (`rgba(20,20,30,0.78)` +
`saturate(1.4) blur(22px)`). Windows are always fully opaque. Hover states use low-alpha overlays
(`rgba(255,255,255,0.08)` dark, `rgba(0,0,0,0.06)` light) rather than color changes.

**Animation.** Short and mechanical; nothing bounces, nothing springs. Hover and color transitions
are 120ms. Icon and dock lifts are 150ms. Window geometry animates at 250ms ease; window
open/close at 320ms `cubic-bezier(.45,.05,.55,.95)`. The only continuous animation in the system is
the assistant orb: a 4s rim pulse, a 3s iris pulse, and four rings that sit still for 6 seconds then
spin once (`0%,85.714% { rotate(0) } 100% { rotate(360deg) }`). When it is speaking, every rate roughly triples.

**Hover states.** Background lift, not color change: a translucent grey overlay on menubar buttons,
popover rows, playlist rows and file cells. Filled brand elements brighten instead
(`filter: brightness(1.08)`). Dock tiles translate up 6px and scale 1.06. Links brighten 1.15. Icon
buttons in the player switch their glyph to cyan.

**Press states.** `transform: scale(0.92)` on window lights. There is no separate active color.

**Focus states.** The border turns cyan. No outline, no ring, no glow.

**Layout rules.** The menubar is fixed at the top (36px, 44px on mobile) and the dock floats
bottom-center. Desktop icons stack in a right-edge column that wraps leftward. Windows are absolutely
positioned with explicit pixel coordinates and z-order managed by a counter. Window bodies scroll
vertically and never horizontally — long content wraps, code blocks wrap rather than scroll. Below
720px, windows go full-screen, the icon column becomes a 4-up springboard grid, and the dock reduces
to Home, the assistant, and a window switcher.

**Imagery vibe.** Where imagery appears it is the site owner's own work — pixel art, VRM character
models, poster illustrations — saturated and warm. No stock photography, no gradient meshes, no
generated abstract shapes. When an image is absent, mOS shows a bordered placeholder or a serif
glyph, never a fake photo.

---

## Iconography

**System.** Font Awesome 6, loaded as the production kit
(`<script src="https://kit.fontawesome.com/fde87cf732.js" crossorigin="anonymous"></script>`). One
kit, one weight family: `fa-solid` for nearly everything, `fa-regular` for the theme toggle
(`fa-regular fa-moon` / `fa-sun`), the envelope, the note and `fa-window-restore`; `fa-brands` only
for GitHub. Icons are monochrome and inherit `currentColor` — they are never multi-colored.

**Sizes by context.** 13px in the menubar · 20px in dock tiles · 22px on desktop icons · 28px in file
browser cells · 56px in the weather readout · 9px inside window lights.

**Inventory in active use.** Window lights: `fa-xmark`, `fa-minus`, `fa-plus`. Dock: `fa-house`,
`fa-folder-open`, `fa-palette`, `fa-music`, `fa-pen-nib`. Menubar: `fa-envelope`, `fa-calculator`,
`fa-github`, `fa-moon`/`fa-sun`. Files: `fa-file-lines`, `fa-file-pdf`, `fa-image`, `fa-cube`,
`fa-music`. Player: `fa-backward-step`, `fa-play`/`fa-pause`, `fa-forward-step`. World clock:
`fa-snowflake`, `fa-mug-hot`, `fa-mountain`, `fa-torii-gate`, `fa-globe`. Assistant:
`fa-microphone`, `fa-volume-xmark`, `fa-paper-plane`. Weather glyphs are mapped from WMO codes at runtime.

**Hand-built SVG.** Two icons are not Font Awesome — the folder and the trash can — because they
carry brand color blocks and the heavy 2px black stroke that Font Awesome can't express. They are
kept in `assets/icons/mos-icons.svg` as an SVG symbol sprite, reproduced verbatim from the source
markup, and they reference `var(--yellow)`, `var(--cyan)`, `var(--pink)` and `var(--window-border)`
so they retheme automatically. Use these two rather than a Font Awesome folder or trash glyph.

**Emoji.** Never. **Unicode glyphs** are used sparingly as content, not iconography: `♪` for missing
album art, `>_` as a terminal prompt, `•` and `·` as separators, `—` for an empty value.

**Logo.** The source's logo mark was excluded by request, and none was created. Render the brand name
in italic serif type wherever a mark would go — that treatment *is* the identity. Do not draw a
substitute.

---

## Index

```
readme.md              This file — brand context, content, visual foundations, iconography.
SKILL.md               Agent-skill entry point.
styles.css             Global CSS entry. @import lines only.
thumbnail.html         Homepage tile.
tokens/                fonts · colors · typography · layout · elevation · motion · themes · base
guidelines/            18 foundation specimen cards (Colors, Type, Spacing, Brand).
assets/icons/          mos-icons.svg — the two hand-built brand icons.
components/            React primitives, grouped by concern.
ui_kits/mos-desktop/   Interactive recreation of the full desktop shell.
templates/mos-desktop/ "mOS Desktop" starting template for consuming projects.
```

### Components

**`components/shell/`** — Desktop, DesktopIcon, MenuBar, MenuBarButton, Dock, DockSeparator, DockItem, MinList

**`components/window/`** — Window, Dialog, Tooltip

**`components/controls/`** — Button, TextField, Select

**`components/content/`** — FileBrowser, FileRow, StickyNote, Prose

**`components/widgets/`** — MusicPlayer, WeatherWidget, WorldClock, GitHubFeed, CalcPad, ContactForm, AssistantOrb, AssistantBubble

Every component has a sibling `.d.ts` (props contract) and `.prompt.md` (what it is, when to use it,
a usage example). Each directory has one `@dsCard` HTML showing its variants.

### Intentional additions

The source is hand-written CSS with no component library, so the inventory above was derived from its
BEM class families — one component per family. Three names differ from the source:

- **Prose** wraps the source's `.markdown-body` rules, which had no component of their own.
- **AssistantOrb / AssistantBubble** rename the source's assistant classes generically, since the source names a specific assistant persona.
- **Button** unifies three near-identical source buttons (`.dl-alert__btn`, `.dl-alert__btn--yes`, `.contactform__send`) into one component with three variants.

Not built, because the source treats them as one-off content rather than reusable UI: the image
viewer, the video player, the 3D VRM viewer, and the mobile springboard (a responsive arrangement of
DesktopIcon, not a distinct component).

### Known gaps

- **Fonts** load from Google Fonts, exactly as the source does. No binaries were shipped.
- **`--font-display`** is referenced by the source's weather readout but never declared there; mOS defines it as an alias of `--font-serif`.

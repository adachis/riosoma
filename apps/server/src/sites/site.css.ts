import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SiteSettings } from '@riosoma/contracts';

export async function readSiteTheme(root: string, theme: string): Promise<string> {
  const css = await readFile(join(root, theme, 'theme.css'), 'utf8');
  // Missing optional assets fall back without requests for files that do not exist.
  // Late font swaps move text even when every picture has reserved its space.
  return css
    .replace(/@font-face\s*\{[^}]*\}/g, (face) =>
      [...face.matchAll(/url\((['"]?)((?:\.\/)?assets\/[^)'"\s]+)\1\)/g)].some(
        ([, , asset]) => !existsSync(join(root, theme, asset!)),
      )
        ? ''
        : face,
    )
    .replace(/font-display:\s*swap\s*;/g, 'font-display: optional;')
    .replace(/url\((['"]?)(?:\.\/)?assets\//g, `url($1/themes/${theme}/assets/`);
}

/** Grid placement uses external rules so documents never need inline styles. */
const placement = [
  ...Array.from(
    { length: 12 },
    (_, index) =>
      `.site-x-${index} { grid-column-start: ${index + 1} } .site-w-${index + 1} { grid-column-end: span ${index + 1} }`,
  ),
  ...Array.from(
    { length: 100 },
    (_, index) =>
      `.site-row-${index + 1} { grid-row-start: ${index + 1} } .site-span-${index + 1} { grid-row-end: span ${index + 1} }`,
  ),
].join('\n');
export const SITE_CSS = `@layer rio.defaults, rio.theme, rio.base, rio.components, rio.app;
@layer rio.app {
* { box-sizing: border-box }
html { scroll-padding-top: 1rem }
body { margin: 0; background: var(--rio-bg); color: var(--rio-aa-text-muted); font-family: var(--rio-font-body); font-size: 1.0625rem; line-height: 1.65; overflow-wrap: anywhere }
.site-header, main, .site-footer { width: min(100% - 2rem, 76rem); margin-inline: auto }
.site-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem 2rem; padding-block: 1.5rem; border-bottom: 1px solid var(--rio-aa-border) }
.site-brand { display: inline-flex; align-items: center; max-width: 100%; font-family: var(--rio-font-display); font-weight: 700; font-size: 1.4rem; text-decoration: none }
.site-brand img { width: auto; max-width: min(18rem, 100%); height: auto; max-height: 3rem }
.site-logo { display: block; position: relative; max-width: min(18rem, 100%) }
.site-logo > svg { display: block; width: auto; max-width: 100%; height: auto; max-height: 3rem; visibility: hidden }
.site-logo > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain }
.site-header-with-button .site-brand, .site-header-with-button > .site-button { min-width: 0 }
/* Reserve the logo's full height inside the theme's link border before the image loads. */
.site-header-with-button .site-brand { min-height: 3rem; box-sizing: content-box }
.site-header-with-button .site-nav-wide { margin-inline-start: auto }
main { padding-block: clamp(2rem, 5vw, 5rem) }
.site-footer { padding-block: 2rem; border-top: 1px solid var(--rio-aa-border) }
.site-footer p { max-width: 65ch }
.rio-prose :where(p, li, dl, dt, dd, label, span, td, th, legend, article, section, nav, footer, header) { color: var(--rio-aa-text-muted) }
h1, h2, h3 { font-family: var(--rio-font-display); color: var(--rio-aa-text-muted); line-height: 1.15; text-wrap: balance; margin-block: 0 1rem }
h1 { font-size: clamp(2.25rem, 5vw, 4rem); max-width: 22ch; margin-bottom: 2rem }
h2 { font-size: clamp(1.5rem, 3vw, 2.25rem) }
h3 { font-size: 1.4rem }
p { margin-block: 0 1.25rem }
a { color: var(--rio-aa-link); text-underline-offset: .18em }
a:hover { text-decoration-thickness: .15em }
nav ul { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem 1rem; list-style: none; padding: 0; margin: 0 }
nav a, .site-page-link { display: inline-flex; align-items: center; min-height: 2.75rem; padding: .5rem }
nav a[aria-current="page"] { font-weight: 700; text-decoration-thickness: .15em }
.site-nav { display: none }
.site-nav-toggle { display: none; min-height: 2.75rem; padding: .5rem; cursor: pointer }
:focus-visible { outline: 3px solid var(--rio-aa-focus); outline-offset: 4px }
.site-skip { position: absolute; top: 0; left: 1rem; transform: translateY(-200%); padding: .75rem; background: var(--rio-bg); z-index: 2 }
.site-skip:focus { transform: none }
.site-grid { display: grid; gap: clamp(1.5rem, 3vw, 3rem) }
.site-block { min-width: 0; padding: clamp(1rem, 2vw, 2rem); border: 1px solid var(--rio-aa-border); border-radius: var(--rio-radius); background: var(--rio-surface) }
.site-block[data-kind="text"], .site-block[data-kind="hero"], .site-block[data-kind="media"], .site-block[data-kind="button"] { border: 0; background: var(--rio-bg); padding: 0 }
main.site-banded { width: 100% }
.site-banded > h1, .site-banded > form { width: min(100% - 2rem, 76rem); margin-inline: auto }
.site-bands { display: grid; gap: clamp(1.5rem, 3vw, 3rem) }
.site-band > .site-grid { width: min(100% - 2rem, 76rem); margin-inline: auto }
.site-band[data-band="quiet"] { --rio-band-bg: var(--rio-surface); --rio-band-text: var(--rio-aa-text-muted); --rio-band-link: var(--rio-aa-link) }
.site-band[data-band="accent"] { --rio-band-bg: var(--rio-accent); --rio-band-text: var(--rio-aa-on-accent); --rio-band-link: var(--rio-aa-on-accent) }
.site-band[data-band="inverse"] { --rio-band-bg: var(--rio-aa-text-muted); --rio-band-text: var(--rio-bg); --rio-band-link: var(--rio-bg) }
.site-band:not([data-band="none"]) { background: var(--rio-band-bg); padding-block: clamp(2rem, 5vw, 4rem) }
.site-band:not([data-band="none"]) :is(.site-block, .site-cards article) { background: transparent }
.site-band:not([data-band="none"]) :is(h1, h2, h3, p, li, dl, dt, dd, span, td, th, article, section, summary, strong, figcaption) { color: var(--rio-band-text) }
.site-band:not([data-band="none"]) a:not(.site-button) { color: var(--rio-band-link) }
.site-band:not([data-band="none"]) :is(.site-block, .site-cards article, th, td, .site-accordion) { border-color: var(--rio-band-text) }
/* A plot's own surface keeps accent series visible on an accent band. */
.site-band:not([data-band="none"]) .site-chart { background: var(--rio-surface); border-radius: var(--rio-radius) }
.site-band:not([data-band="none"]) .site-chart-label { fill: var(--rio-aa-text-muted) }
.site-band:not([data-band="none"]) .site-legend { background: var(--rio-surface); border-radius: var(--rio-radius); padding: .75rem 1rem }
.site-band:not([data-band="none"]) .site-legend :is(li, span) { color: var(--rio-aa-text-muted) }
.site-band:not([data-band="none"]) :focus-visible { outline-color: var(--rio-band-text) }
.site-band:not([data-band="none"]) .site-button { border-color: var(--rio-band-text) }
.site-accordion { border-bottom: 1px solid var(--rio-aa-border) }
.site-accordion summary { cursor: pointer; padding-block: 1rem; min-height: 2.75rem; font-weight: 600 }
@media screen {
  .site-accordion > details:not([open]) + .site-answer { display: none }
}
.site-answer, .site-section-words :is(h3, p) { white-space: pre-line }
.site-sections { display: grid; gap: clamp(2rem, 5vw, 4rem) }
.site-record-section { display: grid; align-items: center; gap: 2rem; min-width: 0 }
.site-section-words, .site-section-media { min-width: 0 }
/* A fixed container prevents video metadata from changing nested intrinsic width calculations. */
.site-enlarge-video { display: block; position: relative; width: 100%; max-width: 100% }
.site-enlarge { display: block; width: fit-content; max-width: 100%; cursor: zoom-in }
/* A label inherits its link's appearance even when a theme styles prose spans. */
a.site-enlarge .site-enlarge-label { all: unset }
.site-image-dialog { max-width: calc(100% - 2rem); max-height: calc(100% - 2rem); padding: 1rem; border: 1px solid var(--rio-aa-border); border-radius: var(--rio-radius); color: var(--rio-aa-text-muted); background: var(--rio-bg) }
.site-image-dialog::backdrop { background: var(--rio-bg); opacity: .9 }
.site-image-dialog :is(img, video) { width: min(80vw, 76rem); max-height: calc(100vh - 8rem); object-fit: contain; margin-top: 1rem }
.site-text { max-width: 65ch }
.site-text > :last-child { margin-bottom: 0 }
.site-lead { font-size: clamp(1.25rem, 2.5vw, 1.65rem); line-height: 1.5; max-width: 52ch }
.site-hero { display: grid; gap: 2rem; align-items: center }
.site-hero h1, .site-hero h2 { font-size: clamp(2.25rem, 5vw, 4.5rem); max-width: 20ch; margin-bottom: 1rem }
.site-actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.5rem }
.site-button { display: inline-flex; justify-content: center; align-items: center; min-height: 2.75rem; max-width: 100%; padding: .75rem 1.25rem; border: 1px solid var(--rio-aa-border); border-radius: var(--rio-radius); color: var(--rio-aa-on-accent); background: var(--rio-accent); font-weight: 600; text-decoration: none; text-align: center }
.site-actions .site-button + .site-button { color: var(--rio-aa-link); background: var(--rio-bg) }
.site-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: 1.5rem }
.site-cards article { min-width: 0; border: 1px solid var(--rio-aa-border); border-radius: var(--rio-radius); overflow: hidden; background: var(--rio-bg) }
.site-card-body { padding: 1.25rem }
.site-card-body > :last-child { margin-bottom: 0 }
.site-list article + article { margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--rio-aa-border) }
img, video { display: block; max-width: 100%; height: auto; border-radius: var(--rio-radius) }
.site-picture { display: block; position: relative; width: fit-content; max-width: 100% }
/* An overlaid edge preserves the picture's intrinsic size and aspect ratio. */
.site-picture::after { content: ''; position: absolute; inset: 0; border: 1px solid var(--rio-border); border-radius: var(--rio-radius); pointer-events: none }
.site-cover { width: 100%; border-radius: 0 }
.site-cover :is(.site-enlarge-video, .site-enlarge, .site-picture, .site-player, img, video, svg) { width: 100%; border-radius: 0 }
.site-player { display: block; position: relative; width: fit-content; max-width: 100% }
.site-player > svg { display: block; max-width: 100%; height: auto; visibility: hidden }
.site-player > video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain }
figure { margin: 0 }
figcaption { margin-top: .75rem; max-width: 65ch }
.site-number { font-size: clamp(2rem, 5vw, 4rem); font-weight: 700; line-height: 1.2 }
fieldset { min-width: 0; margin-block: .75rem }
[hidden] { display: none }
label { display: block; margin-block: .75rem }
input, select, textarea, button { font: inherit; color: var(--rio-aa-text-muted); background: var(--rio-bg); border: 1px solid var(--rio-aa-border); border-radius: var(--rio-radius); padding: .5rem; max-width: 100%; min-height: 2.75rem }
button { cursor: pointer }
.site-scroll { overflow-x: auto }
table { border-collapse: collapse; width: 100% }
th, td { text-align: start; padding: .5rem; border-bottom: 1px solid var(--rio-aa-border) }
dt { font-weight: 700 }
dd { margin-inline-start: 0; margin-block-end: .75rem }
dl { margin: 0 }
.site-trap { display: none }
.site-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0 }
.site-chart { display: block; width: 100%; height: auto }
.site-chart-label { fill: var(--rio-aa-text-muted); font-size: 13px; font-family: var(--rio-font-body) }
.site-chart-axis { stroke: var(--rio-aa-border); fill: none; stroke-width: 1 }
.site-chart-empty { stroke: var(--rio-aa-border) }
.site-chart-line { fill: none; stroke-width: 3 }
.site-chart-slice { fill: none }
.site-series-0 { fill: var(--rio-aa-accent-text); stroke: var(--rio-aa-accent-text) }
.site-series-1 { fill: var(--rio-aa-choice-blue); stroke: var(--rio-aa-choice-blue) }
.site-series-2 { fill: var(--rio-aa-choice-orange); stroke: var(--rio-aa-choice-orange) }
.site-series-3 { fill: var(--rio-aa-choice-green); stroke: var(--rio-aa-choice-green) }
.site-series-4 { fill: var(--rio-aa-choice-purple); stroke: var(--rio-aa-choice-purple) }
.site-series-5 { fill: var(--rio-aa-choice-red); stroke: var(--rio-aa-choice-red) }
.site-series-6 { fill: var(--rio-aa-choice-teal); stroke: var(--rio-aa-choice-teal) }
.site-series-7 { fill: var(--rio-aa-choice-pink); stroke: var(--rio-aa-choice-pink) }
.site-chart-line, .site-chart-slice { fill: none }
.site-legend { display: flex; flex-wrap: wrap; gap: .5rem 1rem; list-style: none; padding: 0; margin-block: 1rem 0 }
.site-swatch { display: inline-block; width: .75rem; height: .75rem; border-radius: var(--rio-radius); background: var(--rio-aa-accent-text); margin-inline-end: .5rem }
.site-swatch.site-series-1 { background: var(--rio-aa-choice-blue) }
.site-swatch.site-series-2 { background: var(--rio-aa-choice-orange) }
.site-swatch.site-series-3 { background: var(--rio-aa-choice-green) }
.site-swatch.site-series-4 { background: var(--rio-aa-choice-purple) }
.site-swatch.site-series-5 { background: var(--rio-aa-choice-red) }
.site-swatch.site-series-6 { background: var(--rio-aa-choice-teal) }
.site-swatch.site-series-7 { background: var(--rio-aa-choice-pink) }
@media (max-width: 47.999rem) {
  .site-header { align-items: flex-start }
  .site-header-with-button { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: .75rem 1rem }
  .site-header-with-button .site-brand { grid-column: 1 / -1 }
  .site-header-with-button .site-nav { margin-inline-start: 0 }
  .site-header-with-button > .site-button { justify-self: end; align-self: start }
  .site-nav-wide { display: none }
  .site-nav { display: block; margin-inline-start: auto }
  .site-nav-toggle { display: list-item }
  .site-nav:not([open]) nav { display: none }
  nav ul { flex-direction: column; align-items: stretch; padding-block: .5rem }
}
@media (min-width: 48rem) {
  .site-grid { grid-template-columns: repeat(12, minmax(0, 1fr)); align-items: stretch }
  .site-record-section[data-media] { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) }
  .site-record-section[data-media]:nth-child(even) .site-section-words { grid-column: 2; grid-row: 1 }
  .site-record-section[data-media]:nth-child(even) .site-section-media { grid-column: 1; grid-row: 1 }
  .site-hero[data-image] { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) }
}
@media screen and (prefers-reduced-motion: no-preference) {
  @media (scripting: enabled) {
    /* Reserve the loop's overlay while native controls handle pending or denied playback. */
    html[data-site-motion="subtle"] .site-enlarge-video:has(video[data-site-loop][controls]) .site-enlarge { position: absolute; inset: 0; width: auto; max-width: none; overflow: hidden; font-size: 0; color: transparent; outline-offset: -3px; pointer-events: none }
    html[data-site-motion="subtle"] .site-enlarge-video:has(video[data-site-loop][controls]) .site-enlarge-label { display: none }
  }
  @view-transition { navigation: auto; }
  html[data-site-motion="subtle"] .site-header { view-transition-name: site-header }
  html[data-site-motion="subtle"]::view-transition-group(*) { animation-duration: 160ms }
  html[data-site-motion="subtle"]::view-transition-old(root) { animation: site-fade-out 160ms ease-out both }
  html[data-site-motion="subtle"]::view-transition-new(root) { animation: site-fade-in 160ms ease-out both }
  ::view-transition-group(site-header), ::view-transition-new(site-header) { animation: none; mix-blend-mode: normal }
  ::view-transition-old(site-header) { display: none }
  html[data-site-motion="subtle"][data-site-reveal-ready] .site-block[data-site-pending] { opacity: 0; transform: translateY(6px) }
  html[data-site-motion="subtle"] .site-block[data-site-revealed] { animation: site-reveal 250ms cubic-bezier(.2, .8, .2, 1) backwards }
  html[data-site-motion="subtle"] .site-brand[data-site-introduce] { animation: site-logo-enter 500ms cubic-bezier(.2, .8, .2, 1) backwards }
  html[data-site-motion="subtle"] .site-image-dialog[open] { animation: site-dialog-enter 200ms ease-out backwards }
  html[data-site-motion="subtle"] .site-image-dialog[open]::backdrop { animation: site-fade-in 200ms ease-out backwards }
  html[data-site-motion="subtle"] .site-image-dialog[data-site-closing] { animation: site-dialog-exit 200ms ease-in forwards }
  html[data-site-motion="subtle"] .site-image-dialog[data-site-closing]::backdrop { animation: site-fade-out 200ms ease-in forwards }
  html[data-site-motion="subtle"] :is(button, .site-button, nav a, .site-page-link, .site-cards article, .site-accordion summary) { transition: color 150ms, background-color 150ms, transform 150ms }
  html[data-site-motion="subtle"] :is(button, .site-button, nav a, .site-page-link, .site-accordion summary):is(:hover, :focus-visible), html[data-site-motion="subtle"] .site-cards article:is(:hover, :focus-within) { transform: translateY(-2px) }
  html[data-site-motion="subtle"] :is(button, .site-button, nav a, .site-page-link, .site-accordion summary):active, html[data-site-motion="subtle"] .site-cards article:active { transform: translateY(1px) }
  /* A playing loop is its own enlarge control.  File links stay in flow when scripting or motion is off. */
  html[data-site-motion="subtle"] .site-enlarge-video:has(video:not([controls])) .site-enlarge { position: absolute; inset: 0; width: auto; max-width: none; overflow: hidden; font-size: 0; color: transparent; outline-offset: -3px }
  /* The reserved player holds the overlay while its hidden label leaves no font-dependent line box. */
  html[data-site-motion="subtle"] .site-enlarge-video:has(video:not([controls])) .site-enlarge-label { display: none }
  @supports (transition-behavior: allow-discrete) {
    html[data-site-motion="subtle"] .site-answer { transition: opacity 160ms, display 160ms allow-discrete }
    html[data-site-motion="subtle"] .site-accordion > details:not([open]) + .site-answer { opacity: 0 }
    @starting-style { html[data-site-motion="subtle"] .site-accordion > details[open] + .site-answer { opacity: 0 } }
  }
}
/* Targets and focused content must be readable before an observer can respond. */
html[data-site-motion][data-site-reveal-ready] .site-block:is(:target, :focus-within) { opacity: 1; transform: none; animation: none }
html[data-site-motion="none"] *, html[data-site-motion="none"] *::before, html[data-site-motion="none"] *::after { animation: none !important; transition: none !important; scroll-behavior: auto }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto } }
@keyframes site-fade-in { from { opacity: 0 } }
@keyframes site-fade-out { to { opacity: 0 } }
@keyframes site-reveal { from { opacity: 0; transform: translateY(6px) } }
@keyframes site-logo-enter { from { opacity: 0 } }
@keyframes site-dialog-enter { from { opacity: 0; transform: scale(.97) } }
@keyframes site-dialog-exit { to { opacity: 0; transform: scale(.97) } }
@media print {
  :root { color-scheme: light; --rio-bg: Canvas; --rio-surface: Canvas; --rio-aa-text-muted: CanvasText; --rio-aa-link: CanvasText; --rio-aa-border: GrayText }
  .site-nav, .site-nav-wide, .site-skip, .site-actions, .site-page-link, form { display: none }
  .site-grid { display: block }
  .site-block { margin-block: 2rem; break-inside: avoid }
  html[data-site-reveal-ready] .site-block { opacity: 1 !important; transform: none !important; animation: none !important }
  .site-answer { opacity: 1 !important; transition: none !important }
  .site-visually-hidden { position: static; width: auto; height: auto; margin: 0; overflow: visible; clip-path: none; white-space: normal }
  .site-scroll { overflow: visible }
  .site-accordion summary { list-style: none }
  .site-accordion summary::-webkit-details-marker { display: none }
  .site-band:not([data-band="none"]) { --rio-band-bg: var(--rio-bg); --rio-band-text: var(--rio-aa-text-muted); --rio-band-link: var(--rio-aa-text-muted) }
  a { color: var(--rio-aa-text-muted) }
}
}

@layer rio.app { @media (min-width: 48rem) { ${placement} } }`;

/** Disabling navigation in the external stylesheet also covers visitors without scripts. */
export function siteCss(motion: SiteSettings['motion']): string {
  return motion === 'none' ? SITE_CSS.replace('navigation: auto;', 'navigation: none;') : SITE_CSS;
}

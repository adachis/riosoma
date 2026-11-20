// Browser-resolved theme colors feed the same opaque-color algorithm as custom brand colors.
const fs = require('fs');
const path = require('path');
const { adjustForContrast, legibleOn, contrastRatio, mix } = require('./legibility.cjs');

// Choice colors come from the shared tokens, so the tier and the defaults never drift apart.
const CHOICES = Object.fromEntries([...fs.readFileSync(path.join(__dirname, '../packages/tokens/src/base.css'), 'utf8')
  .matchAll(/--rio-choice-([a-z]+):\s*(#[0-9a-f]{6});/g)].filter((m) => m[1] !== 'on').map((m) => [m[1], m[2]]));
// Pills are this much choice color mixed into the page, matching base.css.
const CHOICE_TINT = 0.22;

const weights = JSON.parse(fs.readFileSync(path.join(__dirname, 'theme_config.json'), 'utf8'))._legibility;
const tintVariables = ['surface', 'hover', 'pressed', 'selected'].map((name) => `--rio-legible-${name}-tint`);
const pairs = {
  text: ['text', ['bg', 'surface', 'sunken', 'raised', 'bg-hover', 'bg-pressed', 'surface-hover', 'surface-pressed', 'selected'], 4.5],
  'on-accent': ['on-accent', ['accent'], 4.5],
  'accent-text': ['accent', ['bg', 'surface'], 4.5],
  'text-muted': ['text-muted', ['bg', 'surface', 'sunken', 'raised', 'bg-hover', 'bg-pressed', 'surface-hover', 'surface-pressed', 'selected'], 4.5],
  link: ['link', ['bg', 'surface'], 4.5],
  focus: ['focus', ['bg', 'surface'], 3],
  border: ['border', ['bg', 'surface'], 3],
};
for (const status of ['success', 'warning', 'danger', 'info']) {
  pairs[`${status}-text`] = [status, ['bg', 'surface', 'sunken', 'raised', 'bg-hover', 'bg-pressed', 'surface-hover', 'surface-pressed'], 4.5];
  pairs[`on-${status}`] = [`on-${status}`, [status], 4.5];
}
const choiceVariables = Object.keys(CHOICES).flatMap((name) => [`--rio-aa-choice-${name}`, `--rio-aa-choice-${name}-soft`]);
const variables = [...Object.keys(pairs).map((name) => `--rio-aa-${name}`), '--rio-legible-text', '--rio-legible-text-muted', '--rio-legible-on-accent', '--rio-aa-choice-text', ...choiceVariables, ...tintVariables];
const marker = '/* Riosoma legibility tier */';
const hex = (color) => '#' + color.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const composite = (color, background) => color.slice(0, 3).map((v, i) =>
  Math.round(v * color[3] / 255 + background[i] * (1 - color[3] / 255))).concat(255);
const ratio = (color, background) => contrastRatio(hex(composite(color, background)), hex(background));
const cssColor = (color, raw) => color[3] === 255 ? hex(color) : raw;
const rgbaHex = (color) => [...color.slice(1).match(/../g).map((v) => parseInt(v, 16)), 255];

function tier(snapshot) {
  const colors = { ...snapshot.rio, ...snapshot.derived, ...snapshot.onColors };
  const values = {};
  const blend = (foreground, background, weight) => foreground.slice(0, 3).map((value, i) =>
    Math.round(value * weight + background[i] * (1 - weight))).concat(255);
  // Some palettes leave too little headroom for their usual interaction tint. Reduce the shared
  // tint strengths until text can stay readable without flattening the surface colors.
  for (let scale = 1; ; scale /= 2) {
    const tint = Object.fromEntries(Object.entries(weights).map(([name, weight]) => [name, weight * scale / 100]));
    colors.sunken = rgbaHex(mix(hex(colors.text), hex(colors.bg), tint.surfaceTint));
    colors.raised = rgbaHex(mix(hex(colors.text), hex(colors.surface), tint.surfaceTint));
    colors.selected = blend(colors.accent, colors.bg, tint.selectedTint);
    for (const surface of ['bg', 'surface']) {
      colors[`${surface}-hover`] = blend(colors.text, colors[surface], tint.hoverTint);
      colors[`${surface}-pressed`] = blend(colors.text, colors[surface], tint.pressedTint);
    }
    const backgrounds = pairs.text[1].map((name) => hex(colors[name]));
    if (adjustForContrast(hex(colors.text), backgrounds, 4.6) &&
        adjustForContrast(hex(colors['text-muted']), backgrounds, 4.6)) {
      for (const name of ['surface', 'hover', 'pressed', 'selected']) {
        values[`--rio-legible-${name}-tint`] = `${weights[`${name}Tint`] * scale}%`;
      }
      break;
    }
    if (scale < 1 / 1024) throw new Error('No readable text across theme surfaces');
  }
  let adjusted = 0;
  for (const [name, [source, backgrounds, target]] of Object.entries(pairs)) {
    const generationTarget = backgrounds.some((key) => snapshot.derived[key]) ? target + 0.1 : target;
    const sourceKey = colors[source] ? source : name.startsWith('on-') ? 'on-accent' : source;
    const original = colors[sourceKey];
    const bgs = backgrounds.map((key) => colors[key]);
    if (!original || bgs.some((bg) => !bg || bg[3] !== 255)) throw new Error(`Unresolved or translucent background for ${name}`);
    let value;
    if (bgs.every((bg) => ratio(original, bg) >= generationTarget)) value = cssColor(original, snapshot.rawColors[sourceKey]);
    else {
      if (name.startsWith('on-')) {
        const passing = ['text', 'bg'].find((key) => ratio(colors[key], bgs[0]) >= generationTarget);
        value = passing ? cssColor(colors[passing], snapshot.rawColors[passing]) : legibleOn(hex(bgs[0]), [hex(composite(original, bgs[0]))], generationTarget);
      } else {
        value = adjustForContrast(hex(composite(original, bgs[0])), bgs.map(hex), generationTarget);
      }
      adjusted++;
    }
    if (!value) throw new Error(`No legible color for ${name}`);
    values[`--rio-aa-${name}`] = value;
  }
  values['--rio-legible-text'] = values['--rio-aa-text'];
  values['--rio-legible-text-muted'] = values['--rio-aa-text-muted'];
  values['--rio-legible-on-accent'] = values['--rio-aa-on-accent'];
  // Choice colors: lines and dots at 3:1 against the page and surfaces, and pill tints with a text
  // color that reads at 4.5:1 on every one of them (body text, unless a theme's text is too light).
  const bg = hex(colors.bg);
  const pages = [colors.bg, colors.surface].map(hex);
  const lines = {};
  const softs = {};
  for (const [name, strong] of Object.entries(CHOICES)) {
    let line = strong;
    if (!pages.every((page) => contrastRatio(strong, page) >= 3)) {
      line = adjustForContrast(strong, pages, 3);
      adjusted++;
    }
    if (!line) throw new Error(`No legible choice color for ${name}`);
    lines[name] = line;
    softs[name] = mix(line, bg, CHOICE_TINT);
  }
  const text = hex(composite(colors.text, colors.bg));
  const tints = Object.values(softs);
  let pillText = text;
  if (!tints.every((tint) => contrastRatio(text, tint) >= 4.5)) {
    pillText =
      adjustForContrast(text, tints, 4.5) ??
      ['#000000', '#ffffff'].find((c) => tints.every((tint) => contrastRatio(c, tint) >= 4.5)) ??
      null;
    adjusted++;
  }
  if (!pillText) throw new Error('No legible text color for choice pills');
  values['--rio-aa-choice-text'] = pillText;
  for (const name of Object.keys(CHOICES)) {
    values[`--rio-aa-choice-${name}`] = lines[name];
    values[`--rio-aa-choice-${name}-soft`] = softs[name];
  }
  return { values, adjusted };
}

function stylesheet(manifest, contexts) {
  const rules = [];
  const rule = (selectors, values) => rules.push(`${selectors.join(', ')} {\n` +
    Object.entries(values).map(([key, value]) => `  ${key}: ${value};`).join('\n') + '\n}');
  for (const scheme of manifest.schemes) {
    const schemeSelector = `[data-scheme="${scheme}"]`;
    const roots = scheme === manifest.defaultScheme ? [':root:where(:not([data-scheme]))'] : [];
    const base = contexts[scheme].default;
    const values = { ...base.default };
    // Surface palettes inherit with their scheme, so surface-only containers
    // do not need ancestor selectors that could leak across a nested scheme.
    for (const surface of manifest.surfaces || []) {
      for (const [key, color] of Object.entries(base[surface])) values[`${key}-surface-${surface}`] = color;
    }
    rule([...roots, schemeSelector], values);
    for (const mode of manifest.modes || []) {
      const modeValues = { ...contexts[scheme][mode].default };
      for (const surface of manifest.surfaces || []) {
        for (const [key, color] of Object.entries(contexts[scheme][mode][surface])) {
          modeValues[`${key}-surface-${surface}`] = color;
        }
      }
      rule([...roots, schemeSelector].map((sel) => `${sel}[data-mode="${mode}"]`), modeValues);
    }
  }
  for (const surface of manifest.surfaces || []) {
    // Match scheme/mode combinations with sufficient specificity, while using the
    // inherited palette for a surface-only container.
    rule([`[data-surface="${surface}"]`, `[data-scheme][data-surface="${surface}"]`,
      `[data-mode][data-surface="${surface}"]`, `[data-scheme][data-mode][data-surface="${surface}"]`],
    Object.fromEntries(variables.map((key) => [key, `var(${key}-surface-${surface})`])));
  }
  return '\n' + marker + '\n' + rules.join('\n') + '\n';
}

function check(snapshot, result, location, expected) {
  for (const [name, [, backgrounds, target]] of Object.entries(pairs)) {
    const key = `--rio-aa-${name}`;
    const color = snapshot.aa[key];
    if (!color) result.errors.push(`${key} does not resolve at ${location}`);
    else for (const background of backgrounds) {
      const bg = snapshot.rio[background] || snapshot.derived[background];
      if (!bg || bg[3] !== 255 || ratio(color, bg) < target) {
        result.errors.push(`${key} fails ${target}:1 against --rio-${background} at ${location}`);
      }
    }
    if (expected && JSON.stringify(color) !== JSON.stringify(expected.aa[key])) {
      result.errors.push(`${key} differs from the root at ${location}`);
    }
  }
  for (const name of Object.keys(CHOICES)) {
    const line = snapshot.aa[`--rio-aa-choice-${name}`];
    const soft = snapshot.aa[`--rio-aa-choice-${name}-soft`];
    if (!line || !soft) {
      result.errors.push(`--rio-aa-choice-${name} does not resolve at ${location}`);
      continue;
    }
    for (const background of ['bg', 'surface']) {
      const bg = snapshot.rio[background];
      if (!bg || bg[3] !== 255 || ratio(line, bg) < 3) {
        result.errors.push(`--rio-aa-choice-${name} fails 3:1 against --rio-${background} at ${location}`);
      }
    }
    const text = snapshot.aa['--rio-aa-choice-text'];
    if (!text || ratio(text, soft) < 4.5) {
      result.errors.push(`--rio-aa-choice-text fails 4.5:1 on --rio-aa-choice-${name}-soft at ${location}`);
    }
    if (expected) {
      for (const key of ['--rio-aa-choice-text', `--rio-aa-choice-${name}`, `--rio-aa-choice-${name}-soft`]) {
        if (JSON.stringify(snapshot.aa[key]) !== JSON.stringify(expected.aa[key])) {
          result.errors.push(`${key} differs from the root at ${location}`);
        }
      }
    }
  }
}

module.exports = { variables, marker, tier, stylesheet, check };

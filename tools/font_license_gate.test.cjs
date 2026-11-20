const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { checkTheme, policy } = require('./font_license_gate.cjs');

const approved = policy();
const root = path.resolve(__dirname, '../themes');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'nature/theme.json'), 'utf8'));
const css = fs.readFileSync(path.join(root, 'nature/theme.css'), 'utf8');
const check = (value, fonts = manifest) => checkTheme('nature', value, fonts, approved, { checkFiles: false });
const scratch = path.join(__dirname, '.unit-logs');
fs.mkdirSync(scratch, { recursive: true });

test('licensed theme stacks, faces, and generic fallbacks pass', () => {
  assert.deepEqual(check(css).errors, []);
  assert.ok(check(css).families.includes('DM Sans'));
});

test('proprietary families fail in declarations, fallbacks, shorthands, and variables', () => {
  for (const extra of [
    'h1 { font-family: "Univers Next Pro", sans-serif; }',
    'h1 { font-family: "DM Sans", "Univers Next Pro"; }',
    'h1 { font: 700 32px/1.2 "Univers Next Pro"; }',
    ':root { --body: 400 16px "Univers Next Pro"; } p { font: var(--body); }',
    ':root { --font-unused: 400 16px "Univers Next Pro"; }',
    ':root { --size: 24px; } h1 { font: 700 var(--size) "Univers Next Pro"; }',
    'h1 { font: 700 var(--unknown-size) "Univers Next Pro"; }',
    'h1 { font: var(--unknown, 400 16px "Univers Next Pro"); }',
    ':root { --heading: "Univers Next Pro"; } h1 { font-family: var(--heading); }',
    ':root { --font-unused: "Univers Next Pro"; }',
    'h1 { font-family: var(--unknown, "Univers Next Pro"); }',
    'h1 { font-family: "Univers\\20 Next Pro"; }',
    'h1 { font-\\66 amily: "Univers Next Pro"; }',
  ]) assert.match(check(css + extra).errors.join('\n'), /Unapproved font family: Univers Next Pro/, extra);
});

test('standard property names are case insensitive while custom property names stay distinct', () => {
  for (const property of ['FONT-FAMILY', 'Font-Family', 'FONT', 'Font']) {
    const value = property.toLowerCase() === 'font' ? '700 3vw "Univers Next Pro"' : '"Univers Next Pro"';
    assert.match(check(`h1 { ${property}: ${value}; }`, {}).errors.join('\n'), /Unapproved font family: Univers Next Pro/);
  }
  const result = check(':root { --Family: "DM Sans"; --family: "Univers Next Pro"; } h1 { FONT-FAMILY: var(--Family); }', {});
  assert.ok(result.families.includes('DM Sans'));
  assert.deepEqual(result.errors, ['Unapproved font family: Univers Next Pro']);
});

const sizes = [
  ...['px', 'pt', 'pc', 'in', 'cm', 'mm', 'q', 'em', 'rem', 'ex', 'rex', 'cap', 'rcap', 'ch', 'rch',
    'ic', 'ric', 'lh', 'rlh', 'vw', 'vh', 'vi', 'vb', 'vmin', 'vmax', 'svw', 'svh', 'svi', 'svb',
    'svmin', 'svmax', 'lvw', 'lvh', 'lvi', 'lvb', 'lvmin', 'lvmax', 'dvw', 'dvh', 'dvi', 'dvb',
    'dvmin', 'dvmax', 'cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax', '%'].map((unit) => `2${unit}`),
  '0', '+0', '-0', '0.0', '.5CH', '1e1px', 'xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large',
  'xxx-large', 'smaller', 'larger', 'math', 'calc(1rem + 2vw)', 'min(2ch, 3vw)', 'max(2ch, 3vw)',
  'clamp(1rem, calc(2ch + 3vw), 4rem)',
  'env(safe-area-inset-top, 16px)', 'attr(data-size type(<length>), 16px)',
];

test('font shorthands validate families across size units, keywords, and nested functions', () => {
  for (const size of sizes) {
    for (const lineHeight of ['', '/1.2', ' / calc(1 + .2)']) {
      const declaration = `h1 { font: italic 700 ${size}${lineHeight} "Univers Next Pro", sans-serif !important; }`;
      assert.match(check(declaration, {}).errors.join('\n'), /Unapproved font family: Univers Next Pro/, declaration);
      const licensed = check(declaration.replace('Univers Next Pro', 'DM Sans'), {});
      assert.deepEqual(licensed.errors, [], declaration);
      assert.ok(licensed.families.includes('DM Sans'), declaration);
    }
  }
});

test('font declarations that cannot be validated fail closed', () => {
  for (const declaration of [
    'font: 700 mystery-size "DM Sans"',
    'font: 700 3vw',
    'font: var(--missing)',
    '--é: 3vw "Univers Next Pro",; font: 700 var(--é) "DM Sans"',
    'font-family: var(--missing)',
    '--cycle: var(--cycle); font: var(--cycle)',
    '--Cycle: "DM Sans"; font-family: var(--cycle)',
    'font: 700 unknown(16px) "DM Sans"',
    'font: 700 calc(1rem + 2vw "DM Sans"',
  ]) assert.ok(check(`h1 { ${declaration}; }`, {}).errors.length > 0, declaration);
  for (const value of ['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'caption', 'icon', 'menu',
    'message-box', 'small-caption', 'status-bar']) {
    assert.deepEqual(check(`h1 { FONT: ${value}; }`, {}).errors, [], value);
  }
});

test('repeated variables, nested fallbacks, and line height functions preserve licensed families', () => {
  for (const declaration of [
    ':root { --size: 1rem; } h1 { font: 700 calc(var(--size) + var(--size))/calc(var(--size) * 2) "DM Sans"; }',
    ':root { --face: "DM Sans"; } h1 { font-family: var(--face), var(--face), sans-serif; }',
    'h1 { font: var(--missing, 700 clamp(1rem, calc(2vw + 1ch), 3rem)/1.2 "DM Sans"); }',
  ]) {
    const result = check(declaration, {});
    assert.deepEqual(result.errors, [], declaration);
    assert.ok(result.families.includes('DM Sans'), declaration);
  }
});

test('a proprietary file cannot borrow an approved family name', () => {
  const extra = '@font-face { font-family: "DM Sans"; src: url(assets/fonts/MarketDisplay.ttf); }';
  assert.match(check(css + extra).errors.join('\n'), /Unapproved font reference/);
  assert.match(check(css, { ...manifest, assets: [{ path: 'assets/fonts/MarketDisplay.ttf' }] }).errors.join('\n'),
    /Unapproved bundled font file/);
});

test('remote sources must match both the approved family and the exact local path', () => {
  const font = manifest.remoteFonts[0];
  for (const changed of [
    { ...font, sourceUrl: 'https://example.test/MarketDisplay.woff2' },
    { ...font, family: 'DM Sans' },
    { ...font, path: 'assets/fonts/remote/unreviewed.woff2' },
  ]) {
    if (changed.family === font.family && changed.path === font.path && changed.sourceUrl === font.sourceUrl) continue;
    assert.match(check(css, { ...manifest, remoteFonts: [changed] }).errors.join('\n'), /Unapproved font file/);
  }
});

test('renaming proprietary bytes to an approved file still fails', () => {
  const tmp = fs.mkdtempSync(path.join(scratch, 'font-gate-bytes-'));
  try {
    const font = manifest.remoteFonts[0];
    const filename = path.join(tmp, font.path);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, 'unlicensed font bytes');
    const sources = new Map(approved.sources);
    sources.set(font.sourceUrl, {
      family: font.family,
      sha256: createHash('sha256').update('licensed font bytes').digest('hex'),
    });
    const result = checkTheme('nature', css, { ...manifest, remoteFonts: [font] },
      { ...approved, sources }, { themeRoot: tmp });
    assert.match(result.errors.join('\n'), /Font file fingerprint differs/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the build license command exits unsuccessfully for an injected proprietary family', () => {
  const tmp = fs.mkdtempSync(path.join(scratch, 'font-gate-build-'));
  try {
    fs.mkdirSync(path.join(tmp, 'nature'));
    fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify({ themes: [
      { id: 'nature', manifest: 'nature/theme.json', css: 'nature/theme.css' },
    ] }));
    fs.writeFileSync(path.join(tmp, 'nature/theme.json'), JSON.stringify(manifest));
    for (const declaration of ['font-family: "Univers Next Pro"', 'FONT-FAMILY: "Univers Next Pro"',
      'font: 700 3vw "Univers Next Pro"', 'font: 700 2ch "Univers Next Pro"']) {
      fs.writeFileSync(path.join(tmp, 'nature/theme.css'), css + `\nh1 { ${declaration}; }`);
      const run = spawnSync(process.execPath, [path.join(__dirname, 'font_license_gate.cjs'),
        '--themes-dir', tmp, '--allow-missing-assets'], { encoding: 'utf8' });
      assert.equal(run.status, 1, declaration);
      assert.match(run.stderr, /Unapproved font family: Univers Next Pro/);
      assert.equal(fs.existsSync(path.join(tmp, 'FONT-LICENSES.md')), false);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

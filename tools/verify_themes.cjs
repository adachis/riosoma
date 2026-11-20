// Headless-browser checks for the generated themes, run by tools/build_themes.py.
// Reads {themeId: {defaultScheme, schemes, modes, defaultMode}} on stdin and prints a JSON report on stdout.
//
// Errors (the build fails):
//   - an untagged page doesn't match data-scheme="<default>"
//   - a scheme doesn't change anything compared with the default
//   - two schemes resolve to identical values
//   - a mode doesn't change anything
//   - a nested scheme differs from its root values
//   - semantic values drift, external resources remain, or component layers lose
//   - element styles escape prose, or prose loses the original typography
// Missing local font files and low contrast are notes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const legibility = require('./legibility.cjs');
const tier = require('./legibility-theme.cjs');
const fontLicenses = require('./font_license_gate.cjs');
const approvedFonts = fontLicenses.policy();

const THEMES = path.resolve(__dirname, '..', 'themes');
// Background variables to try, in order, when the page body has no solid background of its own.
const BG_VARS = ['--bg-page', '--bg', '--bg-base', '--page-bg', '--color-bg', '--surface-page', '--canvas-0',
  '--paper', '--paper-1', '--k-bg', '--gl-bg', '--gf-bg', '--ds-paper', '--neu-surface', '--surface', '--window-bg'];

async function checkProseSelectors(page) {
  const source = `
    :root { --global: 17px; color: rgb(20, 30, 40); font-family: monospace; }
    body { border-top: 3px solid; }
    * { box-sizing: border-box; }
    a, .theme-link { --mixed: 19px; border-bottom: 2px solid; }
    .theme-part > i { border-left: 5px solid; }
    :where(button, input) { font-family: monospace; }
    ::selection { background-color: rgb(40, 50, 60); }
    ::placeholder { color: rgb(60, 70, 80); }
    ::-webkit-scrollbar { width: 7px; }
    @media (min-width: 0px) {
      html[data-mode="dark"] { outline-color: rgb(80, 90, 100); }
      [data-scheme="night"] h1 { letter-spacing: 3px; }
      [data-surface="paper"] * { text-decoration-color: rgb(100, 110, 120); }
    }
    @supports (display: grid) { p { word-spacing: 2px; } }
    @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
    @font-face { font-family: fixture; src: local("fixture"); }
  `;
  const scoped = execFileSync('python3', ['-c',
    'import sys; from build_themes import scope_prose; print(scope_prose(sys.stdin.read()))'],
  { cwd: __dirname, input: source, encoding: 'utf8' });
  await page.setContent('<div id="outside"><a></a><div class="theme-part"><i></i></div></div>' +
    '<div id="ancestor"><div class="rio-prose"><a></a><h1></h1><p></p><input placeholder="input"></div></div>' +
    '<a class="rio-prose"></a><a class="theme-link"></a>');
  await page.addStyleTag({ content: scoped });
  const observations = await page.evaluate(() => {
    const get = (selector, property, pseudo = null) =>
      getComputedStyle(document.querySelector(selector), pseudo).getPropertyValue(property).trim();
    const prose = document.querySelector('div.rio-prose');
    const contexts = [];
    for (const host of [prose, document.getElementById('ancestor'), document.documentElement]) {
      for (const [name, value] of [['data-mode', 'dark'], ['data-scheme', 'night'], ['data-surface', 'paper']]) {
        host.setAttribute(name, value);
      }
      contexts.push([
        get('div.rio-prose', 'outline-color'),
        get('.rio-prose h1', 'letter-spacing'),
        get('.rio-prose', 'text-decoration-color'),
        get('.rio-prose p', 'text-decoration-color'),
      ]);
      for (const name of ['data-mode', 'data-scheme', 'data-surface']) host.removeAttribute(name);
    }
    const rules = [...document.styleSheets[0].cssRules];
    return {
      outside: [get('body', 'border-top-width'), get('#outside a', 'border-bottom-width'), get('#outside', 'box-sizing')],
      tokens: [get('#outside', '--global'), get('#outside a', '--mixed')],
      inside: [get('.rio-prose', 'border-top-width'), get('.rio-prose a', 'border-bottom-width'),
        get('a.rio-prose', 'border-bottom-width'), get('.rio-prose p', 'word-spacing'),
        get('.rio-prose input', 'font-family'), get('.rio-prose p', 'background-color', '::selection'),
        get('.rio-prose input', 'color', '::placeholder'), get('.rio-prose', 'width', '::-webkit-scrollbar')],
      classes: [get('.theme-link', 'border-bottom-width'), get('.theme-part i', 'border-left-width')],
      keyframes: rules.find((rule) => rule.type === CSSRule.KEYFRAMES_RULE).cssRules[0].keyText,
      font: rules.find((rule) => rule.type === CSSRule.FONT_FACE_RULE).style.fontFamily,
      contexts,
    };
  });
  assert.deepEqual(observations.outside, ['0px', '0px', 'content-box']);
  assert.deepEqual(observations.tokens, ['17px', '19px']);
  assert.deepEqual(observations.inside, ['3px', '2px', '2px', '2px', 'monospace', 'rgb(40, 50, 60)', 'rgb(60, 70, 80)', '7px']);
  assert.deepEqual(observations.classes, ['2px', '5px']);
  assert.equal(observations.keyframes, '0%');
  assert.equal(observations.font, 'fixture');
  for (const context of observations.contexts) {
    assert.deepEqual(context, ['rgb(80, 90, 100)', '3px', 'rgb(100, 110, 120)', 'rgb(100, 110, 120)']);
  }
  // A later type selector must still beat the scoped type selector.
  await page.addStyleTag({ content: 'a { border-bottom-width: 4px; }' });
  assert.equal(await page.locator('a.rio-prose').evaluate((el) => getComputedStyle(el).borderBottomWidth), '4px');
}

async function checkStylesheet(page, css, cssPath, manifest, result) {
  const licensed = fontLicenses.checkTheme(path.basename(path.dirname(cssPath)), css, manifest, approvedFonts);
  result.errors.push(...licensed.errors);
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@import\b/i.test(code)) result.errors.push('stylesheet contains an import');
  if (/url\(\s*["']?(?:https?:|\/\/)/i.test(code)) result.errors.push('stylesheet contains a remote URL');
  if (/!\s*important\b/i.test(code)) result.errors.push('stylesheet contains a priority flag');
  const parsed = await page.evaluate((css) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const fonts = [], errors = [];
    const walk = (rules, inTheme) => {
      for (const rule of rules) {
        const inside = inTheme || (rule.constructor.name === 'CSSLayerBlockRule' && rule.name === 'rio.theme');
        if (!inside) errors.push('rule outside the theme layer');
        if (rule.type === CSSRule.IMPORT_RULE) errors.push('parsed import remains');
        if (rule.style) {
          for (const property of rule.style) {
            if (rule.style.getPropertyPriority(property)) errors.push(`priority flag on ${property}`);
          }
        }
        if (rule.type === CSSRule.FONT_FACE_RULE) {
          const src = rule.style.getPropertyValue('src');
          for (const match of src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) fonts.push(match[1].trim());
        }
        if (rule.cssRules) walk(rule.cssRules, inside);
      }
    };
    if (!sheet || !sheet.cssRules.length) errors.push('empty theme stylesheet');
    else walk(sheet.cssRules, false);
    return { fonts, errors };
  }, css);
  result.errors.push(...new Set(parsed.errors));
  const listed = new Set([...(manifest.assets || []), ...(manifest.remoteFonts || [])].map((f) => f.path));
  const missing = new Set();
  for (const font of new Set(parsed.fonts)) {
    const local = font.split(/[?#]/)[0];
    if (!listed.has(local)) result.errors.push(`font source is absent from the manifest: ${font}`);
    else if (!fs.existsSync(path.join(path.dirname(cssPath), local))) missing.add(local);
  }
  if (missing.size) result.warnings.push(`${missing.size} local font files are missing. Run tools/fetch_theme_assets.py to fetch assets.`);
}

async function checkComponents(page, tmp, manifest, result) {
  const componentPath = path.join(tmp, 'components.css');
  fs.writeFileSync(componentPath, '@layer rio.components { ' +
    'button.probe, a.probe, h1.probe, input.probe, body.probe, *.probe {' +
    'background-color: rgb(1, 2, 3); color: rgb(4, 5, 6); animation: none; transition: none; } }');
  await page.evaluate(async (componentPath) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `file://${componentPath}`;
    const loaded = new Promise((resolve, reject) => { link.onload = resolve; link.onerror = reject; });
    // Put the component rule before the theme so source order cannot hide a broken layer.
    document.head.insertBefore(link, document.head.lastElementChild);
    await loaded;
    document.body.classList.add('probe', 'rio-prose');
    for (const tag of ['button', 'a', 'h1', 'input', 'div']) {
      const el = document.createElement(tag);
      el.className = 'probe';
      document.body.append(el);
    }
  }, componentPath);
  for (const scheme of manifest.schemes) {
    for (const mode of [null, ...(manifest.modes || [])]) {
      const failures = await page.evaluate(({ scheme, mode }) => {
        document.documentElement.setAttribute('data-scheme', scheme);
        if (mode) document.documentElement.setAttribute('data-mode', mode);
        else document.documentElement.removeAttribute('data-mode');
        return [...document.querySelectorAll('.probe')].filter((el) => {
          const style = getComputedStyle(el);
          return style.backgroundColor !== 'rgb(1, 2, 3)' || style.color !== 'rgb(4, 5, 6)';
        }).map((el) => el.tagName.toLowerCase());
      }, { scheme, mode });
      if (failures.length) result.errors.push(`component layer loses in ${scheme}/${mode || 'default'}: ${failures.join(', ')}`);
    }
  }
}

async function checkProse(page, tmp, cssPath, manifest, result) {
  const fixture = path.join(tmp, 'prose.html');
  fs.writeFileSync(fixture, '<!doctype html><html><head>' +
    `<base href="file://${path.dirname(cssPath)}/"><link id="theme" rel="stylesheet" href="file://${cssPath}">` +
    '</head><body></body></html>');
  await page.goto(`file://${fixture}`, { waitUntil: 'load' });
  const dark = manifest.schemes.find((scheme) => scheme !== manifest.defaultScheme && result.appearance[scheme] === 'dark') ||
    manifest.schemes.find((scheme) => result.appearance[scheme] === 'dark');
  const schemes = [...new Set([manifest.defaultScheme, dark].filter(Boolean))];
  const failures = await page.evaluate(({ schemes, reference }) => {
    const errors = [];
    const theme = document.getElementById('theme').sheet;
    const original = document.createElement('style');
    original.textContent = reference;
    document.head.append(original);
    original.sheet.disabled = true;
    const tags = ['a', 'h1', 'h2', 'p', 'button', 'input', 'select', 'textarea', 'hr',
      'code', 'pre', 'ul', 'li', 'img', 'table'];
    const populate = (parent) => tags.map((tag) => {
      const el = document.createElement(tag);
      if (!['input', 'hr', 'img'].includes(tag)) el.textContent = tag;
      if (tag === 'a') el.href = '#';
      if (tag === 'input' || tag === 'textarea') el.placeholder = tag;
      if (tag === 'img') { el.width = 16; el.height = 16; }
      parent.append(el);
      return el;
    });
    const snapshot = (elements, pseudo = null) => elements.map((el) => {
      const style = getComputedStyle(el, pseudo);
      return Object.fromEntries([...style].filter((name) =>
        !name.startsWith('--') && name !== 'color-scheme').map((name) => [name, style.getPropertyValue(name)]));
    });
    const typography = (elements) => elements.filter((el) => ['P', 'H1'].includes(el.tagName)).map((el) => {
      const style = getComputedStyle(el);
      return { tag: el.tagName.toLowerCase(), 'font-family': style.fontFamily, color: style.color };
    });
    for (const scheme of schemes) {
      document.body.replaceChildren();
      document.documentElement.setAttribute('data-scheme', scheme);
      theme.disabled = false;
      // Native controls also follow color-scheme.  Give the unthemed reference
      // the same inherited scheme so those browser defaults remain comparable.
      document.documentElement.style.colorScheme = '';
      document.documentElement.style.colorScheme = getComputedStyle(document.documentElement).colorScheme;
      const outside = [document.documentElement, document.body, ...populate(document.body)];
      for (const pseudo of [null, '::before', '::after', '::selection', '::placeholder',
        '::-webkit-scrollbar', '::-webkit-scrollbar-thumb', '::-webkit-scrollbar-track']) {
        theme.disabled = true;
        const baseline = snapshot(outside, pseudo);
        theme.disabled = false;
        const themed = snapshot(outside, pseudo);
        outside.forEach((el, i) => {
          const changed = Object.keys(baseline[i]).filter((name) => baseline[i][name] !== themed[i][name]);
          if (changed.length) errors.push(`outside prose ${scheme} ${el.tagName.toLowerCase()}${pseudo || ''}: ${changed.join(', ')}`);
        });
      }
      document.body.replaceChildren();
      const ancestor = document.createElement('div');
      const prose = document.createElement('div');
      document.body.append(ancestor);
      ancestor.append(prose);
      const elements = populate(prose);
      theme.disabled = true;
      const baseline = typography(elements);
      original.sheet.disabled = false;
      const expected = typography(elements);
      original.sheet.disabled = true;
      theme.disabled = false;
      prose.className = 'rio-prose';
      for (const location of [document.documentElement, ancestor, prose]) {
        for (const el of [document.documentElement, ancestor, prose]) el.removeAttribute('data-scheme');
        location.setAttribute('data-scheme', scheme);
        const actual = typography(elements);
        expected.forEach((entry, i) => {
          for (const property of ['font-family', 'color']) {
            if (entry[property] !== baseline[i][property] && actual[i][property] !== entry[property]) {
              errors.push(`inside prose ${scheme} ${location === prose ? 'self' : 'ancestor'} ${entry.tag} ${property}: expected ${entry[property]}, got ${actual[i][property]}`);
            }
          }
        });
      }
    }
    return errors;
  }, { schemes, reference: manifest.proseReference });
  result.errors.push(...failures);
}

async function main() {
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'legibility-vectors.json'), 'utf8'));
  for (const vector of vectors.adjust) {
    assert.equal(legibility.adjustForContrast(vector.color, vector.backgrounds, vector.target), vector.expected, vector.id);
  }
  for (const vector of vectors.on) {
    assert.equal(legibility.legibleOn(vector.fill, vector.candidates, vector.target), vector.expected, vector.id);
  }
  const writeLegibility = process.argv.includes('--write-legibility');
  const manifests = JSON.parse(fs.readFileSync(0, 'utf8'));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route('**/*', (route) => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
  await checkProseSelectors(page);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rio-verify-'));
  const report = {};
  const baselinePath = path.join(__dirname, 'semantic-baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  // An intended color change (a new scheme, a corrected token) is accepted by rewriting the
  // baseline from this run instead of comparing against it.
  const updateBaseline = process.env.RIO_UPDATE_BASELINE === '1';
  const nextBaseline = {};
  const order = path.join(tmp, 'order.css');
  fs.writeFileSync(order, '@layer rio.defaults, rio.theme, rio.base, rio.components, rio.app;');


  for (const [id, m] of Object.entries(manifests)) {
    const cssPath = path.join(THEMES, id, 'theme.css');
    let css = fs.readFileSync(cssPath, 'utf8');
    const vars = [...new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:/g)].map((x) => x[1]).filter((name) => !name.startsWith('--rio-aa-')))];
    vars.push('color-scheme');
    const html = path.join(tmp, `${id}.html`);
    fs.writeFileSync(html, `<!doctype html><html><head><link rel="stylesheet" href="file://${order}"><link rel="stylesheet" href="file://${cssPath}"></head>` +
      '<body class="rio-prose"><div id="nest"></div><div id="probe"></div></body></html>');
    await page.goto(`file://${html}`, { waitUntil: 'load' });

    const bgVars = m.backgroundVar ? [m.backgroundVar] : BG_VARS;
    const snap = (attrs, nested) => page.evaluate(({ attrs, nested, vars, bgVars, semanticKinds, aaVariables, onSources }) => {
      const root = document.documentElement;
      const nest = document.getElementById('nest');
      for (const a of ['data-scheme', 'data-mode', 'data-surface']) { root.removeAttribute(a); nest.removeAttribute(a); }
      for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
      for (const [k, v] of Object.entries(nested || {})) nest.setAttribute(k, v);
      const el = nested ? nest : root;
      const probeEl = document.getElementById('probe');
      (nested ? nest : document.body).append(probeEl);
      const cs = getComputedStyle(el);
      const values = {};
      for (const v of vars) values[v] = cs.getPropertyValue(v).trim();
      // Paint a color to a canvas to turn any CSS color syntax into sRGB bytes.
      const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');
      const rgba = (color) => {
        ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#00000000'; ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data];
      };
      let source = 'body background';
      let px = rgba(getComputedStyle(document.body).backgroundColor);
      if (px[3] < 200) { source = 'html background'; px = rgba(getComputedStyle(root).backgroundColor); }
      if (px[3] < 200 || bgVars.length === 1) {
        source = null;
        const probe = document.getElementById('probe');
        for (const v of bgVars) {
          probe.style.backgroundColor = `var(${v})`;
          const c = rgba(getComputedStyle(probe).backgroundColor);
          if (c[3] >= 200) { source = v; px = c; break; }
        }
      }
      // Resolve every --rio-* color to sRGB, and check the font and length tokens aren't empty.
      const rio = {};
      const rawColors = {};
      for (const [tok, kind] of Object.entries(semanticKinds)) {
        if (kind === 'color') {
          probeEl.style.backgroundColor = '';
          probeEl.style.backgroundColor = `var(--rio-${tok})`;
          const raw = getComputedStyle(probeEl).backgroundColor;
          rawColors[tok] = raw;
          rio[tok] = raw && raw !== 'rgba(0, 0, 0, 0)' ? rgba(raw) : null;
        } else {
          rio[tok] = getComputedStyle(el).getPropertyValue(`--rio-${tok}`).trim() || null;
        }
      }
      const resolveColor = (value, key) => {
        probeEl.style.backgroundColor = '';
        probeEl.style.backgroundColor = value;
        const raw = getComputedStyle(probeEl).backgroundColor;
        if (key) rawColors[key] = raw;
        return raw && raw !== 'rgba(0, 0, 0, 0)' ? rgba(raw) : null;
      };
      const aa = Object.fromEntries(aaVariables.map((key) => {
        const value = cs.getPropertyValue(key).trim();
        return [key, value && CSS.supports('color', value) ? resolveColor(`var(${key})`) : null];
      }));
      const onColors = Object.fromEntries(Object.entries(onSources).map(([key, source]) =>
        [key, resolveColor(source.startsWith('--') ? `var(${source})` : source, key)]));
      // Include the fills shared controls derive from semantic colors, including interaction tints.
      const derived = {
        sunken: resolveColor('color-mix(in oklab, var(--rio-ink) var(--rio-legible-surface-tint, 6%), var(--rio-bg))'),
        raised: resolveColor('color-mix(in oklab, var(--rio-ink) var(--rio-legible-surface-tint, 6%), var(--rio-surface))'),
        selected: resolveColor('color-mix(in srgb, var(--rio-accent) var(--rio-legible-selected-tint, 16%), var(--rio-bg))'),
      };
      for (const surface of ['bg', 'surface']) {
        derived[`${surface}-hover`] = resolveColor(`color-mix(in srgb, var(--rio-ink) var(--rio-legible-hover-tint, 8%), var(--rio-${surface}))`);
        derived[`${surface}-pressed`] = resolveColor(`color-mix(in srgb, var(--rio-ink) var(--rio-legible-pressed-tint, 14%), var(--rio-${surface}))`);
      }
      probeEl.style.backgroundColor = '';
      const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      const luminance = px[3] >= 200 ? 0.2126 * lin(px[0]) + 0.7152 * lin(px[1]) + 0.0722 * lin(px[2]) : null;
      return { values, luminance, source, rio, aa, onColors, rawColors, derived };
    }, { attrs, nested, vars, bgVars, semanticKinds: m.semantic || {}, aaVariables: tier.variables, onSources: m.legibilityOnColors || {} });

    const diff = (a, b) => vars.filter((v) => a.values[v] !== b.values[v]);
    const result = { errors: [], warnings: [], appearance: {}, backgroundSource: null };
    const contexts = {};
    let adjusted = 0;
    for (const scheme of m.schemes) {
      contexts[scheme] = {};
      for (const mode of [null, ...(m.modes || [])]) {
        const surfaces = contexts[scheme][mode || 'default'] = {};
        for (const surface of [null, ...(m.surfaces || [])]) {
          const attrs = { 'data-scheme': scheme };
          if (mode) attrs['data-mode'] = mode;
          if (surface) attrs['data-surface'] = surface;
          let generated;
          try { generated = tier.tier(await snap(attrs)); }
          catch (error) { throw new Error(`${id} ${scheme} ${mode || 'default'} ${surface || 'default'}: ${error.message}`); }
          surfaces[surface || 'default'] = generated.values;
          adjusted += generated.adjusted;
        }
      }
    }
    result.legibilityData = {
      legibility: Object.fromEntries(Object.entries(contexts).map(([scheme, modes]) =>
        [scheme, Object.fromEntries(Object.entries(modes).map(([mode, surfaces]) => [mode, surfaces.default]))])),
      ...(m.surfaces?.length ? {
        legibilitySurfaces: Object.fromEntries(Object.entries(contexts).map(([scheme, modes]) =>
        [scheme, Object.fromEntries(Object.entries(modes).map(([mode, surfaces]) =>
          [mode, Object.fromEntries(Object.entries(surfaces).filter(([surface]) => surface !== 'default'))]))])),
      } : {}),
      legibilityAdjusted: adjusted,
    };
    result.legibilityAdjusted = adjusted;
    if (writeLegibility) {
      const base = css.includes(tier.marker) ? css.split(tier.marker)[0].trimEnd() : css.trimEnd().slice(0, -1).trimEnd();
      css = base + '\n' + tier.stylesheet(m, contexts) + '}\n';
      fs.writeFileSync(cssPath, css);
      await page.reload({ waitUntil: 'load' });
    }
    // Every combination is measured again after loading the emitted stylesheet.
    // Both a fully specified nested scheme and a surface-only child must work.
    for (const scheme of m.schemes) {
      for (const mode of [null, ...(m.modes || [])]) {
        for (const surface of [null, ...(m.surfaces || [])]) {
          const attrs = { 'data-scheme': scheme };
          if (mode) attrs['data-mode'] = mode;
          if (surface) attrs['data-surface'] = surface;
          const label = `${scheme}/${mode || 'default'}/${surface || 'default'}`;
          const root = await snap(attrs);
          tier.check(root, result, label);
          const other = m.schemes.find((s) => s !== scheme) || scheme;
          const nested = await snap({ 'data-scheme': other }, attrs);
          tier.check(nested, result, `nested ${label}`, root);
          for (const [token, color] of Object.entries(root.rio)) {
            if (JSON.stringify(nested.rio[token]) !== JSON.stringify(color)) {
              result.errors.push(`--rio-${token} differs from the root at nested ${label}`);
            }
          }
          if (surface) {
            const parent = { 'data-scheme': scheme };
            if (mode) parent['data-mode'] = mode;
            tier.check(await snap(parent, { 'data-surface': surface }), result, `surface child ${label}`, root);
          }
        }
      }
    }
    const untagged = await snap({});
    tier.check(untagged, result, 'untagged', await snap({ 'data-scheme': m.defaultScheme }));
    for (const mode of [null, ...(m.modes || [])]) {
      for (const surface of [null, ...(m.surfaces || [])]) {
        const attrs = {};
        if (mode) attrs['data-mode'] = mode;
        if (surface) attrs['data-surface'] = surface;
        const root = await snap({ 'data-scheme': m.defaultScheme, ...attrs });
        tier.check(await snap(attrs), result, `untagged/${mode || 'default'}/${surface || 'default'}`, root);
      }
    }
    const snaps = {};
    for (const s of m.schemes) snaps[s] = await snap({ 'data-scheme': s });

    const d = diff(untagged, snaps[m.defaultScheme]);
    if (d.length) result.errors.push(`untagged page differs from data-scheme="${m.defaultScheme}" in ${d.length} variables (e.g. ${d.slice(0, 3).join(', ')})`);
    const seen = {};
    const nestedMisses = {};
    for (const s of m.schemes) {
      const snapshot = snaps[s];
      if (s !== m.defaultScheme && !diff(snapshot, snaps[m.defaultScheme]).length) result.errors.push(`scheme ${s} changes nothing compared with the default`);
      const sig = JSON.stringify(snapshot.values);
      if (seen[sig] && s !== m.defaultScheme) result.errors.push(`scheme ${s} is identical to ${seen[sig]}`);
      seen[sig] = seen[sig] || s;
      if (snapshot.luminance !== null) result.appearance[s] = snapshot.luminance < 0.18 ? 'dark' : 'light';
      else result.warnings.push(`scheme ${s} has no measurable page background, so its appearance is unknown`);
      result.backgroundSource = result.backgroundSource || snapshot.source;
      const other = m.schemes.find((x) => x !== s) || s;
      const nested = await snap({ 'data-scheme': other }, { 'data-scheme': s });
      // Variables this scheme never defines can leak down from the parent scheme. That's harmless.
      const nd = diff(nested, snapshot).filter((v) => snapshot.values[v] !== '');
      if (nd.length) nestedMisses[s] = nd;
    }
    // Semantic layer: every token resolves in every scheme, and the key pairs stay readable.
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const lowContrast = {};
    const unresolved = {};
    for (const s of m.schemes) {
      const r = snaps[s].rio;
      for (const [tok, v] of Object.entries(r)) if (v === null) (unresolved[tok] = unresolved[tok] || []).push(s);
      for (const [fg, bg, min] of [['text', 'bg', 4.5], ['text', 'surface', 4.5], ['on-accent', 'accent', 3]]) {
        if (r[fg] && r[bg] && r[fg][3] > 200 && r[bg][3] > 200 && contrast(r[fg], r[bg]) < min) {
          (lowContrast[`${fg} on ${bg}`] = lowContrast[`${fg} on ${bg}`] || []).push(`${s} ${contrast(r[fg], r[bg]).toFixed(1)}`);
        }
      }
    }
    for (const [tok, list] of Object.entries(unresolved)) result.errors.push(`--rio-${tok} doesn't resolve in ${list.length} of ${m.schemes.length} schemes (${list.slice(0, 3).join(', ')})`);
    for (const [pair, list] of Object.entries(lowContrast)) result.warnings.push(`--rio-${pair.replace(' on ', ' on --rio-')} is below ${pair.startsWith('on-') ? '3' : '4.5'}:1 in ${list.length} schemes (${list.slice(0, 3).join(', ')})`);
    result.semantic = Object.fromEntries(m.schemes.map((s) => [s, snaps[s].rio]));
    const missed = Object.keys(nestedMisses);
    if (missed.length) {
      const names = [...new Set(missed.flatMap((s) => nestedMisses[s]))];
      result.errors.push(`${missed.length} of ${m.schemes.length} schemes resolve differently on a nested container than on <html> (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''})`);
    }
    for (const mode of m.modes || []) {
      if (mode === m.defaultMode) continue;
      const ms = await snap({ 'data-scheme': m.defaultScheme, 'data-mode': mode });
      if (!diff(ms, snaps[m.defaultScheme]).length) result.errors.push(`mode ${mode} changes nothing`);
    }
    const untaggedMode = m.defaultMode ? await snap({ 'data-scheme': m.defaultScheme, 'data-mode': m.defaultMode }) : null;
    if (untaggedMode && diff(untaggedMode, snaps[m.defaultScheme]).length) {
      result.errors.push(`data-mode="${m.defaultMode}" is listed as the default mode but changes the page`);
    }
    const actual = { untagged: untagged.rio, schemes: {} };
    for (const s of m.schemes) {
      const modes = {};
      for (const mode of m.modes || []) {
        modes[mode] = (await snap({ 'data-scheme': s, 'data-mode': mode })).rio;
      }
      actual.schemes[s] = { default: snaps[s].rio, modes };
    }
    const compare = (current, expected, location) => {
      if (current && expected && typeof current === 'object' && typeof expected === 'object') {
        for (const key of new Set([...Object.keys(current), ...Object.keys(expected)])) {
          compare(current[key], expected[key], `${location}.${key}`);
        }
      } else if (current !== expected) {
        result.errors.push(`semantic baseline differs at ${location}: ${JSON.stringify(expected)} -> ${JSON.stringify(current)}`);
      }
    };
    if (updateBaseline) nextBaseline[id] = actual;
    else compare(actual, baseline[id], id);
    await checkStylesheet(page, css, cssPath, m, result);
    await checkComponents(page, tmp, m, result);
    await checkProse(page, tmp, cssPath, m, result);
    report[id] = result;
  }
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (updateBaseline) {
    const sortDeep = (v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]))
        : v;
    const lines = Object.keys(nextBaseline)
      .sort()
      .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(sortDeep(nextBaseline[k]))}`);
    fs.writeFileSync(baselinePath, `{\n${lines.join(',\n')}\n}\n`);
  }
  process.stdout.write(JSON.stringify(report));
}

main().catch((err) => { console.error(err); process.exit(1); });

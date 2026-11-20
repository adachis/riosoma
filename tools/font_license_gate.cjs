// Font files must come from reviewed Google Fonts stylesheets and match downloaded bytes.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const LICENSES = new Set(['OFL-1.1', 'Apache-2.0', 'Ubuntu-Font-License-1.0']);
const GENERICS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const decode = (value) => value.replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi,
  (_, hex, escaped) => hex ? String.fromCodePoint(parseInt(hex, 16)) : escaped);
const unquote = (value) => decode(value.trim().replace(/^(['"])(.*)\1$/, '$2'));
const GLOBAL_VALUES = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const SYSTEM_FONTS = /^(?:caption|icon|menu|message-box|small-caption|status-bar)$/i;
const FONT_SIZE = /^(?:[+-]?(?:0+(?:\.0+)?|\.0+)(?:e[+-]?\d+)?|[+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?(?:%|px|pt|pc|in|cm|mm|q|r?(?:em|ex|cap|ch|ic|lh)|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))|xx?-small|small|medium|large|x{1,3}-large|smaller|larger|math)$/i;
const SIZE_FUNCTION = /^(?:calc|min|max|clamp|round|mod|rem|sin|cos|tan|asin|acos|atan|atan2|pow|sqrt|hypot|log|exp|abs|sign|calc-size|anchor-size|env|attr|var)\(/i;

// Keep functions and quoted names intact when locating the size and optional line height.
function fontTokens(value) {
  const tokens = [];
  let start = 0, depth = 0, quote = '';
  for (let i = 0; i <= value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') { if (--depth < 0) return null; }
    else if (!depth && (char === undefined || /\s/.test(char) || char === '/')) {
      if (i > start) tokens.push({ value: value.slice(start, i), start });
      if (char === '/') tokens.push({ value: '/', start: i });
      start = i + 1;
    }
  }
  return depth || quote ? null : tokens;
}

function variableReference(value) {
  const match = /var\(\s*(--[\w-]+)\s*/i.exec(value);
  if (!match) return null;
  let depth = 1, quote = '', comma = -1;
  for (let i = match.index + match[0].length; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return {
      name: match[1], start: match.index, end: i + 1,
      fallback: comma < 0 ? null : value.slice(comma + 1, i).trim(),
    };
    else if (char === ',' && depth === 1 && comma < 0) comma = i;
  }
  return null;
}

function policy() {
  const families = JSON.parse(fs.readFileSync(path.join(__dirname, 'font-licenses.json'), 'utf8')).families;
  const fingerprints = JSON.parse(fs.readFileSync(path.join(__dirname, 'font-cache/files.json'), 'utf8'));
  const sources = new Map();
  const index = JSON.parse(fs.readFileSync(path.join(__dirname, 'font-cache/index.json'), 'utf8'));
  for (const [url, entry] of Object.entries(index)) {
    const stylesheet = new URL(url);
    if (stylesheet.protocol !== 'https:' || stylesheet.hostname !== 'fonts.googleapis.com') {
      throw new Error(`Unapproved font stylesheet: ${url}`);
    }
    const css = fs.readFileSync(path.join(__dirname, 'font-cache', entry.file), 'utf8');
    for (const face of css.matchAll(/@font-face\s*\{([^{}]*)\}/gi)) {
      const family = unquote(face[1].match(/font-family\s*:\s*([^;]+)/i)[1]);
      const license = families[family];
      if (!license || !license.isOpenSource || !LICENSES.has(license.license) || !license.licenseText) {
        throw new Error(`Unapproved cached font family: ${family}`);
      }
      for (const source of face[1].matchAll(/url\(\s*['"]?([^'"\s)]+)/gi)) {
        const parsed = new URL(source[1]);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'fonts.gstatic.com' || !parsed.pathname.endsWith('.woff2')) {
          throw new Error(`Unapproved font source: ${source[1]}`);
        }
        sources.set(source[1], { family, sha256: fingerprints[source[1]] });
      }
    }
  }
  return { families, sources };
}

function checkTheme(id, css, manifest, approved, options = {}) {
  const errors = [], used = new Set();
  const code = decode(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const declarations = [...code.matchAll(/([\w-]+)\s*:\s*([^;{}]*)/g)].map((m) => {
    const prop = decode(m[1]);
    return [prop.startsWith('--') ? prop : prop.toLowerCase(), m[2].trim().replace(/\s*!\s*important\s*$/i, '')];
  });
  const variables = new Map();
  for (const [prop, value] of declarations) {
    if (prop.startsWith('--')) variables.set(prop, [...(variables.get(prop) || []), value]);
  }
  const family = (name, face = false) => {
    name = unquote(name);
    if (!name || (!face && GENERICS.has(name.toLowerCase()))) return;
    const entry = approved.families[name];
    if (!entry || !entry.isOpenSource || !LICENSES.has(entry.license)) errors.push(`Unapproved font family: ${name}`);
    else used.add(name);
  };
  if (/@import\b/i.test(code)) errors.push('Font policy does not allow stylesheet imports');
  const invalid = (prop, value) => errors.push(`Cannot validate ${prop}: ${value}`);
  const expand = (value, seen, validate, strict) => {
    if (!variableReference(value)) return false;
    const resolve = (text, ancestors) => {
      const reference = variableReference(text);
      if (!reference) return [text];
      const sources = [...new Set(variables.get(reference.name) || [])];
      if (reference.fallback !== null) sources.push(reference.fallback);
      if (ancestors.has(reference.name) || !sources.length) {
        if (strict) invalid('font variable', reference.name);
        return [text];
      }
      // Cycle detection follows a variable's definition, so sibling references can repeat it.
      const next = new Set([...ancestors, reference.name]);
      const suffixes = resolve(text.slice(reference.end), ancestors);
      return sources.flatMap((source) => resolve(source, next).flatMap((expanded) =>
        suffixes.map((suffix) => text.slice(0, reference.start) + expanded + suffix)));
    };
    for (const expanded of new Set(resolve(value, seen))) validate(expanded, seen, strict, true);
    return true;
  };
  const stack = (value, seen = new Set(), strict = true, resolved = false) => {
    if (!resolved && expand(value, seen, stack, strict)) return;
    if (!value || !fontTokens(value) || /\bvar\(/i.test(value)) {
      if (strict) invalid('font-family', value);
      return;
    }
    for (const name of value.split(',')) {
      if (name.trim() && !GLOBAL_VALUES.test(name.trim())) family(name);
    }
  };
  const shorthand = (value, seen = new Set(), strict = true, resolved = false) => {
    if (GLOBAL_VALUES.test(value) || SYSTEM_FONTS.test(value)) return;
    if (!resolved && expand(value, seen, shorthand, strict)) return;
    if (strict && /\bvar\(/i.test(value)) invalid('font', value);
    const tokens = fontTokens(value);
    const size = tokens?.findIndex((token) => FONT_SIZE.test(token.value) || SIZE_FUNCTION.test(token.value)) ?? -1;
    let familyIndex = size + 1;
    if (tokens?.[familyIndex]?.value === '/') familyIndex += 2;
    if (size >= 0 && tokens[familyIndex]) stack(value.slice(tokens[familyIndex].start), seen, strict, resolved);
    else if (strict) invalid('font', value);
    else if (/^(?:['"]|[a-z])/i.test(value) && !/^(?:normal|bold|italic|calc|clamp)\b/i.test(value)) {
      stack(value, seen, false, resolved);
    }
  };
  for (const [prop, value] of declarations) {
    if (prop === 'font-family') stack(value);
    // Check even unused font stacks so a later component cannot activate an unreviewed face.
    else if (prop.startsWith('--') && /(?:font|family)/i.test(prop) &&
      /^(?:['"]|[a-z])/i.test(value) && !/^(?:var|calc|clamp|linear-gradient)\(/.test(value) &&
      !/^[\d.]/.test(value) && !/^(?:normal|bold|italic|block|swap|none|inherit|auto)$/.test(value)) stack(value);
    else if (prop === 'font') shorthand(value);
    else if (prop.startsWith('--') && /(?:font|family)/i.test(prop)) shorthand(value, new Set(), false);
  }
  const files = new Map();
  for (const font of manifest.remoteFonts || []) {
    const source = approved.sources.get(font.sourceUrl);
    const slug = font.family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const expected = `assets/fonts/remote/${slug}-${hash(font.sourceUrl).slice(0, 12)}.woff2`;
    if (!source || source.family !== font.family || font.path !== expected) {
      errors.push(`Unapproved font file: ${font.path}`);
      continue;
    }
    family(font.family, true);
    files.set(font.path, font);
    if (options.checkFiles !== false) {
      const filename = path.join(options.themeRoot || path.join(ROOT, 'themes', id), font.path);
      if (!source.sha256) errors.push(`Unverified font bytes: ${font.path}`);
      else if (!fs.existsSync(filename)) errors.push(`Missing licensed font file: ${font.path}`);
      else if (hash(fs.readFileSync(filename)) !== source.sha256) errors.push(`Font file fingerprint differs: ${font.path}`);
    }
  }
  for (const asset of manifest.assets || []) {
    if (/\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(asset.path)) errors.push(`Unapproved bundled font file: ${asset.path}`);
  }
  for (const face of code.matchAll(/@font-face\s*\{([^{}]*)\}/gi)) {
    const name = face[1].match(/font-family\s*:\s*([^;]+)/i);
    if (!name) errors.push('Font face has no family');
    else family(name[1], true);
    if (/local\(/i.test(face[1])) errors.push('Font face uses an unverified local source');
    const urls = [...face[1].matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)];
    if (!urls.length) errors.push('Font face has no approved file');
    for (const url of urls) {
      const font = files.get(url[1].trim());
      if (!font || (name && font.family !== unquote(name[1]))) errors.push(`Unapproved font reference: ${url[1]}`);
    }
  }
  for (const url of code.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
    if (/\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(url[1]) && !files.has(url[1].trim())) {
      errors.push(`Unapproved font reference: ${url[1]}`);
    }
  }
  return { errors: [...new Set(errors)], families: [...used].sort() };
}

function writeLicenses(themes, approved, output) {
  const usage = new Map();
  for (const [id, families] of Object.entries(themes)) for (const name of families) {
    usage.set(name, [...(usage.get(name) || []), id]);
  }
  const lines = ['# Theme font licenses', '', 'Generated from the checked-in font allowlist and theme references. Do not edit this file by hand.', '',
    '| Family | License | Themes | License source |', '| --- | --- | --- | --- |'];
  for (const name of [...usage.keys()].sort()) {
    const font = approved.families[name];
    lines.push(`| ${name} | ${font.license} | ${usage.get(name).sort().join(', ')} | [License](${font.source}) |`);
  }
  lines.push('', '## Copyright and license notices', '');
  for (const name of [...usage.keys()].sort()) {
    // Some upstream license files use Windows line endings.  The generated file always uses plain newlines.
    const notice = approved.families[name].licenseText.replace(/\r\n?/g, '\n').trim();
    lines.push(`### ${name}`, '', '```text', notice, '```', '');
  }
  fs.writeFileSync(output, lines.join('\n') + '\n');
}

function main() {
  const approved = policy(), usage = {}, errors = [];
  const directoryArg = process.argv.indexOf('--themes-dir');
  const themes = directoryArg < 0 ? path.join(ROOT, 'themes') : path.resolve(process.argv[directoryArg + 1]);
  const index = JSON.parse(fs.readFileSync(path.join(themes, 'index.json'), 'utf8'));
  for (const entry of index.themes) {
    const manifest = JSON.parse(fs.readFileSync(path.join(themes, entry.manifest), 'utf8'));
    const result = checkTheme(entry.id, fs.readFileSync(path.join(themes, entry.css), 'utf8'), manifest, approved,
      { checkFiles: !process.argv.includes('--allow-missing-assets'), themeRoot: path.join(themes, entry.id) });
    errors.push(...result.errors.map((error) => `${entry.id}: ${error}`));
    usage[entry.id] = result.families;
  }
  if (errors.length) throw new Error(errors.join('\n'));
  writeLicenses(usage, approved, path.join(themes, 'FONT-LICENSES.md'));
  console.log(`Verified open font licenses in ${index.themes.length} themes.`);
}

module.exports = { checkTheme, policy, writeLicenses };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

// Checks the translated message catalogs against the American English source.
//   node tools/i18n_check.mjs [--enabled | --locale fr] [--allow-missing]
// Fails when a message is missing or empty, when a translation's placeholders differ from the
// source, when ICU syntax doesn't parse, when a longer message was left in English, or when a
// product name (Riosoma, Rio) was translated away.
// --allow-missing permits untranslated messages while preserving syntax and placeholder checks.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@messageformat/parser';
import { enabledLocales } from './locales.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'apps/web/src/locales');
const SOURCE = 'en-US';
const TARGETS = ['es', 'fr', 'de', 'it', 'pt-BR', 'nl', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const NAMES = ['Riosoma', 'Rio'];

/** Reads msgid/msgstr pairs from a PO file, joining multi-line strings. */
function readPo(path) {
  const entries = new Map();
  let field = null;
  let current = { msgid: '', msgstr: '' };
  const flush = () => {
    if (current.msgid) entries.set(current.msgid, current.msgstr);
    current = { msgid: '', msgstr: '' };
  };
  const unquote = (s) => JSON.parse(s);
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith('msgid ')) {
      flush();
      field = 'msgid';
      current.msgid = unquote(line.slice(6));
    } else if (line.startsWith('msgstr ')) {
      field = 'msgstr';
      current.msgstr = unquote(line.slice(7));
    } else if (line.startsWith('"') && field) {
      current[field] += unquote(line);
    } else if (!line.trim()) {
      field = null;
    }
  }
  flush();
  return entries;
}

/** Argument names used anywhere in an ICU message, including inside plural and select. */
function argumentsOf(message) {
  const names = new Set();
  const walk = (tokens) => {
    for (const token of tokens) {
      if (token.type === 'argument' || token.type === 'function') names.add(token.arg);
      if (token.type === 'plural' || token.type === 'select' || token.type === 'selectordinal') {
        names.add(token.arg);
        for (const c of token.cases) walk(c.tokens);
      }
    }
  };
  walk(parse(message));
  return [...names].sort().join(',');
}

export function checkCatalog(source, target, { allowMissing = false } = {}) {
  const problems = [];
  let translated = 0;
  for (const [id, english] of source) {
    let sourceArgs;
    try {
      sourceArgs = argumentsOf(english);
    } catch {
      problems.push(`${id}: the English source isn't valid ICU`);
      continue;
    }
    const text = target.get(id);
    if (!text) {
      if (!allowMissing) problems.push(`${id}: missing`);
      continue;
    }
    translated += 1;
    let targetArgs;
    try {
      targetArgs = argumentsOf(text);
    } catch (error) {
      problems.push(`${id}: not valid ICU (${error.message})`);
      continue;
    }
    if (sourceArgs !== targetArgs)
      problems.push(`${id}: placeholders {${targetArgs}} should be {${sourceArgs}}`);
    if (!allowMissing && text === english && english.split(/\s+/).length >= 3)
      problems.push(`${id}: still in English`);
    for (const name of NAMES) {
      if (new RegExp(`\\b${name}\\b`).test(english) && !text.includes(name))
        problems.push(`${id}: keep "${name}" as is`);
    }
  }
  for (const id of target.keys()) if (!source.has(id)) problems.push(`${id}: not in the source catalog`);
  return { problems, translated };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const only = args.includes('--locale') ? args[args.indexOf('--locale') + 1] : null;
  const allowMissing = args.includes('--allow-missing');
  if (only && ![SOURCE, ...TARGETS].includes(only)) throw new Error('Unknown locale');
  // --enabled checks the languages a production web build would include.
  const enabled = args.includes('--enabled') ? enabledLocales() : null;
  if (enabled?.some((locale) => locale !== SOURCE && !TARGETS.includes(locale)))
    throw new Error('Unknown locale requested for completeness check');
  const targets = enabled
    ? enabled.filter((locale) => locale !== SOURCE)
    : TARGETS.filter((locale) => !only || locale === only);
  const source = readPo(join(DIR, SOURCE, 'messages.po'));
  let failures = 0;
  for (const locale of [SOURCE, ...targets]) {
    const target = locale === SOURCE ? source : readPo(join(DIR, locale, 'messages.po'));
    const { problems, translated } = checkCatalog(source, target, {
      allowMissing: locale === SOURCE || allowMissing,
    });
    failures += problems.length;
    const status = locale === SOURCE ? 'validated' : 'translated';
    console.log(
      `${locale}: ${translated}/${source.size} ${status}${problems.length ? `, ${problems.length} problems` : ''}`,
    );
    for (const problem of problems.slice(0, 50)) console.log(`  ${problem}`);
  }
  process.exitCode = failures ? 1 : 0;
}

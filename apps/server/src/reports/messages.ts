/**
 * A small reader for the ICU messages the report email is written in: `{name}` for a value, and
 * `{count, plural, =0 {…} one {# …} other {# …}}` for a count, with `#` standing for the number
 * written the reader's way.  It's the subset the email's copy uses, so the same messages sit in the
 * app's catalogs beside every other string and translate the same way.
 */

/** A value to put in a message: text, a number, or a piece of markup with its plain-text twin. */
export type MessageValue = string | number | { html: string; text: string };

export interface Formatting {
  locale: string;
  /** Whether the result is HTML, in which case the message's own text and every value are escaped */
  html: boolean;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!;
  });
}

/** The index of the brace that closes the one at `open`. */
function closing(message: string, open: number): number {
  let depth = 0;
  for (let index = open; index < message.length; index += 1) {
    if (message[index] === '{') depth += 1;
    else if (message[index] === '}' && --depth === 0) return index;
  }
  return -1;
}

function numberText(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

function valueText(value: MessageValue | undefined, formatting: Formatting): string {
  if (value === undefined) return '';
  if (typeof value === 'number') return numberText(value, formatting.locale);
  if (typeof value === 'string') return formatting.html ? escapeHtml(value) : value;
  return formatting.html ? value.html : value.text;
}

/** The plural case for a count: an exact `=n` first, then the language's own category, then `other`. */
function pluralCase(body: string, count: number, locale: string): string {
  const cases = new Map<string, string>();
  let index = 0;
  while (index < body.length) {
    const open = body.indexOf('{', index);
    if (open < 0) break;
    const selector = body.slice(index, open).trim();
    const end = closing(body, open);
    if (end < 0) break;
    cases.set(selector, body.slice(open + 1, end));
    index = end + 1;
  }
  const category = new Intl.PluralRules(locale).select(count);
  return cases.get(`=${count}`) ?? cases.get(category) ?? cases.get('other') ?? '';
}

/** Fills a message with values, escaping for HTML when asked. */
export function formatMessage(
  message: string,
  values: Readonly<Record<string, MessageValue>>,
  formatting: Formatting,
  count?: number,
): string {
  let out = '';
  let index = 0;
  while (index < message.length) {
    const character = message[index]!;
    if (character === '#' && count !== undefined) {
      out += numberText(count, formatting.locale);
      index += 1;
      continue;
    }
    if (character !== '{') {
      out += formatting.html ? escapeHtml(character) : character;
      index += 1;
      continue;
    }
    const end = closing(message, index);
    if (end < 0) {
      out += message.slice(index);
      break;
    }
    const inner = message.slice(index + 1, end);
    const comma = inner.indexOf(',');
    if (comma < 0) out += valueText(values[inner.trim()], formatting);
    else {
      const name = inner.slice(0, comma).trim();
      const rest = inner.slice(comma + 1);
      const second = rest.indexOf(',');
      const kind = rest.slice(0, second).trim();
      const value = values[name];
      if (kind === 'plural' && typeof value === 'number')
        out += formatMessage(
          pluralCase(rest.slice(second + 1), value, formatting.locale),
          values,
          formatting,
          value,
        );
      else out += valueText(value, formatting);
    }
    index = end + 1;
  }
  return out;
}

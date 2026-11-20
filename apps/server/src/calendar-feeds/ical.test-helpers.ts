/**
 * A strict iCalendar reader for tests, written by hand from RFC 5545 rather than borrowed, so it
 * checks the rules the feed promises instead of forgiving what a lenient parser would.  It throws
 * on the first thing out of place: a line end other than CRLF, a line longer than 75 octets, a
 * character split across a fold, a malformed content line, a control character, a TEXT value with
 * an unescaped comma or semicolon or an unknown escape, a component left open, a required
 * property missing or repeated, a date in the wrong form, or an end that isn't after its start.
 */

export type ParsedTime = { date: string } | { instant: Date };

export interface ParsedEvent {
  uid: string;
  summary: string | null;
  description: string | null;
  url: string | null;
  start: ParsedTime;
  end: ParsedTime | null;
  stamp: Date;
  lastModified: Date | null;
}

export interface ParsedCalendar {
  /** The calendar's own properties, TEXT values unescaped */
  properties: Map<string, string>;
  events: ParsedEvent[];
  /** Every physical line, as sent */
  lines: string[];
}

interface Property {
  name: string;
  params: Map<string, string>;
  value: string;
}

interface Component {
  name: string;
  properties: Property[];
  children: Component[];
}

const MAX_OCTETS = 75;
const CONTENT_LINE =
  /^([A-Za-z0-9-]+)((?:;[A-Za-z0-9-]+=(?:"[^"]*"|[^";:,]*)(?:,(?:"[^"]*"|[^";:,]*))*)*):(.*)$/;
const PARAM = /;([A-Za-z0-9-]+)=("[^"]*"|[^";:]*)/g;

/** Whether text holds a control character other than a tab, which no content line may. */
function hasControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}
const TEXT_PROPERTIES = new Set(['UID', 'SUMMARY', 'DESCRIPTION', 'NAME', 'X-WR-CALNAME', 'X-WR-TIMEZONE']);

function fail(message: string): never {
  throw new Error(`Invalid iCalendar: ${message}`);
}

/** A TEXT value, unescaped.  Commas and semicolons have to be escaped in a single TEXT value. */
export function unescapeText(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === ',' || char === ';') fail(`unescaped "${char}" in text ${JSON.stringify(value)}`);
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = value[index + 1];
    index += 1;
    if (next === '\\' || next === ';' || next === ',') out += next;
    else if (next === 'n' || next === 'N') out += '\n';
    else fail(`unknown escape "\\${next ?? ''}" in text ${JSON.stringify(value)}`);
  }
  return out;
}

/**
 * The lines as sent.  Given the raw bytes, each line has to be valid UTF-8 on its own, which is
 * what shows a fold never split a character.  Given a string, a split shows as a lone surrogate.
 */
function physicalLines(input: string | Buffer): string[] {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (
    typeof input === 'string' &&
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(input)
  )
    fail('a character is split');
  if (bytes.length < 2 || bytes[bytes.length - 2] !== 0x0d || bytes[bytes.length - 1] !== 0x0a)
    fail('the document has to end with CRLF');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lines: string[] = [];
  let from = 0;
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] !== 0x0d || bytes[index + 1] !== 0x0a) continue;
    const raw = bytes.subarray(from, index);
    if (raw.includes(0x0d) || raw.includes(0x0a)) fail(`line ${lines.length + 1} holds a bare CR or LF`);
    if (raw.length > MAX_OCTETS) fail(`line ${lines.length + 1} is longer than 75 octets`);
    try {
      lines.push(decoder.decode(raw));
    } catch {
      fail(`line ${lines.length + 1} splits a character`);
    }
    from = index + 2;
    index += 1;
  }
  if (from !== bytes.length) fail('the document has to end with CRLF');
  return lines;
}

function unfold(lines: string[]): string[] {
  const logical: string[] = [];
  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (!logical.length) fail('the first line is a continuation');
      logical[logical.length - 1] += line.slice(1);
    } else logical.push(line);
  }
  return logical;
}

function contentLine(line: string): Property {
  if (hasControl(line)) fail(`a control character in ${JSON.stringify(line)}`);
  const match = CONTENT_LINE.exec(line);
  if (!match) fail(`malformed content line ${JSON.stringify(line)}`);
  const value = match[3]!;
  const params = new Map<string, string>();
  for (const param of match[2]!.matchAll(PARAM)) params.set(param[1]!.toUpperCase(), param[2]!);
  return { name: match[1]!.toUpperCase(), params, value };
}

function components(properties: Property[]): Component {
  const root: Component = { name: '', properties: [], children: [] };
  const stack = [root];
  for (const property of properties) {
    const current = stack[stack.length - 1]!;
    if (property.name === 'BEGIN') {
      const child: Component = { name: property.value.toUpperCase(), properties: [], children: [] };
      current.children.push(child);
      stack.push(child);
    } else if (property.name === 'END') {
      if (stack.length === 1 || current.name !== property.value.toUpperCase())
        fail(`END:${property.value} doesn't close ${current.name || 'anything'}`);
      stack.pop();
    } else {
      if (stack.length === 1) fail(`${property.name} outside any component`);
      current.properties.push(property);
    }
  }
  if (stack.length !== 1) fail(`${stack[stack.length - 1]!.name} is never closed`);
  return root;
}

function only(component: Component, name: string, required: boolean): Property | null {
  const found = component.properties.filter((property) => property.name === name);
  if (found.length > 1) fail(`${component.name} has ${name} ${found.length} times`);
  if (required && !found.length) fail(`${component.name} has no ${name}`);
  return found[0] ?? null;
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function utcInstant(value: string, what: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) fail(`${what} isn't a UTC date and time: ${value}`);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 60)
    fail(`${what} isn't a real moment: ${value}`);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function time(property: Property): ParsedTime {
  const type = property.params.get('VALUE');
  if (property.params.has('TZID')) fail(`${property.name} names a zone, where times are only in UTC`);
  if (type === 'DATE') {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(property.value);
    if (!match || !validDate(Number(match[1]), Number(match[2]), Number(match[3])))
      fail(`${property.name} isn't a date: ${property.value}`);
    return { date: `${match[1]}-${match[2]}-${match[3]}` };
  }
  if (type !== undefined && type !== 'DATE-TIME') fail(`${property.name} has VALUE=${type}`);
  return { instant: utcInstant(property.value, property.name) };
}

function event(component: Component): ParsedEvent {
  const text = (name: string, required = false) => {
    const property = only(component, name, required);
    return property ? unescapeText(property.value) : null;
  };
  const start = time(only(component, 'DTSTART', true)!);
  const endProperty = only(component, 'DTEND', false);
  if (only(component, 'DURATION', false)) fail('the feed never sends DURATION');
  const end = endProperty ? time(endProperty) : null;
  if (end) {
    if ('date' in start !== 'date' in end) fail('DTSTART and DTEND are different kinds of value');
    const after = 'date' in start ? (end as { date: string }).date > start.date : true;
    const later =
      'instant' in start ? (end as { instant: Date }).instant.getTime() > start.instant.getTime() : after;
    if (!after || !later) fail('DTEND is not after DTSTART');
  }
  const lastModified = only(component, 'LAST-MODIFIED', false);
  return {
    uid: text('UID', true)!,
    summary: text('SUMMARY'),
    description: text('DESCRIPTION'),
    url: only(component, 'URL', false)?.value ?? null,
    start,
    end,
    stamp: utcInstant(only(component, 'DTSTAMP', true)!.value, 'DTSTAMP'),
    lastModified: lastModified ? utcInstant(lastModified.value, 'LAST-MODIFIED') : null,
  };
}

export function parseCalendar(input: string | Buffer): ParsedCalendar {
  const lines = physicalLines(input);
  const root = components(unfold(lines).map(contentLine));
  if (root.children.length !== 1 || root.children[0]!.name !== 'VCALENDAR')
    fail('the document has to be exactly one VCALENDAR');
  const calendar = root.children[0]!;
  if (only(calendar, 'VERSION', true)!.value !== '2.0') fail('VERSION has to be 2.0');
  only(calendar, 'PRODID', true);
  const properties = new Map<string, string>();
  for (const property of calendar.properties) {
    if (properties.has(property.name)) fail(`VCALENDAR has ${property.name} twice`);
    properties.set(
      property.name,
      TEXT_PROPERTIES.has(property.name) ? unescapeText(property.value) : property.value,
    );
  }
  const events: ParsedEvent[] = [];
  for (const child of calendar.children) {
    if (child.name !== 'VEVENT') fail(`unexpected ${child.name}`);
    if (child.children.length) fail('a VEVENT holds another component');
    events.push(event(child));
  }
  const uids = new Set(events.map((item) => item.uid));
  if (uids.size !== events.length) fail('two events share a UID');
  return { properties, events, lines };
}

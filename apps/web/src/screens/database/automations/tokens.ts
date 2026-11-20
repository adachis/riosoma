/**
 * Text in automation steps can hold values as `{{…}}` tokens: a field of the record that started
 * the automation or of a record an earlier step made, the current time, a link to the record, or
 * a path into a webhook's JSON.  Anything else between braces is left as plain text.
 */
export type TokenRef =
  | { kind: 'item'; path: string }
  | { kind: 'index' }
  | { kind: 'output'; stepId: string; path: string }
  | { kind: 'now' }
  | { kind: 'link' }
  | { kind: 'triggerField'; fieldId: string }
  | { kind: 'stepField'; stepId: string; fieldId: string }
  | { kind: 'body'; path: string };

export type Segment = { kind: 'text'; text: string } | { kind: 'token'; token: string };

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const TRIGGER_FIELD = /^trigger\.record\.(fld[0-9A-Za-z]{14})$/;
const STEP_FIELD = /^steps\.([0-9A-Za-z_-]{6,40})\.record\.(fld[0-9A-Za-z]{14})$/;
const BODY = /^trigger\.body\.(\S[^{}]*)$/;

/** The start of a webhook body token, which the person finishes by typing a path. */
export const BODY_PREFIX = 'trigger.body.';

export const token = {
  now: 'now',
  link: 'trigger.record.url',
  triggerField: (fieldId: string) => `trigger.record.${fieldId}`,
  stepField: (stepId: string, fieldId: string) => `steps.${stepId}.record.${fieldId}`,
};

export function readToken(text: string): TokenRef | null {
  if (text === 'index') return { kind: 'index' };
  if (text === 'item' || text.startsWith('item.')) return { kind: 'item', path: text.slice(5) };
  const output = /^steps\.([0-9A-Za-z_-]{6,40})\.output(?:\.(.+))?$/.exec(text);
  if (output) return { kind: 'output', stepId: output[1]!, path: output[2] ?? '' };
  if (text === token.now) return { kind: 'now' };
  if (text === token.link) return { kind: 'link' };
  const field = TRIGGER_FIELD.exec(text);
  if (field) return { kind: 'triggerField', fieldId: field[1]! };
  const step = STEP_FIELD.exec(text);
  if (step) return { kind: 'stepField', stepId: step[1]!, fieldId: step[2]! };
  const body = BODY.exec(text);
  if (body) return { kind: 'body', path: body[1]!.trim() };
  return null;
}

/** Splits a template into text and the tokens it recognizes. */
export function splitTemplate(template: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of template.matchAll(TOKEN)) {
    const inner = match[1]!.trim();
    if (!readToken(inner)) continue;
    if (match.index > last) segments.push({ kind: 'text', text: template.slice(last, match.index) });
    segments.push({ kind: 'token', token: inner });
    last = match.index + match[0].length;
  }
  if (last < template.length) segments.push({ kind: 'text', text: template.slice(last) });
  return segments;
}

export function tokenText(inner: string): string {
  return `{{${inner}}}`;
}

export function tokensIn(template: string): TokenRef[] {
  return splitTemplate(template).flatMap((segment) =>
    segment.kind === 'token' ? [readToken(segment.token)!] : [],
  );
}

/** A list of addresses, written with commas between them. */
export function splitList(text: string): string[] {
  const items = text
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : [''];
}

export function joinList(items: readonly string[]): string {
  return items.filter(Boolean).join(', ');
}

/** Headers, one `Name: value` per line. */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().slice(0, 100);
    if (name) headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

export function formatHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function sameHeaders(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  return JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));
}

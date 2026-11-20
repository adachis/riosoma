import { describe, expect, it } from 'vitest';
import { FieldMeta } from '@riosoma/contracts';
import type { StoredField } from '../data/types.js';
import { recipients, renderBody, renderSubject } from './email.js';
import {
  fillJson,
  fillText,
  parseToken,
  pieces,
  soleToken,
  type Resolver,
  type TokenValue,
} from './tokens.js';
import { stepValue } from './values.js';

const text = (value: string, extra: Partial<TokenValue> = {}): TokenValue => ({
  text: value,
  json: value,
  addresses: [],
  ...extra,
});

/** Resolves `{{name}}`-style test tokens from a table of values. */
function resolver(values: Record<string, TokenValue>): Resolver {
  return (_ref, raw) => {
    const value = values[raw.slice(2, -2).trim()];
    if (!value) throw new Error(`unexpected token ${raw}`);
    return value;
  };
}

function field(spec: Record<string, unknown>): StoredField {
  return {
    ...FieldMeta.parse({
      id: 'fld00000000000001',
      tableId: 'tbl00000000000001',
      name: 'Field',
      description: '',
      position: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...spec,
    }),
    columnName: 'fld00000000000001',
  };
}

describe('tokens', () => {
  it('parse the kinds of token steps can use', () => {
    expect(parseToken('now')).toEqual({ kind: 'now' });
    expect(parseToken('trigger.record.url')).toEqual({ kind: 'url' });
    expect(parseToken('trigger.record.fld0123456789abcd')).toEqual({
      kind: 'field',
      stepId: null,
      fieldId: 'fld0123456789abcd',
    });
    expect(parseToken('steps.make-it.record.fld0123456789abcd')).toEqual({
      kind: 'field',
      stepId: 'make-it',
      fieldId: 'fld0123456789abcd',
    });
    expect(parseToken('trigger.body.items.0.name')).toEqual({ kind: 'body', path: ['items', '0', 'name'] });
    expect(parseToken('trigger.body')).toEqual({ kind: 'body', path: [] });
    for (const unknown of [
      'trigger.record.name',
      'trigger.body..x',
      'steps.x.record.fld0123456789abcd',
      'later',
    ])
      expect(parseToken(unknown), unknown).toBeNull();
    expect(pieces('Hi {{ now }}!')).toEqual([
      { text: 'Hi ' },
      { raw: '{{ now }}', ref: { kind: 'now' } },
      { text: '!' },
    ]);
    expect(soleToken('  {{now}} ')).toEqual({ raw: '{{now}}', ref: { kind: 'now' } });
    expect(soleToken('at {{now}}')).toBeNull();
  });

  it('escape values inside JSON strings and write JSON values outside them', () => {
    const resolve = resolver({
      name: text('Say "hi" \\ bye\n'),
      count: { text: '1,234', json: 1234, addresses: [] },
      nothing: { text: '', json: null, addresses: [] },
    });
    const filled = fillJson(
      '{"name": "{{name}}", "count": {{count}}, "none": {{nothing}}, "braces": "}}"}',
      resolve,
    );
    expect(JSON.parse(filled)).toEqual({ name: 'Say "hi" \\ bye\n', count: 1234, none: null, braces: '}}' });
    expect(JSON.parse(fillJson('["a \\" {{name}}"]', resolve))).toEqual(['a " Say "hi" \\ bye\n']);
    expect(fillText('{{count}} items', resolve)).toBe('1,234 items');
  });
});

describe('email', () => {
  it('renders a small Markdown subset, with values escaped and never read as Markdown', () => {
    const resolve = resolver({
      name: text('<script>x</script> **not bold** [link](javascript:alert(1))'),
      url: text('https://example.test/rec?a=1&b=2'),
      bad: text('javascript:alert(1)'),
    });
    const { text: plain, html } = renderBody(
      '## Hi {{name}}\n\nLine one\nline _two_ with `code **here**`\n\n1. first\n2. second\n\n[Open]({{url}}) [Nope]({{bad}})',
      resolve,
    );
    expect(plain).toContain('## Hi <script>x</script> **not bold**');
    expect(html).toContain(
      '<h2>Hi &lt;script&gt;x&lt;/script&gt; **not bold** [link](javascript:alert(1))</h2>',
    );
    expect(html).toContain('<p>Line one<br>line <em>two</em> with <code>code **here**</code></p>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<a href="https://example.test/rec?a=1&amp;b=2">Open</a>');
    expect(html).toContain(' Nope</p>');
    expect(html).not.toContain('javascript:alert(1)">');
    expect(html).not.toContain('<script>');
  });

  it('keeps subjects to one line and reads recipients from addresses and fields', () => {
    const resolve = resolver({
      name: text('Line\r\nbreak'),
      people: text('Ada, Grace', { addresses: ['ada@example.test', 'grace@example.test'] }),
      email: text('ops@example.test'),
      empty: text(''),
      host: text('example.test'),
    });
    expect(renderSubject('Re: {{name}}', resolve)).toBe('Re: Line break');
    expect(
      recipients(['{{people}}', '{{email}}; OPS@example.test', '{{empty}}', 'team@{{host}}'], resolve),
    ).toEqual(['ada@example.test', 'grace@example.test', 'ops@example.test', 'team@example.test']);
    expect(recipients(['Ada Lovelace'], resolve)).toBeNull();
  });
});

describe('values for fields', () => {
  it('read typed text the way a person would type it', () => {
    const number = field({ type: 'number' });
    expect(stepValue(number, ' $1,234.50 ', null, [])).toBe(1234.5);
    expect(stepValue(number, '', null, [])).toBeNull();
    expect(stepValue(number, 'many', null, [])).toBe('many');
    expect(stepValue(field({ type: 'percent' }), '25%', null, [])).toBe(0.25);
    expect(stepValue(field({ type: 'duration' }), '1:30', null, [])).toBe(5400);
    expect(stepValue(field({ type: 'checkbox' }), 'Yes', null, [])).toBe(true);
    expect(stepValue(field({ type: 'checkbox' }), '', null, [])).toBe(false);
    expect(stepValue(field({ type: 'date' }), '2026-09-27', null, [])).toBe('2026-09-27');
    expect(stepValue(field({ type: 'date' }), '2026-09-27T23:30:00-04:00', null, [])).toBe('2026-09-28');
    expect(stepValue(field({ type: 'date', options: { includeTime: true } }), '2026-09-27', null, [])).toBe(
      '2026-09-27T00:00:00.000Z',
    );
    expect(stepValue(field({ type: 'date' }), 'Sep 27, 2026', null, [])).toBe('2026-09-27');
    const select = field({
      type: 'multipleSelect',
      options: {
        choices: [
          { id: 'cho00000000000001', name: 'Red', color: 'red' },
          { id: 'cho00000000000002', name: 'Blue', color: 'blue' },
        ],
      },
    });
    expect(stepValue(select, 'blue, Red', null, [])).toEqual(['cho00000000000002', 'cho00000000000001']);
    const people = [{ id: 'usr00000000000001', name: 'Ada', email: 'ada@example.test' }];
    expect(stepValue(field({ type: 'user' }), 'ADA@example.test', null, people)).toEqual([
      'usr00000000000001',
    ]);
    expect(
      stepValue(
        field({ type: 'link', options: { linkedTableId: 'tbl00000000000002' } }),
        'rec00000000000001, x',
        null,
        [],
      ),
    ).toEqual(['rec00000000000001']);
  });

  it('copy a stored value when one token fills the field and the kinds match', () => {
    const source = field({
      type: 'singleSelect',
      options: { choices: [{ id: 'cho00000000000009', name: 'Done', color: 'green' }] },
    });
    const target = field({
      type: 'singleSelect',
      options: { choices: [{ id: 'cho00000000000001', name: 'done', color: 'gray' }] },
    });
    const sole = {
      text: 'Done',
      json: 'Done',
      addresses: [],
      cell: { field: source, value: 'cho00000000000009' },
    };
    expect(stepValue(target, 'Done', sole, [])).toBe('cho00000000000001');
    const when = field({ type: 'date', options: { includeTime: true, timeZone: 'Asia/Tokyo' } });
    const instant = {
      text: 'x',
      json: 'x',
      addresses: [],
      cell: { field: when, value: '2026-09-27T20:00:00.000Z' },
    };
    // 20:00 UTC is already the next day in Tokyo.
    expect(stepValue(field({ type: 'date' }), 'x', instant, [])).toBe('2026-09-28');
    const count = {
      text: '1,234',
      json: 1234,
      addresses: [],
      cell: { field: field({ type: 'number' }), value: 1234 },
    };
    expect(stepValue(field({ type: 'currency' }), '1,234', count, [])).toBe(1234);
  });
});

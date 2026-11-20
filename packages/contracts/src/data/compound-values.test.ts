import { describe, expect, it } from 'vitest';
import {
  canConvert,
  checkCellValue,
  checkCondition,
  describeTemplate,
  distanceKm,
  FieldMeta,
  fillTemplate,
  isSignaturePath,
  LIMITS,
  locationText,
  minifyJson,
  operatorsFor,
  parseCoordinates,
  parseLocationText,
  prettyJson,
  resolveTemplate,
  sameValue,
  splitDateRangeText,
  templateScheme,
  templateText,
  type FieldType,
} from '../index.js';

function field(type: FieldType, options: object = {}): FieldMeta {
  return FieldMeta.parse({
    id: 'fld00000000000001',
    tableId: 'tbl00000000000001',
    name: 'Field',
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    type,
    options,
  });
}

const check = (type: FieldType, input: unknown, options: object = {}) =>
  checkCellValue(field(type, options), input);
const fails = (messageKey: string) => ({ ok: false, messageKey });

describe('date range values', () => {
  it('keeps days, turns instants into UTC, and drops anything else it was given', () => {
    expect(check('dateRange', { start: '2026-09-27', end: '2026-09-30', note: 'x' })).toEqual({
      ok: true,
      value: { start: '2026-09-27', end: '2026-09-30' },
    });
    expect(
      check(
        'dateRange',
        { start: '2026-09-27T09:00+02:00', end: '2026-09-27T08:00:00Z' },
        { includeTime: true },
      ),
    ).toEqual({ ok: true, value: { start: '2026-09-27T07:00:00.000Z', end: '2026-09-27T08:00:00.000Z' } });
    expect(check('dateRange', { start: '2026-09-27', end: '2026-09-27' })).toMatchObject({ ok: true });
    for (const empty of [null, undefined, ''])
      expect(check('dateRange', empty)).toEqual({ ok: true, value: null });
  });

  it('refuses a missing end, an end before the start, and the wrong kind of date', () => {
    for (const input of [
      { start: '2026-09-27' },
      { start: '2026-09-30', end: '2026-09-27' },
      { start: '2026-02-30', end: '2026-03-01' },
      { start: '2026-09-27T09:00:00Z', end: '2026-09-28T09:00:00Z' },
      '2026-09-27/2026-09-30',
      ['2026-09-27', '2026-09-30'],
    ])
      expect(check('dateRange', input), JSON.stringify(input)).toEqual(fails('data.value.dateRange'));
    expect(
      check(
        'dateRange',
        { start: '2026-09-28T00:00:00Z', end: '2026-09-27T23:59:59Z' },
        { includeTime: true },
      ),
    ).toEqual(fails('data.value.dateRange'));
  });

  it('splits the ways people write a range', () => {
    expect(splitDateRangeText('2026-09-27/2026-09-30')).toEqual(['2026-09-27', '2026-09-30']);
    expect(splitDateRangeText('Sep 27, 2026 – Sep 30, 2026')).toEqual(['Sep 27, 2026', 'Sep 30, 2026']);
    expect(splitDateRangeText('9/27/2026 - 9/30/2026')).toEqual(['9/27/2026', '9/30/2026']);
    expect(splitDateRangeText('Monday to Friday')).toEqual(['Monday', 'Friday']);
    // A numeric date's own slashes and an ISO date's own hyphens don't split it.
    expect(splitDateRangeText('9/27/2026')).toEqual(['9/27/2026', '9/27/2026']);
    expect(splitDateRangeText('2026-09-27')).toEqual(['2026-09-27', '2026-09-27']);
  });
});

describe('JSON values', () => {
  it('keeps the text as written, without its spacing', () => {
    expect(check('json', '{ "b" : 1.50,\n "a": [ true , "x y" ], "b": 2 }')).toEqual({
      ok: true,
      value: '{"b":1.50,"a":[true,"x y"],"b":2}',
    });
    expect(check('json', '12345678901234567890')).toEqual({ ok: true, value: '12345678901234567890' });
    expect(check('json', '"text"')).toEqual({ ok: true, value: '"text"' });
    for (const empty of ['null', ' null ', '', '  ', null])
      expect(check('json', empty)).toEqual({ ok: true, value: null });
  });

  it('refuses text that isn’t JSON, values that aren’t text, and JSON that’s too long', () => {
    for (const input of ['{', "{'a':1}", 'undefined', '[1,]', 'NaN'])
      expect(check('json', input), input).toEqual(fails('data.value.notJson'));
    expect(check('json', { a: 1 })).toEqual(fails('data.value.notJson'));
    expect(check('json', `"${'x'.repeat(LIMITS.jsonLength)}"`)).toEqual(fails('data.value.tooLong'));
  });

  it('lays JSON out with two spaces a level and keeps empty lists and objects on one line', () => {
    expect(prettyJson('{"a":[1,{"b":[]}],"c":{}}')).toBe(
      '{\n  "a": [\n    1,\n    {\n      "b": []\n    }\n  ],\n  "c": {}\n}',
    );
    expect(prettyJson('{"a":1}')).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(prettyJson('{"x":"a,b:{c}"}')).toBe('{\n  "x": "a,b:{c}"\n}');
    expect(minifyJson('not json')).toBeNull();
  });
});

describe('location values', () => {
  it('rounds to six places, keeps a one-line label, and treats no label as none', () => {
    expect(check('location', { lat: 40.71278123, lng: -74.00600049, label: ' New York\nCity ' })).toEqual({
      ok: true,
      value: { lat: 40.712781, lng: -74.006, label: 'New York City' },
    });
    expect(check('location', { lat: -0.0000001, lng: 180, label: '' })).toEqual({
      ok: true,
      value: { lat: 0, lng: 180, label: null },
    });
  });

  it('refuses coordinates out of range or of the wrong kind', () => {
    for (const input of [
      { lat: 90.1, lng: 0 },
      { lat: 0, lng: -180.1 },
      { lat: '1', lng: 2 },
      { lat: Number.NaN, lng: 2 },
      { lat: 1 },
      { lat: 1, lng: 2, label: 3 },
      '1, 2',
    ])
      expect(check('location', input), JSON.stringify(input)).toEqual(fails('data.value.location'));
    expect(check('location', { lat: 1, lng: 2, label: 'x'.repeat(LIMITS.locationLabelLength + 1) })).toEqual(
      fails('data.value.tooLong'),
    );
  });

  it('reads coordinates the ways maps copy them, and labels in parentheses', () => {
    expect(parseCoordinates('40.7128, -74.0060')).toEqual({ lat: 40.7128, lng: -74.006 });
    expect(parseCoordinates('(40.7128,-74.0060)')).toEqual({ lat: 40.7128, lng: -74.006 });
    expect(parseCoordinates('48,8566; 2,3522')).toEqual({ lat: 48.8566, lng: 2.3522 });
    expect(parseCoordinates('48,8566 2,3522')).toEqual({ lat: 48.8566, lng: 2.3522 });
    for (const text of ['40,7128,-74,006', '91, 0', '1, 2, 3', 'north', `1,${' '.repeat(200)}2`])
      expect(parseCoordinates(text), text).toBeNull();
    const paris = { lat: 48.8566, lng: 2.3522, label: 'Paris' };
    expect(locationText(paris)).toBe('Paris (48.8566, 2.3522)');
    expect(parseLocationText(locationText(paris))).toEqual(paris);
    expect(parseLocationText('Café (Rue 1) (48.8566, 2.3522)')).toEqual({ ...paris, label: 'Café (Rue 1)' });
    expect(parseLocationText('Paris')).toBeNull();
  });

  it('measures great-circle distance in kilometers', () => {
    const lyon = { lat: 45.764, lng: 4.8357 };
    expect(distanceKm(paris(), lyon)).toBeGreaterThan(385);
    expect(distanceKm(paris(), lyon)).toBeLessThan(395);
    expect(distanceKm(paris(), paris())).toBe(0);
  });
});

function paris() {
  return { lat: 48.8566, lng: 2.3522 };
}

describe('signature values', () => {
  const drawing = { path: 'M10 20l3 -2 4 1 M50 60l0 0', width: 400, height: 150 };

  it('takes a drawing, a typed name, or both, and fills in when when it wasn’t given', () => {
    const drawn = check('signature', { drawing, name: '  Ada   Lovelace ' });
    expect(drawn).toMatchObject({ ok: true, value: { drawing, name: 'Ada Lovelace', signedBy: null } });
    expect(drawn.ok && typeof drawn.value === 'object' && drawn.value && 'signedAt' in drawn.value).toBe(
      true,
    );
    expect(
      check('signature', {
        drawing: null,
        name: 'Ada',
        signedBy: 'usr00000000000001',
        signedAt: '2026-09-27T15:05:00+01:00',
      }),
    ).toEqual({
      ok: true,
      value: {
        drawing: null,
        name: 'Ada',
        signedBy: 'usr00000000000001',
        signedAt: '2026-09-27T14:05:00.000Z',
      },
    });
  });

  it('refuses nothing to sign, unsafe or malformed paths, bad sizes, and strangers', () => {
    for (const input of [
      {},
      { drawing: null, name: '   ' },
      { drawing: { ...drawing, path: '' } },
      { drawing: { ...drawing, path: 'M0 0" onload="alert(1)' } },
      { drawing: { ...drawing, path: '<script>' } },
      { drawing: { ...drawing, path: 'M0 0 C 1 2 3 4 5 6' } },
      { drawing: { ...drawing, width: 0 } },
      { drawing: { ...drawing, height: 1.5 } },
      { drawing: { ...drawing, width: LIMITS.signatureSize + 1 } },
      { name: 'Ada', signedBy: 'someone' },
      { name: 'Ada', signedAt: 'yesterday' },
      'Ada',
    ])
      expect(check('signature', input), JSON.stringify(input)).toEqual(fails('data.value.signature'));
    expect(check('signature', { drawing: { ...drawing, path: `M0 0l${' 1 1'.repeat(10_000)}` } })).toEqual(
      fails('data.value.tooLong'),
    );
  });

  it('reads path data as moves and lines in pairs, first a move', () => {
    for (const path of ['M0 0', 'M1 2l3 4', 'm1,2 l-3.5 4 5 6', 'M10 20l3 -2 4 1 M50 60l0 0', 'M1 2L3 4'])
      expect(isSignaturePath(path), path).toBe(true);
    for (const path of ['L1 2', 'M1', 'M1 2l3', 'M1 2 3', 'M1 2z', 'M1 2l3 4;', 'Mx y', '', 'M1 2 l'])
      expect(isSignaturePath(path), path).toBe(false);
  });
});

describe('buttons and values in general', () => {
  it('holds no value, and compares object values by what they hold', () => {
    expect(check('button', 'https://example.com')).toEqual(fails('data.value.button'));
    expect(check('button', null)).toEqual(fails('data.value.button'));
    expect(sameValue({ start: 'a', end: 'b' }, { end: 'b', start: 'a' })).toBe(true);
    expect(sameValue({ lat: 1, lng: 2, label: null }, { lat: 1, lng: 2, label: 'x' })).toBe(false);
    expect(sameValue([{ lat: 1, lng: 2, label: null }], [{ lng: 2, lat: 1, label: null }])).toBe(true);
  });
});

describe('button link templates', () => {
  const fields = [
    { id: 'fld00000000000001', name: 'Order ID' },
    { id: 'fld00000000000002', name: 'Website' },
    { id: 'fld00000000000003', name: 'Twin' },
    { id: 'fld00000000000004', name: 'twin' },
  ];

  it('stores names as IDs, keeps IDs, and shows names again', () => {
    const stored = resolveTemplate(
      'https://example.com/orders/{ order id }?site={fld00000000000002}',
      fields,
    );
    expect(stored).toEqual({
      template: 'https://example.com/orders/{fld00000000000001}?site={fld00000000000002}',
    });
    expect(describeTemplate('template' in stored ? stored.template : '', fields)).toBe(
      'https://example.com/orders/{Order ID}?site={Website}',
    );
    expect(resolveTemplate('https://x.test/{Nope}', fields)).toEqual({ unknown: 'Nope' });
    expect(resolveTemplate('https://x.test/{Twin}', fields)).toEqual({ unknown: 'Twin' });
    expect(describeTemplate('https://x.test/{fld00000000000099}', fields)).toBe(
      'https://x.test/{fld00000000000099}',
    );
  });

  it('fills in encoded values, uses a leading field as it is, and says why a link can’t be made', () => {
    const values: Record<string, string> = {
      fld00000000000001: 'A/B 7&x',
      fld00000000000002: 'example.com/shop',
    };
    const text = (id: string) => values[id];
    expect(fillTemplate('https://example.com/orders/{fld00000000000001}', text)).toEqual({
      ok: true,
      url: 'https://example.com/orders/A%2FB%207%26x',
    });
    expect(fillTemplate('{fld00000000000002}/{fld00000000000001}', text)).toEqual({
      ok: true,
      url: 'https://example.com/shop/A%2FB%207%26x',
    });
    expect(fillTemplate('https://example.com/{fld00000000000009}', text)).toEqual({
      ok: false,
      reason: 'missingField',
      fieldId: 'fld00000000000009',
    });
    expect(fillTemplate('  ', text)).toEqual({ ok: false, reason: 'empty' });
    // Values that turn a link into another scheme, or into no link at all, are refused.
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com',
      '//evil.test',
      ' ',
      'a b',
    ])
      expect(
        fillTemplate('{fld00000000000002}', () => value),
        value,
      ).toEqual({ ok: false, reason: 'invalid' });
    expect(fillTemplate('mailto:{fld00000000000001}', text)).toEqual({ ok: false, reason: 'invalid' });
    expect(fillTemplate('https://example.com/{fld00000000000001}', () => '')).toEqual({
      ok: true,
      url: 'https://example.com/',
    });
  });

  it('refuses templates that could never be web links', () => {
    for (const template of ['', 'https://example.com/{x}', 'HTTP://example.com', '{Website}/path'])
      expect(templateScheme(template), template).toBe(true);
    for (const template of [
      'javascript:alert(1)',
      'ftp://example.com',
      'example.com/{x}',
      'https://',
      'data:x',
    ])
      expect(templateScheme(template), template).toBe(false);
  });

  it('words each kind of value the way a link carries it', () => {
    const select = field('singleSelect', {
      choices: [{ id: 'cho00000000000001', name: 'Blue', color: 'blue' }],
    });
    expect(templateText(select, 'cho00000000000001')).toBe('Blue');
    expect(templateText(field('number'), 1234.5)).toBe('1234.5');
    expect(templateText(field('checkbox'), false)).toBe('false');
    expect(templateText(field('dateRange'), { start: '2026-09-27', end: '2026-09-30' })).toBe(
      '2026-09-27/2026-09-30',
    );
    expect(templateText(field('location'), { lat: 1, lng: 2, label: 'x' })).toBe('1, 2');
    expect(templateText(field('user'), ['usr00000000000001'], { person: () => 'Ada' })).toBe('Ada');
    expect(templateText(field('text'), null)).toBe('');
  });
});

describe('filters and conversions', () => {
  it('offers each type its conditions and checks their values', () => {
    expect(operatorsFor('dateRange')).toEqual(
      expect.arrayContaining(['containsDate', 'overlaps', 'isWithin', 'is', 'isBefore', 'isEmpty']),
    );
    expect(operatorsFor('json')).toEqual(['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty']);
    expect(operatorsFor('location')).toEqual(['isWithin', 'isEmpty', 'isNotEmpty']);
    expect(operatorsFor('signature')).toEqual(['isEmpty', 'isNotEmpty']);
    expect(operatorsFor('button')).toEqual([]);
    const condition = (type: FieldType, operator: string, value?: unknown) =>
      checkCondition(field(type), { id: 'c', fieldId: 'fld00000000000001', operator, value } as never);
    expect(condition('dateRange', 'overlaps', { mode: 'nextWeek' })).toEqual({ valid: true, usable: true });
    expect(condition('dateRange', 'overlaps', { mode: 'today' })).toEqual({ valid: false, usable: false });
    expect(condition('dateRange', 'containsDate', { mode: 'exactDate', date: '2026-09-27' })).toEqual({
      valid: true,
      usable: true,
    });
    expect(condition('location', 'isWithin', { lat: 1, lng: 2, km: 5 })).toEqual({
      valid: true,
      usable: true,
    });
    expect(condition('location', 'isWithin', { lat: 1, lng: 2, km: 0 })).toEqual({
      valid: false,
      usable: false,
    });
    expect(condition('location', 'isWithin', { mode: 'nextWeek' })).toEqual({ valid: false, usable: false });
    expect(condition('json', 'contains', 'x')).toEqual({ valid: true, usable: true });
    expect(condition('button', 'isEmpty')).toEqual({ valid: false, usable: false });
  });

  it('converts where values have a reading in the other type, and refuses the rest', () => {
    const allowed: Array<[FieldType, FieldType]> = [
      ['text', 'dateRange'],
      ['date', 'dateRange'],
      ['dateRange', 'date'],
      ['dateRange', 'longText'],
      ['text', 'json'],
      ['number', 'json'],
      ['json', 'text'],
      ['text', 'location'],
      ['location', 'text'],
      ['signature', 'text'],
      ['rating', 'button'],
      ['button', 'number'],
      ['text', 'number'],
    ];
    const refused: Array<[FieldType, FieldType]> = [
      ['text', 'signature'],
      ['dateRange', 'signature'],
      ['signature', 'json'],
      ['json', 'number'],
      ['location', 'dateRange'],
      ['dateRange', 'number'],
      ['singleSelect', 'location'],
      ['user', 'json'],
      ['attachment', 'dateRange'],
    ];
    for (const [from, to] of allowed) expect(canConvert(from, to), `${from} → ${to}`).toBe(true);
    for (const [from, to] of refused) expect(canConvert(from, to), `${from} → ${to}`).toBe(false);
  });
});

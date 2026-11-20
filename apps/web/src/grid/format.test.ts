import { i18n } from '@lingui/core';
import { FieldMeta } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { editText, formatCell, type FormatContext } from './format';

const field = (spec: unknown, id = 'fld00000000000001'): FieldMeta =>
  FieldMeta.parse({
    id,
    tableId: 'tbl00000000000001',
    name: 'F',
    description: '',
    position: 1,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    ...(spec as object),
  });

const numberField = (options: unknown = {}) => field({ type: 'number', options });
const dateField = (options: unknown = {}) => field({ type: 'date', options });

const CHOICES = [
  { id: 'cho00000000000001', name: 'Todo', color: 'gray' },
  { id: 'cho00000000000002', name: 'Done', color: 'green' },
];

const COLLABORATORS = new Map([['usr00000000000001', { name: 'Ada Lovelace' }]]);

/** The narrow no-break space French grouping uses. */
const NARROW = '\u202f';

const ctx = (locale: string, timeZone = 'America/New_York'): FormatContext => ({
  locale,
  timeZone,
  collaborators: COLLABORATORS,
});

describe('formatCell text-like fields', () => {
  it('shows the stored text as it is', () => {
    for (const type of ['text', 'longText', 'email', 'url', 'phone'] as const) {
      expect(formatCell(field({ type }), 'a b', ctx('en-US'))).toBe('a b');
      expect(formatCell(field({ type }), null, ctx('en-US'))).toBe('');
    }
    expect(formatCell(field({ type: 'recordId' }), 'rec0000000000001', ctx('en-US'))).toBe(
      'rec0000000000001',
    );
    expect(formatCell(field({ type: 'text' }), 'line\nbreak', ctx('de'))).toBe('line\nbreak');
  });
});

describe('formatCell numbers', () => {
  it('groups and keeps the decimals the field asks for', () => {
    const open = numberField();
    expect(formatCell(open, 1234567, ctx('en-US'))).toBe('1,234,567');
    expect(formatCell(open, 1234.5, ctx('en-US'))).toBe('1,234.5');
    expect(formatCell(open, 1234.56789, ctx('en-US'))).toBe('1,234.56789');
    expect(formatCell(open, 0.12345678901234, ctx('en-US'))).toBe('0.123456789');
    expect(formatCell(numberField({ precision: 2 }), 1234.5, ctx('en-US'))).toBe('1,234.50');
    expect(formatCell(numberField({ precision: 0 }), 1234.4, ctx('en-US'))).toBe('1,234');
    expect(formatCell(numberField({ thousands: false }), 1234567.5, ctx('en-US'))).toBe('1234567.5');
  });

  it('uses the decimal mark and grouping of each locale', () => {
    expect(formatCell(numberField(), 1234.5, ctx('de'))).toBe('1.234,5');
    expect(formatCell(numberField({ precision: 2 }), 1234.5, ctx('de'))).toBe('1.234,50');
    expect(formatCell(numberField(), 1234.5, ctx('fr'))).toBe(`1${NARROW}234,5`);
    expect(formatCell(numberField(), 1234.5, ctx('ja'))).toBe('1,234.5');
    expect(formatCell(numberField(), 1234567, ctx('fr'))).toBe(`1${NARROW}234${NARROW}567`);
  });

  it('writes negatives with a minus from the locale, and shows nothing when empty', () => {
    expect(formatCell(numberField(), -1234.5, ctx('en-US'))).toBe('-1,234.5');
    expect(formatCell(numberField(), -1234.5, ctx('de'))).toBe('-1.234,5');
    expect(formatCell(numberField(), -0.5, ctx('fr'))).toBe('-0,5');
    expect(formatCell(numberField(), -1234.5, ctx('ja'))).toBe('-1,234.5');
    expect(formatCell(numberField(), null, ctx('en-US'))).toBe('');
    expect(formatCell(numberField(), 'nope' as unknown as number, ctx('en-US'))).toBe('');
  });
});

describe('editText', () => {
  it('leaves grouping out of a number and edits everything else as shown', () => {
    expect(editText(numberField(), 1234.5, ctx('en-US'))).toBe('1234.5');
    expect(editText(numberField(), 1234.5, ctx('de'))).toBe('1234,5');
    expect(editText(numberField({ precision: 2 }), 1234.5, ctx('de'))).toBe('1234,50');
    expect(editText(numberField(), -1234567.5, ctx('fr'))).toBe('-1234567,5');
    expect(editText(numberField(), null, ctx('en-US'))).toBe('');
    expect(editText(field({ type: 'text' }), 'a b', ctx('en-US'))).toBe('a b');
    expect(editText(dateField({ dateFormat: 'iso' }), '2026-09-27', ctx('en-US'))).toBe('2026-09-27');
    expect(
      editText(
        field({ type: 'singleSelect', options: { choices: CHOICES } }),
        'cho00000000000002',
        ctx('en-US'),
      ),
    ).toBe('Done');
    expect(editText(field({ type: 'checkbox' }), true, ctx('en-US'))).toBe('checked');
    expect(
      editText(
        field({ type: 'multipleSelect', options: { choices: CHOICES } }),
        ['cho00000000000001'],
        ctx('ja'),
      ),
    ).toBe('Todo');
  });
});

describe('formatCell checkbox', () => {
  it('copies a word for a checked box and nothing for the rest', () => {
    const checkbox = field({ type: 'checkbox' });
    expect(formatCell(checkbox, true, ctx('en-US'))).toBe('checked');
    expect(formatCell(checkbox, false, ctx('en-US'))).toBe('');
    expect(formatCell(checkbox, null, ctx('en-US'))).toBe('');
  });

  it('takes that word from the catalog of the active locale', () => {
    i18n.load('en-US', {});
    i18n.load('de', { 'grid.cell.checked': 'aktiviert' });
    i18n.activate('de');
    try {
      expect(formatCell(field({ type: 'checkbox' }), true, ctx('de'))).toBe('aktiviert');
    } finally {
      i18n.activate('en-US');
    }
    expect(formatCell(field({ type: 'checkbox' }), true, ctx('de'))).toBe('checked');
  });
});

describe('formatCell dates', () => {
  const day = '2026-09-27';
  const instant = '2026-09-27T15:05:00.000Z';

  it('follows every date layout', () => {
    const at = (dateFormat: string, locale: string) =>
      formatCell(dateField({ dateFormat }), day, ctx(locale));
    expect(at('local', 'en-US')).toBe('Sep 27, 2026');
    expect(at('friendly', 'en-US')).toBe('September 27, 2026');
    expect(at('us', 'en-US')).toBe('9/27/2026');
    expect(at('european', 'en-US')).toBe('27/9/2026');
    expect(at('iso', 'en-US')).toBe('2026-09-27');
    // A prescribed layout keeps its order in every language.
    expect(at('us', 'de')).toBe('9/27/2026');
    expect(at('european', 'ja')).toBe('27/9/2026');
    expect(at('iso', 'fr')).toBe('2026-09-27');
    expect(at('local', 'de')).toBe('27.09.2026');
    expect(at('friendly', 'de')).toBe('27. September 2026');
    expect(at('local', 'fr')).toBe('27 sept. 2026');
    expect(at('local', 'ja')).toBe('2026/09/27');
    expect(at('friendly', 'ja')).toBe('2026年9月27日');
  });

  it('adds the time the field asks for, in the clock the locale or the field picks', () => {
    const shown = (options: Record<string, unknown>, locale: string, timeZone = 'America/New_York') =>
      formatCell(dateField({ includeTime: true, ...options }), instant, ctx(locale, timeZone));
    // 15:05 UTC is 11:05 in New York in September.
    expect(shown({ timeFormat: 'local' }, 'en-US')).toBe('Sep 27, 2026, 11:05 AM');
    expect(shown({ timeFormat: '12h' }, 'en-US')).toBe('Sep 27, 2026, 11:05 AM');
    expect(shown({ timeFormat: '24h' }, 'en-US')).toBe('Sep 27, 2026, 11:05');
    expect(shown({ timeFormat: 'local' }, 'de')).toBe('27.09.2026, 11:05');
    expect(shown({ timeFormat: '12h' }, 'de')).toBe('27.09.2026, 11:05 AM');
    expect(shown({ timeFormat: 'local' }, 'ja')).toBe('2026/09/27 11:05');
    expect(shown({ dateFormat: 'us', timeFormat: '12h' }, 'en-US')).toBe('9/27/2026, 11:05 AM');
    expect(shown({ dateFormat: 'european', timeFormat: '24h' }, 'de')).toBe('27/9/2026, 11:05');
    expect(shown({ dateFormat: 'iso', timeFormat: '24h' }, 'en-US')).toBe('2026-09-27 11:05');
    // A long date reads with the locale's own word before the time.
    expect(shown({ dateFormat: 'friendly', timeFormat: 'local' }, 'en-US')).toBe(
      'September 27, 2026 at 11:05 AM',
    );
    expect(shown({ dateFormat: 'friendly', timeFormat: 'local' }, 'fr')).toBe('27 septembre 2026 à 11:05');
    expect(shown({ dateFormat: 'friendly', timeFormat: '24h' }, 'de')).toBe('27. September 2026 um 11:05');
  });

  it('shows times in the zone of the field and names one that differs from the viewer', () => {
    const options = { includeTime: true, timeFormat: '12h' as const, timeZone: 'America/Los_Angeles' };
    expect(formatCell(dateField(options), instant, ctx('en-US'))).toBe('Sep 27, 2026, 8:05 AM PDT');
    // German clocks name the zone by its offset rather than by `PDT`.
    expect(formatCell(dateField(options), instant, ctx('de'))).toBe('27.09.2026, 08:05 AM GMT-7');
    // The viewer's own zone needs no name, and `client` follows the viewer.
    const same = { ...options, timeZone: 'America/New_York' };
    expect(formatCell(dateField(same), instant, ctx('en-US'))).toBe('Sep 27, 2026, 11:05 AM');
    expect(
      formatCell(dateField({ includeTime: true, timeFormat: '12h' }), instant, ctx('en-US', 'Asia/Tokyo')),
    ).toBe('Sep 28, 2026, 12:05 AM');
  });

  it('keeps a date-only value on its own day, with no time and no zone', () => {
    const withTime = dateField({ includeTime: true, timeZone: 'Asia/Tokyo' });
    expect(formatCell(withTime, '2026-09-27', ctx('en-US'))).toBe('Sep 27, 2026');
    expect(formatCell(dateField(), '2026-09-27', ctx('en-US', 'Asia/Tokyo'))).toBe('Sep 27, 2026');
    expect(formatCell(dateField(), '2026-02-30', ctx('en-US'))).toBe('');
    expect(formatCell(dateField(), 'not a date', ctx('en-US'))).toBe('');
    // A stored value has to be a day or an instant; anything else shows nothing rather than a guess.
    expect(formatCell(dateField(), 'Sep 27', ctx('en-US'))).toBe('');
    expect(formatCell(dateField(), null, ctx('en-US'))).toBe('');
  });

  it('shows created and modified times with their time unless it is turned off', () => {
    const created = field({ type: 'createdTime' });
    expect(formatCell(created, instant, ctx('en-US'))).toBe('Sep 27, 2026, 11:05 AM');
    expect(formatCell(field({ type: 'lastModifiedTime' }), instant, ctx('en-US'))).toBe(
      'Sep 27, 2026, 11:05 AM',
    );
    const dateOnly = field({ type: 'createdTime', options: { includeTime: false } });
    expect(formatCell(dateOnly, instant, ctx('en-US'))).toBe('Sep 27, 2026');
    expect(formatCell(created, null, ctx('en-US'))).toBe('');
  });
});

describe('formatCell choices and people', () => {
  const single = field({ type: 'singleSelect', options: { choices: CHOICES } });
  const multiple = field({ type: 'multipleSelect', options: { choices: CHOICES } });

  it('names a choice and skips one it does not know', () => {
    expect(formatCell(single, 'cho00000000000002', ctx('de'))).toBe('Done');
    expect(formatCell(single, 'cho00000000000009', ctx('de'))).toBe('');
    expect(formatCell(single, null, ctx('de'))).toBe('');
    expect(formatCell(multiple, ['cho00000000000002', 'cho00000000000001'], ctx('ja'))).toBe('Done, Todo');
    expect(formatCell(multiple, ['cho00000000000009', 'cho00000000000001'], ctx('ja'))).toBe('Todo');
    expect(formatCell(multiple, [], ctx('ja'))).toBe('');
  });

  it('names a collaborator and leaves a stranger empty', () => {
    const createdBy = field({ type: 'createdBy' });
    expect(formatCell(createdBy, 'usr00000000000001', ctx('fr'))).toBe('Ada Lovelace');
    expect(formatCell(field({ type: 'lastModifiedBy' }), 'usr00000000000009', ctx('fr'))).toBe('');
    expect(formatCell(createdBy, null, ctx('fr'))).toBe('');
  });
});

// Timing budgets run with the performance checks (RIOSOMA_PERF=1), not on every commit, where other
// suites share the machine.
describe.skipIf(!process.env.RIOSOMA_PERF)('formatCell performance', () => {
  it('reuses its number formats over 100,000 cells', () => {
    const fields = [numberField(), numberField({ precision: 2 }), numberField({ thousands: false })];
    const contexts = [ctx('en-US'), ctx('de'), ctx('fr'), ctx('ja')];
    // One pass first, so the measurement is of formatting and not of building formats.
    for (const each of fields) formatCell(each, 1234.5, contexts[0]!);
    const started = performance.now();
    let length = 0;
    for (let index = 0; index < 100_000; index += 1) {
      length += formatCell(
        fields[index % fields.length]!,
        index + 0.5,
        contexts[index % contexts.length]!,
      ).length;
    }
    const elapsed = performance.now() - started;
    expect(length).toBeGreaterThan(0);
    // Building a format for every cell instead of reusing one costs roughly twenty times as much,
    // which is the difference between a smooth scroll and dropped frames.
    expect(elapsed).toBeLessThan(500);
  });
});

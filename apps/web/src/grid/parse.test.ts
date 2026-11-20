import { FieldMeta } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { formatCell } from './format';
import { dateOrderFor, parseText, type ParseContext } from './parse';

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

const dateField = (options: unknown = {}) => field({ type: 'date', options });

const CHOICES = [
  { id: 'cho00000000000001', name: 'Todo', color: 'gray' },
  { id: 'cho00000000000002', name: 'Done', color: 'green' },
];

const ctx = (locale: string, timeZone = 'America/New_York'): ParseContext => ({
  locale,
  timeZone,
  collaborators: new Map(),
});

const read = (spec: unknown, text: string, locale = 'en-US', timeZone?: string) =>
  parseText(field(spec), text, timeZone === undefined ? ctx(locale) : ctx(locale, timeZone));

describe('parseText empty text', () => {
  it('stores nothing, and an unchecked box for a checkbox', () => {
    for (const spec of [
      { type: 'text' },
      { type: 'longText' },
      { type: 'number' },
      { type: 'date' },
      { type: 'email' },
      { type: 'singleSelect', options: { choices: CHOICES } },
      { type: 'multipleSelect', options: { choices: CHOICES } },
    ]) {
      expect(read(spec, '   ')).toEqual({ ok: true, value: null });
    }
    expect(read({ type: 'checkbox' }, '')).toEqual({ ok: true, value: false });
    expect(read({ type: 'checkbox' }, ' \n ')).toEqual({ ok: true, value: false });
  });
});

describe('parseText text-like fields', () => {
  it('keeps the text as typed', () => {
    for (const type of ['text', 'longText', 'email', 'url', 'phone'] as const) {
      expect(read({ type }, '  Ada  ')).toEqual({ ok: true, value: '  Ada  ' });
      expect(read({ type }, 'a\nb')).toEqual({ ok: true, value: 'a\nb' });
    }
  });
});

describe('parseText numbers', () => {
  it('reads the format of the locale, and the plain one', () => {
    expect(read({ type: 'number' }, '1,234.5')).toEqual({ ok: true, value: 1234.5 });
    expect(read({ type: 'number' }, '1234.5')).toEqual({ ok: true, value: 1234.5 });
    expect(read({ type: 'number' }, '1234.5', 'de')).toEqual({ ok: true, value: 1234.5 });
    expect(read({ type: 'number' }, '1.234,5', 'de')).toEqual({ ok: true, value: 1234.5 });
    expect(read({ type: 'number' }, '1 234,5', 'fr')).toEqual({ ok: true, value: 1234.5 });
    expect(read({ type: 'number' }, '1\u202f234,5', 'fr')).toEqual({ ok: true, value: 1234.5 });
    expect(read({ type: 'number' }, '1,234.5', 'ja')).toEqual({ ok: true, value: 1234.5 });
    expect(read({ type: 'number' }, '1234,5', 'ja')).toEqual({ ok: true, value: 1234.5 });
    expect(read({ type: 'number' }, '1,234,567.89')).toEqual({ ok: true, value: 1234567.89 });
    expect(read({ type: 'number' }, '1.234.567,89', 'de')).toEqual({ ok: true, value: 1234567.89 });
    // A number can leave out the zero on either side of its decimal mark.
    expect(read({ type: 'number' }, '.5')).toEqual({ ok: true, value: 0.5 });
    expect(read({ type: 'number' }, ',5', 'de')).toEqual({ ok: true, value: 0.5 });
    expect(read({ type: 'number' }, '12.')).toEqual({ ok: true, value: 12 });
  });

  it('lets the locale settle a number that could be read two ways', () => {
    expect(read({ type: 'number' }, '1,234')).toEqual({ ok: true, value: 1234 });
    expect(read({ type: 'number' }, '1,234', 'de')).toEqual({ ok: true, value: 1.234 });
    expect(read({ type: 'number' }, '1.234')).toEqual({ ok: true, value: 1.234 });
    expect(read({ type: 'number' }, '1.234', 'de')).toEqual({ ok: true, value: 1234 });
    // Japanese writes numbers the way American English does, so the comma groups there too.
    expect(read({ type: 'number' }, '1,234', 'ja')).toEqual({ ok: true, value: 1234 });
    expect(read({ type: 'number' }, '1.234', 'ja')).toEqual({ ok: true, value: 1.234 });
    expect(read({ type: 'number' }, '1 234', 'fr')).toEqual({ ok: true, value: 1234 });
  });

  it('takes currency, a percent sign, parentheses, and a sign', () => {
    expect(read({ type: 'number' }, '$1,234.50')).toEqual({ ok: true, value: 1234.5 });
    expect(read({ type: 'number' }, '1234.5 €', 'fr')).toEqual({ ok: true, value: 1234.5 });
    expect(read({ type: 'number' }, '£12')).toEqual({ ok: true, value: 12 });
    expect(read({ type: 'number' }, '¥1,234', 'ja')).toEqual({ ok: true, value: 1234 });
    expect(read({ type: 'number' }, '₩1234', 'ko')).toEqual({ ok: true, value: 1234 });
    expect(read({ type: 'number' }, 'R$ 1.234,56', 'pt-BR')).toEqual({ ok: true, value: 1234.56 });
    expect(read({ type: 'number' }, '12%')).toEqual({ ok: true, value: 12 });
    expect(read({ type: 'number' }, '12 %', 'fr')).toEqual({ ok: true, value: 12 });
    expect(read({ type: 'number' }, '(123)')).toEqual({ ok: true, value: -123 });
    expect(read({ type: 'number' }, '(1.234)', 'de')).toEqual({ ok: true, value: -1234 });
    expect(read({ type: 'number' }, '\u22121234')).toEqual({ ok: true, value: -1234 });
    expect(read({ type: 'number' }, '-1.234,5', 'de')).toEqual({ ok: true, value: -1234.5 });
    expect(read({ type: 'number' }, '+12')).toEqual({ ok: true, value: 12 });
    expect(read({ type: 'number' }, '12-')).toEqual({ ok: true, value: -12 });
  });

  it('reads a negative number even where the field forbids one, which checkCellValue refuses', () => {
    expect(read({ type: 'number', options: { allowNegative: false } }, '-5')).toEqual({
      ok: true,
      value: -5,
    });
  });

  it('refuses text that is not a number', () => {
    for (const text of ['abc', '1.2.3', '12,34,56', '--5', '$', '1 2', 'NaN', '12e3']) {
      expect(read({ type: 'number' }, text), text).toEqual({ ok: false, reason: 'notNumber' });
    }
  });
});

describe('parseText checkboxes', () => {
  it('unchecks the words that say so and checks everything else', () => {
    for (const text of ['false', 'FALSE', 'No', 'n', '0', 'unchecked', 'Off']) {
      expect(read({ type: 'checkbox' }, text), text).toEqual({ ok: true, value: false });
    }
    for (const text of ['true', 'yes', 'x', '1', 'nein', 'anything']) {
      expect(read({ type: 'checkbox' }, text), text).toEqual({ ok: true, value: true });
    }
  });
});

describe('parseText dates', () => {
  it('reads ISO dates and instants', () => {
    expect(read({ type: 'date' }, '2026-09-27')).toEqual({ ok: true, value: '2026-09-27' });
    // A date-only field keeps the day an instant names and drops its time.
    expect(read({ type: 'date' }, '2026-09-27T23:00:00Z')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date', options: { includeTime: true } }, '2026-09-27')).toEqual({
      ok: true,
      value: '2026-09-27T04:00:00.000Z',
    });
    expect(read({ type: 'date', options: { includeTime: true } }, '2026-09-27T15:05:00Z')).toEqual({
      ok: true,
      value: '2026-09-27T15:05:00.000Z',
    });
    expect(read({ type: 'date', options: { includeTime: true } }, '2026-09-27T15:05:00+02:00')).toEqual({
      ok: true,
      value: '2026-09-27T13:05:00.000Z',
    });
    expect(read({ type: 'date', options: { includeTime: true } }, '2026-09-27T15:05:00.250Z')).toEqual({
      ok: true,
      value: '2026-09-27T15:05:00.250Z',
    });
  });

  it('reads numeric dates in the order of the locale, with any of the three separators', () => {
    expect(read({ type: 'date' }, '9/27/2026')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '9-27-2026')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '9.27.2026')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '27.9.2026', 'de')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '27/09/2026', 'fr')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '2026/9/27', 'ja')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '2026. 9. 27.', 'ko')).toEqual({ ok: true, value: '2026-09-27' });
    // A date pasted from a locale that writes the day first still reads.
    expect(read({ type: 'date' }, '27/9/2026')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '27/9/2026', 'ja')).toEqual({ ok: true, value: '2026-09-27' });
  });

  it('expands two-digit years around the turn of the century', () => {
    expect(read({ type: 'date' }, '9/27/26')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '9/27/00')).toEqual({ ok: true, value: '2000-09-27' });
    expect(read({ type: 'date' }, '9/27/69')).toEqual({ ok: true, value: '2069-09-27' });
    expect(read({ type: 'date' }, '9/27/70')).toEqual({ ok: true, value: '1970-09-27' });
    expect(read({ type: 'date' }, '9/27/99')).toEqual({ ok: true, value: '1999-09-27' });
    expect(read({ type: 'date' }, '27.9.26', 'de')).toEqual({ ok: true, value: '2026-09-27' });
  });

  it('reads month names in the locale and in English', () => {
    expect(read({ type: 'date' }, 'Sep 27, 2026')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, 'September 27, 2026')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '27 September 2026')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, 'Sept 27, 2026')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '27. September 2026', 'de')).toEqual({
      ok: true,
      value: '2026-09-27',
    });
    expect(read({ type: 'date' }, '27 sept. 2026', 'fr')).toEqual({ ok: true, value: '2026-09-27' });
    // English names reach every locale, since that is where most pasted dates come from.
    expect(read({ type: 'date' }, 'Sep 27, 2026', 'ja')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '2026年9月27日', 'ja')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '2026년 9월 27일', 'ko')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, 'sep 27 2026')).toEqual({ ok: true, value: '2026-09-27' });
    expect(read({ type: 'date' }, '27 janv 2026', 'fr')).toEqual({ ok: true, value: '2026-01-27' });
    // A weekday or a note around the day doesn't change which day is meant.
    expect(read({ type: 'date' }, 'Sunday, September 27, 2026')).toEqual({
      ok: true,
      value: '2026-09-27',
    });
    expect(read({ type: 'date' }, 'September 27, 2026 at 11:05 AM')).toEqual({
      ok: true,
      value: '2026-09-27',
    });
  });

  it('refuses a day the calendar does not have', () => {
    for (const text of [
      '2/30/2026',
      '30.2.2026',
      '2026-02-30',
      '13/13/2026',
      'Feb 30, 2026',
      'not a date',
      '27',
      '15:05',
      '2026-13-01',
      '9/27/2026 25:00',
    ]) {
      expect(read({ type: 'date' }, text), text).toEqual({ ok: false, reason: 'notDate' });
    }
    expect(read({ type: 'date' }, '2/30/2026', 'de')).toEqual({ ok: false, reason: 'notDate' });
  });

  it('reads a time with a date, and ignores one in a date-only field', () => {
    const withTime = { type: 'date', options: { includeTime: true } };
    expect(read(withTime, '9/27/2026 3:05 PM')).toEqual({
      ok: true,
      value: '2026-09-27T19:05:00.000Z',
    });
    // A day period on its own names the hour, so `3pm` is three o'clock sharp.
    expect(read(withTime, '9/27/2026 3pm')).toEqual({ ok: true, value: '2026-09-27T19:00:00.000Z' });
    expect(read(withTime, '9/27/2026 15:05')).toEqual({ ok: true, value: '2026-09-27T19:05:00.000Z' });
    expect(read(withTime, '9/27/2026 15:05:30')).toEqual({
      ok: true,
      value: '2026-09-27T19:05:30.000Z',
    });
    expect(read(withTime, '9/27/2026 12:00 AM')).toEqual({
      ok: true,
      value: '2026-09-27T04:00:00.000Z',
    });
    expect(read(withTime, '27.9.2026 15:05', 'de')).toEqual({
      ok: true,
      value: '2026-09-27T19:05:00.000Z',
    });
    expect(read(withTime, '2026年9月27日 15:05', 'ja')).toEqual({
      ok: true,
      value: '2026-09-27T19:05:00.000Z',
    });
    expect(read({ type: 'date' }, '9/27/2026 3:05 PM')).toEqual({ ok: true, value: '2026-09-27' });
  });

  it('reads the time in the zone of the field, and follows the viewer for `client`', () => {
    const tokyo = { type: 'date', options: { includeTime: true, timeZone: 'Asia/Tokyo' } };
    expect(read(tokyo, '9/27/2026 15:05')).toEqual({ ok: true, value: '2026-09-27T06:05:00.000Z' });
    // The same wall clock in the viewer's zone, and in winter, when New York is five hours behind.
    const client = { type: 'date', options: { includeTime: true } };
    expect(read(client, '7/4/2026 12:00')).toEqual({ ok: true, value: '2026-07-04T16:00:00.000Z' });
    expect(read(client, '1/4/2026 12:00')).toEqual({ ok: true, value: '2026-01-04T17:00:00.000Z' });
    expect(read(client, '9/28/2026 0:05', 'en-US', 'Asia/Tokyo')).toEqual({
      ok: true,
      value: '2026-09-27T15:05:00.000Z',
    });
  });

  it('reads back a zone the grid named itself', () => {
    const fixed = dateField({ includeTime: true, timeFormat: '12h', timeZone: 'America/Los_Angeles' });
    const text = formatCell(fixed, '2026-09-27T15:05:00.000Z', ctx('en-US'));
    expect(text).toBe('Sep 27, 2026, 8:05 AM PDT');
    expect(parseText(fixed, text, ctx('en-US'))).toEqual({
      ok: true,
      // Read in the field's own zone, which is what the text was showing.
      value: '2026-09-27T15:05:00.000Z',
    });
  });
});

describe('parseText choices', () => {
  const single = { type: 'singleSelect', options: { choices: CHOICES } };
  const multiple = { type: 'multipleSelect', options: { choices: CHOICES } };

  it('matches a choice by name, however it is written', () => {
    expect(read(single, 'Done')).toEqual({ ok: true, value: 'cho00000000000002' });
    expect(read(single, '  done ')).toEqual({ ok: true, value: 'cho00000000000002' });
    expect(read(single, 'TODO', 'de')).toEqual({ ok: true, value: 'cho00000000000001' });
    expect(read(single, 'Maybe')).toEqual({ ok: 'newChoices', names: ['Maybe'] });
    expect(read(single, '  Maybe  ')).toEqual({ ok: 'newChoices', names: ['Maybe'] });
  });

  it('splits a list, drops repeats, and reports every name it does not know', () => {
    expect(read(multiple, 'Done, Todo')).toEqual({
      ok: true,
      value: ['cho00000000000002', 'cho00000000000001'],
    });
    expect(read(multiple, 'Done\nTodo\n todo ,')).toEqual({
      ok: true,
      value: ['cho00000000000002', 'cho00000000000001'],
    });
    expect(read(multiple, ',,')).toEqual({ ok: true, value: null });
    expect(read(multiple, 'Done, Maybe, Later, Maybe')).toEqual({
      ok: 'newChoices',
      names: ['Maybe', 'Later'],
    });
  });
});

describe('parseText computed fields', () => {
  it('refuses the fields Riosoma fills in itself', () => {
    for (const type of [
      'createdTime',
      'lastModifiedTime',
      'createdBy',
      'lastModifiedBy',
      'recordId',
    ] as const) {
      expect(read({ type }, 'anything')).toEqual({ ok: false, reason: 'computed' });
    }
  });
});

describe('dateOrderFor', () => {
  it('knows where each locale puts the year', () => {
    expect(dateOrderFor('en-US')).toBe('mdy');
    for (const locale of ['en-GB', 'de', 'fr', 'es', 'it', 'pt-BR', 'nl']) {
      expect(dateOrderFor(locale), locale).toBe('dmy');
    }
    for (const locale of ['ja', 'ko', 'zh-Hans', 'zh-Hant']) {
      expect(dateOrderFor(locale), locale).toBe('ymd');
    }
  });
});

describe('round trips', () => {
  const back = (spec: unknown, value: string | number, locale: string, timeZone?: string) => {
    const target = field(spec);
    const context = timeZone === undefined ? ctx(locale) : ctx(locale, timeZone);
    const text = formatCell(target, value, context);
    expect(parseText(target, text, context), `${locale} ${text}`).toEqual({ ok: true, value });
  };

  it('gives the same number back in every locale', () => {
    for (const locale of ['en-US', 'de', 'fr', 'ja']) {
      for (const value of [0, 1234.5, -1234.5, 1234567, 0.5, -0.125, 987654321.25, 1e-10]) {
        back({ type: 'number' }, value, locale);
        back({ type: 'number', options: { thousands: false } }, value, locale);
      }
      // A fixed precision can only give back a number it shows in full.
      for (const value of [0, 1234.5, -1234.5, 1234567, 0.25, 987654321.25]) {
        back({ type: 'number', options: { precision: 2 } }, value, locale);
      }
    }
  });

  it('gives the same day back in every locale and layout', () => {
    for (const locale of ['en-US', 'de', 'fr', 'ja']) {
      for (const dateFormat of ['local', 'friendly', 'us', 'european', 'iso']) {
        back({ type: 'date', options: { dateFormat } }, '2026-09-27', locale);
      }
    }
  });

  it('gives the same instant back, with the time and zone the field shows', () => {
    const instant = '2026-09-27T15:05:00.000Z';
    for (const locale of ['en-US', 'de', 'fr', 'ja']) {
      for (const timeFormat of ['local', '12h', '24h']) {
        for (const dateFormat of ['local', 'friendly', 'us', 'european', 'iso']) {
          back({ type: 'date', options: { includeTime: true, dateFormat, timeFormat } }, instant, locale);
        }
      }
      back(
        { type: 'date', options: { includeTime: true, timeZone: 'America/Los_Angeles' } },
        instant,
        locale,
      );
      back(
        {
          type: 'date',
          options: { includeTime: true, dateFormat: 'us', timeZone: 'America/Los_Angeles' },
        },
        instant,
        locale,
        'Europe/Berlin',
      );
    }
  });

  it('gives the same choices back', () => {
    for (const locale of ['en-US', 'de', 'fr', 'ja']) {
      back({ type: 'singleSelect', options: { choices: CHOICES } }, 'cho00000000000002', locale);
      const target = field({ type: 'multipleSelect', options: { choices: CHOICES } });
      const context = ctx(locale);
      const value = ['cho00000000000002', 'cho00000000000001'];
      expect(parseText(target, formatCell(target, value, context), context)).toEqual({
        ok: true,
        value,
      });
    }
  });
});

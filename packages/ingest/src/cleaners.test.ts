import { describe, expect, it } from 'vitest';
import {
  addDecimals,
  blank,
  boolean,
  canonicalDecimal,
  date,
  dateReadings,
  duration,
  identifier,
  instant,
  inputValue,
  isEmpty,
  lookup,
  multiplyDecimals,
  number,
  text,
} from './cleaners.js';
import { cell } from './source.js';

describe('instant', () => {
  it('validates calendar days and clocks, preserves fractional seconds, and treats a missing zone as UTC', () => {
    expect(instant('2026-10-12T10:30:00Z')).toEqual({
      value: String(Date.parse('2026-10-12T10:30:00Z') / 1000),
      certain: true,
    });
    expect(instant('2026-10-12 10:30:00.123456789').value).toBe(
      `${Date.parse('2026-10-12T10:30:00Z') / 1000}.123456789`,
    );
    expect(instant('2026-10-12T03:30:00-07:00')).toEqual(instant('2026-10-12T10:30:00Z'));
    for (const value of [
      '2026-02-30T10:30:00Z',
      '2026-10-12T24:00:00Z',
      '2026-10-12T10:60:00Z',
      '2026-10-12T10:30:60Z',
      '2026-10-12',
      'tomorrow',
    ])
      expect(instant(value)).toMatchObject({ value: null, certain: false });
    expect(instant(null)).toEqual({ value: null, certain: true });
  });
});

describe('blank and text', () => {
  it('recognizes declared placeholders without treating zero or false as empty', () => {
    for (const input of [null, undefined, '', '  ', ' N/A ', cell('n/a')])
      expect(blank(input, { placeholders: ['N/A'] })).toEqual({ value: null, certain: true });
    expect(blank(0)).toEqual({ value: 0, certain: true });
    expect(blank(false)).toEqual({ value: false, certain: true });
    expect(blank('unknown')).toEqual({ value: 'unknown', certain: true });
    expect(isEmpty(cell(0))).toBe(false);
    expect(inputValue(cell('0042'))).toBe('0042');
  });
  it('trims and normalizes text while preserving case and optional internal spacing', () => {
    expect(text('  Cafe\u0301  Grove  ')).toEqual({ value: 'Café  Grove', certain: true });
    expect(text(' A\tB  C ', { collapseSpaces: true }).value).toBe('A B C');
    expect(text(false).value).toBe('false');
    expect(text('none', { placeholders: ['NONE'] }).value).toBeNull();
  });
  it('is idempotent over generated Unicode text and blanks', () => {
    for (let index = 0; index < 150; index++) {
      const input = `  Cove ${index} Cafe\u0301  `;
      const result = text(input);
      expect(text(result.value)).toEqual(result);
      expect(blank(blank(input).value)).toEqual(blank(input));
      expect(text(blank(null).value)).toEqual({ value: null, certain: true });
    }
  });
});

describe('exact numbers', () => {
  it('handles declared decimal marks, grouped digits, units, negative values, and scientific notation', () => {
    expect(number('USD 1,234.50', { decimalMark: '.', units: ['USD'] })).toEqual({
      value: '1234.5',
      certain: true,
    });
    expect(number('(1.234,50)', { decimalMark: ',' }).value).toBe('-1234.5');
    expect(number('1 234,50', { decimalMark: ',', groupingMark: ' ' }).value).toBe('1234.5');
    expect(number('1,234', { decimalMark: '.', groupingMark: 'none' }).certain).toBe(false);
    expect(number('1,23,456.00', { decimalMark: '.' }).certain).toBe(false);
    expect(number('12.5kg', { decimalMark: '.', units: ['kg'] }).value).toBe('12.5');
    expect(number('12 kg').issue?.input).toBe('units');
    expect(number('1.25e-4').value).toBe('0.000125');
    expect(number('1.234e2', { decimalMark: '.' }).value).toBe('123.4');
    expect(number('1.234e2', { decimalMark: ',' }).value).toBe('123400');
    expect(number('1e1001').certain).toBe(false);
    expect(number(true).certain).toBe(false);
    expect(number(Infinity).certain).toBe(false);
    expect(number(Number.MAX_SAFE_INTEGER + 1).issue?.input).toBe('exactText');
    expect(number('n/a', { placeholders: ['N/A'] })).toEqual({ value: null, certain: true });
    expect(number('1.20').value).toBe('1.2');
    expect(number('junk').certain).toBe(false);
  });
  it('reads a fraction written with no digit before its mark', () => {
    expect(number('.75')).toEqual({ value: '0.75', certain: true });
    expect(number('-.5').value).toBe('-0.5');
    expect(number('+.5').value).toBe('0.5');
    expect(number(',75', { decimalMark: ',' }).value).toBe('0.75');
    expect(number('USD .50', { decimalMark: '.', units: ['USD'] }).value).toBe('0.5');
    expect(number('(.25)').value).toBe('-0.25');
    for (const refused of ['.', '-.', '5.', '..5', '.5.5', '.,5'])
      expect(number(refused).certain).toBe(false);
  });

  it('never certifies a separator with two different readings', () => {
    expect(number('0,000')).toMatchObject({ value: '0', certain: false, issue: { input: 'decimalMark' } });
    for (let index = 1; index <= 150; index++) {
      const fraction = String(index).padStart(3, '0');
      for (const separator of ['.', ',']) {
        const input = `12${separator}${fraction}`;
        expect(number(input)).toMatchObject({
          value: null,
          certain: false,
          issue: { key: 'ingest.cleaner.ambiguous', input: 'decimalMark' },
        });
        expect(number(`${input}e2`)).toMatchObject({
          value: null,
          certain: false,
          issue: { key: 'ingest.cleaner.ambiguous', input: 'decimalMark' },
        });
      }
    }
  });
  it('round trips decimal strings beyond machine precision', () => {
    for (let index = 1; index <= 200; index++) {
      const input = `${index % 2 ? '-' : ''}9007199254740993.${String(index).padStart(12, '0')}`;
      const result = number(input, { decimalMark: '.' });
      expect(result.certain).toBe(true);
      expect(number(result.value, { decimalMark: '.' })).toEqual(result);
      expect(number(input.replace('.', ','), { decimalMark: ',' })).toEqual(result);
    }
  });
  it('adds and multiplies exact coefficients', () => {
    expect(addDecimals('0.1', '0.2')).toBe('0.3');
    expect(addDecimals('9007199254740993.01', '0.09')).toBe('9007199254740993.1');
    expect(addDecimals('-0.01', '0.005')).toBe('-0.005');
    expect(multiplyDecimals('1.25', '2.4')).toBe('3');
    expect(multiplyDecimals('-0.1', '-0.2')).toBe('0.02');
    expect(canonicalDecimal('-000.000')).toBe('0');
    expect(canonicalDecimal('1e1001')).toBeNull();
    expect(canonicalDecimal('bad')).toBeNull();
    expect(() => addDecimals('bad', '1')).toThrow('ingest.decimal.invalid');
    for (let index = 0; index < 100; index++) {
      const value = `123.${String(index).padStart(2, '0')}`;
      expect(addDecimals(value, `-${value}`)).toBe('0');
      expect(multiplyDecimals(value, '1')).toBe(canonicalDecimal(value));
    }
  });
});

describe('calendar dates', () => {
  it('requires real calendar days and explicit formats for non-ISO dates', () => {
    expect(date('2024-02-29')).toEqual({ value: '2024-02-29', certain: true });
    for (const input of ['2026-02-29', '1900-02-29', '2026-04-31', '0000-01-01', '2026-13-01'])
      expect(date(input, { formats: ['YYYY-MM-DD'] }).certain).toBe(false);
    expect(date('2000-02-29').certain).toBe(true);
    expect(date('2026-02-29').issue?.input).toBe('calendarDay');
    expect(date('2026/03/15', { formats: ['YYYY/MM/DD'] }).value).toBe('2026-03-15');
    expect(date('15-03-2026', { formats: ['DD-MM-YYYY'] }).value).toBe('2026-03-15');
    expect(date('03/15/2026').issue?.input).toBe('formats');
    expect(date('15/03/2026', { formats: ['MM/DD/YYYY', 'DD/MM/YYYY'] }).value).toBe('2026-03-15');
    expect(dateReadings('04-03-2026', ['MM-DD-YYYY', 'DD-MM-YYYY']).size).toBe(2);
    expect(date(null)).toEqual({ value: null, certain: true });
  });
  it('round trips generated days and never certifies two different valid orders', () => {
    for (let day = 1; day <= 12; day++) {
      expect(date(`${day}/${day}/2026`, { formats: ['MM/DD/YYYY', 'DD/MM/YYYY'] })).toMatchObject({
        certain: false,
        issue: { input: 'formats' },
      });
    }
    for (let year = 1996; year <= 2030; year++)
      for (let month = 1; month <= 12; month++) {
        const day = (month % 12) + 1;
        const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        expect(date(date(iso).value)).toEqual(date(iso));
        const input = `${month}/${day}/${year}`;
        const result = date(input, { formats: ['MM/DD/YYYY', 'DD/MM/YYYY'] });
        expect(result.certain).toBe(false);
        expect(result.issue?.key).toBe('ingest.cleaner.ambiguous');
      }
  });
});

describe('duration', () => {
  it('requires units or a clock interpretation and returns exact seconds', () => {
    expect(duration('1.5', { unit: 'hours', decimalMark: '.' }).value).toBe('5400');
    expect(duration('1:30').certain).toBe(false);
    expect(duration('1:30', { clock: 'hours:minutes' }).value).toBe('5400');
    expect(duration('1:30', { clock: 'minutes:seconds' }).value).toBe('90');
    expect(duration('1:60', { clock: 'hours:minutes' }).certain).toBe(false);
    expect(duration('12').issue?.input).toBe('unit');
    expect(duration('-1', { unit: 'seconds' }).certain).toBe(false);
    expect(duration(null)).toEqual({ value: null, certain: true });
  });
  it('round trips seconds and never certifies an unspecified two-part clock', () => {
    for (let index = 1; index <= 150; index++) {
      const value = `${index}.125`;
      const result = duration(value, { unit: 'seconds', decimalMark: '.' });
      expect(duration(result.value, { unit: 'seconds', decimalMark: '.' })).toEqual(result);
      expect(duration(`${index}:30`).certain).toBe(false);
    }
  });
});

describe('boolean', () => {
  it('accepts declared values and reports unknown ones', () => {
    expect(boolean(' Yes ')).toEqual({ value: true, certain: true });
    expect(boolean('0').value).toBe(false);
    expect(boolean('active', { trueValues: ['active'], falseValues: ['inactive'] }).value).toBe(true);
    expect(boolean('sometimes').issue?.input).toBe('booleanValues');
    expect(boolean(null).value).toBeNull();
  });
  it('round trips boolean values and never certifies overlapping vocabularies', () => {
    for (let index = 0; index < 100; index++) {
      const value = index % 2 === 0;
      expect(boolean(boolean(value).value)).toEqual({ value, certain: true });
      const label = `State ${index}`;
      expect(boolean(label, { trueValues: [label], falseValues: [label.toLowerCase()] }).certain).toBe(false);
    }
  });
});

describe('identifier', () => {
  it('keeps zeros, requires width for numeric cells, and refuses unsafe values', () => {
    expect(identifier(' 00412 ')).toEqual({ value: '00412', certain: true });
    expect(identifier(412)).toMatchObject({ value: '412', certain: false, issue: { input: 'width' } });
    expect(identifier(412, { width: 5 })).toEqual({ value: '00412', certain: true });
    for (const input of [1.5, -1, Number.MAX_SAFE_INTEGER + 1, true])
      expect(identifier(input).certain).toBe(false);
    expect(identifier('123', { width: 2 }).certain).toBe(false);
    expect(identifier('123', { width: 0 }).certain).toBe(false);
    expect(identifier(null).value).toBeNull();
  });
  it('round trips generated identifiers without erasing leading zeros', () => {
    for (let index = 0; index < 200; index++) {
      const value = String(index).padStart(7, '0');
      expect(identifier(identifier(value).value)).toEqual({ value, certain: true });
      expect(identifier(index).certain).toBe(false);
      expect(identifier(index, { width: 7 }).value).toBe(value);
    }
  });
});

describe('lookup', () => {
  it('reports missing entries and respects declared case sensitivity', () => {
    expect(lookup(' crest ', { entries: { Crest: 'A' } })).toEqual({ value: 'A', certain: true });
    expect(lookup('crest', { entries: { Crest: 'A' }, caseSensitive: true }).certain).toBe(false);
    expect(lookup('missing', { entries: {} }).issue?.input).toBe('entries');
    expect(lookup(null, { entries: {} })).toEqual({ value: null, certain: true });
    expect(lookup('crest', { entries: { Crest: 'A', CREST: 'A' } }).certain).toBe(true);
  });
  it('round trips identity vocabularies and never certifies conflicting normalized keys', () => {
    for (let index = 0; index < 100; index++) {
      const value = `Tier${index}`;
      const entries = { [value]: value };
      const result = lookup(value, { entries });
      expect(lookup(result.value, { entries })).toEqual(result);
      expect(lookup(value, { entries: { [value]: 'A', [value.toLowerCase()]: 'B' } }).certain).toBe(false);
    }
  });
});

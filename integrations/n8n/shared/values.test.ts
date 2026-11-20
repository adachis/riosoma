import { describe, expect, it } from 'vitest';
import type { FieldMeta } from './types';
import { fromRiosoma, recordToJson, toRiosoma, ValueProblem, wallTimeToInstant } from './values';

const ctx = { address: 'https://riosoma.example.com', timeZone: 'America/New_York' };
const field = (type: string, options: FieldMeta['options'] = {}): FieldMeta => ({
  id: 'fldExample0000000',
  tableId: 'tblExample0000000',
  name: 'Example',
  type,
  options,
});

/** A stand-in for the Luxon DateTime n8n passes for date fields. */
const dateTime = (iso: string, day: string) => ({
  isValid: true,
  toISODate: () => day,
  toJSDate: () => new Date(iso),
});

describe('toRiosoma', () => {
  it('reads numbers from text and refuses other text', () => {
    expect(toRiosoma(field('number'), '42.5', ctx)).toBe(42.5);
    expect(toRiosoma(field('currency'), 7, ctx)).toBe(7);
    expect(toRiosoma(field('percent'), ' -0.25 ', ctx)).toBe(-0.25);
    expect(() => toRiosoma(field('number'), 'about 5', ctx)).toThrow(ValueProblem);
    expect(() => toRiosoma(field('rating'), true, ctx)).toThrow('Expected a number');
  });

  it('reads checkboxes from words and digits', () => {
    expect(toRiosoma(field('checkbox'), 'Yes', ctx)).toBe(true);
    expect(toRiosoma(field('checkbox'), '0', ctx)).toBe(false);
    expect(toRiosoma(field('checkbox'), 1, ctx)).toBe(true);
    expect(toRiosoma(field('checkbox'), '', ctx)).toBe(false);
    expect(() => toRiosoma(field('checkbox'), 'maybe', ctx)).toThrow('Expected true or false');
  });

  it('writes a date field without a time as the day written', () => {
    const date = field('date', { includeTime: false });
    expect(toRiosoma(date, '2026-10-15', ctx)).toBe('2026-10-15');
    expect(toRiosoma(date, '2026-10-15T23:30:00-07:00', ctx)).toBe('2026-10-15');
    expect(toRiosoma(date, dateTime('2026-10-16T03:30:00Z', '2026-10-15'), ctx)).toBe('2026-10-15');
    expect(toRiosoma(date, new Date('2026-10-15T12:00:00Z'), ctx)).toBe('2026-10-15');
    expect(() => toRiosoma(date, 'next Tuesday', ctx)).toThrow('Expected a date');
  });

  it('writes a date field with a time as an instant, reading times without an offset in the time zone', () => {
    const stamp = field('date', { includeTime: true });
    expect(toRiosoma(stamp, '2026-10-15T14:30:00+02:00', ctx)).toBe('2026-10-15T12:30:00.000Z');
    expect(toRiosoma(stamp, '2026-10-15 14:30', ctx)).toBe('2026-10-15T18:30:00.000Z');
    expect(toRiosoma(stamp, '2026-10-15', ctx)).toBe('2026-10-15T04:00:00.000Z');
    expect(toRiosoma(stamp, dateTime('2026-10-15T14:30:00Z', '2026-10-15'), ctx)).toBe(
      '2026-10-15T14:30:00.000Z',
    );
  });

  it('crosses a change of clocks correctly', () => {
    // New York moves from daylight to standard time on 2026-11-01.
    expect(wallTimeToInstant('2026-10-31T12:00', 'America/New_York')).toBe('2026-10-31T16:00:00.000Z');
    expect(wallTimeToInstant('2026-11-02T12:00', 'America/New_York')).toBe('2026-11-02T17:00:00.000Z');
    expect(wallTimeToInstant('2026-11-02T12:00', 'UTC')).toBe('2026-11-02T12:00:00.000Z');
  });

  it('takes linked records by ID from lists, text with commas, and records', () => {
    const link = field('link');
    expect(toRiosoma(link, 'rec00000000000001, rec00000000000002', ctx)).toEqual([
      'rec00000000000001',
      'rec00000000000002',
    ]);
    expect(toRiosoma(link, [{ id: 'rec00000000000003' }], ctx)).toEqual(['rec00000000000003']);
    expect(toRiosoma(link, '["rec00000000000004"]', ctx)).toEqual(['rec00000000000004']);
    expect(() => toRiosoma(link, 'Order 5', ctx)).toThrow('Linked records go by record ID');
  });

  it('takes files by ID, by a file from a read, or by their Riosoma address', () => {
    const files = field('attachment');
    expect(
      toRiosoma(
        files,
        [
          'att00000000000001',
          { id: 'att00000000000002', url: 'https://riosoma.example.com/api/files/att00000000000002/a.pdf' },
          'https://riosoma.example.com/api/files/att00000000000003/report.pdf',
          { url: '/api/files/att00000000000004/b.png' },
        ],
        ctx,
      ),
    ).toEqual(['att00000000000001', 'att00000000000002', 'att00000000000003', 'att00000000000004']);
  });

  it('explains that files from elsewhere must be uploaded to Riosoma first', () => {
    expect(() => toRiosoma(field('attachment'), 'https://example.com/photo.jpg', ctx)).toThrow(
      /attaches files already stored in Riosoma/,
    );
  });

  it('keeps an option name with a comma whole, and splits other text', () => {
    const tags = field('multipleSelect', {
      choices: [
        { id: 'choA', name: 'Red, dark' },
        { id: 'choB', name: 'Blue' },
      ],
    });
    expect(toRiosoma(tags, 'Red, dark', ctx)).toEqual(['Red, dark']);
    expect(toRiosoma(tags, 'Blue, Green', ctx)).toEqual(['Blue', 'Green']);
    expect(toRiosoma(tags, [{ name: 'Blue' }], ctx)).toEqual(['Blue']);
  });

  it('takes people by ID, email, or person', () => {
    expect(toRiosoma(field('user'), 'ada@example.com', ctx)).toEqual(['ada@example.com']);
    expect(
      toRiosoma(field('user'), [{ id: 'usr00000000000001', email: 'ada@example.com', name: 'Ada' }], ctx),
    ).toEqual(['usr00000000000001']);
  });

  it('writes text, clears empty values, and refuses computed fields', () => {
    expect(toRiosoma(field('text'), 12, ctx)).toBe('12');
    expect(toRiosoma(field('text'), '', ctx)).toBe('');
    expect(toRiosoma(field('number'), '', ctx)).toBeNull();
    expect(toRiosoma(field('link'), null, ctx)).toBeNull();
    expect(() => toRiosoma(field('formula'), 'x', ctx)).toThrow('fills in this field itself');
  });
});

describe('fromRiosoma', () => {
  it('makes file addresses absolute and leaves other values alone', () => {
    expect(
      fromRiosoma(
        'attachment',
        [
          {
            id: 'att1',
            url: '/api/files/att1/a.png',
            thumbnails: { small: '/api/files/att1/thumbnails/small', large: null },
          },
        ],
        ctx,
      ),
    ).toEqual([
      {
        id: 'att1',
        url: 'https://riosoma.example.com/api/files/att1/a.png',
        thumbnails: { small: 'https://riosoma.example.com/api/files/att1/thumbnails/small', large: null },
      },
    ]);
    expect(fromRiosoma('number', 5, ctx)).toBe(5);
  });

  it('puts the record ID after the fields, or the fields under their own key', () => {
    const record = { id: 'rec1', createdTime: '2026-10-01T00:00:00.000Z', fields: { Name: 'A', id: 'mine' } };
    expect(recordToJson(record, [], ctx)).toEqual({
      Name: 'A',
      id: 'rec1',
      createdTime: '2026-10-01T00:00:00.000Z',
    });
    expect(recordToJson(record, [], ctx, true)).toEqual({
      id: 'rec1',
      createdTime: '2026-10-01T00:00:00.000Z',
      fields: { Name: 'A', id: 'mine' },
    });
  });
});

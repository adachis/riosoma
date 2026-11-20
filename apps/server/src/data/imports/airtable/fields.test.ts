import { describe, expect, it } from 'vitest';
import { checkCellValue, type FieldMeta } from '@riosoma/contracts';
import type { AirtableField } from './api.js';
import { colorOf, currencyCode, planField, textOf, type FieldPlan } from './fields.js';

const tables = new Set(['tblOther00000000', 'tblSelf000000000']);
const field = (type: string, options?: Record<string, unknown>, name = 'Field'): AirtableField => ({
  id: 'fldSomething0000',
  name,
  type,
  ...(options ? { options } : {}),
});
const plan = (type: string, options?: Record<string, unknown>, primary = false) =>
  planField(field(type, options), { tables, primary });

function value(planned: FieldPlan) {
  if (planned.kind !== 'value') throw new Error(`expected a value plan, got ${planned.kind}`);
  return planned;
}

/** What a cell becomes once it's read and checked the way records are. */
function cell(planned: FieldPlan, input: unknown) {
  const plan = value(planned);
  const meta = {
    ...plan.spec,
    id: plan.id,
    tableId: 'tblSelf000000000',
    name: plan.name,
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
  } as FieldMeta;
  return checkCellValue(meta, plan.read(input));
}

const keys = (planned: FieldPlan) => planned.notes.map((note) => `${note.status}:${note.key}`);

describe('Airtable field types', () => {
  it('keeps text, email, URL, and phone fields as they are', () => {
    expect(value(plan('singleLineText')).spec).toEqual({ type: 'text', options: {} });
    expect(cell(plan('singleLineText'), 'Hello')).toEqual({ ok: true, value: 'Hello' });
    expect(value(plan('email')).spec.type).toBe('email');
    expect(cell(plan('email'), ' ada@example.com ')).toEqual({ ok: true, value: 'ada@example.com' });
    expect(cell(plan('email'), 'not an email')).toEqual({ ok: false, messageKey: 'data.value.notEmail' });
    expect(value(plan('url')).spec.type).toBe('url');
    expect(value(plan('phoneNumber')).spec.type).toBe('phone');
  });

  it('makes long text single-line text when it names records, and keeps rich text as rich text', () => {
    expect(value(plan('multilineText')).spec).toEqual({ type: 'longText', options: { richText: false } });
    const primary = plan('multilineText', undefined, true);
    expect(value(primary).spec.type).toBe('text');
    expect(keys(primary)).toEqual(['changed:import.airtable.report.primaryLines']);
    // Airtable sends rich text as Markdown, which Riosoma's rich text stores as it is.
    expect(value(plan('richText')).spec).toEqual({ type: 'longText', options: { richText: true } });
    expect(keys(plan('richText'))).toEqual([]);
    expect(keys(plan('richText', undefined, true))).toEqual(['changed:import.airtable.report.richText']);
  });

  it('keeps numbers, percents, currencies, durations, and ratings with their options', () => {
    expect(value(plan('number', { precision: 3 })).spec).toEqual({
      type: 'number',
      options: { precision: 3, thousands: true, allowNegative: true },
    });
    expect(value(plan('percent', { precision: 1 })).spec).toMatchObject({
      type: 'percent',
      options: { precision: 1 },
    });
    expect(cell(plan('percent', { precision: 1 }), 0.25)).toEqual({ ok: true, value: 0.25 });
    expect(value(plan('currency', { precision: 2, symbol: '€' })).spec).toMatchObject({
      type: 'currency',
      options: { code: 'EUR', precision: 2 },
    });
    const unknown = plan('currency', { precision: 1, symbol: '¤' });
    expect(value(unknown).spec).toMatchObject({ type: 'number', options: { precision: 1 } });
    expect(unknown.notes[0]).toMatchObject({
      key: 'import.airtable.report.currencyUnknown',
      params: { symbol: '¤' },
    });
    expect(value(plan('duration', { durationFormat: 'h:mm:ss.SS' })).spec).toEqual({
      type: 'duration',
      options: { format: 'h:mm:ss.ss' },
    });
    expect(cell(plan('duration', { durationFormat: 'h:mm' }), -60).ok).toBe(false);
    expect(value(plan('rating', { max: 7, icon: 'dot', color: 'purpleBright' })).spec).toEqual({
      type: 'rating',
      options: { max: 7, icon: 'circle', color: 'purple' },
    });
  });

  it('keeps checkboxes, noting an icon Riosoma doesn’t draw', () => {
    expect(value(plan('checkbox', { color: 'tealBright', icon: 'check' })).spec).toEqual({
      type: 'checkbox',
      options: { color: 'teal' },
    });
    expect(cell(plan('checkbox'), true)).toEqual({ ok: true, value: true });
    expect(keys(plan('checkbox', { icon: 'star' }))).toEqual(['changed:import.airtable.report.checkboxIcon']);
  });

  it('keeps dates and times with their formats and time zones', () => {
    expect(value(plan('date', { dateFormat: { name: 'european', format: 'D/M/YYYY' } })).spec).toEqual({
      type: 'date',
      options: { includeTime: false, dateFormat: 'european', timeFormat: 'local', timeZone: 'client' },
    });
    const dateTime = plan('dateTime', {
      dateFormat: { name: 'friendly' },
      timeFormat: { name: '12hour' },
      timeZone: 'America/Chicago',
    });
    expect(value(dateTime).spec).toEqual({
      type: 'date',
      options: { includeTime: true, dateFormat: 'friendly', timeFormat: '12h', timeZone: 'America/Chicago' },
    });
    expect(cell(dateTime, '2026-01-20T15:30:00.000Z')).toEqual({
      ok: true,
      value: '2026-01-20T15:30:00.000Z',
    });
    expect(value(plan('dateTime', { timeZone: 'utc' })).spec).toMatchObject({ options: { timeZone: 'UTC' } });
    expect(value(plan('dateTime', { timeZone: 'Not/AZone' })).spec).toMatchObject({
      options: { timeZone: 'client' },
    });
    const created = plan('createdTime', { result: { type: 'dateTime', options: { timeZone: 'utc' } } });
    expect(value(created).spec).toMatchObject({
      type: 'date',
      options: { includeTime: true, timeZone: 'UTC' },
    });
    expect(keys(created)).toEqual(['changed:import.airtable.report.timeFixed']);
    expect(keys(plan('lastModifiedTime', { result: { type: 'date' } }))).toEqual([
      'changed:import.airtable.report.timeFixed',
    ]);
  });

  it('keeps single and multiple selects with their colors, reading options by name', () => {
    const single = plan('singleSelect', {
      choices: [
        { id: 'selA', name: 'Todo', color: 'blueLight2' },
        { id: 'selB', name: 'Doing', color: 'cyanBright' },
        { id: 'selC', name: 'Done' },
      ],
    });
    const spec = value(single).spec;
    if (spec.type !== 'singleSelect') throw new Error('expected a single select');
    expect(spec.options.choices.map(({ name, color }) => [name, color])).toEqual([
      ['Todo', 'blue'],
      ['Doing', 'teal'],
      ['Done', 'gray'],
    ]);
    expect(cell(single, 'Doing')).toEqual({ ok: true, value: spec.options.choices[1]!.id });
    expect(cell(single, 'Gone').ok).toBe(false);
    const multiple = plan('multipleSelects', { choices: [{ name: 'a', color: 'redLight1' }, { name: 'b' }] });
    const multi = value(multiple).spec;
    if (multi.type !== 'multipleSelect') throw new Error('expected a multiple select');
    expect(cell(multiple, ['b', 'a'])).toEqual({
      ok: true,
      value: [multi.options.choices[1]!.id, multi.options.choices[0]!.id],
    });
    expect(keys(plan('externalSyncSource', { choices: [{ name: 'Sheet' }] }))).toEqual([
      'changed:import.airtable.report.syncSource',
    ]);
  });

  it('keeps people as their email addresses until they turn out to be members', () => {
    const people = plan('multipleCollaborators');
    const planned = value(people);
    expect(planned.spec.type).toBe('text');
    expect(planned.finish).toEqual({ kind: 'people', allowMultiple: true });
    expect(
      cell(people, [
        { id: 'usrA', email: 'Ada@example.com', name: 'Ada' },
        { id: 'usrB', name: 'No Email' },
      ]),
    ).toEqual({ ok: true, value: 'Ada@example.com, No Email' });
    expect([...planned.people!]).toEqual(['ada@example.com', 'no email']);
    expect(value(plan('singleCollaborator')).finish).toEqual({ kind: 'people', allowMultiple: false });
    expect(keys(plan('createdBy'))).toEqual(['changed:import.airtable.report.peopleFixed']);
  });

  it('plans links, and leaves out links to tables that didn’t come across', () => {
    const link = plan('multipleRecordLinks', {
      linkedTableId: 'tblOther00000000',
      inverseLinkFieldId: 'fldInverse000000',
      prefersSingleRecordLink: true,
    });
    expect(link).toMatchObject({
      kind: 'link',
      linkedTable: 'tblOther00000000',
      inverse: 'fldInverse000000',
      prefersSingle: true,
    });
    const missing = plan('multipleRecordLinks', { linkedTableId: 'tblNowhere000000' });
    expect(missing.kind).toBe('omitted');
    expect(keys(missing)).toEqual(['omitted:import.airtable.report.linkMissing']);
    expect(plan('multipleAttachments').kind).toBe('files');
  });

  it('starts computed fields as text holding Airtable’s values, to turn into the real thing later', () => {
    const formula = plan('formula', {
      formula: '{fldA} * 2',
      isValid: true,
      result: { type: 'currency', options: { precision: 2, symbol: '$' } },
    });
    expect(value(formula).spec.type).toBe('text');
    expect(value(formula).finish).toMatchObject({ kind: 'formula', formula: '{fldA} * 2', valid: true });
    expect(cell(formula, 12.5)).toEqual({ ok: true, value: '$12.50' });
    expect(cell(plan('formula', { result: { type: 'percent', options: { precision: 0 } } }), 0.25)).toEqual({
      ok: true,
      value: '25%',
    });
    expect(cell(formula, { specialValue: 'NaN' })).toEqual({ ok: true, value: 'NaN' });
    expect(cell(formula, { error: '#ERROR!' })).toEqual({ ok: true, value: '#ERROR!' });
    const lookup = plan('multipleLookupValues', { recordLinkFieldId: 'fldL', fieldIdInLinkedTable: 'fldT' });
    expect(value(lookup).finish).toEqual({ kind: 'lookup', link: 'fldL', target: 'fldT' });
    expect(cell(lookup, ['a', 'b'])).toEqual({ ok: true, value: 'a, b' });
    const rollup = plan('rollup', {
      recordLinkFieldId: 'fldL',
      fieldIdInLinkedTable: 'fldT',
      result: { type: 'number' },
    });
    expect(value(rollup).finish).toEqual({ kind: 'rollup', link: 'fldL', target: 'fldT', result: 'number' });
    const count = plan('count', { recordLinkFieldId: 'fldL' });
    expect(value(count).spec.type).toBe('number');
    expect(value(count).finish).toEqual({ kind: 'count', link: 'fldL' });
    expect(value(plan('autoNumber')).finish).toEqual({ kind: 'autoNumber' });
  });

  it('keeps barcodes, buttons, and generated text as their values, with notes', () => {
    const barcode = plan('barcode');
    expect(cell(barcode, { text: '12345', type: 'upce' })).toEqual({ ok: true, value: '12345' });
    expect(keys(barcode)).toEqual(['changed:import.airtable.report.barcode']);
    const button = plan('button');
    expect(value(button).spec.type).toBe('url');
    expect(cell(button, { label: 'Open', url: 'https://example.com/x' })).toEqual({
      ok: true,
      value: 'https://example.com/x',
    });
    const generated = plan('aiText');
    expect(value(generated).spec.type).toBe('longText');
    expect(cell(generated, { state: 'generated', value: 'Hi', isStale: false })).toEqual({
      ok: true,
      value: 'Hi',
    });
    expect(keys(generated)).toEqual(['changed:import.airtable.report.generatedText']);
  });

  it('leaves out types it doesn’t know, saying which', () => {
    const unknown = plan('hologram');
    expect(unknown.kind).toBe('omitted');
    expect(unknown.notes).toEqual([
      { status: 'omitted', key: 'import.airtable.report.typeUnsupported', params: { type: 'hologram' } },
    ]);
  });

  it('keeps a primary field Riosoma can’t name records with as text', () => {
    const primary = plan('rating', { max: 5 }, true);
    expect(value(primary).spec.type).toBe('text');
    expect(cell(primary, 4)).toEqual({ ok: true, value: '4' });
    expect(keys(primary)).toEqual(['changed:import.airtable.report.primaryText']);
    expect(value(plan('formula', { formula: '1' }, true)).spec.type).toBe('text');
    expect(value(plan('autoNumber', undefined, true)).spec.type).toBe('number');
  });
});

describe('helpers', () => {
  it('matches colors by hue', () => {
    expect(colorOf('redDark1')).toBe('red');
    expect(colorOf('cyanLight2')).toBe('teal');
    expect(colorOf(undefined)).toBe('gray');
  });

  it('knows currencies by symbol or code, and not by ambiguous symbols', () => {
    expect(currencyCode('$')).toBe('USD');
    expect(currencyCode('£')).toBe('GBP');
    expect(currencyCode('chf')).toBe('CHF');
    expect(currencyCode('kr')).toBeNull();
    expect(currencyCode(undefined)).toBe('USD');
  });

  it('reads any cell as text', () => {
    expect(textOf([{ filename: 'a.png' }, { email: 'b@example.com' }])).toBe('a.png, b@example.com');
    expect(textOf(true)).toBe('true');
    expect(textOf(Number.NaN)).toBeNull();
    expect(textOf([])).toBeNull();
  });
});

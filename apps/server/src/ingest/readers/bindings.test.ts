import { expect, it } from 'vitest';
import { cell, type ExtractedSource } from '@riosoma/ingest';
import { runReader } from './index.js';
import { valueSources } from '../build/provenance.js';

it('uses stable anonymous sheet identifiers in sandbox reads and emitted locations', async () => {
  const privateName = `private-${Math.random()}.csv`;
  const source: ExtractedSource = {
    kind: 'text',
    name: privateName,
    warnings: [],
    sheets: [{ name: privateName, hidden: false, rows: [[cell('source value')]] }],
  };
  const result = await runReader(
    source,
    `const sheet = (await source.sheets())[0]
const grid = await source.rows(sheet.name, 0, 1)
await emit([{values:{sheet:sheet.name,value:grid[0][0].v},at:{sheet:sheet.name,row:1},raw:{}}])`,
    {},
    {},
    { anonymousSheets: true },
  );
  expect(result).toMatchObject({
    status: 'read',
    rows: [{ values: { sheet: 'sheet-1', value: 'source value' }, at: { sheet: 'sheet-1', row: 1 } }],
  });
  expect(JSON.stringify(result)).not.toContain(privateName);
  expect(source.sheets![0]!.name).toBe(privateName);
});

it('executes saved source bindings instead of accepting a reader description of its values', async () => {
  const source: ExtractedSource = {
    kind: 'workbook',
    name: 'rows.xlsx',
    warnings: [],
    sheets: [
      {
        name: 'Rows',
        hidden: false,
        rows: [
          ['Alias', 'Code'],
          ['source value', 'A'],
        ].map((row) => row.map(cell)),
      },
    ],
    email: {
      from: 'sender@example.test',
      date: '2026-01-01',
      messageId: 'message',
      subject: 'Subject value',
      bodyText: '',
      tables: [],
    },
  };
  const code = `await emit([{values:{column:'claimed',fixed:'claimed',mapped:'claimed',subject:'claimed',person:'claimed'},at:{sheet:'Rows',row:2},raw:{}}])`;
  const bindings = {
    column: { kind: 'column' as const, aliases: ['Heading', 'Alias'] },
    fixed: { kind: 'fixed' as const, value: 'fixed value' },
    mapped: { kind: 'lookup' as const, aliases: ['Code'], entries: { A: 'lookup value' } },
    subject: { kind: 'emailSubject' as const },
    person: { kind: 'fact' as const, key: 'provided' },
  };
  const result = await runReader(source, code, {}, { provided: 'person value' }, { bindings });
  expect(result.status).toBe('read');
  if (result.status === 'read')
    expect(result.rows[0]!.values).toEqual({
      column: 'source value',
      fixed: 'fixed value',
      mapped: 'lookup value',
      subject: 'Subject value',
      person: 'person value',
    });
  const sources = valueSources(
    {
      reading: 'reader',
      rules: { code, toolkitVersion: 'version', bindings },
      name: '',
      state: 'draft',
      probationPassed: 0,
      signature: { id: 'signature', kind: 'workbook', headerGroups: [], markers: [] },
    },
    Object.keys(bindings),
  );
  expect(sources).toEqual(bindings);
});

it('rejects a nonscalar fact without keeping partial reader output', async () => {
  const result = await runReader(
    { kind: 'text', name: 'file.txt', warnings: [] },
    `await emit([{values:{value:'claimed'},at:{page:1},raw:{}}])`,
    {},
    { provided: ['not a cell'] },
    { bindings: { value: { kind: 'fact', key: 'provided' } } },
  );
  expect(result).toMatchObject({ status: 'failed', code: 'invalid-row' });
});

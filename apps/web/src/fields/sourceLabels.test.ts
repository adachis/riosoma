import { afterEach, expect, it, vi } from 'vitest';
import { FieldSpec, newId } from '@riosoma/contracts';
import { meta, prepareColumns, type Column } from '../screens/import/columns';
import { planUpsert } from '../screens/import/upsert';
import { importRecords } from '../screens/import/importRecords';

async function* rows(values: string[][]) {
  yield* values;
}
async function* numbered(values: string[][]) {
  for (const [index, cells] of values.entries()) yield { number: index + 1, cells };
}
afterEach(() => vi.unstubAllGlobals());

it('batches distinct source labels and retains misses through every import pass', async () => {
  const column: Column = {
    name: 'Source',
    include: true,
    dateOrder: 'mdy',
    field: meta(FieldSpec.parse({ type: 'singleSelect', options: { source: { tableId: newId('table') } } })),
  };
  const requests: string[][] = [];
  const selected = newId('choice');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.includes('/select-options?')) {
        const names = JSON.parse(new URLSearchParams(url.split('?')[1]).get('names')!) as string[];
        requests.push(names);
        return new Response(
          JSON.stringify({
            choices: names.includes('known') ? [{ id: selected, name: 'Known', color: 'gray' }] : [],
          }),
        );
      }
      const body = JSON.parse(String(options.body));
      return new Response(
        JSON.stringify({
          results: body.commands.map((command: { id: string }) => ({ id: command.id, status: 'applied' })),
        }),
      );
    }),
  );
  const values = [
    ['Source'],
    ['Known'],
    ...Array.from({ length: 120 }, (_, i) => [`Missing ${i}`]),
    ...Array.from({ length: 120 }, (_, i) => [`Missing ${i}`]),
  ];
  const prepared = await prepareColumns(rows(values), [column], true, true, 'UTC');
  expect(prepared.misfits).toEqual([240]);
  expect(requests.map((names) => names.length)).toEqual([50, 50, 21]);
  const plan = await planUpsert(numbered(values), true, {
    columns: prepared.columns,
    key: null,
    existing: null,
    timeZone: 'UTC',
    people: new Map(),
    createChoices: false,
  });
  expect(plan.creates[0]?.values[column.field.id]).toBe(selected);
  expect(plan.skipped).toHaveLength(240);
  await importRecords({
    databaseId: newId('database'),
    tableId: newId('table'),
    name: 'Import',
    viewName: 'Grid',
    columns: prepared.columns,
    primary: 0,
    header: true,
    timeZone: 'UTC',
    rows: rows(values),
    canceled: () => false,
    onProgress: vi.fn(),
  });
  expect(requests).toHaveLength(3);
});

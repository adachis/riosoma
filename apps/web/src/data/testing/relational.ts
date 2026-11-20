import { FieldSpec, newId, type FieldMeta } from '@riosoma/contracts';
import type { FakeServer } from './fake-server';

export function relationalFixture(server: FakeServer) {
  const source = server.createDatabase(3);
  const base = server.database(source.databaseId).schema;
  const tableId = newId('table');
  const viewId = newId('view');
  function field(name: string, spec: FieldSpec, table = source.tableId): FieldMeta {
    return { ...base.fields[0]!, id: newId('field'), tableId: table, name, ...spec };
  }
  const title = field('Title', FieldSpec.parse({ type: 'text' }), tableId);
  const price = field('Price', FieldSpec.parse({ type: 'number', options: { precision: 2 } }), tableId);
  const done = field('Done', FieldSpec.parse({ type: 'checkbox' }), tableId);
  const date = field('Date', FieldSpec.parse({ type: 'date' }), tableId);
  const inverseId = newId('field');
  const link = field(
    'Projects',
    FieldSpec.parse({ type: 'link', options: { linkedTableId: tableId, inverseFieldId: inverseId } }),
  );
  const inverse = {
    ...field(
      'Sources',
      FieldSpec.parse({ type: 'link', options: { linkedTableId: source.tableId, inverseFieldId: link.id } }),
      tableId,
    ),
    id: inverseId,
  };
  const lookup = field(
    'Prices',
    FieldSpec.parse({
      type: 'lookup',
      options: { linkFieldId: link.id, targetFieldId: price.id, resultType: 'number' },
    }),
  );
  const rollup = field(
    'Total',
    FieldSpec.parse({
      type: 'rollup',
      options: { linkFieldId: link.id, targetFieldId: price.id, fn: 'sum', precision: 2 },
    }),
  );
  const count = field('Project count', FieldSpec.parse({ type: 'count', options: { linkFieldId: link.id } }));
  const formula = field(
    'Double',
    FieldSpec.parse({
      type: 'formula',
      options: { expression: `{${source.numberFieldId}} * 2`, resultType: 'number' },
    }),
  );
  const database = server.seed(
    {
      ...base,
      tables: [
        ...base.tables,
        { ...base.tables[0]!, id: tableId, name: 'Projects', primaryFieldId: title.id, position: 1 },
      ],
      views: [...base.views, { ...base.views[0]!, id: viewId, tableId }],
      fields: [...base.fields, title, price, done, date, link, inverse, lookup, rollup, count, formula],
    },
    new Map([
      [
        source.tableId,
        {
          count: 3,
          values: (index: number) => ({
            [source.textFieldId]: `Record ${index + 1}`,
            [source.numberFieldId]: index + 1,
          }),
        },
      ],
      [
        tableId,
        {
          count: 3,
          values: (index: number) => ({
            [title.id]: ['Alpha', 'Beta', 'Gamma'][index]!,
            [price.id]: index + 1,
          }),
        },
      ],
    ]),
  );
  const recordIds = Array.from({ length: 3 }, (_, index) => database.rows(tableId).id(index));
  const row = database.rows(source.tableId).get(source.recordId(0))!;
  database.rows(source.tableId).set({
    ...row,
    values: {
      ...row.values,
      [link.id]: recordIds.slice(0, 2),
      [lookup.id]: [1, 2],
      [rollup.id]: 3,
      [count.id]: 2,
    },
  });
  return {
    source,
    tableId,
    viewId,
    recordIds,
    title,
    price,
    done,
    date,
    link,
    inverse,
    lookup,
    rollup,
    count,
    formula,
    database,
  };
}

export async function settle() {
  for (let index = 0; index < 50; index++) await Promise.resolve();
}

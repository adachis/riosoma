import { addDecimals, date, identifier, multiplyDecimals, number, text } from './cleaners.js';
import type { Scalar } from './cleaners.js';
import { parseLayout } from './layout.js';
import type { Layout } from './layout.js';
import { cell } from './source.js';
import type { ExtractedSource, IngestRow, RowLocation, SourceSheet } from './source.js';
import type { Signature } from './signatures.js';
import {
  between,
  cellText,
  fillDown,
  findHeaderRow,
  findLabelValueBlocks,
  isTotalRow,
  lineTable,
  normalizeMarker,
  pageLines,
  pivot,
  splitText,
  tableByName,
  unpivot,
} from './tables.js';

export type ArchetypeId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
export interface GeneratorOptions {
  seed?: number;
  size: number;
}
export interface CorpusExample {
  id: ArchetypeId;
  source: ExtractedSource;
  expected: IngestRow[];
  signature: Signature;
  layout?: Layout;
}
const MARKERS = [
  'Cedar Comet orders',
  'Pebble Loom departments',
  'Amber Kite periods',
  'Willow Lantern dispatch',
  'Juniper Arc directory',
  'Copper Finch terms',
  'Silver Fern periods',
  'Marble Wren measures',
  'Pine Orbit ledger',
  'Coral Birch blocks',
  'Velvet Grove letter',
  'Maple Harbor instructions',
  'Indigo Spruce message',
  'Golden Moss scans',
  'Opal Meadow collection',
];
const PRODUCTS = ['Orbit Sprocket', 'Comet Ribbon', 'Lantern Disk', 'Cove Spindle'];
const SENDERS = ['Willow Lantern Supply', 'Birch Harbor Goods', 'Cedar Pebble Trading'];
const ENTITIES = ['Mira Vale', 'Tomas Reed'];
const PERIODS = ['2026-03-01', '2026-04-01', '2026-05-01'];
interface Fact {
  id: string;
  product: string;
  amount: string;
  units: string;
}

function facts(options: GeneratorOptions): Fact[] {
  if (!Number.isSafeInteger(options.size) || options.size < 1 || options.size > 10000)
    throw new RangeError('ingest.corpus.invalidSize');
  if (options.seed !== undefined && !Number.isSafeInteger(options.seed))
    throw new RangeError('ingest.corpus.invalidSeed');
  let state = (options.seed ?? 19) >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return Array.from({ length: options.size }, (_, index) => {
    const cents = (next() % 90000) + 100;
    return {
      id: String(index + 1).padStart(5, '0'),
      product: PRODUCTS[next() % PRODUCTS.length]!,
      amount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`,
      units: String((next() % 20) + 1),
    };
  });
}
function sheet(name: string, rows: Scalar[][]): SourceSheet {
  return { name, hidden: false, rows: rows.map((row) => row.map(cell)) };
}
function workbook(name: string, sheets: SourceSheet[]): ExtractedSource {
  return { kind: 'workbook', name, sheets, warnings: [] };
}
function row(values: Record<string, unknown>, at: RowLocation = {}): IngestRow {
  return { values, at, raw: {} };
}
function amount(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const tail = fraction.replace(/0+$/u, '');
  return tail ? `${whole}.${tail}` : whole;
}
function total(items: Fact[]): string {
  return items.reduce((sum, item) => addDecimals(sum, amount(item.amount)), '0');
}
const idColumn = { aliases: ['ID'], cleaners: [{ kind: 'identifier' as const }] };
const productColumn = { aliases: ['Product', 'Item'], cleaners: [{ kind: 'text' as const }] };
const amountColumn = {
  aliases: ['Amount'],
  cleaners: [{ kind: 'number' as const, decimalMark: '.' as const }],
};
export const REFERENCE_LAYOUTS: Readonly<Record<1 | 2 | 3 | 4, Layout>> = {
  1: {
    header: { markers: ['ID', 'Amount'], searchRows: 12 },
    columns: {
      id: idColumn,
      product: productColumn,
      amount: amountColumn,
      date: { aliases: ['Date'], cleaners: [{ kind: 'date', formats: ['MM/DD/YYYY'] }] },
    },
    skip: [{ field: 'id', blank: true }],
  },
  2: {
    header: { markers: ['Department', 'Product', 'Amount'], searchRows: 12 },
    columns: {
      department: { aliases: ['Department'], cleaners: [{ kind: 'text' }] },
      product: productColumn,
      amount: amountColumn,
    },
    fillDown: ['department'],
    skip: [
      { field: 'department', wildcard: 'Subtotal*' },
      { field: 'department', equals: 'Grand total' },
    ],
    checks: [{ field: 'amount', label: 'Grand total', cleaner: { decimalMark: '.' } }],
  },
  3: {
    header: { markers: ['ID', 'Period', 'Amount'], searchRows: 12 },
    columns: {
      id: idColumn,
      product: productColumn,
      period: { aliases: ['Period'], cleaners: [{ kind: 'date' }] },
      amount: amountColumn,
    },
    skip: [
      { field: 'id', equals: 'Period total' },
      { field: 'id', equals: 'Order count' },
    ],
    checks: [{ field: 'amount', label: 'Period total', cleaner: { decimalMark: '.' } }],
  },
  4: {
    header: { markers: ['ID', 'Amount'], searchRows: 12 },
    columns: {
      id: idColumn,
      product: productColumn,
      amount: amountColumn,
      sender: {
        aliases: ['Sender', 'Origin'],
        cleaners: [
          { kind: 'lookup', entries: { [SENDERS[0]!]: 'WL', [SENDERS[1]!]: 'BH', [SENDERS[2]!]: 'CP' } },
        ],
      },
    },
    constants: { currency: 'USD' },
  },
};

export function generateArchetype(id: ArchetypeId, options: GeneratorOptions): CorpusExample {
  const items = facts(options);
  const marker = MARKERS[id - 1];
  if (!marker) throw new RangeError('ingest.corpus.invalidArchetype');
  let source: ExtractedSource;
  let expected: IngestRow[];
  let headerGroups: string[][] = [];
  switch (id) {
    case 1: {
      const productHeader = (options.seed ?? 19) % 2 ? 'Item' : 'Product';
      source = workbook('cedar-orders.xlsx', [
        sheet('Orders', [
          [marker],
          ['Prepared by Elara Finch'],
          [],
          ['ID', productHeader, 'Amount', 'Date'],
          ...items.map((item, index): Scalar[] => [
            item.id,
            ` ${item.product} `,
            item.amount,
            `03/${String((index % 28) + 1).padStart(2, '0')}/2026`,
          ]),
        ]),
      ]);
      expected = items.map((item, index) =>
        row(
          {
            id: item.id,
            product: item.product,
            amount: amount(item.amount),
            date: `2026-03-${String((index % 28) + 1).padStart(2, '0')}`,
          },
          { sheet: 'Orders', row: index + 5 },
        ),
      );
      headerGroups = [['ID'], ['Product', 'Item'], ['Amount'], ['Date']];
      break;
    }
    case 2: {
      const rows: Scalar[][] = [[marker], ['Department', 'Product', 'Amount']];
      expected = [];
      let subtotal = '0';
      items.forEach((item, index) => {
        const department = `Workshop ${Math.floor(index / 3) + 1}`;
        rows.push([index % 3 === 0 ? department : null, item.product, item.amount]);
        expected.push(
          row(
            { department, product: item.product, amount: amount(item.amount) },
            { sheet: 'Departments', row: rows.length },
          ),
        );
        subtotal = addDecimals(subtotal, amount(item.amount));
        if (index % 3 === 2 || index === items.length - 1) {
          rows.push([`Subtotal ${department}`, subtotal]);
          subtotal = '0';
        }
      });
      rows.push(['Grand total', total(items)]);
      source = workbook('pebble-departments.xlsx', [sheet('Departments', rows)]);
      headerGroups = [['Department'], ['Product'], ['Amount']];
      break;
    }
    case 3: {
      expected = [];
      const tabs = PERIODS.map((period) => {
        const rows: Scalar[][] = [
          [marker],
          ['ID', 'Product', 'Period', 'Amount'],
          ...items.map((item): Scalar[] => [item.id, item.product, period, item.amount]),
          [],
          ['Period total', total(items)],
          ['Order count', items.length],
        ];
        items.forEach((item, index) =>
          expected.push(
            row(
              { id: item.id, product: item.product, period, amount: amount(item.amount) },
              { sheet: period, row: index + 3 },
            ),
          ),
        );
        return sheet(period, rows);
      });
      source = workbook('amber-periods.xlsx', tabs);
      headerGroups = [['ID'], ['Product'], ['Period'], ['Amount']];
      break;
    }
    case 4: {
      const origin = (options.seed ?? 19) % 2 ? 'Origin' : 'Sender';
      source = workbook('willow-dispatch.xlsx', [
        sheet('Dispatch', [
          [marker],
          ['ID', 'Product', 'Amount', origin],
          ...items.map((item, index): Scalar[] => [
            item.id,
            item.product,
            item.amount,
            SENDERS[index % SENDERS.length]!,
          ]),
        ]),
      ]);
      expected = items.map((item, index) =>
        row(
          {
            id: item.id,
            product: item.product,
            amount: amount(item.amount),
            sender: ['WL', 'BH', 'CP'][index % 3],
            currency: 'USD',
          },
          { sheet: 'Dispatch', row: index + 3 },
        ),
      );
      headerGroups = [['ID'], ['Product'], ['Amount'], ['Sender', 'Origin']];
      break;
    }
    case 5: {
      const summary = sheet('Directory', [
        [marker],
        ['Data tab', 'Region'],
        ['Orders East', 'East Cove'],
        ['Orders West', 'West Peak'],
        [],
        ['Footnote currency', 'USD'],
        ['Footnote period', '2026-03-01'],
      ]);
      expected = [];
      const tabs = ['Orders East', 'Orders West'].map((name, tab) => {
        items.forEach((item, index) =>
          expected.push(
            row(
              {
                id: item.id,
                product: item.product,
                amount: amount(item.amount),
                region: tab === 0 ? 'East Cove' : 'West Peak',
                currency: 'USD',
                period: '2026-03-01',
              },
              { sheet: name, row: index + 2 },
            ),
          ),
        );
        return sheet(name, [
          ['ID', 'Product', 'Amount'],
          ...items.map((item): Scalar[] => [item.id, item.product, item.amount]),
        ]);
      });
      source = workbook('juniper-directory.xlsx', [summary, ...tabs]);
      headerGroups = [['Data tab'], ['Region']];
      break;
    }
    case 6: {
      source = workbook('copper-terms.xlsx', [
        sheet('Orders', [
          [marker],
          ['ID', 'Tier', 'Units'],
          ...items.map((item, index): Scalar[] => [item.id, index % 2 ? 'Cove' : 'Crest', item.units]),
        ]),
        sheet('Terms', [
          ['Tier', 'Rate'],
          ['Crest', '1.25'],
          ['Cove', '2.40'],
        ]),
      ]);
      expected = items.map((item, index) =>
        row(
          {
            id: item.id,
            tier: index % 2 ? 'Cove' : 'Crest',
            units: item.units,
            amount: multiplyDecimals(item.units, index % 2 ? '2.4' : '1.25'),
          },
          { sheet: 'Orders', row: index + 3 },
        ),
      );
      headerGroups = [['ID'], ['Tier'], ['Units']];
      break;
    }
    case 7: {
      source = workbook('silver-periods.xlsx', [
        sheet('Periods', [
          [marker],
          ['Product', PERIODS[0]!, PERIODS[1]!],
          ...items.map((item): Scalar[] => [item.product, item.amount, addDecimals(item.amount, '2')]),
        ]),
      ]);
      expected = items.flatMap((item, index) =>
        PERIODS.slice(0, 2).map((period, column) =>
          row(
            {
              product: item.product,
              period,
              amount: column ? addDecimals(item.amount, '2') : amount(item.amount),
            },
            { sheet: 'Periods', row: index + 3 },
          ),
        ),
      );
      headerGroups = [['Product'], [PERIODS[0]!], [PERIODS[1]!]];
      break;
    }
    case 8: {
      source = workbook('marble-measures.xlsx', [
        sheet('Pairs', [
          [marker],
          ['Product', ENTITIES[0]!, ENTITIES[0]!, ENTITIES[1]!, ENTITIES[1]!],
          [null, 'Quantity', 'Amount', 'Quantity', 'Amount'],
          ...items.map((item): Scalar[] => [
            item.product,
            item.units,
            item.amount,
            addDecimals(item.units, '1'),
            addDecimals(item.amount, '3'),
          ]),
        ]),
      ]);
      expected = items.flatMap((item, index) =>
        ENTITIES.map((entity, column) =>
          row(
            {
              product: item.product,
              entity,
              quantity: column ? addDecimals(item.units, '1') : item.units,
              amount: column ? addDecimals(item.amount, '3') : amount(item.amount),
            },
            { sheet: 'Pairs', row: index + 4 },
          ),
        ),
      );
      headerGroups = [['Product'], [ENTITIES[0]!], [ENTITIES[1]!]];
      break;
    }
    case 9: {
      source = workbook('pine-ledger.xlsx', [
        sheet('Measures', [
          [marker],
          ['ID', 'Product', 'Measure', 'Value'],
          ...items.flatMap((item): Scalar[][] => [
            [item.id, item.product, 'quantity', item.units],
            [null, null, 'amount', item.amount],
          ]),
        ]),
      ]);
      expected = items.map((item, index) =>
        row(
          { id: item.id, product: item.product, quantity: item.units, amount: amount(item.amount) },
          { sheet: 'Measures', row: index * 2 + 3 },
        ),
      );
      headerGroups = [['ID'], ['Measure'], ['Value']];
      break;
    }
    case 10: {
      source = workbook('coral-blocks.xlsx', [
        sheet('Blocks', [
          [marker],
          ...items.map((item): Scalar[] => ['Product:', item.product, 'Amount', item.amount, 'ID', item.id]),
        ]),
      ]);
      expected = items.map((item, index) =>
        row(
          { id: item.id, product: item.product, amount: amount(item.amount) },
          { sheet: 'Blocks', row: index + 2 },
        ),
      );
      headerGroups = [['Product'], ['Amount'], ['ID']];
      break;
    }
    case 11: {
      source = {
        kind: 'pdf',
        name: 'velvet-letter.pdf',
        warnings: [],
        pages: [
          {
            number: 1,
            textQuality: 'clean',
            text: [
              marker,
              'Dear Elara Finch,',
              'ID  Product  Amount',
              ...items.map((item) => `${item.id}  ${item.product}  ${item.amount}`),
              'With regards, Mira Vale',
            ].join('\n'),
          },
        ],
      };
      expected = items.map((item, index) =>
        row(
          { id: item.id, product: item.product, amount: amount(item.amount) },
          { page: 1, line: index + 4 },
        ),
      );
      break;
    }
    case 12: {
      source = workbook('maple-instructions.xlsx', [
        sheet('Instructions', [
          [marker],
          ['ID', 'Instruction'],
          ...items.map((item, index): Scalar[] => [
            item.id,
            `Hold ${item.amount} - Final [${index % 2 ? 'ZP' : 'XD'}]`,
          ]),
        ]),
      ]);
      expected = items.map((item, index) =>
        row(
          { id: item.id, hold: amount(item.amount), stage: 'Final', code: index % 2 ? 'ZP' : 'XD' },
          { sheet: 'Instructions', row: index + 3 },
        ),
      );
      headerGroups = [['ID'], ['Instruction']];
      break;
    }
    case 13: {
      const tabular = (options.seed ?? 19) % 2 === 0;
      source = {
        kind: 'email',
        name: 'indigo-message.eml',
        warnings: [],
        email: {
          from: 'dispatch@indigospruce.example',
          subject: 'Indigo Spruce orders',
          date: '2026-03-01T09:00:00Z',
          messageId: 'indigo-001',
          bodyText: tabular
            ? marker
            : [
                marker,
                ...items.map((item) => `Order ${item.id} contains ${item.product} at USD ${item.amount}.`),
              ].join('\n'),
          tables: tabular
            ? [[['ID', 'Product', 'Amount'], ...items.map((item) => [item.id, item.product, item.amount])]]
            : [],
        },
      };
      expected = items.map((item, index) =>
        row(
          { id: item.id, product: item.product, amount: amount(item.amount) },
          tabular ? { table: 1, row: index + 2 } : { line: index + 2 },
        ),
      );
      break;
    }
    case 14: {
      source = {
        kind: 'pdf',
        name: 'golden-scans.pdf',
        warnings: [],
        pages: items.map((_, index) => ({
          number: index + 1,
          textQuality: index % 2 ? 'garbled' : 'none',
          text: index % 2 ? '\uFFFD\u0000\uFFFD\u0001\uFFFD' : '',
        })),
        images: items.map((_, index) => ({ index, width: 1200, height: 1600 })),
      };
      expected = items.map((item, index) =>
        row({ id: item.id, product: item.product, amount: amount(item.amount) }, { page: index + 1 }),
      );
      break;
    }
    case 15: {
      const documents = ['order', 'expense', 'service'];
      source = {
        kind: 'pdf',
        name: 'opal-collection.pdf',
        warnings: [],
        pages: items.map((item, index) => ({
          number: index + 1,
          textQuality: 'clean',
          text: [
            index === 0 ? marker : '',
            documents[index % 3]!,
            index % 3 === 0
              ? `Order ${item.id}, ${item.product}, USD ${item.amount}`
              : index % 3 === 1
                ? `Mira Vale, travel reimbursement, USD ${item.amount}`
                : `Cove Spindle inspection, ${item.units} hours, complete`,
          ]
            .filter(Boolean)
            .join('\n'),
        })),
      };
      expected = items.map((item, index) =>
        row(
          index % 3 === 0
            ? { document: 'order', id: item.id, product: item.product, amount: amount(item.amount) }
            : index % 3 === 1
              ? { document: 'expense', person: 'Mira Vale', amount: amount(item.amount) }
              : { document: 'service', product: 'Cove Spindle', hours: item.units, complete: true },
          { page: index + 1 },
        ),
      );
      break;
    }
  }
  return {
    id,
    source,
    expected,
    signature: {
      id: `archetype-${id}`,
      kind: source.kind,
      headerGroups,
      markers: id === 14 ? [] : [marker],
      markerRows: 10,
    },
    ...(id <= 4 ? { layout: parseLayout(REFERENCE_LAYOUTS[id as 1 | 2 | 3 | 4]) } : {}),
  };
}

function requiredSheet(source: ExtractedSource, name: string): SourceSheet {
  const value = source.sheets?.find((item) => item.name === name);
  if (!value) throw new Error('ingest.reference.sheetMissing');
  return value;
}
function named(source: ExtractedSource, name: string, markers: string[]) {
  const value = requiredSheet(source, name);
  const header = findHeaderRow(value.rows, markers);
  if (header === null) throw new Error('ingest.reference.headerMissing');
  return { sheet: value, table: tableByName(value.rows, header) };
}
function statedFacts(source: ExtractedSource, name: string, labels: string[]): Record<string, Scalar> {
  return Object.fromEntries(
    findLabelValueBlocks(requiredSheet(source, name).rows, labels).map((block) => [
      normalizeMarker(block.label),
      block.value.v,
    ]),
  );
}

/** These readings compose pure helpers and only consult facts present in the source. */
export const REFERENCE_READINGS: Readonly<
  Record<5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13, (source: ExtractedSource) => IngestRow[]>
> = {
  5: (source) => {
    const { table } = named(source, 'Directory', ['Data tab', 'Region']);
    const footnotes = statedFacts(source, 'Directory', ['Footnote currency', 'Footnote period']);
    return table.rows
      .filter((cells) =>
        source.sheets?.some((sheet) => sheet.name === cellText(table.get(cells, 'Data tab'))),
      )
      .flatMap((cells) => {
        const name = cellText(table.get(cells, 'Data tab'));
        const data = named(source, name, ['ID', 'Product', 'Amount']).table;
        return data.rows.map((record, index) =>
          row(
            {
              id: identifier(data.get(record, 'ID')).value,
              product: text(data.get(record, 'Product')).value,
              amount: number(data.get(record, 'Amount'), { decimalMark: '.' }).value,
              region: text(table.get(cells, 'Region')).value,
              currency: text(footnotes['footnote currency']).value,
              period: date(footnotes['footnote period']).value,
            },
            { sheet: name, row: data.headerIndex + index + 2 },
          ),
        );
      });
  },
  6: (source) => {
    const terms = named(source, 'Terms', ['Tier', 'Rate']).table;
    const rates = new Map(
      terms.rows.map((cells) => [
        text(terms.get(cells, 'Tier')).value,
        number(terms.get(cells, 'Rate'), { decimalMark: '.' }).value!,
      ]),
    );
    const data = named(source, 'Orders', ['ID', 'Tier', 'Units']).table;
    return data.rows.map((cells, index) => {
      const tier = text(data.get(cells, 'Tier')).value;
      const units = number(data.get(cells, 'Units'), { decimalMark: '.' }).value!;
      const rate = rates.get(tier);
      if (rate === undefined) throw new Error('ingest.reference.termMissing');
      return row(
        { id: identifier(data.get(cells, 'ID')).value, tier, units, amount: multiplyDecimals(units, rate) },
        { sheet: 'Orders', row: data.headerIndex + index + 2 },
      );
    });
  },
  7: (source) => {
    const data = named(source, 'Periods', ['Product']).table;
    const columns = data.headers.slice(1).map((key) => ({ key, period: date(key).value! }));
    return data.rows.flatMap((cells, index) => {
      const values = Object.fromEntries(
        data.headers.map((key) => [
          key,
          key === 'Product'
            ? text(data.get(cells, key)).value
            : number(data.get(cells, key), { decimalMark: '.' }).value,
        ]),
      );
      return unpivot([values], {
        keys: ['Product'],
        columns,
        periodField: 'period',
        valueField: 'amount',
      }).map((value) =>
        row(
          { product: value.Product, period: value.period, amount: value.amount },
          { sheet: 'Periods', row: data.headerIndex + index + 2 },
        ),
      );
    });
  },
  8: (source) => {
    const data = named(source, 'Pairs', ['Product']).table;
    const entities = [...new Set(data.headers.slice(1))];
    return data.rows.slice(1).flatMap((cells, index) =>
      entities.map((entity) => {
        const measures = data.all(cells, entity);
        return row(
          {
            product: text(data.get(cells, 'Product')).value,
            entity,
            quantity: number(measures[0], { decimalMark: '.' }).value,
            amount: number(measures[1], { decimalMark: '.' }).value,
          },
          { sheet: 'Pairs', row: data.headerIndex + index + 3 },
        );
      }),
    );
  },
  9: (source) => {
    const data = named(source, 'Measures', ['ID', 'Product', 'Measure', 'Value']).table;
    const records = fillDown(
      data.rows.map((cells) => ({
        id: identifier(data.get(cells, 'ID')).value,
        product: text(data.get(cells, 'Product')).value,
        measure: text(data.get(cells, 'Measure')).value,
        value: number(data.get(cells, 'Value'), { decimalMark: '.' }).value,
      })),
      ['id', 'product'],
    );
    const result = pivot(records, { keys: ['id', 'product'], measureField: 'measure', valueField: 'value' });
    if (result.conflicts.length) throw new Error('ingest.reference.duplicateMeasure');
    const firstRows = new Map<Scalar, number>();
    records.forEach((record, index) => {
      if (!firstRows.has(record.id)) firstRows.set(record.id, data.headerIndex + index + 2);
    });
    return result.rows.map((values) =>
      row(values, { sheet: 'Measures', row: firstRows.get(values.id ?? null) }),
    );
  },
  10: (source) => {
    const data = requiredSheet(source, 'Blocks');
    const blocks = findLabelValueBlocks(data.rows, ['ID', 'Product', 'Amount']);
    const groups = new Map<number, Record<string, (typeof blocks)[number]['value']>>();
    for (const block of blocks) {
      const values = groups.get(block.row) ?? {};
      values[normalizeMarker(block.label)] = block.value;
      groups.set(block.row, values);
    }
    return [...groups].map(([index, values]) => {
      return row(
        {
          id: identifier(values.id).value,
          product: text(values.product).value,
          amount: number(values.amount, { decimalMark: '.' }).value,
        },
        { sheet: 'Blocks', row: index + 1 },
      );
    });
  },
  11: (source) => {
    const lines = lineTable(pageLines(source), ['ID', 'Product', 'Amount']);
    if (!lines) throw new Error('ingest.reference.headerMissing');
    const data = tableByName(lines.rows, lines.headerIndex);
    return data.rows.flatMap((cells, index) => {
      if (cells.length !== 3 || isTotalRow(cells)) return [];
      return [
        row(
          {
            id: identifier(data.get(cells, 'ID')).value,
            product: text(data.get(cells, 'Product')).value,
            amount: number(data.get(cells, 'Amount'), { decimalMark: '.' }).value,
          },
          lines.locations[data.headerIndex + index + 1],
        ),
      ];
    });
  },
  12: (source) => {
    const data = named(source, 'Instructions', ['ID', 'Instruction']).table;
    return data.rows.map((cells, index) => {
      const instruction = cellText(data.get(cells, 'Instruction'));
      const tail = splitText(instruction, ' - ')[1] ?? '';
      return row(
        {
          id: identifier(data.get(cells, 'ID')).value,
          hold: number(between(instruction, 'Hold ', ' - '), { decimalMark: '.' }).value,
          stage: text(splitText(tail, '[')[0]).value,
          code: text(between(tail, '[', ']')).value,
        },
        { sheet: 'Instructions', row: data.headerIndex + index + 2 },
      );
    });
  },
  13: (source) => {
    if (!source.email) throw new Error('ingest.reference.emailMissing');
    if (source.email.tables.length)
      return source.email.tables.flatMap((table, tableIndex) => {
        const rows = table.map((cells) => cells.map(cell));
        const header = findHeaderRow(rows, ['ID', 'Product', 'Amount']);
        if (header === null) throw new Error('ingest.reference.headerMissing');
        const data = tableByName(rows, header);
        return data.rows.map((cells, index) =>
          row(
            {
              id: identifier(data.get(cells, 'ID')).value,
              product: text(data.get(cells, 'Product')).value,
              amount: number(data.get(cells, 'Amount'), { decimalMark: '.' }).value,
            },
            { table: tableIndex + 1, row: header + index + 2 },
          ),
        );
      });
    return splitText(source.email.bodyText, '\n').flatMap((line, index) => {
      if (!line.startsWith('Order ')) return [];
      return [
        row(
          {
            id: identifier(between(line, 'Order ', ' contains ')).value,
            product: text(between(line, ' contains ', ' at USD ')).value,
            amount: number(splitText(line, ' at USD ')[1]?.slice(0, -1), { decimalMark: '.' }).value,
          },
          { line: index + 1 },
        ),
      ];
    });
  },
};

export const ARCHETYPE_IDS: readonly ArchetypeId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
export interface Archetype {
  id: ArchetypeId;
  key: string;
  generate: (options: GeneratorOptions) => CorpusExample;
  layout?: Layout;
  read?: (source: ExtractedSource) => IngestRow[];
}
const ARCHETYPE_KEYS = [
  'delayedHeader',
  'mergedLabels',
  'periodTabs',
  'senderColumn',
  'summaryDirectory',
  'termsSheet',
  'widePeriods',
  'entityMeasures',
  'longMeasures',
  'labelBlocks',
  'letterLines',
  'cellGrammar',
  'emailBody',
  'unreadablePages',
  'mixedDocuments',
];
export const ARCHETYPES: readonly Archetype[] = ARCHETYPE_IDS.map((id) => ({
  id,
  key: `ingest.archetype.${ARCHETYPE_KEYS[id - 1]}`,
  generate: (options) => generateArchetype(id, options),
  ...(id <= 4 ? { layout: parseLayout(REFERENCE_LAYOUTS[id as 1 | 2 | 3 | 4]) } : {}),
  ...(id >= 5 && id <= 13 ? { read: REFERENCE_READINGS[id as keyof typeof REFERENCE_READINGS] } : {}),
}));
export function generateCorpus(options: GeneratorOptions): CorpusExample[] {
  return ARCHETYPE_IDS.map((id) => generateArchetype(id, options));
}
export interface RowComparisonOptions {
  numberFields?: readonly string[];
  dateFields?: readonly string[];
}
export function rowsEqual(
  actual: readonly IngestRow[],
  expected: readonly IngestRow[],
  options: RowComparisonOptions = {},
): boolean {
  if (actual.length !== expected.length) return false;
  const normalize = (value: unknown, field: string): { value: unknown; certain: boolean } => {
    if ((options.numberFields ?? []).includes(field) || (options.dateFields ?? []).includes(field)) {
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      )
        return { value: null, certain: false };
      return (options.numberFields ?? []).includes(field)
        ? number(value as Scalar, { decimalMark: '.' })
        : date(value as Scalar);
    }
    return { value: typeof value === 'string' ? value.trim().normalize('NFC') : value, certain: true };
  };
  return actual.every((item, index) => {
    const wanted = expected[index]!.values;
    const fields = Object.keys(wanted);
    return (
      Object.keys(item.values).length === fields.length &&
      fields.every((field) => {
        if (!Object.hasOwn(item.values, field)) return false;
        const left = normalize(item.values[field], field);
        const right = normalize(wanted[field], field);
        return left.certain && right.certain && JSON.stringify(left.value) === JSON.stringify(right.value);
      })
    );
  });
}

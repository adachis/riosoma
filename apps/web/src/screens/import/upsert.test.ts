import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandBatch, FieldSpec, newId, type Command, type FieldMeta } from '@riosoma/contracts';
import type { ImportCell } from './cells';
import { meta, specFor, type Column } from './columns';
import { jsonBytes, MAX_REQUEST_BYTES } from './importRecords';
import { keyOf, planUpsert, summarize, usedChoices, writeImport, type PlanRequest } from './upsert';

afterEach(() => vi.unstubAllGlobals());

function column(name: string, spec: FieldSpec): Column {
  return { name, include: true, dateOrder: 'mdy', field: { ...meta(spec), name } };
}
async function* numbered(rows: ImportCell[][]) {
  for (const [index, cells] of rows.entries()) yield { number: index + 1, cells };
}
function request(patch: Partial<PlanRequest> & Pick<PlanRequest, 'columns'>): PlanRequest {
  return { key: null, existing: null, timeZone: 'UTC', people: new Map(), createChoices: true, ...patch };
}
function fieldsOf(columns: Column[]): Map<string, FieldMeta> {
  return new Map(columns.map((item) => [item.field.id, item.field]));
}

describe('keys', () => {
  it('compare as a person would read them', () => {
    const text = meta(specFor('text'));
    expect(keyOf(text, '  Ada   Lovelace ')).toBe(keyOf(text, 'ada lovelace'));
    expect(keyOf(text, '   ')).toBeNull();
    expect(keyOf(text, null)).toBeNull();
    const number = meta(specFor('number'));
    expect(keyOf(number, 12)).toBe('12');
    expect(keyOf(number, 12)).not.toBe(keyOf(number, 12.5));
    const day = meta(specFor('date'));
    expect(keyOf(day, '2026-03-04')).toBe('2026-03-04');
    const moment = meta(specFor('dateTime'));
    expect(keyOf(moment, '2026-03-04T10:30:00Z')).toBe(keyOf(moment, '2026-03-04T10:30:00.000Z'));
    const checkbox = meta(specFor('checkbox'));
    expect(keyOf(checkbox, true)).toBeNull();
  });
});

describe('defaults in an import', () => {
  it('keeps a blank cell blank for a field with a default, so only a column left out takes it', async () => {
    const name = column('Name', specFor('text'));
    const status = column(
      'Status',
      FieldSpec.parse({ type: 'text', options: { defaultValue: { kind: 'value', value: 'New' } } }),
    );
    const notes = column('Notes', specFor('text'));
    const plan = await planUpsert(
      numbered([
        ['Ada', '', ''],
        ['Bea', 'Done', 'Hi'],
      ]),
      false,
      request({ columns: [name, status, notes] }),
    );
    expect(plan.creates.map((create) => create.values)).toEqual([
      { [name.field.id]: 'Ada', [status.field.id]: null },
      { [name.field.id]: 'Bea', [status.field.id]: 'Done', [notes.field.id]: 'Hi' },
    ]);
    // A column left out of the import never reaches the record, so the server fills its default.
    const skipped = await planUpsert(
      numbered([['Cy', '']]),
      false,
      request({ columns: [name, { ...status, include: false }] }),
    );
    expect(skipped.creates.map((create) => create.values)).toEqual([{ [name.field.id]: 'Cy' }]);
  });
});

describe('planning an import into a table', () => {
  const name = column('Name', specFor('text'));
  const total = column('Total', specFor('number'));
  const rows: ImportCell[][] = [
    ['Name', 'Total'],
    ['Ada', 1],
    [' bea ', '2'],
    ['ADA', 3],
    ['Cy', 'lots'],
    ['', 5],
    ['Dee', 6],
  ];

  it('adds, matches, and skips each row, saying why', async () => {
    const plan = await planUpsert(
      numbered(rows),
      true,
      request({
        columns: [name, total],
        key: 0,
        existing: new Map([
          ['ada', ['recAda0000000001']],
          ['bea', ['recBea0000000001', 'recBea0000000002']],
        ]),
      }),
    );
    expect(plan.rows).toBe(6);
    expect(plan.creates).toEqual([
      { row: 7, label: 'Dee', values: { [name.field.id]: 'Dee', [total.field.id]: 6 } },
    ]);
    expect(plan.matches.map(({ row, recordIds }) => [row, recordIds])).toEqual([
      [2, ['recAda0000000001']],
      [3, ['recBea0000000001', 'recBea0000000002']],
    ]);
    expect(plan.skipped).toEqual([
      { row: 4, label: 'ADA', problems: [], repeats: 2 },
      { row: 5, label: 'Cy', problems: [{ column: 1, text: 'lots', reason: 'number' }] },
      { row: 6, label: '', problems: [], noKey: true },
    ]);
  });

  it('adds every row that converts when there’s no key', async () => {
    const plan = await planUpsert(numbered(rows), true, request({ columns: [name, total] }));
    expect(plan.creates.map((row) => row.row)).toEqual([2, 3, 4, 6, 7]);
    expect(plan.skipped.map((row) => row.row)).toEqual([5]);
    expect(plan.matches).toEqual([]);
  });

  it('leaves out rows with nothing in the columns being imported', async () => {
    const note = column('Note', specFor('text'));
    const input: ImportCell[][] = [
      ['Name', 'Total', 'Note'],
      ['Ada', 1, ''],
      ['', '', 'only a note'],
      [' ', null],
    ];
    const skippedNote = { ...note, include: false };
    const added = await planUpsert(numbered(input), true, request({ columns: [name, total, skippedNote] }));
    expect(added.creates.map((row) => row.row)).toEqual([2]);
    expect(added.rows).toBe(1);
    const keyed = await planUpsert(
      numbered(input),
      true,
      request({ columns: [name, total, skippedNote], key: 0, existing: new Map() }),
    );
    expect(keyed.skipped).toEqual([]);
  });

  it('names new options once each, the way pasting does, only for people who may add them', async () => {
    const status = column('Status', FieldSpec.parse({ type: 'singleSelect', options: { choices: [] } }));
    const input: ImportCell[][] = [['Status'], ['Open'], ['open'], ['Closed']];
    const plan = await planUpsert(numbered(input), true, request({ columns: [status] }));
    expect(plan.choices).toEqual([
      {
        fieldId: status.field.id,
        choices: [
          { id: expect.any(String), name: 'Open', color: 'red' },
          { id: expect.any(String), name: 'Closed', color: 'orange' },
        ],
      },
    ]);
    const [open, closed] = plan.choices[0]!.choices;
    expect(plan.creates.map((row) => row.values[status.field.id])).toEqual([open!.id, open!.id, closed!.id]);
    // The request's own field is left as it was.
    expect(status.field.type === 'singleSelect' && status.field.options.choices).toEqual([]);
    const refused = await planUpsert(
      numbered(input),
      true,
      request({ columns: [status], createChoices: false }),
    );
    expect(refused.skipped.map((row) => row.problems[0]?.reason)).toEqual(['choice', 'choice', 'choice']);
    expect(usedChoices(plan.choices, [{ values: { [status.field.id]: closed!.id } }])).toEqual([
      { fieldId: status.field.id, choices: [closed] },
    ]);
  });
});

describe('summarizing an import', () => {
  const name = column('Name', specFor('text'));
  const seen = column('Seen', specFor('dateTime'));
  const columns = [name, seen];
  const existing = new Map([
    ['ada', ['recAda0000000001']],
    ['bea', ['recBea0000000001']],
    ['cy', ['recCyy0000000001', 'recCyy0000000002']],
  ]);
  const rows: ImportCell[][] = [
    ['Name', 'Seen'],
    ['Ada', { date: '2026-03-04T10:30:00' }],
    ['Bea', { date: '2026-03-05T08:00:00' }],
    ['Cy', ''],
    ['Bea', { date: '2026-03-06T08:00:00' }],
  ];

  it('tells updates from records already up to date, leaving empty cells and the key alone', async () => {
    const plan = await planUpsert(numbered(rows), true, request({ columns, key: 0, existing }));
    const current = new Map([
      ['recAda0000000001', { [seen.field.id]: '2026-03-04T10:30:00Z' }],
      ['recBea0000000001', { [seen.field.id]: '2026-01-01T00:00:00.000Z' }],
      ['recCyy0000000001', { [seen.field.id]: '2026-01-01T00:00:00.000Z' }],
    ]);
    const summary = summarize(plan, current, fieldsOf(columns), name.field.id, 'first');
    expect(summary.updated.map((row) => [row.row, row.recordId, row.changed, row.values])).toEqual([
      [3, 'recBea0000000001', [seen.field.id], { [seen.field.id]: '2026-03-05T08:00:00.000Z' }],
    ]);
    // The same moment written two ways is the same, and an empty cell changes nothing.
    expect(summary.unchanged.map((row) => [row.row, row.recordId])).toEqual([
      [2, 'recAda0000000001'],
      [4, 'recCyy0000000001'],
    ]);
    expect(summary.repeated.map((row) => row.row)).toEqual([5]);
    expect(summary.ambiguous.map((row) => row.row)).toEqual([4]);
    expect(summary.blocked).toBe(false);
    expect(summarize(plan, current, fieldsOf(columns), name.field.id, 'stop').blocked).toBe(true);
  });
});

describe('writing an import', () => {
  function server(answer: (command: Command, index: number) => 'applied' | 'rejected' = () => 'applied') {
    const commands: Command[] = [];
    const sizes: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        sizes.push(new TextEncoder().encode(String(init.body)).byteLength);
        const batch = CommandBatch.parse(JSON.parse(String(init.body)));
        const results = batch.commands.map((command) => {
          commands.push(command);
          const status = answer(command, commands.length - 1);
          return status === 'applied'
            ? { id: command.id, status }
            : {
                id: command.id,
                status,
                error: { code: 'forbidden', messageKey: 'data.access.denied', userFault: true },
              };
        });
        return new Response(JSON.stringify({ results }));
      }),
    );
    return { commands, sizes };
  }
  const tableId = newId('table');
  const databaseId = newId('database');
  const fieldId = newId('field');
  function records(count: number, value: (index: number) => string = (index) => `Row ${index}`) {
    return Array.from({ length: count }, (_, index) => ({
      id: newId('record'),
      values: { [fieldId]: value(index) },
    }));
  }

  it('writes updates, then additions, in batches of at most 1,000 records, as one action', async () => {
    const { commands } = server();
    const progress = vi.fn();
    const applied = vi.fn();
    const result = await writeImport({
      databaseId,
      tableId,
      choices: [],
      field: () => undefined,
      updates: records(1_001),
      creates: records(2),
      canceled: () => false,
      onProgress: progress,
      onApplied: applied,
    });
    expect(
      commands.map((command) => [command.kind, 'records' in command ? command.records.length : 0]),
    ).toEqual([
      ['record.update', 1_000],
      ['record.update', 1],
      ['record.create', 2],
    ]);
    expect(new Set(commands.map((command) => command.groupId))).toEqual(new Set([result.groupId]));
    expect(result).toMatchObject({ added: 2, updated: 1_001, canceled: false });
    expect(progress).toHaveBeenLastCalledWith({ added: 2, updated: 1_001 });
    expect(applied).toHaveBeenCalledOnce();
  });

  it('keeps every request under the size limit', async () => {
    const { commands, sizes } = server();
    await writeImport({
      databaseId,
      tableId,
      choices: [],
      field: () => undefined,
      updates: [],
      creates: records(12, () => '雪'.repeat(300_000)),
      canceled: () => false,
      onProgress: vi.fn(),
      onApplied: vi.fn(),
    });
    expect(commands.length).toBeGreaterThan(1);
    expect(sizes.every((size) => size <= MAX_REQUEST_BYTES)).toBe(true);
    expect(jsonBytes(commands)).toBeGreaterThan(MAX_REQUEST_BYTES);
  });

  it('gives every create batch the viewer’s time zone for date defaults', async () => {
    const { commands } = server();
    await writeImport({
      databaseId,
      tableId,
      timeZone: 'Pacific/Kiritimati',
      choices: [],
      field: () => undefined,
      updates: records(1),
      creates: records(1_001),
      canceled: () => false,
      onProgress: vi.fn(),
      onApplied: vi.fn(),
    });
    const creates = commands.filter((command) => command.kind === 'record.create');
    expect(creates).toHaveLength(2);
    expect(creates.map((command) => command.timeZone)).toEqual(['Pacific/Kiritimati', 'Pacific/Kiritimati']);
    expect(commands[0]).toMatchObject({ kind: 'record.update' });
    expect(commands[0]).not.toHaveProperty('timeZone');
  });

  it('adds new options first, using one someone else just added under the same name', async () => {
    const { commands } = server();
    const open = { id: newId('choice'), name: 'Open', color: 'green' as const };
    const closed = { id: newId('choice'), name: 'Closed', color: 'red' as const };
    const theirs = { id: newId('choice'), name: 'closed', color: 'blue' as const };
    const later = { id: newId('choice'), name: 'Later', color: 'teal' as const };
    const field: FieldMeta = {
      ...meta(FieldSpec.parse({ type: 'singleSelect', options: { choices: [open, theirs] } })),
      id: fieldId,
    };
    await writeImport({
      databaseId,
      tableId,
      choices: [{ fieldId, choices: [closed, later] }],
      field: () => field,
      updates: [{ id: newId('record'), values: { [fieldId]: closed.id } }],
      creates: [{ id: newId('record'), values: { [fieldId]: later.id } }],
      canceled: () => false,
      onProgress: vi.fn(),
      onApplied: vi.fn(),
    });
    const [update, ...writes] = commands;
    expect(update).toMatchObject({
      kind: 'field.update',
      fieldId,
      options: { choices: [open, theirs, later] },
    });
    expect(
      writes.map((command) =>
        command.kind === 'record.update' || command.kind === 'record.create'
          ? command.records[0]!.values[fieldId]
          : null,
      ),
    ).toEqual([theirs.id, later.id]);
  });

  it('stops between batches, saying what it wrote', async () => {
    let canceled = false;
    const { commands } = server(() => {
      canceled = true;
      return 'applied';
    });
    const result = await writeImport({
      databaseId,
      tableId,
      choices: [],
      field: () => undefined,
      updates: [],
      creates: records(2_500),
      canceled: () => canceled,
      onProgress: vi.fn(),
      onApplied: vi.fn(),
    });
    expect(commands).toHaveLength(1);
    expect(result).toMatchObject({ added: 1_000, updated: 0, canceled: true });
  });

  it('stops at a rejected batch with the server’s reason', async () => {
    const { commands } = server((_, index) => (index === 1 ? 'rejected' : 'applied'));
    await expect(
      writeImport({
        databaseId,
        tableId,
        choices: [],
        field: () => undefined,
        updates: records(1_500),
        creates: records(10),
        canceled: () => false,
        onProgress: vi.fn(),
        onApplied: vi.fn(),
      }),
    ).rejects.toMatchObject({ info: { messageKey: 'data.access.denied' } });
    expect(commands).toHaveLength(2);
  });
});

it('reports required and bounded import cells by file row', async () => {
  const name = column('Name', FieldSpec.parse({ type: 'text', options: { validation: { required: {} } } }));
  const amount = column(
    'Amount',
    FieldSpec.parse({ type: 'number', options: { validation: { min: { value: 0 } } } }),
  );
  const plan = await planUpsert(
    numbered([
      ['', 1],
      ['Valid', -1],
      ['Valid', 2],
    ]),
    false,
    request({ columns: [name, amount] }),
  );
  expect(plan.skipped).toMatchObject([
    { row: 1, problems: [{ column: 0, messageKey: 'data.validation.required' }] },
    { row: 2, problems: [{ column: 1, messageKey: 'data.validation.min' }] },
  ]);
  expect(plan.creates.map((row) => row.row)).toEqual([3]);
});

it('resolves source labels outside the first page without creating fixed choices', async () => {
  const id = newId('choice');
  const selected = column(
    'Source',
    FieldSpec.parse({ type: 'singleSelect', options: { source: { tableId: newId('table') } } }),
  );
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ id, name: 'Later label', color: 'gray' }], truncated: false }),
        { status: 200 },
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  const plan = await planUpsert(numbered([['Later label']]), false, request({ columns: [selected] }));
  expect(plan.skipped).toEqual([]);
  expect(plan.creates[0]?.values[selected.field.id]).toBe(id);
  expect(plan.choices).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

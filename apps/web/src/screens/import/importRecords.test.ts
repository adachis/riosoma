import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandBatch, DatabaseCreate, newId, type Command } from '@riosoma/contracts';
import { meta, specFor, type Column } from './columns';
import { importRecords, jsonBytes, MAX_REQUEST_BYTES, type ImportOptions } from './importRecords';

async function* rows(count: number, value = 'value') {
  for (let i = 0; i < count; i++) yield [value];
}
function column(name = 'Name'): Column {
  return { name, include: true, dateOrder: 'mdy', field: meta(specFor('text')) };
}
function options(patch: Partial<ImportOptions> = {}): ImportOptions {
  return {
    databaseId: newId('database'),
    name: 'Data',
    viewName: 'Grid',
    columns: [column()],
    primary: 0,
    header: false,
    timeZone: 'UTC',
    rows: rows(1),
    canceled: () => false,
    onProgress: vi.fn(),
    ...patch,
  };
}
function server(answer?: (commands: Command[], index: number) => Promise<Response> | Response) {
  const batches: CommandBatch[] = [];
  const databases: DatabaseCreate[] = [];
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body));
    if (path === '/api/databases') {
      databases.push(DatabaseCreate.parse(body));
      return new Response(JSON.stringify({}));
    }
    const batch = CommandBatch.parse(body);
    batches.push(batch);
    return (
      answer?.(batch.commands, batches.length) ??
      new Response(JSON.stringify({ results: batch.commands.map((c) => ({ id: c.id, status: 'applied' })) }))
    );
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, batches, databases };
}
afterEach(() => vi.unstubAllGlobals());
describe('import commands', () => {
  it('leaves out blank rows and rows empty in the included columns', async () => {
    const { batches } = server();
    const columns = [column(), { ...column('Skipped'), include: false }];
    async function* input() {
      yield ['Name', 'Skipped'];
      yield ['Alpha', ''];
      yield [''];
      yield ['   ', 'Only skipped data'];
      yield ['Beta', ''];
    }
    const result = await importRecords(options({ columns, header: true, rows: input() }));
    expect(result.count).toBe(2);
    const records = batches
      .flatMap((batch) => batch.commands)
      .find((command) => command.kind === 'record.create')!.records;
    expect(records.map((record) => record.values)).toEqual([
      { [columns[0]!.field.id]: 'Alpha' },
      { [columns[0]!.field.id]: 'Beta' },
    ]);
  });
  it('preserves the import time zone across every record batch', async () => {
    const { batches } = server();
    await importRecords(
      options({ tableId: newId('table'), rows: rows(1_001), timeZone: 'Pacific/Kiritimati' }),
    );
    const commands = batches.flatMap((batch) => batch.commands);
    expect(commands).toHaveLength(2);
    expect(
      commands.filter((command) => command.kind === 'record.create').map((command) => command.timeZone),
    ).toEqual(['Pacific/Kiritimati', 'Pacific/Kiritimati']);
  });

  it('creates 50 initial fields, then additional fields, with the primary first and one group', async () => {
    const { batches } = server();
    const columns = Array.from({ length: 53 }, (_, i) => column(`Field ${i}`));
    columns[1]!.include = false;
    const result = await importRecords(options({ columns, primary: 52, rows: rows(2001) }));
    const commands = batches.flatMap((batch) => batch.commands);
    const table = commands[0];
    expect(table?.kind).toBe('table.create');
    if (table?.kind !== 'table.create') throw new Error();
    expect(table.table.fields).toHaveLength(50);
    expect(table.table.fields[0]!.id).toBe(columns[52]!.field.id);
    expect(commands.filter((c) => c.kind === 'field.create')).toHaveLength(2);
    expect(commands.filter((c) => c.kind === 'record.create').map((c) => c.records.length)).toEqual([
      1000, 1000, 1,
    ]);
    expect(new Set(commands.map((c) => c.groupId))).toEqual(new Set([result.groupId]));
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
    expect(result.count).toBe(2001);
  });
  it('packs multibyte JSON under 4 MB and sends one request at a time', async () => {
    let active = 0;
    let peak = 0;
    const { batches } = server(async (commands) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return new Response(
        JSON.stringify({ results: commands.map((c) => ({ id: c.id, status: 'applied' })) }),
      );
    });
    const large = column();
    large.field = meta(specFor('longText'));
    const result = await importRecords(
      options({ tableId: newId('table'), columns: [large], rows: rows(10, '雪'.repeat(300_000)) }),
    );
    expect(result.count).toBe(10);
    expect(peak).toBe(1);
    expect(batches).toHaveLength(3);
    expect(batches.every((batch) => jsonBytes(batch) <= MAX_REQUEST_BYTES)).toBe(true);
  });
  it('moves fields with large choice lists out of the initial request to honor the byte cap', async () => {
    const { batches } = server();
    const choices = Array.from({ length: 1000 }, (_, i) => ({
      id: newId('choice'),
      name: `${i} ${'x'.repeat(240)}`,
      color: 'gray' as const,
    }));
    const columns = [
      column(),
      ...Array.from({ length: 15 }, (_, i) => ({
        ...column(`Choices ${i}`),
        field: meta({ type: 'singleSelect', options: { choices } }),
      })),
    ];
    await importRecords(options({ columns, rows: rows(0) }));
    const commands = batches.flatMap((batch) => batch.commands);
    const initial = commands.find((command) => command.kind === 'table.create')!;
    expect(initial.table.fields.length).toBeLessThan(columns.length);
    expect(
      initial.table.fields.length + commands.filter((command) => command.kind === 'field.create').length,
    ).toBe(columns.length);
    expect(batches.every((batch) => jsonBytes(batch) <= MAX_REQUEST_BYTES)).toBe(true);
  });
  it('keeps choices on new fields and omits invalid and empty cell values', async () => {
    const { batches } = server();
    const choice = { id: newId('choice'), name: 'Ready', color: 'red' as const };
    const columns = [
      column(),
      { ...column('Status'), field: meta({ type: 'singleSelect', options: { choices: [choice] } }) },
      { ...column('Total'), field: meta(specFor('number')) },
    ];
    async function* input() {
      yield ['a', 'Ready', 'bad'];
      yield ['', 'Unknown', '0'];
    }
    const result = await importRecords(options({ columns, rows: input() }));
    const created = batches.flatMap((b) => b.commands).find((c) => c.kind === 'table.create');
    expect(created?.table.fields[1]?.options).toEqual({ choices: [choice] });
    const records = batches.flatMap((b) => b.commands).find((c) => c.kind === 'record.create')!.records;
    expect(records[0]!.values).toEqual({ [columns[0]!.field.id]: 'a', [columns[1]!.field.id]: choice.id });
    expect(records[1]!.values).toEqual({ [columns[2]!.field.id]: 0 });
    expect(result.empty).toBe(2);
  });
  it('cancels after the current request, retaining acknowledged progress', async () => {
    let cancel = false;
    const { batches } = server((commands) => {
      cancel = true;
      return new Response(
        JSON.stringify({ results: commands.map((c) => ({ id: c.id, status: 'applied' })) }),
      );
    });
    const progress = vi.fn();
    const result = await importRecords(
      options({ tableId: newId('table'), rows: rows(3000), canceled: () => cancel, onProgress: progress }),
    );
    expect(batches).toHaveLength(1);
    expect(result.count).toBe(1000);
    expect(result.canceled).toBe(true);
    expect(progress).toHaveBeenCalledWith(1000, 0);
  });
  it('stops immediately on rejected commands and preserves the server reason', async () => {
    const { batches } = server(
      (commands) =>
        new Response(
          JSON.stringify({
            results: commands.map((c) => ({
              id: c.id,
              status: 'rejected',
              error: { code: 'forbidden', messageKey: 'data.access.denied', userFault: true },
            })),
          }),
        ),
    );
    await expect(importRecords(options({ rows: rows(3000) }))).rejects.toMatchObject({
      info: { messageKey: 'data.access.denied' },
    });
    expect(batches).toHaveLength(1);
  });
  it('does not count an unacknowledged request or continue after a network failure', async () => {
    const progress = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError()));
    await expect(importRecords(options({ tableId: newId('table'), onProgress: progress }))).rejects.toThrow();
    expect(progress).not.toHaveBeenCalled();
  });
  it('creates a database with its first table, then writes the records to its ID', async () => {
    const { batches, databases, fetch } = server();
    const result = await importRecords(options({ databaseId: undefined, rows: rows(2) }));
    expect(databases).toHaveLength(1);
    expect(databases[0]!.id).toBe(result.databaseId);
    expect(databases[0]!.table.id).toBe(result.tableId);
    expect(databases[0]!.groupId).toBe(result.groupId);
    expect(
      batches.flatMap((batch) => batch.commands).every((command) => command.groupId === result.groupId),
    ).toBe(true);
    expect(batches.flatMap((batch) => batch.commands).map((c) => c.kind)).toEqual(['record.create']);
    expect(fetch.mock.calls[1]![0]).toBe(`/api/databases/${result.databaseId}/commands`);
  });
  it('skips the header and never creates schema for an existing table', async () => {
    const { batches } = server();
    const result = await importRecords(options({ tableId: newId('table'), header: true, rows: rows(3) }));
    expect(result.count).toBe(2);
    expect(batches[0]!.commands[0]!.kind).toBe('record.create');
  });
});

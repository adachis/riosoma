import { cellText, isBlankCell } from './cells';
import { sourceLabelRows } from '../../fields/sourceLabels';
import {
  CommandBatchResult,
  LIMITS,
  TableCreate,
  newId,
  type Command,
  type CommandBatch,
  type DatabaseCreate,
  type FieldCreate,
} from '@riosoma/contracts';
import { api, ApiError } from '../../api';
import { clientId } from '../../data/deps';
import type { ImportCell } from './cells';
import { readValue, type Column } from './columns';

export const MAX_REQUEST_BYTES = 4_000_000;
const encoder = new TextEncoder();
export const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

/**
 * Sends one command and waits for the server's answer.  A rejected command throws with the
 * server's reason, and nothing after it is sent.
 */
export async function sendCommand(databaseId: string, command: Command): Promise<void> {
  const batch: CommandBatch = { clientId: clientId(), commands: [command] };
  if (jsonBytes(batch) > MAX_REQUEST_BYTES) throw new Error('import.tooLarge');
  const response = CommandBatchResult.parse(
    await api(`/api/databases/${databaseId}/commands`, { body: batch }),
  );
  const answer = response.results.find((item) => item.id === command.id);
  if (!answer) throw new Error('import.unreadable');
  if (answer.status === 'rejected')
    throw new ApiError(
      400,
      answer.error ?? { code: 'internal', messageKey: 'errors.internal', userFault: false },
    );
}

export interface ImportOptions {
  databaseId?: string;
  tableId?: string;
  /** The table's name, and the database's too unless `databaseName` says otherwise */
  name: string;
  databaseName?: string;
  viewName: string;
  columns: Column[];
  primary: number;
  header: boolean;
  timeZone: string;
  rows: AsyncIterable<ImportCell[]>;
  /** Shares one action with other tables of the same import, so they undo together */
  groupId?: string;
  canceled: () => boolean;
  onProgress: (count: number, empty: number) => void;
  onApplied?: (result: ImportResult) => void;
}
export interface ImportResult {
  databaseId: string;
  tableId: string;
  groupId: string;
  count: number;
  empty: number;
  canceled: boolean;
}
export async function importRecords(options: ImportOptions): Promise<ImportResult> {
  const databaseId = options.databaseId ?? newId('database');
  const tableId = options.tableId ?? newId('table');
  const groupId = options.groupId ?? newId('action');
  const client = clientId();
  const result: ImportResult = { databaseId, tableId, groupId, count: 0, empty: 0, canceled: false };
  const base = () => ({ id: newId('command'), groupId });
  async function send(command: Command) {
    await sendCommand(databaseId, command);
    options.onApplied?.(result);
  }
  if (options.canceled()) return { ...result, canceled: true };
  if (!options.tableId) {
    const columns = options.columns
      .map((column, index) => ({ column, index }))
      .filter(({ column }) => column.include);
    columns.sort((a, b) => Number(b.index === options.primary) - Number(a.index === options.primary));
    const fields: FieldCreate[] = columns.map(({ column }) => ({
      ...column.field,
      name: column.name.trim(),
    }));
    if (fields.length > LIMITS.fieldsPerTable) throw new Error('data.field.tooMany');
    const table = TableCreate.parse({
      id: tableId,
      name: options.name,
      fields: fields.slice(0, LIMITS.initialFields),
      view: { id: newId('view'), name: options.viewName },
    });
    const create: Command = { ...base(), kind: 'table.create', table };
    const database: DatabaseCreate = {
      id: databaseId,
      groupId,
      name: options.databaseName ?? options.name,
      icon: null,
      color: null,
      table,
    };
    const initialBody = options.databaseId ? { clientId: client, commands: [create] } : database;
    // Large choice lists can reach the byte limit before the initial-field limit.
    while (table.fields.length > 1 && jsonBytes(initialBody) > MAX_REQUEST_BYTES) table.fields.pop();
    if (jsonBytes(initialBody) > MAX_REQUEST_BYTES) throw new Error('import.tooLarge');
    if (!options.databaseId) {
      await api('/api/databases', { body: database });
      options.onApplied?.(result);
    } else await send(create);
    for (const field of fields.slice(table.fields.length)) {
      if (options.canceled()) return { ...result, canceled: true };
      await send({ ...base(), kind: 'field.create', tableId, field });
    }
  }
  type RecordCommand = Extract<Command, { kind: 'record.create' }>;
  let command: RecordCommand = {
    ...base(),
    kind: 'record.create',
    tableId,
    records: [],
    timeZone: options.timeZone,
  };
  let bytes = jsonBytes({ clientId: client, commands: [command] });
  let empty = 0;
  async function flush() {
    if (!command.records.length || options.canceled()) return;
    await send(command);
    result.count += command.records.length;
    result.empty += empty;
    options.onProgress(result.count, result.empty);
    command = { ...base(), kind: 'record.create', tableId, records: [], timeZone: options.timeZone };
    bytes = jsonBytes({ clientId: client, commands: [command] });
    empty = 0;
  }
  let first = true;
  for await (const row of sourceLabelRows(
    options.rows,
    options.columns,
    (row, index) => cellText(row[index]),
    options.header,
  )) {
    if (options.canceled()) break;
    if (first) {
      first = false;
      if (options.header) continue;
    }
    if (options.columns.every((column, index) => !column.include || isBlankCell(row[index]))) continue;
    const record: RecordCommand['records'][number] = { id: newId('record'), values: {} };
    let rowEmpty = 0;
    for (let i = 0; i < options.columns.length; i++) {
      const column = options.columns[i]!;
      if (!column.include) continue;
      const parsed = readValue(column, row[i], options.timeZone);
      if (parsed.misfit) rowEmpty++;
      else if (parsed.value !== undefined) record.values[column.field.id] = parsed.value;
    }
    const size = jsonBytes(record);
    if (
      bytes + size + Number(command.records.length > 0) > MAX_REQUEST_BYTES ||
      command.records.length === LIMITS.recordsPerCommand
    )
      await flush();
    if (options.canceled()) break;
    if (bytes + size > MAX_REQUEST_BYTES) throw new Error('import.tooLarge');
    bytes += size + Number(command.records.length > 0);
    command.records.push(record);
    empty += rowEmpty;
  }
  await flush();
  return { ...result, canceled: options.canceled() };
}

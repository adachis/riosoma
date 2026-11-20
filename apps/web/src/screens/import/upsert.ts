import { sourceLabelRows } from '../../fields/sourceLabels';
import {
  CHOICE_COLORS,
  fieldDefault,
  ImportRecordsPage,
  LIMITS,
  newId,
  sameValue,
  validateFieldValue,
  type CellValue,
  type CellValues,
  type Choice,
  type Command,
  type FieldMeta,
} from '@riosoma/contracts';
import { api, ApiError } from '../../api';
import { cellText, isBlankCell, isErrorCell, type ImportCell } from './cells';
import { readValue, type Column, type MisfitReason, type People } from './columns';
import { jsonBytes, MAX_REQUEST_BYTES, sendCommand } from './importRecords';
import type { NumberedRow } from './source';

/**
 * Importing into a table that already has records.  Each row either adds a record or, when a key
 * field is chosen and a record has the same key, updates that record.  Everything is worked out
 * before anything is written: the plan reads every row the way pasting into the grid reads a cell,
 * and the summary compares the matches with the records as they are.
 */

const KEY_TYPES = new Set<FieldMeta['type']>([
  'text',
  'email',
  'url',
  'phone',
  'number',
  'currency',
  'percent',
  'date',
  'singleSelect',
]);

/** Fields whose values can tell one record from another. */
export function canBeKey(field: FieldMeta): boolean {
  return KEY_TYPES.has(field.type);
}

/**
 * A key as it's compared: text ignores case and spacing, numbers and dates compare as the values
 * they are, and an option as the option.  Null is no key at all.
 */
export function keyOf(field: FieldMeta, value: CellValue | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  switch (field.type) {
    case 'text':
    case 'email':
    case 'url':
    case 'phone':
      return typeof value === 'string'
        ? value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') || null
        : null;
    case 'number':
    case 'currency':
    case 'percent':
      return typeof value === 'number' ? String(value) : null;
    case 'date': {
      if (typeof value !== 'string') return null;
      if (!field.options.includeTime) return value;
      const time = Date.parse(value);
      return Number.isNaN(time) ? null : String(time);
    }
    case 'singleSelect':
      return typeof value === 'string' ? value : null;
    default:
      return null;
  }
}

/** Two values of a field, alike when a person would call them the same. */
export function sameCell(field: FieldMeta, a: CellValue | undefined, b: CellValue | undefined): boolean {
  if (field.type === 'date' && field.options.includeTime && typeof a === 'string' && typeof b === 'string')
    return Date.parse(a) === Date.parse(b);
  return sameValue(a ?? null, b ?? null);
}

export interface CellProblem {
  /** The file column */
  column: number;
  text: string;
  reason: MisfitReason | 'validation';
  messageKey?: string;
  message?: string;
}

export interface PlanRequest {
  /** Every file column.  The included ones map onto the table's fields. */
  columns: Column[];
  /** The column records are matched on, or null to add every row */
  key: number | null;
  /** The table's records by key, oldest first */
  existing: ReadonlyMap<string, readonly string[]> | null;
  timeZone: string;
  people: People;
  /** Names that aren't options yet become options, as pasting makes them, when the person may add them */
  createChoices: boolean;
}

export interface PlannedRow {
  /** The row's number in the file */
  row: number;
  /** What names the row: its key, or its first imported value */
  label: string;
  values: CellValues;
}

export interface MatchedRow extends PlannedRow {
  /** The records with the row's key, oldest first */
  recordIds: string[];
}

export interface SkippedRow {
  row: number;
  label: string;
  /** Cells that don't convert */
  problems: CellProblem[];
  /** The key cell is empty */
  noKey?: boolean;
  /** The row repeats the key of this earlier row */
  repeats?: number;
}

export interface UpsertPlan {
  /** Rows read, not counting the header or rows with nothing to import */
  rows: number;
  creates: PlannedRow[];
  matches: MatchedRow[];
  skipped: SkippedRow[];
  /** Options the rows name that the fields don't have yet */
  choices: Array<{ fieldId: string; choices: Choice[] }>;
}

const COLORS = CHOICE_COLORS.filter((color) => color !== 'gray');
const CHOICE_SPLIT = /[\n\r,]+/;
const LABEL_LENGTH = 80;
const choiceKey = (name: string) => name.trim().toLocaleLowerCase('en-US');

/** Adds the options a cell names to its field, the way pasting would before writing it. */
class ChoiceMaker {
  private known = new Map<string, Set<string>>();
  readonly added = new Map<string, Choice[]>();
  add(field: FieldMeta, cell: ImportCell | undefined): void {
    if (field.type !== 'singleSelect' && field.type !== 'multipleSelect') return;
    if (field.options.source || field.options.cascade || isBlankCell(cell) || isErrorCell(cell)) return;
    let known = this.known.get(field.id);
    if (!known) {
      known = new Set(field.options.choices.map((choice) => choiceKey(choice.name)));
      this.known.set(field.id, known);
    }
    const text = cellText(cell);
    for (const part of field.type === 'multipleSelect' ? text.split(CHOICE_SPLIT) : [text]) {
      const name = part.trim();
      const key = choiceKey(name);
      if (!name || name.length > LIMITS.nameLength || known.has(key)) continue;
      if (field.options.choices.length >= LIMITS.choicesPerField) continue;
      const choice: Choice = {
        id: newId('choice'),
        name,
        color: COLORS[field.options.choices.length % COLORS.length]!,
      };
      field.options.choices.push(choice);
      known.add(key);
      this.added.set(field.id, [...(this.added.get(field.id) ?? []), choice]);
    }
  }
}

/**
 * Reads every row into what it would do.  The plan doesn't depend on how repeated keys are
 * handled, so changing that choice doesn't mean reading the file again.
 */
export async function planUpsert(
  rows: AsyncIterable<NumberedRow>,
  header: boolean,
  request: PlanRequest,
): Promise<UpsertPlan> {
  const columns = structuredClone(request.columns);
  const mapped = columns.map((column, index) => ({ column, index })).filter(({ column }) => column.include);
  const choices = new ChoiceMaker();
  const plan: UpsertPlan = { rows: 0, creates: [], matches: [], skipped: [], choices: [] };
  const firstRows = new Map<string, number>();
  const keyColumn = request.key === null ? undefined : columns[request.key];
  let first = true;
  for await (const { number, cells } of sourceLabelRows(
    rows,
    columns,
    (row, index) => cellText(row.cells[index]),
    header,
  )) {
    if (first) {
      first = false;
      if (header) continue;
    }
    const values: CellValues = {};
    const problems: CellProblem[] = [];
    for (const { column, index } of mapped) {
      const cell = cells[index];
      if (request.createChoices) choices.add(column.field, cell);
      const read = readValue(column, cell, request.timeZone, request.people);
      if (read.misfit) problems.push({ column: index, text: cellText(cell), reason: read.reason ?? 'other' });
      else if (read.value !== undefined) {
        values[column.field.id] = read.value;
        const issue = validateFieldValue(column.field, read.value);
        if (issue) problems.push({ column: index, text: cellText(cell), reason: 'validation', ...issue });
      }
    }
    // A row with nothing in the columns being imported, such as a blank line, is left out.
    if (!problems.length && mapped.every(({ index }) => isBlankCell(cells[index]))) continue;
    plan.rows++;
    const labelCell = cells[request.key ?? mapped[0]?.index ?? 0];
    const label = isErrorCell(labelCell) ? '' : cellText(labelCell).trim().slice(0, LABEL_LENGTH);
    const matched =
      keyColumn && request.key !== null
        ? request.existing?.get(keyOf(keyColumn.field, values[keyColumn.field.id]) ?? '')
        : undefined;
    if (!matched?.length) {
      for (const { column, index } of mapped) {
        if (Object.hasOwn(values, column.field.id) || problems.some((problem) => problem.column === index))
          continue;
        // A blank cell in a column being imported keeps a new record's field empty, where a column
        // left out of the import gives it the field's default.
        if (fieldDefault(column.field)) values[column.field.id] = null;
        const issue = validateFieldValue(column.field, undefined);
        if (issue) problems.push({ column: index, text: '', reason: 'validation', ...issue });
      }
    }
    if (!keyColumn || request.key === null) {
      if (problems.length) plan.skipped.push({ row: number, label, problems });
      else plan.creates.push({ row: number, label, values });
      continue;
    }
    if (problems.some((problem) => problem.column === request.key)) {
      plan.skipped.push({ row: number, label, problems });
      continue;
    }
    const key = keyOf(keyColumn.field, values[keyColumn.field.id]);
    if (key === null) {
      plan.skipped.push({ row: number, label, problems, noKey: true });
      continue;
    }
    const earlier = firstRows.get(key);
    if (earlier !== undefined) {
      plan.skipped.push({ row: number, label, problems: [], repeats: earlier });
      continue;
    }
    firstRows.set(key, number);
    if (problems.length) {
      plan.skipped.push({ row: number, label, problems });
      continue;
    }
    const recordIds = request.existing?.get(key);
    if (recordIds?.length) plan.matches.push({ row: number, label, values, recordIds: [...recordIds] });
    else plan.creates.push({ row: number, label, values });
  }
  plan.choices = [...choices.added].map(([fieldId, added]) => ({ fieldId, choices: added }));
  return plan;
}

export type RepeatChoice = 'first' | 'stop';

export interface UpdatedRow extends PlannedRow {
  baseValues?: Record<string, string | null>;
  recordId: string;
  /** The fields whose values change */
  changed: string[];
}

export interface Summary {
  added: PlannedRow[];
  updated: UpdatedRow[];
  unchanged: Array<PlannedRow & { recordId: string }>;
  skipped: SkippedRow[];
  /** Rows repeating an earlier row's key */
  repeated: SkippedRow[];
  /** Rows whose key more than one record has */
  ambiguous: MatchedRow[];
  /** Keys repeat and the person chose to stop */
  blocked: boolean;
}

/**
 * What the import would do, given the matched records as they are now.  An empty cell leaves a
 * record's value alone, and the key, having matched, isn't written again.  When a key matches
 * several records the oldest one is updated.
 */
export function summarize(
  plan: UpsertPlan,
  current: ReadonlyMap<string, CellValues>,
  fields: ReadonlyMap<string, FieldMeta>,
  keyFieldId: string | null,
  repeat: RepeatChoice,
): Summary {
  const updated: UpdatedRow[] = [];
  const unchanged: Summary['unchanged'] = [];
  for (const match of plan.matches) {
    const recordId = match.recordIds[0]!;
    const before = current.get(recordId) ?? {};
    const changed = Object.keys(match.values).filter((fieldId) => {
      const field = fields.get(fieldId);
      return fieldId !== keyFieldId && field && !sameCell(field, before[fieldId], match.values[fieldId]);
    });
    if (!changed.length) unchanged.push({ ...match, recordId });
    else
      updated.push({
        ...match,
        recordId,
        changed,
        values: Object.fromEntries(changed.map((fieldId) => [fieldId, match.values[fieldId]!])),
        ...(changed.some((id) => fields.get(id)?.type === 'longText' || fields.get(id)?.type === 'json')
          ? {
              baseValues: Object.fromEntries(
                changed
                  .filter((id) => fields.get(id)?.type === 'longText' || fields.get(id)?.type === 'json')
                  .map((id) => [id, typeof before[id] === 'string' ? before[id] : null]),
              ),
            }
          : {}),
      });
  }
  const repeated = plan.skipped.filter((row) => row.repeats !== undefined);
  const ambiguous = plan.matches.filter((match) => match.recordIds.length > 1);
  return {
    added: plan.creates,
    updated,
    unchanged,
    skipped: plan.skipped,
    repeated,
    ambiguous,
    blocked: repeat === 'stop' && (repeated.length > 0 || ambiguous.length > 0),
  };
}

/** Every record's key, oldest record first, for matching rows against. */
export async function keyIndex(
  tableId: string,
  field: FieldMeta,
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  let after: string | undefined;
  do {
    const page = ImportRecordsPage.parse(
      await api(`/api/tables/${tableId}/import/records`, {
        body: { fieldIds: [field.id], ...(after ? { after } : {}) },
        signal,
      }),
    );
    for (const record of page.records) {
      const key = keyOf(field, record.values[field.id] as CellValue | undefined);
      if (key !== null) index.set(key, [...(index.get(key) ?? []), record.id]);
    }
    after = page.next ?? undefined;
  } while (after);
  return index;
}

/** Some fields of the records named, as they are now. */
export async function currentValues(
  tableId: string,
  recordIds: readonly string[],
  fieldIds: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, CellValues>> {
  const values = new Map<string, CellValues>();
  if (!fieldIds.length) return values;
  for (let start = 0; start < recordIds.length; start += LIMITS.recordsPerCommand) {
    const page = ImportRecordsPage.parse(
      await api(`/api/tables/${tableId}/import/records`, {
        body: { fieldIds, recordIds: recordIds.slice(start, start + LIMITS.recordsPerCommand) },
        signal,
      }),
    );
    for (const record of page.records) values.set(record.id, record.values as CellValues);
  }
  return values;
}

export interface WriteRequest {
  databaseId: string;
  tableId: string;
  timeZone?: string;
  /** New options the written values use */
  choices: UpsertPlan['choices'];
  /** A field as it is now, so options someone else just added stay */
  field: (fieldId: string) => FieldMeta | undefined;
  updates: Array<{ id: string; values: CellValues; baseValues?: Record<string, string | null> }>;
  creates: Array<{ id: string; values: CellValues }>;
  canceled: () => boolean;
  /** Records written so far */
  onProgress: (progress: { added: number; updated: number }) => void;
  /** The first command has been applied, so there's something to undo */
  onApplied: (groupId: string) => void;
}

export class ImportRefusal extends Error {
  constructor(
    readonly recordIds: string[],
    override readonly cause: ApiError,
  ) {
    super(cause.message);
  }
}

export interface WriteResult {
  groupId: string;
  added: number;
  updated: number;
  canceled: boolean;
}

/** Only the new options that the values being written use. */
export function usedChoices(
  choices: UpsertPlan['choices'],
  records: ReadonlyArray<{ values: CellValues }>,
): UpsertPlan['choices'] {
  const used = new Set<string>();
  for (const record of records)
    for (const value of Object.values(record.values)) {
      if (typeof value === 'string') used.add(value);
      else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') used.add(item);
    }
  return choices
    .map(({ fieldId, choices: added }) => ({
      fieldId,
      choices: added.filter((choice) => used.has(choice.id)),
    }))
    .filter(({ choices: added }) => added.length > 0);
}

/**
 * Writes the import as one action, a batch at a time: new options first, then updates, then new
 * records.  Stopping takes effect between batches, and whatever was written undoes together.
 */
export async function writeImport(request: WriteRequest): Promise<WriteResult> {
  const groupId = newId('action');
  const timeZone = request.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const result: WriteResult = { groupId, added: 0, updated: 0, canceled: false };
  let applied = false;
  const send = async (command: Command) => {
    await sendCommand(request.databaseId, command);
    if (!applied) request.onApplied(groupId);
    applied = true;
  };
  // An option someone else added under the same name since is used rather than added twice.
  const renamed = new Map<string, string>();
  for (const { fieldId, choices } of request.choices) {
    if (request.canceled()) return { ...result, canceled: true };
    const field = request.field(fieldId);
    if (field?.type !== 'singleSelect' && field?.type !== 'multipleSelect') continue;
    const existing = new Map(field.options.choices.map((choice) => [choiceKey(choice.name), choice.id]));
    const fresh = choices.filter((choice) => {
      const same = existing.get(choiceKey(choice.name));
      if (same) renamed.set(choice.id, same);
      return !same;
    });
    if (!fresh.length) continue;
    await send({
      id: newId('command'),
      groupId,
      kind: 'field.update',
      fieldId,
      options: { ...field.options, choices: [...field.options.choices, ...fresh] },
    });
  }
  const rename = (values: CellValues): CellValues => {
    if (!renamed.size) return values;
    return Object.fromEntries(
      Object.entries(values).map(([fieldId, value]) => [
        fieldId,
        typeof value === 'string'
          ? (renamed.get(value) ?? value)
          : Array.isArray(value)
            ? value.map((item) => (typeof item === 'string' ? (renamed.get(item) ?? item) : item))
            : value,
      ]),
    );
  };
  const total = request.updates.length + request.creates.length;
  writing: for (const kind of ['record.update', 'record.create'] as const) {
    const records: WriteRequest['updates'] = kind === 'record.update' ? request.updates : request.creates;
    // Date defaults follow the same time zone used to read the imported values.
    const context = kind === 'record.create' ? { timeZone } : {};
    let batch: WriteRequest['updates'] = [];
    // What the command around the records takes, before any of them.
    const envelope = jsonBytes({
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId, kind, tableId: request.tableId, records: [], ...context }],
    });
    let bytes = envelope;
    const flush = async () => {
      if (!batch.length || request.canceled()) return;
      try {
        await send({
          id: newId('command'),
          groupId,
          kind,
          tableId: request.tableId,
          records: batch,
          ...context,
        });
      } catch (error) {
        if (error instanceof ApiError && /^(data\.validation\.|data\.locks\.)/.test(error.info.messageKey))
          throw new ImportRefusal(
            batch.map((row) => row.id),
            error,
          );
        throw error;
      }
      if (kind === 'record.update') result.updated += batch.length;
      else result.added += batch.length;
      request.onProgress({ added: result.added, updated: result.updated });
      batch = [];
      bytes = envelope;
    };
    for (const record of records) {
      if (request.canceled()) break writing;
      const entry = {
        id: record.id,
        values: rename(record.values),
        ...(record.baseValues
          ? { baseValues: rename(record.baseValues) as Record<string, string | null> }
          : {}),
      };
      const size = jsonBytes(entry) + 1;
      if (batch.length === LIMITS.recordsPerCommand || (batch.length && bytes + size > MAX_REQUEST_BYTES))
        await flush();
      if (request.canceled()) break writing;
      batch.push(entry);
      bytes += size;
    }
    await flush();
  }
  result.canceled = result.added + result.updated < total;
  return result;
}

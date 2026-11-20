import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { riosomaRequest, type Query } from '../../shared/api';
import {
  FilterProblem,
  hasChoice,
  matchCondition,
  resolveFilter,
  sameValue,
  toMatchValue,
} from '../../shared/filters';
import {
  addressOf,
  listDatabases,
  listTables,
  readRecords,
  TableCache,
  TableMissing,
} from '../../shared/metadata';
import type { ApiRecord, FieldMeta, FilterGroup, RecordsPage, TableMeta } from '../../shared/types';
import { isWritable, recordToJson, toRiosoma, ValueProblem, type ValueContext } from '../../shared/values';

interface Options {
  fields?: string[];
  nestFields?: boolean;
  valuesAsText?: boolean;
  view?: string;
  sort?: { property?: Array<{ field: string; direction: 'asc' | 'desc' }> };
  typecast?: boolean;
  ignoreUnknownFields?: boolean;
  sendEmptyValues?: boolean;
}

interface Run {
  context: IExecuteFunctions;
  item: INodeExecutionData;
  itemIndex: number;
  cache: TableCache;
  values: ValueContext;
}

const RECORD_ID = /^rec[0-9A-Za-z]{14}$/;

/** A problem with what the node was given, rather than with Riosoma's answer. */
class InputProblem extends Error {
  constructor(
    message: string,
    readonly description?: string,
  ) {
    super(message);
    this.name = 'InputProblem';
  }
}

function fieldNamed(table: TableMeta, key: string): FieldMeta | undefined {
  return table.fields.find((field) => field.id === key) ?? table.fields.find((field) => field.name === key);
}

function recordIdOf(run: Run): string {
  const id = String(run.context.getNodeParameter('recordId', run.itemIndex, '')).trim();
  if (!RECORD_ID.test(id))
    throw new InputProblem(
      `"${id}" isn't a record ID`,
      'Record IDs are rec followed by 14 letters and digits.',
    );
  return id;
}

function readQuery(run: Run, options: Options): Query {
  return {
    fields: options.fields?.length ? options.fields : undefined,
    ...(options.valuesAsText ? { cellFormat: 'string', timeZone: run.context.getTimezone() } : {}),
  };
}

function toItems(run: Run, table: TableMeta, records: ApiRecord[], options: Options): IDataObject[] {
  return records.map(
    (record) => recordToJson(record, table.fields, run.values, options.nestFields === true) as IDataObject,
  );
}

/**
 * The fields a write sets, keyed by field ID and converted for Riosoma, from the item itself when
 * the mapper maps automatically, or from the values set in the node.
 */
function mappedFields(run: Run, table: TableMeta, options: Options) {
  const { context, itemIndex } = run;
  const auto = context.getNodeParameter('columns.mappingMode', itemIndex) === 'autoMapInputData';
  let source: Record<string, unknown>;
  if (auto) {
    source = { ...run.item.json };
    // Items from a Riosoma node with nested fields carry them under `fields`.
    const nested = source.fields;
    if (!fieldNamed(table, 'fields') && nested && typeof nested === 'object' && !Array.isArray(nested)) {
      delete source.fields;
      source = { ...source, ...(nested as Record<string, unknown>) };
    }
  } else {
    source = (context.getNodeParameter('columns.value', itemIndex, {}) ?? {}) as Record<string, unknown>;
  }
  const fields: Record<string, unknown> = {};
  const given = new Map<string, unknown>();
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!auto && !options.sendEmptyValues && (value === null || value === '')) continue;
    const field = fieldNamed(table, key);
    if (!field) {
      if ((auto && (key === 'id' || key === 'createdTime')) || options.ignoreUnknownFields) continue;
      unknown.push(key);
      continue;
    }
    // A record read earlier carries fields Riosoma fills in, which a write leaves alone.
    if (!isWritable(field)) continue;
    given.set(field.name, value);
    fields[field.id] = toRiosoma(field, value, run.values);
  }
  if (unknown.length)
    throw new InputProblem(
      `The table "${table.name}" has no field named ${unknown.map((name) => `"${name}"`).join(', ')}`,
      'Check the names against the table, or turn on Ignore Unknown Fields to leave these values out.',
    );
  return { fields, given };
}

async function writeRecord(
  run: Run,
  table: TableMeta,
  method: 'POST' | 'PATCH',
  record: { id?: string; fields: Record<string, unknown> },
  options: Options,
): Promise<IDataObject[]> {
  const body = await riosomaRequest<RecordsPage>(run.context, method, `/tables/${table.id}/records`, {
    query: { shape: 'airtable', fieldKey: 'name' },
    body: { records: [record], typecast: options.typecast === true, fieldKey: 'id' },
    itemIndex: run.itemIndex,
  });
  return toItems(run, table, body.records, options);
}

async function search(run: Run, table: TableMeta, options: Options): Promise<IDataObject[]> {
  const { context, itemIndex } = run;
  const filterBy = context.getNodeParameter('filterBy', itemIndex, 'none') as string;
  let filter: FilterGroup | undefined;
  if (filterBy === 'field') {
    const key = String(context.getNodeParameter('matchField', itemIndex, ''));
    const field = fieldNamed(table, key);
    if (!field) throw new InputProblem(`The table "${table.name}" has no field "${key}"`);
    const wanted = toMatchValue(field, context.getNodeParameter('matchValue', itemIndex, ''), run.values);
    // Riosoma refuses a filter that names an option the field doesn't have, and no record holds one.
    if (!hasChoice(field, wanted)) return [];
    filter = { conjunction: 'and', conditions: [matchCondition(field, wanted)] };
  } else if (filterBy === 'filter') {
    let raw = context.getNodeParameter('filter', itemIndex, '') as unknown;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw) as unknown;
      } catch {
        throw new NodeOperationError(context.getNode(), "The filter isn't valid JSON", {
          itemIndex,
          description: 'A filter is a JSON object with a conjunction and a list of conditions.',
        });
      }
    }
    filter = resolveFilter(raw, table.fields);
  }
  const sorts = (options.sort?.property ?? []).map((sort) => {
    const field = fieldNamed(table, sort.field);
    if (!field) throw new InputProblem(`The table "${table.name}" has no field "${sort.field}" to sort by`);
    return { fieldId: field.id, direction: sort.direction === 'desc' ? 'desc' : 'asc' };
  });
  const returnAll = context.getNodeParameter('returnAll', itemIndex, false) as boolean;
  const limit = returnAll ? null : (context.getNodeParameter('limit', itemIndex, 50) as number);
  const query: Query = {
    ...readQuery(run, options),
    view: options.view || undefined,
    sort: sorts.length ? JSON.stringify(sorts) : undefined,
    filter: filter ? JSON.stringify(filter) : undefined,
  };
  return toItems(run, table, await readRecords(context, table.id, query, limit, itemIndex), options);
}

async function upsert(run: Run, table: TableMeta, options: Options): Promise<IDataObject[]> {
  const matching = run.context.getNodeParameter('columns.matchingColumns', run.itemIndex, []) as string[];
  const name = matching[0];
  if (!name)
    throw new InputProblem(
      'Choose a field to match on',
      'Create or Update finds the record to update by one field.',
    );
  const field = fieldNamed(table, name);
  if (!field) throw new InputProblem(`The table "${table.name}" has no field "${name}" to match on`);
  const { fields, given } = mappedFields(run, table, options);
  if (!given.has(field.name))
    throw new InputProblem(
      `Set a value for "${field.name}", the field to match on`,
      'Create or Update looks for a record with that value.',
    );
  const wanted = toMatchValue(field, given.get(field.name), run.values);
  let matches: ApiRecord[] = [];
  if (hasChoice(field, wanted)) {
    const filter: FilterGroup = { conjunction: 'and', conditions: [matchCondition(field, wanted)] };
    const found = await readRecords(
      run.context,
      table.id,
      { filter: JSON.stringify(filter), fields: [field.id] },
      10,
      run.itemIndex,
    );
    // Checking each value again means a filter the server couldn't use never picks a record.
    matches = found.filter((record) => sameValue(field, record.fields[field.name], wanted));
  }
  if (matches.length > 1)
    throw new InputProblem(
      `${matches.length} records have ${JSON.stringify(wanted)} in "${field.name}", so it's unclear which to update`,
      'Match on a field whose values are unique, such as an ID from the other system.',
    );
  const [match] = matches;
  return match
    ? writeRecord(run, table, 'PATCH', { id: match.id, fields }, options)
    : writeRecord(run, table, 'POST', { fields }, options);
}

async function recordOperation(run: Run, operation: string): Promise<IDataObject[]> {
  const { context, itemIndex } = run;
  const databaseId = String(context.getNodeParameter('database', itemIndex, '', { extractValue: true }));
  const tableId = String(context.getNodeParameter('table', itemIndex, '', { extractValue: true }));
  const table = await run.cache.table(databaseId, tableId, itemIndex);
  const options = context.getNodeParameter('options', itemIndex, {}) as Options;
  switch (operation) {
    case 'get': {
      const id = recordIdOf(run);
      const body = await riosomaRequest<RecordsPage>(context, 'GET', `/tables/${table.id}/records/${id}`, {
        query: { ...readQuery(run, options), shape: 'airtable' },
        itemIndex,
      });
      return toItems(run, table, body.records, options);
    }
    case 'search':
      return search(run, table, options);
    case 'create':
      return writeRecord(run, table, 'POST', { fields: mappedFields(run, table, options).fields }, options);
    case 'update': {
      const id = recordIdOf(run);
      return writeRecord(
        run,
        table,
        'PATCH',
        { id, fields: mappedFields(run, table, options).fields },
        options,
      );
    }
    case 'upsert':
      return upsert(run, table, options);
    case 'delete': {
      const id = recordIdOf(run);
      await riosomaRequest<RecordsPage>(context, 'DELETE', `/tables/${table.id}/records`, {
        query: { records: [id], shape: 'airtable' },
        itemIndex,
      });
      return [{ id, deleted: true }];
    }
    default:
      throw new InputProblem(`The operation "${operation}" isn't supported`);
  }
}

async function runOne(run: Run, resource: string, operation: string): Promise<IDataObject[]> {
  if (resource === 'database')
    return (await listDatabases(run.context, run.itemIndex)) as unknown as IDataObject[];
  if (resource === 'table') {
    const databaseId = String(
      run.context.getNodeParameter('database', run.itemIndex, '', { extractValue: true }),
    );
    const tables = await listTables(run.context, databaseId, run.itemIndex);
    return tables.map((table) => ({
      id: table.id,
      databaseId: table.databaseId,
      name: table.name,
      primaryFieldId: table.primaryFieldId,
      fields: table.fields.map((field) => ({ id: field.id, name: field.name, type: field.type })),
      views: table.views.map((view) => ({ id: view.id, name: view.name, type: view.type })),
    }));
  }
  return recordOperation(run, operation);
}

/** An n8n error for anything a run throws, tied to the item it came from. */
function asNodeError(context: IExecuteFunctions, error: unknown, itemIndex: number) {
  if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
  if (error instanceof InputProblem)
    return new NodeOperationError(context.getNode(), error.message, {
      itemIndex,
      ...(error.description ? { description: error.description } : {}),
    });
  if (error instanceof ValueProblem)
    return new NodeOperationError(context.getNode(), error.message, {
      itemIndex,
      description: `The value for "${error.field}" can't be written to it.  Check the value, or turn on Typecast so Riosoma reads text for the field.`,
    });
  if (error instanceof FilterProblem)
    return new NodeOperationError(context.getNode(), error.message, {
      itemIndex,
      description:
        'Riosoma leaves out conditions it cannot use, which would widen the search, so the node checks them first.',
    });
  if (error instanceof TableMissing)
    return new NodeOperationError(context.getNode(), error.message, {
      itemIndex,
      description: 'Check the database and table, and that the token can reach them.',
    });
  return new NodeOperationError(context.getNode(), error as Error, { itemIndex });
}

export async function execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
  const items = this.getInputData();
  const resource = this.getNodeParameter('resource', 0) as string;
  const operation = this.getNodeParameter('operation', 0) as string;
  const cache = new TableCache(this);
  const values: ValueContext = { address: await addressOf(this), timeZone: this.getTimezone() };
  const output: INodeExecutionData[] = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const run: Run = { context: this, item: items[itemIndex]!, itemIndex, cache, values };
    try {
      for (const json of await runOne(run, resource, operation))
        output.push({ json, pairedItem: { item: itemIndex } });
    } catch (error) {
      const failure = asNodeError(this, error, itemIndex);
      if (!this.continueOnFail()) throw failure;
      output.push({
        json: {
          error: failure.message,
          ...(failure.description ? { description: failure.description } : {}),
        },
        pairedItem: { item: itemIndex },
      });
    }
  }
  return [output];
}

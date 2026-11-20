import {
  LIMITS,
  type CellValue,
  type DataverseConnection,
  type SourceColumn,
  type SourceObject,
  type SourceObjectRef,
  type SourceSelect,
} from '@riosoma/contracts';
import { sourceKey } from '../registry.js';
import { positive } from '../sql.js';
import {
  ConnectorError,
  type Connector,
  type ConnectorContext,
  type SourcePreviewRows,
  type SourceRow,
} from '../types.js';
import { column as sqlColumn } from '../values.js';
import { RowBatcher } from '../warehouses/values.js';
import {
  climb,
  distinctNames,
  MicrosoftCall,
  microsoftConfig,
  microsoftFailure,
  microsoftProblem,
  MICROSOFT_KEYS,
  nearestDay,
  type Answer,
  type MicrosoftOptions,
} from './client.js';

/**
 * Dataverse tables, the data behind Power Apps, read through an environment's Web API as an Entra
 * app that an admin added to the environment as an application user.  The environment offers its
 * tables people work with (never intersect tables or private ones), each by its logical name with
 * its display name as a label.  Columns are named as the table shows them and typed by their own
 * definitions: text, whole and decimal numbers, currency, yes or no, dates, and choices keep their
 * types, and lookups come across as the names of the rows they point at.  Every row's own ID is the
 * key.  What the app may read is what its security role grants, and nothing is ever written.
 */

export const DATAVERSE_KEYS = {
  environment: 'sources.dataverse.environment',
  notUser: 'sources.dataverse.notUser',
  denied: 'sources.dataverse.denied',
  noTables: 'sources.dataverse.noTables',
  lookupText: 'sources.dataverse.lookupText',
} as const;

/** The column each row's ID arrives in, which no table column can take from it. */
export const ROW_ID = 'Row ID';

export interface DataverseOptions extends MicrosoftOptions {
  /** Where an environment's Web API answers, given its address.  Tests point it at a stand-in. */
  apiUrlFor?: (environmentUrl: string) => string;
}

/** Rows one page holds, which Dataverse allows up to 5,000 of. */
const PAGE_ROWS = 1_000;
const FORMATTED = 'OData.Community.Display.V1.FormattedValue';
const HEADERS = {
  'odata-maxversion': '4.0',
  'odata-version': '4.0',
  prefer: `odata.include-annotations="${FORMATTED}",odata.maxpagesize=${PAGE_ROWS}`,
};
/** The most decimal places a number field shows. */
const MOST_DECIMALS = 8;
/** Declared lengths past this suggest long text, as they do for the SQL connectors. */
const LONG_TEXT = 1_000;

type Plan =
  | { kind: 'text'; long: boolean; format: 'email' | 'url' | 'phone' | null }
  | { kind: 'number'; precision: number | null }
  | { kind: 'checkbox' }
  | { kind: 'date'; includeTime: boolean; dayOnly: boolean }
  | { kind: 'choice'; multiple: boolean; labels: Map<number, string> }
  | { kind: 'lookup' }
  | { kind: 'id' }
  | { kind: 'omitted' };

/** A column as a table defines it, and where a row keeps its value. */
interface TableColumn {
  column: SourceColumn;
  /** The property a row's value is under, like `name` or `_parentaccountid_value` */
  property: string;
  plan: Plan;
}

interface TableInfo {
  logicalName: string;
  entitySet: string;
  primaryId: string;
  name: string;
}

type Metadata = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A label as Dataverse writes one, in the language the app's user reads. */
function labelOf(value: unknown): string | null {
  const label = record(record(value)?.UserLocalizedLabel)?.Label;
  return typeof label === 'string' && label.trim() ? label.trim() : null;
}

/** An enumeration's value, like a format name, which Dataverse writes as `{ Value: '…' }`. */
function valueName(value: unknown): string {
  const inner = record(value)?.Value;
  return typeof inner === 'string' ? inner : typeof value === 'string' ? value : '';
}

function precisionOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.max(0, Math.min(value, MOST_DECIMALS))
    : null;
}

/** A logical name as a Web API address writes it, which Dataverse keeps to letters, digits, and `_`. */
function logical(name: string): string {
  if (!/^[A-Za-z0-9_]{1,128}$/.test(name))
    throw new ConnectorError(MICROSOFT_KEYS.objectMissing, 'that isn’t a table’s logical name', {
      object: name,
    });
  return name;
}

/** How an attribute's values are read, from its type and what its own definition adds. */
function planOf(attribute: Metadata, detail: Metadata | undefined): Plan {
  const type = typeof attribute.AttributeType === 'string' ? attribute.AttributeType : '';
  const typeName = valueName(attribute.AttributeTypeName);
  switch (type) {
    case 'String': {
      const format = valueName(detail?.FormatName);
      const length = typeof detail?.MaxLength === 'number' ? detail.MaxLength : 0;
      if (format === 'Email') return { kind: 'text', long: false, format: 'email' };
      if (format === 'Url') return { kind: 'text', long: false, format: 'url' };
      if (format === 'Phone') return { kind: 'text', long: false, format: 'phone' };
      const long = ['TextArea', 'RichText', 'Json'].includes(format) || length > LONG_TEXT;
      return { kind: 'text', long, format: null };
    }
    case 'Memo':
      return { kind: 'text', long: true, format: null };
    case 'Integer':
    case 'BigInt':
      return { kind: 'number', precision: 0 };
    case 'Decimal':
    case 'Double':
      return { kind: 'number', precision: precisionOf(detail?.Precision) };
    case 'Money':
      return { kind: 'number', precision: precisionOf(detail?.Precision) ?? 2 };
    case 'Boolean':
      return { kind: 'checkbox' };
    case 'DateTime': {
      const dayOnly = valueName(detail?.Format) === 'DateOnly';
      return { kind: 'date', includeTime: !dayOnly, dayOnly };
    }
    case 'Picklist':
    case 'State':
    case 'Status':
      return { kind: 'choice', multiple: false, labels: optionsOf(detail) };
    case 'Virtual':
      return typeName === 'MultiSelectPicklistType'
        ? { kind: 'choice', multiple: true, labels: optionsOf(detail) }
        : { kind: 'omitted' };
    case 'Lookup':
    case 'Customer':
    case 'Owner':
      return { kind: 'lookup' };
    case 'Uniqueidentifier':
      return { kind: 'id' };
    default:
      // Party lists, images, files, and Dataverse's own bookkeeping hold nothing a field can.
      return { kind: 'omitted' };
  }
}

/** A choice column's labels by value, from its own option set or the global one it uses. */
function optionsOf(detail: Metadata | undefined): Map<number, string> {
  const labels = new Map<number, string>();
  for (const set of [record(detail?.OptionSet), record(detail?.GlobalOptionSet)]) {
    const options = Array.isArray(set?.Options) ? set.Options : [];
    for (const option of options) {
      const entry = record(option);
      const label = labelOf(entry?.Label);
      if (typeof entry?.Value === 'number' && label && !labels.has(entry.Value))
        labels.set(entry.Value, label.slice(0, LIMITS.nameLength));
    }
  }
  return labels;
}

function suggestionOf(name: string, plan: Plan): Pick<SourceColumn, 'suggested' | 'alternatives'> {
  switch (plan.kind) {
    case 'text':
      if (plan.format) return { suggested: { type: plan.format, options: {} }, alternatives: ['text'] };
      return plan.long
        ? { suggested: { type: 'longText', options: {} }, alternatives: ['text'] }
        : { suggested: { type: 'text', options: {} }, alternatives: ['longText', 'email', 'url', 'phone'] };
    case 'number':
      return {
        suggested: { type: 'number', options: { precision: plan.precision } },
        alternatives: ['text'],
      };
    case 'checkbox':
      return { suggested: { type: 'checkbox', options: {} }, alternatives: ['text'] };
    case 'date':
      return {
        suggested: { type: 'date', options: plan.includeTime ? { includeTime: true, timeZone: 'UTC' } : {} },
        alternatives: ['text'],
      };
    case 'choice': {
      const described = sqlColumn(
        {
          name,
          type: plan.multiple ? 'set' : 'enum',
          nullable: true,
          labels: [...new Set(plan.labels.values())].slice(0, LIMITS.choicesPerField),
        },
        'postgres',
      );
      return { suggested: described.suggested, alternatives: described.alternatives };
    }
    case 'lookup':
    case 'id':
      return { suggested: { type: 'text', options: {} }, alternatives: ['longText'] };
    case 'omitted':
      return { suggested: null, alternatives: [] };
  }
}

/** A row's value for a column, as the field type it's read as. */
function valueOf(entry: TableColumn, row: Record<string, unknown>, fieldType: string): CellValue {
  const raw = row[entry.property];
  const formatted = row[`${entry.property}@${FORMATTED}`];
  const plan = entry.plan;
  const text = (value: unknown): string | null =>
    value === null || value === undefined || value === '' ? null : String(value);
  switch (plan.kind) {
    case 'omitted':
      return null;
    case 'text':
    case 'id':
      return text(raw);
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
      return fieldType === 'number' ? raw : String(raw);
    }
    case 'checkbox':
      if (typeof raw !== 'boolean') return null;
      return fieldType === 'checkbox' ? raw : String(raw);
    case 'date': {
      if (typeof raw !== 'string' || !raw) return null;
      if (plan.includeTime) {
        const time = Date.parse(raw);
        return Number.isNaN(time) ? null : new Date(time).toISOString();
      }
      return nearestDay(raw);
    }
    case 'choice': {
      const names: string[] = [];
      if (plan.multiple) {
        // A multiple choice's value is its options' values, like `1,3`.
        for (const part of text(raw)?.split(',') ?? []) {
          const label = plan.labels.get(Number(part.trim()));
          if (label) names.push(label);
        }
        if (!names.length && typeof formatted === 'string')
          names.push(...formatted.split(/;\s*/).filter(Boolean));
      } else {
        const label =
          typeof formatted === 'string' && formatted
            ? formatted
            : typeof raw === 'number'
              ? plan.labels.get(raw)
              : null;
        if (label) names.push(label);
      }
      if (!names.length) return null;
      if (fieldType === 'multipleSelect') return [...new Set(names)];
      if (fieldType === 'singleSelect') return names[0]!;
      return names.join(', ');
    }
    case 'lookup':
      // The name of the row a lookup points at, or its ID when Dataverse gives no name.
      return typeof formatted === 'string' && formatted ? formatted : text(raw);
  }
}

export function createDataverseConnector(options: DataverseOptions = {}): Connector {
  const config = microsoftConfig(options);

  function settingsOf(ctx: ConnectorContext): DataverseConnection {
    if (ctx.connection.kind !== 'dataverse')
      throw new ConnectorError(
        MICROSOFT_KEYS.read,
        `the connection settings are for ${ctx.connection.kind}, not dataverse`,
      );
    return ctx.connection;
  }

  function apiOf(ctx: ConnectorContext): string {
    const environment = settingsOf(ctx).environmentUrl;
    return (options.apiUrlFor?.(environment) ?? environment).replace(/\/+$/, '');
  }

  function begin(ctx: ConnectorContext, ms: number): MicrosoftCall {
    const settings = settingsOf(ctx);
    return new MicrosoftCall(
      config,
      ctx,
      settings,
      settings.environmentUrl,
      ms,
      () => new ConnectorError(DATAVERSE_KEYS.environment),
    );
  }

  function url(ctx: ConnectorContext, path: string, query: Record<string, string> = {}): URL {
    const address = new URL(`${apiOf(ctx)}/api/data/v9.2/${path}`);
    for (const [name, value] of Object.entries(query)) address.searchParams.set(name, value);
    return address;
  }

  /** The error an answer outside 2xx stands for, about `what`. */
  function refusal(answer: Answer, what: string, missing: () => ConnectorError): ConnectorError {
    const problem = microsoftProblem(answer.body);
    const detail = `HTTP ${answer.status}${problem.code ? ` ${problem.code}` : ''}${problem.message ? `: ${problem.message}` : ''} (${what})`;
    // An app that isn't one of the environment's users is refused outright, and one whose role
    // doesn't reach a table is told which privilege it's missing.
    if (
      answer.status === 401 ||
      /not a member of the organization|0x80072560/i.test(`${problem.code} ${problem.message}`)
    )
      return new ConnectorError(DATAVERSE_KEYS.notUser, detail);
    if (answer.status === 403) return new ConnectorError(DATAVERSE_KEYS.denied, detail);
    if (answer.status === 404) {
      const error = missing();
      return new ConnectorError(error.messageKey, detail, error.params);
    }
    return new ConnectorError(MICROSOFT_KEYS.status, detail, { status: answer.status });
  }

  async function json(call: MicrosoftCall, address: URL, what: string, missing: () => ConnectorError) {
    const answer = await call.get(address, HEADERS);
    if (answer.status < 200 || answer.status >= 300) throw refusal(answer, what, missing);
    return call.json(answer);
  }

  /** The environment's tables people work with, by display name. */
  async function tablesOf(call: MicrosoftCall): Promise<Array<{ logicalName: string; name: string }>> {
    const tables: Array<{ logicalName: string; name: string }> = [];
    for await (const page of call.pages(
      url(call.ctx, 'EntityDefinitions', {
        $select:
          'LogicalName,EntitySetName,DisplayName,IsIntersect,IsPrivate,IsCustomEntity,IsValidForAdvancedFind',
        $filter: 'IsPrivate eq false',
      }),
      (answer) =>
        refusal(answer, 'the environment’s tables', () => new ConnectorError(DATAVERSE_KEYS.environment)),
      HEADERS,
    ))
      for (const entry of page) {
        if (typeof entry.LogicalName !== 'string' || typeof entry.EntitySetName !== 'string') continue;
        if (entry.IsIntersect === true || entry.IsPrivate === true) continue;
        if (entry.IsValidForAdvancedFind !== true && entry.IsCustomEntity !== true) continue;
        tables.push({
          logicalName: entry.LogicalName,
          name: labelOf(entry.DisplayName) ?? entry.LogicalName,
        });
      }
    return tables.sort((a, b) => a.name.localeCompare(b.name) || a.logicalName.localeCompare(b.logicalName));
  }

  /** What a table's type-specific definitions add: formats, precision, and choices' labels. */
  async function detailsOf(
    call: MicrosoftCall,
    table: string,
    types: ReadonlySet<string>,
  ): Promise<Map<string, Metadata>> {
    const casts: Array<[string, string, string?]> = [];
    if (types.has('String')) casts.push(['StringAttributeMetadata', 'LogicalName,MaxLength,FormatName']);
    if (types.has('Decimal')) casts.push(['DecimalAttributeMetadata', 'LogicalName,Precision']);
    if (types.has('Double')) casts.push(['DoubleAttributeMetadata', 'LogicalName,Precision']);
    if (types.has('Money')) casts.push(['MoneyAttributeMetadata', 'LogicalName,Precision']);
    if (types.has('DateTime'))
      casts.push(['DateTimeAttributeMetadata', 'LogicalName,Format,DateTimeBehavior']);
    const options = 'OptionSet($select=Options),GlobalOptionSet($select=Options)';
    if (types.has('Picklist')) casts.push(['PicklistAttributeMetadata', 'LogicalName', options]);
    if (types.has('State'))
      casts.push(['StateAttributeMetadata', 'LogicalName', 'OptionSet($select=Options)']);
    if (types.has('Status'))
      casts.push(['StatusAttributeMetadata', 'LogicalName', 'OptionSet($select=Options)']);
    if (types.has('Virtual')) casts.push(['MultiSelectPicklistAttributeMetadata', 'LogicalName', options]);
    const details = new Map<string, Metadata>();
    for (const [cast, select, expand] of casts) {
      const document = (await json(
        call,
        url(call.ctx, `EntityDefinitions(LogicalName='${table}')/Attributes/Microsoft.Dynamics.CRM.${cast}`, {
          $select: select,
          ...(expand ? { $expand: expand } : {}),
        }),
        table,
        () => new ConnectorError(MICROSOFT_KEYS.objectMissing, undefined, { object: table }),
      )) as { value?: unknown };
      for (const entry of Array.isArray(document.value) ? document.value : []) {
        const found = record(entry);
        if (typeof found?.LogicalName === 'string') details.set(found.LogicalName, found);
      }
    }
    return details;
  }

  /** A table's own definition and its columns, from the table a select names. */
  async function describeTable(
    call: MicrosoftCall,
    select: SourceSelect,
  ): Promise<{ table: TableInfo; columns: TableColumn[] }> {
    if (select.kind !== 'object')
      throw new ConnectorError(MICROSOFT_KEYS.noQueries, 'Dataverse sources read tables, not queries');
    const name = logical(select.object.name);
    const missing = () =>
      new ConnectorError(MICROSOFT_KEYS.objectMissing, 'the environment has no such table', { object: name });
    const definition = (await json(
      call,
      url(call.ctx, `EntityDefinitions(LogicalName='${name}')`, {
        $select: 'LogicalName,EntitySetName,PrimaryIdAttribute,DisplayName,IsPrivate,IsIntersect',
        $expand:
          'Attributes($select=LogicalName,AttributeType,AttributeTypeName,DisplayName,IsValidForRead,AttributeOf,ColumnNumber)',
      }),
      name,
      missing,
    )) as Metadata;
    if (
      typeof definition.EntitySetName !== 'string' ||
      typeof definition.PrimaryIdAttribute !== 'string' ||
      definition.IsPrivate === true ||
      definition.IsIntersect === true
    )
      throw missing();
    const table: TableInfo = {
      logicalName: name,
      entitySet: definition.EntitySetName,
      primaryId: definition.PrimaryIdAttribute,
      name: labelOf(definition.DisplayName) ?? name,
    };
    const attributes = (Array.isArray(definition.Attributes) ? definition.Attributes : [])
      .map(record)
      .filter(
        (attribute): attribute is Metadata =>
          attribute !== undefined &&
          typeof attribute.LogicalName === 'string' &&
          /^[A-Za-z0-9_]{1,128}$/.test(attribute.LogicalName) &&
          attribute.IsValidForRead !== false &&
          // Helper columns, like a lookup's name, belong to the column they help.
          (attribute.AttributeOf === null || attribute.AttributeOf === undefined) &&
          attribute.LogicalName !== table.primaryId,
      )
      .sort((a, b) => Number(a.ColumnNumber ?? 0) - Number(b.ColumnNumber ?? 0));
    const details = await detailsOf(
      call,
      name,
      new Set(attributes.map((attribute) => String(attribute.AttributeType))),
    );
    const names = distinctNames(
      attributes.map((attribute) => labelOf(attribute.DisplayName) ?? String(attribute.LogicalName)),
      [ROW_ID],
    );
    const columns = attributes.map((attribute, index): TableColumn => {
      const logicalName = String(attribute.LogicalName);
      const plan = planOf(attribute, details.get(logicalName));
      const shown = names[index]!;
      return {
        column: {
          name: shown,
          sourceType: String(attribute.AttributeType ?? 'unknown').slice(0, 255),
          nullable: true,
          ...suggestionOf(shown, plan),
          ...(plan.kind === 'lookup' ? { notes: [{ messageKey: DATAVERSE_KEYS.lookupText }] } : {}),
        },
        property: plan.kind === 'lookup' ? `_${logicalName}_value` : logicalName,
        plan,
      };
    });
    columns.push({
      column: {
        name: ROW_ID,
        sourceType: 'Uniqueidentifier',
        nullable: false,
        suggested: { type: 'text', options: {} },
        alternatives: [],
        role: 'recordId',
      },
      property: table.primaryId,
      plan: { kind: 'id' },
    });
    return { table, columns };
  }

  /**
   * Every row of a table, a page at a time, with the columns' properties.  Columns that hold
   * nothing a field can, like images, are never asked for, since some can't be selected at all.
   */
  function rowsOf(call: MicrosoftCall, table: TableInfo, columns: readonly TableColumn[]) {
    const properties = [
      ...new Set(columns.filter((entry) => entry.plan.kind !== 'omitted').map((entry) => entry.property)),
    ];
    return call.pages(
      url(call.ctx, table.entitySet, { $select: properties.join(',') }),
      (answer) =>
        refusal(
          answer,
          table.name,
          () =>
            new ConnectorError(MICROSOFT_KEYS.objectMissing, undefined, {
              object: table.logicalName,
            }),
        ),
      HEADERS,
    );
  }

  async function look(
    ctx: ConnectorContext,
    select: SourceSelect,
    limit: number | null,
  ): Promise<SourcePreviewRows> {
    let call: MicrosoftCall | undefined;
    try {
      const rows = limit === null ? 0 : positive(limit, 50);
      call = begin(ctx, positive(ctx.timeoutMs, 30000));
      const { table, columns } = await describeTable(call, select);
      const first: Array<Record<string, unknown>> = [];
      if (rows > 0)
        for await (const page of rowsOf(call, table, columns)) {
          first.push(...page);
          if (first.length >= rows) break;
        }
      return {
        columns: columns.map((entry) => entry.column),
        rows: first
          .slice(0, rows)
          .map((row) =>
            columns.map((entry) =>
              entry.column.suggested ? valueOf(entry, row, entry.column.suggested.type) : null,
            ),
          ),
        rowEstimate: null,
      };
    } catch (error) {
      throw microsoftFailure(error, ctx, config, call);
    }
  }

  return {
    kind: 'dataverse',
    test(ctx) {
      let tested: MicrosoftCall | undefined;
      return climb(ctx, config, new URL(apiOf(ctx)), (ms) => (tested = begin(ctx, ms)), [
        {
          step: 'entities',
          async run(within) {
            // WhoAmI answers for any user of the environment, so it proves the app is one.
            await within(() =>
              json(
                tested!,
                url(ctx, 'WhoAmI'),
                'WhoAmI',
                () => new ConnectorError(DATAVERSE_KEYS.environment),
              ),
            );
            const tables = await within(() => tablesOf(tested!));
            if (!tables.length)
              throw new ConnectorError(DATAVERSE_KEYS.noTables, 'the environment lists no tables');
          },
        },
      ]);
    },
    async listObjects(ctx): Promise<SourceObject[]> {
      let call: MicrosoftCall | undefined;
      try {
        call = begin(ctx, config.deadlineMs);
        return (await tablesOf(call)).map((table) => ({
          schema: null,
          name: table.logicalName,
          label: table.name,
          type: 'table' as const,
          rowEstimate: null,
        }));
      } catch (error) {
        throw microsoftFailure(error, ctx, config, call);
      }
    },
    async describe(ctx, select) {
      return (await look(ctx, select, null)).columns;
    },
    preview: (ctx, select, limit) => look(ctx, select, limit),
    async keyCandidates(ctx, object: SourceObjectRef) {
      // A row's ID never changes and never repeats, so it's the key every table has.
      await look(ctx, { kind: 'object', object }, null);
      return [[ROW_ID]];
    },
    async *read(ctx, select, readOptions) {
      let call: MicrosoftCall | undefined;
      try {
        const size = positive(readOptions.batchSize, 5000);
        call = begin(ctx, config.deadlineMs);
        const running = call;
        const { table, columns } = await describeTable(running, select);
        const byName = new Map(columns.map((entry) => [entry.column.name, entry]));
        // A column that has gone from the table fails the sync, rather than emptying its field.
        const columnOf = (name: string): TableColumn => {
          const entry = byName.get(name);
          if (!entry)
            throw new ConnectorError(
              MICROSOFT_KEYS.columnMissing,
              `${table.name} has no column named ${name}`,
              {
                column: name,
              },
            );
          return entry;
        };
        const wanted = readOptions.columns.map((name) => [name, columnOf(name)] as const);
        const keys = readOptions.keyColumns.map(columnOf);
        const reading = [...new Set([...wanted.map(([, entry]) => entry), ...keys])];
        const keyType = (entry: TableColumn) => entry.column.suggested?.type ?? 'text';
        const toRow = (row: Record<string, unknown>): SourceRow => ({
          key: sourceKey(keys.map((entry) => valueOf(entry, row, keyType(entry)))),
          values: Object.fromEntries(
            wanted.map(([name, entry]) => [
              name,
              valueOf(entry, row, readOptions.types[name] ?? keyType(entry)),
            ]),
          ),
        });
        const batcher = new RowBatcher<SourceRow>(size);
        for await (const page of rowsOf(running, table, reading))
          for (const batch of batcher.add(page.map(toRow))) {
            running.signal.throwIfAborted();
            yield batch;
          }
        const rest = batcher.flush();
        running.signal.throwIfAborted();
        if (rest) yield rest;
      } catch (error) {
        throw microsoftFailure(error, ctx, config, call);
      }
    },
  };
}

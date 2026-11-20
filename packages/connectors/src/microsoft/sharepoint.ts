import {
  LIMITS,
  type CellValue,
  type SharePointListConnection,
  type SourceColumn,
  type SourceObject,
  type SourceObjectRef,
  type SourceSelect,
} from '@riosoma/contracts';
import { htmlText, htmlToMarkdown } from '../feed/html.js';
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
  GRAPH_API_URL,
  MicrosoftCall,
  microsoftConfig,
  microsoftFailure,
  MICROSOFT_KEYS,
  nearestDay,
  type Answer,
  type MicrosoftOptions,
} from './client.js';
import { findSite, graphAddress, graphRefusal, type SiteInfo } from './graph.js';

/**
 * SharePoint lists, read through Microsoft Graph as an Entra app.  A source names its sites, and
 * offers each site's lists (never its document libraries or hidden lists), each by its ID with its
 * name as a label, so renaming a list keeps a synced table reading.  Columns are named as the list
 * shows them and typed by their own definitions: text, numbers, currency, yes or no, dates,
 * choices, and links keep their types, while people, lookups, and managed metadata come across as
 * the names they show.  Every item's own ID is the key.  Nothing is ever written to SharePoint.
 */

export const SHAREPOINT_KEYS = {
  site: 'sources.sharepoint.site',
  denied: 'sources.sharepoint.denied',
  noLists: 'sources.sharepoint.noLists',
  lookupText: 'sources.sharepoint.lookupText',
  peopleText: 'sources.sharepoint.peopleText',
  termText: 'sources.sharepoint.termText',
  computed: 'sources.sharepoint.computed',
} as const;

/** The column each item's ID arrives in, which no list column can take from it. */
export const ITEM_ID = 'Item ID';

export interface SharePointOptions extends MicrosoftOptions {
  /** Where Graph answers.  Tests point it at a stand-in. */
  graphUrl?: string;
}

/** Items one request asks for. */
const PAGE_ITEMS = 500;
/** Items of a linked list a preview reads for their names.  A sync reads them all. */
const PREVIEW_LINKED_ITEMS = 1_000;
/** The hidden list every site keeps its people in, which a person column's IDs point into. */
const PEOPLE_LIST = 'User Information List';
/** Read-only columns SharePoint keeps on every list that people still care about. */
const KEPT_READ_ONLY = new Set(['Created', 'Modified', 'Author', 'Editor']);
/** Columns SharePoint keeps for itself, which never become fields. */
const INTERNAL = new Set([
  'ID',
  'ContentType',
  'Attachments',
  'Edit',
  'LinkTitle',
  'LinkTitleNoMenu',
  'DocIcon',
  'ItemChildCount',
  'FolderChildCount',
  'AppAuthor',
  'AppEditor',
  'ComplianceAssetId',
  'SelectTitle',
]);

type Plan =
  | { kind: 'text'; long: boolean; rich: boolean }
  | { kind: 'number'; precision: number | null }
  | { kind: 'checkbox' }
  | { kind: 'date'; includeTime: boolean }
  | { kind: 'choice'; multiple: boolean; labels: string[] }
  | { kind: 'url' }
  | { kind: 'person' }
  | { kind: 'lookup'; listId: string; columnName: string }
  | { kind: 'term' }
  | { kind: 'omitted' };

/** A column as a list defines it, and how an item's value becomes a cell. */
interface ListColumn {
  column: SourceColumn;
  /** The list's own name for it, which items key their values by, or null for the item's ID */
  field: string | null;
  plan: Plan;
}

/** Names of people and linked items, by lookup ID, for the columns that point at them. */
interface Known {
  people: Map<string, string>;
  lookups: Map<string, Map<string, string>>;
}

interface ListInfo {
  id: string;
  name: string;
}

type Definition = Record<string, unknown> & { name?: unknown; displayName?: unknown };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const DECIMALS: Record<string, number | null> = {
  automatic: null,
  none: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

/** How a column's values are read, from the facet its definition carries. */
function planOf(definition: Definition): Plan {
  const text = record(definition.text);
  if (text) {
    const rich = text.textType === 'richText';
    return { kind: 'text', long: text.allowMultipleLines === true || rich, rich };
  }
  const number = record(definition.number);
  if (number) {
    const places = typeof number.decimalPlaces === 'string' ? DECIMALS[number.decimalPlaces] : undefined;
    return { kind: 'number', precision: places === undefined ? null : places };
  }
  if (record(definition.currency)) return { kind: 'number', precision: 2 };
  if (record(definition.boolean)) return { kind: 'checkbox' };
  const dateTime = record(definition.dateTime);
  if (dateTime) return { kind: 'date', includeTime: dateTime.format !== 'dateOnly' };
  const choice = record(definition.choice);
  if (choice) {
    const labels = (Array.isArray(choice.choices) ? choice.choices : [])
      .filter((label): label is string => typeof label === 'string' && label.trim() !== '')
      .map((label) => label.slice(0, LIMITS.nameLength));
    return {
      kind: 'choice',
      multiple: choice.displayAs === 'checkBoxes',
      labels: [...new Set(labels)].slice(0, LIMITS.choicesPerField),
    };
  }
  if (record(definition.hyperlinkOrPicture)) return { kind: 'url' };
  if (record(definition.personOrGroup)) return { kind: 'person' };
  const lookup = record(definition.lookup);
  if (lookup && typeof lookup.listId === 'string' && typeof lookup.columnName === 'string')
    return { kind: 'lookup', listId: lookup.listId, columnName: lookup.columnName };
  if (record(definition.term)) return { kind: 'term' };
  const calculated = record(definition.calculated);
  if (calculated)
    switch (calculated.outputType) {
      case 'number':
        return { kind: 'number', precision: null };
      case 'currency':
        return { kind: 'number', precision: 2 };
      case 'boolean':
        return { kind: 'checkbox' };
      case 'dateTime':
        return { kind: 'date', includeTime: calculated.format !== 'dateOnly' };
      default:
        return { kind: 'text', long: false, rich: false };
    }
  return { kind: 'omitted' };
}

function suggestionOf(name: string, plan: Plan): Pick<SourceColumn, 'suggested' | 'alternatives'> {
  switch (plan.kind) {
    case 'text':
      return plan.long
        ? {
            suggested: { type: 'longText', options: plan.rich ? { richText: true } : {} },
            alternatives: ['text'],
          }
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
      // A choice column picks from its own list, which is a select field, choices and all.
      const described = sqlColumn(
        { name, type: plan.multiple ? 'set' : 'enum', nullable: true, labels: plan.labels },
        'postgres',
      );
      return { suggested: described.suggested, alternatives: described.alternatives };
    }
    case 'url':
      return { suggested: { type: 'url', options: {} }, alternatives: ['text'] };
    case 'person':
    case 'lookup':
    case 'term':
      return { suggested: { type: 'text', options: {} }, alternatives: ['longText'] };
    case 'omitted':
      return { suggested: null, alternatives: [] };
  }
}

/** The type a definition names, for the source type people see beside a column. */
function sourceTypeOf(definition: Definition): string {
  for (const facet of [
    'text',
    'number',
    'currency',
    'boolean',
    'dateTime',
    'choice',
    'hyperlinkOrPicture',
    'personOrGroup',
    'lookup',
    'term',
    'calculated',
    'geolocation',
    'thumbnail',
    'contentApprovalStatus',
  ])
    if (record(definition[facet])) return facet;
  return 'unknown';
}

/** The columns a list offers: its own columns in its order, then the item's ID. */
function columnsOf(definitions: readonly Definition[], lists: ReadonlyMap<string, string>): ListColumn[] {
  const kept = definitions.filter((definition) => {
    const name = typeof definition.name === 'string' ? definition.name : '';
    if (!name || name.startsWith('_') || INTERNAL.has(name) || definition.hidden === true) return false;
    // Computed columns are read-only, and still worth keeping.
    return (
      definition.readOnly !== true || KEPT_READ_ONLY.has(name) || record(definition.calculated) !== undefined
    );
  });
  const names = distinctNames(
    kept.map((definition) =>
      typeof definition.displayName === 'string' && definition.displayName.trim()
        ? definition.displayName
        : String(definition.name),
    ),
    [ITEM_ID],
  );
  const columns = kept.map((definition, index): ListColumn => {
    const name = names[index]!;
    const plan = planOf(definition);
    const notes: NonNullable<SourceColumn['notes']> = [];
    if (record(definition.calculated)) notes.push({ messageKey: SHAREPOINT_KEYS.computed });
    if (plan.kind === 'person') notes.push({ messageKey: SHAREPOINT_KEYS.peopleText });
    if (plan.kind === 'term') notes.push({ messageKey: SHAREPOINT_KEYS.termText });
    if (plan.kind === 'lookup')
      notes.push({
        messageKey: SHAREPOINT_KEYS.lookupText,
        params: { list: (lists.get(plan.listId.toLowerCase()) ?? plan.listId).slice(0, 255) },
      });
    return {
      column: {
        name,
        sourceType: sourceTypeOf(definition),
        nullable: definition.required !== true,
        ...suggestionOf(name, plan),
        ...(notes.length ? { notes } : {}),
      },
      field: String(definition.name),
      plan,
    };
  });
  columns.push({
    column: {
      name: ITEM_ID,
      sourceType: 'id',
      nullable: false,
      suggested: { type: 'number', options: { precision: 0 } },
      alternatives: ['text'],
      role: 'recordId',
    },
    field: null,
    plan: { kind: 'number', precision: 0 },
  });
  return columns;
}

/** The IDs a person or lookup value holds, and the names it already carries. */
function lookupParts(raw: unknown, idText: unknown): Array<{ id: string; name: string | null }> {
  const parts: Array<{ id: string; name: string | null }> = [];
  const add = (entry: unknown) => {
    const found = record(entry);
    if (found) {
      const id = found.LookupId ?? found.lookupId;
      const name = found.LookupValue ?? found.lookupValue ?? found.Label;
      parts.push({
        id: id === undefined || id === null ? '' : String(id),
        name: typeof name === 'string' && name.trim() ? name : null,
      });
    } else if (typeof entry === 'string' && entry.trim()) parts.push({ id: '', name: entry });
  };
  if (Array.isArray(raw)) raw.forEach(add);
  else if (raw !== undefined && raw !== null) add(raw);
  if (!parts.length && idText !== undefined && idText !== null && String(idText).trim())
    for (const id of Array.isArray(idText) ? idText : [idText]) parts.push({ id: String(id), name: null });
  return parts;
}

function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(textOf).filter((part): part is string => part !== null);
    return parts.length ? parts.join(', ') : null;
  }
  return JSON.stringify(value);
}

/** A calculated column's value as SharePoint sometimes writes it, like `float;#12.5`. */
function unprefixed(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/^[a-z]+;#/i, '') : value;
}

function numberOf(value: unknown): number | null {
  const raw = unprefixed(value);
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** An item's value for a column, as the field type it's read as. */
function valueOf(
  entry: ListColumn,
  item: { id: string; fields: Record<string, unknown> },
  fieldType: string,
  known: Known,
): CellValue {
  if (entry.field === null) return fieldType === 'number' ? numberOf(item.id) : item.id;
  const raw = item.fields[entry.field];
  const plan = entry.plan;
  const asText = (value: CellValue): CellValue => (value === null ? null : textOf(value));
  switch (plan.kind) {
    case 'omitted':
      return null;
    case 'text': {
      const text = textOf(unprefixed(raw));
      if (text === null || !plan.rich) return text;
      // Rich text arrives as HTML, which a formatted long text field holds as Markdown.
      const shown = fieldType === 'longText' ? htmlToMarkdown(text) : htmlText(text);
      return shown.trim() ? shown : null;
    }
    case 'number': {
      const value = numberOf(raw);
      return fieldType === 'number' ? value : asText(value);
    }
    case 'checkbox': {
      const value = unprefixed(raw);
      if (value === null || value === undefined || value === '') return null;
      const checked =
        value === true ||
        value === 1 ||
        value === '1' ||
        (typeof value === 'string' && /^(true|yes)$/i.test(value));
      return fieldType === 'checkbox' ? checked : String(checked);
    }
    case 'date': {
      const text = textOf(unprefixed(raw));
      if (text === null) return null;
      const time = Date.parse(text);
      if (Number.isNaN(time)) return fieldType === 'date' ? null : text;
      const value = plan.includeTime ? new Date(time).toISOString() : nearestDay(text);
      return value;
    }
    case 'choice': {
      const names = (Array.isArray(raw) ? raw : [raw])
        .map((name) => (typeof name === 'string' ? name.trim() : ''))
        .filter(Boolean);
      if (!names.length) return null;
      if (fieldType === 'multipleSelect') return [...new Set(names)];
      if (fieldType === 'singleSelect') return names[0]!;
      return names.join(', ');
    }
    case 'url': {
      const found = record(raw);
      const address = found ? (found.Url ?? found.url) : raw;
      return typeof address === 'string' && address.trim() ? address.trim() : null;
    }
    case 'person':
    case 'lookup': {
      const names = lookupParts(raw, item.fields[`${entry.field}LookupId`]).map(
        (part) =>
          part.name ??
          (plan.kind === 'person'
            ? known.people.get(part.id)
            : known.lookups.get(plan.listId)?.get(part.id)) ??
          null,
      );
      const shown = names.filter((name): name is string => name !== null && name.trim() !== '');
      return shown.length ? shown.join(', ') : null;
    }
    case 'term': {
      const labels = lookupParts(raw, undefined)
        .map((part) => part.name)
        .filter((name): name is string => name !== null);
      return labels.length ? labels.join(', ') : null;
    }
  }
}

export function createSharePointListConnector(options: SharePointOptions = {}): Connector {
  const config = microsoftConfig(options);
  const graphUrl = (options.graphUrl ?? GRAPH_API_URL).replace(/\/+$/, '');

  function settingsOf(ctx: ConnectorContext): SharePointListConnection {
    if (ctx.connection.kind !== 'sharepoint-list')
      throw new ConnectorError(
        MICROSOFT_KEYS.read,
        `the connection settings are for ${ctx.connection.kind}, not sharepoint-list`,
      );
    return ctx.connection;
  }

  function begin(ctx: ConnectorContext, ms: number, extra?: AbortSignal): MicrosoftCall {
    return new MicrosoftCall(config, ctx, settingsOf(ctx), graphUrl, ms, undefined, extra);
  }

  function url(path: string, query: Record<string, string> = {}): URL {
    return graphAddress(graphUrl, path, query);
  }

  /** The error an answer outside 2xx stands for, for `what` (a site or a list). */
  function refusal(answer: Answer, what: string, missing: () => ConnectorError): ConnectorError {
    return graphRefusal(answer, what, SHAREPOINT_KEYS.denied, missing);
  }

  function siteOf(call: MicrosoftCall, address: string): Promise<SiteInfo> {
    return findSite(call, graphUrl, address, SHAREPOINT_KEYS.denied, SHAREPOINT_KEYS.site);
  }

  /** A site's lists people keep items in: not its libraries, hidden lists, or system lists. */
  async function listsOf(call: MicrosoftCall, site: SiteInfo): Promise<ListInfo[]> {
    const lists: ListInfo[] = [];
    for await (const page of call.pages(
      url(`/sites/${encodeURIComponent(site.id)}/lists`, { $select: 'id,displayName,list', $top: '200' }),
      (answer) => refusal(answer, site.address, () => new ConnectorError(SHAREPOINT_KEYS.site)),
    ))
      for (const entry of page) {
        const facet = record(entry.list) ?? {};
        const template = typeof facet.template === 'string' ? facet.template : '';
        if (facet.hidden === true || /library$/i.test(template) || template === 'xmlForm') continue;
        if (typeof entry.id !== 'string') continue;
        lists.push({
          id: entry.id,
          name: typeof entry.displayName === 'string' ? entry.displayName : entry.id,
        });
      }
    return lists;
  }

  /** The site and list a select names, by the IDs that stay put when either is renamed. */
  async function placeOf(
    call: MicrosoftCall,
    select: SourceSelect,
  ): Promise<{ site: SiteInfo; list: ListInfo; lists: Map<string, string> }> {
    if (select.kind !== 'object')
      throw new ConnectorError(MICROSOFT_KEYS.noQueries, 'SharePoint list sources read lists, not queries');
    const missing = () =>
      new ConnectorError(MICROSOFT_KEYS.objectMissing, 'the source’s sites have no such list', {
        object: select.object.name,
      });
    let site: SiteInfo | undefined;
    for (const address of settingsOf(call.ctx).sites) {
      const found = await siteOf(call, address);
      if (found.id === select.object.schema) {
        site = found;
        break;
      }
    }
    if (!site) throw missing();
    const lists = await listsOf(call, site);
    const list = lists.find((entry) => entry.id.toLowerCase() === select.object.name.toLowerCase());
    if (!list) throw missing();
    return {
      site,
      list,
      lists: new Map(lists.map((entry) => [entry.id.toLowerCase(), entry.name])),
    };
  }

  async function columnsFor(
    call: MicrosoftCall,
    site: SiteInfo,
    list: ListInfo,
    lists: Map<string, string>,
  ): Promise<ListColumn[]> {
    const definitions: Definition[] = [];
    for await (const page of call.pages(
      url(`/sites/${encodeURIComponent(site.id)}/lists/${encodeURIComponent(list.id)}/columns`),
      (answer) => refusal(answer, list.name, () => new ConnectorError(MICROSOFT_KEYS.objectMissing)),
    ))
      definitions.push(...page);
    return columnsOf(definitions, lists);
  }

  /** Every item of a list, a page at a time, with the fields the columns read. */
  async function* items(
    call: MicrosoftCall,
    site: SiteInfo,
    listId: string,
    fields: readonly string[],
    what: string,
  ): AsyncGenerator<Array<{ id: string; fields: Record<string, unknown> }>> {
    const query: Record<string, string> = { $select: 'id', $top: String(PAGE_ITEMS) };
    query.$expand = fields.length ? `fields($select=${fields.join(',')})` : 'fields';
    for await (const page of call.pages(
      url(`/sites/${encodeURIComponent(site.id)}/lists/${encodeURIComponent(listId)}/items`, query),
      (answer) => refusal(answer, what, () => new ConnectorError(MICROSOFT_KEYS.objectMissing)),
    ))
      yield page.map((entry) => ({
        id: String(entry.id ?? ''),
        fields: record(entry.fields) ?? {},
      }));
  }

  /** The Graph field names reading these columns asks for, IDs of people and lookups included. */
  function fieldsFor(columns: readonly ListColumn[]): string[] {
    const fields = new Set<string>();
    for (const entry of columns) {
      if (entry.field === null || entry.plan.kind === 'omitted') continue;
      fields.add(entry.field);
      if (entry.plan.kind === 'person' || entry.plan.kind === 'lookup') fields.add(`${entry.field}LookupId`);
    }
    return [...fields];
  }

  /**
   * The names people and lookup columns point at, read once for a whole call: every person in the
   * site's people list, and every linked item's shown value.  A preview reads only the first ones.
   */
  async function knownFor(
    call: MicrosoftCall,
    site: SiteInfo,
    columns: readonly ListColumn[],
    limit: number,
  ): Promise<Known> {
    const known: Known = { people: new Map(), lookups: new Map() };
    const read = async (listId: string, field: string, into: Map<string, string>, what: string) => {
      for await (const page of items(call, site, listId, [field], what)) {
        for (const item of page) {
          const name = textOf(item.fields[field]);
          if (name) into.set(item.id, name);
        }
        if (into.size >= limit) return;
      }
    };
    if (columns.some((entry) => entry.plan.kind === 'person'))
      try {
        await read(PEOPLE_LIST, 'Title', known.people, PEOPLE_LIST);
      } catch (error) {
        // A site that won't show its people still syncs, with names only where items carry them.
        if (!(error instanceof ConnectorError) || call.signal.aborted) throw error;
      }
    for (const entry of columns) {
      if (entry.plan.kind !== 'lookup' || known.lookups.has(entry.plan.listId)) continue;
      const names = new Map<string, string>();
      known.lookups.set(entry.plan.listId, names);
      await read(entry.plan.listId, entry.plan.columnName, names, entry.column.name);
    }
    return known;
  }

  /** A list's columns and its first `rows` items, none when only its columns are wanted. */
  async function look(
    ctx: ConnectorContext,
    select: SourceSelect,
    limit: number | null,
  ): Promise<SourcePreviewRows> {
    let call: MicrosoftCall | undefined;
    try {
      const rows = limit === null ? 0 : positive(limit, 50);
      call = begin(ctx, positive(ctx.timeoutMs, 30000));
      const { site, list, lists } = await placeOf(call, select);
      const columns = await columnsFor(call, site, list, lists);
      const first: Array<{ id: string; fields: Record<string, unknown> }> = [];
      if (rows > 0)
        for await (const page of items(call, site, list.id, fieldsFor(columns), list.name)) {
          first.push(...page);
          if (first.length >= rows) break;
        }
      const shown = first.slice(0, rows);
      const known = shown.length
        ? await knownFor(call, site, columns, PREVIEW_LINKED_ITEMS)
        : { people: new Map(), lookups: new Map() };
      return {
        columns: columns.map((entry) => entry.column),
        rows: shown.map((item) =>
          columns.map((entry) =>
            entry.column.suggested ? valueOf(entry, item, entry.column.suggested.type, known) : null,
          ),
        ),
        rowEstimate: null,
      };
    } catch (error) {
      throw microsoftFailure(error, ctx, config, call);
    }
  }

  return {
    kind: 'sharepoint-list',
    test(ctx) {
      const settings = settingsOf(ctx);
      let first: { site: SiteInfo; list: ListInfo } | undefined;
      let tested: MicrosoftCall | undefined;
      return climb(ctx, config, new URL(graphUrl), (ms) => (tested = begin(ctx, ms)), [
        {
          step: 'lists',
          async run(within) {
            for (const address of settings.sites) {
              const site = await within(() => siteOf(tested!, address));
              const lists = await within(() => listsOf(tested!, site));
              if (!first && lists.length) first = { site, list: lists[0]! };
            }
            if (!first) throw new ConnectorError(SHAREPOINT_KEYS.noLists, 'the sites have no lists');
          },
        },
        {
          step: 'rows',
          async run(within) {
            const { site, list } = first!;
            await within(async () => {
              const answer = await tested!.get(
                url(`/sites/${encodeURIComponent(site.id)}/lists/${encodeURIComponent(list.id)}/items`, {
                  $select: 'id',
                  $top: '1',
                }),
              );
              if (answer.status < 200 || answer.status >= 300)
                throw refusal(answer, list.name, () => new ConnectorError(MICROSOFT_KEYS.objectMissing));
            });
          },
        },
      ]);
    },
    async listObjects(ctx): Promise<SourceObject[]> {
      let call: MicrosoftCall | undefined;
      try {
        call = begin(ctx, config.deadlineMs);
        const objects: SourceObject[] = [];
        for (const address of settingsOf(ctx).sites) {
          const site = await siteOf(call, address);
          for (const list of await listsOf(call, site))
            objects.push({
              schema: site.id,
              schemaLabel: site.name,
              name: list.id,
              label: list.name,
              type: 'list',
              rowEstimate: null,
            });
        }
        return objects;
      } catch (error) {
        throw microsoftFailure(error, ctx, config, call);
      }
    },
    async describe(ctx, select) {
      return (await look(ctx, select, null)).columns;
    },
    preview: (ctx, select, limit) => look(ctx, select, limit),
    async keyCandidates(ctx, object: SourceObjectRef) {
      // An item's ID never changes and never repeats, so it's the one key a list has.
      await look(ctx, { kind: 'object', object }, null);
      return [[ITEM_ID]];
    },
    async *read(ctx, select, readOptions) {
      let call: MicrosoftCall | undefined;
      try {
        const size = positive(readOptions.batchSize, 5000);
        call = begin(ctx, config.deadlineMs);
        const running = call;
        const { site, list, lists } = await placeOf(running, select);
        const columns = await columnsFor(running, site, list, lists);
        const byName = new Map(columns.map((entry) => [entry.column.name, entry]));
        // A column that has gone from the list fails the sync, rather than emptying its field.
        const columnOf = (name: string): ListColumn => {
          const entry = byName.get(name);
          if (!entry)
            throw new ConnectorError(
              MICROSOFT_KEYS.columnMissing,
              `${list.name} has no column named ${name}`,
              {
                column: name,
              },
            );
          return entry;
        };
        const wanted = readOptions.columns.map((name) => [name, columnOf(name)] as const);
        const keys = readOptions.keyColumns.map(columnOf);
        const reading = [...new Set([...wanted.map(([, entry]) => entry), ...keys])];
        const known = await knownFor(running, site, reading, Number.POSITIVE_INFINITY);
        const keyType = (entry: ListColumn) => entry.column.suggested?.type ?? 'text';
        const toRow = (item: { id: string; fields: Record<string, unknown> }): SourceRow => ({
          key: sourceKey(keys.map((entry) => valueOf(entry, item, keyType(entry), known))),
          values: Object.fromEntries(
            wanted.map(([name, entry]) => [
              name,
              valueOf(entry, item, readOptions.types[name] ?? keyType(entry), known),
            ]),
          ),
        });
        const batcher = new RowBatcher<SourceRow>(size);
        for await (const page of items(running, site, list.id, fieldsFor(reading), list.name))
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

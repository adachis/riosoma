import { createHash } from 'node:crypto';
import {
  AppError,
  type AirtableConnection,
  type AirtableSourceBase,
  type CellValue,
  type SourceColumn,
  type SourceObject,
  type SourceSelect,
  type SourceTestResult,
  type TestStep,
} from '@riosoma/contracts';
import {
  ConnectorError,
  FileNetworkError,
  nodeSockets,
  NO_NETWORK,
  pace,
  registerConnector,
  sourceKey,
  type Connector,
  type ConnectorContext,
  type FileNetwork,
  type FileResponse,
  type SourcePreviewRows,
  type SourceRow,
  type Sockets,
} from '@riosoma/connectors';
import type { FastifyInstance } from 'fastify';
import { systemResolve, type Resolve } from '../automations/outbound.js';
import type { RuntimeConfig } from '../config.js';
import {
  AIRTABLE_API_URL,
  AirtableClient,
  systemClock,
  Unreachable,
  type AirtableRecord,
  type AirtableTable,
  type Clock,
  type Fetch,
  type Limiter,
} from '../data/imports/airtable/api.js';
import { choiceName, planField, textOf, type FieldPlan, type Note } from '../data/imports/airtable/fields.js';
import { allowsPrivate } from '../webhooks/url.js';
import { fileNetwork } from './files.js';

/**
 * Airtable sources: the tables of the bases an admin chose from the ones a personal access token can
 * see, each offered like a table and keyed by Airtable's own record IDs.  The import's client reads
 * Airtable through the server's guarded network.  Every request to a base, whether for a sync, its
 * linked records' names, a preview, or a test, goes through that base's one limiter: evenly spaced
 * at four a second, under Airtable's five, and counted against the import's limiter for the same
 * base too.  A 429 holds every request for that base as long as Airtable asks, 30 seconds unless it
 * says otherwise.  A call with time left for the wait waits it out, and one without stops at once
 * and says Airtable asked to slow down, which the next sync gets past on its own.
 *
 * Fields come across the way an import maps them, except that a link holds the linked records'
 * names as text, since the other table may not be synced, and fields Airtable computes hold the
 * values it computed, typed by their result.  Nothing is ever written to Airtable.
 */

export const AIRTABLE_KEYS = {
  token: 'sources.airtable.token',
  scopes: 'sources.airtable.scopes',
  records: 'sources.airtable.records',
  base: 'sources.airtable.base',
  unavailable: 'sources.airtable.unavailable',
  unreadable: 'sources.airtable.unreadable',
  rateLimited: 'sources.airtable.rateLimited',
  slowDown: 'sources.airtable.slowDown',
  unreachable: 'sources.airtable.unreachable',
  noQueries: 'sources.airtable.noQueries',
  linkText: 'sources.airtable.linkText',
  filesText: 'sources.airtable.filesText',
  computed: 'sources.airtable.computed',
  read: 'sources.sync.read',
  objectMissing: 'sources.sync.objectMissing',
  columnMissing: 'sources.sync.columnMissing',
  secretsMissing: 'sources.secretsMissing',
  timeout: 'sources.test.timeout',
} as const;

/** Keys a failed test step carries as they are.  The others say less than the step's own advice. */
const ADVICE = new Set<string>([
  AIRTABLE_KEYS.token,
  AIRTABLE_KEYS.scopes,
  AIRTABLE_KEYS.records,
  AIRTABLE_KEYS.base,
  AIRTABLE_KEYS.unavailable,
  AIRTABLE_KEYS.unreadable,
  AIRTABLE_KEYS.rateLimited,
  AIRTABLE_KEYS.slowDown,
  AIRTABLE_KEYS.unreachable,
  AIRTABLE_KEYS.secretsMissing,
  AIRTABLE_KEYS.timeout,
]);

/** The column each record's ID arrives in, which no field can take from it. */
export const RECORD_ID = 'Record ID';

/** The most one answer from Airtable may hold, far more than a page of 100 records needs. */
const MAX_ANSWER_BYTES = 50 * 1024 * 1024;
/** How long a sync's whole read may take. */
const DEADLINE_MS = 20 * 60_000;
/**
 * Requests a second to each base.  Airtable allows five, and spacing four evenly leaves room for
 * the network to bunch a few together on the way there without five landing inside one second.
 */
export const BASE_REQUESTS_PER_SECOND = 4;
/** Time a call keeps for its own requests once a wait for Airtable is over. */
const ROOM_AFTER_WAIT_MS = 10_000;
/** Records of each linked table a preview reads for their names.  A sync reads them all. */
const PREVIEW_LINKED_RECORDS = 1_000;
/** Types a formula's or a rollup's result can take that hold one plain value, so it keeps its type. */
const PLAIN_RESULTS = new Set([
  'singleLineText',
  'multilineText',
  'email',
  'url',
  'phoneNumber',
  'number',
  'currency',
  'percent',
  'duration',
  'rating',
  'checkbox',
  'date',
  'dateTime',
]);
/** Import notes about what happens after an import, which mean nothing to a sync. */
const IMPORT_ONLY = new Set(['import.airtable.report.timeFixed', 'import.airtable.report.peopleFixed']);
const TEXT_TYPES = ['text', 'longText'];

export interface AirtableSourceOptions {
  /** The guarded network the server supplies.  Without one, nothing is reached. */
  network?: FileNetwork;
  sockets?: Sockets;
  /** Where Airtable's API answers.  Tests point it at a stand-in. */
  apiUrl?: string;
  clock?: Clock;
  /** Requests a second for each base: four unless set, which is under Airtable's five */
  requestsPerSecond?: number;
  /**
   * Another limiter every request to a base also counts against, like the import's, so imports and
   * syncs of the same base stay under Airtable's limit together
   */
  sharedLimiter?: (key: string) => Limiter | undefined;
}

/** A column as a table describes it, and how a record's cell becomes its value. */
interface AirtableColumn {
  column: SourceColumn;
  /** The field it reads, by ID, or null for the record's own ID */
  fieldId: string | null;
  /** For a link, the linked table and the field that names its records */
  link?: { table: string; primary: string };
  value(record: AirtableRecord, fieldType: string, names: LinkedNames): CellValue;
}

/** Linked records' names, by linked table and then by record ID. */
type LinkedNames = Map<string, Map<string, string>>;

/** Airtable asked to slow down, and the call has no time left to wait as long as it asked. */
function slowDown(ms: number): ConnectorError {
  return new ConnectorError(
    AIRTABLE_KEYS.slowDown,
    `Airtable asked for a wait of ${Math.ceil(ms / 1_000)} seconds, longer than the call had left`,
  );
}

/**
 * `fetch` through the guarded network, for the import's client.  An address the network refuses
 * leaves at once, since no retry would change its mind.
 */
function guardedFetch(network: FileNetwork, idleMs: number): Fetch {
  // An answer the client doesn't read, like a 429's, lets its connection go when it's canceled.
  const streamOf = (response: FileResponse) => {
    const chunks = response.body[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel() {
        response.close();
        void chunks.return?.().catch(() => undefined);
      },
    });
  };
  return async (url, init) => {
    const target = new URL(url);
    if (!network.allowsAddress(target))
      throw new Unreachable(new FileNetworkError('https', `${target.protocol} addresses aren’t allowed`));
    let response;
    try {
      response = await network.request({
        url: target,
        method: 'GET',
        headers: init.headers,
        maxBytes: MAX_ANSWER_BYTES,
        signal: init.signal,
        idleMs,
      });
    } catch (error) {
      if (error instanceof FileNetworkError && ['https', 'blocked', 'tooLarge'].includes(error.problem))
        throw new Unreachable(error);
      throw error;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers))
      if (value !== undefined) headers.set(name, value);
    const empty = response.status === 204 || response.status === 304;
    if (empty) response.close();
    return new Response(empty ? null : streamOf(response), {
      status: response.status,
      headers,
    });
  };
}

/**
 * Column names from field names, with the record ID's own name taken first, so a field that
 * repeats it is the one that gets numbered, the way a sheet's repeated headers are.
 */
function columnNames(names: readonly string[]): string[] {
  const used = new Set([RECORD_ID.toLowerCase()]);
  return names.map((raw) => {
    const base = raw.trim().slice(0, 255) || 'Field';
    let name = base;
    for (let suffix = 1; used.has(name.toLowerCase()); suffix++) name = `${base}_${suffix}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function noteOf(note: Note): { messageKey: string; params?: Record<string, string | number> } {
  return { messageKey: note.key, ...(note.params ? { params: note.params } : {}) };
}

function isDay(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));
}

/** A cell as the value of the field type its plan gives it, or null when it doesn't fit. */
function typedValue(
  plan: Extract<FieldPlan, { kind: 'value' }>,
  raw: unknown,
  includeTime: boolean,
): CellValue {
  switch (plan.spec.type) {
    case 'singleSelect':
      return choiceName(raw);
    case 'multipleSelect': {
      const names = (Array.isArray(raw) ? raw : [raw])
        .map(choiceName)
        .filter((name): name is string => name !== null && name !== '');
      return names.length ? [...new Set(names)] : null;
    }
    case 'checkbox':
      return raw === true || raw === 1;
    case 'number':
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating': {
      const value = plan.read(raw);
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return plan.spec.type === 'rating' ? Math.round(value) : value;
    }
    case 'date': {
      const value = plan.read(raw);
      if (typeof value !== 'string') return null;
      if (!includeTime) return isDay(value) ? value : null;
      const time = Date.parse(value);
      return Number.isNaN(time) ? null : new Date(time).toISOString();
    }
    default: {
      const value = plan.read(raw);
      return typeof value === 'string' ? value : textOf(value);
    }
  }
}

/**
 * The columns a table offers: its primary field first, every other field in Airtable's order, and
 * the record ID last.  Each is typed the way an import types it.
 */
function columnsOf(table: AirtableTable, tables: readonly AirtableTable[]): AirtableColumn[] {
  const context = { tables: new Set(tables.map((entry) => entry.id)), primary: false };
  const fields = [
    ...table.fields.filter((field) => field.id === table.primaryFieldId),
    ...table.fields.filter((field) => field.id !== table.primaryFieldId),
  ];
  const names = columnNames(fields.map((field) => field.name));
  const columns = fields.map((field, index): AirtableColumn => {
    const name = names[index]!;
    const options = field.options ?? undefined;
    const result = options?.result as { type?: unknown; options?: Record<string, unknown> } | undefined;
    const notes: SourceColumn['notes'] = [];
    let plan: FieldPlan;
    if (
      (field.type === 'formula' || field.type === 'rollup') &&
      typeof result?.type === 'string' &&
      PLAIN_RESULTS.has(result.type)
    )
      // A computed field keeps the type of its result, holding the values Airtable computed.
      plan = planField({ ...field, type: result.type, options: result.options ?? null }, context);
    else plan = planField(field, context);
    if (['formula', 'rollup', 'multipleLookupValues', 'count'].includes(field.type))
      notes.push({ messageKey: AIRTABLE_KEYS.computed });
    for (const note of plan.notes) if (!IMPORT_ONLY.has(note.key)) notes.push(noteOf(note));
    const column = (suggested: SourceColumn['suggested'], alternatives: string[]): SourceColumn => ({
      name,
      sourceType: field.type.slice(0, 255),
      nullable: true,
      suggested,
      alternatives,
      ...(notes.length ? { notes } : {}),
    });
    const text = (record: AirtableRecord) => textOf(record.fields[field.id]);
    switch (plan.kind) {
      case 'value': {
        const valued = plan;
        const spec = valued.spec;
        if (spec.type === 'singleSelect' || spec.type === 'multipleSelect') {
          const choices = (spec.options as { choices: Array<{ id: string; name: string }> }).choices;
          // A schema read preserves option identity across previews and descriptions.
          for (const choice of choices) {
            const bytes = createHash('sha256')
              .update(JSON.stringify([table.id, field.id, choice.name]))
              .digest();
            choice.id =
              'cho' +
              Array.from(
                bytes.subarray(0, 14),
                (byte) => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[byte % 62],
              ).join('');
          }
        }
        const includeTime =
          spec.type === 'date' && (spec.options as { includeTime?: boolean }).includeTime === true;
        return {
          column: column(
            { type: spec.type, options: spec.options as Record<string, unknown> },
            TEXT_TYPES.filter((type) => type !== spec.type),
          ),
          fieldId: field.id,
          value: (record, fieldType) => {
            const raw = record.fields[field.id];
            if (raw === undefined || raw === null) return null;
            return fieldType === spec.type ? typedValue(valued, raw, includeTime) : text(record);
          },
        };
      }
      case 'link': {
        const linked = tables.find((entry) => entry.id === plan.linkedTable)!;
        notes.push({ messageKey: AIRTABLE_KEYS.linkText, params: { table: linked.name.slice(0, 255) } });
        return {
          column: column({ type: 'text', options: {} }, ['longText']),
          fieldId: field.id,
          link: { table: linked.id, primary: linked.primaryFieldId },
          value: (record, _fieldType, known) => {
            const raw = record.fields[field.id];
            const ids = (Array.isArray(raw) ? raw : []).filter((id): id is string => typeof id === 'string');
            const byId = known.get(linked.id);
            // A linked record whose name is empty, or wasn't read, reads as its ID.
            const shown = ids.map((id) => byId?.get(id) || id);
            return shown.length ? shown.join(', ') : null;
          },
        };
      }
      case 'files':
        notes.push({ messageKey: AIRTABLE_KEYS.filesText });
        return {
          column: column({ type: 'text', options: {} }, ['longText']),
          fieldId: field.id,
          value: text,
        };
      case 'omitted':
        return { column: column(null, []), fieldId: field.id, value: () => null };
    }
  });
  columns.push({
    column: {
      name: RECORD_ID,
      sourceType: 'recordId',
      nullable: false,
      suggested: { type: 'text', options: {} },
      alternatives: [],
      role: 'recordId',
    },
    fieldId: null,
    value: (record) => record.id,
  });
  return columns;
}

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>;

export function airtableSourceOptions(
  config: Config,
  resolve: Resolve = systemResolve,
): AirtableSourceOptions {
  return { network: fileNetwork({ resolve, allowPrivate: (url) => allowsPrivate(url.href, config) }) };
}

/** An Airtable connector, which can also list the bases a token sees, for choosing a source's bases. */
export interface AirtableSourceConnector extends Connector {
  bases(token: string, signal: AbortSignal, timeoutMs?: number): Promise<AirtableSourceBase[]>;
}

export function isAirtableConnector(connector: Connector): connector is AirtableSourceConnector {
  return connector.kind === 'airtable' && 'bases' in connector;
}

export function createAirtableSourceConnector(options: AirtableSourceOptions = {}): AirtableSourceConnector {
  const network = options.network ?? NO_NETWORK;
  const sockets = options.sockets ?? nodeSockets;
  const apiUrl = (options.apiUrl ?? AIRTABLE_API_URL).replace(/\/+$/, '');
  const clock = options.clock ?? systemClock;
  const perSecond = options.requestsPerSecond ?? BASE_REQUESTS_PER_SECOND;
  /** When each base may be asked again after a 429, shared by every call to it. */
  const pauses = new Map<string, number>();

  /**
   * One base's limiter for one call.  Every call to the same base shares its pace and its pauses.
   * A pause that wouldn't leave the call time for its requests ends the call at once, so a preview
   * or a test says Airtable asked to slow down instead of spending its time waiting, while a sync's
   * read, which has minutes, waits.  A wait that runs past the time the call's caller gave it ends
   * the same way, since waiting on Airtable is why it ran out.
   */
  function baseLimiter(key: string, deadline: number): Limiter {
    const name = `airtable:${key}`;
    const shared = options.sharedLimiter?.(key);
    return {
      async take(signal) {
        const running = signal ?? new AbortController().signal;
        for (;;) {
          const wait = (pauses.get(name) ?? 0) - clock.now();
          if (wait <= 0) break;
          if (clock.now() + wait + ROOM_AFTER_WAIT_MS > deadline) throw slowDown(wait);
          try {
            await clock.sleep(wait, running);
          } catch (error) {
            if (running.aborted) throw slowDown(wait);
            throw error;
          }
        }
        await pace(name, perSecond, running);
        if (!shared) return;
        const started = clock.now();
        try {
          await shared.take(running);
        } catch (error) {
          // The import's limiter only holds a request for long after Airtable asked it to slow down.
          if (running.aborted) throw slowDown(clock.now() - started);
          throw error;
        }
      },
      pause(ms) {
        pauses.set(name, Math.max(pauses.get(name) ?? 0, clock.now() + ms));
        shared?.pause(ms);
      },
    };
  }

  function settingsOf(ctx: ConnectorContext): AirtableConnection {
    if (ctx.connection.kind !== 'airtable')
      throw new ConnectorError(AIRTABLE_KEYS.read, `the connection settings are for ${ctx.connection.kind}`);
    return ctx.connection;
  }

  function tokenOf(ctx: ConnectorContext): string {
    settingsOf(ctx);
    const token = ctx.secrets.token;
    if (!token) throw new ConnectorError(AIRTABLE_KEYS.secretsMissing, 'the token isn’t stored');
    return token;
  }

  /** A client for one call, which has `budgetMs` for all of its requests and their waits. */
  function clientFor(
    token: string,
    signal: AbortSignal,
    timeoutMs: number,
    budgetMs = timeoutMs,
  ): AirtableClient {
    const deadline = clock.now() + budgetMs;
    return new AirtableClient({
      apiUrl,
      token,
      clock,
      limiter: (key) => baseLimiter(key, deadline),
      signal,
      fetch: guardedFetch(network, timeoutMs),
    });
  }

  /** A client for a call, which has the caller's own time unless it's a sync's whole read. */
  function client(ctx: ConnectorContext, signal: AbortSignal, budgetMs?: number): AirtableClient {
    const timeoutMs = ctx.timeoutMs ?? 30_000;
    return clientFor(tokenOf(ctx), signal, timeoutMs, budgetMs ?? timeoutMs);
  }

  /** A call's signal: the caller's, and a deadline of its own. */
  function signalOf(ctx: ConnectorContext, ms: number): AbortSignal {
    return AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(ms)]);
  }

  /**
   * The error a call leaves with.  The import's client says what went wrong in its own keys, and
   * never repeats the token, so its errors carry no words of Airtable's.
   */
  function failure(error: unknown, purpose: 'records' | 'schema'): ConnectorError {
    if (error instanceof ConnectorError) {
      if (error.messageKey === AIRTABLE_KEYS.timeout)
        return new ConnectorError(AIRTABLE_KEYS.read, 'Airtable took too long to answer');
      return error;
    }
    if (error instanceof Unreachable) {
      const reason = error.reason;
      if (reason instanceof FileNetworkError && reason.problem === 'tooLarge')
        return new ConnectorError(AIRTABLE_KEYS.read, 'one of Airtable’s answers passed the size limit');
      return new ConnectorError(
        AIRTABLE_KEYS.unreachable,
        reason instanceof FileNetworkError ? (reason.detail ?? reason.problem) : undefined,
      );
    }
    if (error instanceof AppError)
      switch (error.messageKey) {
        case 'import.airtable.tokenInvalid':
          return new ConnectorError(AIRTABLE_KEYS.token, 'Airtable answered HTTP 401');
        case 'import.airtable.scopes':
          return new ConnectorError(AIRTABLE_KEYS.scopes, 'Airtable refused to list bases');
        case 'import.airtable.baseUnavailable':
          return purpose === 'records'
            ? new ConnectorError(AIRTABLE_KEYS.records, 'Airtable refused to read records')
            : new ConnectorError(AIRTABLE_KEYS.base, 'Airtable refused to read the base');
        case 'import.airtable.rateLimited':
          return new ConnectorError(AIRTABLE_KEYS.rateLimited, 'Airtable kept answering HTTP 429');
        case 'import.airtable.unavailable':
          return new ConnectorError(
            AIRTABLE_KEYS.unavailable,
            'Airtable didn’t answer, or answered HTTP 5xx',
          );
        case 'import.airtable.unreadable':
          return new ConnectorError(AIRTABLE_KEYS.unreadable, 'Airtable’s answer didn’t read as expected');
      }
    return new ConnectorError(
      AIRTABLE_KEYS.read,
      'the call was stopped or ran out of time before it finished',
    );
  }

  /**
   * The base and table a select names, by the IDs that stay put when either is renamed.  A base the
   * source doesn't offer is refused before anything asks Airtable about it.
   */
  async function tableOf(
    api: AirtableClient,
    ctx: ConnectorContext,
    select: SourceSelect,
  ): Promise<{ baseId: string; table: AirtableTable; tables: AirtableTable[] }> {
    if (select.kind !== 'object')
      throw new ConnectorError(AIRTABLE_KEYS.noQueries, 'Airtable sources read tables, not queries');
    const baseId = select.object.schema;
    const missing = () =>
      new ConnectorError(AIRTABLE_KEYS.objectMissing, 'the source offers no such table', {
        object: select.object.name,
      });
    if (baseId === null || !settingsOf(ctx).bases.includes(baseId)) throw missing();
    const { tables } = await api.schema(baseId);
    const table = tables.find((entry) => entry.id === select.object.name);
    if (!table) throw missing();
    return { baseId, table, tables };
  }

  /** Linked records' names for the links among `columns`, up to `limit` records of each linked table. */
  async function linkedNames(
    api: AirtableClient,
    baseId: string,
    columns: readonly AirtableColumn[],
    limit = Number.POSITIVE_INFINITY,
  ): Promise<LinkedNames> {
    const names: LinkedNames = new Map();
    for (const { link } of columns) {
      if (!link || names.has(link.table)) continue;
      const byId = new Map<string, string>();
      names.set(link.table, byId);
      for await (const page of api.records(baseId, link.table, { fields: [link.primary] })) {
        for (const record of page) byId.set(record.id, textOf(record.fields[link.primary]) ?? '');
        if (byId.size >= limit) break;
      }
    }
    return names;
  }

  async function test(ctx: ConnectorContext): Promise<SourceTestResult> {
    const steps: SourceTestResult['steps'] = [];
    let current: TestStep = 'resolve';
    let start = Date.now();
    const passed = (step: TestStep) => steps.push({ step, status: 'ok', ms: Date.now() - start });
    const enter = (step: TestStep) => {
      current = step;
      start = Date.now();
    };
    const signal = signalOf(ctx, ctx.timeoutMs ?? 30_000);
    try {
      const address = new URL(apiUrl);
      const port = Number(address.port || (address.protocol === 'https:' ? 443 : 80));
      if (!network.allowsAddress(address))
        throw new FileNetworkError('https', `${address.protocol} addresses aren’t allowed`);
      const checked = await network.check(address, signal);
      passed('resolve');
      enter('connect');
      await sockets.connect(checked, port, signal);
      passed('connect');
      enter('tls');
      if (address.protocol === 'https:') {
        await sockets.handshake(checked, port, address.hostname, signal);
        passed('tls');
      } else steps.push({ step: 'tls', status: 'skipped', ms: null });

      enter('authenticate');
      const api = client(ctx, signal);
      await api.whoami().catch((error: unknown) => {
        throw failure(error, 'schema');
      });
      passed('authenticate');

      // The first base the source offers stands for them all, since each base is a request of its own.
      enter('tables');
      const baseId = settingsOf(ctx).bases[0]!;
      const { tables } = await api.schema(baseId).catch((error: unknown) => {
        throw failure(error, 'schema');
      });
      passed('tables');

      enter('rows');
      const first = tables[0];
      if (first) {
        const pages = api.records(baseId, first.id, { fields: [first.primaryFieldId] });
        try {
          await pages.next();
        } catch (error) {
          throw failure(error, 'records');
        } finally {
          await pages.return(undefined);
        }
      }
      passed('rows');
      return { ok: true, steps };
    } catch (error) {
      const known = error instanceof ConnectorError;
      const messageKey =
        signal.aborted && !ctx.signal?.aborted
          ? AIRTABLE_KEYS.timeout
          : known
            ? ADVICE.has(error.messageKey)
              ? error.messageKey
              : `sources.test.${current}`
            : error instanceof FileNetworkError
              ? error.problem === 'resolve'
                ? 'sources.test.resolve'
                : error.problem === 'https' || error.problem === 'blocked'
                  ? AIRTABLE_KEYS.unreachable
                  : `sources.test.${current}`
              : `sources.test.${current}`;
      const detail = known ? error.detail : error instanceof FileNetworkError ? error.detail : undefined;
      steps.push({
        step: current,
        status: 'failed',
        ms: Date.now() - start,
        messageKey,
        ...(detail ? { detail: detail.slice(0, 300) } : {}),
      });
      return { ok: false, steps };
    }
  }

  async function preview(
    ctx: ConnectorContext,
    select: SourceSelect,
    limit: number,
  ): Promise<SourcePreviewRows> {
    const signal = signalOf(ctx, ctx.timeoutMs ?? 30_000);
    let purpose: 'records' | 'schema' = 'schema';
    try {
      const api = client(ctx, signal);
      const { baseId, table, tables } = await tableOf(api, ctx, select);
      const columns = columnsOf(table, tables);
      purpose = 'records';
      const pages = api.records(baseId, table.id);
      let records: AirtableRecord[] = [];
      let complete = false;
      try {
        const first = await pages.next();
        records = first.done ? [] : first.value;
        // A table whose records fit on one page has no second one.
        complete = first.done === true || (await pages.next()).done === true;
      } finally {
        await pages.return(undefined);
      }
      const shown = records.slice(0, limit);
      const names = await linkedNames(api, baseId, columns, PREVIEW_LINKED_RECORDS);
      return {
        columns: columns.map((entry) => entry.column),
        rows: shown.map((record) =>
          columns.map((entry) =>
            entry.column.suggested ? entry.value(record, entry.column.suggested.type, names) : null,
          ),
        ),
        rowEstimate: complete ? records.length : null,
      };
    } catch (error) {
      throw failure(error, purpose);
    }
  }

  return {
    kind: 'airtable',
    test,
    // One listing, a page a request, of every base the token sees, for choosing the source's bases.
    async bases(token, signal, timeoutMs = 30_000) {
      try {
        const api = clientFor(token, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), timeoutMs);
        return (await api.bases()).map((base) => ({ id: base.id, name: base.name }));
      } catch (error) {
        throw failure(error, 'schema');
      }
    },
    async listObjects(ctx): Promise<SourceObject[]> {
      try {
        const api = client(ctx, signalOf(ctx, DEADLINE_MS));
        const chosen = settingsOf(ctx).bases;
        // One listing, a page a request, names the bases, and each chosen base's schema lists its
        // tables.  A base the listing doesn't name goes by its ID.
        const names = new Map((await api.bases()).map((base) => [base.id, base.name]));
        const objects: SourceObject[] = [];
        for (const baseId of chosen) {
          const { tables } = await api.schema(baseId);
          for (const table of tables)
            objects.push({
              schema: baseId,
              schemaLabel: names.get(baseId) ?? baseId,
              name: table.id,
              label: table.name,
              type: 'table',
              rowEstimate: null,
            });
        }
        return objects;
      } catch (error) {
        throw failure(error, 'schema');
      }
    },
    async describe(ctx, select) {
      try {
        const api = client(ctx, signalOf(ctx, ctx.timeoutMs ?? 30_000));
        const { table, tables } = await tableOf(api, ctx, select);
        return columnsOf(table, tables).map((entry) => entry.column);
      } catch (error) {
        throw failure(error, 'schema');
      }
    },
    preview,
    // Every record has an ID of its own that never changes, which is the key a sync wants.
    keyCandidates: async () => [[RECORD_ID]],
    async *read(ctx, select, readOptions) {
      const signal = signalOf(ctx, DEADLINE_MS);
      let purpose: 'records' | 'schema' = 'schema';
      try {
        const size = readOptions.batchSize ?? 5_000;
        const api = client(ctx, signal, DEADLINE_MS);
        const { baseId, table, tables } = await tableOf(api, ctx, select);
        const byName = new Map(columnsOf(table, tables).map((entry) => [entry.column.name, entry]));
        // A field that has gone from Airtable, or was renamed there, fails the sync, rather than
        // emptying its field here.
        const columnOf = (name: string): AirtableColumn => {
          const entry = byName.get(name);
          if (!entry)
            throw new ConnectorError(
              AIRTABLE_KEYS.columnMissing,
              `${table.name} has no field named ${name}`,
              {
                column: name,
              },
            );
          return entry;
        };
        const wanted = readOptions.columns.map((name) => [name, columnOf(name)] as const);
        const keys = readOptions.keyColumns.map(columnOf);
        const fields = [
          ...new Set([...wanted.map(([, entry]) => entry), ...keys].flatMap((entry) => entry.fieldId ?? [])),
        ];
        purpose = 'records';
        const names = await linkedNames(
          api,
          baseId,
          wanted.map(([, entry]) => entry),
        );
        const toRow = (record: AirtableRecord): SourceRow => ({
          key: sourceKey(
            keys.map((entry) => entry.value(record, entry.column.suggested?.type ?? 'text', names)),
          ),
          values: Object.fromEntries(
            wanted.map(([name, entry]) => [
              name,
              entry.value(record, readOptions.types[name] ?? entry.column.suggested?.type ?? 'text', names),
            ]),
          ),
        });
        let held: SourceRow[] = [];
        // Asking for no fields would ask for all of them, so a read of IDs alone asks for the first.
        const only = fields.length ? fields : [table.primaryFieldId];
        for await (const page of api.records(baseId, table.id, { fields: only })) {
          held.push(...page.map(toRow));
          while (held.length >= size) {
            signal.throwIfAborted();
            yield held.slice(0, size);
            held = held.slice(size);
          }
        }
        signal.throwIfAborted();
        if (held.length) yield held;
      } catch (error) {
        throw failure(error, purpose);
      }
    },
  };
}

export function installAirtableSources(app: FastifyInstance): void {
  registerConnector(
    createAirtableSourceConnector({
      ...airtableSourceOptions(app.ctx.config),
      // A sync and an import of the same base count against one limit.
      sharedLimiter: (key) => app.ctx.airtableImports?.limiter(key),
    }),
  );
}

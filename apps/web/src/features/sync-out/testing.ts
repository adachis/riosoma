import type {
  DestinationPlace,
  OutboundSync,
  SyncOutAction,
  SyncOutPreview,
  SyncOutRun,
  SyncOutStats,
  SyncOutStatus,
  ViewSyncOut,
} from '@riosoma/contracts';

/** Fixtures and an in-memory server for Sync out, so tests drive the real requests. */

export const VIEW_ID = 'viwAAAAAAAAAAAAAA';
export const DATABASE_ID = 'dbAAAAAAAAAAAAAA';
export const TABLE_ID = 'tblAAAAAAAAAAAAAA';
export const BASE_ID = 'appAAAAAAAAAAAAAA';

const ME = { id: 'usrADAADAADAADAAD', name: 'Ada' };

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

export function statsFixture(overrides: Partial<SyncOutStats> = {}): SyncOutStats {
  return { created: 12, updated: 3, removed: 0, unchanged: 240, failed: 0, ms: 1800, ...overrides };
}

export function statusFixture(overrides: Partial<SyncOutStatus> = {}): SyncOutStatus {
  return {
    state: 'idle',
    lastRunAt: ago(120_000),
    lastSuccessAt: ago(120_000),
    nextRunAt: ahead(58 * 60_000),
    error: null,
    stats: statsFixture(),
    progress: null,
    withheld: [],
    ...overrides,
  };
}

let serial = 0;
function newSyncId(): string {
  serial += 1;
  return `osy${String(serial).padStart(14, '0')}`;
}

export function syncFixture(overrides: Partial<OutboundSync> = {}): OutboundSync {
  return {
    id: 'osyAAAAAAAAAAAAAA',
    databaseId: DATABASE_ID,
    tableId: TABLE_ID,
    viewId: VIEW_ID,
    name: 'Launches to Airtable',
    destination: {
      kind: 'airtable',
      baseId: BASE_ID,
      baseName: 'Product',
      table: {
        id: 'tblZZZZZZZZZZZZZZ',
        name: 'Launches',
        created: true,
        url: 'https://airtable.com/app/tbl',
      },
    },
    settings: {
      everyMinutes: 60,
      removeMissing: true,
      createColumns: true,
      timeZone: 'America/Denver',
      locale: 'en-US',
    },
    enabled: true,
    stoppedBecause: null,
    status: statusFixture(),
    columns: [],
    hiddenColumns: 0,
    creator: { id: ME.id, name: 'Dana Ortiz' },
    createdAt: ago(86_400_000),
    updatedAt: ago(120_000),
    canEdit: true,
    canDelete: true,
    canRun: true,
    ...overrides,
  };
}

export function baseFixture(overrides: Partial<DestinationPlace> = {}): DestinationPlace {
  return {
    id: BASE_ID,
    name: 'Product',
    group: 'My workspace',
    canWrite: true,
    canCreate: true,
    ...overrides,
  };
}

export function previewFixture(overrides: Partial<SyncOutPreview> = {}): SyncOutPreview {
  return {
    columns: [
      {
        fieldId: 'fldAAAAAAAAAAAAAA',
        fieldName: 'Name',
        fieldType: 'text',
        action: 'create',
        columnName: 'Name',
        columnType: 'singleLineText',
        write: 'typed',
        reason: null,
      },
      {
        fieldId: 'fldBBBBBBBBBBBBBB',
        fieldName: 'Stage',
        fieldType: 'singleSelect',
        action: 'create',
        columnName: 'Stage',
        columnType: 'singleSelect',
        write: 'typed',
        reason: null,
      },
      {
        fieldId: 'fldCCCCCCCCCCCCCC',
        fieldName: 'Owner',
        fieldType: 'user',
        action: 'skip',
        columnName: null,
        columnType: null,
        write: null,
        reason: 'syncOut.skip.readOnly',
      },
    ],
    key: { name: 'Riosoma record ID', action: 'create' },
    withheld: [],
    untouched: [],
    rows: 240,
    problems: [],
    ...overrides,
  };
}

export function runFixture(overrides: Partial<SyncOutRun> = {}): SyncOutRun {
  return {
    id: 'jobAAAAAAAAAAAAAA',
    syncId: 'osyAAAAAAAAAAAAAA',
    trigger: 'schedule',
    actor: null,
    startedAt: ago(120_000),
    endedAt: ago(118_000),
    outcome: 'succeeded',
    stats: statsFixture(),
    error: null,
    notes: [],
    ...overrides,
  };
}

interface ErrorSpec {
  status?: number;
  code?: string;
  messageKey: string;
  fields?: Record<string, string>;
}

export interface MockOptions {
  syncs?: OutboundSync[];
  canCreate?: boolean;
  unavailable?: string | null;
  kinds?: ViewSyncOut['kinds'];
  bases?: DestinationPlace[];
  placesError?: ErrorSpec;
  preview?: SyncOutPreview;
  previewError?: ErrorSpec;
  runs?: SyncOutRun[];
  runsError?: ErrorSpec;
  commandError?: ErrorSpec;
  listError?: ErrorSpec;
}

export interface SentRequest {
  method: string;
  url: string;
  body: unknown;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function fail(spec: ErrorSpec): Response {
  return json(
    {
      error: {
        code: spec.code ?? 'validation_failed',
        messageKey: spec.messageKey,
        userFault: true,
        ...(spec.fields ? { fields: spec.fields } : {}),
      },
    },
    spec.status ?? 400,
  );
}

function fromCreate(input: Extract<SyncOutAction, { kind: 'create' }>['input']): OutboundSync {
  const destination =
    input.destination.kind === 'airtable'
      ? {
          kind: 'airtable' as const,
          baseId: input.destination.baseId,
          baseName: input.destination.baseName,
          table: {
            id: null,
            name: input.destination.table.name,
            created: input.destination.table.mode === 'new',
            url: null,
          },
        }
      : {
          kind: 'smartsheet' as const,
          region: input.destination.region,
          table: {
            id: null,
            name: input.destination.table.name,
            created: input.destination.table.mode === 'new',
            url: null,
          },
        };
  return syncFixture({
    id: newSyncId(),
    name: input.name,
    destination,
    settings: input.settings,
    status: statusFixture({
      state: 'queued',
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      stats: null,
    }),
  });
}

/**
 * An in-memory server for one view's Sync out, recording what the dialog sends.  The test stubs
 * `fetch` with `handle` and drives the real request functions through it.
 */
export function mockSyncOut(options: MockOptions = {}) {
  const state: ViewSyncOut = {
    syncs: options.syncs ?? [],
    canCreate: options.canCreate ?? true,
    unavailable: options.unavailable ?? null,
    kinds: options.kinds ?? ['airtable'],
  };
  const runs = options.runs ?? [];
  const bases = options.bases ?? [baseFixture()];
  const sent: SentRequest[] = [];

  async function handle(url: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    sent.push({ method, url, body });

    if (url === `/api/views/${VIEW_ID}/sync-out` && method === 'GET')
      return options.listError ? fail(options.listError) : json(state);

    if (url === `/api/views/${VIEW_ID}/sync-out/places`)
      return options.placesError ? fail(options.placesError) : json({ level: 'base', places: bases });

    if (url === `/api/views/${VIEW_ID}/sync-out/preview`)
      return options.previewError ? fail(options.previewError) : json(options.preview ?? previewFixture());

    const runsMatch = /^\/api\/sync-out\/(osy[0-9A-Za-z]{14})\/runs$/.exec(url);
    if (runsMatch) return options.runsError ? fail(options.runsError) : json({ runs });

    if (url === `/api/databases/${DATABASE_ID}/sync-out/commands` && method === 'POST') {
      if (options.commandError) return fail(options.commandError);
      const command = body as { id: string; action: SyncOutAction };
      const action = command.action;
      if (action.kind === 'create') {
        const sync = fromCreate(action.input);
        state.syncs = [...state.syncs, sync];
        return json({ id: command.id, status: 'applied', sync });
      }
      const existing = state.syncs.find((sync) => sync.id === action.syncId);
      if (!existing) return fail({ status: 404, code: 'not_found', messageKey: 'errors.notFound' });
      if (action.kind === 'delete') {
        state.syncs = state.syncs.filter((sync) => sync.id !== action.syncId);
        return json({ id: command.id, status: 'applied', sync: null });
      }
      let updated = existing;
      if (action.kind === 'update') {
        const input = action.input;
        updated = {
          ...existing,
          name: input.name ?? existing.name,
          enabled: input.enabled ?? existing.enabled,
          stoppedBecause: input.enabled === true ? null : existing.stoppedBecause,
          settings: {
            ...existing.settings,
            ...(input.everyMinutes !== undefined ? { everyMinutes: input.everyMinutes } : {}),
            ...(input.removeMissing !== undefined ? { removeMissing: input.removeMissing } : {}),
            ...(input.createColumns !== undefined ? { createColumns: input.createColumns } : {}),
          },
          status:
            input.enabled === false
              ? statusFixture({ ...existing.status, state: 'idle', progress: null })
              : input.enabled === true
                ? statusFixture({ ...existing.status, state: 'queued', nextRunAt: ahead(0) })
                : existing.status,
        };
      } else {
        // run
        updated = { ...existing, status: statusFixture({ ...existing.status, state: 'queued' }) };
      }
      state.syncs = state.syncs.map((sync) => (sync.id === updated.id ? updated : sync));
      return json({ id: command.id, status: 'applied', sync: updated });
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  }

  return { handle, sent, state, runs };
}

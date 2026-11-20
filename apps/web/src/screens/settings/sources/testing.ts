import type {
  AirtableSourceBase,
  SourceConnection,
  SourceCreate,
  SourceMeta,
  SourcePreview,
  SourceTestResult,
  SourceUpdate,
  TestStep,
  WebhookSourceLog,
} from '@riosoma/contracts';
import { TEST_STEPS } from '@riosoma/contracts';
import { failure, json } from '../../database/share/testing';

/** Fixtures and a stand-in server for the Data Source settings, so tests drive the real requests. */

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const POSTGRES_CONNECTION: SourceConnection = {
  kind: 'postgres',
  host: 'db.example.com',
  port: 5432,
  database: 'analytics',
  user: 'reader',
  auth: { method: 'password' },
  tls: { mode: 'verify-full' },
};

export const BIGQUERY_CONNECTION: SourceConnection = {
  kind: 'bigquery',
  projectId: 'garden-analytics',
  dataset: 'events',
};

/** The same PostgreSQL server behind a bastion, which is what opens the advanced settings. */
export const TUNNELED_CONNECTION: SourceConnection = {
  kind: 'postgres',
  host: 'db.internal',
  port: 5432,
  database: 'analytics',
  user: 'reader',
  auth: { method: 'password' },
  tls: { mode: 'verify-full' },
  ssh: { host: 'bastion.example.com', port: 22, user: 'tunnel', hostKey: 'ssh-ed25519 AAAA' },
};

/** A web API with one endpoint that pages by number, signed in with a bearer token. */
export const REST_CONNECTION: SourceConnection = {
  kind: 'rest',
  baseUrl: 'https://api.example.com/v2',
  auth: { method: 'bearer' },
  requestsPerSecond: 5,
  endpoints: [
    {
      name: 'Orders',
      path: '/orders',
      query: [{ name: 'status', value: 'open' }],
      records: 'data',
      paging: { style: 'page', param: 'page', start: 1 },
      maxPages: 10_000,
      maxRecords: 1_000_000,
      flattenDepth: 1,
      arrays: 'text',
    },
  ],
};

/** What an endpoint's first page shows while it's set up, until a test says otherwise. */
export const ENDPOINT_PREVIEW: SourcePreview = {
  columns: [
    {
      name: 'id',
      sourceType: 'number',
      nullable: true,
      suggested: { type: 'number', options: {} },
      alternatives: [],
    },
    {
      name: 'customer.name',
      sourceType: 'string',
      nullable: true,
      suggested: { type: 'text', options: {} },
      alternatives: [],
    },
  ],
  rows: [
    [1, 'Ada'],
    [2, 'Grace'],
  ],
  rowEstimate: null,
  keyCandidates: [],
};

export function sourceMeta(overrides: Partial<SourceMeta> = {}): SourceMeta {
  return {
    id: 'src0123456789abcd',
    name: 'Warehouse',
    description: 'Nightly copy of the warehouse',
    kind: 'postgres',
    connection: POSTGRES_CONNECTION,
    secrets: ['password'],
    access: 'creators',
    createdAt: '2026-01-05T09:00:00Z',
    createdBy: 'Ada',
    updatedAt: '2026-09-01T09:00:00Z',
    lastTest: { at: ago(3 * HOUR), ok: true },
    tables: 3,
    ...overrides,
  };
}

export const postgresSource = sourceMeta();

export const bigquerySource = sourceMeta({
  id: 'srcabcdefghijklmn',
  name: 'Events',
  description: '',
  kind: 'bigquery',
  connection: BIGQUERY_CONNECTION,
  secrets: ['serviceAccountJson'],
  access: 'admins',
  lastTest: { at: ago(2 * DAY), ok: false },
  tables: 0,
});

export const motherduckSource = sourceMeta({
  id: 'srcduck0123456789',
  name: 'Notebook',
  description: '',
  kind: 'motherduck',
  connection: { kind: 'motherduck', database: 'notes' },
  secrets: ['token'],
  access: 'creators',
  lastTest: null,
  tables: 1,
});

/**
 * The steps a file source, an API source, a MongoDB source, a Google Sheets source, and an Airtable
 * source climb, which a database's climb leaves out.
 */
const FILE_STEPS: readonly TestStep[] = ['resolve', 'connect', 'tls', 'authenticate', 'read', 'parse'];
const API_STEPS: readonly TestStep[] = [
  'resolve',
  'connect',
  'tls',
  'authenticate',
  'read',
  'records',
  'paging',
];
const MONGO_STEPS: readonly TestStep[] = [
  'resolve',
  'connect',
  'tls',
  'authenticate',
  'collections',
  'document',
];
const SHEETS_STEPS: readonly TestStep[] = ['resolve', 'connect', 'tls', 'authenticate', 'sheets', 'rows'];
const AIRTABLE_STEPS: readonly TestStep[] = ['resolve', 'connect', 'tls', 'authenticate', 'tables', 'rows'];
const LISTS_STEPS: readonly TestStep[] = ['resolve', 'connect', 'tls', 'authenticate', 'lists', 'rows'];
const WORKBOOKS_STEPS: readonly TestStep[] = [
  'resolve',
  'connect',
  'tls',
  'authenticate',
  'workbooks',
  'rows',
];
const DATAVERSE_STEPS: readonly TestStep[] = ['resolve', 'connect', 'tls', 'authenticate', 'entities'];
const FEED_STEPS: readonly TestStep[] = ['resolve', 'read', 'feed'];
const WEBHOOK_STEPS: readonly TestStep[] = ['posts'];
const DATABASE_STEPS: readonly TestStep[] = TEST_STEPS.filter(
  (step) =>
    ![
      'driver',
      'read',
      'parse',
      'records',
      'paging',
      'collections',
      'document',
      'sheets',
      'tables',
      'lists',
      'workbooks',
      'entities',
      'rows',
      'feed',
      'posts',
    ].includes(step),
);

/**
 * What the test route answers with until a test says otherwise: a database's climb, or a file's,
 * an API's, a MongoDB source's, a Google Sheets source's, or an Airtable source's when the failure
 * is one only they reach.
 */
export function testResult(failedAt: TestStep | null, serverVersion = 'PostgreSQL 17.2'): SourceTestResult {
  const climb =
    failedAt === 'driver'
      ? (['driver', ...DATABASE_STEPS] as const)
      : failedAt === 'read' || failedAt === 'parse'
        ? FILE_STEPS
        : failedAt === 'records' || failedAt === 'paging'
          ? API_STEPS
          : failedAt === 'collections' || failedAt === 'document'
            ? MONGO_STEPS
            : failedAt === 'sheets' || failedAt === 'rows'
              ? SHEETS_STEPS
              : failedAt === 'tables'
                ? AIRTABLE_STEPS
                : failedAt === 'lists'
                  ? LISTS_STEPS
                  : failedAt === 'workbooks'
                    ? WORKBOOKS_STEPS
                    : failedAt === 'entities'
                      ? DATAVERSE_STEPS
                      : failedAt === 'feed'
                        ? FEED_STEPS
                        : failedAt === 'posts'
                          ? WEBHOOK_STEPS
                          : DATABASE_STEPS;
  const stop = failedAt === null ? climb.length : climb.indexOf(failedAt);
  const steps: SourceTestResult['steps'] = [];
  for (const [index, step] of climb.entries()) {
    // A tunnel is only opened when the connection has one, so a plain test skips that step.
    if (step === 'tunnel' && failedAt !== 'tunnel') {
      steps.push({ step, status: 'skipped', ms: null });
      continue;
    }
    if (index < stop) steps.push({ step, status: 'ok', ms: 8 + index });
    else if (index === stop)
      steps.push({
        step,
        status: 'failed',
        ms: 40,
        messageKey: `sources.test.${step}`,
        detail: `driver: ${step} stopped here`,
      });
    else steps.push({ step, status: 'skipped', ms: null });
  }
  return {
    ok: failedAt === null,
    steps,
    ...(failedAt === null ? { serverVersion } : {}),
  };
}

/** The bases an Airtable token sees, until a test says otherwise. */
export const AIRTABLE_BASES: AirtableSourceBase[] = [
  { id: 'appGarden00000000', name: 'Garden' },
  { id: 'appOrchard0000000', name: 'Orchard' },
  { id: 'appPantry00000000', name: 'Pantry' },
];

export type SourceRoute = 'create' | 'update' | 'delete' | 'test';

export interface SourcesMock {
  /** Stand-in for `fetch`.  Wrap it in `vi.fn` to inspect or override single calls. */
  handle(url: string, init?: RequestInit): Promise<Response>;
  /** The sources the mock holds now. */
  sources(): SourceMeta[];
  /** Responses that replace the normal one for a route, for as long as they stay set. */
  fail: Partial<Record<SourceRoute, Response>>;
  /** What the test routes answer with. */
  test: SourceTestResult;
  /** What an API endpoint's setup preview answers with, or the response that replaces it. */
  endpointPreview: SourcePreview | Response;
  /** What listing an Airtable token's bases answers with, or the response that replaces it. */
  airtableBases: AirtableSourceBase[] | Response;
  /** A webhook's delivery log, which turning bodies on or off changes */
  webhookLog: WebhookSourceLog;
}

/** A webhook address's token, made up for each test so none is ever written down. */
export function hookPath(): string {
  return `/api/inbound/${'T'.repeat(20)}${Math.random().toString(36).slice(2).padEnd(23, 'x').slice(0, 23)}`;
}

export function mockSources(options: { sources?: SourceMeta[] } = {}): SourcesMock {
  let list = options.sources ?? [postgresSource, bigquerySource, motherduckSource];
  let created = 0;
  // The server gives every source its own id, so two sources saved in one test are two rows the
  // page can tell apart.  A repeated id would leave React dropping one of them from the list.
  const createdId = (): string => `srcnew${String((created += 1)).padStart(11, '0')}`;
  const mock: SourcesMock = {
    fail: {},
    test: testResult(null),
    endpointPreview: ENDPOINT_PREVIEW,
    airtableBases: AIRTABLE_BASES,
    webhookLog: { deliveries: [], bodiesUntil: null },
    sources: () => list,
    handle: async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const id = /^\/api\/sources\/([^/]+)(?:\/test)?$/.exec(url)?.[1];
      // A Response body is read once, so a failure that stays set keeps answering.
      const failed = (route: SourceRoute) => mock.fail[route]?.clone();

      if (method === 'GET' && url === '/api/sources') return json(list);

      if (method === 'POST' && /^\/api\/sources\/(?:[^/]+\/)?endpoint-preview$/.test(url)) {
        const answer = mock.endpointPreview;
        return answer instanceof Response ? answer.clone() : json(answer);
      }

      if (method === 'POST' && /^\/api\/sources\/(?:[^/]+\/)?airtable-bases$/.test(url)) {
        const answer = mock.airtableBases;
        return answer instanceof Response ? answer.clone() : json(answer);
      }

      if (method === 'GET' && /^\/api\/sources\/[^/]+\/webhook-deliveries$/.test(url))
        return json(mock.webhookLog);
      if (method === 'PUT' && /^\/api\/sources\/[^/]+\/webhook-bodies$/.test(url)) {
        const on = (body as { on: boolean }).on;
        mock.webhookLog = {
          deliveries: mock.webhookLog.deliveries.map((delivery) =>
            on ? delivery : { ...delivery, body: null },
          ),
          bodiesUntil: on ? new Date(Date.now() + HOUR).toISOString() : null,
        };
        return json(mock.webhookLog);
      }
      if (method === 'POST' && /^\/api\/sources\/[^/]+\/webhook-address$/.test(url))
        return json({ path: hookPath() });

      if (method === 'POST' && url === '/api/sources/test') {
        return failed('test') ?? json(mock.test);
      }
      if (method === 'POST' && id && url === `/api/sources/${id}/test`) {
        list = list.map((source) =>
          source.id === id
            ? { ...source, lastTest: { at: new Date().toISOString(), ok: mock.test.ok } }
            : source,
        );
        return failed('test') ?? json(mock.test);
      }
      if (method === 'POST' && url === '/api/sources') {
        const refused = failed('create');
        if (refused) return refused;
        const create = body as SourceCreate;
        const saved = sourceMeta({
          id: createdId(),
          name: create.name,
          description: create.description,
          kind: create.connection.kind,
          connection: create.connection,
          secrets: Object.keys(create.secrets) as SourceMeta['secrets'],
          access: create.access,
          lastTest: null,
          tables: 0,
        });
        list = [...list, saved];
        // A new webhook's address comes back this once, and never with the list.
        return json(create.connection.kind === 'webhook' ? { ...saved, webhookPath: hookPath() } : saved);
      }
      if (method === 'PATCH' && id) {
        const refused = failed('update');
        if (refused) return refused;
        const update = body as SourceUpdate;
        const changed = list.map((source) => {
          if (source.id !== id) return source;
          const secrets = { ...(update.secrets ?? {}) };
          const kept = source.secrets.filter((name) => !(name in secrets));
          const added = Object.entries(secrets)
            .filter(([, value]) => value !== null)
            .map(([name]) => name as (typeof source.secrets)[number]);
          return {
            ...source,
            name: update.name ?? source.name,
            description: update.description ?? source.description,
            connection: update.connection ?? source.connection,
            access: update.access ?? source.access,
            secrets: [...kept, ...added],
          };
        });
        list = changed;
        const updated = changed.find((source) => source.id === id);
        return updated ? json(updated) : failure('errors.notFound', 404);
      }
      if (method === 'DELETE' && id) {
        const refused = failed('delete');
        if (refused) return refused;
        list = list.filter((source) => source.id !== id);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    },
  };
  return mock;
}

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AttachmentMeta,
  DatabaseArchive,
  newId,
  sourceChoiceId,
  type CommandBatchResult,
  type AuditEntry,
  type AuditPage,
  type DatabaseCopy,
  type DatabaseSchema,
  type RowData,
  type RowsPage,
  type SnapshotList,
  type SnapshotMeta,
  type SourceMeta,
  type TemplateSummary,
} from '@riosoma/contracts';
import { registerConnector, sourceKey, type Connector, type SourceRow } from '@riosoma/connectors';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { claimSyncs, runSync } from '../../sources/sync.js';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { keptSnapshots, runDailySnapshots, weekOf } from './schedule.js';
import { writeArchive } from './write.js';
import { restoreArchive } from './restore.js';
import { actorFor } from '../../automations/run.js';
import { AccessScope } from '../access.js';

/**
 * Archives end to end: a database that uses every field type, view type, and feature, taken as a
 * snapshot, restored as a new database, and compared part by part with every ID mapped back.  Then
 * snapshots while another session edits, the schedule and what it keeps, who may take a copy,
 * duplicates, synced tables, and templates.
 */

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
let source: SourceMeta;
const clientId = newId('client');
const remote = new Map<string, SourceRow[]>();

const columns = [
  {
    name: 'id',
    sourceType: 'integer',
    nullable: false,
    suggested: { type: 'number', options: {} },
    alternatives: ['text'],
  },
  {
    name: 'name',
    sourceType: 'text',
    nullable: true,
    suggested: { type: 'text', options: {} },
    alternatives: [],
  },
];
const fake: Connector = {
  kind: 'postgres',
  async test() {
    return { ok: true, steps: [] };
  },
  async listObjects() {
    return [{ schema: null, name: 'items', type: 'table', rowEstimate: null }];
  },
  async describe() {
    return columns;
  },
  async preview() {
    return { columns, rows: [], rowEstimate: 0 };
  },
  async keyCandidates() {
    return [['id']];
  },
  async *read(_context, select) {
    yield remote.get(select.kind === 'object' ? select.object.name : select.sql) ?? [];
  },
};

beforeAll(async () => {
  registerConnector(fake);
  kit = await startTestPostgres();
  server = await startServer(kit, 'archives');
  member = await server.addMember({ name: 'Morgan' });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: 'Warehouse',
      connection: { kind: 'postgres', host: 'example.test', database: 'data', user: 'reader' },
      secrets: { password: 'private-value' },
      access: 'admins',
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  source = response.json<SourceMeta>();
}, 60_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

type Who = SignedIn;

async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  who: Who = server.owner,
): Promise<{ status: number; body: T; raw: string; headers: Record<string, unknown> }> {
  const response = await server.app.inject({
    method,
    url,
    headers: who.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: response.statusCode,
    body: (response.body ? JSON.parse(response.body) : null) as T,
    raw: response.body,
    headers: response.headers,
  };
}

async function ok<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, who?: Who) {
  const result = await call<T>(method, url, payload, who);
  expect(result.status, result.raw).toBe(200);
  return result.body;
}

async function commands(databaseId: string, list: Array<Record<string, unknown>>, who: Who = server.owner) {
  const groupId = newId('action');
  const body = await ok<CommandBatchResult>(
    'POST',
    `/api/databases/${databaseId}/commands`,
    { clientId, commands: list.map((command) => ({ id: newId('command'), groupId, ...command })) },
    who,
  );
  for (const [index, result] of body.results.entries())
    expect(result, JSON.stringify(list[index]).slice(0, 400)).toMatchObject({ status: 'applied' });
}

const schemaOf = (databaseId: string, who: Who = server.owner) =>
  ok<DatabaseSchema>('GET', `/api/databases/${databaseId}/schema`, undefined, who);

async function rowsOf(viewId: string): Promise<RowsPage> {
  return ok<RowsPage>('GET', `/api/views/${viewId}/rows?refresh=1&limit=500`);
}

async function upload(
  tableId: string,
  fieldId: string,
  name: string,
  bytes: Buffer,
): Promise<AttachmentMeta> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${tableId}/fields/${fieldId}/files`,
    headers: {
      ...server.owner.headers,
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(name),
    },
    payload: bytes,
  });
  expect(response.statusCode, response.body).toBe(200);
  return AttachmentMeta.parse(response.json());
}

/** Waits for a restore or duplicate to end, and answers how it ended. */
async function finished(copy: DatabaseCopy, who: Who = server.owner): Promise<DatabaseCopy> {
  await server.ctx.databaseCopies!.settled(copy.id);
  return ok<DatabaseCopy>('GET', `/api/database-copies/${copy.id}`, undefined, who);
}

const FIELD_KEYS = [
  'name',
  'notes',
  'budget',
  'done',
  'due',
  'kickoff',
  'status',
  'tags',
  'email',
  'website',
  'phone',
  'created',
  'modified',
  'creator',
  'editor',
  'recordId',
  'cost',
  'share',
  'time',
  'score',
  'owner',
  'number',
  'files',
  'span',
  'data',
  'place',
  'signed',
  'code',
  'open',
  'title',
  'hours',
  'projectCode',
  'tasks',
  'parent',
  'matched',
  'project',
  'children',
  'matchedBack',
  'taskNames',
  'totalHours',
  'taskCount',
  'summary',
  'double',
  'projectStatus',
  'scratch',
] as const;
type FieldKey = (typeof FIELD_KEYS)[number];
const VIEW_KEYS = [
  'all',
  'open',
  'board',
  'cards',
  'calendar',
  'intake',
  'timeline',
  'gantt',
  'chart',
  'pivot',
  'list',
  'map',
  'tasks',
] as const;
type ViewKey = (typeof VIEW_KEYS)[number];

interface Built {
  databaseId: string;
  projects: string;
  tasks: string;
  ids: Record<FieldKey, string>;
  views: Record<ViewKey, string>;
  choices: Record<string, string>;
  records: Record<string, string>;
  files: Record<string, Buffer>;
}

/** A database that uses every field type, every view type, and every other part a database has. */
async function buildEverything(): Promise<Built> {
  const ids = Object.fromEntries(FIELD_KEYS.map((key) => [key, newId('field')])) as Record<FieldKey, string>;
  const choices = {
    planned: newId('choice'),
    active: newId('choice'),
    closed: newId('choice'),
    red: newId('choice'),
    blue: newId('choice'),
  };
  const databaseId = newId('database');
  const projects = newId('table');
  const tasks = newId('table');
  const views = Object.fromEntries(VIEW_KEYS.map((key) => [key, newId('view')])) as Record<ViewKey, string>;
  const created = await call<DatabaseSchema>('POST', '/api/databases', {
    id: databaseId,
    name: 'Everything',
    icon: 'rocket',
    color: 'purple',
    table: {
      id: projects,
      name: 'Projects',
      description: 'Every kind of field',
      view: { id: views.all, name: 'All' },
      fields: [
        { id: ids.name, name: 'Name', type: 'text' },
        { id: ids.notes, name: 'Notes', type: 'longText', options: { richText: true } },
        { id: ids.budget, name: 'Budget', type: 'number', options: { precision: 2 } },
        { id: ids.done, name: 'Done', type: 'checkbox' },
        { id: ids.due, name: 'Due', type: 'date' },
        { id: ids.kickoff, name: 'Kickoff', type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
        {
          id: ids.status,
          name: 'Status',
          type: 'singleSelect',
          options: {
            choices: [
              { id: choices.planned, name: 'Planned', color: 'blue' },
              { id: choices.active, name: 'Active', color: 'green' },
              { id: choices.closed, name: 'Closed', color: 'gray' },
            ],
          },
        },
        {
          id: ids.tags,
          name: 'Tags',
          type: 'multipleSelect',
          options: {
            choices: [
              { id: choices.red, name: 'Red', color: 'red' },
              { id: choices.blue, name: 'Blue', color: 'blue' },
            ],
          },
        },
        { id: ids.email, name: 'Email', type: 'email' },
        { id: ids.website, name: 'Website', type: 'url' },
        { id: ids.phone, name: 'Phone', type: 'phone' },
        { id: ids.created, name: 'Created', type: 'createdTime' },
        { id: ids.modified, name: 'Modified', type: 'lastModifiedTime' },
        { id: ids.creator, name: 'Creator', type: 'createdBy' },
        { id: ids.editor, name: 'Editor', type: 'lastModifiedBy' },
        { id: ids.recordId, name: 'Record ID', type: 'recordId' },
        { id: ids.cost, name: 'Cost', type: 'currency', options: { code: 'EUR' } },
        { id: ids.share, name: 'Share', type: 'percent' },
        { id: ids.time, name: 'Time', type: 'duration' },
        { id: ids.score, name: 'Score', type: 'rating', options: { max: 5 } },
        { id: ids.owner, name: 'Owner', type: 'user' },
        { id: ids.number, name: 'Number', type: 'autoNumber' },
        { id: ids.files, name: 'Files', type: 'attachment' },
        { id: ids.span, name: 'Span', type: 'dateRange' },
        { id: ids.data, name: 'Data', type: 'json' },
        { id: ids.place, name: 'Place', type: 'location' },
        { id: ids.signed, name: 'Signed', type: 'signature' },
        { id: ids.code, name: 'Code', type: 'text' },
        {
          id: ids.open,
          name: 'Open',
          type: 'button',
          options: { label: 'Visit', action: { kind: 'openUrl', urlTemplate: '{Website}/about' } },
        },
      ],
    },
  });
  expect(created.status, created.raw).toBe(200);
  await commands(databaseId, [
    {
      kind: 'table.create',
      table: {
        id: tasks,
        name: 'Tasks',
        view: { id: views.tasks, name: 'Tasks' },
        fields: [
          { id: ids.title, name: 'Title', type: 'text' },
          { id: ids.hours, name: 'Hours', type: 'number' },
          { id: ids.projectCode, name: 'Project code', type: 'text' },
        ],
      },
    },
    { kind: 'database.update', description: 'The whole kitchen sink' },
  ]);
  // Links: tasks both ways, a project's parent in the same table, and tasks matched by code.
  await commands(databaseId, [
    {
      kind: 'field.create',
      tableId: projects,
      field: { id: ids.tasks, name: 'Tasks', type: 'link', options: { linkedTableId: tasks } },
    },
    {
      kind: 'field.create',
      tableId: projects,
      field: {
        id: ids.parent,
        name: 'Parent',
        type: 'link',
        options: { linkedTableId: projects, prefersSingle: true },
      },
    },
    {
      kind: 'field.create',
      tableId: tasks,
      field: {
        id: ids.matched,
        name: 'Matched project',
        type: 'link',
        options: { linkedTableId: projects, match: { fieldId: ids.projectCode, linkedFieldId: ids.code } },
      },
    },
  ]);
  let schema = await schemaOf(databaseId);
  const inverse = (fieldId: string) => {
    const field = schema.fields.find((item) => item.id === fieldId)!;
    if (field.type !== 'link') throw new Error('not a link');
    return field.options.inverseFieldId!;
  };
  ids.project = inverse(ids.tasks);
  ids.children = inverse(ids.parent);
  ids.matchedBack = inverse(ids.matched);
  await commands(databaseId, [
    { kind: 'field.update', fieldId: ids.project, name: 'Project' },
    { kind: 'field.update', fieldId: ids.children, name: 'Children' },
    { kind: 'field.update', fieldId: ids.matchedBack, name: 'Tasks by code' },
    {
      kind: 'field.create',
      tableId: projects,
      field: {
        id: ids.taskNames,
        name: 'Task names',
        type: 'lookup',
        options: { linkFieldId: ids.tasks, targetFieldId: ids.title },
      },
    },
    {
      kind: 'field.create',
      tableId: projects,
      field: {
        id: ids.totalHours,
        name: 'Total hours',
        type: 'rollup',
        options: { linkFieldId: ids.tasks, targetFieldId: ids.hours, fn: 'sum' },
      },
    },
    {
      kind: 'field.create',
      tableId: projects,
      field: { id: ids.taskCount, name: 'Task count', type: 'count', options: { linkFieldId: ids.tasks } },
    },
    {
      kind: 'field.create',
      tableId: projects,
      field: {
        id: ids.summary,
        name: 'Summary',
        type: 'formula',
        options: { expression: '{Name} & " has " & {Task count} & " tasks, " & {Total hours} & " hours"' },
      },
    },
    {
      kind: 'field.create',
      tableId: tasks,
      field: { id: ids.double, name: 'Double', type: 'formula', options: { expression: '{Hours} * 2' } },
    },
    {
      kind: 'field.create',
      tableId: tasks,
      field: {
        id: ids.projectStatus,
        name: 'Project status',
        type: 'lookup',
        options: { linkFieldId: ids.project, targetFieldId: ids.status },
      },
    },
    { kind: 'field.create', tableId: projects, field: { id: ids.scratch, name: 'Scratch', type: 'text' } },
  ]);
  await commands(databaseId, [{ kind: 'field.trash', fieldId: ids.scratch }]);

  const records = {
    alpha: newId('record'),
    beta: newId('record'),
    gamma: newId('record'),
    delta: newId('record'),
    t1: newId('record'),
    t2: newId('record'),
    t3: newId('record'),
  };
  const bytes = { report: Buffer.from('Quarterly report, first draft'), plan: Buffer.from('The plan') };
  const report = await upload(projects, ids.files, 'report.txt', bytes.report);
  const plan = await upload(projects, ids.files, 'plan.txt', bytes.plan);
  await commands(databaseId, [
    {
      kind: 'record.create',
      tableId: projects,
      records: [
        {
          id: records.alpha,
          values: {
            [ids.name]: 'Alpha',
            [ids.notes]: '**Bold** start',
            [ids.budget]: 1234.5,
            [ids.done]: true,
            [ids.due]: '2026-03-01',
            [ids.kickoff]: '2026-02-01T09:30:00.000Z',
            [ids.status]: choices.active,
            [ids.tags]: [choices.red, choices.blue],
            [ids.email]: 'alpha@example.com',
            [ids.website]: 'https://example.com',
            [ids.phone]: '(555) 555-0100',
            [ids.cost]: 99.95,
            [ids.share]: 0.25,
            [ids.time]: 5400,
            [ids.score]: 4,
            [ids.owner]: [server.owner.userId],
            [ids.files]: [report.id, plan.id],
            [ids.span]: { start: '2026-01-01', end: '2026-01-31' },
            [ids.data]: '{"a": 1}',
            [ids.place]: { lat: 51.5, lng: -0.12, label: 'London' },
            [ids.signed]: {
              drawing: null,
              name: 'Amara Okafor',
              signedBy: null,
              signedAt: '2026-01-02T00:00:00.000Z',
            },
            [ids.code]: 'A-1',
          },
        },
        {
          id: records.beta,
          values: { [ids.name]: 'Beta', [ids.status]: choices.planned, [ids.budget]: 10, [ids.code]: 'B-2' },
        },
        { id: records.gamma, values: { [ids.name]: 'Gamma', [ids.status]: choices.closed } },
        { id: records.delta, values: { [ids.name]: 'Delta' } },
      ],
    },
    {
      kind: 'record.create',
      tableId: tasks,
      records: [
        { id: records.t1, values: { [ids.title]: 'Write', [ids.hours]: 3, [ids.projectCode]: 'A-1' } },
        { id: records.t2, values: { [ids.title]: 'Review', [ids.hours]: 1.5, [ids.projectCode]: 'A-1' } },
        { id: records.t3, values: { [ids.title]: 'Ship', [ids.hours]: 2, [ids.projectCode]: 'B-2' } },
      ],
    },
  ]);
  await commands(databaseId, [
    {
      kind: 'record.update',
      tableId: projects,
      records: [
        { id: records.alpha, values: { [ids.tasks]: [records.t2, records.t1] } },
        { id: records.beta, values: { [ids.tasks]: [records.t3], [ids.parent]: [records.alpha] } },
        { id: records.gamma, values: { [ids.parent]: [records.alpha] } },
      ],
    },
    { kind: 'record.trash', tableId: projects, recordIds: [records.delta] },
    {
      kind: 'comment.create',
      tableId: projects,
      recordId: records.alpha,
      comment: { id: newId('comment'), body: 'Looks good to me', fieldId: ids.notes },
    },
  ]);

  const place = { x: 0, y: 0, w: 4, h: 2 };
  await commands(databaseId, [
    {
      kind: 'view.update',
      viewId: views.all,
      config: {
        sorts: [{ fieldId: ids.name, direction: 'asc' }],
        hiddenFieldIds: [ids.notes],
        columnWidths: { [ids.name]: 300 },
        summaries: { [ids.budget]: 'sum' },
        frozenFieldCount: 2,
        rowHeight: 'medium',
        colorRules: [
          {
            id: 'rule-1',
            target: 'record',
            condition: { id: 'c1', fieldId: ids.status, operator: 'is', value: choices.active },
            color: 'green',
          },
        ],
        colorScales: [{ fieldId: ids.budget, stops: [{ color: 'red' }, { color: 'green' }] }],
        dataBars: [{ fieldId: ids.score }],
      },
    },
    ...(
      [
        [
          'open',
          'Open ones',
          'grid',
          {
            filter: {
              conjunction: 'and',
              conditions: [
                {
                  id: 'c1',
                  fieldId: ids.status,
                  operator: 'isAnyOf',
                  value: [choices.active, choices.planned],
                },
              ],
            },
          },
        ],
        [
          'board',
          'Board',
          'kanban',
          {
            kanban: {
              stackFieldId: ids.status,
              stackOrder: [choices.closed, choices.active],
              coverFieldId: ids.files,
            },
          },
        ],
        ['cards', 'Cards', 'gallery', { gallery: { coverFieldId: ids.files, cardSize: 'large' } }],
        ['calendar', 'Calendar', 'calendar', { calendar: { startFieldId: ids.due } }],
        [
          'intake',
          'Intake',
          'form',
          {
            form: {
              title: 'New project',
              questions: [{ fieldId: ids.name, required: true }, { fieldId: ids.notes }],
            },
          },
        ],
        [
          'timeline',
          'Timeline',
          'timeline',
          {
            timeline: { startFieldId: ids.due, endFieldId: ids.kickoff, groupFieldId: ids.status },
          },
        ],
        [
          'gantt',
          'Gantt',
          'gantt',
          {
            gantt: { startFieldId: ids.due, dependencyFieldId: ids.parent, progressFieldId: ids.share },
          },
        ],
        [
          'chart',
          'Chart',
          'chart',
          {
            chart: {
              groupBy: { fieldId: ids.status },
              value: { fn: 'sum', fieldId: ids.budget },
              seriesBy: ids.done,
            },
          },
        ],
        [
          'pivot',
          'Pivot',
          'pivot',
          { pivot: { rows: [{ fieldId: ids.status }], values: [{ fn: 'count' }] } },
        ],
        ['list', 'List', 'list', { list: { visibleFieldCount: 2 } }],
        ['map', 'Map', 'map', { map: { locationFieldId: ids.place, colorFieldId: ids.status } }],
      ] as const
    ).map(([key, name, type, config]) => ({
      kind: 'view.create',
      view: { id: views[key], tableId: projects, name, type, config },
    })),
  ]);
  // The list keeps an order of its own.
  await commands(databaseId, [
    {
      kind: 'record.move',
      tableId: projects,
      viewId: views.list,
      recordIds: [records.gamma],
      place: { before: records.alpha },
    },
  ]);
  const dashboardId = newId('dashboard');
  const automationId = newId('automation');
  await commands(databaseId, [
    {
      kind: 'dashboard.create',
      dashboard: {
        id: dashboardId,
        name: 'Overview',
        config: {
          tiles: [
            {
              id: 'tile-total',
              kind: 'number',
              title: 'Budget',
              place,
              source: { tableId: projects, viewId: views.open },
              value: { fn: 'sum', fieldId: ids.budget },
            },
            {
              id: 'tile-chart',
              kind: 'chart',
              place: { ...place, x: 4 },
              source: { tableId: projects },
              groupBy: { fieldId: ids.status },
              value: { fn: 'count' },
            },
            {
              id: 'tile-list',
              kind: 'records',
              place: { ...place, y: 2 },
              source: { tableId: tasks },
              fieldIds: [ids.hours],
            },
            { id: 'tile-note', kind: 'text', place: { ...place, x: 8 }, text: 'Kept as written' },
          ],
        },
      },
    },
    {
      kind: 'automation.create',
      automation: {
        id: automationId,
        name: 'Note changes',
        config: {
          trigger: { kind: 'recordUpdated', tableId: projects, fieldIds: [ids.status] },
          steps: [
            {
              id: 'step-note',
              kind: 'updateRecord',
              tableId: projects,
              record: 'trigger',
              values: { [ids.notes]: `Status of {{trigger.record.${ids.name}}} changed` },
            },
          ],
        },
      },
    },
    {
      kind: 'interface.create',
      interface: {
        id: newId('interface'),
        name: 'Portal',
        pages: [
          {
            id: 'page-home',
            name: 'Home',
            blocks: [
              {
                id: 'block-list',
                kind: 'records',
                place,
                source: { tableId: projects, viewId: views.all },
                fieldIds: [ids.status, ids.budget],
              },
              { id: 'block-text', kind: 'text', place: { ...place, y: 2 }, text: 'Welcome' },
            ],
          },
        ],
      },
    },
    {
      kind: 'script.create',
      script: {
        id: newId('script'),
        name: 'Count projects',
        description: 'Counts them',
        source: `const found = await records.find('${projects}', { limit: 100 })\nawait output.text(found.length + ' in ${ids.name}')`,
      },
    },
  ]);
  await commands(databaseId, [{ kind: 'automation.update', automationId, enabled: true }]);
  // The database's theme, and links anyone can open.
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'databases')}
    SET settings = ${JSON.stringify({ theme: { id: 'nature', scheme: 'grove' } })}::jsonb WHERE id = ${databaseId}`,
  );
  expect((await call('PUT', `/api/views/${views.all}/shared-view`)).status).toBe(200);
  expect((await call('PUT', `/api/views/${views.intake}/public-form`)).status).toBe(200);
  schema = await schemaOf(databaseId);
  expect(schema.fields.some((field) => field.id === ids.scratch)).toBe(false);
  return {
    databaseId,
    projects,
    tasks,
    ids,
    views,
    choices,
    records,
    files: { [report.id]: bytes.report, [plan.id]: bytes.plan },
  };
}

const ID = /\b[a-z]{2,3}[0-9A-Za-z]{14}\b/g;

/**
 * Everything a database holds, with every ID replaced by a name that says what it points at, so a
 * copy with new IDs reads the same as its original wherever the two agree.
 */
async function canonical(databaseId: string) {
  const schema = await schemaOf(databaseId);
  const names = new Map<string, string>();
  const tableName = (id: string) => schema.tables.find((table) => table.id === id)!.name;
  for (const table of schema.tables) names.set(table.id, `table:${table.name}`);
  for (const field of schema.fields) {
    names.set(field.id, `field:${tableName(field.tableId)}.${field.name}`);
    if (field.type === 'singleSelect' || field.type === 'multipleSelect')
      for (const choice of field.options.choices)
        names.set(choice.id, `choice:${tableName(field.tableId)}.${field.name}.${choice.name}`);
  }
  for (const view of schema.views) names.set(view.id, `view:${tableName(view.tableId)}.${view.name}`);
  for (const item of schema.dashboards ?? []) names.set(item.id, `dashboard:${item.name}`);
  for (const item of schema.automations ?? []) names.set(item.id, `automation:${item.name}`);
  for (const item of schema.interfaces ?? []) names.set(item.id, `interface:${item.name}`);
  for (const item of schema.scripts ?? []) names.set(item.id, `script:${item.name}`);
  const pages = new Map<string, RowsPage>();
  for (const table of schema.tables) {
    const grid = schema.views.find((view) => view.tableId === table.id && view.position === 0)!;
    const page = await rowsOf(grid.id);
    pages.set(table.id, page);
    for (const row of page.rows)
      names.set(row!.id, `record:${table.name}.${String(row!.values[table.primaryFieldId])}`);
    for (const [id, file] of Object.entries(page.attachments ?? {})) names.set(id, `file:${file.name}`);
  }
  const named = <T>(value: T): T =>
    JSON.parse(JSON.stringify(value).replace(ID, (id) => names.get(id) ?? id)) as T;
  const settings = await query<{ settings: unknown }>(
    server.pool,
    sql`SELECT settings FROM ${ident(server.schemas.app, 'databases')} WHERE id = ${databaseId}`,
  );
  return {
    names,
    pages,
    schema,
    shape: named({
      database: {
        description: schema.database.description,
        icon: schema.database.icon,
        color: schema.database.color,
        settings: settings.rows[0]!.settings,
      },
      tables: schema.tables.map((table) => ({
        name: table.name,
        description: table.description,
        position: table.position,
        primaryFieldId: table.primaryFieldId,
        fields: schema.fields
          .filter((field) => field.tableId === table.id)
          .map(({ createdAt: _created, updatedAt: _updated, ...field }) => field),
        views: schema.views
          .filter((view) => view.tableId === table.id)
          .map(({ createdAt: _created, updatedAt: _updated, createdBy: _by, ...view }) => view),
        rows: pages.get(table.id)!.rows,
        attachments: Object.values(pages.get(table.id)!.attachments ?? {}).map(
          ({ url: _url, thumbnails: _thumbnails, ...file }) => file,
        ),
      })),
      dashboards: (schema.dashboards ?? []).map(
        ({ createdAt: _c, updatedAt: _u, databaseId: _d, ...item }) => item,
      ),
      automations: (schema.automations ?? []).map(({ name, config, position }) => ({
        name,
        config,
        position,
      })),
      interfaces: (schema.interfaces ?? []).map(
        ({ createdAt: _c, updatedAt: _u, databaseId: _d, ...item }) => item,
      ),
      scripts: (schema.scripts ?? []).map(
        ({ createdAt: _c, updatedAt: _u, databaseId: _d, ...item }) => item,
      ),
    }),
  };
}

async function takeSnapshot(databaseId: string, name = 'Before the launch', who: Who = server.owner) {
  return ok<SnapshotMeta>('POST', `/api/databases/${databaseId}/snapshots`, { name }, who);
}

async function restore(snapshotId: string, name = 'Restored', who: Who = server.owner) {
  const copy = await ok<DatabaseCopy>('POST', `/api/snapshots/${snapshotId}/restore`, { name }, who);
  const done = await finished(copy, who);
  expect(done, JSON.stringify(done)).toMatchObject({ state: 'finished' });
  return done;
}

it('preserves never-published automation drafts through snapshot restore', async () => {
  const small = await smallDatabase('Draft snapshot');
  const automationId = newId('automation');
  const before = await schemaOf(small.databaseId);
  const tableId = before.tables[0]!.id;
  const stepId = randomUUID();
  const config = {
    trigger: { kind: 'recordCreated', tableId },
    steps: [
      { id: stepId, name: '', kind: 'createRecord', tableId, values: { [small.nameField]: 'Created' } },
    ],
  };
  await commands(small.databaseId, [
    {
      kind: 'automation.create',
      automation: { id: automationId, name: 'Unpublished', config, draftOnly: true },
    },
  ]);
  const snapshot = await takeSnapshot(small.databaseId);
  const done = await restore(snapshot.id);
  const schema = await schemaOf(done.databaseId!);
  const automation = schema.automations![0]!;
  expect(automation).toMatchObject({
    enabled: false,
    publishedAt: null,
    config: { trigger: { kind: 'webhook' }, steps: [] },
    draft: {
      config: {
        trigger: { kind: 'recordCreated', tableId: schema.tables[0]!.id },
        steps: [
          {
            id: stepId,
            kind: 'createRecord',
            tableId: schema.tables[0]!.id,
            values: { [schema.tables[0]!.primaryFieldId]: 'Created' },
          },
        ],
      },
    },
  });
  const rejected = await ok<CommandBatchResult>('POST', `/api/databases/${done.databaseId!}/commands`, {
    clientId,
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        kind: 'automation.update',
        automationId: automation.id,
        enabled: true,
      },
    ],
  });
  expect(rejected.results[0]).toMatchObject({ status: 'rejected' });
  await commands(done.databaseId!, [{ kind: 'automation.publish', automationId: automation.id }]);
  const published = (await schemaOf(done.databaseId!)).automations![0]!;
  expect(published).toMatchObject({ version: 1, draft: null, config: automation.draft!.config });
  expect(published.publishedAt).not.toBeNull();
});

it('preserves named functions through snapshots, duplicates, and templates before restoring formulas', async () => {
  const small = await smallDatabase('Named functions');
  const definition = {
    name: 'Z_DOUBLE',
    parameters: ['amount'],
    body: 'amount * 2',
    description: 'Double an amount',
  };
  const wrapper = {
    name: 'A_TOTAL',
    parameters: ['value'],
    body: 'z_double(value) + 4',
    description: 'Add four',
  };
  await commands(small.databaseId, [
    { kind: 'namedFunction.create', functionId: newId('namedFunction'), definition },
    { kind: 'namedFunction.create', functionId: newId('namedFunction'), definition: wrapper },
    {
      kind: 'field.create',
      tableId: small.tableId,
      field: {
        id: newId('field'),
        name: 'Total',
        type: 'formula',
        options: { expression: 'A_TOTAL({Count})' },
      },
    },
  ]);
  const snapshot = await takeSnapshot(small.databaseId);
  const response = await server.app.inject({
    url: `/api/snapshots/${snapshot.id}/download`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  const archive = response.json() as { namedFunctions?: unknown[] };
  expect(archive.namedFunctions).toEqual(
    expect.arrayContaining([expect.objectContaining(definition), expect.objectContaining(wrapper)]),
  );
  const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
  const standalone = await withTransaction(server.pool, async (db) => {
    await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    return writeArchive(
      db,
      server.schemas,
      small.databaseId,
      { records: 'all', comments: true },
      new AccessScope(db, server.schemas, actor!),
    );
  });
  const importedId = newId('database');
  await restoreArchive(server.app.ctx, actor!, {
    archive: DatabaseArchive.parse(JSON.parse(JSON.stringify(standalone))),
    databaseId: importedId,
    name: 'Standalone functions',
  });
  const restored = await restore(snapshot.id);
  const copied = await finished(
    await ok<DatabaseCopy>('POST', `/api/databases/${small.databaseId}/duplicate`, {
      name: 'Functions copy',
      withRecords: true,
    }),
  );
  expect(copied.state, JSON.stringify(copied)).toBe('finished');
  const saved = await ok<TemplateSummary>('POST', `/api/databases/${small.databaseId}/save-as-template`, {
    name: 'Functions template',
    samples: 2,
  });
  const made = await ok<DatabaseSchema>('POST', '/api/databases/from-template', {
    id: newId('database'),
    templateId: saved.id,
    name: 'From functions',
  });
  for (const schema of [
    await schemaOf(importedId),
    await schemaOf(restored.databaseId!),
    await schemaOf(copied.databaseId!),
    made,
  ]) {
    expect(schema.namedFunctions).toEqual(
      expect.arrayContaining([expect.objectContaining(definition), expect.objectContaining(wrapper)]),
    );
    const total = schema.fields.find((field) => field.name === 'Total')!;
    expect(total.options).toMatchObject({ expression: expect.stringContaining('A_TOTAL(') });
    const rows = await rowsOf(schema.views[0]!.id);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row!.values[total.id]).toBe(6);
      expect(row!.errors?.[total.id]).toBeUndefined();
    }
  }
});

describe('snapshots, restored part by part', () => {
  let built: Built;
  let original: Awaited<ReturnType<typeof canonical>>;
  let copy: Awaited<ReturnType<typeof canonical>>;
  let done: DatabaseCopy;

  beforeAll(async () => {
    built = await buildEverything();
    const snapshot = await takeSnapshot(built.databaseId);
    expect(snapshot).toMatchObject({ name: 'Before the launch', kind: 'manual', tables: 2, records: 6 });
    done = await restore(snapshot.id, 'Everything, restored');
    original = await canonical(built.databaseId);
    copy = await canonical(done.databaseId!);
  }, 120_000);

  it('lists the snapshot with who took it, when, and its size', async () => {
    const list = await ok<SnapshotList>('GET', `/api/databases/${built.databaseId}/snapshots`);
    expect(list.snapshots).toHaveLength(1);
    expect(list.snapshots[0]).toMatchObject({
      name: 'Before the launch',
      kind: 'manual',
      createdBy: server.owner.userId,
      tables: 2,
      records: 6,
    });
    expect(list.snapshots[0]!.size).toBeGreaterThan(100);
  });

  it('makes a new database with every ID new', () => {
    expect(done.databaseId).not.toBe(built.databaseId);
    const originalIds = new Set(original.names.keys());
    for (const id of copy.names.keys())
      // User IDs are the organization's people, the same in both.
      if (!id.startsWith('usr')) expect(originalIds.has(id), id).toBe(false);
    expect(copy.schema.database).toMatchObject({ name: 'Everything, restored', role: 'owner' });
  });

  it('keeps every table, field, view, and record, with the same values', () => {
    expect(copy.shape.tables).toEqual(original.shape.tables);
    expect(copy.shape.database).toEqual(original.shape.database);
    expect(copy.shape.database.settings).toEqual({ theme: { id: 'nature', scheme: 'grove' } });
  });

  it('computes formulas, lookups, rollups, and counts the same, and follows links', () => {
    const alpha = (page: RowsPage, names: Map<string, string>, id: (name: string) => string) =>
      page.rows.find((row) => names.get(row!.id) === 'record:Projects.Alpha')!.values[id('Summary')];
    const field = (state: typeof copy) => (name: string) =>
      state.schema.fields.find((item) => item.name === name && item.tableId === state.schema.tables[0]!.id)!
        .id;
    const projects = (state: typeof copy) => state.pages.get(state.schema.tables[0]!.id)!;
    expect(alpha(projects(copy), copy.names, field(copy))).toBe('Alpha has 2 tasks, 4.5 hours');
    expect(alpha(projects(original), original.names, field(original))).toBe('Alpha has 2 tasks, 4.5 hours');
    const shaped = copy.shape.tables.find((table) => table.name === 'Tasks')!.rows;
    const write = shaped.find((row) => row!.id === 'record:Tasks.Write')!;
    const values = Object.fromEntries(
      Object.entries(write.values).map(([key, value]) => [key.replace('field:Tasks.', ''), value]),
    );
    expect(values).toMatchObject({
      Double: 6,
      Project: ['record:Projects.Alpha'],
      'Project status': ['choice:Projects.Status.Active'],
      'Matched project': ['record:Projects.Alpha'],
    });
  });

  it('keeps each list’s own order', async () => {
    const order = async (state: typeof copy, databaseId: string) => {
      const schema = await schemaOf(databaseId);
      const list = schema.views.find((view) => view.name === 'List')!;
      return (await rowsOf(list.id)).rows.map((row) => state.names.get(row!.id));
    };
    const before = await order(original, built.databaseId);
    expect(before).toEqual(['record:Projects.Gamma', 'record:Projects.Alpha', 'record:Projects.Beta']);
    expect(await order(copy, done.databaseId!)).toEqual(before);
  });

  it('copies the files, which open with the same bytes', async () => {
    const files = Object.values(copy.pages.get(copy.schema.tables[0]!.id)!.attachments ?? {});
    expect(files.map((file) => file.name).sort()).toEqual(['plan.txt', 'report.txt']);
    for (const file of files) {
      expect(built.files[file.id]).toBeUndefined();
      const response = await server.app.inject({ url: file.url, headers: server.owner.headers });
      expect(response.statusCode).toBe(200);
      const original = Object.entries(built.files).find(([, bytes]) => bytes.length === file.size)!;
      expect(response.rawPayload.equals(original[1])).toBe(true);
    }
  });

  it('keeps comments, dashboards, interfaces, and scripts, and turns automations off', async () => {
    expect(copy.shape.dashboards).toEqual(original.shape.dashboards);
    expect(copy.shape.interfaces).toEqual(original.shape.interfaces);
    // A script's code names the copy's own tables and fields.
    expect(copy.shape.scripts).toEqual(original.shape.scripts);
    expect(copy.shape.scripts).toMatchObject([
      { name: 'Count projects', source: expect.stringContaining("records.find('table:Projects'") },
    ]);
    expect(copy.schema.scripts![0]!.source).not.toContain(built.projects);
    expect(copy.shape.automations).toEqual(original.shape.automations);
    expect(original.schema.automations!.every((automation) => automation.enabled)).toBe(true);
    expect(copy.schema.automations!.map((automation) => automation.enabled)).toEqual([false]);
    const alpha = [...copy.names].find(([, name]) => name === 'record:Projects.Alpha')![0];
    const comments = await ok<{ comments: Array<{ body: string; authorId: string }> }>(
      'GET',
      `/api/tables/${copy.schema.tables[0]!.id}/records/${alpha}/comments`,
    );
    expect(comments.comments).toMatchObject([
      {
        body: 'Looks good to me',
        authorId: server.owner.userId,
        fieldId: copy.schema.fields.find((field) => field.name === 'Notes')!.id,
      },
    ]);
  });

  it('can enable copied automations and retains their first published version', async () => {
    const automation = copy.schema.automations![0]!;
    expect(automation.publishedAt).not.toBeNull();
    await commands(done.databaseId!, [
      { kind: 'automation.update', automationId: automation.id, enabled: true },
    ]);
    await commands(done.databaseId!, [
      { kind: 'automation.update', automationId: automation.id, enabled: false },
    ]);
    await commands(done.databaseId!, [
      { kind: 'automation.update', automationId: automation.id, config: { ...automation.config, steps: [] } },
    ]);
    await commands(done.databaseId!, [{ kind: 'automation.publish', automationId: automation.id }]);
    const versions = await ok<{ versions: Array<{ version: number }> }>(
      'GET',
      `/api/automations/${automation.id}/versions`,
    );
    expect(versions.versions.map((version) => version.version)).toEqual([2, 1]);
  });

  it('never copies shared links, trashed things, or sharing', async () => {
    for (const table of ['shared_views', 'public_forms']) {
      const rows = await query<{ count: string }>(
        server.pool,
        sql`SELECT count(*) FROM ${ident(server.schemas.app, table)} WHERE database_id = ${done.databaseId!}`,
      );
      expect(rows.rows[0]!.count, table).toBe('0');
    }
    expect(copy.schema.fields.some((field) => field.name === 'Scratch')).toBe(false);
    expect(copy.names.has(built.records.delta!)).toBe(false);
    const trashed = await query<{ count: string }>(
      server.pool,
      sql`SELECT count(*) FROM ${ident(server.schemas.data, copy.schema.tables[0]!.id)} WHERE __deleted_at IS NOT NULL`,
    );
    expect(trashed.rows[0]!.count).toBe('0');
    const grants = await query<{ principal_id: string; role: string }>(
      server.pool,
      sql`SELECT principal_id, role FROM ${ident(server.schemas.app, 'grants')} WHERE resource_id = ${done.databaseId!}`,
    );
    expect(grants.rows).toEqual([{ principal_id: server.owner.userId, role: 'owner' }]);
  });

  it('downloads a snapshot as a versioned archive that names files by key and checksum', async () => {
    const snapshots = await ok<SnapshotList>('GET', `/api/databases/${built.databaseId}/snapshots`);
    const response = await server.app.inject({
      url: `/api/snapshots/${snapshots.snapshots[0]!.id}/download`,
      headers: server.owner.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toContain('Everything - Before the launch.riosoma.json');
    const archive = DatabaseArchive.parse(response.json());
    expect(archive).toMatchObject({ format: 'riosoma.database', version: 1, records: 'all' });
    expect(archive.attachments).toHaveLength(2);
    expect(archive.attachments[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(archive)).not.toContain(
      built.files[archive.attachments[0]!.id]!.toString('base64'),
    );
    const gzipped = await server.app.inject({
      url: `/api/snapshots/${snapshots.snapshots[0]!.id}/download`,
      headers: { ...server.owner.headers, 'accept-encoding': 'gzip' },
    });
    expect(gzipped.headers['content-encoding']).toBe('gzip');
    expect(gzipped.rawPayload.length).toBe(snapshots.snapshots[0]!.size);
    const events = await query<{ action: string; metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action LIKE 'databases.%' ORDER BY id`,
    );
    expect(events.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'databases.snapshot.created',
        'databases.copy.started',
        'databases.copy.finished',
        'databases.snapshot.downloaded',
      ]),
    );
    // Audit events say what happened in counts and IDs, never values.
    expect(JSON.stringify(events.rows)).not.toContain('Alpha');
  });

  it('deletes a snapshot', async () => {
    const snapshot = await takeSnapshot(built.databaseId, 'Short lived');
    expect((await call('DELETE', `/api/snapshots/${snapshot.id}`)).status).toBe(200);
    const list = await ok<SnapshotList>('GET', `/api/databases/${built.databaseId}/snapshots`);
    expect(list.snapshots.map((item) => item.name)).toEqual(['Before the launch']);
  });
});

async function smallDatabase(name = 'Small', who: Who = server.owner) {
  const databaseId = newId('database');
  const tableId = newId('table');
  const nameField = newId('field');
  const countField = newId('field');
  const viewId = newId('view');
  const created = await call(
    'POST',
    '/api/databases',
    {
      id: databaseId,
      name,
      table: {
        id: tableId,
        name: 'Items',
        fields: [
          { id: nameField, name: 'Name', type: 'text' },
          { id: countField, name: 'Count', type: 'number' },
        ],
        view: { id: viewId, name: 'Grid' },
      },
    },
    who,
  );
  expect(created.status, created.raw).toBe(200);
  const records = Array.from({ length: 5 }, (_, index) => ({
    id: newId('record'),
    values: { [nameField]: `Item ${index + 1}`, [countField]: 1 },
  }));
  await commands(databaseId, [{ kind: 'record.create', tableId, records }], who);
  return { databaseId, tableId, nameField, countField, viewId, records };
}

describe('a snapshot taken while someone edits', () => {
  it('reads the whole database as of one moment', async () => {
    const small = await smallDatabase('Busy');
    const otherTable = newId('table');
    const otherField = newId('field');
    await commands(small.databaseId, [
      {
        kind: 'table.create',
        table: {
          id: otherTable,
          name: 'Totals',
          fields: [{ id: otherField, name: 'Total', type: 'number' }],
          view: { id: newId('view'), name: 'Grid' },
        },
      },
    ]);
    const total = newId('record');
    await commands(small.databaseId, [
      { kind: 'record.create', tableId: otherTable, records: [{ id: total, values: { [otherField]: 5 } }] },
    ]);
    // Between reading the first table and the second, another session changes both.
    const archive = await (async () => {
      const client = await server.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const result = await writeArchive(
          client,
          server.schemas,
          small.databaseId,
          {
            records: 'all',
            comments: true,
            afterTable: async (tableId) => {
              if (tableId !== small.tableId) return;
              await commands(small.databaseId, [
                {
                  kind: 'record.update',
                  tableId: small.tableId,
                  records: small.records.map((record) => ({
                    id: record.id,
                    values: { [small.countField]: 2 },
                  })),
                },
                {
                  kind: 'record.update',
                  tableId: otherTable,
                  records: [{ id: total, values: { [otherField]: 10 } }],
                },
              ]);
            },
          },
          new AccessScope(
            client,
            server.schemas,
            (await actorFor(client, server.schemas, server.owner.userId, server.owner.info.org.id))!,
          ),
        );
        await client.query('COMMIT');
        return result;
      } finally {
        client.release();
      }
    })();
    const counts = archive.tables[0]!.records.map((record) => record.values[small.countField]);
    expect(counts).toEqual([1, 1, 1, 1, 1]);
    expect(archive.tables[1]!.records[0]!.values[otherField]).toBe(5);
    // Through the API too: every snapshot taken during a stream of edits agrees with itself.
    let editing = true;
    const edits = (async () => {
      for (let value = 3; editing && value < 40; value++)
        await commands(small.databaseId, [
          {
            kind: 'record.update',
            tableId: small.tableId,
            records: small.records.map((record) => ({
              id: record.id,
              values: { [small.countField]: value },
            })),
          },
        ]);
    })();
    const snapshots = [];
    for (let index = 0; index < 4; index++)
      snapshots.push(await takeSnapshot(small.databaseId, `During ${index}`));
    editing = false;
    await edits;
    for (const snapshot of snapshots) {
      const response = await server.app.inject({
        url: `/api/snapshots/${snapshot.id}/download`,
        headers: server.owner.headers,
      });
      const read = DatabaseArchive.parse(response.json());
      // Each edit changes every record in one command, so a snapshot never holds two values.
      const values = new Set(read.tables[0]!.records.map((record) => record.values[small.countField]));
      expect(values.size).toBe(1);
    }
  });
});

describe('automatic snapshots', () => {
  it('keeps the newest of each of the last seven days and four weeks', () => {
    const days = Array.from({ length: 40 }, (_, index) =>
      new Date(Date.UTC(2026, 8, 30) - index * 86_400_000).toISOString().slice(0, 10),
    );
    const snapshots = days.map((day) => ({ id: day, day }));
    const kept = [...keptSnapshots(snapshots, { keepDaily: 7, keepWeekly: 4 })].sort().reverse();
    // The last seven days, then the newest of each of the last four weeks.  The week under way and
    // the one before it are already kept as days, so two more weeks' Sundays make up the rest.
    expect(kept).toEqual([...days.slice(0, 7), '2026-09-20', '2026-09-13']);
    expect(new Set(kept.map(weekOf)).size).toBe(4);
    for (const day of kept.slice(7)) expect(new Date(`${day}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(keptSnapshots(snapshots, { keepDaily: 1, keepWeekly: 0 })).toEqual(new Set([days[0]]));
  });

  it('snapshots the databases that changed that day, and follows the organization’s settings', async () => {
    const changed = await smallDatabase('Changed yesterday');
    const quiet = await smallDatabase('Quiet');
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    // Everything happened today in the test, so the quiet one's changes move to last week.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'changes')} SET at = CASE WHEN database_id = ${quiet.databaseId}
        THEN now() - interval '8 days' ELSE ${yesterday} END
      WHERE database_id = ANY(${[changed.databaseId, quiet.databaseId]}::text[])`,
    );
    const first = await runDailySnapshots(server.ctx, now);
    const list = async (databaseId: string) =>
      (await ok<SnapshotList>('GET', `/api/databases/${databaseId}/snapshots`)).snapshots;
    expect(await list(changed.databaseId)).toMatchObject([
      { kind: 'automatic', createdBy: null, records: 5 },
    ]);
    expect(await list(quiet.databaseId)).toEqual([]);
    const filters = { action: 'databases.snapshot.automatic', resource: changed.databaseId };
    const history = await ok<AuditPage>('GET', `/api/org/audit?${new URLSearchParams(filters)}`);
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({ actorId: null, metadata: { databaseId: changed.databaseId } });
    const exported = await ok<AuditEntry[]>('POST', '/api/org/audit/export', { filters, format: 'json' });
    expect(exported).toEqual(history.events);
    expect(await ok('GET', '/api/org/audit/integrity')).toMatchObject({ firstBreak: null });
    // Running again the same day takes nothing new.
    const again = await runDailySnapshots(server.ctx, now);
    expect(again.taken.filter((id) => first.taken.includes(id))).toEqual([]);
    expect(await list(changed.databaseId)).toHaveLength(1);

    // Old automatic snapshots beyond what the settings keep go, and snapshots taken by hand stay.
    const manual = await takeSnapshot(changed.databaseId, 'Mine');
    const [automatic] = await list(changed.databaseId).then((items) =>
      items.filter((item) => item.kind === 'automatic'),
    );
    for (let index = 2; index < 60; index++) {
      const day = new Date(now.getTime() - index * 86_400_000).toISOString().slice(0, 10);
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'database_snapshots')}
        (id, org_id, database_id, name, kind, day, change_seq, tables, records, size, archive, created_at)
        SELECT ${newId('snapshot')}, org_id, database_id, '', 'automatic', ${day}::date, change_seq, tables, records,
          size, archive, ${day}::date FROM ${ident(server.schemas.app, 'database_snapshots')} WHERE id = ${automatic!.id}`,
      );
    }
    const settings = await ok('PUT', '/api/settings/snapshots', {
      automatic: true,
      keepDaily: 3,
      keepWeekly: 2,
    });
    expect(settings).toEqual({ automatic: true, keepDaily: 3, keepWeekly: 2 });
    await runDailySnapshots(server.ctx, now);
    const left = await list(changed.databaseId);
    expect(left.filter((item) => item.kind === 'manual').map((item) => item.id)).toEqual([manual.id]);
    const automaticLeft = left.filter((item) => item.kind === 'automatic');
    expect(automaticLeft.length).toBeGreaterThanOrEqual(3);
    expect(automaticLeft.length).toBeLessThanOrEqual(4);
    const expired = await ok<AuditPage>(
      'GET',
      `/api/org/audit?${new URLSearchParams({ action: 'databases.snapshot.expired', resource: changed.databaseId })}`,
    );
    expect(expired.events).toHaveLength(1);
    expect(expired.events[0]).toMatchObject({ actorId: null, metadata: { databaseId: changed.databaseId } });

    // Turned off, nothing new is taken.
    await ok('PUT', '/api/settings/snapshots', { automatic: false, keepDaily: 7, keepWeekly: 4 });
    const later = new Date(now.getTime() + 86_400_000);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'changes')} SET at = ${now} WHERE database_id = ${quiet.databaseId}`,
    );
    expect((await runDailySnapshots(server.ctx, later)).taken).toEqual([]);
    await ok('PUT', '/api/settings/snapshots', { automatic: true, keepDaily: 7, keepWeekly: 4 });
    expect(
      (await call('PUT', '/api/settings/snapshots', { automatic: true, keepDaily: 7, keepWeekly: 4 }, member))
        .status,
    ).toBe(403);
  });
});

describe('who may take a copy', () => {
  it('keeps private cell comments private after their field is trashed', async () => {
    const small = await smallDatabase('Private discussion');
    await commands(small.databaseId, [
      {
        kind: 'comment.create',
        tableId: small.tableId,
        recordId: small.records[0]!.id,
        comment: { id: newId('comment'), fieldId: small.countField, body: 'Private discussion' },
      },
      {
        kind: 'comment.create',
        tableId: small.tableId,
        recordId: small.records[0]!.id,
        comment: { id: newId('comment'), body: 'Record discussion' },
      },
    ]);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${small.databaseId}, 'user', ${member.userId}, 'creator')`,
    );
    await ok('PUT', `/api/fields/${small.countField}/permissions`, {
      locked: null,
      restricted: { roles: [], users: [] },
    });
    const duplicate = () =>
      call(
        'POST',
        `/api/databases/${small.databaseId}/duplicate`,
        { name: 'Copy', withRecords: true },
        member,
      );
    expect((await duplicate()).status).toBe(403);
    const snapshot = await takeSnapshot(small.databaseId, 'Before trash');
    await commands(small.databaseId, [{ kind: 'field.trash', fieldId: small.countField }]);
    expect((await duplicate()).status).toBe(403);
    expect((await call('GET', `/api/snapshots/${snapshot.id}/download`, undefined, member)).status).toBe(403);
    expect(
      (await call('POST', `/api/snapshots/${snapshot.id}/restore`, { name: 'Copy' }, member)).status,
    ).toBe(403);
    const copy = await finished(
      await ok<DatabaseCopy>('POST', `/api/databases/${small.databaseId}/duplicate`, {
        name: 'Owner copy',
        withRecords: true,
      }),
    );
    expect(copy.state).toBe('finished');
    const copied = await query<{ body: string; field_id: string | null }>(
      server.pool,
      sql`SELECT body, field_id FROM ${ident(server.schemas.app, 'comments')} WHERE database_id = ${copy.databaseId}`,
    );
    expect(copied.rows).toEqual([{ body: 'Record discussion', field_id: null }]);
    const original = await query<{ field_id: string }>(
      server.pool,
      sql`SELECT field_id FROM ${ident(server.schemas.app, 'comments')}
      WHERE database_id = ${small.databaseId} AND body = 'Private discussion'`,
    );
    expect(original.rows).toEqual([{ field_id: small.countField }]);
  });

  it('refuses people who can’t change the schema or can’t see every field', async () => {
    const small = await smallDatabase('Guarded');
    const grant = async (role: string) =>
      query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
        (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
        VALUES (${server.owner.info.org.id}, 'database', ${small.databaseId}, 'user', ${member.userId}, ${role})
        ON CONFLICT (resource_kind, resource_id, principal_kind, principal_id) DO UPDATE SET role = EXCLUDED.role`,
      );
    await grant('editor');
    const refused = await call(
      'POST',
      `/api/databases/${small.databaseId}/snapshots`,
      { name: 'Nope' },
      member,
    );
    expect(refused.status).toBe(403);
    await grant('creator');
    const snapshot = await takeSnapshot(small.databaseId, 'Allowed', member);
    // A person with a field they can't see can't take a snapshot, download one, restore one, or
    // duplicate the database.
    const tableOf = await query<{ table_id: string }>(
      server.pool,
      sql`SELECT table_id FROM ${ident(server.schemas.app, 'fields')} WHERE id = ${small.countField}`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'field_permissions')}
        (field_id, org_id, database_id, table_id, restricted)
        VALUES (${small.countField}, ${server.owner.info.org.id}, ${small.databaseId},
          ${tableOf.rows[0]!.table_id}, ${JSON.stringify({ roles: [], users: [] })}::jsonb)`,
    );
    for (const [method, url, payload] of [
      ['POST', `/api/databases/${small.databaseId}/snapshots`, { name: 'Hidden' }],
      ['GET', `/api/snapshots/${snapshot.id}/download`, undefined],
      ['POST', `/api/snapshots/${snapshot.id}/restore`, { name: 'Hidden' }],
      ['POST', `/api/databases/${small.databaseId}/duplicate`, { name: 'Hidden', withRecords: true }],
      ['DELETE', `/api/snapshots/${snapshot.id}`, undefined],
    ] as const) {
      const response = await call<{ error: { messageKey: string } }>(method, url, payload, member);
      expect(response.status, `${method} ${url}`).toBe(403);
      expect(response.body.error.messageKey).toBe('archives.restricted');
    }
    // The owner, who sees everything, still can.
    expect((await call('GET', `/api/snapshots/${snapshot.id}/download`)).status).toBe(200);
    const events = await query<{ count: string }>(
      server.pool,
      sql`SELECT count(*) FROM ${ident(server.schemas.audit, 'events')}
      WHERE action = 'databases.snapshot.created' AND actor_id = ${member.userId}`,
    );
    expect(events.rows[0]!.count).toBe('1');
  });
});

describe('duplicating a database', () => {
  it('copies it with records, or only its structure', async () => {
    const small = await smallDatabase('Original');
    const withRecords = await finished(
      await ok<DatabaseCopy>('POST', `/api/databases/${small.databaseId}/duplicate`, {
        name: 'Original copy',
        withRecords: true,
      }),
    );
    expect(withRecords).toMatchObject({
      state: 'finished',
      kind: 'duplicate',
      report: { records: 5, tables: 1 },
    });
    const schema = await schemaOf(withRecords.databaseId!);
    const rows = await rowsOf(schema.views[0]!.id);
    expect(rows.rows.map((row) => row!.values[schema.fields[0]!.id])).toEqual(
      small.records.map((record) => record.values[small.nameField]),
    );
    const bare = await finished(
      await ok<DatabaseCopy>('POST', `/api/databases/${small.databaseId}/duplicate`, {
        name: 'Just the shape',
        withRecords: false,
      }),
    );
    const bareSchema = await schemaOf(bare.databaseId!);
    expect(bareSchema.fields.map((field) => field.name)).toEqual(['Name', 'Count']);
    expect((await rowsOf(bareSchema.views[0]!.id)).total).toBe(0);
    // The new database is on the person's home screen, and a new record numbers on from the copy's.
    const home = await ok<Array<{ id: string }>>('GET', '/api/databases');
    expect(home.map((item) => item.id)).toEqual(
      expect.arrayContaining([withRecords.databaseId, bare.databaseId]),
    );
    await commands(withRecords.databaseId!, [
      {
        kind: 'record.create',
        tableId: schema.tables[0]!.id,
        records: [{ id: newId('record'), values: {} }],
      },
    ]);
    const after = await rowsOf(schema.views[0]!.id);
    expect(after.total).toBe(6);
  });

  it('copies a select whose source table is in the trash', async () => {
    const small = await smallDatabase('Trashed source');
    const places = newId('table');
    const placeName = newId('field');
    const harbor = newId('record');
    const select = newId('field');
    await commands(small.databaseId, [
      {
        kind: 'table.create',
        table: {
          id: places,
          name: 'Places',
          view: { id: newId('view'), name: 'Grid' },
          fields: [{ id: placeName, name: 'Name', type: 'text' }],
          records: [],
        },
      },
    ]);
    await commands(small.databaseId, [
      {
        kind: 'record.create',
        tableId: places,
        records: [{ id: harbor, values: { [placeName]: 'Harbor' } }],
      },
      {
        kind: 'field.create',
        tableId: small.tableId,
        field: {
          id: select,
          name: 'Place',
          type: 'singleSelect',
          options: { choices: [], source: { tableId: places } },
        },
      },
    ]);
    await commands(small.databaseId, [
      {
        kind: 'record.update',
        tableId: small.tableId,
        records: [{ id: small.records[0]!.id, values: { [select]: await sourceChoiceId(harbor) } }],
      },
    ]);
    await commands(small.databaseId, [{ kind: 'table.trash', tableId: places }]);
    const copy = await finished(
      await ok<DatabaseCopy>('POST', `/api/databases/${small.databaseId}/duplicate`, {
        name: 'Trashed source copy',
        withRecords: true,
      }),
    );
    expect(copy).toMatchObject({ state: 'finished', report: { tables: 1, records: 5 } });
    const schema = await schemaOf(copy.databaseId!);
    expect(schema.tables.map((table) => table.name)).toEqual(['Items']);
    // The copy keeps the select, which no longer reads from a table it doesn't have.
    const place = schema.fields.find((field) => field.name === 'Place');
    expect(place).toMatchObject({ type: 'singleSelect' });
    expect(place?.type === 'singleSelect' && place.options.source).toBeFalsy();
    const rows = await rowsOf(schema.views[0]!.id);
    expect(rows.rows.map((row) => row!.values[schema.fields[0]!.id])).toEqual(
      small.records.map((record) => record.values[small.nameField]),
    );
  });

  it('answers a copy only to the person who started it', async () => {
    const small = await smallDatabase('Private copy');
    const copy = await ok<DatabaseCopy>('POST', `/api/databases/${small.databaseId}/duplicate`, {
      name: 'Mine',
      withRecords: true,
    });
    await server.ctx.databaseCopies!.settled(copy.id);
    expect((await call('GET', `/api/database-copies/${copy.id}`, undefined, member)).status).toBe(404);
  });
});

describe('synced tables in a copy', () => {
  async function syncedDatabase() {
    const small = await smallDatabase('With a synced table');
    const tableId = newId('table');
    const keyField = newId('field');
    const nameField = newId('field');
    const noteField = newId('field');
    await commands(small.databaseId, [
      {
        kind: 'table.create',
        table: {
          id: tableId,
          name: 'Remote items',
          source: {
            sourceId: source.id,
            select: { kind: 'object', object: { schema: null, name: tableId } },
            keyColumns: ['id'],
            everyMinutes: null,
          },
          fields: [
            { id: keyField, name: 'Key', type: 'number', source: { column: 'id', sourceType: '' } },
            { id: nameField, name: 'Name', type: 'text', source: { column: 'name', sourceType: '' } },
            { id: noteField, name: 'Note', type: 'text' },
          ],
          view: { id: newId('view'), name: 'Grid' },
        },
      },
    ]);
    remote.set(tableId, [
      { key: sourceKey([1]), values: { id: 1, name: 'One' } },
      { key: sourceKey([2]), values: { id: 2, name: 'Two' } },
    ]);
    for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
    return { ...small, synced: tableId, keyField, nameField, noteField };
  }

  it('stays synced when the source is there and the person may use it', async () => {
    const database = await syncedDatabase();
    const snapshot = await takeSnapshot(database.databaseId, 'Synced');
    const done = await restore(snapshot.id, 'Still synced');
    expect(done.report).toMatchObject({ syncedTables: 1, unsyncedTables: 0 });
    const schema = await schemaOf(done.databaseId!);
    const table = schema.tables.find((item) => item.name === 'Remote items')!;
    expect(table.source).toMatchObject({ sourceId: source.id, keyColumns: ['id'] });
    const before = await rowsOf(schema.views.find((view) => view.tableId === table.id)!.id);
    // A sync of the copy keeps its records, matched by their keys.
    // The copy reads the same object in the source as the original does.
    remote.set(database.synced, [
      { key: sourceKey([1]), values: { id: 1, name: 'One, renamed' } },
      { key: sourceKey([2]), values: { id: 2, name: 'Two' } },
    ]);
    for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
    const after = await rowsOf(schema.views.find((view) => view.tableId === table.id)!.id);
    expect(after.rows.map((row) => row!.id)).toEqual(before.rows.map((row) => row!.id));
    const name = schema.fields.find((field) => field.tableId === table.id && field.name === 'Name')!;
    expect(after.rows.map((row) => row!.values[name.id])).toEqual(['One, renamed', 'Two']);
  });

  it('comes back as an ordinary table when the person may not use the source', async () => {
    const database = await syncedDatabase();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${database.databaseId}, 'user', ${member.userId}, 'creator')`,
    );
    const snapshot = await takeSnapshot(database.databaseId, 'Synced', member);
    const done = await restore(snapshot.id, 'Ordinary now', member);
    expect(done.report).toMatchObject({ syncedTables: 0, unsyncedTables: 1, records: 7 });
    const schema = await schemaOf(done.databaseId!, member);
    const table = schema.tables.find((item) => item.name === 'Remote items')!;
    expect(table.source).toBeUndefined();
    expect(schema.fields.filter((field) => field.tableId === table.id).every((field) => !field.source)).toBe(
      true,
    );
    // Its records are ordinary ones now, which people can change.
    const page = await ok<RowsPage>(
      'GET',
      `/api/views/${schema.views.find((view) => view.tableId === table.id)!.id}/rows?refresh=1`,
      undefined,
      member,
    );
    const name = schema.fields.find((field) => field.tableId === table.id && field.name === 'Name')!;
    await commands(
      done.databaseId!,
      [
        {
          kind: 'record.update',
          tableId: table.id,
          records: [{ id: page.rows[0]!.id, values: { [name.id]: 'Mine' } }],
        },
      ],
      member,
    );
  });
});

describe('templates the organization saves', () => {
  it('saves a database with sample records, lists it beside the built-in ones, and makes databases from it', async () => {
    const small = await smallDatabase('Team tracker');
    const saved = await ok<TemplateSummary>('POST', `/api/databases/${small.databaseId}/save-as-template`, {
      name: 'Team tracker',
      description: 'How our team tracks things',
      category: 'work',
      samples: 2,
    });
    expect(saved).toMatchObject({ name: 'Team tracker', tables: ['Items'], organization: { samples: 2 } });
    const list = await ok<TemplateSummary[]>('GET', '/api/templates', undefined, member);
    expect(list[0]).toMatchObject({ id: saved.id, name: 'Team tracker' });
    expect(list.length).toBeGreaterThan(20);
    // Anyone in the organization can start from it.
    const databaseId = newId('database');
    const schema = await ok<DatabaseSchema>(
      'POST',
      '/api/databases/from-template',
      { id: databaseId, templateId: saved.id, name: 'Our tracker' },
      member,
    );
    expect(schema.database).toMatchObject({ id: databaseId, name: 'Our tracker', role: 'owner' });
    const rows = await ok<RowsPage>(
      'GET',
      `/api/views/${schema.views[0]!.id}/rows?refresh=1`,
      undefined,
      member,
    );
    expect(rows.rows.map((row) => row!.values[schema.fields[0]!.id])).toEqual(['Item 1', 'Item 2']);
    // Asking again with the same ID answers the same database.
    const again = await ok<DatabaseSchema>(
      'POST',
      '/api/databases/from-template',
      { id: databaseId, templateId: saved.id, name: 'Our tracker' },
      member,
    );
    expect(again.database.id).toBe(databaseId);
    // Only organization admins save and remove templates.
    expect(
      (await call('POST', `/api/databases/${small.databaseId}/save-as-template`, { name: 'Mine' }, member))
        .status,
    ).toBe(403);
    expect((await call('DELETE', `/api/templates/${saved.id}`, undefined, member)).status).toBe(403);
    expect((await call('DELETE', `/api/templates/${saved.id}`)).status).toBe(200);
    const after = await ok<TemplateSummary[]>('GET', '/api/templates');
    expect(after.some((item) => item.id === saved.id)).toBe(false);
  });

  it('keeps each field’s default in copies and templates, and never fills one into a copied record', async () => {
    const small = await smallDatabase('Defaults kept');
    const [low, high] = [newId('choice'), newId('choice')];
    const priority = newId('field');
    await commands(small.databaseId, [
      {
        kind: 'field.create',
        tableId: small.tableId,
        field: {
          id: priority,
          name: 'Priority',
          type: 'singleSelect',
          options: {
            choices: [
              { id: low, name: 'Low', color: 'blue' },
              { id: high, name: 'High', color: 'red' },
            ],
            defaultValue: { kind: 'value', value: high },
          },
        },
      },
      {
        kind: 'field.update',
        fieldId: small.countField,
        options: { defaultValue: { kind: 'value', value: 2 } },
      },
    ]);
    const check = async (schema: DatabaseSchema) => {
      const copied = schema.fields.find((field) => field.name === 'Priority')!;
      if (copied.type !== 'singleSelect') throw new Error('expected a select');
      const copiedHigh = copied.options.choices.find((choice) => choice.name === 'High')!.id;
      // The default follows the copy's own option, which has a new ID.
      expect(copiedHigh).not.toBe(high);
      expect(copied.options.defaultValue).toEqual({ kind: 'value', value: copiedHigh });
      expect(schema.fields.find((field) => field.name === 'Count')!.options).toMatchObject({
        defaultValue: { kind: 'value', value: 2 },
      });
      const rows = await rowsOf(schema.views[0]!.id);
      expect(rows.rows.length).toBeGreaterThan(0);
      for (const row of rows.rows) {
        expect(row!.values[copied.id]).toBeNull();
        expect(row!.values[schema.fields.find((field) => field.name === 'Count')!.id]).toBe(1);
      }
    };
    const copy = await finished(
      await ok<DatabaseCopy>('POST', `/api/databases/${small.databaseId}/duplicate`, {
        name: 'Defaults copy',
        withRecords: true,
      }),
    );
    await check(await schemaOf(copy.databaseId!));
    const saved = await ok<TemplateSummary>('POST', `/api/databases/${small.databaseId}/save-as-template`, {
      name: 'Defaults template',
      samples: 2,
    });
    const made = await ok<DatabaseSchema>('POST', '/api/databases/from-template', {
      id: newId('database'),
      templateId: saved.id,
      name: 'From defaults',
    });
    await check(made);
  });

  it('keeps only the structure without samples, and never comments', async () => {
    const small = await smallDatabase('Structure only');
    await commands(small.databaseId, [
      {
        kind: 'comment.create',
        tableId: small.tableId,
        recordId: small.records[0]!.id,
        comment: { id: newId('comment'), body: 'Private note' },
      },
    ]);
    const saved = await ok<TemplateSummary>('POST', `/api/databases/${small.databaseId}/save-as-template`, {
      name: 'Bare',
    });
    const stored = await query<{ archive: Buffer }>(
      server.pool,
      sql`SELECT archive FROM ${ident(server.schemas.app, 'org_templates')} WHERE id = ${saved.id}`,
    );
    const { gunzipSync } = await import('node:zlib');
    const archive = DatabaseArchive.parse(JSON.parse(gunzipSync(stored.rows[0]!.archive).toString('utf8')));
    expect(archive.records).toBe('none');
    expect(archive.tables[0]!.records).toEqual([]);
    expect(JSON.stringify(archive)).not.toContain('Private note');
  });
});

describe('a copy of records a person reads', () => {
  it('keeps record order and row numbers, and numbers new records after them', async () => {
    const small = await smallDatabase('Ordered');
    await commands(small.databaseId, [
      { kind: 'record.trash', tableId: small.tableId, recordIds: [small.records[1]!.id] },
    ]);
    const snapshot = await takeSnapshot(small.databaseId, 'Ordered');
    const done = await restore(snapshot.id, 'Ordered copy');
    const schema = await schemaOf(done.databaseId!);
    const rows = await rowsOf(schema.views[0]!.id);
    expect(rows.rows.map((row) => row!.values[schema.fields[0]!.id])).toEqual([
      'Item 1',
      'Item 3',
      'Item 4',
      'Item 5',
    ]);
    const added = newId('record');
    await commands(done.databaseId!, [
      { kind: 'record.create', tableId: schema.tables[0]!.id, records: [{ id: added, values: {} }] },
    ]);
    const after = await rowsOf(schema.views[0]!.id);
    expect(after.rows.at(-1)!.id).toBe(added);
    const detail = await ok<RowData>('GET', `/api/tables/${schema.tables[0]!.id}/records/${added}`);
    expect(detail.id).toBe(added);
  });
});

describe('joined tables and pin settings in a copy', () => {
  it('keeps a joined table’s definition, its records’ origins, and its tables’ settings', async () => {
    const small = await smallDatabase('With a joined table');
    const sideId = newId('table');
    const sideKey = newId('field');
    const sideAmount = newId('field');
    const sideRecord = newId('record');
    const joinedId = newId('table');
    const joinedKey = newId('field');
    const joinedAmount = newId('field');
    await commands(small.databaseId, [
      {
        kind: 'table.create',
        table: {
          id: sideId,
          name: 'Sides',
          fields: [
            { id: sideKey, name: 'Key', type: 'text' },
            { id: sideAmount, name: 'Amount', type: 'number' },
          ],
          view: { id: newId('view'), name: 'Grid' },
        },
      },
      {
        kind: 'record.create',
        tableId: sideId,
        records: [{ id: sideRecord, values: { [sideKey]: 'Item 1', [sideAmount]: 5 } }],
      },
      { kind: 'table.update', tableId: sideId, allowComputedOverrides: true, historyRetentionDays: 7 },
      {
        kind: 'table.create',
        table: {
          id: joinedId,
          name: 'Joined',
          fields: [
            { id: joinedKey, name: 'Key', type: 'text' },
            { id: joinedAmount, name: 'Amount', type: 'number' },
          ],
          view: { id: newId('view'), name: 'Grid' },
          joined: {
            baseTableId: small.tableId,
            steps: [
              {
                tableId: sideId,
                leftTableId: small.tableId,
                leftFieldId: small.nameField,
                rightFieldId: sideKey,
                kind: 'inner',
              },
            ],
            fields: [
              { tableId: small.tableId, fieldId: small.nameField, outputFieldId: joinedKey },
              { tableId: sideId, fieldId: sideAmount, outputFieldId: joinedAmount },
            ],
          },
        },
      },
    ]);
    const joinedView = (await schemaOf(small.databaseId)).views.find((view) => view.tableId === joinedId)!.id;
    const before = await rowsOf(joinedView);
    expect(before.rows[0]!.values[joinedAmount]).toBe(5);
    await commands(small.databaseId, [
      {
        kind: 'record.update',
        tableId: joinedId,
        records: [{ id: before.rows[0]!.id, values: { [joinedAmount]: 9 } }],
      },
    ]);
    expect((await rowsOf(joinedView)).rows[0]!.overrides?.[joinedAmount]?.source).toBe(5);

    const snapshot = await takeSnapshot(small.databaseId, 'Joined');
    const done = await restore(snapshot.id, 'Joined copy');
    expect(done.report).toMatchObject({ syncedTables: 1, unsyncedTables: 0 });
    const schema = await schemaOf(done.databaseId!);
    const joined = schema.tables.find((table) => table.name === 'Joined')!;
    const sides = schema.tables.find((table) => table.name === 'Sides')!;
    const items = schema.tables.find((table) => table.name === 'Items')!;
    expect(sides.allowComputedOverrides, 'computed pins stay on for the copy').toBe(true);
    expect(sides.historyRetentionDays).toBe(7);
    const itemKey = schema.fields.find((field) => field.tableId === items.id && field.name === 'Name')!;
    const sideKeyField = schema.fields.find((field) => field.tableId === sides.id && field.name === 'Key')!;
    const sideAmountField = schema.fields.find(
      (field) => field.tableId === sides.id && field.name === 'Amount',
    )!;
    const key = schema.fields.find((field) => field.tableId === joined.id && field.name === 'Key')!;
    const amount = schema.fields.find((field) => field.tableId === joined.id && field.name === 'Amount')!;
    expect(joined.joined).toEqual({
      baseTableId: items.id,
      steps: [
        {
          tableId: sides.id,
          leftTableId: items.id,
          leftFieldId: itemKey.id,
          rightFieldId: sideKeyField.id,
          kind: 'inner',
        },
      ],
      fields: [
        { tableId: items.id, fieldId: itemKey.id, outputFieldId: key.id },
        { tableId: sides.id, fieldId: sideAmountField.id, outputFieldId: amount.id },
      ],
    });
    // Its records came across with the pin, and say which records of the copies they join.
    const page = await rowsOf(schema.views.find((view) => view.tableId === joined.id)!.id);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.values[amount.id]).toBe(9);
    expect(page.rows[0]!.overrides?.[amount.id]?.source).toBe(5);
    const itemRecord = (await rowsOf(schema.views.find((view) => view.tableId === items.id)!.id)).rows[0]!;
    const sideRow = (await rowsOf(schema.views.find((view) => view.tableId === sides.id)!.id)).rows[0]!;
    const origins = await query<{ id: string; joined: Record<string, string> | null }>(
      server.pool,
      sql`SELECT __id AS id, __joined_records AS joined FROM ${ident(server.schemas.data, joined.id)}`,
    );
    expect(origins.rows).toHaveLength(1);
    expect(origins.rows[0]!.id).toBe(page.rows[0]!.id);
    expect(origins.rows[0]!.joined).toEqual({
      [items.id]: itemRecord.id,
      [sides.id]: sideRow.id,
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import * as XLSX from 'xlsx';
import {
  AiSettings,
  DatabaseCreate,
  INGEST_PROCESS_FIELDS,
  newId,
  type IngestExample,
  type IngestFormat,
  type IngestReadiness,
  type IngestTableSettings,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { loadFields, loadTable, loadViews } from '../../data/metadata.js';
import { AccessScope } from '../../data/access.js';
import { saveFieldRules, saveRecordRules } from '../../data/permissions/store.js';
import { runIngestSetupCommand } from '../../data/commands/ingest-setup.js';
import { actorFor } from '../../automations/run.js';
import { propose } from '../../ai/plans.js';
import { IngestTableStore } from '../tables/store.js';
import { standIn, eicar } from '../../data/files/scan-test-support.js';
import { TOOLKIT_VERSION } from '../readers/toolkit-bundle.js';

let kit: TestPostgres;
let server: ServerFixture;
let editor: SignedIn;
let store: IngestTableStore;
let ordinary: Awaited<ReturnType<typeof newTable>>;
let working: Awaited<ReturnType<typeof newTable>>;
const file = (text: string, name = 'input.csv', mediaType?: string) => ({
  name,
  base64: Buffer.from(text).toString('base64'),
  ...(mediaType ? { mediaType } : {}),
});
const layout = {
  header: { markers: ['Incoming'], searchRows: 10 },
  columns: { value: { aliases: ['Incoming'], cleaners: [{ kind: 'text' }] } },
};
const signature = { id: 'receipt', kind: 'text', headerGroups: [['Incoming']], markers: [] };
const call = (tableId: string, kind: string, values: object = {}, who = server.owner) =>
  server.app.inject({
    method: 'POST',
    url: `/api/tables/${tableId}/ingest/commands`,
    headers: who.headers,
    payload: { id: newId('command'), kind, ...values },
  });
async function applied(tableId: string, kind: string, values: object = {}) {
  const result = await call(tableId, kind, values);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().status).toBe('applied');
  return result.json().output;
}
async function newTable() {
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Incoming',
    table: {
      id: newId('table'),
      name: 'Receipts',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by)
    VALUES ($4, 'database', $1, 'user', $2, 'editor', $3)`,
    [input.id, editor.userId, server.owner.userId, server.owner.info.org.id],
  );
  return {
    tableId: input.table.id,
    fieldId: input.table.fields[0]!.id,
    viewId: input.table.view.id,
    databaseId: input.id,
  };
}
async function begin(table: Awaited<ReturnType<typeof newTable>>) {
  return (await applied(table.tableId, 'ingest.begin')).settings as IngestTableSettings;
}
async function output(table: Awaited<ReturnType<typeof newTable>>, settings: IngestTableSettings) {
  return (
    await applied(table.tableId, 'ingest.output', {
      output: {
        revision: settings.revision,
        rowMeaning: 'Each row represents a receipt.',
        identity: null,
        fields: [
          { key: 'value', field: { id: table.fieldId }, meaning: 'The receipt identifier.', required: true },
        ],
      },
    })
  ).settings as IngestTableSettings;
}
async function format(tableId: string) {
  return (await applied(tableId, 'ingest.format.add', { name: 'Receipts' })).format as IngestFormat;
}
async function example(tableId: string, formatId: string, value: string, extra = value) {
  return (
    await applied(tableId, 'ingest.example.add', {
      formatId,
      file: file(`Incoming,Extra\n${value},${extra}\n`),
      expected: { kind: 'paste', text: `value\n${value}\n` },
    })
  ).example as IngestExample;
}
async function rules(tableId: string, saved: IngestFormat, extra: object = {}) {
  return applied(tableId, 'ingest.format.rules', {
    formatId: saved.id,
    revision: saved.revision,
    reading: 'layout',
    rules: layout,
    signature,
    ...extra,
  });
}
async function ready() {
  const table = await newTable();
  const settings = await output(table, await begin(table));
  const saved = await format(table.tableId);
  for (const value of ['A', 'B', 'C']) await example(table.tableId, saved.id, value);
  await rules(table.tableId, saved);
  return { ...table, settings, format: saved };
}
const candidates: Array<[string, object]> = [
  ['ingest.output', { output: { revision: 1, rowMeaning: '', identity: null, fields: [] } }],
  ['ingest.propose', { file: file('Name\nAda\n') }],
  ['ingest.sender.add', { label: 'Sender', senderKind: 'domain', value: 'example.test' }],
  ['ingest.sender.update', { senderId: 'missing', approved: true }],
  ['ingest.sender.remove', { senderId: 'missing' }],
  ['ingest.format.add', { name: 'Rows' }],
  ['ingest.format.rename', { formatId: 'missing', name: 'Rows' }],
  ['ingest.format.remove', { formatId: 'missing' }],
  ['ingest.format.rules', { formatId: 'missing', revision: 1, reading: 'layout', rules: layout, signature }],
  [
    'ingest.example.add',
    {
      formatId: 'missing',
      file: file('Incoming,Extra\nA,x\n'),
      expected: { kind: 'paste', text: 'value\nA\n' },
    },
  ],
  ['ingest.example.remove', { exampleId: 'missing' }],
  ['ingest.goLive', {}],
  ['ingest.pause', {}],
  ['ingest.resume', {}],
  ['ingest.takeOver', {}],
  ['ingest.redo', { revision: 1, confirm: true }],
  ['ingest.turnOff', {}],
];
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'setupcommands');
  editor = await server.addMember();
  store = new IngestTableStore(server.pool, server.schemas);
  const settings = AiSettings.parse({ enabled: true, ingest: true, models: { everyday: null, power: null } });
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.ai_settings (org_id, settings) VALUES ($1, $2)
    ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings`,
    [server.owner.info.org.id, settings],
  );
  ordinary = await newTable();
  working = await newTable();
  await begin(working);
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

describe('schema rights and state boundaries', () => {
  for (const [kind, input] of [['ingest.begin', {}], ...candidates] as Array<[string, object]>) {
    it(`refuses ${kind} for a record editor`, async () => {
      const response = await call(working.tableId, kind, input, editor);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.messageKey).toBe('data.access.denied');
    });
    it(`refuses ${kind} in the wrong state`, async () => {
      const response = await call(kind === 'ingest.begin' ? working.tableId : ordinary.tableId, kind, input);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.messageKey).toBe('ingest.setup.state');
    });
  }
  for (const [kind, input] of [['ingest.begin', {}], ...candidates] as Array<[string, object]>)
    it(`refuses ${kind} in demo mode`, async () => {
      const actor = (await actorFor(
        server.pool,
        server.schemas,
        server.owner.userId,
        server.owner.info.org.id,
      ))!;
      await expect(
        runIngestSetupCommand(
          server.app,
          { ...actor, demo: true },
          { id: newId('command'), tableId: working.tableId, kind, ...input },
        ),
      ).rejects.toMatchObject({ messageKey: 'demo.readOnly' });
    });
});

it('begins an empty resumable setup and safely replays the same command', async () => {
  const table = await newTable();
  const id = newId('command');
  const request = {
    method: 'POST' as const,
    url: `/api/tables/${table.tableId}/ingest/begin`,
    headers: server.owner.headers,
    payload: { id },
  };
  const first = await server.app.inject(request);
  const again = await server.app.inject(request);
  expect(first.json().output.settings).toMatchObject({
    state: 'setup',
    rowMeaning: '',
    identityDecided: false,
    fields: [],
    ownerId: null,
  });
  expect(again.json()).toMatchObject({ status: 'duplicate', output: first.json().output });
  const audit = await server.pool.query(
    `SELECT action FROM ${server.schemas.audit}.events WHERE metadata->>'commandId' = $1`,
    [id],
  );
  expect(audit.rows).toEqual([{ action: 'data.ingest.begin' }]);
});

it('lets a database creator begin setup with organization consent and no AI administration rights', async () => {
  const table = await newTable();
  await server.pool.query(
    `UPDATE ${server.schemas.app}.grants SET role = 'creator' WHERE resource_id = $1 AND principal_id = $2`,
    [table.databaseId, editor.userId],
  );
  const actor = (await actorFor(server.pool, server.schemas, editor.userId, editor.info.org.id))!;
  await new AccessScope(server.pool, server.schemas, actor).require(table.databaseId, 'editSchema');
  const admin = await server.app.inject({ url: '/api/ai/settings', headers: editor.headers });
  expect(admin.statusCode).toBe(403);
  const response = await call(table.tableId, 'ingest.begin', {}, editor);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().output.settings).toMatchObject({ state: 'setup', fields: [] });
});

it.each(Object.keys(INGEST_PROCESS_FIELDS))(
  'refuses the reserved output key %s before changing fields',
  async (key) => {
    const table = await newTable();
    const settings = await begin(table);
    const response = await call(table.tableId, 'ingest.output', {
      output: {
        revision: settings.revision,
        rowMeaning: 'Each row represents a receipt.',
        identity: null,
        fields: [{ key, field: { id: table.fieldId }, meaning: 'The receipt identifier.', required: true }],
      },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect((await loadTable(server.pool, server.schemas, table.tableId))!.ingest).toEqual(settings);
    expect((await loadFields(server.pool, server.schemas, [table.tableId]))[0]!.ingest).toBeUndefined();
  },
);

it('suggests unique data keys when sheet headings use reserved process keys', async () => {
  const table = await newTable();
  await begin(table);
  const keys = Object.keys(INGEST_PROCESS_FIELDS);
  const proposal = await applied(table.tableId, 'ingest.propose', {
    file: file(
      `${[...keys, 'source_2', 'source'].join(',')}\n${Array(keys.length + 2)
        .fill('A')
        .join(',')}\n`,
    ),
  });
  const suggested = proposal.fields.map((field: { key: string }) => field.key);
  expect(suggested.some((key: string) => Object.hasOwn(INGEST_PROCESS_FIELDS, key))).toBe(false);
  expect(new Set(suggested).size).toBe(suggested.length);
  expect(proposal.fields.map((field: { heading: string }) => field.heading)).toEqual([
    ...keys,
    'source_2',
    'source',
  ]);
});

it('proposes a legacy workbook after content safety inspection', async () => {
  const table = await newTable();
  const settings = await begin(table);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['Identifier', 'Amount'],
      ['0012', 3],
      ['0013', null],
    ]),
    'Output',
  );
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }) as Buffer;
  const proposal = await applied(table.tableId, 'ingest.propose', {
    file: { name: 'output.xls', mediaType: 'application/vnd.ms-excel', base64: bytes.toString('base64') },
  });
  expect(proposal.fields).toEqual([
    { heading: 'Identifier', key: 'Identifier', type: 'text', hasEmpty: false, examples: ['0012', '0013'] },
    { heading: 'Amount', key: 'Amount', type: 'number', hasEmpty: true, examples: [3] },
  ]);
  expect((await loadTable(server.pool, server.schemas, table.tableId))!.ingest).toEqual(settings);
  expect(await store.listFiles({ orgId: server.owner.info.org.id, tableId: table.tableId })).toEqual([]);
});

it('refuses a safe compound document that has no workbook sheets', async () => {
  const table = await newTable();
  await begin(table);
  const container = XLSX.CFB.utils.cfb_new({ root: 'Root Entry' });
  XLSX.CFB.utils.cfb_add(container, 'Document', Buffer.from('Document content'));
  const bytes = Buffer.from(XLSX.CFB.write(container, { type: 'buffer' }));
  const response = await call(table.tableId, 'ingest.propose', {
    file: { name: 'document.doc', base64: bytes.toString('base64') },
  });
  expect(response.statusCode, response.body).toBe(422);
  expect(response.json().error.messageKey).toBe('import.spreadsheet.notSpreadsheet');
});

it.each(['field', 'record'] as const)(
  'applies %s permissions to redo previews, replays, and confirmed results',
  async (restriction) => {
    const table = await newTable();
    const settings = await output(table, await begin(table));
    const saved = await format(table.tableId);
    const evidence = await example(table.tableId, saved.id, 'restricted-example-value');
    const sender = (
      await applied(table.tableId, 'ingest.sender.add', {
        label: 'Setup sender',
        senderKind: 'address',
        value: 'sender@example.test',
      })
    ).sender;
    const created = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${table.databaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'record.create',
            tableId: table.tableId,
            records: ['Visible', 'restricted-example-value'].map((value) => ({
              id: newId('record'),
              values: { [table.fieldId]: value },
            })),
          },
        ],
      },
    });
    expect(created.json().results[0].status, created.body).toBe('applied');
    await server.pool.query(
      `UPDATE ${server.schemas.app}.grants SET role = 'creator' WHERE resource_id = $1 AND principal_id = $2`,
      [table.databaseId, editor.userId],
    );
    await server.pool.query(
      `UPDATE ${server.schemas.app}.fields SET name = 'Restricted field name' WHERE id = $1`,
      [table.fieldId],
    );
    const id = newId('command');
    const request = {
      method: 'POST' as const,
      url: `/api/tables/${table.tableId}/ingest/commands`,
      headers: editor.headers,
      payload: { id, kind: 'ingest.redo', revision: settings.revision, dryRun: true },
    };
    const first = await server.app.inject(request);
    expect(first.statusCode, first.body).toBe(200);
    const target = { orgId: editor.info.org.id, databaseId: table.databaseId, tableId: table.tableId };
    if (restriction === 'field')
      await saveFieldRules(
        server.pool,
        server.schemas,
        { ...target, fieldId: table.fieldId },
        { restricted: { roles: ['owner'], users: [] }, locked: null },
        server.owner.userId,
      );
    else
      await saveRecordRules(
        server.pool,
        server.schemas,
        target,
        [
          {
            id: newId('recordRule'),
            roles: ['creator'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [
                { id: 'visible-records', fieldId: table.fieldId, operator: 'is', value: 'Visible' },
              ],
            },
          },
        ],
        server.owner.userId,
      );
    const actor = (await actorFor(server.pool, server.schemas, editor.userId, editor.info.org.id))!;
    const scope = new AccessScope(server.pool, server.schemas, actor);
    await scope.require(table.databaseId, 'editSchema');
    expect(
      scope.visibleFields(table.tableId, await loadFields(server.pool, server.schemas, [table.tableId])),
    ).toHaveLength(restriction === 'field' ? 0 : 1);
    const ordinaryReplay = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${table.databaseId}/commands`,
      headers: editor.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          { id, groupId: newId('action'), kind: 'table.update', tableId: table.tableId, name: 'Replay only' },
        ],
      },
    });
    expect(ordinaryReplay.statusCode, ordinaryReplay.body).toBe(200);
    expect(ordinaryReplay.json().results[0].status).toBe('duplicate');
    expect(ordinaryReplay.body).not.toContain('restricted-example-value');
    expect(ordinaryReplay.body).not.toContain('Restricted field name');
    expect(ordinaryReplay.body).not.toContain('Setup sender');
    expect(ordinaryReplay.body).not.toContain('sender@example.test');
    expect(ordinaryReplay.json().results[0].output.stays.fields).toEqual([{ id: table.fieldId }]);
    expect(ordinaryReplay.json().results[0].output.erased.fieldMarks).toEqual([{ fieldId: table.fieldId }]);
    expect(ordinaryReplay.json().results[0].output.stays.senders).toEqual([{ id: sender.id }]);
    for (const response of [
      await call(table.tableId, 'ingest.redo', { revision: settings.revision, dryRun: true }, editor),
      await server.app.inject(request),
      await call(table.tableId, 'ingest.redo', { revision: settings.revision, confirm: true }, editor),
    ]) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain('restricted-example-value');
      const result = response.json().output;
      expect(result.erased.examples).toEqual([
        { id: evidence.id, formatId: saved.id, fileId: evidence.fileId },
      ]);
      expect(result.stays.rows).toBe(restriction === 'field' ? 2 : 1);
      expect(result.stays.fields).toHaveLength(restriction === 'field' ? 0 : 1);
      expect(result.stays.senders).toEqual([sender]);
      if (restriction === 'field') {
        expect(response.body).not.toContain('Restricted field name');
        expect(result.erased.output.fields).toEqual([]);
        expect(result.erased.fieldMarks).toEqual([]);
      }
    }
    const kept = await server.pool.query(
      `SELECT "${table.fieldId}" FROM ${server.schemas.data}."${table.tableId}" ORDER BY "${table.fieldId}"`,
    );
    expect(kept.rows.map((row) => row[table.fieldId])).toEqual(['Visible', 'restricted-example-value']);
    expect((await loadFields(server.pool, server.schemas, [table.tableId]))[0]!.name).toBe(
      'Restricted field name',
    );
  },
);

it('refuses begin on a joined table, a synced table, and an organization with AI or ingest off', async () => {
  const base = await newTable();
  const rightId = newId('table');
  const rightFieldId = newId('field');
  const joinedId = newId('table');
  const joinedFieldId = newId('field');
  for (const definition of [
    {
      id: rightId,
      name: 'Other receipts',
      fields: [{ id: rightFieldId, name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
    {
      id: joinedId,
      name: 'Joined receipts',
      fields: [{ id: joinedFieldId, name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
      joined: {
        baseTableId: base.tableId,
        steps: [
          {
            tableId: rightId,
            leftTableId: base.tableId,
            leftFieldId: base.fieldId,
            rightFieldId,
            kind: 'left',
          },
        ],
        fields: [{ tableId: base.tableId, fieldId: base.fieldId, outputFieldId: joinedFieldId }],
      },
    },
  ]) {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${base.databaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          { id: newId('command'), groupId: newId('action'), kind: 'table.create', table: definition },
        ],
      },
    });
    expect(response.json().results[0].status, response.body).toBe('applied');
  }
  expect((await call(joinedId, 'ingest.begin')).json().error.messageKey).toBe('ingest.tables.exclusive');
  const synced = await newTable();
  const sourceId = newId('source');
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.sources (id, org_id, name, kind, connection, sealed_secrets, access, created_by)
    VALUES ($1, $2, 'Incoming', 'webhook', '{}', '', 'creators', $3)`,
    [sourceId, server.owner.info.org.id, server.owner.userId],
  );
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.table_sources (table_id, source_id, settings, status)
    VALUES ($1, $2, '{"select":{"kind":"object","name":"Incoming"},"freshness":"copy","keyColumns":[],"everyMinutes":null,"allowOverrides":false,"holdAboveDeleteShare":null}', '{"state":"idle"}')`,
    [synced.tableId, sourceId],
  );
  expect((await call(synced.tableId, 'ingest.begin')).json().error.messageKey).toBe(
    'ingest.tables.exclusive',
  );
  for (const key of ['ingest', 'enabled']) {
    await server.pool.query(
      `UPDATE ${server.schemas.app}.ai_settings SET settings = jsonb_set(settings, ARRAY[$1]::text[], 'false')`,
      [key],
    );
    try {
      expect((await call(ordinary.tableId, 'ingest.begin')).json().error.messageKey).toBe(
        'ingest.setup.disabled',
      );
    } finally {
      await server.pool.query(
        `UPDATE ${server.schemas.app}.ai_settings SET settings = jsonb_set(settings, ARRAY[$1]::text[], 'true')`,
        [key],
      );
    }
  }
});

it('creates, marks, and unmarks output fields, refuses stale revisions, and protects marked types', async () => {
  const table = await newTable();
  const initial = await begin(table);
  const first = await applied(table.tableId, 'ingest.output', {
    output: {
      revision: initial.revision,
      rowMeaning: 'Each row is a receipt.',
      identity: ['value'],
      fields: [
        { key: 'value', field: { id: table.fieldId }, meaning: 'The receipt identifier.', required: true },
        {
          key: 'amount',
          field: { name: 'Amount', type: 'number' },
          meaning: 'The receipt total.',
          required: false,
        },
        {
          key: 'status',
          field: { name: 'Status', type: 'singleSelect' },
          meaning: 'The processing status.',
          required: false,
          allowedValues: ['Ready', 'Waiting'],
        },
      ],
    },
  });
  const fields = await loadFields(server.pool, server.schemas, [table.tableId]);
  expect(fields.map((field) => field.ingest?.key)).toEqual(['value', 'amount', 'status']);
  expect(fields[2]).toMatchObject({
    type: 'singleSelect',
    options: { choices: [{ name: 'Ready' }, { name: 'Waiting' }] },
  });
  const stale = await call(table.tableId, 'ingest.output', {
    output: { revision: initial.revision, rowMeaning: '', identity: null, fields: [] },
  });
  expect(stale.json().error.messageKey).toBe('ingest.tables.stale');
  await output(table, first.settings);
  expect(
    (await loadFields(server.pool, server.schemas, [table.tableId])).map((field) => field.ingest?.key),
  ).toEqual(['value', undefined, undefined]);
  const converted = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'field.convert',
          fieldId: table.fieldId,
          to: { type: 'number' },
        },
      ],
    },
  });
  expect(converted.json().results[0].error.messageKey).toBe('ingest.fields.locked');
});

it('proposes headings, unique keys, types, blanks, and three values without saving a setup change', async () => {
  const table = await newTable();
  const settings = await begin(table);
  const result = await applied(table.tableId, 'ingest.propose', {
    file: file(
      'Name,Amount,Active,Date,Name\nAda,1,true,2026-01-01,A\nBea,2,false,2026-01-02,B\nCia,3,true,2026-01-03,C\nDee,,false,2026-01-04,D\n',
    ),
  });
  expect(result.fields).toEqual([
    { heading: 'Name', key: 'Name', type: 'text', hasEmpty: false, examples: ['Ada', 'Bea', 'Cia'] },
    { heading: 'Amount', key: 'Amount', type: 'number', hasEmpty: true, examples: ['1', '2', '3'] },
    { heading: 'Active', key: 'Active', type: 'checkbox', hasEmpty: false, examples: ['true', 'false'] },
    {
      heading: 'Date',
      key: 'Date',
      type: 'date',
      hasEmpty: false,
      examples: ['2026-01-01', '2026-01-02', '2026-01-03'],
    },
    { heading: 'Name', key: 'Name_2', type: 'text', hasEmpty: false, examples: ['A', 'B', 'C'] },
  ]);
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Output').addRows([
    ['Id', 'Count'],
    ['0012', 3],
    ['0013', null],
  ]);
  const bytes = await workbook.xlsx.writeBuffer();
  const proposed = await applied(table.tableId, 'ingest.propose', {
    file: { name: 'output.xlsx', base64: Buffer.from(bytes).toString('base64') },
  });
  expect(proposed.fields[0]).toMatchObject({ type: 'text', examples: ['0012', '0013'] });
  expect(proposed.fields[1]).toMatchObject({ type: 'number', hasEmpty: true });
  expect((await loadTable(server.pool, server.schemas, table.tableId))!.ingest).toEqual(settings);
  expect(await store.listFiles({ orgId: server.owner.info.org.id, tableId: table.tableId })).toEqual([]);
});

it('adds, renames, approves, unapproves, and removes senders, and reports referenced file counts', async () => {
  const table = await newTable();
  await begin(table);
  const sender = (
    await applied(table.tableId, 'ingest.sender.add', {
      label: 'Supplier',
      senderKind: 'domain',
      value: 'EXAMPLE.TEST',
    })
  ).sender;
  expect(sender).toMatchObject({ value: 'example.test', approved: false });
  expect(
    (
      await applied(table.tableId, 'ingest.sender.update', {
        senderId: sender.id,
        label: 'Partner',
        approved: true,
      })
    ).sender,
  ).toMatchObject({ label: 'Partner', approved: true });
  expect(
    (await applied(table.tableId, 'ingest.sender.update', { senderId: sender.id, approved: false })).sender
      .approved,
  ).toBe(false);
  await applied(table.tableId, 'ingest.sender.remove', { senderId: sender.id });
  const used = (
    await applied(table.tableId, 'ingest.sender.add', {
      label: 'Used',
      senderKind: 'address',
      value: 'a@example.test',
    })
  ).sender;
  await store.createFile(
    { orgId: server.owner.info.org.id, tableId: table.tableId, userId: server.owner.userId },
    {
      origin: 'drop',
      name: 'source.txt',
      mediaType: 'text/plain',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      storedFile: null,
      senderId: used.id,
    },
  );
  const refused = await call(table.tableId, 'ingest.sender.remove', { senderId: used.id });
  expect(refused.json().error).toMatchObject({ messageKey: 'ingest.setup.senderUsed', params: { count: 1 } });
});

it('creates and renames formats, stores originals, removes examples, and deletes a format with its examples', async () => {
  const table = await newTable();
  await output(table, await begin(table));
  const saved = await format(table.tableId);
  expect(saved.state).toBe('draft');
  expect(
    (await applied(table.tableId, 'ingest.format.rename', { formatId: saved.id, name: 'New receipts' }))
      .format.name,
  ).toBe('New receipts');
  const first = await example(table.tableId, saved.id, 'A');
  const second = await example(table.tableId, saved.id, 'B');
  const context = { orgId: server.owner.info.org.id, tableId: table.tableId };
  const original = (await store.readFile(context, first.fileId))!;
  expect(original).toMatchObject({ isExample: true, expiresAt: null, mediaType: 'text/plain' });
  const downloadable = await server.app.inject({
    url: `/api/files/${original.storedFile}/input.csv`,
    headers: server.owner.headers,
  });
  expect(downloadable.statusCode).toBe(404);
  expect(
    (
      await server.app.inject({ url: `/api/files?ids=${original.storedFile}`, headers: server.owner.headers })
    ).json(),
  ).toEqual([]);
  await applied(table.tableId, 'ingest.example.remove', { exampleId: first.id });
  const removed = (await store.readFile(context, first.fileId))!;
  expect(removed.isExample).toBe(false);
  expect(Date.parse(removed.expiresAt!) - Date.parse(removed.receivedAt)).toBe(90 * 86_400_000);
  await applied(table.tableId, 'ingest.format.remove', { formatId: saved.id });
  expect(await store.listExamples(context)).toEqual([]);
  expect((await store.readFile(context, second.fileId))!.isExample).toBe(false);
});

for (const [name, input, expected, blocking] of [
  ['raw input with missing output fields', 'Incoming,Extra\nA,1\n', 'Incoming,Extra\nA,1\n', 'columns'],
  ['raw input with an empty required field', 'value,Extra\n,x\n', 'value,Extra\n,x\n', 'empty-required'],
  ['unknown columns', 'Incoming,Extra\nA,x\n', 'value,unknown\nA,x\n', 'columns'],
  ['missing required columns', 'Incoming,Extra\nA,x\n', 'other\nA\n', 'columns'],
  ['empty required values', 'Incoming,Extra\nA,x\n', 'value,other\n,x\n', 'empty-required'],
] as const)
  it(`refuses ${name} with all findings before storing the original`, async () => {
    const table = await newTable();
    await output(table, await begin(table));
    const saved = await format(table.tableId);
    const result = await call(table.tableId, 'ingest.example.add', {
      formatId: saved.id,
      file: file(input),
      expected: { kind: 'paste', text: expected },
      confirm: true,
    });
    expect(result.json().error.messageKey).toBe('ingest.setup.pairBlocked');
    expect(result.json().details.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: blocking, blocks: true })]),
    );
    if (name.startsWith('raw input'))
      expect(result.json().details.findings).toContainEqual(
        expect.objectContaining({ kind: 'input-as-output', blocks: false }),
      );
    expect(await store.listFiles({ orgId: server.owner.info.org.id, tableId: table.tableId })).toEqual([]);
    expect(await store.listExamples({ orgId: server.owner.info.org.id, tableId: table.tableId })).toEqual([]);
  });

it('confirms three finished-form pairs, records their findings, and reaches G3', async () => {
  const table = await newTable();
  await output(table, await begin(table));
  const saved = await format(table.tableId);
  const context = { orgId: server.owner.info.org.id, tableId: table.tableId };
  for (const [index, value] of ['A', 'B', 'C'].entries()) {
    const offered = {
      formatId: saved.id,
      file: file(`value\n${value}\n`),
      expected: { kind: 'paste', text: `value\n${value}\n` },
    };
    const first = await call(table.tableId, 'ingest.example.add', offered);
    expect(first.json()).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'ingest.setup.confirmPair' },
      details: {
        needsConfirmation: true,
        findings: [{ kind: 'input-as-output', messageId: 'ingest.pairs.inputAsOutput', blocks: false }],
      },
    });
    expect(await store.listExamples(context)).toHaveLength(index);
    expect(await store.listFiles(context)).toHaveLength(index);
    const confirmed = await applied(table.tableId, 'ingest.example.add', {
      ...offered,
      confirm: true,
      confirmationId: first.json().details.confirmationId,
    });
    expect(confirmed.example).toMatchObject({
      own: true,
      expected: [{ values: { value } }],
      confirmedBy: server.owner.userId,
      confirmedFindings: first.json().details.findings,
    });
    expect(await store.readExample(context, confirmed.example.id)).toEqual(confirmed.example);
  }
  const response = await server.app.inject({
    url: `/api/tables/${table.tableId}/ingest/readiness`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<IngestReadiness>().gates.find((gate) => gate.id === 'G3')).toEqual({
    id: 'G3',
    met: true,
    gaps: [],
  });
});

it('requires a second call for non-blocking findings, rejects duplicate bytes, and derives own from expected-row provenance', async () => {
  const table = await newTable();
  await output(table, await begin(table));
  const saved = await format(table.tableId);
  const offered = {
    formatId: saved.id,
    file: file('Incoming,Extra\nA,x\n'),
    expected: { kind: 'paste', text: 'value\nB\n' },
  };
  const first = await call(table.tableId, 'ingest.example.add', offered);
  expect(first.json()).toMatchObject({
    error: { messageKey: 'ingest.setup.confirmPair' },
    details: { needsConfirmation: true, findings: [{ kind: 'absent-value', blocks: false }] },
  });
  const confirmed = await applied(table.tableId, 'ingest.example.add', {
    ...offered,
    confirm: true,
    confirmationId: first.json().details.confirmationId,
  });
  expect(confirmed.example.own).toBe(true);
  expect(confirmed.example.confirmedFindings).toEqual(first.json().details.findings);
  const twice = await call(table.tableId, 'ingest.example.add', { ...offered, confirm: true });
  expect(
    twice.json().details.findings.some((finding: { kind: string }) => finding.kind === 'duplicate-file'),
  ).toBe(true);
  const draft = await applied(table.tableId, 'ingest.example.add', {
    formatId: saved.id,
    file: file('Incoming,Extra\nB,y\n'),
    expected: { kind: 'draft', exampleId: confirmed.example.id },
  });
  expect(draft.example.own).toBe(false);
});

it('takes expected rows from visible records and uploaded sheets', async () => {
  const table = await newTable();
  await output(table, await begin(table));
  const saved = await format(table.tableId);
  const recordId = newId('record');
  await server.app.inject({
    method: 'POST',
    url: `/api/databases/${table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'record.create',
          tableId: table.tableId,
          records: [{ id: recordId, values: { [table.fieldId]: 'A' } }],
        },
      ],
    },
  });
  expect(
    (
      await applied(table.tableId, 'ingest.example.add', {
        formatId: saved.id,
        file: file('Incoming,Extra\nA,x\n'),
        expected: { kind: 'records', recordIds: [recordId] },
      })
    ).example,
  ).toMatchObject({ own: true, expected: [{ values: { value: 'A' } }] });
  expect(
    (
      await applied(table.tableId, 'ingest.example.add', {
        formatId: saved.id,
        file: file('Incoming,Extra\nB,y\n'),
        expected: { kind: 'upload', file: file('value\nB\n', 'expected.csv') },
      })
    ).example.own,
  ).toBe(true);
});

it('refuses infected, mislabeled, and oversized uploads before parsing or storing them', async () => {
  const table = await newTable();
  await output(table, await begin(table));
  const saved = await format(table.tableId);
  const scanner = await standIn();
  server.config.clamavApprovedUrls = [scanner.url];
  await server.pool.query(`UPDATE ${server.schemas.app}.orgs SET settings = settings || $1::jsonb`, [
    JSON.stringify({ fileScanner: { enabled: true, address: scanner.url, oversizedPolicy: 'quarantine' } }),
  ]);
  try {
    const infected = await call(table.tableId, 'ingest.example.add', {
      formatId: saved.id,
      file: { name: 'infected.txt', base64: eicar.toString('base64') },
      expected: { kind: 'paste', text: 'value\nA\n' },
    });
    expect(infected.json().error.messageKey).toBe('files.checks.infected');
    expect(scanner.received).toEqual([eicar]);
  } finally {
    await server.pool.query(`UPDATE ${server.schemas.app}.orgs SET settings = settings - 'fileScanner'`);
    await scanner.close();
  }
  const mislabeled = await call(table.tableId, 'ingest.example.add', {
    formatId: saved.id,
    file: file('Incoming,Extra\nA,x\n', 'input.pdf', 'application/pdf'),
    expected: { kind: 'paste', text: 'value\nA\n' },
  });
  expect(mislabeled.json().error.messageKey).toBe('files.checks.typeMismatch');
  await server.pool.query(
    `UPDATE ${server.schemas.app}.orgs SET settings = settings || '{"files":{"maxUploadBytes":8}}'::jsonb`,
  );
  try {
    expect(
      (await call(table.tableId, 'ingest.propose', { file: file('Incoming,Extra\nA,x\n') })).statusCode,
    ).toBe(413);
  } finally {
    await server.pool.query(`UPDATE ${server.schemas.app}.orgs SET settings = settings - 'files'`);
  }
  expect(await store.listFiles({ orgId: server.owner.info.org.id, tableId: table.tableId })).toEqual([]);
});

it('saves signature and pair outcomes, refuses signature overlap, and leaves the previous rules intact', async () => {
  const table = await ready();
  const context = { orgId: server.owner.info.org.id, tableId: table.tableId };
  const current = (await store.readFormat(context, table.format.id))!;
  expect(current.checks).toMatchObject({
    signatures: [],
    pairs: {
      passed: true,
      examples: [{ result: { passed: true } }, { result: { passed: true } }, { result: { passed: true } }],
    },
  });
  const second = await format(table.tableId);
  const overlap = await call(table.tableId, 'ingest.format.rules', {
    formatId: second.id,
    revision: second.revision,
    signature,
    reading: 'layout',
    rules: layout,
  });
  expect(overlap.json().error.messageKey).toBe('ingest.setup.signatureOverlap');
  expect(overlap.json().details.signatures).toHaveLength(3);
  expect(overlap.json().details.pairs).toBeDefined();
  expect((await store.readFormat(context, second.id))!.revision).toBe(second.revision);
  const stale = await call(table.tableId, 'ingest.format.rules', {
    formatId: current.id,
    revision: 1,
    signature,
    reading: 'layout',
    rules: layout,
  });
  expect(stale.json().error.messageKey).toBe('ingest.tables.stale');
});

it('runs reader rules with their toolkit version and reports unavailable reading by AI without a model call', async () => {
  const table = await newTable();
  await output(table, await begin(table));
  const saved = await format(table.tableId);
  await example(table.tableId, saved.id, 'A');
  const read = await rules(table.tableId, saved, {
    reading: 'reader',
    rules: {
      toolkitVersion: TOOLKIT_VERSION,
      code: "await emit([{ values: { value: 'A' }, at: {}, raw: {} }])",
    },
  });
  expect(read.pairs.passed).toBe(true);
  const ai = await rules(table.tableId, read.format, { reading: 'ai', rules: null });
  expect(ai.pairs.examples[0].result.failure.kind).toBe('cannot-run-yet');
});

it('returns identical full gaps from readiness and the go-live refusal', async () => {
  const table = await newTable();
  await begin(table);
  const readiness = await server.app.inject({
    url: `/api/tables/${table.tableId}/ingest/readiness`,
    headers: server.owner.headers,
  });
  const refused = await call(table.tableId, 'ingest.goLive');
  expect(refused.json().error.messageKey).toBe('ingest.setup.notReady');
  expect(refused.json().details.readiness).toEqual(readiness.json());
});

it('blocks a completed format when an unfinished format has an example matching its signature', async () => {
  const table = await ready();
  const unfinished = await format(table.tableId);
  const colliding = await example(table.tableId, unfinished.id, 'D');
  const response = await server.app.inject({
    url: `/api/tables/${table.tableId}/ingest/readiness`,
    headers: server.owner.headers,
  });
  const readiness = response.json<IngestReadiness>();
  expect(readiness.ready).toBe(false);
  expect(readiness.gates.find((gate) => gate.id === 'G6')!.gaps).toContainEqual({
    messageId: 'ingest.pairs.otherSignatureMatched',
    facts: { format: table.format.id, exampleId: colliding.id, otherFormat: unfinished.id },
  });
  expect(readiness.formats.find((format) => format.formatId === table.format.id)!.ready).toBe(false);
  const refused = await call(table.tableId, 'ingest.goLive');
  expect(refused.json().error.messageKey).toBe('ingest.setup.notReady');
  expect(refused.json().details.readiness).toEqual(readiness);
  expect((await loadTable(server.pool, server.schemas, table.tableId))!.ingest!.state).toBe('setup');
});

it('activates an independent ready format while keeping a colliding completed format in draft', async () => {
  const table = await ready();
  const independent = await format(table.tableId);
  for (const value of ['D', 'E', 'F'])
    await applied(table.tableId, 'ingest.example.add', {
      formatId: independent.id,
      file: file(`Alternative,Extra\n${value},x\n`),
      expected: { kind: 'paste', text: `value\n${value}\n` },
    });
  await rules(table.tableId, independent, {
    signature: { ...signature, id: 'alternative', headerGroups: [['Alternative']] },
    rules: {
      header: { markers: ['Alternative'], searchRows: 10 },
      columns: { value: { aliases: ['Alternative'], cleaners: [{ kind: 'text' }] } },
    },
  });
  const unfinished = await format(table.tableId);
  await example(table.tableId, unfinished.id, 'G');
  expect((await applied(table.tableId, 'ingest.goLive')).settings.state).toBe('live');
  const formats = await store.listFormats({ orgId: server.owner.info.org.id, tableId: table.tableId });
  expect(formats.find((format) => format.id === independent.id)!.state).toBe('live');
  expect(formats.find((format) => format.id === table.format.id)!.state).toBe('draft');
  expect(formats.find((format) => format.id === unfinished.id)!.state).toBe('draft');
});

it.each(['format', 'file', 'both'] as const)(
  'keeps an unfinished format question local through %s provenance',
  async (provenance) => {
    const table = await ready();
    const unfinished = await format(table.tableId);
    const draft = await applied(table.tableId, 'ingest.example.add', {
      formatId: unfinished.id,
      file: file('Draft,Extra\nD,x\n'),
      expected: { kind: 'paste', text: 'value\nD\n' },
    });
    const document = {
      kind: 'valueSource',
      key: 'value',
      target: {
        type: 'field',
        field: 'value',
        ...(provenance !== 'format' ? { file: draft.example.fileId } : {}),
      },
      scopeContext: provenance !== 'file' ? { format: unfinished.id } : {},
    };
    const questionId = newId('command');
    await server.pool.query(
      `INSERT INTO ${server.schemas.app}.ingest_questions (id, org_id, table_id, version, document) VALUES ($1, $2, $3, 'v1', $4)`,
      [questionId, server.owner.info.org.id, table.tableId, document],
    );
    const response = await server.app.inject({
      url: `/api/tables/${table.tableId}/ingest/readiness`,
      headers: server.owner.headers,
    });
    const readiness = response.json<IngestReadiness>();
    expect(readiness.ready).toBe(true);
    expect(readiness.gates.find((gate) => gate.id === 'G4')).toEqual({ id: 'G4', met: true, gaps: [] });
    expect(readiness.formats.find((format) => format.formatId === unfinished.id)!.gaps).toContainEqual({
      messageId: 'ingest.ready.valueSource',
      facts: { field: 'value', questionId },
    });
    expect((await applied(table.tableId, 'ingest.goLive')).settings.state).toBe('live');
  },
);

it('returns persisted setup details to an authorized reader without original storage references', async () => {
  const table = await ready();
  const context = { orgId: server.owner.info.org.id, tableId: table.tableId };
  const sender = await applied(table.tableId, 'ingest.sender.add', {
    label: 'Receipts',
    senderKind: 'domain',
    value: 'example.test',
    approved: true,
  });
  const response = await server.app.inject({
    url: `/api/tables/${table.tableId}/ingest`,
    headers: editor.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  const details = response.json();
  expect(details.settings).toEqual((await loadTable(server.pool, server.schemas, table.tableId))!.ingest);
  expect(details.fields).toMatchObject([{ id: table.fieldId, name: 'Name', type: 'text' }]);
  expect(details.formats).toEqual(await store.listFormats(context));
  expect(details.formats[0]).toMatchObject({ name: 'Receipts', reading: 'layout', rules: layout, signature });
  expect(details.examples).toEqual(await store.listExamples(context));
  expect(details.examples.map((example: IngestExample) => example.expected)).toEqual(
    ['A', 'B', 'C'].map((value) => [{ values: { value } }]),
  );
  expect(details.senders).toEqual([sender.sender]);
  const files = await store.listFiles(context);
  expect(details.files).toHaveLength(3);
  for (const original of files) {
    expect(details.files).toContainEqual({
      id: original.id,
      name: original.name,
      mediaType: original.mediaType,
      sizeBytes: original.sizeBytes,
      sha256: original.sha256,
      receivedAt: original.receivedAt,
      expiresAt: original.expiresAt,
      formatId: original.formatId,
      senderId: original.senderId,
      isExample: original.isExample,
    });
    expect(response.body).not.toContain(original.storedFile);
  }
  expect(response.headers['cache-control']).toBe('no-store');
  const outsider = await server.addMember();
  const inaccessible = await server.app.inject({
    url: `/api/tables/${table.tableId}/ingest`,
    headers: outsider.headers,
  });
  expect(inaccessible.statusCode).toBe(404);
  expect(inaccessible.json()).toEqual({
    error: { code: 'not_found', messageKey: 'errors.notFound', userFault: true },
  });
  expect((await server.app.inject({ url: `/api/tables/${table.tableId}/ingest` })).statusCode).toBe(401);
  expect(
    (
      await server.app.inject({
        url: `/api/tables/${ordinary.tableId}/ingest`,
        headers: server.owner.headers,
      })
    ).json().error.messageKey,
  ).toBe('ingest.setup.state');
});

it('keeps session and CSRF checks for bearer requests that do not activate ingest', async () => {
  const payload = { id: newId('command'), kind: 'ingest.format.add', name: 'Draft' };
  const headers = { authorization: `Bearer ${randomBytes(32).toString('base64url')}` };
  const url = `/api/tables/${working.tableId}/ingest/commands`;
  const unsigned = await server.app.inject({ method: 'POST', url, headers, payload });
  expect(unsigned.statusCode).toBe(401);
  expect(unsigned.json().error.messageKey).toBe('errors.signInRequired');
  const noCsrf = await server.app.inject({
    method: 'POST',
    url,
    headers: { cookie: server.owner.headers.cookie, ...headers },
    payload,
  });
  expect(noCsrf.statusCode).toBe(403);
  expect(noCsrf.json().error.messageKey).toBe('errors.csrfMismatch');
  const signed = await server.app.inject({
    method: 'POST',
    url,
    headers: { ...server.owner.headers, ...headers },
    payload,
  });
  expect(signed.statusCode, signed.body).toBe(200);
  expect(signed.json().status).toBe('applied');
});

it('gives a real access token no way to activate ingest through either route', async () => {
  const table = await ready();
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Setup', scopes: ['schema.bases:read', 'schema.bases:write'], databases: 'all' },
  });
  expect(created.statusCode, created.body).toBe(200);
  for (const path of ['go-live', 'commands']) {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${table.tableId}/ingest/${path}`,
      headers: { authorization: `Bearer ${created.json().token}` },
      payload: { id: newId('command'), kind: 'ingest.goLive' },
    });
    expect(response.statusCode, response.body).toBe(401);
    expect(response.json().error.messageKey).toBe('errors.signInRequired');
  }
  expect((await loadTable(server.pool, server.schemas, table.tableId))!.ingest!.state).toBe('setup');
});

for (const door of ['token', 'mcp', 'automation', 'proposal', 'script', 'routine'] as const)
  it(`refuses go-live through ${door} with the person-button message`, async () => {
    const actor = (await actorFor(
      server.pool,
      server.schemas,
      server.owner.userId,
      server.owner.info.org.id,
    ))!;
    const modified = {
      ...actor,
      sessionId: 'session',
      ...(door === 'token' || door === 'mcp'
        ? { token: { id: 'token', databases: null, scopes: ['schema.bases:write' as const] } }
        : {}),
      ...(door === 'automation' ? { automation: { id: 'automation', runId: 'run', depth: 0 } } : {}),
      ...(door === 'script' ? { script: { id: 'script', runId: 'run' } } : {}),
      ...(door === 'routine' ? { routine: { id: 'routine', runId: 'run' } } : {}),
    };
    await expect(
      runIngestSetupCommand(
        server.app,
        modified,
        { id: newId('command'), tableId: working.tableId, kind: 'ingest.goLive' },
        door === 'proposal' ? 'proposal' : door === 'mcp' ? 'mcp' : 'person',
      ),
    ).rejects.toMatchObject({ messageKey: 'ingest.setup.personMustGoLive' });
  });

it('goes live with the five process fields, review view, hidden fields, and only passing formats live, then pauses and resumes', async () => {
  const table = await ready();
  const unfinished = await format(table.tableId);
  const live = await applied(table.tableId, 'ingest.goLive');
  expect(live.settings).toMatchObject({ state: 'live', ownerId: server.owner.userId });
  const fields = await loadFields(server.pool, server.schemas, [table.tableId]);
  expect(
    Object.fromEntries(
      fields
        .filter((field) => field.ingest?.role === 'process')
        .map((field) => [field.ingest!.key, field.type]),
    ),
  ).toEqual(INGEST_PROCESS_FIELDS);
  expect(fields.find((field) => field.ingest?.key === 'received')).toMatchObject({
    type: 'date',
    options: { includeTime: true },
  });
  const views = await loadViews(server.pool, server.schemas, [table.tableId]);
  const needsReview = fields.find((field) => field.ingest?.key === 'needsReview')!;
  expect(views.find((view) => view.name === 'Needs review')!.config.filter).toMatchObject({
    conditions: [{ fieldId: needsReview.id, operator: 'is', value: true }],
  });
  expect(views.find((view) => view.id === table.viewId)!.config.hiddenFieldIds).toEqual(
    fields
      .filter((field) => ['readByAi', 'source', 'received'].includes(field.ingest?.key ?? ''))
      .map((field) => field.id),
  );
  const formats = await store.listFormats({ orgId: server.owner.info.org.id, tableId: table.tableId });
  expect(formats.find((format) => format.id === table.format.id)!.state).toBe('live');
  expect(formats.find((format) => format.id === unfinished.id)!.state).toBe('draft');
  expect((await call(table.tableId, 'ingest.goLive')).json().error.messageKey).toBe('ingest.setup.state');
  expect((await applied(table.tableId, 'ingest.pause')).settings.state).toBe('paused');
  expect((await call(table.tableId, 'ingest.goLive')).json().error.messageKey).toBe('ingest.setup.state');
  expect((await applied(table.tableId, 'ingest.resume')).settings.state).toBe('live');
  expect((await call(table.tableId, 'ingest.resume')).json().error.messageKey).toBe('ingest.setup.state');
  const current = await server.app.inject({
    url: `/api/tables/${table.tableId}/ingest/readiness`,
    headers: server.owner.headers,
  });
  expect(current.json<IngestReadiness>().ready).toBe(true);
});

it('takes over with the previous owner audited, previews and confirms redo, and turns off atomically', async () => {
  const table = await ready();
  await applied(table.tableId, 'ingest.goLive');
  await server.pool.query(
    `UPDATE ${server.schemas.app}.grants SET role = 'creator' WHERE resource_id = $1 AND principal_id = $2`,
    [table.databaseId, editor.userId],
  );
  const takeover = await call(table.tableId, 'ingest.takeOver', {}, editor);
  expect(takeover.statusCode, takeover.body).toBe(200);
  expect(takeover.json().output).toMatchObject({
    previousOwnerId: server.owner.userId,
    settings: { ownerId: editor.userId },
  });
  const events = await server.pool.query(
    `SELECT metadata FROM ${server.schemas.audit}.events WHERE action = 'data.ingest.takeOver' AND metadata->>'tableId' = $1`,
    [table.tableId],
  );
  expect(events.rows[0]!.metadata.previousOwnerId).toBe(server.owner.userId);
  const settings = (await loadTable(server.pool, server.schemas, table.tableId))!.ingest!;
  const preview = await applied(table.tableId, 'ingest.redo', { revision: settings.revision, dryRun: true });
  expect(preview.erased.formats).toHaveLength(1);
  expect(preview.erased.examples).toHaveLength(3);
  expect(preview.stays.fields).toHaveLength(6);
  expect(preview.stays.rows).toBe(0);
  expect((await loadTable(server.pool, server.schemas, table.tableId))!.ingest).toEqual(settings);
  expect(
    (await call(table.tableId, 'ingest.redo', { revision: settings.revision })).json().error.messageKey,
  ).toBe('ingest.setup.confirmRedo');
  expect(
    (await call(table.tableId, 'ingest.redo', { revision: settings.revision - 1, confirm: true })).json()
      .error.messageKey,
  ).toBe('ingest.tables.stale');
  const reset = await applied(table.tableId, 'ingest.redo', { revision: settings.revision, confirm: true });
  expect(reset.settings).toMatchObject({
    state: 'setup',
    rowMeaning: '',
    identityDecided: false,
    fields: [],
  });
  expect(
    (await loadFields(server.pool, server.schemas, [table.tableId])).every((field) => !field.ingest),
  ).toBe(true);
  expect(await store.listFormats({ orgId: server.owner.info.org.id, tableId: table.tableId })).toEqual([]);
  await output(table, reset.settings);
  await applied(table.tableId, 'ingest.turnOff');
  expect((await loadTable(server.pool, server.schemas, table.tableId))!.ingest).toBeUndefined();
  const converted = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'field.convert',
          fieldId: table.fieldId,
          to: { type: 'number' },
        },
      ],
    },
  });
  expect(converted.json().results[0].status).toBe('applied');
});

it('requires a prior matching offer for warnings and returns every non-blocking finding', async () => {
  const table = await newTable();
  await output(table, await begin(table));
  const saved = await format(table.tableId);
  const offered = {
    formatId: saved.id,
    file: file('Incoming,Extra\n1,x\n2,x\n3,x\n4,x\n5,x\n6,x\n'),
    expected: { kind: 'paste', text: 'value\n21\n' },
  };
  const bypass = await call(table.tableId, 'ingest.example.add', { ...offered, confirm: true });
  expect(bypass.json().error.messageKey).toBe('ingest.setup.confirmPair');
  expect(bypass.json().details.findings.map((finding: { kind: string }) => finding.kind)).toEqual([
    'absent-value',
    'row-shortfall',
    'summary',
  ]);
  const changed = await call(table.tableId, 'ingest.example.add', {
    ...offered,
    expected: { kind: 'paste', text: 'value\n22\n' },
    confirm: true,
    confirmationId: bypass.json().details.confirmationId,
  });
  expect(changed.json().error.messageKey).toBe('ingest.setup.confirmPair');
  expect(await store.listExamples({ orgId: server.owner.info.org.id, tableId: table.tableId })).toEqual([]);
  const confirmed = await applied(table.tableId, 'ingest.example.add', {
    ...offered,
    confirm: true,
    confirmationId: bypass.json().details.confirmationId,
  });
  expect(confirmed.findings).toEqual(bypass.json().details.findings);
});

it('checks unanswered required-field provenance and requires an answer to the current question version', async () => {
  const table = await ready();
  const orgId = server.owner.info.org.id;
  const document = {
    id: 'source-question',
    kind: 'valueSource',
    key: 'value',
    target: { type: 'field', field: 'value' },
  };
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.ingest_questions (id, org_id, table_id, version, document) VALUES ($1, $2, $3, 'v2', $4)`,
    [document.id, orgId, table.tableId, document],
  );
  const get = async () =>
    (
      await server.app.inject({
        url: `/api/tables/${table.tableId}/ingest/readiness`,
        headers: server.owner.headers,
      })
    ).json<IngestReadiness>();
  expect((await get()).gates.find((gate) => gate.id === 'G4')).toEqual({
    id: 'G4',
    met: false,
    gaps: [{ messageId: 'ingest.ready.valueSource', facts: { field: 'value', questionId: document.id } }],
  });
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.ingest_answers (id, org_id, table_id, question_id, question_version, question_document, response, answered_by)
    VALUES ($1, $2, $3, $4, 'v1', $5, '{"type":"answer","answer":{"type":"text","value":"From the receipt"}}', $6)`,
    [newId('command'), orgId, table.tableId, document.id, document, server.owner.userId],
  );
  expect((await get()).gates.find((gate) => gate.id === 'G4')!.met).toBe(false);
  await server.pool.query(
    `UPDATE ${server.schemas.app}.ingest_answers SET question_version = 'v2' WHERE question_id = $1`,
    [document.id],
  );
  expect((await get()).ready).toBe(true);
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.ingest_answers (id, org_id, table_id, question_id, question_version, question_document, response, answered_by)
    VALUES ($1, $2, $3, $4, 'v2', $5, '{"type":"unknown"}', $6)`,
    [newId('command'), orgId, table.tableId, document.id, document, server.owner.userId],
  );
  const unknown = await get();
  expect(unknown.ready).toBe(false);
  expect(unknown.gates.find((gate) => gate.id === 'G4')!.gaps).toEqual([
    { messageId: 'ingest.ready.valueSource', facts: { field: 'value', questionId: document.id } },
  ]);
  const refused = await call(table.tableId, 'ingest.goLive');
  expect(refused.statusCode, refused.body).toBe(422);
  expect(refused.json().details.readiness).toEqual(unknown);
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.ingest_answers (id, org_id, table_id, question_id, question_version, question_document, response, answered_by)
    VALUES ($1, $2, $3, $4, $5, $6, '{"type":"answer","answer":{"type":"text","value":"From the receipt"}}', $7)`,
    [newId('command'), orgId, table.tableId, document.id, 'v1', document, server.owner.userId],
  );
  expect((await get()).ready).toBe(false);
  await server.pool.query(
    `UPDATE ${server.schemas.app}.ingest_answers SET question_version = 'v2' WHERE question_id = $1 AND question_version = 'v1'`,
    [document.id],
  );
  expect((await get()).ready).toBe(true);
});

it('rechecks readiness after a successful read and preserves all metadata when activation has gaps', async () => {
  const table = await ready();
  const context = { orgId: server.owner.info.org.id, tableId: table.tableId };
  const get = await server.app.inject({
    url: `/api/tables/${table.tableId}/ingest/readiness`,
    headers: server.owner.headers,
  });
  expect(get.json().ready).toBe(true);
  const examples = await store.listExamples(context);
  await applied(table.tableId, 'ingest.example.remove', { exampleId: examples[0]!.id });
  const result = await call(table.tableId, 'ingest.goLive');
  expect(result.json().error.messageKey).toBe('ingest.setup.notReady');
  expect(result.json().details.readiness.gates.find((gate: { id: string }) => gate.id === 'G3').gaps).toEqual(
    [{ messageId: 'ingest.ready.examples', facts: { format: table.format.id, count: 2, needed: 3 } }],
  );
  expect(
    (await loadFields(server.pool, server.schemas, [table.tableId])).map((field) => field.ingest?.role),
  ).toEqual(['data']);
  expect(await loadViews(server.pool, server.schemas, [table.tableId])).toHaveLength(1);
});

it('refuses a go-live request without a session before reading its body', async () => {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${working.tableId}/ingest/go-live`,
    headers: { authorization: 'Bearer external-token' },
    payload: { id: newId('command') },
  });
  expect(response.statusCode).toBe(401);
  expect(response.json().error.messageKey).toBe('errors.signInRequired');
});

it('refuses activation in the proposal entry point before a proposal can be saved', async () => {
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  await expect(
    propose(
      server.app,
      actor,
      'conversation',
      {
        databaseId: working.databaseId,
        summary: 'Activate ingest',
        steps: ['Activate ingest'],
        commands: [{ kind: 'ingest.goLive', tableId: working.tableId }],
      },
      'ask',
      'ask',
    ),
  ).rejects.toMatchObject({ messageKey: 'ingest.setup.personMustGoLive' });
});

it('creates only missing process fields when valid process marks already exist', async () => {
  const table = await ready();
  const fieldId = newId('field');
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'field.create',
          tableId: table.tableId,
          field: { id: fieldId, name: 'Arrival source', type: 'text' },
        },
      ],
    },
  });
  expect(response.json().results[0].status).toBe('applied');
  await store.markField(
    { orgId: server.owner.info.org.id, tableId: table.tableId, userId: server.owner.userId },
    fieldId,
    { role: 'process', key: 'source' },
  );
  await applied(table.tableId, 'ingest.goLive');
  const fields = await loadFields(server.pool, server.schemas, [table.tableId]);
  expect(fields).toHaveLength(6);
  expect(fields.filter((field) => field.ingest?.key === 'source').map((field) => field.id)).toEqual([
    fieldId,
  ]);
});

async function restrictEvidence(
  table: Awaited<ReturnType<typeof newTable>>,
  restriction: 'field' | 'record',
) {
  const target = { orgId: editor.info.org.id, databaseId: table.databaseId, tableId: table.tableId };
  if (restriction === 'field')
    await saveFieldRules(
      server.pool,
      server.schemas,
      { ...target, fieldId: table.fieldId },
      { restricted: { roles: ['owner'], users: [] }, locked: null },
      server.owner.userId,
    );
  else
    await saveRecordRules(
      server.pool,
      server.schemas,
      target,
      [
        {
          id: newId('recordRule'),
          roles: ['creator'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'visible-records', fieldId: table.fieldId, operator: 'is', value: 'Visible' }],
          },
        },
      ],
      server.owner.userId,
    );
  const actor = (await actorFor(server.pool, server.schemas, editor.userId, editor.info.org.id))!;
  const scope = new AccessScope(server.pool, server.schemas, actor);
  await scope.require(table.databaseId, 'editSchema');
  if (restriction === 'field')
    expect(
      scope.visibleFields(table.tableId, await loadFields(server.pool, server.schemas, [table.tableId])),
    ).toEqual([]);
  else expect(scope.limitsRecords(table.tableId)).toBe(true);
}

async function evidenceEditor(table: Awaited<ReturnType<typeof newTable>>) {
  await server.pool.query(
    `UPDATE ${server.schemas.app}.grants SET role = 'creator' WHERE resource_id = $1 AND principal_id = $2`,
    [table.databaseId, editor.userId],
  );
}

it.each(['field', 'record'] as const)(
  'refuses restricted %s evidence in drafts, rule differences, and readiness',
  async (restriction) => {
    const table = await newTable();
    await output(table, await begin(table));
    const saved = await format(table.tableId);
    const secret = randomBytes(24).toString('hex');
    const evidence = await example(table.tableId, saved.id, secret);
    await evidenceEditor(table);
    await restrictEvidence(table, restriction);
    const requests = [
      await call(
        table.tableId,
        'ingest.example.add',
        {
          formatId: saved.id,
          file: file('Incoming,Extra\nOther,x\n'),
          expected: { kind: 'draft', exampleId: evidence.id },
        },
        editor,
      ),
      await call(
        table.tableId,
        'ingest.format.rules',
        {
          formatId: saved.id,
          revision: saved.revision,
          signature,
          reading: 'reader',
          rules: {
            toolkitVersion: TOOLKIT_VERSION,
            code: "await emit([{ values: { value: 'Other' }, at: {}, raw: {} }])",
          },
        },
        editor,
      ),
      await server.app.inject({
        url: `/api/tables/${table.tableId}/ingest/readiness`,
        headers: editor.headers,
      }),
      await server.app.inject({
        url: `/api/tables/${table.tableId}/ingest`,
        headers: editor.headers,
      }),
    ];
    for (const response of requests) {
      expect(response.body).not.toContain(secret);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.messageKey).toBe('data.access.denied');
    }
    expect(await store.listExamples({ orgId: editor.info.org.id, tableId: table.tableId })).toEqual([
      evidence,
    ]);
  },
);

for (const evidenceKind of ['example', 'warning', 'rules'] as const)
  it.each(['field', 'record'] as const)(
    `projects ${evidenceKind} replays after %s access is revoked`,
    async (restriction) => {
      const table = await newTable();
      await output(table, await begin(table));
      const saved = await format(table.tableId);
      const secret = randomBytes(24).toString('hex');
      if (evidenceKind === 'rules') await example(table.tableId, saved.id, secret);
      await evidenceEditor(table);
      const id = newId('command');
      const kind = evidenceKind === 'rules' ? 'ingest.format.rules' : 'ingest.example.add';
      const input =
        evidenceKind === 'rules'
          ? {
              formatId: saved.id,
              revision: saved.revision,
              signature,
              reading: 'reader',
              rules: {
                toolkitVersion: TOOLKIT_VERSION,
                code: "await emit([{ values: { value: 'Other' }, at: {}, raw: {} }])",
              },
            }
          : {
              formatId: saved.id,
              file: file(`Incoming,Extra\n${evidenceKind === 'warning' ? 'Other' : secret},x\n`),
              expected: { kind: 'paste', text: `value\n${secret}\n` },
            };
      const first = await call(table.tableId, kind, { ...input, id }, editor);
      expect(first.body).toContain(secret);
      expect(first.json().status).toBe(evidenceKind === 'warning' ? 'rejected' : 'applied');
      const readableReplay = await call(table.tableId, kind, { ...input, id }, editor);
      expect(readableReplay.body).toContain(secret);
      expect(readableReplay.json().output).toEqual(first.json().output);
      expect(readableReplay.json().details).toEqual(first.json().details);
      const disguisedReplay = await call(
        table.tableId,
        'ingest.propose',
        { id, file: file('Name\nVisible\n') },
        editor,
      );
      expect(disguisedReplay.statusCode, disguisedReplay.body).toBe(404);
      expect(disguisedReplay.body).not.toContain(secret);
      const stored = await server.pool.query(
        `SELECT result FROM ${server.schemas.app}.commands WHERE id = $1`,
        [id],
      );
      expect(JSON.stringify(stored.rows[0].result)).not.toContain(secret);
      await restrictEvidence(table, restriction);
      const setupReplay = await call(table.tableId, kind, { ...input, id }, editor);
      expect(setupReplay.body).not.toContain(secret);
      expect(setupReplay.statusCode, setupReplay.body).toBe(403);
      const ordinaryReplay = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${table.databaseId}/commands`,
        headers: editor.headers,
        payload: {
          clientId: newId('client'),
          commands: [
            {
              id,
              groupId: newId('action'),
              kind: 'table.update',
              tableId: table.tableId,
              name: 'Replay only',
            },
          ],
        },
      });
      expect(ordinaryReplay.statusCode, ordinaryReplay.body).toBe(200);
      expect(ordinaryReplay.body).not.toContain(secret);
      expect(ordinaryReplay.json().results[0].status).toBe(
        evidenceKind === 'warning' ? 'rejected' : 'duplicate',
      );
      expect((await store.listExamples({ orgId: editor.info.org.id, tableId: table.tableId })).length).toBe(
        evidenceKind === 'warning' ? 0 : 1,
      );
    },
  );

it.each(['field', 'record'] as const)(
  'refuses format rename when its saved checks contain restricted %s evidence',
  async (restriction) => {
    const table = await newTable();
    await output(table, await begin(table));
    const saved = await format(table.tableId);
    const secret = randomBytes(24).toString('hex');
    await example(table.tableId, saved.id, secret);
    const checked = await rules(table.tableId, saved, {
      reading: 'reader',
      rules: {
        toolkitVersion: TOOLKIT_VERSION,
        code: "await emit([{ values: { value: 'Other' }, at: {}, raw: {} }])",
      },
    });
    expect(JSON.stringify(checked.pairs)).toContain(secret);
    await evidenceEditor(table);
    await restrictEvidence(table, restriction);
    const response = await call(
      table.tableId,
      'ingest.format.rename',
      { formatId: saved.id, name: 'Renamed' },
      editor,
    );
    expect(response.statusCode, response.body).toBe(403);
    expect(response.body).not.toContain(secret);
    expect(
      (await store.readFormat({ orgId: editor.info.org.id, tableId: table.tableId }, saved.id))!.name,
    ).toBe(saved.name);
  },
);

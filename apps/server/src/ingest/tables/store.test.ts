import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseCreate, IngestTableSettings, newId, type IngestExample } from '@riosoma/contracts';
import { FILE_STATES, type FormatDefinition } from '@riosoma/ingest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { IngestTableStore, type IngestActor } from './store.js';
import { loadField, loadTable } from '../../data/metadata.js';
import { demoIngestTables, demoSchema } from '../../demo/metadata.js';

let kit: TestPostgres;
let server: ServerFixture;
let store: IngestTableStore;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'ingesttables');
  store = new IngestTableStore(server.pool, server.schemas);
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
async function table() {
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Incoming',
    table: {
      id: newId('table'),
      name: 'Arrivals',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const result = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(result.statusCode, result.body).toBe(200);
  const context: IngestActor = {
    orgId: server.owner.info.org.id,
    tableId: input.table.id,
    userId: server.owner.userId,
  };
  return { context, fieldId: input.table.fields[0]!.id, schema: result.json() };
}
const setup = () =>
  IngestTableSettings.parse({
    state: 'setup',
    ownerId: null,
    rowMeaning: 'One arrival',
    identity: null,
    fields: [],
    originals: { keepDays: null },
    revision: 0,
  });
const format: FormatDefinition = {
  name: 'Text',
  reading: 'ai',
  rules: null,
  state: 'draft',
  probationPassed: 0,
  signature: { id: 'text', kind: 'text', headerGroups: [], markers: [] },
};
const file = () => ({
  origin: 'drop' as const,
  name: 'incoming.csv',
  mediaType: 'text/csv',
  sizeBytes: 12,
  sha256: 'a'.repeat(64),
  storedFile: 'original-key',
  expiresAt: '2026-12-01T00:00:00.000Z',
});

it('stores settings with defaults, serializes revision checks, and removes field marks atomically', async () => {
  const { context, fieldId } = await table();
  expect(await store.readSettings(context)).toBeNull();
  const first = await store.changeSettings(context, null, setup());
  expect(first).toMatchObject({ revision: 1, reply: true, originals: { readOnlyAccess: false } });
  await store.markField(context, fieldId, { key: 'name', role: 'data' });
  await expect(store.markField(context, fieldId, { key: 'other', role: 'data' })).rejects.toMatchObject({
    messageKey: 'ingest.tables.invalid',
  });
  const changes = await Promise.allSettled([
    store.changeSettings(context, 1, setup()),
    store.changeSettings(context, 1, setup()),
  ]);
  expect(changes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(changes.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { messageKey: 'ingest.tables.stale' },
  });
  await expect(store.changeSettings(context, 1, null)).rejects.toMatchObject({
    messageKey: 'ingest.tables.stale',
  });
  await store.changeSettings(context, 2, null);
  expect((await loadField(server.pool, server.schemas, fieldId))?.ingest).toBeUndefined();
  expect((await loadTable(server.pool, server.schemas, context.tableId))?.ingest).toBeUndefined();
  expect((await store.changeSettings(context, null, setup()))?.revision).toBe(4);
  await expect(store.changeSettings(context, 1, setup())).rejects.toMatchObject({
    messageKey: 'ingest.tables.stale',
  });
});

it('uses the shared audit helper, refuses demo changes, and rolls back when an audit write fails', async () => {
  const { context } = await table();
  const unitId = newId('orgUnit');
  await store.changeSettings({ ...context, auditUnitId: unitId }, null, setup());
  const events = await server.pool.query(
    `SELECT metadata FROM ${server.schemas.audit}.events WHERE action = 'data.ingest.settings.changed' AND metadata->>'tableId' = $1`,
    [context.tableId],
  );
  expect(events.rows).toEqual([{ metadata: { tableId: context.tableId, unitId } }]);
  await expect(
    store.createSender(
      { ...context, demo: true },
      { label: 'Sender', kind: 'domain', value: 'example.test', approved: true },
    ),
  ).rejects.toMatchObject({ messageKey: 'demo.readOnly' });
  await server.pool
    .query(`CREATE FUNCTION ${server.schemas.audit}.reject_ingest_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action LIKE 'data.ingest.%' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_ingest_test BEFORE INSERT ON ${server.schemas.audit}.events FOR EACH ROW EXECUTE FUNCTION ${server.schemas.audit}.reject_ingest_test()`);
  try {
    await expect(store.changeSettings(context, 1, null)).rejects.toThrow('audit unavailable');
    expect((await store.readSettings(context))?.revision).toBe(1);
  } finally {
    await server.pool.query(
      `DROP TRIGGER reject_ingest_test ON ${server.schemas.audit}.events; DROP FUNCTION ${server.schemas.audit}.reject_ingest_test()`,
    );
  }
});

it('cannot attach setup to a joined or synced table, or attach a source to an ingest table', async () => {
  const { context } = await table();
  await server.pool.query(`UPDATE ${server.schemas.app}.tables SET joined = '{}' WHERE id = $1`, [
    context.tableId,
  ]);
  await expect(store.changeSettings(context, null, setup())).rejects.toMatchObject({
    messageKey: 'ingest.tables.exclusive',
  });
  await server.pool.query(`UPDATE ${server.schemas.app}.tables SET joined = NULL WHERE id = $1`, [
    context.tableId,
  ]);
  await store.changeSettings(context, null, setup());
  await expect(
    server.pool.query(`UPDATE ${server.schemas.app}.tables SET joined = '{}' WHERE id = $1`, [
      context.tableId,
    ]),
  ).rejects.toMatchObject({ code: '23514' });
  const sourceId = newId('source');
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.sources (id, org_id, name, kind, connection, sealed_secrets, access, created_by)
    VALUES ($1, $2, 'Incoming', 'webhook', '{}', '', 'creators', $3)`,
    [sourceId, context.orgId, context.userId],
  );
  const attach = () =>
    server.pool.query(
      `INSERT INTO ${server.schemas.app}.table_sources (table_id, source_id, settings, status)
    VALUES ($1, $2, '{"select":{"kind":"object","name":"Incoming"},"freshness":"copy","keyColumns":[],"everyMinutes":null,"allowOverrides":false,"holdAboveDeleteShare":null}', '{"state":"idle"}')`,
      [context.tableId, sourceId],
    );
  await expect(attach()).rejects.toMatchObject({ code: '23514' });
  await store.changeSettings(context, 1, null);
  await attach();
  await expect(store.changeSettings(context, null, setup())).rejects.toMatchObject({
    messageKey: 'ingest.tables.exclusive',
  });
});

it('creates, reads, lists, and updates senders, formats, files, examples, and row state', async () => {
  const { context } = await table();
  const sender = await store.createSender(context, {
    label: 'Accounts',
    kind: 'address',
    value: 'ACCOUNT@EXAMPLE.TEST',
    approved: false,
  });
  expect(sender.value).toBe('account@example.test');
  await expect(
    store.createSender(context, { label: 'Again', kind: 'address', value: sender.value, approved: false }),
  ).rejects.toMatchObject({ code: '23505' });
  const domain = await store.createSender(context, {
    label: 'Domain',
    kind: 'domain',
    value: sender.value,
    approved: false,
  });
  expect((await store.listSenders(context)).map((item) => item.id)).toEqual([sender.id, domain.id]);
  expect(await store.readSender(context, sender.id)).toEqual(sender);
  expect(await store.updateSender(context, sender.id, { approved: true })).toMatchObject({ approved: true });
  const savedFormat = await store.createFormat(context, format);
  expect(await store.readFormat(context, savedFormat.id)).toEqual(savedFormat);
  expect(await store.listFormats(context)).toEqual([savedFormat]);
  const updatedFormat = await store.updateFormat(context, savedFormat.id, 1, {
    ...format,
    reading: 'reader',
    rules: { code: 'return []', toolkitVersion: '1' },
    state: 'probation',
  });
  expect(updatedFormat).toMatchObject({ revision: 2, reading: 'reader', rules: { toolkitVersion: '1' } });
  await expect(store.updateFormat(context, savedFormat.id, 1, format)).rejects.toMatchObject({
    messageKey: 'ingest.tables.stale',
  });
  const arrival = await store.createFile(context, { ...file(), senderId: sender.id });
  expect(await store.readFile(context, arrival.id)).toEqual(arrival);
  expect(await store.listFiles(context)).toEqual([arrival]);
  const read = await store.updateFile(context, arrival.id, {
    state: 'reading',
    attempts: 1,
    leasedBy: 'worker',
    leaseUntil: '2026-12-01T00:00:00.000Z',
  });
  expect(read).toMatchObject({ attempts: 1, state: 'reading' });
  const example = await store.createExample(context, {
    formatId: savedFormat.id,
    fileId: arrival.id,
    own: true,
    expected: [{ values: { name: 'Gold' } }],
  });
  expect(await store.readExample(context, example.id)).toEqual(example);
  expect(example.confirmedFindings).toEqual([]);
  expect(await store.listExamples(context, savedFormat.id)).toEqual([example]);
  expect(
    await store.updateExample(context, example.id, {
      lastResult: {
        passed: false,
        differences: [{ row: 0, key: 'name', expected: 'Gold', actual: 'Silver' }],
      },
    }),
  ).toMatchObject({ lastResult: { passed: false } });
  expect(await store.readFile(context, arrival.id)).toMatchObject({ isExample: true, expiresAt: null });
  await expect(store.updateFile(context, arrival.id, { storedFile: null })).rejects.toMatchObject({
    messageKey: 'ingest.examples.kept',
  });
  await expect(
    store.updateFile(context, arrival.id, { expiresAt: '2027-01-01T00:00:00.000Z' }),
  ).rejects.toMatchObject({ messageKey: 'ingest.examples.kept' });
  const index = await server.pool.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'ingest_files_expiry'`,
    [server.schemas.app],
  );
  expect(index.rows[0].indexdef).toContain('NOT is_example');
  const recordId = newId('record');
  const row = await store.createRowState(context, {
    recordId,
    fileId: arrival.id,
    identity: 'b'.repeat(64),
    hashes: { name: 'c'.repeat(64) },
  });
  expect(await store.readRowState(context, recordId)).toEqual(row);
  expect(await store.listRowState(context, arrival.id)).toEqual([row]);
  await expect(store.createRowState(context, { ...row, recordId: newId('record') })).rejects.toMatchObject({
    code: '23505',
  });
  await store.createRowState(context, { ...row, recordId: newId('record'), identity: null });
  await store.createRowState(context, { ...row, recordId: newId('record'), identity: null });
  expect(
    await store.updateRowState(context, recordId, {
      fileId: arrival.id,
      identity: 'd'.repeat(64),
      hashes: {},
    }),
  ).toMatchObject({ identity: 'd'.repeat(64), hashes: {} });
  const foreign = { ...context, orgId: newId('org') };
  await expect(store.readFile(foreign, arrival.id)).rejects.toMatchObject({ messageKey: 'errors.notFound' });
});

it('preserves confirmed findings through result updates and clears them when expected rows change', async () => {
  const { context } = await table();
  const savedFormat = await store.createFormat(context, format);
  const arrival = await store.createFile(context, file());
  const confirmedFindings: IngestExample['confirmedFindings'] = [
    {
      kind: 'input-as-output',
      messageId: 'ingest.pairs.inputAsOutput',
      blocks: false,
      facts: { table: 'Orders' },
    },
  ];
  const example = await store.createExample(context, {
    formatId: savedFormat.id,
    fileId: arrival.id,
    own: true,
    expected: [{ values: { name: 'Gold' } }],
    confirmedFindings,
  });
  expect(await store.readExample(context, example.id)).toMatchObject({ confirmedFindings });
  expect(
    await store.updateExample(context, example.id, { lastResult: { passed: true, differences: [] } }),
  ).toMatchObject({ confirmedFindings });
  await store.updateExample(context, example.id, { expected: [{ values: { name: 'Silver' } }] });
  expect(await store.readExample(context, example.id)).toMatchObject({ confirmedFindings: [] });
});

it('checks composite references, file ancestry, and table deletion', async () => {
  const one = await table();
  const two = await table();
  const sender = await store.createSender(one.context, {
    label: 'Sender',
    kind: 'domain',
    value: 'example.test',
    approved: true,
  });
  await expect(store.createFile(two.context, { ...file(), senderId: sender.id })).rejects.toMatchObject({
    code: '23503',
  });
  const parent = await store.createFile(one.context, { ...file(), origin: 'email' });
  const part = await store.createFile(one.context, { ...file(), origin: 'part', parentId: parent.id });
  expect(part.seq).toBeGreaterThan(parent.seq);
  const droppedEmail = await store.createFile(one.context, { ...file(), mediaType: 'message/rfc822' });
  const droppedPart = await store.createFile(one.context, {
    ...file(),
    origin: 'part',
    parentId: droppedEmail.id,
  });
  expect(droppedPart.parentId).toBe(droppedEmail.id);
  await expect(
    store.createFile(one.context, { ...file(), origin: 'part', parentId: part.id }),
  ).rejects.toMatchObject({ messageKey: 'ingest.tables.invalid' });
  const savedFormat = await store.createFormat(one.context, format);
  await store.createExample(one.context, {
    formatId: savedFormat.id,
    fileId: part.id,
    expected: [],
    own: false,
  });
  await store.createRowState(one.context, {
    recordId: newId('record'),
    fileId: part.id,
    identity: null,
    hashes: {},
  });
  await server.pool.query(`DELETE FROM ${server.schemas.app}.tables WHERE id = $1`, [one.context.tableId]);
  for (const catalog of [
    'ingest_senders',
    'ingest_formats',
    'ingest_files',
    'ingest_examples',
    'ingest_row_state',
  ]) {
    const count = await server.pool.query(
      `SELECT count(*)::int AS total FROM ${server.schemas.app}.${catalog} WHERE table_id = $1`,
      [one.context.tableId],
    );
    expect(count.rows[0].total, catalog).toBe(0);
  }
});

it('omits private setup, field marks, and storage in demo projections', async () => {
  const { context, fieldId, schema } = await table();
  const setting = await store.changeSettings(context, null, setup());
  schema.tables[0].ingest = setting;
  schema.fields.find((field: { id: string }) => field.id === fieldId).ingest = {
    key: 'privateKey',
    role: 'data',
  };
  const demo = demoSchema(schema);
  expect(demo.tables[0]!.ingest).toBeUndefined();
  expect(demo.fields[0]!.ingest).toBeUndefined();
  expect(demoIngestTables()).toEqual({
    settings: null,
    senders: [],
    formats: [],
    files: [],
    examples: [],
    rowState: [],
  });
});

const expectedSteps = {
  received: 'held waiting reading skipped removed',
  held: 'waiting skipped removed',
  waiting: 'held reading skipped removed',
  reading: 'waiting held read failed skipped removed',
  read: 'waiting removed',
  failed: 'waiting skipped removed',
  skipped: 'waiting removed',
  removed: '',
};
describe('file state steps', () => {
  for (const before of FILE_STATES)
    for (const after of FILE_STATES) {
      it(`${before} to ${after}`, async () => {
        const { context } = await table();
        const arrival = await store.createFile(context, file());
        await server.pool.query(`UPDATE ${server.schemas.app}.ingest_files SET state = $1 WHERE id = $2`, [
          before,
          arrival.id,
        ]);
        const result = store.updateFile(context, arrival.id, { state: after });
        if (before === after || expectedSteps[before].split(' ').includes(after))
          await expect(result).resolves.toMatchObject({ state: after });
        else await expect(result).rejects.toMatchObject({ messageKey: 'ingest.files.state' });
      });
    }
});

it('round-trips layout rules and rejects malformed layouts and reader versions', async () => {
  const { context } = await table();
  const rules = {
    header: { markers: ['Name'], searchRows: 10 },
    columns: { name: { aliases: ['Name'], cleaners: [{ kind: 'text' as const }] } },
  };
  const saved = await store.createFormat(context, { ...format, reading: 'layout', rules });
  expect(saved).toMatchObject({ reading: 'layout', rules });
  expect(await store.readFormat(context, saved.id)).toEqual(saved);
  await expect(
    store.createFormat(context, {
      ...format,
      reading: 'layout',
      rules: { ...rules, header: { markers: [], searchRows: 10 } },
    }),
  ).rejects.toThrow();
  await expect(
    store.createFormat(context, {
      ...format,
      reading: 'reader',
      rules: { code: 'return []', toolkitVersion: '' },
    }),
  ).rejects.toThrow();
});

it('marks each fixed process field only with its required type, including time on received', async () => {
  const { context, fieldId, schema } = await table();
  await store.changeSettings(context, null, setup());
  await expect(
    store.markField(context, fieldId, { key: 'needsReview', role: 'process' }),
  ).rejects.toMatchObject({ messageKey: 'ingest.tables.invalid' });
  const definitions = [
    { key: 'needsReview', type: 'checkbox', options: {} },
    { key: 'reviewNote', type: 'longText', options: {} },
    { key: 'readByAi', type: 'checkbox', options: {} },
    { key: 'source', type: 'text', options: {} },
    { key: 'received', type: 'date', options: { includeTime: true } },
  ].map((definition) => ({ ...definition, id: newId('field') }));
  const result = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${schema.database.id}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: definitions.map((definition) => ({
        kind: 'field.create',
        id: newId('command'),
        groupId: newId('action'),
        tableId: context.tableId,
        field: {
          id: definition.id,
          name: definition.key,
          type: definition.type,
          options: definition.options,
        },
      })),
    },
  });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().results.every((item: { status: string }) => item.status === 'applied')).toBe(true);
  for (const definition of definitions) {
    await store.markField(context, definition.id, { key: definition.key, role: 'process' });
    expect((await loadField(server.pool, server.schemas, definition.id))?.ingest).toEqual({
      key: definition.key,
      role: 'process',
    });
  }
  await store.markField(context, definitions[0]!.id, null);
  expect((await loadField(server.pool, server.schemas, definitions[0]!.id))?.ingest).toBeUndefined();
});

import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DatabaseCreate, LIMITS, newId, type IngestRowReason, type TableMeta } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { serializableValue } from '@riosoma/ingest';
import { ident, query, sql } from '@riosoma/db';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { purgeTrash } from '../../data/purge.js';
import { actorFor } from '../../automations/run.js';
import * as bus from '../../data/commands/index.js';
import { loadFields, loadTable } from '../../data/metadata.js';
import { currentValues } from '../../data/physical/records.js';
import { IngestTableStore } from '../tables/store.js';
import {
  answerIngestRows,
  removeIngestFileRows,
  writeIngestRows,
  type WriteRow,
  type WriterServices,
} from './index.js';
import * as storage from './storage.js';
import { snapshot } from './mutations.js';

let kit: TestPostgres;
let server: ServerFixture;
let store: IngestTableStore;
let services: WriterServices;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'rowwriter');
  store = new IngestTableStore(server.pool, server.schemas);
  services = {
    app: server.app,
    message: (id, params) =>
      id.startsWith('ingest.write.source.')
        ? `${id.slice('ingest.write.source.'.length)} ${params?.value}`
        : `${id} ${JSON.stringify(serializableValue(params ?? {}))}`,
  };
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

interface Column {
  key: string;
  type: string;
  required?: boolean;
  options?: Record<string, unknown>;
}
async function fixture(options: { identity?: string[] | null; columns?: Column[] } = {}) {
  const columns = options.columns ?? [
    { key: 'code', type: 'text', required: true },
    { key: 'amount', type: 'number' },
    { key: 'memo', type: 'longText' },
  ];
  const process = [
    { key: 'needsReview', type: 'checkbox' },
    { key: 'reviewNote', type: 'longText' },
    { key: 'readByAi', type: 'checkbox' },
    { key: 'source', type: 'text' },
    { key: 'received', type: 'date', options: { includeTime: true } },
  ];
  const specs = [...columns, ...process].map((field) => ({ ...field, id: newId('field') }));
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Incoming',
    table: {
      id: newId('table'),
      name: 'Arrivals',
      fields: specs.map((field) => ({ ...field, name: field.key })),
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
  const context = { orgId: server.owner.info.org.id, userId: server.owner.userId, tableId: input.table.id };
  await store.changeSettings(context, null, {
    state: 'live',
    ownerId: server.owner.userId,
    rowMeaning: 'One arrival',
    identity: options.identity === undefined ? ['code'] : options.identity,
    fields: columns.map((column) => ({
      key: column.key,
      fieldId: specs.find((field) => field.key === column.key)!.id,
      meaning: column.key,
      required: column.required ?? false,
    })),
    originals: { keepDays: null, readOnlyAccess: false },
    reply: true,
  });
  for (const spec of specs)
    await store.markField(context, spec.id, {
      key: spec.key,
      role: columns.some((column) => column.key === spec.key) ? 'data' : 'process',
    });
  const table = (await loadTable(server.pool, server.schemas, input.table.id))!;
  const file = await store.createFile(context, {
    origin: 'drop',
    name: 'Q3.xlsx',
    mediaType: 'application/octet-stream',
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
    storedFile: null,
    receivedAt: '2026-10-01T10:30:00.000Z',
  });
  const fieldIds = Object.fromEntries(specs.map((field) => [field.key, field.id]));
  const anotherFile = () =>
    store.createFile(context, {
      origin: 'drop',
      name: 'Q4.xlsx',
      mediaType: 'application/octet-stream',
      sizeBytes: 1,
      sha256: 'b'.repeat(64),
      storedFile: null,
    });
  return { table, file, context, fieldIds, anotherFile };
}
const row = (code: string, amount: unknown = 1, reasons: IngestRowReason[] = []): WriteRow => ({
  values: { code, amount, memo: null },
  at: { sheet: 'Summary', row: 14 },
  raw: {},
  aiFields: [],
  reasons,
});
const question = (questionId = 'question-1', fieldKey = 'amount'): IngestRowReason => ({
  messageId: 'ingest.write.type',
  params: { field: fieldKey },
  fieldKey,
  source: { kind: 'question', questionId },
});
async function records(table: TableMeta) {
  const ids = await server.pool.query<{ __id: string }>(
    `SELECT __id FROM ${server.schemas.data}."${table.id}" WHERE __deleted_at IS NULL ORDER BY __rid`,
  );
  const fields = await loadFields(server.pool, server.schemas, [table.id]);
  const current = await currentValues(
    server.pool,
    server.schemas.data,
    table.id,
    fields,
    ids.rows.map((record) => record.__id),
  );
  return [...current].map(([id, values]) => ({
    id,
    values: Object.fromEntries(fields.map((field) => [field.ingest?.key ?? field.id, values[field.id]])),
  }));
}
async function edit(
  table: TableMeta,
  recordId: string,
  fieldIds: Record<string, string>,
  values: Record<string, unknown>,
) {
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  const result = await bus.runCommands(server.app, actor, table.databaseId, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        kind: 'record.update',
        tableId: table.id,
        records: [
          {
            id: recordId,
            values: Object.fromEntries(Object.entries(values).map(([key, value]) => [fieldIds[key], value])),
          },
        ],
      },
    ],
  });
  expect(result.results[0]).toMatchObject({ status: 'applied' });
}
async function undo(table: TableMeta, groupId: string) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${table.databaseId}/undo`,
    headers: server.owner.headers,
    payload: { clientId: newId('client'), commandId: newId('command'), groupId },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ status: 'applied', skipped: 0 });
}

it('matches identities, preserves leading zeros, defers three differences, and updates exactly the chosen cells', async () => {
  const { table, file, context, fieldIds, anotherFile } = await fixture();
  const input = ['00123', '123', 'third', 'fourth'].map((code) => row(code));
  const first = await writeIngestRows(table, file.id, 'first', input, services);
  expect(first.counts).toEqual({ added: 4, updated: 0, identical: 0, flagged: 0, refused: 0 });
  const existing = await records(table);
  expect(existing.map((record) => record.values.code)).toEqual(['00123', '123', 'third', 'fourth']);
  expect(existing[0]!.values).toMatchObject({
    received: file.receivedAt,
    source: 'Q3.xlsx, sheet Summary, row 14',
    needsReview: false,
    readByAi: false,
  });
  const again = await writeIngestRows(table, file.id, 'again', input, services);
  expect(again.counts).toEqual({ added: 0, updated: 0, identical: 4, flagged: 0, refused: 0 });
  expect(again.busCalls).toBe(0);
  const secondFile = await anotherFile();
  const changed = input.slice(0, 3).map((value) => ({ ...value, values: { ...value.values, amount: 2 } }));
  const pending = await writeIngestRows(table, secondFile.id, 'second', changed, services);
  expect(pending.status).toBe('disagreement');
  expect(pending.disagreements).toHaveLength(3);
  expect(pending.busCalls).toBe(0);
  expect(pending.comparison).toEqual({ identical: 0, different: 3, fileOnly: 0, tableOnly: 1 });
  expect(await records(table)).toEqual(existing);
  const accepted = await writeIngestRows(
    table,
    secondFile.id,
    'second',
    changed,
    services,
    Object.fromEntries(
      pending.disagreements.map((difference) => [difference.identity, { choice: 'takeFile' }]),
    ),
  );
  expect(accepted.counts.updated).toBe(3);
  expect((await records(table)).map((record) => record.values.amount)).toEqual([2, 2, 2, 1]);
  const changes = await server.pool.query(
    `SELECT body FROM ${server.schemas.app}.changes WHERE origin->>'fileId' = $1 AND body->>'kind' = 'record.updated'`,
    [secondFile.id],
  );
  expect(changes.rows).toHaveLength(1);
  for (const record of changes.rows[0].body.records)
    expect(Object.keys(record.values).sort()).toEqual(
      [fieldIds.amount, fieldIds.received, fieldIds.source].sort(),
    );
  expect((await store.readFile(context, secondFile.id))?.counts).toEqual(accepted.counts);
});

it('returns repeated identities without writing either row and accepts one explicit selection', async () => {
  const { table, file } = await fixture();
  const input = [row('repeat', 1), row('repeat', 2)];
  const pending = await writeIngestRows(table, file.id, 'repeat', input, services);
  expect(pending.disagreements).toMatchObject([{ kind: 'repeated-file-identity', rows: [0, 1] }]);
  expect(await records(table)).toHaveLength(0);
  const kept = await writeIngestRows(table, file.id, 'repeat', input, services, {
    [pending.disagreements[0]!.identity]: { choice: 'keepTable' },
  });
  expect(kept.busCalls).toBe(0);
  const taken = await writeIngestRows(table, file.id, 'repeat', input, services, {
    [pending.disagreements[0]!.identity]: { choice: 'takeFile', row: 1 },
  });
  expect(taken.counts.added).toBe(1);
  expect((await records(table))[0]!.values.amount).toBe(2);
});

it('adds all rows without an identity and leaves duplicate-file checks to its caller', async () => {
  const { table, file } = await fixture({ identity: null });
  const input = [row('repeat'), row('repeat')];
  expect((await writeIngestRows(table, file.id, 'one', input, services)).counts.added).toBe(2);
  expect((await writeIngestRows(table, file.id, 'two', input, services)).counts.added).toBe(2);
  expect(await records(table)).toHaveLength(4);
});

it('preserves hand edits and a cleared review mark, joins reasons, and only raises review again for a new reason', async () => {
  const { table, file, context, fieldIds } = await fixture();
  const input = [{ ...row('hand', 1, [question()]), aiFields: ['amount'] }];
  await writeIngestRows(table, file.id, 'one', input, services);
  const existing = (await records(table))[0]!;
  await edit(table, existing.id, fieldIds, { amount: 9, needsReview: false });
  const pending = await writeIngestRows(table, file.id, 'reread', input, services);
  expect(pending.cellsLeftAlone.map((cell) => cell.fieldKey).sort()).toEqual(['amount', 'needsReview']);
  const chosen = await writeIngestRows(table, file.id, 'reread', input, services, {
    [pending.disagreements[0]!.identity]: { choice: 'takeFile' },
  });
  expect(chosen.cellsLeftAlone.map((cell) => cell.fieldKey).sort()).toEqual(['amount', 'needsReview']);
  expect((await records(table))[0]!.values).toMatchObject({ amount: 9, needsReview: false, readByAi: true });
  const state = (await store.readRowState(context, existing.id))!;
  expect(state.hashes.amount).toBe(storage.hashValue(null));
  const newer = [{ ...input[0]!, aiFields: [], reasons: [question(), question('question-2', 'memo')] }];
  const next = await writeIngestRows(table, file.id, 'new-reason', newer, services, {
    [pending.disagreements[0]!.identity]: { choice: 'takeFile' },
  });
  expect(next.counts.updated).toBe(1);
  const final = (await records(table))[0]!.values;
  expect(final).toMatchObject({ amount: 9, needsReview: true, readByAi: true });
  expect(String(final.reviewNote).split('\n')).toHaveLength(2);
});

it('resumes after the second of five committed batches without writing or counting anything twice', async () => {
  const { table, file, context } = await fixture({ identity: null });
  const input = Array.from({ length: 5_000 }, (_, position) => row(String(position)));
  const original = bus.runCommands;
  let calls = 0;
  const spy = vi.spyOn(bus, 'runCommands').mockImplementation(async (...args) => {
    calls += 1;
    if (calls === 3) throw new Error('test.interrupted');
    return original(...args);
  });
  try {
    await expect(writeIngestRows(table, file.id, 'interrupted', input, services)).rejects.toThrow(
      'test.interrupted',
    );
  } finally {
    spy.mockRestore();
  }
  expect(await records(table)).toHaveLength(2_000);
  expect((await store.readFile(context, file.id))?.counts.added).toBe(2_000);
  const resumed = await writeIngestRows(table, file.id, 'interrupted', input, services);
  expect(resumed.counts.added).toBe(5_000);
  expect(resumed.busCalls).toBe(3);
  expect(await records(table)).toHaveLength(5_000);
  const changes = await server.pool.query(
    `SELECT count(*)::int AS total, count(DISTINCT group_id)::int AS groups FROM ${server.schemas.app}.changes WHERE origin->>'fileId' = $1`,
    [file.id],
  );
  expect(changes.rows).toEqual([{ total: 5, groups: 1 }]);
  expect((await writeIngestRows(table, file.id, 'interrupted', input, services)).busCalls).toBe(0);
});

it('rolls back values, command receipts, and hashes together if a checkpoint cannot be saved', async () => {
  const { table, file } = await fixture({ identity: null });
  const spy = vi.spyOn(storage, 'saveCheckpoint').mockImplementationOnce(async () => {
    throw new Error('test.storageFailed');
  });
  try {
    await expect(writeIngestRows(table, file.id, 'atomic', [row('one')], services)).rejects.toThrow(
      'test.storageFailed',
    );
  } finally {
    spy.mockRestore();
  }
  expect(await records(table)).toHaveLength(0);
  expect((await writeIngestRows(table, file.id, 'atomic', [row('one')], services)).counts.added).toBe(1);
});

it('lands 2,499 rows around a bus validation refusal in three successful batches, all undone together', async () => {
  const { table, file } = await fixture({
    columns: [
      { key: 'code', type: 'text' },
      { key: 'amount', type: 'number', options: { validation: { min: { value: 0 } } } },
    ],
  });
  const input = Array.from({ length: 2_500 }, (_, position) =>
    row(String(position), position === 1_400 ? -1 : position),
  );
  const result = await writeIngestRows(table, file.id, 'validation', input, services);
  expect(result.counts).toEqual({ added: 2_499, updated: 0, identical: 0, flagged: 0, refused: 1 });
  expect(result.refused).toMatchObject([
    {
      row: 1_400,
      reason: { messageKey: 'data.validation.failed', issues: [{ messageKey: 'data.validation.min' }] },
    },
  ]);
  expect(await records(table)).toHaveLength(2_499);
  const changes = await server.pool.query(
    `SELECT count(*)::int AS total, count(DISTINCT group_id)::int AS groups FROM ${server.schemas.app}.changes WHERE origin->>'fileId' = $1`,
    [file.id],
  );
  expect(changes.rows).toEqual([{ total: 3, groups: 1 }]);
  await undo(table, result.undoGroupId);
  expect(await records(table)).toHaveLength(0);
});

it('reports unique-rule refusals while keeping the other rows', async () => {
  const { table, file } = await fixture({
    identity: null,
    columns: [{ key: 'code', type: 'text', options: { unique: true } }],
  });
  const result = await writeIngestRows(
    table,
    file.id,
    'unique',
    [row('same'), row('same'), row('other')],
    services,
  );
  expect(result.counts.added).toBe(2);
  expect(result.refused).toMatchObject([{ row: 1, reason: { messageKey: 'data.validation.unique' } }]);
  expect(await records(table)).toHaveLength(2);
});

it('fills an answer into 40 rows, removes only its reasons, and leaves one hand-edited value alone', async () => {
  const { table, file, fieldIds, context } = await fixture();
  const input = Array.from({ length: 40 }, (_, position) => row(String(position), 1, [question()]));
  await writeIngestRows(table, file.id, 'questions', input, services);
  const before = await records(table);
  await edit(table, before[0]!.id, fieldIds, { amount: 99 });
  const answered = await answerIngestRows(table, 'question-1', '12', 'answer', services);
  expect(answered.counts.updated).toBe(40);
  expect(answered.cellsLeftAlone).toEqual([
    { recordId: before[0]!.id, fieldKey: 'amount', messageId: 'ingest.write.handEdit' },
  ]);
  expect((await records(table)).map((record) => record.values.amount)).toEqual([99, ...Array(39).fill(12)]);
  for (const record of await records(table))
    expect(record.values).toMatchObject({ needsReview: false, reviewNote: null });
  expect((await store.listRowState(context)).every((state) => state.reasons.length === 0)).toBe(true);
  expect((await answerIngestRows(table, 'question-1', '12', 'answer', services)).busCalls).toBe(0);
});

it('trashes created records through one group, marks the file removed, and restores records from trash', async () => {
  const { table, file, context } = await fixture();
  await writeIngestRows(table, file.id, 'write', [row('a'), row('b')], services);
  const before = await records(table);
  const removed = await removeIngestFileRows(table, file.id, 'remove', services);
  expect(removed.refused).toHaveLength(0);
  expect(await records(table)).toHaveLength(0);
  expect((await store.readFile(context, file.id))?.state).toBe('removed');
  expect((await removeIngestFileRows(table, file.id, 'remove', services)).busCalls).toBe(0);
  await undo(table, removed.undoGroupId);
  expect(await records(table)).toEqual(before);
});

it('forgets what it remembered about a record once the record is deleted for good', async () => {
  const { table, file, context } = await fixture();
  await writeIngestRows(table, file.id, 'write', [row('a'), row('b')], services);
  const written = await records(table);
  expect(await store.listRowState(context)).toHaveLength(2);
  await removeIngestFileRows(table, file.id, 'remove', services);
  // A trashed record can still be restored, so its remembered values stay with it.
  await purgeTrash(server.ctx);
  expect(await store.listRowState(context)).toHaveLength(2);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.data, table.id)}
    SET __deleted_at = now() - interval '400 days' WHERE __id = ${written[0]!.id}`,
  );
  await purgeTrash(server.ctx);
  expect((await store.listRowState(context)).map((state) => state.recordId)).toEqual([written[1]!.id]);
});

it('restores earlier file cells on removal, respects hand edits, and keeps the model provenance mark', async () => {
  const { table, file, fieldIds, anotherFile, context } = await fixture();
  await writeIngestRows(table, file.id, 'first', [row('a'), row('b')], services);
  const nextFile = await anotherFile();
  const input = [{ ...row('a', 2), aiFields: ['amount'] }, row('b', 2)];
  const pending = await writeIngestRows(table, nextFile.id, 'next', input, services);
  await writeIngestRows(
    table,
    nextFile.id,
    'next',
    input,
    services,
    Object.fromEntries(
      pending.disagreements.map((difference) => [difference.identity, { choice: 'takeFile' }]),
    ),
  );
  const before = await records(table);
  await edit(table, before[1]!.id, fieldIds, { amount: 7 });
  const removed = await removeIngestFileRows(table, nextFile.id, 'remove', services);
  expect(removed.cellsLeftAlone).toMatchObject([{ recordId: before[1]!.id, fieldKey: 'amount' }]);
  expect((await records(table)).map((record) => record.values.amount)).toEqual([1, 7]);
  expect((await records(table))[0]!.values.readByAi).toBe(true);
  expect(
    (await store.listRowState(context)).every(
      (state) => state.fileId === file.id && state.createdByFileId === file.id,
    ),
  ).toBe(true);
});

it('flags every output check failure, keeps invalid text, adds no choices, and holds undecided rows', async () => {
  const target = await fixture();
  await writeIngestRows(target.table, target.file.id, 'target', [row('target')], services);
  const linked = (await records(target.table))[0]!.id;
  const choiceId = newId('choice');
  const { table, file, context, fieldIds } = await fixture({
    columns: [
      { key: 'code', type: 'text', required: true },
      { key: 'amount', type: 'number' },
      { key: 'day', type: 'date' },
      { key: 'flag', type: 'checkbox' },
      { key: 'email', type: 'email' },
      {
        key: 'choice',
        type: 'singleSelect',
        options: { choices: [{ id: choiceId, name: 'Ready', color: 'blue' }] },
      },
      { key: 'links', type: 'link', options: { linkedTableId: target.table.id } },
    ],
  });
  const input: WriteRow[] = [
    {
      ...row('', 'not a number'),
      values: {
        code: '',
        amount: 'not a number',
        day: '2026-02-30',
        flag: 'maybe',
        email: 'bad address',
        choice: 'New choice',
        links: [newId('record')],
      },
    },
    {
      ...row('valid', 0),
      values: {
        code: 'valid',
        amount: 0,
        day: '2026-10-12',
        flag: false,
        email: 'person@example.test',
        choice: 'Ready',
        links: [linked],
      },
    },
    { ...row('held'), held: { questionId: 'hold-question' } },
  ];
  const result = await writeIngestRows(table, file.id, 'checks', input, services);
  expect(result.counts).toMatchObject({ added: 2, flagged: 1, refused: 0 });
  expect(result.held).toEqual([{ row: 2, questionId: 'hold-question' }]);
  const written = await records(table);
  expect(written[0]!.values).toMatchObject({
    code: null,
    amount: null,
    day: null,
    flag: false,
    email: 'bad address',
    choice: null,
    links: [],
    needsReview: true,
  });
  expect(written[1]!.values).toMatchObject({
    amount: 0,
    flag: false,
    choice: choiceId,
    links: [linked],
    needsReview: false,
  });
  const state = (await store.readRowState(context, written[0]!.id))!;
  expect(state.reasons.map((reason) => reason.source.kind === 'check' && reason.source.name)).toEqual([
    'required',
    'type',
    'type',
    'type',
    'type',
    'choice',
    'link',
  ]);
  expect(state.at).toEqual(input[0]!.at);
  expect(String(written[0]!.values.reviewNote).split('\n')).toHaveLength(7);
  const repeated = await writeIngestRows(table, file.id, 'checks-again', input, services);
  expect(repeated.counts).toMatchObject({ added: 0, updated: 0, identical: 2, flagged: 1 });
  expect(repeated.busCalls).toBe(0);
  const fields = await loadFields(server.pool, server.schemas, [table.id]);
  expect(fields.find((field) => field.id === fieldIds.choice)?.options).toMatchObject({
    choices: [{ id: choiceId }],
  });
  // The ordinary bus still refuses invalid typed text without the internal ingest capability.
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, context.orgId))!;
  const ordinary = await bus.runCommands(server.app, actor, table.databaseId, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: written[1]!.id, values: { [fieldIds.email!]: 'bad address' } }],
      },
    ],
  });
  expect(ordinary.results[0]).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'data.value.notEmail' },
  });
});

it('stops without any writes for a paused table, a missing owner, or revoked owner access', async () => {
  const { table, file, context } = await fixture();
  const settings = (await store.readSettings(context))!;
  await store.changeSettings(context, settings.revision, { ...settings, state: 'paused' });
  expect(await writeIngestRows(table, file.id, 'paused', [row('a')], services)).toMatchObject({
    status: 'stopped',
    messageId: 'ingest.write.inactive',
    busCalls: 0,
  });
  const paused = (await store.readSettings(context))!;
  await store.changeSettings(context, paused.revision, { ...paused, state: 'setup', ownerId: null });
  expect(await writeIngestRows(table, file.id, 'missing-owner', [row('a')], services)).toMatchObject({
    status: 'stopped',
    messageId: 'ingest.write.ownerCannotWrite',
    busCalls: 0,
  });
  const member = await server.addMember();
  const setup = (await store.readSettings(context))!;
  await store.changeSettings(context, setup.revision, { ...setup, state: 'live', ownerId: member.userId });
  expect(await writeIngestRows(table, file.id, 'revoked', [row('a')], services)).toMatchObject({
    status: 'stopped',
    messageId: 'ingest.write.ownerCannotWrite',
    busCalls: 0,
  });
  expect(await records(table)).toHaveLength(0);
});

it('does not let trashed rows reserve an identity and keeps their provenance available on restore', async () => {
  const { table, file, anotherFile, context } = await fixture();
  await writeIngestRows(table, file.id, 'first', [row('same')], services);
  const original = (await records(table))[0]!;
  const removed = await removeIngestFileRows(table, file.id, 'remove', services);
  const nextFile = await anotherFile();
  expect((await writeIngestRows(table, nextFile.id, 'next', [row('same')], services)).counts.added).toBe(1);
  const remembered = (await store.readRowState(context, original.id))!;
  expect(remembered.history.at(-1)?.identity).toMatch(/^[a-f0-9]{64}$/);
  expect(remembered.createdByFileId).toBe(file.id);
  await undo(table, removed.undoGroupId);
  expect(await records(table)).toHaveLength(2);
  const thirdFile = await anotherFile();
  const disagreement = await writeIngestRows(table, thirdFile.id, 'third', [row('same', 3)], services);
  expect(disagreement.disagreements).toMatchObject([{ kind: 'repeated-table-identity' }]);
  expect(disagreement.busCalls).toBe(0);
  const chosen = await writeIngestRows(table, thirdFile.id, 'third', [row('same', 3)], services, {
    [disagreement.disagreements[0]!.identity]: { choice: 'takeFile', recordId: original.id },
  });
  expect(chosen.counts.updated).toBe(1);
  expect((await records(table)).map((record) => record.values.amount)).toEqual([3, 1]);
});

it('rejects changed input under the same run and allows keeping the table on a disagreement', async () => {
  const { table, file, anotherFile } = await fixture();
  await writeIngestRows(table, file.id, 'same-run', [row('a')], services);
  const changedRun = await writeIngestRows(table, file.id, 'same-run', [row('b')], services, {
    unused: { choice: 'takeFile' },
  });
  expect(changedRun).toMatchObject({ status: 'stopped', messageId: 'ingest.write.changedRun', busCalls: 0 });
  const secondFile = await anotherFile();
  const pending = await writeIngestRows(table, secondFile.id, 'second', [row('a', 2)], services);
  const kept = await writeIngestRows(table, secondFile.id, 'second', [row('a', 2)], services, {
    [pending.disagreements[0]!.identity]: { choice: 'keepTable' },
  });
  expect(kept).toMatchObject({ status: 'written', busCalls: 0, counts: { added: 0, updated: 0 } });
  expect((await records(table))[0]!.values.amount).toBe(1);
});

it('never adopts existing human data as a remembered process write, even after takeFile', async () => {
  const { table, file, fieldIds, context } = await fixture();
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, context.orgId))!;
  const recordId = newId('record');
  const created = await bus.runCommands(server.app, actor, table.databaseId, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        kind: 'record.create',
        tableId: table.id,
        records: [{ id: recordId, values: { [fieldIds.code!]: 'human', [fieldIds.amount!]: 1 } }],
      },
    ],
  });
  expect(created.results[0]).toMatchObject({ status: 'applied' });
  const pending = await writeIngestRows(table, file.id, 'manual', [row('human', 2)], services);
  await edit(table, recordId, fieldIds, { amount: 9 });
  const accepted = await writeIngestRows(table, file.id, 'manual', [row('human', 2)], services, {
    [pending.disagreements[0]!.identity]: { choice: 'takeFile' },
  });
  expect(accepted.cellsLeftAlone).toMatchObject([{ recordId, fieldKey: 'amount' }]);
  expect((await records(table))[0]!.values.amount).toBe(9);
  expect((await store.readRowState(context, recordId))?.hashes.amount).toBeUndefined();
  await removeIngestFileRows(table, file.id, 'remove', services);
  expect((await records(table))[0]!.values.amount).toBe(9);
  expect(await store.readRowState(context, recordId)).toBeNull();
});

it('writes 20,000 rows in 20 bus calls and records the elapsed time', async () => {
  const { table, file } = await fixture();
  const input = Array.from({ length: 20_000 }, (_, position) => row(String(position), position));
  const started = performance.now();
  const result = await writeIngestRows(table, file.id, 'large', input, services);
  const elapsed = performance.now() - started;
  expect(result.counts.added).toBe(20_000);
  expect(result.busCalls).toBe(20);
  expect(await records(table)).toHaveLength(20_000);
  process.stdout.write(
    `Row writer benchmark: 20,000 rows, ${elapsed.toFixed(1)} ms, ${result.busCalls} bus calls\n`,
  );
}, 120_000);

it('retains each row outcome across separate disagreement choices and checkpoint replays', async () => {
  const { table, file, anotherFile, context } = await fixture();
  await writeIngestRows(table, file.id, 'baseline', [row('a'), row('b')], services);
  const next = await anotherFile();
  const input = [row('new'), row('a', 2), row('b', 3)];
  const pending = await writeIngestRows(table, next.id, 'choices', input, services);
  expect(pending.counts.added).toBe(1);
  const choices = { [pending.disagreements[0]!.identity]: { choice: 'takeFile' as const } };
  const partial = await writeIngestRows(table, next.id, 'choices', input, services, choices);
  expect(partial.counts).toEqual({ added: 1, updated: 1, identical: 0, flagged: 0, refused: 0 });
  expect(partial.disagreements).toHaveLength(1);
  const complete = await writeIngestRows(table, next.id, 'choices', input, services, {
    ...choices,
    [partial.disagreements[0]!.identity]: { choice: 'takeFile' },
  });
  expect(complete.counts).toEqual({ added: 1, updated: 2, identical: 0, flagged: 0, refused: 0 });
  expect(complete.busCalls).toBe(1);
  const replay = await writeIngestRows(table, next.id, 'choices', input, services, choices);
  expect(replay.counts).toEqual(complete.counts);
  expect(replay.busCalls).toBe(0);
  expect((await store.readFile(context, next.id))?.counts).toEqual(complete.counts);
  expect((await records(table)).map((record) => record.values.amount)).toEqual([2, 3, 1]);
});

it('restores a removed file cell independently of later file cells and rebases their removal history', async () => {
  const { table, file, anotherFile, context } = await fixture();
  await writeIngestRows(table, file.id, 'baseline', [row('a')], services);
  const middle = await anotherFile();
  const middleInput = [row('a', 2)];
  const pending = await writeIngestRows(table, middle.id, 'middle', middleInput, services);
  await writeIngestRows(table, middle.id, 'middle', middleInput, services, {
    [pending.disagreements[0]!.identity]: { choice: 'takeFile' },
  });
  const last = await anotherFile();
  const lastInput = [{ ...row('a', 2), values: { code: 'a', amount: 2, memo: 'later memo' } }];
  const later = await writeIngestRows(table, last.id, 'last', lastInput, services);
  await writeIngestRows(table, last.id, 'last', lastInput, services, {
    [later.disagreements[0]!.identity]: { choice: 'takeFile' },
  });
  await removeIngestFileRows(table, middle.id, 'remove-middle', services);
  expect((await records(table))[0]!.values).toMatchObject({ amount: 1, memo: 'later memo' });
  expect((await store.readFile(context, middle.id))?.state).toBe('removed');
  await removeIngestFileRows(table, last.id, 'remove-last', services);
  expect((await records(table))[0]!.values).toMatchObject({ amount: 1, memo: null });
});

it('preserves later writes and hand edits when removing an intermediate file contribution', async () => {
  const { table, file, anotherFile, fieldIds } = await fixture();
  await writeIngestRows(table, file.id, 'baseline', [row('later'), row('hand')], services);
  const middle = await anotherFile();
  const input = [row('later', 2), row('hand', 2)];
  const pending = await writeIngestRows(table, middle.id, 'middle', input, services);
  await writeIngestRows(
    table,
    middle.id,
    'middle',
    input,
    services,
    Object.fromEntries(
      pending.disagreements.map((difference) => [difference.identity, { choice: 'takeFile' }]),
    ),
  );
  const last = await anotherFile();
  const nextInput = [
    row('later', 3),
    { ...row('hand', 2), values: { code: 'hand', amount: 2, memo: 'later' } },
  ];
  const later = await writeIngestRows(table, last.id, 'last', nextInput, services);
  await writeIngestRows(
    table,
    last.id,
    'last',
    nextInput,
    services,
    Object.fromEntries(
      later.disagreements.map((difference) => [difference.identity, { choice: 'takeFile' }]),
    ),
  );
  const before = await records(table);
  await edit(table, before[1]!.id, fieldIds, { amount: 9 });
  const removed = await removeIngestFileRows(table, middle.id, 'remove', services);
  expect((await records(table)).map((record) => record.values.amount)).toEqual([3, 9]);
  expect(removed.cellsLeftAlone).toContainEqual({
    recordId: before[1]!.id,
    fieldKey: 'amount',
    messageId: 'ingest.write.handEdit',
  });
});

it('moves an answered identity reservation and allows a new empty identity row', async () => {
  const { table, file, anotherFile, context } = await fixture();
  await writeIngestRows(
    table,
    file.id,
    'question',
    [row('suppressed', 1, [question('identity-question', 'code')])],
    services,
  );
  await answerIngestRows(table, 'identity-question', 'answered', 'answer', services);
  const existing = (await records(table))[0]!;
  const next = await anotherFile();
  const written = await writeIngestRows(table, next.id, 'empty', [row('')], services);
  expect(written.status).toBe('written');
  expect(written.counts.added).toBe(1);
  expect(written.disagreements).toHaveLength(0);
  expect((await store.readRowState(context, existing.id))?.identity).toBe(
    storage.hashValue([{ kind: 'text', value: 'answered' }]),
  );
});

it('returns an identity disagreement before an answer can collide with another record', async () => {
  const { table, file, context } = await fixture({ identity: ['code', 'amount'] });
  await writeIngestRows(
    table,
    file.id,
    'question',
    [
      row('suppressed', 1, [question('identity-question', 'code')]),
      row('suppressed', 2, [question('identity-question', 'code')]),
      row('answered'),
    ],
    services,
  );
  const before = await records(table);
  const state = await store.readRowState(context, before[0]!.id);
  const answered = await answerIngestRows(table, 'identity-question', 'answered', 'answer', services);
  expect(answered.status).toBe('disagreement');
  expect(answered.disagreements).toMatchObject([{ kind: 'repeated-table-identity' }]);
  expect(answered.busCalls).toBe(0);
  expect(await records(table)).toEqual(before);
  expect(await store.readRowState(context, before[0]!.id)).toEqual(state);
  const retried = await answerIngestRows(table, 'identity-question', 'safe', 'retry', services);
  expect(retried.counts.updated).toBe(2);
  expect((await records(table)).map((record) => record.values.code)).toEqual(['safe', 'safe', 'answered']);
});

it('restores blank process fields on a human-created record after removing its accepted file', async () => {
  const { table, file, fieldIds, context } = await fixture();
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, context.orgId))!;
  const recordId = newId('record');
  const created = await bus.runCommands(server.app, actor, table.databaseId, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId: newId('action'),
        kind: 'record.create',
        tableId: table.id,
        records: [{ id: recordId, values: { [fieldIds.code!]: 'human', [fieldIds.amount!]: 1 } }],
      },
    ],
  });
  expect(created.results[0]).toMatchObject({ status: 'applied' });
  const before = await records(table);
  const input = [row('human', 2)];
  const pending = await writeIngestRows(table, file.id, 'manual', input, services);
  await writeIngestRows(table, file.id, 'manual', input, services, {
    [pending.disagreements[0]!.identity]: { choice: 'takeFile' },
  });
  expect((await records(table))[0]!.values.source).toBeTruthy();
  await removeIngestFileRows(table, file.id, 'remove', services);
  expect(await records(table)).toEqual(before);
});

it('retains invalid multiline JSON exactly as written through the command bus', async () => {
  const { table, file } = await fixture({
    columns: [
      { key: 'code', type: 'text' },
      { key: 'payload', type: 'json' },
    ],
  });
  const payload = '{\n  "missing": value\n}';
  const written = await writeIngestRows(
    table,
    file.id,
    'json',
    [
      {
        ...row('invalid'),
        values: { code: 'invalid', payload },
      },
      { ...row('too-long'), values: { code: 'too-long', payload: 'x'.repeat(LIMITS.jsonLength + 1) } },
    ],
    services,
  );
  expect(written.counts).toMatchObject({ added: 2, flagged: 2, refused: 0 });
  expect((await records(table))[0]!.values.payload).toBe(payload);
  expect((await records(table))[1]!.values.payload).toBeNull();
});

it('preserves added, identical, flagged, and refused row outcomes when a differing row is accepted', async () => {
  const { table, file, anotherFile, context } = await fixture({
    columns: [
      { key: 'code', type: 'text' },
      { key: 'amount', type: 'number', options: { validation: { min: { value: 0 } } } },
      { key: 'memo', type: 'longText' },
    ],
  });
  await writeIngestRows(table, file.id, 'baseline', [row('same'), row('different')], services);
  const next = await anotherFile();
  const input = [
    row('new', 1, [question('flag', 'memo')]),
    row('refused', -1),
    row('same'),
    row('different', 2),
  ];
  const pending = await writeIngestRows(table, next.id, 'choices', input, services);
  const accepted = await writeIngestRows(table, next.id, 'choices', input, services, {
    [pending.disagreements[0]!.identity]: { choice: 'takeFile' },
  });
  expect(accepted.counts).toEqual({ added: 1, updated: 1, identical: 1, flagged: 1, refused: 1 });
  expect(accepted.refused).toEqual(pending.refused);
  expect((await store.readFile(context, next.id))?.counts).toEqual(accepted.counts);
  expect(await records(table)).toHaveLength(3);
});

it.each([false, true])(
  'reserves the hand-edited identity when review fields were cleared: %s',
  async (cleared) => {
    const { table, file, fieldIds, anotherFile, context } = await fixture();
    await writeIngestRows(
      table,
      file.id,
      'question',
      [row('suppressed', 1, [question('identity-question', 'code')])],
      services,
    );
    const existing = (await records(table))[0]!;
    await edit(table, existing.id, fieldIds, {
      code: 'human',
      ...(cleared ? { needsReview: false, reviewNote: null } : {}),
    });
    const answered = await answerIngestRows(table, 'identity-question', 'answered', 'answer', services);
    expect(answered.busCalls).toBe(cleared ? 0 : 1);
    expect(answered.cellsLeftAlone).toContainEqual({
      recordId: existing.id,
      fieldKey: 'code',
      messageId: 'ingest.write.handEdit',
    });
    expect((await records(table))[0]!.values.code).toBe('human');
    expect((await store.readRowState(context, existing.id))?.identity).toBe(
      storage.hashValue([{ kind: 'text', value: 'human' }]),
    );
    const next = await anotherFile();
    expect((await writeIngestRows(table, next.id, 'empty', [row('')], services)).counts.added).toBe(1);
  },
);

it('isolates snapshot values, hashes, locations, and nested reasons from later mutations', async () => {
  const { table, file, context } = await fixture();
  await writeIngestRows(table, file.id, 'snapshot', [row('one', 1, [question()])], services);
  const existing = (await records(table))[0]!;
  const state = (await store.readRowState(context, existing.id))!;
  const before = structuredClone(state);
  const remembered = snapshot(state);
  state.values.amount = 9;
  state.hashes.amount = storage.hashValue(9);
  state.at.row = 99;
  state.reasons[0]!.params!.field = 'memo';
  state.reasons[0]!.source = { kind: 'check', name: 'type' };
  expect(remembered).toMatchObject({
    values: before.values,
    hashes: before.hashes,
    at: before.at,
    reasons: before.reasons,
  });
});

it('preserves a hand-edited identity across repeated file updates and re-reads', async () => {
  const { table, file, fieldIds } = await fixture();
  const input = [row('original', 1, [question('memo-question', 'memo')])];
  await writeIngestRows(table, file.id, 'first', input, services);
  const existing = (await records(table))[0]!;
  await edit(table, existing.id, fieldIds, { code: 'human', needsReview: false });
  const changed = [row('original', 2, [question('memo-question', 'memo')])];
  const pending = await writeIngestRows(table, file.id, 'update', changed, services);
  const taken = await writeIngestRows(table, file.id, 'update', changed, services, {
    [pending.disagreements[0]!.identity]: { choice: 'takeFile' },
  });
  expect(taken.counts.updated).toBe(1);
  const again = await writeIngestRows(table, file.id, 'reread', changed, services);
  expect(again.counts.added).toBe(0);
  expect(again.cellsLeftAlone.map((cell) => cell.fieldKey).sort()).toEqual(['code', 'needsReview']);
  expect(await records(table)).toHaveLength(1);
  expect((await records(table))[0]!.values).toMatchObject({ code: 'human', amount: 2, needsReview: false });
});

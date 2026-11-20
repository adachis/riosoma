import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  AiSettings,
  DatabaseCreate,
  IngestDraft,
  newId,
  type IngestDraft as Draft,
  type IngestSpotCheck,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { saveRecordRules } from '../../data/permissions/store.js';
import { actorFor } from '../../automations/run.js';
import { runIngestSetupCommand } from '../../data/commands/ingest-setup.js';
import { TryLaterError } from '../pipeline/types.js';
import { notRead } from '../ai-reader/reader.js';
import { startDraftWork, waitForDraftWork } from './worker.js';
import * as metadata from '../../data/metadata.js';
import { applyPeriods, sweepOriginals } from '../originals/retention.js';
import { createScriptedDraftRead, draftRequests, scriptedDraftRead } from './test-helpers.js';

const script = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../ai-reader/index.js', () => ({ createAiReader: () => script.read }));
let kit: TestPostgres;
let server: ServerFixture;
let editor: SignedIn;
const file = (text: string) => ({ name: 'input.csv', base64: Buffer.from(text).toString('base64') });
const csv = (count = 12, prefix = 'Input') =>
  `name,amount,day,notes\n${Array.from({ length: count }, (_, index) => `${prefix}-${index},1200.5,2026-03-01,source-${index}`).join('\n')}\n`;
const expected = (count: number, prefix: string) =>
  `name\tamount\tday\n${Array.from({ length: count }, (_, index) => `${prefix}-${index}\t1200.5\t2026-03-01`).join('\n')}\n`;
const call = (tableId: string, kind: string, input: object = {}, who = server.owner) =>
  server.app.inject({
    method: 'POST',
    url: `/api/tables/${tableId}/ingest/commands`,
    headers: who.headers,
    payload: { id: newId('command'), kind, ...input },
  });
async function applied(tableId: string, kind: string, input: object = {}) {
  const response = await call(tableId, kind, input);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().status).toBe('applied');
  return response.json().output;
}
async function fixture(own = true) {
  const database = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Draft inputs',
    table: {
      id: newId('table'),
      name: 'Draft rows',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: database,
  });
  expect(created.statusCode, created.body).toBe(200);
  const tableId = database.table.id;
  const { settings } = await applied(tableId, 'ingest.begin');
  await applied(tableId, 'ingest.output', {
    output: {
      revision: settings.revision,
      rowMeaning: 'Each row is an invoice.',
      identity: null,
      fields: [
        {
          key: 'name',
          field: { id: database.table.fields[0]!.id },
          meaning: 'The invoice name.',
          required: true,
        },
        {
          key: 'amount',
          field: { name: 'Amount', type: 'number' },
          meaning: 'The invoice total.',
          required: true,
        },
        { key: 'day', field: { name: 'Day', type: 'date' }, meaning: 'The invoice date.', required: true },
      ],
    },
  });
  const { format } = await applied(tableId, 'ingest.format.add', { name: 'Invoices' });
  if (own)
    await applied(tableId, 'ingest.example.add', {
      formatId: format.id,
      file: file(csv(1, 'Own')),
      expected: { kind: 'paste', text: expected(1, 'Own') },
    });
  return { tableId, formatId: format.id, databaseId: database.id, fieldId: database.table.fields[0]!.id };
}
async function start(target: Awaited<ReturnType<typeof fixture>>, text = csv()) {
  const { draft } = await applied(target.tableId, 'ingest.draft.start', {
    formatId: target.formatId,
    file: file(text),
  });
  expect(draft.state).toBe('drafting');
  await waitForDraftWork(server.app);
  return read(target.tableId, draft.id);
}
async function read(tableId: string, draftId: string, who = server.owner): Promise<Draft> {
  const response = await server.app.inject({
    url: `/api/tables/${tableId}/ingest/drafts/${draftId}`,
    headers: who.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return IngestDraft.parse(response.json());
}
const target = (draft: Draft) => ({ draftId: draft.id, revision: draft.revision });
async function checks(draft: Draft): Promise<{ revision: number; checks: IngestSpotCheck[] }> {
  return applied(draft.tableId, 'ingest.draft.checks', target(draft));
}
async function answer(draft: Draft, check: IngestSpotCheck, value: unknown) {
  const current = await read(draft.tableId, draft.id);
  return applied(draft.tableId, 'ingest.draft.answer', {
    ...target(current),
    checkId: check.id,
    answer: { kind: 'typed', value },
  });
}
async function pass(draft: Draft) {
  const selected = await checks(draft);
  for (const check of selected.checks)
    await answer(draft, check, draft.rows!.find((row) => row.id === check.rowId)!.values[check.field]);
  return read(draft.tableId, draft.id);
}
async function confirm(draft: Draft) {
  const first = await call(draft.tableId, 'ingest.draft.confirm', target(draft));
  if (first.json().error?.messageKey === 'ingest.setup.confirmPair')
    return call(draft.tableId, 'ingest.draft.confirm', {
      ...target(draft),
      confirm: true,
      confirmationId: first.json().details.confirmationId,
    });
  return first;
}
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'draftchecks');
  editor = await server.addMember();
  server.ctx.ingest!.pause();
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.ai_settings (org_id, settings) VALUES ($1, $2) ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings`,
    [
      server.owner.info.org.id,
      AiSettings.parse({ enabled: true, ingest: true, models: { everyday: null, power: null } }),
    ],
  );
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
beforeEach(() => {
  draftRequests.length = 0;
  script.read.mockReset().mockImplementation(scriptedDraftRead);
});

it('requires a confirmed own pair, refuses an example file, and accepts a new file', async () => {
  const empty = await fixture(false);
  const refused = await call(empty.tableId, 'ingest.draft.start', {
    formatId: empty.formatId,
    file: file(csv()),
  });
  expect(refused.statusCode).toBe(422);
  expect(refused.json().error.messageKey).toBe('ingest.drafts.needsOwn');
  expect(script.read).not.toHaveBeenCalled();
  const seeded = await fixture();
  const duplicate = await call(seeded.tableId, 'ingest.draft.start', {
    formatId: seeded.formatId,
    file: file(csv(1, 'Own')),
  });
  expect(duplicate.statusCode).toBe(422);
  expect(duplicate.json().error.messageKey).toBe('ingest.drafts.sameFile');
  const draft = await start(seeded);
  expect(draft.state).toBe('ready');
  expect(draft.rowCount).toBe(12);
  expect(draftRequests).toHaveLength(1);
  expect(draftRequests[0]!.messages.map((message) => message.role)).toEqual(['system', 'user']);
});
it.each([true, false])('prepares a draft with strict history and forced tool choice %s', async (forced) => {
  script.read.mockImplementation(createScriptedDraftRead(forced));
  const draft = await start(await fixture());
  expect(draft.state).toBe('ready');
  expect(draft.rowCount).toBe(12);
  expect(draft.rows![0]!.values).toEqual({ name: 'Input-0', amount: 1200.5, day: '2026-03-01' });
  expect(draftRequests).toHaveLength(1);
  const request = draftRequests[0]!;
  expect(request.messages.map((message) => message.role)).toEqual(['system', 'user']);
  if (forced) {
    expect(request.toolChoice).toEqual({ name: 'submit_output' });
    expect(request.tools).toHaveLength(1);
  } else {
    expect(request.toolChoice).toBeUndefined();
    expect(request.tools).toBeUndefined();
    expect(request.messages[0]!.content).toContain('Return only JSON matching this schema:');
  }
});

it('fixes five server checks, starts with doubts, and checks every cell of a three-cell draft', async () => {
  const seeded = await fixture();
  const draft = await start(seeded);
  const first = await checks(draft);
  expect(first.checks).toHaveLength(5);
  expect(first.checks[0]).toMatchObject({ field: 'day', at: { row: 11 } });
  const second = await checks(await read(draft.tableId, draft.id));
  expect(second.checks).toEqual(first.checks);
  expect(second.revision).toBe(first.revision);
  expect((await checks(await start(seeded, csv(1, 'Small')))).checks).toHaveLength(3);
});
it('never returns a planted model value outside check choices or identifies its choice', async () => {
  const marker = 'PLANTED-MODEL-CELL';
  script.read.mockResolvedValue({
    status: 'read',
    rows: [
      {
        values: { name: marker, amount: marker, day: marker },
        at: { sheet: 'input.csv', row: 2 },
        raw: { name: marker },
      },
    ],
  });
  const draft = await start(await fixture(), csv(1));
  const response = await call(draft.tableId, 'ingest.draft.checks', target(draft));
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json();
  for (const check of body.output.checks) {
    expect(check.choices).toContain(marker);
    delete check.choices;
  }
  expect(JSON.stringify(body)).not.toContain(marker);
  expect(response.body).not.toMatch(/draftedIndex|correctIndex|correctChoice|answerIndex/);
});
it('passes typed number and date answers written in another form', async () => {
  const draft = await start(await fixture(), csv(1));
  const selected = await checks(draft);
  for (const check of selected.checks) {
    const value = check.field === 'amount' ? '1,200.50' : check.field === 'day' ? '03/01/2026' : 'Input-0';
    expect((await answer(draft, check, value)).passed).toBe(true);
  }
  expect((await read(draft.tableId, draft.id)).passedCount).toBe(3);
});
it('marks a mismatch without naming a correct value, blocks confirmation, and resolves by re-answering', async () => {
  const draft = await start(await fixture(), csv(1));
  const selected = await checks(draft);
  const check = selected.checks.find((check) => check.field === 'amount')!;
  const mismatched = await answer(draft, check, 'wrong');
  expect(mismatched).toMatchObject({ passed: false, needsCorrection: true });
  expect(JSON.stringify(mismatched)).not.toContain('1200');
  const marked = await read(draft.tableId, draft.id);
  expect(marked.markedRowCount).toBe(1);
  expect(marked.mismatches).toEqual([expect.objectContaining({ answer: 'wrong', current: 1200.5 })]);
  expect((await confirm(marked)).json().error.messageKey).toBe('ingest.drafts.checksRequired');
  await answer(draft, check, '1,200.50');
  expect((await read(draft.tableId, draft.id)).markedRowCount).toBe(0);
});
it('resolves a mismatch by correcting the cell, records the correction, and rejects a stale revision', async () => {
  const draft = await start(await fixture(), csv(1));
  const selected = await checks(draft);
  const check = selected.checks.find((check) => check.field === 'amount')!;
  await answer(draft, check, 1300);
  const marked = await read(draft.tableId, draft.id);
  const corrected = await applied(draft.tableId, 'ingest.draft.correct', {
    ...target(marked),
    rows: marked.rows!.map((row) => ({ id: row.id, values: { ...row.values, amount: 1300 } })),
  });
  expect(corrected.draft.rows[0]).toMatchObject({ corrected: ['amount'], needsCorrection: false });
  expect(corrected.draft.markedRowCount).toBe(0);
  expect(corrected.draft.corrections).toContainEqual(
    expect.objectContaining({ field: 'amount', before: 1200.5, after: 1300 }),
  );
  const stale = await call(draft.tableId, 'ingest.draft.correct', { ...target(marked), rows: [] });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error.messageKey).toBe('ingest.tables.stale');
});
it('adds and removes rows, and changes invalidate previously passed checks', async () => {
  let draft = await start(await fixture(), csv(2));
  draft = await pass(draft);
  const check = draft.checks![0]!;
  const changed = await applied(draft.tableId, 'ingest.draft.correct', {
    ...target(draft),
    rows: [
      ...draft.rows!.map((row) => ({
        id: row.id,
        values: row.id === check.rowId ? { ...row.values, [check.field]: 'changed' } : row.values,
      })),
      { values: { name: 'Added', amount: 8, day: '2026-03-02' }, at: { sheet: 'input.csv', row: 4 } },
    ],
  });
  expect(changed.draft.rowCount).toBe(3);
  expect(changed.draft.markedRowCount).toBe(1);
  const removed = await applied(draft.tableId, 'ingest.draft.correct', {
    ...target(changed.draft),
    rows: changed.draft.rows
      .slice(1)
      .map((row: NonNullable<Draft['rows']>[number]) => ({ id: row.id, values: row.values })),
  });
  expect(removed.draft.corrections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rowId: draft.rows![0]!.id, field: 'name', after: null }),
    ]),
  );
  expect(removed.draft.rowCount).toBe(2);
  expect(removed.draft.checkCount).toBe(draft.checkCount);
});
it('refuses confirmation before and during unanswered checks, then creates an example with own false', async () => {
  const seeded = await fixture();
  const draft = await start(seeded, csv(1));
  expect((await confirm(draft)).json().error.messageKey).toBe('ingest.drafts.checksRequired');
  const selected = await checks(draft);
  await answer(draft, selected.checks[0]!, draft.rows![0]!.values[selected.checks[0]!.field]);
  expect((await confirm(await read(draft.tableId, draft.id))).json().error.messageKey).toBe(
    'ingest.drafts.checksRequired',
  );
  for (const check of selected.checks.slice(1))
    await answer(draft, check, draft.rows![0]!.values[check.field]);
  const confirmed = await confirm(await read(draft.tableId, draft.id));
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  expect(confirmed.json().output.example.own).toBe(false);
  expect(confirmed.json().output.draft.state).toBe('confirmed');
});
it('replaces orphaned checks after row replacement and requires answers for current cells', async () => {
  let draft = await pass(await start(await fixture(), csv(1)));
  const orphaned = draft.checks!;
  const corrected = await applied(draft.tableId, 'ingest.draft.correct', {
    ...target(draft),
    rows: draft.rows!.map((row) => ({ values: row.values, at: row.at })),
  });
  draft = corrected.draft;
  for (const check of orphaned) {
    const response = await call(draft.tableId, 'ingest.draft.answer', {
      ...target(await read(draft.tableId, draft.id)),
      checkId: check.id,
      answer: { kind: 'typed', value: null },
    });
    expect(response.statusCode).toBe(404);
  }
  expect(draft.checks).toHaveLength(3);
  expect(draft.checks!.every((check) => draft.rows!.some((row) => row.id === check.rowId))).toBe(true);
  expect(draft.passedCount).toBe(0);
  expect((await confirm(draft)).json().error.messageKey).toBe('ingest.drafts.checksRequired');
  expect((await confirm(await pass(draft))).statusCode).toBe(200);
});
it('refuses scoring and confirmation of stored checks whose rows no longer exist', async () => {
  let draft = await pass(await start(await fixture(), csv(1)));
  await server.pool.query(
    `UPDATE ${server.schemas.app}.ingest_drafts SET document = jsonb_set(document, '{rows}', '[]') WHERE id = $1`,
    [draft.id],
  );
  draft = await read(draft.tableId, draft.id);
  for (const check of draft.checks!) {
    const response = await call(draft.tableId, 'ingest.draft.answer', {
      ...target(await read(draft.tableId, draft.id)),
      checkId: check.id,
      answer: { kind: 'typed', value: null },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.messageKey).toBe('ingest.drafts.checksRequired');
  }
  expect((await confirm(await read(draft.tableId, draft.id))).json().error.messageKey).toBe(
    'ingest.drafts.checksRequired',
  );
});
it('supplements three passed checks when added rows raise the current minimum to five', async () => {
  let draft = await pass(await start(await fixture(), csv(1)));
  const original = draft.checks!;
  const corrected = await applied(draft.tableId, 'ingest.draft.correct', {
    ...target(draft),
    rows: [
      ...draft.rows!.map((row) => ({ id: row.id, values: row.values })),
      { values: { name: 'Added', amount: 8, day: '2026-03-02' }, at: { sheet: 'input.csv', row: 3 } },
    ],
  });
  draft = corrected.draft;
  expect(draft.checkCount).toBe(5);
  expect(draft.passedCount).toBe(3);
  expect(draft.checks!.slice(0, 3)).toEqual(original);
  expect((await checks(draft)).checks).toEqual(draft.checks);
  expect((await confirm(draft)).json().error.messageKey).toBe('ingest.drafts.checksRequired');
  expect((await confirm(await pass(draft))).statusCode).toBe(200);
});
it('enforces the current minimum when stored checks are incomplete', async () => {
  const draft = await pass(await start(await fixture(), csv(2)));
  await server.pool.query(
    `UPDATE ${server.schemas.app}.ingest_drafts SET document = jsonb_set(document, '{checks}', $2::jsonb) WHERE id = $1`,
    [draft.id, JSON.stringify(draft.checks!.slice(0, 3))],
  );
  expect((await confirm(await read(draft.tableId, draft.id))).json().error.messageKey).toBe(
    'ingest.drafts.checksRequired',
  );
});
it('recovers an expired worker claim with its previous spending history', async () => {
  const seeded = await fixture();
  script.read.mockResolvedValueOnce(notRead('fileLimit', 0.04, 1));
  const draft = await start(seeded, csv(1));
  await server.pool.query(
    `UPDATE ${server.schemas.app}.ingest_drafts SET state = 'drafting',
      document = jsonb_set(document, '{state}', '"drafting"'), run_token = $2,
      updated_at = now() - interval '1 day' WHERE id = $1`,
    [draft.id, newId('command')],
  );
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  startDraftWork(server.app, actor, draft.tableId, draft.id);
  await waitForDraftWork(server.app);
  expect((await read(draft.tableId, draft.id)).state).toBe('ready');
  expect(script.read.mock.calls[1]![3]).toMatchObject({ ai: { costUsd: 0.04, chunks: 1 } });
});
it('allows restarting a discarded file after its abandoned claim expires', async () => {
  const seeded = await fixture();
  const draft = await start(seeded, csv(1));
  await server.pool.query(`UPDATE ${server.schemas.app}.ingest_drafts SET run_token = $2 WHERE id = $1`, [
    draft.id,
    newId('command'),
  ]);
  await applied(draft.tableId, 'ingest.draft.discard', target(draft));
  await server.pool.query(
    `UPDATE ${server.schemas.app}.ingest_drafts SET updated_at = now() - interval '1 day' WHERE id = $1`,
    [draft.id],
  );
  const restarted = await start(seeded, csv(1));
  expect(restarted.state).toBe('ready');
  expect(restarted.id).toBe(draft.id);
  expect(script.read.mock.calls[1]![3]).toMatchObject({ ai: { costUsd: 0.03, chunks: 1 } });
});
it('persists a recoverable failure when work exits before loading its table', async () => {
  const seeded = await fixture();
  const draft = await start(seeded, csv(1));
  await server.pool.query(
    `UPDATE ${server.schemas.app}.ingest_drafts SET state = 'drafting',
      document = jsonb_set(document, '{state}', '"drafting"') WHERE id = $1`,
    [draft.id],
  );
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  const load = vi.spyOn(metadata, 'loadTable').mockRejectedValueOnce(new Error('Interrupted table loading'));
  try {
    startDraftWork(server.app, actor, seeded.tableId, draft.id);
    await waitForDraftWork(server.app);
    expect(await read(seeded.tableId, draft.id)).toMatchObject({
      state: 'failed',
      failure: 'providerUnavailable',
      rowCount: 0,
    });
    expect((await start(seeded, csv(1))).state).toBe('ready');
  } finally {
    load.mockRestore();
  }
});
it('retains reserved spending when an unexpected reader interruption ends the work', async () => {
  const seeded = await fixture();
  script.read.mockImplementationOnce(async (...args) => {
    await args[4]({ ai: { costUsd: 0.04, chunks: 1, complete: false } });
    throw new Error('Interrupted reading');
  });
  const failed = await start(seeded, csv(1));
  expect(failed.state).toBe('failed');
  expect((await start(seeded, csv(1))).state).toBe('ready');
  expect(script.read.mock.calls[1]![3]).toMatchObject({ ai: { costUsd: 0.04, chunks: 1 } });
});
it('restarts expired work with its reservation and rejects the previous worker’s late output', async () => {
  const seeded = await fixture();
  const usual = script.read.getMockImplementation()!;
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  script.read.mockImplementationOnce(async (...args) => {
    await args[4]({ ai: { costUsd: 0.04, chunks: 1, complete: false } });
    enter();
    await pending;
    const reading = await usual(...args);
    reading.rows[0].values.name = 'Late output';
    return { ...reading, checks: { ai: { costUsd: 0.05, chunks: 1, complete: true } } };
  });
  script.read.mockImplementationOnce(async (...args) => ({
    ...(await usual(...args)),
    checks: { ai: { costUsd: 0.07, chunks: 2, complete: true } },
  }));
  const started = await applied(seeded.tableId, 'ingest.draft.start', {
    formatId: seeded.formatId,
    file: file(csv(1)),
  });
  await entered;
  try {
    await server.pool.query(
      `UPDATE ${server.schemas.app}.ingest_drafts SET updated_at = now() - interval '1 day' WHERE id = $1`,
      [started.draft.id],
    );
    const restarted = await applied(seeded.tableId, 'ingest.draft.start', {
      formatId: seeded.formatId,
      file: file(csv(1)),
    });
    expect(restarted.draft.id).toBe(started.draft.id);
  } finally {
    release();
  }
  await waitForDraftWork(server.app);
  const current = await read(seeded.tableId, started.draft.id);
  expect(current).toMatchObject({
    state: 'ready',
    rows: [expect.objectContaining({ values: expect.objectContaining({ name: 'Input-0' }) })],
  });
  expect(script.read.mock.calls[1]![3]).toMatchObject({ ai: { costUsd: 0.04, chunks: 1 } });
  const stored = await server.pool.query(
    `SELECT document->'readerChecks' AS checks FROM ${server.schemas.app}.ingest_drafts WHERE id = $1`,
    [current.id],
  );
  expect(stored.rows[0].checks).toMatchObject({ ai: { costUsd: 0.07, chunks: 2 } });
});
it('repairs missing original bytes from a fresh upload without changing arrival or spending history', async () => {
  const seeded = await fixture();
  const draft = await start(seeded, csv(1));
  const before = await server.pool.query(
    `SELECT stored_file, received_at FROM ${server.schemas.app}.ingest_files WHERE id = $1`,
    [draft.fileId],
  );
  await server.pool.query(`DELETE FROM ${server.schemas.app}.file_chunks WHERE storage_key = $1`, [
    before.rows[0].stored_file,
  ]);
  await applied(draft.tableId, 'ingest.draft.discard', target(draft));
  const restarted = await start(seeded, csv(1));
  expect(restarted.state).toBe('ready');
  const after = await server.pool.query(
    `SELECT stored_file, received_at FROM ${server.schemas.app}.ingest_files WHERE id = $1`,
    [draft.fileId],
  );
  expect(after.rows[0].stored_file).not.toBe(before.rows[0].stored_file);
  expect(after.rows[0].received_at).toEqual(before.rows[0].received_at);
  expect(script.read.mock.calls[1]![3]).toMatchObject({ ai: { costUsd: 0.03, chunks: 1 } });
});
it('requires the usual second call for nonblocking arrival findings and refuses blocking findings', async () => {
  const seeded = await fixture();
  let draft = await start(seeded, csv(1));
  await applied(draft.tableId, 'ingest.draft.correct', {
    ...target(draft),
    rows: draft.rows!.map((row) => ({ id: row.id, values: { ...row.values, name: 'Absent from input' } })),
  });
  draft = await pass(await read(draft.tableId, draft.id));
  const refused = await call(draft.tableId, 'ingest.draft.confirm', { ...target(draft), confirm: true });
  expect(refused.json().error.messageKey).toBe('ingest.setup.confirmPair');
  const confirmed = await confirm(draft);
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  let blocked = await start(seeded, csv(1, 'Blocked'));
  await applied(blocked.tableId, 'ingest.draft.correct', {
    ...target(blocked),
    rows: blocked.rows!.map((row) => ({ id: row.id, values: { ...row.values, amount: null } })),
  });
  blocked = await pass(await read(blocked.tableId, blocked.id));
  expect((await confirm(blocked)).json().error.messageKey).toBe('ingest.setup.pairBlocked');
});
it('confirms corrected draft rows that copy the input after spot checks and records the finding', async () => {
  const seeded = await fixture();
  let draft = await start(seeded, 'name,amount,day\nInput-0,1200.5,2026-03-01\n');
  await applied(draft.tableId, 'ingest.draft.correct', {
    ...target(draft),
    rows: draft.rows!.map((row) => ({ id: row.id, values: { ...row.values, amount: '1200.5' } })),
  });
  draft = await read(draft.tableId, draft.id);
  expect((await call(draft.tableId, 'ingest.draft.confirm', target(draft))).json().error.messageKey).toBe(
    'ingest.drafts.checksRequired',
  );
  draft = await pass(draft);
  const before = await server.app.inject({
    url: `/api/tables/${draft.tableId}/ingest`,
    headers: server.owner.headers,
  });
  const first = await call(draft.tableId, 'ingest.draft.confirm', target(draft));
  expect(first.json()).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'ingest.setup.confirmPair' },
    details: {
      needsConfirmation: true,
      findings: [{ kind: 'input-as-output', messageId: 'ingest.pairs.inputAsOutput', blocks: false }],
    },
  });
  const pending = await server.app.inject({
    url: `/api/tables/${draft.tableId}/ingest`,
    headers: server.owner.headers,
  });
  expect(pending.json().examples).toEqual(before.json().examples);
  expect((await read(draft.tableId, draft.id)).state).toBe('ready');
  const confirmed = await applied(draft.tableId, 'ingest.draft.confirm', {
    ...target(draft),
    confirm: true,
    confirmationId: first.json().details.confirmationId,
  });
  expect(confirmed).toMatchObject({
    draft: { state: 'confirmed' },
    example: {
      own: false,
      expected: draft.rows!.map(({ values }) => ({ values })),
      confirmedBy: server.owner.userId,
      confirmedFindings: first.json().details.findings,
    },
  });
  const saved = await server.app.inject({
    url: `/api/tables/${draft.tableId}/ingest`,
    headers: server.owner.headers,
  });
  expect(saved.json().examples).toContainEqual(confirmed.example);
});
it('routes own rows matching a draft through spot checks and accepts rows differing in one cell as own', async () => {
  const seeded = await fixture();
  const draft = await start(seeded, csv(1));
  const matching = await applied(seeded.tableId, 'ingest.example.add', {
    formatId: seeded.formatId,
    file: file(csv(1)),
    expected: { kind: 'paste', text: expected(1, 'Input') },
  });
  expect(matching).toMatchObject({
    requiresSpotChecks: true,
    messageId: 'ingest.drafts.matchesDraft',
    draft: { id: draft.id },
  });
  expect(matching.example).toBeUndefined();
  const input = {
    formatId: seeded.formatId,
    file: file(csv(1)),
    expected: { kind: 'paste', text: expected(1, 'Input').replace('Input-0', 'Changed') },
  };
  const first = await call(seeded.tableId, 'ingest.example.add', input);
  const response =
    first.statusCode === 200
      ? first
      : await call(seeded.tableId, 'ingest.example.add', {
          ...input,
          confirm: true,
          confirmationId: first.json().details.confirmationId,
        });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().output.example.own).toBe(true);
});
for (const reason of [
  'aiOff',
  'ingestOff',
  'classification',
  'unsupported',
  'tooLarge',
  'fileLimit',
  'unpriced',
  'dynamicChoices',
  'monthlyBudget',
  'providerUnavailable',
] as const)
  it(`persists ${reason} without partial rows and can restart with prior spend`, async () => {
    const seeded = await fixture();
    script.read.mockImplementationOnce(async () => {
      if (reason === 'monthlyBudget' || reason === 'providerUnavailable')
        throw new TryLaterError(`ingest.aiReader.${reason}`, { ai: { costUsd: 0.04, chunks: 1 } });
      return notRead(reason, 0.04, 1);
    });
    const failed = await start(seeded, csv(1));
    expect(failed).toMatchObject({ state: 'failed', failure: reason, rowCount: 0 });
    const retry = await start(seeded, csv(1));
    expect(retry.state).toBe('ready');
    expect(retry.id).toBe(failed.id);
    expect(script.read.mock.calls[1]![3]).toMatchObject({ ai: { costUsd: 0.04, chunks: 1 } });
  });
it('does model work without a command lock, and discarding rejects late output', async () => {
  const seeded = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const usual = script.read.getMockImplementation()!;
  script.read.mockImplementationOnce(async (...args) => {
    entered();
    await pending;
    return usual(...args);
  });
  const started = await applied(seeded.tableId, 'ingest.draft.start', {
    formatId: seeded.formatId,
    file: file(csv(1)),
  });
  await called;
  try {
    const discarded = await applied(seeded.tableId, 'ingest.draft.discard', target(started.draft));
    expect(discarded.draft.state).toBe('discarded');
    const tooSoon = await call(seeded.tableId, 'ingest.draft.start', {
      formatId: seeded.formatId,
      file: file(csv(1)),
    });
    expect(tooSoon.json().error.messageKey).toBe('ingest.drafts.finishing');
  } finally {
    release();
  }
  await waitForDraftWork(server.app);
  expect((await read(seeded.tableId, started.draft.id)).state).toBe('discarded');
  const restarted = await start(seeded, csv(1));
  expect(restarted.state).toBe('ready');
  expect(script.read.mock.calls[1]![3]).toMatchObject({ ai: { costUsd: 0.03, chunks: 1 } });
});
it('refuses editors, withholds evidence under record rules, and refuses all draft commands in demo mode', async () => {
  const seeded = await fixture();
  const draft = await start(seeded, csv(1));
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by) VALUES ($1, 'database', $2, 'user', $3, 'editor', $4)`,
    [server.owner.info.org.id, seeded.databaseId, editor.userId, server.owner.userId],
  );
  for (const [kind, input] of [
    ['ingest.draft.start', { formatId: seeded.formatId, file: file(csv()) }],
    ['ingest.draft.confirm', target(draft)],
  ] as const)
    expect((await call(seeded.tableId, kind, input, editor)).statusCode).toBe(403);
  await saveRecordRules(
    server.pool,
    server.schemas,
    { orgId: editor.info.org.id, databaseId: seeded.databaseId, tableId: seeded.tableId },
    [
      {
        id: newId('recordRule'),
        roles: ['editor'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'visible', fieldId: seeded.fieldId, operator: 'is', value: 'Visible' }],
        },
      },
    ],
    server.owner.userId,
  );
  const withheld = await read(seeded.tableId, draft.id, editor);
  expect(withheld).toMatchObject({ state: 'ready', rowCount: 1, evidenceWithheld: true });
  expect(withheld.rows).toBeUndefined();
  expect(withheld.checks).toBeUndefined();
  expect(withheld.mismatches).toBeUndefined();
  const owner = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  for (const [kind, input] of [
    ['ingest.draft.start', { formatId: seeded.formatId, file: file(csv()) }],
    ['ingest.draft.correct', { ...target(draft), rows: [] }],
    ['ingest.draft.discard', target(draft)],
    ['ingest.draft.checks', target(draft)],
    ['ingest.draft.answer', { ...target(draft), checkId: 'missing', answer: { kind: 'typed', value: '' } }],
    ['ingest.draft.confirm', target(draft)],
  ] as Array<[string, object]>)
    await expect(
      runIngestSetupCommand(
        server.app,
        { ...owner, demo: true },
        { id: newId('command'), tableId: seeded.tableId, kind, ...input },
      ),
    ).rejects.toMatchObject({ messageKey: 'demo.readOnly' });
});
it('protects active inputs during retention changes, and discard restores retention from arrival', async () => {
  const seeded = await fixture();
  const draft = await start(seeded, csv(1));
  await server.pool.query(
    `UPDATE ${server.schemas.app}.ingest_files SET received_at = now() - interval '90 days' WHERE id = $1`,
    [draft.fileId],
  );
  await applyPeriods(server.ctx, server.pool, server.owner.info.org.id, [
    { id: seeded.tableId, database_id: seeded.databaseId, keepDays: 30 },
  ]);
  const kept = await server.pool.query(
    `SELECT expires_at, stored_file, is_example FROM ${server.schemas.app}.ingest_files WHERE id = $1`,
    [draft.fileId],
  );
  expect(kept.rows[0]).toMatchObject({ expires_at: null, is_example: false });
  expect(kept.rows[0].stored_file).toBeTruthy();
  await applied(seeded.tableId, 'ingest.draft.discard', target(draft));
  const discarded = await server.pool.query(
    `SELECT expires_at <= now() AS expired, expires_at - received_at AS period FROM ${server.schemas.app}.ingest_files WHERE id = $1`,
    [draft.fileId],
  );
  expect(discarded.rows[0].expired).toBe(true);
  await sweepOriginals(server.ctx);
  expect(
    (
      await server.pool.query(`SELECT stored_file FROM ${server.schemas.app}.ingest_files WHERE id = $1`, [
        draft.fileId,
      ])
    ).rows[0].stored_file,
  ).toBeNull();
  expect((await start(seeded, csv(1))).state).toBe('ready');
});
it('audits draft commands and keeps evidence out of shared replay', async () => {
  const seeded = await fixture();
  const draft = await start(seeded, csv(1));
  await checks(draft);
  const stored = await server.pool.query(
    `SELECT result FROM ${server.schemas.app}.commands WHERE ingest_result->>'tableId' = $1 AND ingest_result->>'kind' LIKE 'ingest.draft.%'`,
    [seeded.tableId],
  );
  expect(stored.rowCount).toBe(2);
  expect(JSON.stringify(stored.rows)).not.toContain('Input-0');
  const events = await server.pool.query(
    `SELECT action FROM ${server.schemas.audit}.events WHERE metadata->>'tableId' = $1`,
    [seeded.tableId],
  );
  expect(events.rows.map((row) => row.action)).toEqual(
    expect.arrayContaining(['data.ingest.draft.start', 'data.ingest.draft.checks']),
  );
});

it('accepts a shuffled choice or a typed none answer without returning the alternatives in scoring', async () => {
  const draft = await start(await fixture(), csv(1));
  const selected = await checks(draft);
  const check = selected.checks.find((check) => check.field === 'name')!;
  const index = check.choices.findIndex((value) => value === 'Input-0');
  const chosen = await applied(draft.tableId, 'ingest.draft.answer', {
    draftId: draft.id,
    revision: selected.revision,
    checkId: check.id,
    answer: { kind: 'choice', index },
  });
  expect(chosen).toMatchObject({ passed: true });
  expect(JSON.stringify(chosen)).not.toContain('Input-0');
  const current = await read(draft.tableId, draft.id);
  const typed = await applied(draft.tableId, 'ingest.draft.answer', {
    ...target(current),
    checkId: check.id,
    answer: { kind: 'none', value: 'Input-0' },
  });
  expect(typed.passed).toBe(true);
});
it('keeps three confirmed draft examples insufficient after removing the own example', async () => {
  const seeded = await fixture();
  for (const prefix of ['First', 'Second', 'Third']) {
    const draft = await pass(await start(seeded, csv(1, prefix)));
    const response = await confirm(draft);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().output.example.own).toBe(false);
  }
  const own = await server.pool.query(
    `SELECT id FROM ${server.schemas.app}.ingest_examples WHERE table_id = $1 AND own`,
    [seeded.tableId],
  );
  await applied(seeded.tableId, 'ingest.example.remove', { exampleId: own.rows[0].id });
  const readiness = await server.app.inject({
    url: `/api/tables/${seeded.tableId}/ingest/readiness`,
    headers: server.owner.headers,
  });
  expect(readiness.statusCode, readiness.body).toBe(200);
  const gate = readiness.json().gates.find((gate: { id: string }) => gate.id === 'G3');
  expect(gate.met).toBe(false);
  expect(gate.gaps).toEqual(
    expect.arrayContaining([expect.objectContaining({ messageId: 'ingest.ready.ownExample' })]),
  );
});
it('restores ordinary retention when a format is removed, and enforces the draft file foreign key', async () => {
  const seeded = await fixture();
  const draft = await start(seeded, csv(1));
  await expect(
    server.pool.query(
      `INSERT INTO ${server.schemas.app}.ingest_drafts
    (id, org_id, table_id, format_id, file_id, revision, state, document) VALUES ('foreign', $1, $2, $3, 'missing', 0, 'ready', '{}')`,
      [server.owner.info.org.id, seeded.tableId, seeded.formatId],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    server.pool.query(
      `INSERT INTO ${server.schemas.app}.ingest_drafts
    (id, org_id, table_id, format_id, file_id, revision, state, document) VALUES ('duplicate', $1, $2, $3, $4, 0, 'ready', '{}')`,
      [server.owner.info.org.id, seeded.tableId, seeded.formatId, draft.fileId],
    ),
  ).rejects.toMatchObject({ code: '23505' });
  await applied(seeded.tableId, 'ingest.format.remove', { formatId: seeded.formatId });
  const file = await server.pool.query(
    `SELECT expires_at IS NOT NULL AS ordinary FROM ${server.schemas.app}.ingest_files WHERE id = $1`,
    [draft.fileId],
  );
  expect(file.rows[0].ordinary).toBe(true);
  expect(
    (await server.pool.query(`SELECT id FROM ${server.schemas.app}.ingest_drafts WHERE id = $1`, [draft.id]))
      .rowCount,
  ).toBe(0);
});

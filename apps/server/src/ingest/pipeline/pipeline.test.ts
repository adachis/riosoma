import type { StoredTable } from '../../data/types.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseCreate, newId, type IngestFile, type TableMeta } from '@riosoma/contracts';
import {
  createQuestion,
  type DecisionQuestion,
  type QuestionResponse,
  type IngestRow,
  type RuleScope,
} from '@riosoma/ingest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { createPool, ident, query, sql } from '@riosoma/db';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { loadFields, loadTable } from '../../data/metadata.js';
import { currentValues } from '../../data/physical/records.js';
import { IngestTableStore } from '../tables/store.js';
import * as safety from '../../data/files/safety.js';
import * as writerStorage from '../write/storage.js';
import { kind, valueDoubt } from './reading.js';
import { IngestWorker, TryLaterError } from './index.js';
import { LeaseLost } from './store.js';

let kit: TestPostgres;
let server: ServerFixture;
let store: IngestTableStore;
let worker: IngestWorker;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'pipeline');
  server.ctx.ingest!.pause();
  store = new IngestTableStore(server.pool, server.schemas);
  worker = new IngestWorker(server.app);
}, 60_000);
afterAll(async () => {
  await worker?.close();
  await server?.close();
  await kit?.stop();
});

async function fixture(
  options: { identity?: string[] | null; reading?: 'layout' | 'ai' | 'reader'; ownerId?: string } = {},
) {
  const specs = [
    { key: 'code', type: 'text' },
    { key: 'amount', type: 'number' },
    { key: 'needsReview', type: 'checkbox' },
    { key: 'reviewNote', type: 'longText' },
    { key: 'readByAi', type: 'checkbox' },
    { key: 'source', type: 'text' },
    { key: 'received', type: 'date', options: { includeTime: true } },
  ].map((spec) => ({ ...spec, id: newId('field') }));
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Incoming',
    table: {
      id: newId('table'),
      name: 'Arrivals',
      fields: specs.map((spec) => ({ ...spec, name: spec.key })),
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(created.statusCode, created.body).toBe(200);
  const context = { orgId: server.owner.info.org.id, tableId: input.table.id, userId: server.owner.userId };
  await store.changeSettings(context, null, {
    state: 'live',
    ownerId: options.ownerId ?? server.owner.userId,
    identity: options.identity === undefined ? ['code'] : options.identity,
    rowMeaning: 'An arrival',
    fields: specs
      .slice(0, 2)
      .map((spec) => ({ key: spec.key, fieldId: spec.id, meaning: spec.key, required: false })),
    originals: { keepDays: 90, readOnlyAccess: false },
    reply: true,
  });
  for (const spec of specs)
    await store.markField(context, spec.id, {
      key: spec.key,
      role: ['code', 'amount'].includes(spec.key) ? 'data' : 'process',
    });
  const format = await store.createFormat(context, {
    name: 'CSV',
    state: 'live',
    probationPassed: 0,
    signature: { id: randomUUID(), kind: 'text', headerGroups: [['Code']], markers: [] },
    ...(options.reading === 'ai'
      ? { reading: 'ai' as const, rules: null }
      : options.reading === 'reader'
        ? {
            reading: 'reader' as const,
            rules: {
              code: 'const rows = source.sheet(0).rows(); for (const row of rows.slice(1)) emit({ code: row[0].v, amount: row[1].v });',
              toolkitVersion: '1',
            },
          }
        : {
            reading: 'layout' as const,
            rules: {
              header: { markers: ['Code'], searchRows: 10 },
              columns: {
                code: { aliases: ['Code', 'Identifier'], cleaners: [{ kind: 'text' as const }] },
                amount: { aliases: ['Amount'], cleaners: [{ kind: 'number' as const }] },
              },
            },
          }),
  });
  const table = (await loadTable(server.pool, server.schemas, input.table.id))!;
  return { context, table, format };
}
const csv = (code: string, amount = '1') => Buffer.from(`Code,Amount\n${code},${amount}\n`);
const incoming = (table: StoredTable, bytes: Buffer, name = 'rows.csv', target = worker) =>
  target.receiveFile(table, { bytes, name, droppedBy: server.owner.userId });
const readFile = (file: IngestFile) => store.readFile(file, file.id) as Promise<IngestFile>;
async function records(table: TableMeta) {
  const fields = await loadFields(server.pool, server.schemas, [table.id]);
  const ids = await query<{ __id: string }>(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, table.id)} WHERE __deleted_at IS NULL ORDER BY __rid`,
  );
  const values = await currentValues(
    server.pool,
    server.schemas.data,
    table.id,
    fields,
    ids.rows.map((row) => row.__id),
  );
  return ids.rows.map((row) =>
    Object.fromEntries(fields.map((field) => [field.ingest!.key, values.get(row.__id)![field.id]])),
  );
}
async function questions(file: IngestFile) {
  const result = await query<{ document: DecisionQuestion; active: boolean }>(
    server.pool,
    sql`SELECT document, active FROM ${ident(server.schemas.app, 'ingest_questions')}
    WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND document->'target'->>'file' = ${file.id}`,
  );
  return result.rows;
}
async function answer(file: IngestFile, question: DecisionQuestion, response: QuestionResponse) {
  const accepted = await worker.store.decisions.answerQuestion(
    { ...file, userId: server.owner.userId, canEditRecords: true, canEditSchema: true },
    { questionId: question.id, questionVersion: question.version, response },
  );
  expect(accepted.status).toBe('accepted');
  return accepted;
}
const outputRow = (code: string, amount: unknown = 1, row = 2): IngestRow => ({
  values: { code, amount },
  raw: {},
  at: { row },
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it('reads a known layout, fills process fields, holds a duplicate, and writes no extra identity on readAnyway', async () => {
  const { table } = await fixture();
  const first = await incoming(table, csv('00123', '15'));
  expect(first.state).toBe('received');
  await worker.drain();
  expect(await readFile(first)).toMatchObject({ state: 'read', counts: { added: 1 } });
  expect(await records(table)).toEqual([
    expect.objectContaining({
      code: '00123',
      amount: 15,
      source: expect.stringContaining('rows.csv'),
      needsReview: false,
      readByAi: false,
      received: first.receivedAt,
    }),
  ]);
  expect((await records(table))[0]!.source).toMatch(/row 2/i);
  const duplicate = await incoming(table, csv('00123', '15'));
  expect(duplicate).toMatchObject({ state: 'held', holdReason: 'ingest.pipeline.seenBefore' });
  await worker.readAnyway(duplicate.id, server.owner.userId);
  await worker.drain();
  expect(await readFile(duplicate)).toMatchObject({ state: 'read', counts: { added: 0, identical: 1 } });
  expect(await records(table)).toHaveLength(1);
});

it.each(
  (['drain', 'tick'] as const).flatMap((method) =>
    (['advisory', 'table', 'file'] as const).map((lock) => ({ method, lock })),
  ),
)('waits for $lock contention before $method finishes claiming', async ({ method, lock }) => {
  const { table } = await fixture();
  const file = await incoming(table, csv(`contended-${method}-${lock}`));
  const holder = await server.pool.connect();
  let settled = false;
  let work: Promise<void> | undefined;
  let finishedWhileContended: boolean;
  try {
    await holder.query('BEGIN');
    if (lock === 'advisory')
      await query(
        holder,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${server.schemas.app}:database:${table.databaseId}`}, 0))`,
      );
    else if (lock === 'table')
      await query(
        holder,
        sql`SELECT id FROM ${ident(server.schemas.app, 'tables')} WHERE id = ${table.id} FOR UPDATE`,
      );
    else
      await query(
        holder,
        sql`SELECT id FROM ${ident(server.schemas.app, 'ingest_files')} WHERE id = ${file.id} FOR UPDATE`,
      );
    work = worker[method]().finally(() => {
      settled = true;
    });
    await vi.waitFor(async () => {
      const waiting = await query(
        server.pool,
        sql`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      expect(settled || Boolean(waiting.rowCount)).toBe(true);
    });
    finishedWhileContended = settled;
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await work;
  }
  const afterClaim = await readFile(file);
  await worker.drain();
  if (method === 'drain') expect(afterClaim).toMatchObject({ state: 'read', counts: { added: 1 } });
  expect(finishedWhileContended).toBe(false);
  expect(await readFile(file)).toMatchObject({ state: 'read', counts: { added: 1 } });
});

it('rejects a drain at the database lock deadline without losing earlier claims', async () => {
  const ready = await fixture();
  const { table } = await fixture();
  const first = await incoming(ready.table, csv('before-lock-deadline'));
  const file = await incoming(table, csv('lock-deadline'));
  const pool = createPool(server.config.database!, { lockTimeoutMs: 50 });
  const holder = await server.pool.connect();
  const originalPool = server.ctx.pool;
  try {
    await holder.query('BEGIN');
    await query(
      holder,
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${server.schemas.app}:database:${table.databaseId}`}, 0))`,
    );
    server.ctx.pool = pool;
    await expect(worker.drain()).rejects.toMatchObject({ code: '55P03' });
    expect(await readFile(first)).toMatchObject({ state: 'read', counts: { added: 1 } });
    expect(await readFile(file)).toMatchObject({ state: 'received', attempts: 0 });
  } finally {
    server.ctx.pool = originalPool;
    await holder.query('ROLLBACK');
    holder.release();
    await pool.end();
    await worker.drain();
  }
  expect(await readFile(file)).toMatchObject({ state: 'read', counts: { added: 1 } });
});

it.each(['queued', 'running'] as const)(
  'does not bypass an arrival with a %s live request',
  async (state) => {
    const a = await fixture();
    const b = await fixture();
    const first = await incoming(a.table, csv('live-head'));
    const second = await incoming(a.table, csv('live-later'));
    const other = await incoming(b.table, csv('live-other-table'));
    const id = randomUUID();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'ingest_live_requests')}
    (id, org_id, table_id, file_id, user_id, action, state, lease_until)
    VALUES (${id}, ${first.orgId}, ${first.tableId}, ${first.id}, ${server.owner.userId}, 'remove', ${state}, clock_timestamp() + interval '5 minutes')`,
    );
    let claims: Awaited<ReturnType<IngestWorker['claim']>> = [];
    try {
      claims = await worker.claim();
      expect(claims.map((claim) => claim.file.id)).toEqual([other.id]);
      expect(await readFile(first)).toMatchObject({ state: 'received', attempts: 0 });
      expect(await readFile(second)).toMatchObject({ state: 'received', attempts: 0 });
    } finally {
      await query(
        server.pool,
        sql`DELETE FROM ${ident(server.schemas.app, 'ingest_live_requests')} WHERE id = ${id}`,
      );
      await Promise.all(claims.map((claim) => worker.run(claim)));
      await worker.drain();
    }
  },
);

it('rescans arrivals when an active file finishes during a claim', async () => {
  const { table } = await fixture({ reading: 'ai' });
  const first = await incoming(table, csv('active-first'));
  const second = await incoming(table, csv('active-second'));
  const started = gate();
  const reading = gate();
  const finished = gate();
  const checked = gate();
  worker.functions.readWithAi = async (source) => {
    const code = String(source.sheets![0]!.rows[1]![0]!.v);
    if (code === 'active-first') {
      started.release();
      await reading.promise;
    }
    return { rows: [outputRow(code)] };
  };
  const claim = worker.claim.bind(worker);
  const run = worker.run.bind(worker);
  const running = vi.spyOn(worker, 'run').mockImplementation(async (claim) => {
    try {
      await run(claim);
    } finally {
      if (claim.file.id === first.id) finished.release();
    }
  });
  let claiming: ReturnType<typeof vi.spyOn> | undefined;
  let drain: Promise<void> | undefined;
  try {
    await worker.tick();
    await started.promise;
    claiming = vi.spyOn(worker, 'claim').mockImplementation(async (...args) => {
      const claims = await claim(...args);
      checked.release();
      await finished.promise;
      // Let the tick remove its completed promise before drain inspects the active set.
      await query(server.pool, sql`SELECT 1`);
      return claims;
    });
    drain = worker.drain();
    await checked.promise;
    reading.release();
    await drain;
    expect(await readFile(first)).toMatchObject({ state: 'read', counts: { added: 1 } });
    expect(await readFile(second)).toMatchObject({ state: 'read', counts: { added: 1 } });
  } finally {
    reading.release();
    claiming?.mockRestore();
    await drain;
    await worker.drain();
    running.mockRestore();
    worker.functions = {};
  }
});

it('preserves table arrival order, interleaves tables, and limits the server to two active files', async () => {
  const a = await fixture({ reading: 'ai' });
  const b = await fixture({ reading: 'ai' });
  const c = await fixture({ reading: 'ai' });
  const started: string[] = [];
  const blocked = gate();
  worker.functions.readWithAi = async (source) => {
    const code = String(source.sheets![0]!.rows[1]![0]!.v);
    started.push(code);
    if (code === 'a1' || code === 'b1') await blocked.promise;
    return { rows: [outputRow(code)] };
  };
  await incoming(a.table, csv('a1'));
  await incoming(a.table, csv('a2'));
  await incoming(a.table, csv('a3'));
  await incoming(b.table, csv('b1'));
  const third = await incoming(c.table, csv('c1'));
  const claims = await worker.claim(9);
  expect(claims).toHaveLength(2);
  const runs = claims.map((claim) => worker.run(claim));
  try {
    expect(claims.map((claim) => claim.file.tableId)).toEqual([a.table.id, b.table.id]);
    // Starting the extractor processes can take more than a second while other test files run.
    await vi.waitFor(() => expect([...started].sort()).toEqual(['a1', 'b1']), { timeout: 30_000 });
    expect(await worker.claim()).toEqual([]);
    expect((await readFile(third)).state).toBe('received');
  } finally {
    blocked.release();
    // Leave no queued arrivals for the next test, even when an assertion above fails.
    try {
      await Promise.all(runs);
      await worker.drain();
    } finally {
      worker.functions = {};
    }
  }
  expect((await records(a.table)).map((row) => row.code)).toEqual(['a1', 'a2', 'a3']);
  expect(started).toContain('c1');
});

it('recovers a crash after the second of five batches without duplicating rows on a table without identity', async () => {
  const { table } = await fixture({ identity: null });
  const file = await incoming(
    table,
    Buffer.from(
      'Code,Amount\n' + Array.from({ length: 5000 }, (_, index) => `row-${index},${index}`).join('\n'),
    ),
  );
  const claim = (await worker.claim())[0]!;
  expect(claim.file.id).toBe(file.id);
  const locked = writerStorage.locked;
  let crashed = false;
  const intercept = vi.spyOn(writerStorage, 'locked').mockImplementation(async (services, target, work) => {
    const result = await locked(services, target, work);
    const batches = await query<{ count: string }>(
      server.pool,
      sql`SELECT count(*) FROM ${ident(server.schemas.app, 'ingest_write_batches')}
      WHERE file_id = ${file.id} AND operation LIKE 'write:%' AND operation <> 'write:outcomes'`,
    );
    if (!crashed && Number(batches.rows[0]!.count) === 2) {
      crashed = true;
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'ingest_files')} SET lease_until = now() - interval '1 second' WHERE id = ${file.id}`,
      );
      throw new LeaseLost();
    }
    return result;
  });
  try {
    await worker.run(claim);
  } finally {
    intercept.mockRestore();
  }
  expect(crashed).toBe(true);
  expect(await records(table)).toHaveLength(2000);
  await worker.drain();
  const landed = await records(table);
  expect(landed).toHaveLength(5000);
  expect(new Set(landed.map((row) => row.code)).size).toBe(5000);
  expect(await readFile(file)).toMatchObject({ state: 'read', counts: { added: 5000 } });
}, 120_000);

it('fences a provider run that loses its lease before its reading returns', async () => {
  const { table } = await fixture({ reading: 'ai', identity: null });
  const file = await incoming(table, csv('stale'));
  const waiting = gate(),
    started = gate();
  worker.functions.readWithAi = async () => {
    started.release();
    await waiting.promise;
    return { rows: [outputRow('old')] };
  };
  const claim = (await worker.claim())[0]!;
  const old = worker.run(claim);
  await started.promise;
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'ingest_files')} SET lease_until = now() - interval '1 second' WHERE id = ${file.id}`,
  );
  const replacement = new IngestWorker(server.app, {
    readWithAi: async () => ({ rows: [outputRow('current')] }),
  });
  await replacement.drain();
  waiting.release();
  await old;
  await replacement.close();
  expect((await records(table)).map((row) => row.code)).toEqual(['current']);
  worker.functions = {};
});

it.each([
  ['empty', Buffer.alloc(0), 'empty.csv', 'ingest.extract.empty'],
  ['unopenable', Buffer.from([0, 1, 2, 3, 0, 255]), 'unknown.bin', 'ingest.extract.unclaimed'],
  ['no match', Buffer.from('Other,Value\nx,1'), 'other.csv', 'ingest.questions.unrecognizedFormat'],
  ['missing column', Buffer.from('Code,Other\nx,1'), 'missing.csv', 'ingest.layout.columnMissing'],
  ['no rows', Buffer.from('Code,Amount\n'), 'headings.csv', 'ingest.layout.noRows'],
])('holds %s with a specific reason and writes nothing', async (_name, bytes, name, reason) => {
  const { table } = await fixture();
  const file = await incoming(table, bytes, name);
  await worker.drain();
  expect(await readFile(file)).toMatchObject({ state: 'held', holdReason: reason });
  expect(await records(table)).toEqual([]);
});

it('holds a password-protected original with a standard question and keeps no refused bytes', async () => {
  const { table } = await fixture();
  const bytes = zip([{ name: 'locked.csv', bytes: csv('secret') }], true);
  const file = await incoming(table, bytes, 'locked.zip');
  expect(file).toMatchObject({
    state: 'held',
    holdReason: 'files.checks.passwordProtected',
    storedFile: null,
  });
  expect((await questions(file))[0]!.document.kind).toBe('passwordProtected');
  expect(await records(table)).toEqual([]);
});

it('holds tied formats, offers their IDs as choices, and resumes the chosen format', async () => {
  const { table, context, format } = await fixture();
  const other = await store.createFormat(context, {
    name: 'Other',
    state: 'live',
    probationPassed: 0,
    signature: { ...format.signature, id: 'other' },
    reading: 'layout',
    rules: format.reading === 'layout' ? format.rules : ({} as never),
  });
  const file = await incoming(table, csv('tie'));
  await worker.drain();
  expect(await readFile(file)).toMatchObject({ state: 'held', holdReason: 'ingest.pipeline.formatTie' });
  const question = (await questions(file))[0]!.document;
  expect(question.form).toMatchObject({ choices: [{ id: format.id }, { id: other.id }] });
  await answer(file, question, { type: 'answer', answer: { type: 'choice', value: other.id } });
  await worker.resumeFile(file.id, server.owner.userId);
  await worker.drain();
  expect(await readFile(file)).toMatchObject({ state: 'read', formatId: other.id });
});

it('holds a failed stated total with its check, and notes later aliases and probation', async () => {
  const { table, context, format } = await fixture();
  if (format.reading !== 'layout') throw new Error('layout fixture');
  await store.updateFormat(context, format.id, format.revision, {
    ...format,
    state: 'probation',
    rules: {
      ...format.rules,
      skip: [{ field: 'code', equals: 'Total' }],
      checks: [{ field: 'amount', label: 'Total' }],
    },
  });
  const file = await incoming(table, Buffer.from('Code,Amount\nx,2\nTotal,3'));
  await worker.drain();
  expect(await readFile(file)).toMatchObject({
    state: 'held',
    holdReason: 'ingest.pipeline.totalFailed',
    checks: { layout: [expect.objectContaining({ field: 'amount', label: 'Total', status: 'failed' })] },
  });
  expect(await records(table)).toEqual([]);
  const updated = (await store.readFormat(context, format.id))!;
  if (updated.reading !== 'layout') throw new Error('layout fixture');
  await store.updateFormat(context, format.id, updated.revision, {
    ...updated,
    signature: { ...updated.signature, headerGroups: [['Code', 'Identifier']] },
    rules: { ...updated.rules, header: { markers: ['Identifier'], searchRows: 10 } },
  });
  const drift = await incoming(table, Buffer.from('Identifier,Amount\ny,2\nTotal,2'));
  await worker.drain();
  expect((await readFile(drift)).notes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        messageId: 'ingest.layout.drift',
        params: expect.objectContaining({ field: 'code', actual: 'Identifier' }),
      }),
      { messageId: 'ingest.pipeline.probation' },
    ]),
  );
});

it('writes a field question empty and flagged, fills its answer without reading again, and reuses the answer on reread', async () => {
  const { table, format } = await fixture({ reading: 'ai' });
  const file = await incoming(table, csv('field'));
  let reads = 0;
  worker.functions.readWithAi = async () => {
    reads++;
    const doubt = valueDoubt(file, format, 'amount', { row: 2 }, 'unknown', 'number');
    return { rows: [outputRow('field', 'unknown')], doubts: [doubt] };
  };
  await worker.drain();
  expect(await readFile(file)).toMatchObject({ state: 'held', counts: { added: 1, flagged: 1 } });
  expect(await records(table)).toEqual([expect.objectContaining({ amount: null, needsReview: true })]);
  expect((await records(table))[0]!.reviewNote).not.toContain('ingest.');
  const question = (await questions(file))[0]!.document;
  await answer(file, question, { type: 'answer', answer: { type: 'number', value: '12' } });
  await worker.resumeFile(file.id, server.owner.userId);
  expect(reads).toBe(1);
  expect(await records(table)).toEqual([expect.objectContaining({ amount: 12, needsReview: false })]);
  await worker.resumeFile(file.id, server.owner.userId);
  await worker.drain();
  expect((await questions(file)).map((item) => item.document.id)).toEqual([question.id]);
  expect(await records(table)).toHaveLength(1);
  expect((await readFile(file)).state).toBe('read');
  worker.functions = {};
});

it.each(['keepTable', 'takeFile'])(
  'aggregates file-table differences into one question and applies %s',
  async (choice) => {
    const { table } = await fixture();
    await incoming(table, csv('same', '1'));
    await worker.drain();
    const file = await incoming(table, Buffer.from('Code,Amount\nsame,9\nextra,2'));
    await worker.drain();
    expect(await readFile(file)).toMatchObject({ state: 'held', counts: { added: 1 } });
    const arising = await questions(file);
    expect(arising).toHaveLength(1);
    expect(arising[0]!.document.kind).toBe('fileTableDisagreement');
    expect((await readFile(file)).checks).toMatchObject({ disagreement: { different: 1, fileOnly: 1 } });
    await answer(file, arising[0]!.document, { type: 'answer', answer: { type: 'choice', value: choice } });
    await worker.resumeFile(file.id, server.owner.userId);
    await worker.drain();
    expect((await records(table)).map((row) => row.amount)).toEqual([choice === 'takeFile' ? 9 : 1, 2]);
    expect((await readFile(file)).state).toBe('read');
  },
);

it('fills an existing field after an unknown answer is resolved by one attempt', async () => {
  const { table, format } = await fixture({ reading: 'ai', identity: null });
  const file = await incoming(table, csv('attempt-field'));
  worker.functions.readWithAi = async () => ({
    rows: [outputRow('attempt-field', '?')],
    doubts: [valueDoubt(file, format, 'amount', { row: 2 }, '?', 'number', 'unfamiliarListValue')],
  });
  try {
    await worker.drain();
    const question = (await questions(file))[0]!.document;
    await answer(file, question, { type: 'unknown' });
    const attempt = vi.fn(async (): Promise<QuestionResponse> => ({
      type: 'answer',
      answer: { type: 'number', value: '7' },
    }));
    worker.functions.attemptOnce = attempt;
    await worker.resumeFile(file.id, server.owner.userId);
    await worker.drain();
    expect(await records(table)).toEqual([
      expect.objectContaining({ amount: 7, needsReview: false, reviewNote: null }),
    ]);
    expect(await readFile(file)).toMatchObject({ state: 'read', counts: { added: 1, flagged: 0 } });
    await worker.resumeFile(file.id, server.owner.userId);
    await worker.drain();
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(await records(table)).toHaveLength(1);
  } finally {
    worker.functions = {};
  }
});

it.each(['source', 'destination', 'both'] as const)(
  'collects explicit selections for repeated %s identities in one aggregate question',
  async (repeated) => {
    const { table, context } = await fixture({ identity: null });
    if (repeated !== 'source') {
      await incoming(table, Buffer.from('Code,Amount\nsame,1\nsame,2'));
      await worker.drain();
    }
    await store.changeSettings(context, table.ingest!.revision, { ...table.ingest!, identity: ['code'] });
    const live = (await loadTable(server.pool, server.schemas, table.id))!;
    const file = await incoming(
      live,
      Buffer.from(
        repeated === 'destination' ? 'Code,Amount\nsame,9\nextra,3' : 'Code,Amount\nsame,9\nsame,7\nextra,3',
      ),
    );
    await worker.drain();
    const arising = await questions(file);
    expect(arising).toHaveLength(1);
    expect(arising[0]!.document.form).toMatchObject({
      type: 'choices',
      selections: [
        expect.objectContaining({
          identity: expect.any(String),
          rows: repeated === 'destination' ? [0] : [0, 1],
          recordIds: repeated === 'source' ? [] : [expect.any(String), expect.any(String)],
        }),
      ],
    });
    const question = arising[0]!.document;
    if (question.form.type !== 'choices') throw new Error('disagreement fixture');
    const group = question.form.selections![0]!;
    const respond = (selections: Extract<QuestionResponse, { type: 'answer' }>['answer']) =>
      worker.store.decisions.answerQuestion(
        { ...file, userId: server.owner.userId, canEditRecords: true, canEditSchema: true },
        {
          questionId: question.id,
          questionVersion: question.version,
          response: { type: 'answer', answer: selections },
        },
      );
    await expect(respond({ type: 'choice', value: 'takeFile' })).rejects.toMatchObject({
      messageKey: 'ingest.decisions.invalidAnswer',
    });
    await expect(
      respond({
        type: 'choice',
        value: 'takeFile',
        selections: [
          {
            identity: group.identity,
            row: 99,
            recordId: 'missing',
          },
        ],
      }),
    ).rejects.toMatchObject({ messageKey: 'ingest.decisions.invalidAnswer' });
    await answer(file, question, {
      type: 'answer',
      answer: {
        type: 'choice',
        value: 'takeFile',
        selections: [
          {
            identity: group.identity,
            ...(repeated !== 'destination' ? { row: 1 } : {}),
            ...(repeated !== 'source' ? { recordId: group.recordIds[1]! } : {}),
          },
        ],
      },
    });
    await worker.resumeFile(file.id, server.owner.userId);
    await worker.drain();
    expect((await records(table)).map((record) => record.amount)).toEqual(
      repeated === 'source' ? [3, 7] : [1, repeated === 'destination' ? 9 : 7, 3],
    );
    expect(await readFile(file)).toMatchObject({
      state: 'read',
      counts: { added: repeated === 'source' ? 2 : 1 },
    });
    expect(await questions(file)).toHaveLength(1);
    await worker.resumeFile(file.id, server.owner.userId);
    await worker.drain();
    expect(await records(table)).toHaveLength(repeated === 'source' ? 2 : 3);
  },
);

it.each(['resumed', 'cached'] as const)(
  'holds a %s reading after its format becomes failing',
  async (mode) => {
    const { table, context, format } = await fixture({ reading: 'ai' });
    const file = await incoming(table, csv(`failing-${mode}`));
    const reading = vi.fn(async () => ({
      rows: [outputRow(`failing-${mode}`, mode === 'cached' ? '?' : 1)],
      ...(mode === 'cached'
        ? {
            doubts: [valueDoubt(file, format, 'amount', { row: 2 }, '?', 'number', 'unfamiliarListValue')],
          }
        : {}),
    }));
    worker.functions.readWithAi = reading;
    try {
      await worker.drain();
      if (mode === 'cached') {
        await answer(file, (await questions(file))[0]!.document, { type: 'unknown' });
        worker.functions.attemptOnce = async () => {
          throw new TryLaterError();
        };
        await worker.resumeFile(file.id, server.owner.userId);
        await worker.drain();
        expect((await readFile(file)).state).toBe('waiting');
        worker.functions.attemptOnce = async () => ({
          type: 'answer',
          answer: { type: 'number', value: '7' },
        });
      }
      await store.updateFormat(context, format.id, format.revision, { ...format, state: 'failing' });
      const before = reading.mock.calls.length;
      if (mode === 'resumed') await worker.resumeFile(file.id, server.owner.userId);
      await worker.drain(new Date(Date.now() + 60_000));
      expect(await readFile(file)).toMatchObject({
        state: 'held',
        formatId: null,
        holdReason: 'ingest.questions.unrecognizedFormat',
      });
      expect(reading).toHaveBeenCalledTimes(before);
    } finally {
      worker.functions = {};
    }
  },
);

it('holds only a row group, writes the rest, and releases the group on resume without adding prior rows twice', async () => {
  const { table } = await fixture({ reading: 'ai', identity: null });
  const file = await incoming(table, csv('groups'));
  const definition = kind('repeatedRowKey');
  const question = createQuestion(definition, {
    key: `${file.id}:group`,
    values: [],
    evidence: [{ file: file.id, examples: [] }],
    form: { type: 'choices', choices: [{ id: 'include', messageId: 'ingest.pipeline.takeFile' }] },
    target: { type: 'rows', file: file.id, rows: [{ row: 2 }] },
    exits: ['removeRow', 'skipFile'],
  });
  let reads = 0;
  worker.functions.readWithAi = async () => {
    reads++;
    return {
      rows: [outputRow('held', 1, 2), outputRow('landed', 2, 3)],
      doubts: [{ item: { kind: definition, inputs: {} }, question }],
    };
  };
  await worker.drain();
  expect((await records(table)).map((row) => row.code)).toEqual(['landed']);
  await answer(file, question, { type: 'answer', answer: { type: 'choice', value: 'include' } });
  await worker.resumeFile(file.id, server.owner.userId);
  await worker.drain();
  expect((await records(table)).map((row) => row.code)).toEqual(['landed', 'held']);
  expect(reads).toBe(2);
  expect((await readFile(file)).state).toBe('read');
  worker.functions = {};
});

it.each(['studyUnknown', 'readWithAi', 'attemptOnce'] as const)(
  'waits with backoff when %s throws try later, then succeeds when it recovers',
  async (callback) => {
    const { table, context, format } = await fixture({
      reading: callback === 'studyUnknown' ? 'layout' : 'ai',
    });
    if (callback === 'studyUnknown')
      await store.updateFormat(context, format.id, format.revision, {
        ...format,
        signature: { ...format.signature, markers: ['absent'] },
      });
    const file = await incoming(table, csv(callback));
    let available = false;
    if (callback === 'studyUnknown')
      worker.functions.studyUnknown = async () => {
        if (!available) throw new TryLaterError();
        return format;
      };
    if (callback === 'readWithAi')
      worker.functions.readWithAi = async () => {
        if (!available) throw new Error('try later');
        return { rows: [outputRow(callback)] };
      };
    if (callback === 'attemptOnce') {
      const doubt = valueDoubt(file, format, 'amount', { row: 2 }, '?', 'number', 'unfamiliarListValue');
      worker.functions.readWithAi = async () => ({ rows: [outputRow(callback, '?')], doubts: [doubt] });
      await worker.drain();
      await answer(file, (await questions(file))[0]!.document, { type: 'unknown' });
      await worker.resumeFile(file.id, server.owner.userId);
      worker.functions.attemptOnce = async () => {
        if (!available) throw new TryLaterError();
        return { type: 'answer', answer: { type: 'number', value: '3' } };
      };
    }
    await worker.drain();
    expect(await readFile(file)).toMatchObject({ state: 'waiting', nextAttemptAt: expect.any(String) });
    expect(Date.parse((await readFile(file)).nextAttemptAt!)).toBeGreaterThan(Date.now());
    available = true;
    await worker.drain(new Date(Date.now() + 60_000));
    expect(await readFile(file)).toMatchObject({ state: 'read' });
    expect(await records(table)).toHaveLength(1);
    worker.functions = {};
  },
);

it.each(['valueFromSender', 'valueFromAnyone', 'format', 'sender', 'table'] as const)(
  'uses a remembered %s rule on a later file without raising a question',
  async (scopeType) => {
    const { table, context, format } = await fixture({ reading: 'ai' });
    const sender = await store.createSender(context, {
      kind: 'address',
      value: 'sender@example.test',
      label: 'Sender',
      approved: true,
    });
    const senderIdentity = { id: sender.id, kind: sender.kind, value: sender.value };
    let current: IngestFile;
    worker.functions.readWithAi = async () => ({
      rows: [outputRow(current.name, '?')],
      doubts: [valueDoubt(current, format, 'amount', { row: 2 }, '?', 'number', 'unfamiliarListValue')],
    });
    current = await incoming(table, csv('first'), 'first.csv');
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'ingest_files')} SET sender_id = ${sender.id} WHERE id = ${current.id}`,
    );
    await worker.drain();
    const question = (await questions(current))[0]!.document;
    const accepted = await answer(current, question, {
      type: 'answer',
      answer: { type: 'number', value: '8' },
    });
    if (accepted.status !== 'accepted') throw new Error('answer fixture');
    const scope: RuleScope =
      scopeType === 'valueFromSender'
        ? { type: scopeType, value: '?', sender: senderIdentity }
        : scopeType === 'valueFromAnyone'
          ? { type: scopeType, value: '?' }
          : scopeType === 'format'
            ? { type: scopeType, format: format.id }
            : scopeType === 'sender'
              ? { type: scopeType, sender: senderIdentity }
              : { type: 'table' };
    await worker.store.decisions.rememberAnswer(
      { ...current, userId: server.owner.userId, canEditRecords: true, canEditSchema: true },
      accepted.answer.id,
      valueDoubt(current, format, 'amount', { row: 2 }, '?', 'number', 'unfamiliarListValue').item.kind,
      scope,
      { eq: { input: 'text', value: { type: 'text', value: '?' } } },
    );
    current = await incoming(table, csv('later'), 'later.csv');
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'ingest_files')} SET sender_id = ${sender.id} WHERE id = ${current.id}`,
    );
    await worker.drain();
    expect((await readFile(current)).state).toBe('read');
    expect(await questions(current)).toEqual([]);
    expect((await records(table)).find((row) => row.code === 'later.csv')?.amount).toBe(8);
    worker.functions = {};
  },
);

it('retains a scanner outage in quarantine, waits, and checks again before extracting', async () => {
  const { table } = await fixture();
  const scan = vi
    .spyOn(safety, 'checkFileSafety')
    .mockResolvedValueOnce({ state: 'held', type: 'text/csv', reason: 'files.checks.scannerUnavailable' });
  let file: IngestFile;
  try {
    file = await incoming(table, csv('scan'));
  } finally {
    scan.mockRestore();
  }
  expect(file!).toMatchObject({
    state: 'waiting',
    storedFile: expect.any(String),
    holdReason: 'files.checks.scannerUnavailable',
  });
  const stored = await query<{ scan_state: string }>(
    server.pool,
    sql`SELECT scan_state FROM ${ident(server.schemas.app, 'files')} WHERE id = ${file!.storedFile}`,
  );
  expect(stored.rows[0]!.scan_state).toBe('unavailable');
  expect(await records(table)).toEqual([]);
  const outage = vi
    .spyOn(safety, 'checkFileSafety')
    .mockResolvedValue({ state: 'held', type: 'text/csv', reason: 'files.checks.scannerUnavailable' });
  try {
    await worker.drain(new Date(Date.now() + 60_000));
  } finally {
    outage.mockRestore();
  }
  const waiting = await readFile(file!);
  expect(waiting.state).toBe('waiting');
  await worker.drain(new Date(Date.parse(waiting.nextAttemptAt!) + 1));
  expect((await readFile(file!)).state).toBe('read');
  expect(await records(table)).toHaveLength(1);
});

it('reads a newly studied format on probation without activating it', async () => {
  const { table, context, format } = await fixture();
  if (format.reading !== 'layout') throw new Error('layout fixture');
  await store.updateFormat(context, format.id, format.revision, {
    ...format,
    signature: { ...format.signature, markers: ['absent'] },
  });
  worker.functions.studyUnknown = async () => ({
    name: 'Studied',
    state: 'live',
    probationPassed: 0,
    reading: 'layout',
    rules: format.rules,
    signature: { ...format.signature, id: 'studied' },
  });
  const file = await incoming(table, csv('studied'));
  await worker.drain();
  const read = await readFile(file);
  expect(read.state).toBe('read');
  expect(read.notes).toContainEqual({ messageId: 'ingest.pipeline.probation' });
  expect((await store.readFormat(context, read.formatId!))!.state).toBe('probation');
  expect(await records(table)).toHaveLength(1);
  worker.functions = {};
});

it('holds undeclared output columns until a person maps or discards them', async () => {
  const { table } = await fixture({ reading: 'ai' });
  const file = await incoming(table, csv('columns'));
  worker.functions.readWithAi = async () => ({
    rows: [
      {
        values: { code: 'columns', amount: null, incomingAmount: '7', unused: 'detail' },
        at: { row: 2 },
        raw: {},
      },
    ],
  });
  await worker.drain();
  expect((await readFile(file)).state).toBe('held');
  expect(await records(table)).toEqual([]);
  const question = (await questions(file))[0]!.document;
  expect(question.kind).toBe('unknownColumn');
  await answer(file, question, {
    type: 'answer',
    answer: {
      type: 'mapping',
      value: [
        { heading: 'incomingAmount', field: 'amount' },
        { heading: 'unused', field: null },
      ],
    },
  });
  await worker.resumeFile(file.id, server.owner.userId);
  await worker.drain();
  expect((await readFile(file)).state).toBe('read');
  expect(await records(table)).toEqual([expect.objectContaining({ code: 'columns', amount: 7 })]);
  worker.functions = {};
});

it('fills a field-level rule conflict with the selected rule answer without rereading', async () => {
  const { table, format } = await fixture({ reading: 'ai' });
  const file = await incoming(table, csv('conflict'));
  let reads = 0;
  worker.functions.readWithAi = async () => {
    reads++;
    const doubt = valueDoubt(file, format, 'amount', { row: 2 }, '?', 'number', 'unfamiliarListValue');
    doubt.builtIns = ['7', '8'].map((value) => ({
      id: value,
      kind: doubt.item.kind.id,
      scope: { type: 'table' },
      condition: { eq: { input: 'text', value: { type: 'text', value: '?' } } },
      answer: { type: 'number', value },
      source: 'file',
    }));
    return { rows: [outputRow('conflict', '?')], doubts: [doubt] };
  };
  await worker.drain();
  const question = (await questions(file))[0]!.document;
  expect(question.kind).toBe('ruleConflict');
  if (question.form.type !== 'choices') throw new Error('conflict fixture');
  const selected = question.form.choices.find(
    (choice) => choice.answer?.type === 'number' && choice.answer.value === '8',
  )!;
  await answer(file, question, { type: 'answer', answer: { type: 'choice', value: selected.id } });
  await worker.resumeFile(file.id, server.owner.userId);
  expect(reads).toBe(1);
  expect(await records(table)).toEqual([expect.objectContaining({ amount: 8, needsReview: false })]);
  expect((await readFile(file)).state).toBe('read');
  worker.functions = {};
});

it('retains file-check notes and verdicts when reporting a successful reading', async () => {
  const { table } = await fixture();
  const checked = vi
    .spyOn(safety, 'checkFileSafety')
    .mockResolvedValueOnce({ state: 'noted', type: 'text/csv', notes: ['files.checks.macrosAllowed'] });
  let file: IngestFile;
  try {
    file = await incoming(table, csv('noted'));
  } finally {
    checked.mockRestore();
  }
  await worker.drain();
  expect(await readFile(file!)).toMatchObject({
    state: 'read',
    notes: expect.arrayContaining([{ messageId: 'files.checks.macrosAllowed' }]),
    checks: { originalSafety: { state: 'noted', notes: ['files.checks.macrosAllowed'] } },
  });
  expect(await records(table)).toHaveLength(1);
});

it('fills an explicit field answer while a table is paused without reading arrivals', async () => {
  const { table, context, format } = await fixture({ reading: 'ai' });
  const file = await incoming(table, csv('paused-answer'));
  let reads = 0;
  worker.functions.readWithAi = async () => {
    reads++;
    return {
      rows: [outputRow('paused-answer', '?')],
      doubts: [valueDoubt(file, format, 'amount', { row: 2 }, '?', 'number')],
    };
  };
  await worker.drain();
  const question = (await questions(file))[0]!.document;
  await store.changeSettings(context, table.ingest!.revision, { ...table.ingest!, state: 'paused' });
  await answer(file, question, { type: 'answer', answer: { type: 'number', value: '2' } });
  await worker.resumeFile(file.id, server.owner.userId);
  expect(reads).toBe(1);
  expect(await records(table)).toEqual([expect.objectContaining({ amount: 2, needsReview: false })]);
  expect((await readFile(file)).state).toBe('read');
  const waiting = await incoming(table, csv('still-waiting'));
  await worker.drain();
  expect((await readFile(waiting)).state).toBe('waiting');
  expect(reads).toBe(1);
  worker.functions = {};
});

it('reads a known email body and its attachments without dropping the body rows', async () => {
  const { table, context } = await fixture();
  await store.createFormat(context, {
    name: 'Email body',
    state: 'live',
    probationPassed: 0,
    signature: { id: 'email-body', kind: 'email', headerGroups: [], markers: ['body-record'] },
    reading: 'reader',
    rules: {
      toolkitVersion: '1',
      code: 'const mail = await source.email(); await emit([{ values: { code: mail.tables[0][1][0], amount: mail.tables[0][1][1] }, at: { table: 1, row: 2 }, raw: {} }]);',
    },
  });
  const bytes = Buffer.from(
    [
      'From: sender@example.test',
      'To: receiver@example.test',
      'Subject: Data',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="body-parts"',
      '',
      '--body-parts',
      'Content-Type: text/html',
      '',
      '<table><tr><th>Code</th><th>Amount</th></tr><tr><td>body-record</td><td>3</td></tr></table>',
      '--body-parts',
      'Content-Type: text/csv',
      'Content-Disposition: attachment; filename="attached.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      csv('attached-record').toString('base64'),
      '--body-parts--',
      '',
    ].join('\r\n'),
  );
  const file = await incoming(table, bytes, 'body.eml');
  await worker.drain();
  expect(await readFile(file)).toMatchObject({ state: 'read', counts: { added: 1 } });
  expect((await records(table)).map((row) => row.code)).toEqual(['body-record', 'attached-record']);
});

it('holds a declined reading and never substitutes guessed rows', async () => {
  const { table } = await fixture({ reading: 'ai' });
  const file = await incoming(table, csv('decline'));
  worker.functions.readWithAi = async () => null;
  await worker.drain();
  expect(await readFile(file)).toMatchObject({
    state: 'held',
    holdReason: 'ingest.pipeline.readerUnavailable',
  });
  expect(await records(table)).toEqual([]);
  worker.functions = {};
});

it('runs reader code through the sandbox with lookup lists and saved file facts', async () => {
  const { table, context, format } = await fixture({ reading: 'reader' });
  await store.updateFormat(context, format.id, format.revision, {
    ...format,
    reading: 'reader',
    rules: {
      code: 'await emit([{values: {code: "reader", amount: 4}, at: {row: 2}, raw: {}}]); await check("amount", 4, 4);',
      toolkitVersion: '1',
    },
  });
  const file = await incoming(table, csv('reader'));
  await worker.drain();
  expect(await readFile(file)).toMatchObject({ state: 'read' });
  expect(await records(table)).toEqual([expect.objectContaining({ code: 'reader', amount: 4 })]);
});

it('extracts three zip parts and two email attachments into their own arrivals', async () => {
  const { table } = await fixture();
  const archive = await incoming(
    table,
    zip(['one', 'two', 'three'].map((code) => ({ name: `${code}.csv`, bytes: csv(code) }))),
    'batch.zip',
  );
  const boundary = 'parts-boundary';
  const email = Buffer.from(
    [
      'From: sender@example.test',
      'To: receiver@example.test',
      'Subject: Files',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain',
      '',
      'Attachments follow.',
      ...['four', 'five'].flatMap((code) => [
        `--${boundary}`,
        'Content-Type: text/csv',
        `Content-Disposition: attachment; filename="${code}.csv"`,
        'Content-Transfer-Encoding: base64',
        '',
        csv(code).toString('base64'),
      ]),
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  );
  const mail = await incoming(table, email, 'message.eml');
  await worker.drain();
  const children = (await store.listFiles(archive)).filter((file) => file.origin === 'part');
  expect(children).toHaveLength(5);
  expect(children.filter((file) => file.parentId === archive.id)).toHaveLength(3);
  expect(children.filter((file) => file.parentId === mail.id)).toHaveLength(2);
  expect(children.every((file) => file.state === 'read')).toBe(true);
  expect((await records(table)).map((row) => row.code)).toEqual(['one', 'two', 'three', 'four', 'five']);
});

it('leaves paused and excess files waiting, and holds an archive beyond the part limit', async () => {
  const { table, context } = await fixture();
  await store.changeSettings(context, table.ingest!.revision, { ...table.ingest!, state: 'paused' });
  const file = await incoming(table, csv('pause'));
  await worker.drain();
  expect((await readFile(file)).state).toBe('waiting');
  const paused = (await loadTable(server.pool, server.schemas, table.id))!;
  await store.changeSettings(context, paused.ingest!.revision, { ...paused.ingest!, state: 'live' });
  await worker.drain();
  expect((await readFile(file)).state).toBe('read');
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'ingest_pipeline_jobs')} (org_id, table_id, file_id, run_id, started_at)
    SELECT org_id, table_id, id, id, now() FROM ${ident(server.schemas.app, 'ingest_files')} WHERE table_id = ${table.id}
    ON CONFLICT (org_id, table_id, file_id) DO UPDATE SET started_at = now()`,
  );
  for (let index = 0; index < 59; index++) {
    const extra = await store.createFile(context, {
      origin: 'drop',
      name: 'previous.csv',
      mediaType: 'text/csv',
      sizeBytes: 0,
      sha256: 'a'.repeat(64),
      storedFile: null,
    });
    await store.updateFile(context, extra.id, { state: 'skipped' });
    await worker.store.job(server.pool, extra);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'ingest_pipeline_jobs')} SET started_at = now() WHERE file_id = ${extra.id}`,
    );
  }
  const excess = await incoming(table, csv('excess'));
  const other = await fixture();
  const archive = await incoming(
    other.table,
    zip(Array.from({ length: 26 }, (_, index) => ({ name: `${index}.csv`, bytes: csv(String(index)) }))),
    'many.zip',
  );
  await worker.drain();
  expect(await readFile(excess)).toMatchObject({
    state: 'waiting',
    holdReason: 'ingest.pipeline.hourlyLimit',
    nextAttemptAt: expect.any(String),
  });
  expect(await readFile(archive)).toMatchObject({ state: 'held', holdReason: 'ingest.pipeline.partLimit' });
  expect((await store.listFiles(archive)).filter((item) => item.origin === 'part')).toHaveLength(0);
});

it('pauses a table once after its owner loses write access and notifies the owner and schema holders', async () => {
  const member = await server.addMember();
  const { table } = await fixture({ ownerId: member.userId });
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${table.orgId}, 'database', ${table.databaseId}, 'user', ${member.userId}, 'editor')`,
  );
  await incoming(table, csv('lost'));
  await query(
    server.pool,
    sql`DELETE FROM ${ident(server.schemas.app, 'grants')} WHERE resource_id = ${table.databaseId} AND principal_id = ${member.userId}`,
  );
  await worker.drain();
  await worker.drain();
  expect((await loadTable(server.pool, server.schemas, table.id))!.ingest!.state).toBe('paused');
  const notes = await query<{ recipient_id: string }>(
    server.pool,
    sql`SELECT recipient_id FROM ${ident(server.schemas.app, 'notifications')}
    WHERE subject_id = ${table.id} AND kind = 'ingest.paused'`,
  );
  expect(notes.rows.map((row) => row.recipient_id).sort()).toEqual(
    [server.owner.userId, member.userId].sort(),
  );
  expect(await records(table)).toEqual([]);
});

it('requires edit rights for file controls, refuses expired originals, and permits skipping them', async () => {
  const { table } = await fixture();
  const file = await incoming(table, csv('expire'));
  const stranger = await server.addMember();
  await expect(worker.skipFile(file.id, stranger.userId)).rejects.toBeInstanceOf(Error);
  await store.updateFile({ ...file, userId: server.owner.userId }, file.id, {
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    state: 'held',
  });
  await expect(worker.resumeFile(file.id, server.owner.userId)).rejects.toMatchObject({
    messageKey: 'ingest.pipeline.originalExpired',
  });
  expect(await worker.skipFile(file.id, server.owner.userId)).toMatchObject({ state: 'skipped' });
  const failed = await incoming(table, csv('retry'));
  await store.updateFile({ ...failed, userId: null }, failed.id, { state: 'reading' });
  await store.updateFile({ ...failed, userId: null }, failed.id, { state: 'failed' });
  await worker.retryFile(failed.id, server.owner.userId);
  await worker.drain();
  expect((await readFile(failed)).state).toBe('read');
});

it('sends at most one file notice and one notice per question without placing row values in any body', async () => {
  const { table, format } = await fixture({ reading: 'ai' });
  const marker = 'private-row-value-84723';
  const file = await incoming(table, csv(marker));
  worker.functions.readWithAi = async () => ({
    rows: [outputRow(marker, '?')],
    doubts: [valueDoubt(file, format, 'amount', { row: 2 }, marker, 'number')],
  });
  await worker.drain();
  await worker.resumeFile(file.id, server.owner.userId);
  await worker.drain();
  const notes = await query<{ subject_id: string; kind: string; target: unknown }>(
    server.pool,
    sql`SELECT subject_id, kind, target FROM ${ident(server.schemas.app, 'notifications')}
    WHERE target->>'tableId' = ${table.id} AND kind LIKE 'ingest.%'`,
  );
  expect(notes.rows.filter((note) => note.subject_id === file.id)).toHaveLength(1);
  expect(notes.rows.filter((note) => note.kind === 'ingest.question')).toHaveLength(1);
  expect(JSON.stringify(notes.rows)).not.toContain(marker);
  worker.functions = {};
});

it('recovers unrelated files when an expired lease belongs to a trashed table', async () => {
  const abandoned = new IngestWorker(server.app);
  const trashed = await fixture();
  const expired = await incoming(trashed.table, csv('trashed'), 'trashed.csv', abandoned);
  const [claim] = await abandoned.claim();
  expect(claim!.file.id).toBe(expired.id);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'tables')}
    SET trashed_at = now() WHERE id = ${trashed.table.id}`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'ingest_files')}
    SET lease_until = now() - interval '1 second' WHERE id = ${expired.id}`,
  );
  const unrelated = await fixture();
  const next = await incoming(unrelated.table, csv('unrelated'));
  await worker.drain();
  expect((await readFile(next)).state).toBe('read');
  expect(await records(unrelated.table)).toEqual([expect.objectContaining({ code: 'unrelated' })]);
  await abandoned.close();
});

/** Stored members include valid checksums, so both safety and extraction inspect these generated containers. */
function zip(parts: Array<{ name: string; bytes: Buffer }>, encrypted = false): Buffer {
  const records: Buffer[] = [],
    catalog: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name);
    let crc = 0xffffffff;
    for (const byte of part.bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(encrypted ? 1 : 0, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(part.bytes.length, 18);
    local.writeUInt32LE(part.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(encrypted ? 1 : 0, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(part.bytes.length, 20);
    central.writeUInt32LE(part.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    records.push(local, name, part.bytes);
    catalog.push(central, name);
    offset += local.length + name.length + part.bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(
    catalog.reduce((size, entry) => size + entry.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, ...catalog, end]);
}

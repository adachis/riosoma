import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, migrate } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import {
  STANDARD_QUESTIONS,
  createQuestion,
  decide,
  type DecisionItem,
  type DecisionQuestion,
} from '@riosoma/ingest';
import { MIGRATIONS } from '../../migrations/index.js';
import { demoIngestDecisions } from '../../demo/metadata.js';
import { DecisionStore, type DecisionPermissions } from './store.js';

let kit: TestPostgres;
let database: Awaited<ReturnType<TestPostgres['createDatabase']>>;
let pool: pg.Pool;
let store: DecisionStore;
const schemas = { app: 'decisions_app', data: 'decisions_data', audit: 'decisions_audit' };
const kind = STANDARD_QUESTIONS.find((entry) => entry.id === 'unfamiliarListValue')!;
const sender = { id: 'approved-sender', kind: 'address' as const, value: 'sender@example.test' };
const item: DecisionItem = {
  kind,
  inputs: { text: { type: 'text', value: 'West' } },
  sender,
  value: 'West',
  format: 'layout',
};
const owner: DecisionPermissions = {
  orgId: 'o1',
  tableId: 't1',
  userId: 'u1',
  canEditRecords: true,
  canEditSchema: true,
};
const foreign: DecisionPermissions = { ...owner, orgId: 'o2', tableId: 't2', userId: 'u2' };
const makeQuestion = (examples = ['West']): DecisionQuestion =>
  createQuestion(
    kind,
    {
      key: 'territory',
      values: [{ type: 'text', value: 'West' }],
      form: {
        type: 'choices',
        choices: [
          { id: 'west', messageId: 'test.west' },
          { id: 'east', messageId: 'test.east' },
        ],
      },
      evidence: [{ file: 'file', sheet: 'Regions', row: 2, column: 'B', examples }],
      target: {
        type: 'field',
        file: 'file',
        rows: [
          { sheet: 'Regions', row: 2 },
          { sheet: 'Regions', row: 7 },
        ],
        field: 'territory',
      },
      exits: ['removeRow', 'skipFile'],
    },
    { sender, format: 'layout', value: 'West' },
  );
const response = (question: DecisionQuestion) => ({
  questionId: question.id,
  questionVersion: question.version,
  response: { type: 'answer' as const, answer: { type: 'choice' as const, value: 'west' } },
});
const scope = { type: 'valueFromSender' as const, value: 'West', sender };
const condition = { present: 'text' as const };
// This historical upgrade exercises the migrations that supported late arrival.  Later ones follow in order.
const historicalMigrations = MIGRATIONS.filter((migration) => migration.id < '0142');

beforeAll(async () => {
  kit = await startTestPostgres();
  database = await kit.createDatabase('decisions');
  pool = createPool({ ...database.profile, schemas });
  // Apply the shipped schema first, including later-numbered migrations, to prove an out-of-order upgrade.
  await migrate(
    pool,
    schemas,
    historicalMigrations.filter((migration) => migration.id !== '0136_ingest_decisions'),
  );
  await pool.query(`INSERT INTO ${schemas.app}.orgs (id, name) VALUES ('o1', 'One'), ('o2', 'Two');
    INSERT INTO ${schemas.app}.users (id, email) VALUES ('u1', 'one@example.test'), ('u2', 'two@example.test');
    INSERT INTO ${schemas.app}.databases (id, org_id, name) VALUES ('d1', 'o1', 'One'), ('d2', 'o2', 'Two');
    INSERT INTO ${schemas.app}.tables (id, org_id, database_id, name, primary_field_id, position)
    VALUES ('t1', 'o1', 'd1', 'One', 'f1', 1), ('t2', 'o2', 'd2', 'Two', 'f2', 1);`);
  const prior = await pool.query(`SELECT id, checksum FROM ${schemas.app}.schema_migrations ORDER BY id`);
  expect((await migrate(pool, schemas, historicalMigrations)).applied).toEqual(['0136_ingest_decisions']);
  expect(
    (
      await pool.query(
        `SELECT id, checksum FROM ${schemas.app}.schema_migrations WHERE id <> '0136_ingest_decisions' ORDER BY id`,
      )
    ).rows,
  ).toEqual(prior.rows);
  expect((await pool.query(`SELECT id, org_id, name FROM ${schemas.app}.tables ORDER BY id`)).rows).toEqual([
    { id: 't1', org_id: 'o1', name: 'One' },
    { id: 't2', org_id: 'o2', name: 'Two' },
  ]);
  expect((await migrate(pool, schemas, historicalMigrations)).applied).toEqual([]);
  expect((await migrate(pool, schemas, MIGRATIONS)).applied).toEqual(
    MIGRATIONS.filter((migration) => migration.id >= '0142').map((migration) => migration.id),
  );
  store = new DecisionStore(pool, schemas);
}, 120_000);

beforeEach(async () => {
  await pool.query(`DELETE FROM ${schemas.app}.ingest_rules;
    DELETE FROM ${schemas.app}.ingest_answers;
    DELETE FROM ${schemas.app}.ingest_questions;`);
});
afterAll(async () => {
  await pool?.end();
  await database?.drop();
  await kit?.stop();
});

async function seed(context = owner) {
  const question = await store.raiseQuestion(context, makeQuestion());
  const result = await store.answerQuestion(context, response(question));
  if (result.status !== 'accepted') throw new Error('Expected accepted answer');
  const rule = await store.rememberAnswer(context, result.answer.id, kind, scope, condition);
  return { question, answer: result.answer, rule };
}

async function events(context: DecisionPermissions) {
  return (
    await pool.query(
      `SELECT action, metadata FROM ${schemas.audit}.events
    WHERE org_id = $1 AND metadata->>'tableId' = $2 AND action LIKE 'data.ingest.%' ORDER BY chain_seq`,
      [context.orgId, context.tableId],
    )
  ).rows;
}

describe('decision storage without a configured provider', () => {
  it('finds a repeated question and its existing answer without duplicating the question', async () => {
    const saved = await seed();
    const reread = await store.raiseQuestion(owner, makeQuestion());
    expect(reread).toEqual(saved.question);
    expect(await store.raiseQuestion(owner, reread)).toEqual(saved.question);
    expect(await store.findAnswer(owner, reread.id)).toEqual(saved.answer);
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM ${schemas.app}.ingest_questions`)).rows[0].n,
    ).toBe(1);
    expect(
      decide({
        item,
        key: 'territory',
        target: reread.target,
        attempt: 'unused',
        rules: await store.findRules(owner, item),
        question: reread,
      }),
    ).toMatchObject({ status: 'decided', ruleId: saved.rule.id });
  });
  it.each([
    ['another sender', 'file', { ...sender, id: 'other-sender', value: 'other@example.test' }],
    ['another file', 'other-file', sender],
    ['a file with no sender', 'file', undefined],
  ])('requires a remembered rule to reuse an answer for %s', async (_label, file, nextSender) => {
    const original = await store.raiseQuestion(owner, makeQuestion());
    const answered = await store.answerQuestion(owner, response(original));
    if (answered.status !== 'accepted') throw new Error('Expected accepted answer');
    expect(await store.listRules(owner)).toEqual([]);
    const next = createQuestion(
      kind,
      {
        ...makeQuestion(),
        target: { ...original.target, file },
        evidence: original.evidence.map((entry) => ({ ...entry, file })),
      },
      { sender: nextSender, format: 'layout', value: 'West' },
    );
    const raised = await store.raiseQuestion(owner, next);
    expect(raised.id).toBe(original.id);
    const nextItem = { ...item, sender: nextSender };
    const decideNext = async () =>
      decide({
        item: nextItem,
        key: 'territory',
        target: raised.target,
        attempt: 'unused',
        rules: await store.findRules(owner, nextItem),
        question: raised,
        answer: (await store.findAnswer(owner, raised.id)) ?? undefined,
      });
    expect(await decideNext()).toMatchObject({ status: 'ask', question: raised });
    expect(await store.findAnswer(owner, raised.id)).toBeNull();
    const editor = { ...owner, canEditSchema: false };
    await expect(
      store.rememberAnswer(
        editor,
        answered.answer.id,
        kind,
        { type: 'valueFromAnyone', value: 'West' },
        condition,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const remembered = await store.rememberAnswer(
      owner,
      answered.answer.id,
      kind,
      { type: 'valueFromAnyone', value: 'West' },
      condition,
    );
    expect(await decideNext()).toMatchObject({ status: 'decided', ruleId: remembered.id });
    await store.raiseQuestion(owner, original);
    expect(await store.findAnswer(owner, original.id)).toEqual(answered.answer);
  });
  it('reuses one-time answers on rereads with changed row evidence and keeps each context’s history', async () => {
    const original = await store.raiseQuestion(owner, makeQuestion());
    const answered = await store.answerQuestion(owner, response(original));
    if (answered.status !== 'accepted') throw new Error('Expected accepted answer');
    const reread = createQuestion(
      kind,
      {
        ...makeQuestion(['West', 'West']),
        target: { type: 'field', file: 'file', field: 'territory', rows: [{ sheet: 'Regions', row: 9 }] },
      },
      original.scopeContext,
    );
    expect(reread.id).toBe(original.id);
    expect(reread.version).not.toBe(original.version);
    await store.raiseQuestion(owner, reread);
    expect(await store.findAnswer(owner, reread.id)).toEqual(answered.answer);
    expect(await store.answerQuestion(owner, response(original))).toMatchObject({ status: 'stale' });
    const other = createQuestion(
      kind,
      { ...makeQuestion(), target: { ...original.target, file: 'other-file' } },
      original.scopeContext,
    );
    await store.raiseQuestion(owner, other);
    const otherAnswer = await store.answerQuestion(owner, {
      ...response(other),
      response: { type: 'answer', answer: { type: 'choice', value: 'east' } },
    });
    if (otherAnswer.status !== 'accepted') throw new Error('Expected accepted answer');
    expect(await store.findAnswer(owner, other.id)).toEqual(otherAnswer.answer);
    await store.raiseQuestion(owner, reread);
    expect(await store.findAnswer(owner, reread.id)).toEqual(answered.answer);
    expect(await store.listRules(owner)).toEqual([]);
  });
  it('remembers a rule using the answer’s original sender after another sender raises the question', async () => {
    const original = await store.raiseQuestion(owner, makeQuestion());
    const answered = await store.answerQuestion(owner, response(original));
    if (answered.status !== 'accepted') throw new Error('Expected accepted answer');
    const otherSender = { ...sender, id: 'other-sender', value: 'other@example.test' };
    await store.raiseQuestion(
      owner,
      createQuestion(kind, makeQuestion(), { sender: otherSender, format: 'layout', value: 'West' }),
    );
    await expect(
      store.rememberAnswer(owner, answered.answer.id, kind, { ...scope, sender: otherSender }, condition),
    ).rejects.toMatchObject({ messageKey: 'ingest.decisions.invalidRule' });
    const remembered = await store.rememberAnswer(owner, answered.answer.id, kind, scope, condition);
    expect(await store.findRules(owner, item)).toEqual([remembered]);
    expect(await store.findRules(owner, { ...item, sender: otherSender })).toEqual([]);
  });
  it('stores conflict questions even when valid rule answers reach the text limit', async () => {
    const textKind = { ...kind, answerType: 'text' as const };
    const rules = ['a', 'b'].map((id) => ({
      id,
      enabled: true,
      kind: kind.id,
      scope: { type: 'table' as const },
      condition,
      answer: { type: 'text' as const, value: id.repeat(4096) },
    }));
    const outcome = decide({
      item: { ...item, kind: textKind },
      rules,
      key: 'territory',
      target: makeQuestion().target,
      attempt: 'unused',
    });
    expect(outcome.status).toBe('ask');
    if (outcome.status !== 'ask') throw new Error('Expected conflict question');
    expect(await store.raiseQuestion(owner, outcome.question)).toMatchObject({
      kind: 'ruleConflict',
      active: true,
    });
  });
  it('stores every choice when more than 64 equally scoped rules disagree', async () => {
    const rules = Array.from({ length: 65 }, (_value, index) => ({
      id: `rule-${index}`,
      enabled: true,
      kind: kind.id,
      scope: { type: 'table' as const },
      condition,
      answer: { type: 'choice' as const, value: `answer-${index}` },
    }));
    const outcome = decide({
      item,
      rules,
      key: 'territory',
      target: makeQuestion().target,
      attempt: 'unused',
    });
    if (outcome.status !== 'ask' || outcome.question.form.type !== 'choices')
      throw new Error('Expected conflict question');
    const saved = await store.raiseQuestion(owner, outcome.question);
    if (saved.form.type !== 'choices') throw new Error('Expected choices');
    expect(saved.form.choices).toHaveLength(65);
  });
  it('refuses stale screens, returns the current question, and stores no stale answer or audit', async () => {
    const original = await store.raiseQuestion(owner, makeQuestion());
    const current = await store.raiseQuestion(owner, makeQuestion(['West', 'East']));
    expect(original.id).toBe(current.id);
    expect(original.version).not.toBe(current.version);
    const prior = await events(owner);
    expect(await store.answerQuestion(owner, response(original))).toEqual({
      status: 'stale',
      question: current,
      messageId: 'ingest.decisions.staleAnswer',
    });
    expect(await store.findAnswer(owner, original.id)).toBeNull();
    expect(await events(owner)).toEqual(prior);
    expect((await store.answerQuestion(owner, response(current))).status).toBe('accepted');
  });
  it('retains vanished answers, ignores them, and uses them when the same question returns', async () => {
    const { question, answer } = await seed();
    await store.reconcileQuestions(owner, []);
    expect(await store.findAnswer(owner, question.id)).toBeNull();
    expect(
      (await pool.query(`SELECT id FROM ${schemas.app}.ingest_answers WHERE id = $1`, [answer.id])).rows,
    ).toEqual([{ id: answer.id }]);
    expect(await store.answerQuestion(owner, response(question))).toMatchObject({
      status: 'accepted',
      applies: false,
    });
    await store.raiseQuestion(owner, makeQuestion());
    expect(await store.findAnswer(owner, question.id)).toMatchObject({
      questionId: question.id,
      response: answer.response,
    });
    const changed = createQuestion(
      kind,
      { ...makeQuestion(), values: [{ type: 'text', value: 'East' }] },
      { sender, format: 'layout', value: 'East' },
    );
    await store.raiseQuestion(owner, changed);
    expect(await store.findAnswer(owner, changed.id)).toBeNull();
  });
  it('lets record editors answer, but requires schema rights to remember or turn off rules', async () => {
    const question = await store.raiseQuestion(owner, makeQuestion());
    const viewer = { ...owner, canEditRecords: false, canEditSchema: false };
    await expect(store.answerQuestion(viewer, response(question))).rejects.toMatchObject({
      code: 'forbidden',
      messageKey: 'ingest.decisions.answerForbidden',
    });
    const editor = { ...owner, canEditSchema: false };
    const answered = await store.answerQuestion(editor, response(question));
    expect(answered.status).toBe('accepted');
    if (answered.status !== 'accepted') throw new Error('Expected accepted answer');
    await expect(
      store.rememberAnswer(editor, answered.answer.id, kind, scope, condition),
    ).rejects.toMatchObject({ code: 'forbidden', messageKey: 'ingest.decisions.ruleForbidden' });
    expect(await store.listRules(owner)).toEqual([]);
    const rule = await store.rememberAnswer(owner, answered.answer.id, kind, scope, condition);
    await expect(store.switchOffRule(editor, rule.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await store.listRules(owner))[0]!.enabled).toBe(true);
  });
  it('audits answers and every rule change, and removes switched-off rules from matching', async () => {
    const prior = await events(owner);
    const { answer, rule, question } = await seed();
    expect((await events(owner)).slice(prior.length)).toEqual([
      {
        action: 'data.ingest.answer.created',
        metadata: { tableId: owner.tableId, questionId: question.id, answerId: answer.id },
      },
      {
        action: 'data.ingest.rule.created',
        metadata: { tableId: owner.tableId, ruleId: rule.id, answerId: answer.id },
      },
    ]);
    expect(await store.findRules(owner, item)).toEqual([rule]);
    expect(await store.findRules(owner, { ...item, sender: undefined })).toEqual([]);
    expect(await store.findRules(owner, { ...item, value: 'East' })).toEqual([]);
    expect(await store.switchOffRule(owner, rule.id)).toMatchObject({ enabled: false });
    expect(await store.findRules(owner, item)).toEqual([]);
    expect(await store.listRules(owner)).toHaveLength(1);
    expect((await events(owner)).at(-1)).toEqual({
      action: 'data.ingest.rule.disabled',
      metadata: { tableId: owner.tableId, ruleId: rule.id },
    });
    expect(JSON.stringify((await events(owner)).slice(prior.length))).not.toContain(sender.value);
  });
  it('commits an answer and a rule only if their audit insert succeeds', async () => {
    const question = await store.raiseQuestion(owner, makeQuestion());
    await pool.query(`CREATE FUNCTION ${schemas.audit}.reject_decision_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action LIKE 'data.ingest.%' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_decision_audit BEFORE INSERT ON ${schemas.audit}.events
      FOR EACH ROW EXECUTE FUNCTION ${schemas.audit}.reject_decision_audit();`);
    try {
      await expect(store.answerQuestion(owner, response(question))).rejects.toThrow();
      expect(await store.findAnswer(owner, question.id)).toBeNull();
    } finally {
      await pool.query(`DROP TRIGGER reject_decision_audit ON ${schemas.audit}.events`);
    }
    const answered = await store.answerQuestion(owner, response(question));
    if (answered.status !== 'accepted') throw new Error('Expected accepted answer');
    await pool.query(`CREATE TRIGGER reject_decision_audit BEFORE INSERT ON ${schemas.audit}.events
      FOR EACH ROW EXECUTE FUNCTION ${schemas.audit}.reject_decision_audit()`);
    try {
      await expect(store.rememberAnswer(owner, answered.answer.id, kind, scope, condition)).rejects.toThrow();
      expect(await store.listRules(owner)).toEqual([]);
    } finally {
      await pool.query(`DROP TRIGGER reject_decision_audit ON ${schemas.audit}.events;
        DROP FUNCTION ${schemas.audit}.reject_decision_audit()`);
    }
  });
  it('refuses invalid answers, rule keys, question identities, and unoffered sender scopes', async () => {
    const question = await store.raiseQuestion(owner, makeQuestion());
    await expect(
      store.answerQuestion(owner, {
        ...response(question),
        response: { type: 'answer', answer: { type: 'choice', value: 'invalid' } },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(store.raiseQuestion(owner, { ...makeQuestion(), id: 'forged' })).rejects.toMatchObject({
      messageKey: 'ingest.decisions.invalidQuestion',
    });
    await expect(store.raiseQuestion(owner, { ...makeQuestion(), version: 'forged' })).rejects.toMatchObject({
      messageKey: 'ingest.decisions.invalidQuestion',
    });
    const { answer } = await seed();
    await expect(
      store.rememberAnswer(owner, answer.id, kind, scope, { present: 'text', code: 'x' } as typeof condition),
    ).rejects.toMatchObject({ messageKey: 'ingest.decisions.invalidRule' });
    await expect(
      store.rememberAnswer(
        owner,
        answer.id,
        kind,
        { ...scope, sender: { ...sender, id: 'other' } },
        condition,
      ),
    ).rejects.toMatchObject({ messageKey: 'ingest.decisions.invalidRule' });
    const dropped = createQuestion(
      kind,
      { ...makeQuestion(), key: 'dropped' },
      { format: 'layout', value: 'West' },
    );
    const raised = await store.raiseQuestion(owner, dropped);
    const answered = await store.answerQuestion(owner, response(raised));
    if (answered.status !== 'accepted') throw new Error('Expected accepted answer');
    await expect(
      store.rememberAnswer(owner, answered.answer.id, kind, scope, condition),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('isolates questions, answers, and rules across organizations and tables', async () => {
    const saved = await seed(foreign);
    expect(await store.listRules(owner)).toEqual([]);
    expect(await store.findAnswer(owner, saved.question.id)).toBeNull();
    await expect(store.answerQuestion(owner, response(saved.question))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(store.rememberAnswer(owner, saved.answer.id, kind, scope, condition)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(store.switchOffRule(owner, saved.rule.id)).rejects.toMatchObject({ code: 'not_found' });
    const crossed = { ...owner, tableId: foreign.tableId };
    const attempted = [
      () => store.raiseQuestion(crossed, makeQuestion()),
      () => store.answerQuestion(crossed, response(saved.question)),
      () => store.reconcileQuestions(crossed, []),
      () => store.findAnswer(crossed, saved.question.id),
      () => store.rememberAnswer(crossed, saved.answer.id, kind, scope, condition),
      () => store.listRules(crossed),
      () => store.findRules(crossed, item),
      () => store.switchOffRule(crossed, saved.rule.id),
    ];
    for (const action of attempted) await expect(action()).rejects.toMatchObject({ code: 'not_found' });
    // A matching hash in two tables still belongs to each table separately.
    const local = await seed(owner);
    expect(local.question.id).toBe(saved.question.id);
    expect(await store.findAnswer(owner, local.question.id)).toEqual(local.answer);
    expect(await store.findAnswer(foreign, saved.question.id)).toEqual(saved.answer);
    expect(await store.listRules(foreign)).toEqual([saved.rule]);
    for (const table of ['ingest_questions', 'ingest_answers', 'ingest_rules']) {
      await expect(
        pool.query(`UPDATE ${schemas.app}.${table} SET org_id = 'o1' WHERE org_id = 'o2'`),
      ).rejects.toMatchObject({ code: '23503' });
    }
    expect(
      demoIngestDecisions({ questions: [saved.question], answers: [saved.answer], rules: [saved.rule] }),
    ).toEqual({ questions: [], answers: [], rules: [] });
  });
  it('removes all three tables’ data when their table is deleted', async () => {
    await pool.query(`INSERT INTO ${schemas.app}.tables (id, org_id, database_id, name, primary_field_id, position)
      VALUES ('delete-me', 'o1', 'd1', 'Delete', 'f3', 2)`);
    await seed({ ...owner, tableId: 'delete-me' });
    await pool.query(`DELETE FROM ${schemas.app}.tables WHERE id = 'delete-me'`);
    for (const table of ['ingest_questions', 'ingest_answers', 'ingest_rules']) {
      expect(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM ${schemas.app}.${table} WHERE table_id = 'delete-me'`,
          )
        ).rows[0].n,
      ).toBe(0);
    }
  });
});

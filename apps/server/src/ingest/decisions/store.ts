import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  AppError,
  IngestDecisionAnswer,
  IngestDecisionQuestion,
  IngestDecisionRule,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import {
  checkAnswer,
  questionIdentity,
  questionVersion,
  scopeMatches,
  responseAllowed,
  validateRule,
  SCOPE_PRECEDENCE,
  type Condition,
  type DecisionAnswer,
  type DecisionItem,
  type DecisionQuestion,
  type QuestionKind,
  type RuleScope,
  type RuleDocument,
} from '@riosoma/ingest';
import type { DataSchemas } from '../../data/context.js';

export interface DecisionContext {
  orgId: string;
  tableId: string;
}
export interface DecisionPermissions extends DecisionContext {
  userId: string;
  canEditRecords: boolean;
  canEditSchema: boolean;
}
interface QuestionRow {
  document: DecisionQuestion;
  active: boolean;
}
interface AnswerRow {
  id: string;
  question_id: string;
  question_version: string;
  question_document: DecisionQuestion;
  response: DecisionAnswer['response'];
  answered_by: string | null;
  answered_at: Date;
}
interface RuleRow {
  id: string;
  document: RuleDocument;
  enabled: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}
const tableIdentity = (context: DecisionContext) => ({ orgId: context.orgId, tableId: context.tableId });
const notFound = () => new AppError('not_found', 'errors.notFound');

/** Each mutation locks its table and commits its audit event in the same transaction. */
export class DecisionStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly schemas: DataSchemas,
    private readonly transaction?: Queryable,
  ) {}

  inTransaction(db: Queryable): DecisionStore {
    return new DecisionStore(this.pool, this.schemas, db);
  }

  private get db(): Queryable {
    return this.transaction ?? this.pool;
  }

  private async table(db: Queryable, context: DecisionContext, lock = false): Promise<void> {
    const result = await query(
      db,
      sql`SELECT id FROM ${ident(this.schemas.app, 'tables')}
      WHERE id = ${context.tableId} AND org_id = ${context.orgId} ${lock ? sql`FOR UPDATE` : sql``}`,
    );
    if (!result.rowCount) throw notFound();
  }

  private async change<T>(context: DecisionContext, work: (db: Queryable) => Promise<T>): Promise<T> {
    const change = async (db: Queryable) => {
      await this.table(db, context, true);
      return work(db);
    };
    return this.transaction ? change(this.transaction) : withTransaction(this.pool, change);
  }

  private require(context: DecisionPermissions, right: 'records' | 'schema'): void {
    if (!(right === 'records' ? context.canEditRecords : context.canEditSchema))
      throw new AppError(
        'forbidden',
        right === 'records' ? 'ingest.decisions.answerForbidden' : 'ingest.decisions.ruleForbidden',
      );
  }

  private async audit(
    db: Queryable,
    context: DecisionPermissions,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await query(
      db,
      sql`INSERT INTO ${ident(this.schemas.audit, 'events')} (org_id, actor_id, action, metadata)
      VALUES (${context.orgId}, ${context.userId}, ${action}, ${JSON.stringify({ tableId: context.tableId, ...metadata })}::jsonb)`,
    );
  }

  private question(context: DecisionContext, row: QuestionRow): IngestDecisionQuestion {
    return IngestDecisionQuestion.parse({ ...row.document, ...tableIdentity(context), active: row.active });
  }
  private answer(context: DecisionContext, row: AnswerRow): IngestDecisionAnswer {
    return IngestDecisionAnswer.parse({
      ...tableIdentity(context),
      id: row.id,
      questionId: row.question_id,
      questionVersion: row.question_version,
      response: row.response,
      answeredBy: row.answered_by,
      answeredAt: row.answered_at.toISOString(),
    });
  }
  private rule(context: DecisionContext, row: RuleRow): IngestDecisionRule {
    return IngestDecisionRule.parse({
      ...row.document,
      ...tableIdentity(context),
      id: row.id,
      enabled: row.enabled,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  }
  private async loadQuestion(db: Queryable, context: DecisionContext, id: string): Promise<QuestionRow> {
    const result = await query<QuestionRow>(
      db,
      sql`SELECT document, active FROM ${ident(this.schemas.app, 'ingest_questions')}
      WHERE org_id = ${context.orgId} AND table_id = ${context.tableId} AND id = ${id}`,
    );
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }

  async raiseQuestion(context: DecisionContext, question: DecisionQuestion): Promise<IngestDecisionQuestion> {
    const parsed = IngestDecisionQuestion.safeParse({ ...question, ...tableIdentity(context), active: true });
    if (!parsed.success) throw new AppError('validation_failed', 'ingest.decisions.invalidQuestion');
    const { orgId: _orgId, tableId: _tableId, active: _active, ...document } = parsed.data;
    if (
      document.id !== questionIdentity(document.kind, document.key, document.values) ||
      document.version !== questionVersion(document)
    )
      throw new AppError('validation_failed', 'ingest.decisions.invalidQuestion');
    return this.change(context, async (db) => {
      const result = await query<QuestionRow>(
        db,
        sql`INSERT INTO ${ident(this.schemas.app, 'ingest_questions')}
        (org_id, table_id, id, version, document) VALUES
        (${context.orgId}, ${context.tableId}, ${question.id}, ${question.version}, ${JSON.stringify(document)}::jsonb)
        ON CONFLICT (org_id, table_id, id) DO UPDATE SET version = EXCLUDED.version,
          document = EXCLUDED.document, active = true, updated_at = now() RETURNING document, active`,
      );
      return this.question(context, result.rows[0]!);
    });
  }

  /** A finished read supplies all questions that still arise.  Answers are retained for a later recurrence. */
  async reconcileQuestions(context: DecisionContext, arisingIds: string[], fileId?: string): Promise<void> {
    await this.change(context, async (db) => {
      await query(
        db,
        sql`UPDATE ${ident(this.schemas.app, 'ingest_questions')} SET active = false, updated_at = now()
        WHERE org_id = ${context.orgId} AND table_id = ${context.tableId} AND active ${fileId ? sql`AND document->'target'->>'file' = ${fileId}` : sql``} AND NOT (id = ANY(${arisingIds}::text[]))`,
      );
    });
  }

  async answerQuestion(
    context: DecisionPermissions,
    answer: DecisionAnswer,
  ): Promise<
    | { status: 'accepted'; answer: IngestDecisionAnswer; applies: boolean }
    | { status: 'stale'; question: IngestDecisionQuestion; messageId: string }
  > {
    return this.change(context, async (db) => {
      this.require(context, 'records');
      const row = await this.loadQuestion(db, context, answer.questionId);
      const checked = checkAnswer(row.document, answer);
      if (checked.status === 'stale')
        return { status: 'stale', question: this.question(context, row), messageId: checked.messageId };
      if (checked.status === 'invalid') throw new AppError('validation_failed', checked.messageId);
      const result = await query<AnswerRow>(
        db,
        sql`INSERT INTO ${ident(this.schemas.app, 'ingest_answers')}
        (id, org_id, table_id, question_id, question_version, question_document, response, answered_by) VALUES
        (${randomUUID()}, ${context.orgId}, ${context.tableId}, ${answer.questionId}, ${answer.questionVersion},
          ${JSON.stringify(row.document)}::jsonb, ${JSON.stringify(answer.response)}::jsonb, ${context.userId}) RETURNING *`,
      );
      const stored = this.answer(context, result.rows[0]!);
      await this.audit(db, context, 'data.ingest.answer.created', {
        questionId: answer.questionId,
        answerId: stored.id,
      });
      return { status: 'accepted', answer: stored, applies: row.active };
    });
  }

  /** One-time answers belong to their file and sender, even when rereads change the row evidence. */
  async findAnswer(context: DecisionContext, questionId: string): Promise<IngestDecisionAnswer | null> {
    await this.table(this.db, context);
    const result = await query<AnswerRow>(
      this.db,
      sql`SELECT a.* FROM ${ident(this.schemas.app, 'ingest_answers')} a
      JOIN ${ident(this.schemas.app, 'ingest_questions')} q ON q.org_id = a.org_id AND q.table_id = a.table_id AND q.id = a.question_id
      WHERE a.org_id = ${context.orgId} AND a.table_id = ${context.tableId} AND a.question_id = ${questionId} AND q.active
        AND a.question_document->'target'->>'file' = q.document->'target'->>'file'
        AND a.question_document->'scopeContext'->'sender' IS NOT DISTINCT FROM q.document->'scopeContext'->'sender'
      ORDER BY a.seq DESC LIMIT 1`,
    );
    return result.rows[0] ? this.answer(context, result.rows[0]) : null;
  }

  async rememberAnswer(
    context: DecisionPermissions,
    answerId: string,
    kind: QuestionKind,
    scope: RuleScope,
    condition: Condition,
    right: 'records' | 'schema' = 'schema',
  ): Promise<IngestDecisionRule> {
    return this.change(context, async (db) => {
      this.require(context, right);
      const result = await query<AnswerRow>(
        db,
        sql`SELECT * FROM ${ident(this.schemas.app, 'ingest_answers')}
        WHERE id = ${answerId} AND org_id = ${context.orgId} AND table_id = ${context.tableId}`,
      );
      const answer = result.rows[0];
      if (!answer) throw notFound();
      const question = answer.question_document;
      if (
        !scopeMatches(scope, { kind, inputs: {}, ...question.scopeContext }) ||
        question.kind !== kind.id ||
        answer.response.type !== 'answer' ||
        !responseAllowed(question, answer.response) ||
        !question.allowedScopes.includes(scope.type)
      )
        throw new AppError('validation_failed', 'ingest.decisions.invalidRule');
      const validated = validateRule(
        { kind: kind.id, scope, condition, answer: answer.response.answer },
        kind,
      );
      if (!validated.ok) throw new AppError('validation_failed', validated.messageId);
      const saved = await query<RuleRow>(
        db,
        sql`INSERT INTO ${ident(this.schemas.app, 'ingest_rules')}
        (id, org_id, table_id, kind, document, answer_id, created_by) VALUES
        (${randomUUID()}, ${context.orgId}, ${context.tableId}, ${kind.id}, ${JSON.stringify(validated.rule)}::jsonb,
          ${answerId}, ${context.userId}) RETURNING *`,
      );
      const rule = this.rule(context, saved.rows[0]!);
      await this.audit(db, context, 'data.ingest.rule.created', { ruleId: rule.id, answerId });
      return rule;
    });
  }

  async listRules(context: DecisionContext): Promise<IngestDecisionRule[]> {
    await this.table(this.db, context);
    const result = await query<RuleRow>(
      this.db,
      sql`SELECT * FROM ${ident(this.schemas.app, 'ingest_rules')}
      WHERE org_id = ${context.orgId} AND table_id = ${context.tableId} ORDER BY created_at, id`,
    );
    return result.rows.map((row) => this.rule(context, row));
  }

  async switchOffRule(context: DecisionPermissions, ruleId: string): Promise<IngestDecisionRule> {
    return this.change(context, async (db) => {
      this.require(context, 'schema');
      const existing = await query<RuleRow>(
        db,
        sql`SELECT * FROM ${ident(this.schemas.app, 'ingest_rules')}
        WHERE id = ${ruleId} AND org_id = ${context.orgId} AND table_id = ${context.tableId}`,
      );
      if (!existing.rows[0]) throw notFound();
      if (!existing.rows[0].enabled) return this.rule(context, existing.rows[0]);
      const result = await query<RuleRow>(
        db,
        sql`UPDATE ${ident(this.schemas.app, 'ingest_rules')}
        SET enabled = false, updated_at = now()
        WHERE id = ${ruleId} AND org_id = ${context.orgId} AND table_id = ${context.tableId} RETURNING *`,
      );
      if (!result.rows[0]) throw notFound();
      const rule = this.rule(context, result.rows[0]);
      await this.audit(db, context, 'data.ingest.rule.disabled', { ruleId });
      return rule;
    });
  }

  async findRules(context: DecisionContext, item: DecisionItem): Promise<IngestDecisionRule[]> {
    return (await this.listRules(context))
      .filter((rule) => rule.enabled && rule.kind === item.kind.id && scopeMatches(rule.scope, item))
      .sort((a, b) => SCOPE_PRECEDENCE[a.scope.type] - SCOPE_PRECEDENCE[b.scope.type]);
  }
}

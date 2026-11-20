import type { z } from 'zod';
import {
  IngestDecisionQuestion,
  IngestDecisionRule,
  IngestExample,
  IngestLiveFile,
  IngestLiveFormat,
  IngestLiveQuestion,
  IngestLiveRule,
  IngestLiveSummary,
  type IngestLivePage,
} from '@riosoma/contracts';
import { ident, query, sql, type Sql } from '@riosoma/db';
import type { LiveAccess } from './access.js';

/** Catalog timestamps and bigint counts have one representation at the HTTP boundary. */
export function catalog<T>(schema: z.ZodType<T>, row: Record<string, unknown>): T {
  return schema.parse(
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
        value instanceof Date ? value.toISOString() : value,
      ]),
    ),
  );
}
export function page<T>(items: T[], input: IngestLivePage) {
  return {
    items: items.slice(0, input.limit),
    nextOffset: items.length > input.limit ? input.offset + input.limit : null,
  };
}
const where = (a: LiveAccess) => sql`org_id = ${a.context.orgId} AND table_id = ${a.context.tableId}`;
export const unresolved = (a: LiveAccess) => sql`NOT EXISTS (
  SELECT 1 FROM ${ident(a.c.schemas.app, 'ingest_answers')} answer
  LEFT JOIN ${ident(a.c.schemas.app, 'ingest_live_requests')} request ON request.id = answer.id
  WHERE answer.org_id = q.org_id AND answer.table_id = q.table_id AND answer.question_id = q.id AND answer.question_version = q.version
    AND (request.id IS NULL OR request.state = 'complete')
)`;

export async function questions(
  a: LiveAccess,
  input: IngestLivePage,
  state: 'open' | 'answered' | 'all',
  fileId?: string,
) {
  const rows = await query<{
    document: IngestDecisionQuestion;
    active: boolean;
    created_at: Date;
    answered: boolean;
    application: IngestLiveQuestion['application'] | null;
  }>(
    a.c.db,
    sql`SELECT q.document, q.active, q.created_at, NOT (${unresolved(a)}) AS answered,
      (SELECT jsonb_build_object('id', r.id, 'state', r.state, 'messageId', r.message_id, 'undoGroupId', r.undo_group_id)
        FROM ${ident(a.c.schemas.app, 'ingest_answers')} answer
        JOIN ${ident(a.c.schemas.app, 'ingest_live_requests')} r ON r.id = answer.id
        WHERE answer.org_id = q.org_id AND answer.table_id = q.table_id AND answer.question_id = q.id
          AND answer.question_version = q.version ORDER BY answer.seq DESC LIMIT 1) AS application
      FROM ${ident(a.c.schemas.app, 'ingest_questions')} q
      WHERE q.org_id = ${a.context.orgId} AND q.table_id = ${a.context.tableId}
      ${state === 'open' ? sql`AND q.active AND ${unresolved(a)}` : state === 'answered' ? sql`AND NOT (${unresolved(a)})` : sql``}
      ${fileId ? sql`AND q.document->'target'->>'file' = ${fileId}` : sql``}
      ORDER BY q.created_at, q.id LIMIT ${input.limit + 1} OFFSET ${input.offset}`,
  );
  return page(
    rows.rows.map((row) => {
      const q = IngestDecisionQuestion.parse({
        ...row.document,
        ...a.context,
        active: row.active,
        ...(row.document.kind === 'formatTie' ? { allowedScopes: [], defaultScope: null } : {}),
      });
      return IngestLiveQuestion.parse({
        id: q.id,
        version: q.version,
        kind: q.kind,
        messageId: q.messageId,
        state: row.answered ? 'answered' : 'open',
        fileId: q.target.file,
        createdAt: row.created_at.toISOString(),
        defaultScope: q.defaultScope,
        allowedScopes: q.allowedScopes,
        allowUnknown: q.allowUnknown,
        exits: q.exits,
        canRemember: q.allowedScopes.length > 0,
        ...(row.application ? { application: row.application } : {}),
        evidenceWithheld: !a.evidence,
        ...(a.evidence ? { details: q } : {}),
      });
    }),
    input,
  );
}

export async function files(a: LiveAccess, input: IngestLivePage, fileId?: string) {
  const rows = await query<Record<string, unknown>>(
    a.c.db,
    sql`
    SELECT f.id, f.name, f.state, f.hold_reason AS "holdReason", f.counts,
      f.received_at AS "receivedAt", f.is_example AS "isExample",
      jsonb_build_object('id', s.id, 'label', s.label, 'userId', f.dropped_by) AS sender,
      jsonb_build_object('id', m.id, 'name', m.name) AS format,
      EXISTS (SELECT 1 FROM ${ident(a.c.schemas.app, 'files')} o
        WHERE o.id = f.stored_file AND o.org_id = f.org_id AND o.table_id = f.table_id
          AND o.ingest_file_id = f.id) AS "originalKept"
      ${fileId && a.evidence ? sql`, f.notes, f.checks` : sql``}
    FROM ${ident(a.c.schemas.app, 'ingest_files')} f
    LEFT JOIN ${ident(a.c.schemas.app, 'ingest_senders')} s ON s.org_id = f.org_id AND s.table_id = f.table_id AND s.id = f.sender_id
    LEFT JOIN ${ident(a.c.schemas.app, 'ingest_formats')} m ON m.org_id = f.org_id AND m.table_id = f.table_id AND m.id = f.format_id
    WHERE f.org_id = ${a.context.orgId} AND f.table_id = ${a.context.tableId}
      ${fileId ? sql`AND f.id = ${fileId}` : sql``}
    ORDER BY f.seq DESC LIMIT ${input.limit + 1} OFFSET ${input.offset}`,
  );
  return page(
    rows.rows.map((row) =>
      IngestLiveFile.parse({
        ...row,
        receivedAt: (row.receivedAt as Date).toISOString(),
        evidenceWithheld: !a.evidence,
      }),
    ),
    input,
  );
}

export async function rules(a: LiveAccess, input: IngestLivePage) {
  const result = await query<Record<string, unknown>>(
    a.c.db,
    sql`SELECT r.*, (SELECT f.name FROM ${ident(a.c.schemas.app, 'ingest_formats')} f
      WHERE f.org_id = r.org_id AND f.table_id = r.table_id AND f.id = r.document->'scope'->>'format') AS format_name
      FROM ${ident(a.c.schemas.app, 'ingest_rules')} r
    WHERE ${where(a)} ORDER BY created_at, id LIMIT ${input.limit + 1} OFFSET ${input.offset}`,
  );
  return page(
    result.rows.map((row) => {
      const rule = IngestDecisionRule.parse({
        ...(row.document as object),
        ...a.context,
        id: row.id,
        enabled: row.enabled,
        createdBy: row.created_by,
        createdAt: (row.created_at as Date).toISOString(),
        updatedAt: (row.updated_at as Date).toISOString(),
      });
      const scope = rule.scope;
      const params: Record<string, string> = {};
      if (a.evidence) {
        if ('value' in scope) params.value = scope.value;
        if ('sender' in scope) params.sender = scope.sender.value;
        if ('format' in scope)
          params.format = typeof row.format_name === 'string' ? row.format_name : scope.format;
      }
      return IngestLiveRule.parse({
        id: rule.id,
        kind: rule.kind,
        enabled: rule.enabled,
        createdBy: rule.createdBy,
        createdAt: rule.createdAt,
        scope: { messageId: `ingest.live.scope.${a.evidence ? scope.type : 'withheld'}`, params },
        evidenceWithheld: !a.evidence,
        ...(a.evidence ? { details: rule } : {}),
      });
    }),
    input,
  );
}

export async function formats(a: LiveAccess, input: IngestLivePage, examples: IngestLivePage) {
  const rows = await query<Record<string, unknown>>(
    a.c.db,
    sql`SELECT id, name, state, reading, rules, probation_passed
    FROM ${ident(a.c.schemas.app, 'ingest_formats')} WHERE ${where(a)}
    ORDER BY created_at, id LIMIT ${input.limit + 1} OFFSET ${input.offset}`,
  );
  const items = [];
  for (const row of rows.rows) {
    const result = await query<Record<string, unknown>>(
      a.c.db,
      sql`SELECT * FROM ${ident(a.c.schemas.app, 'ingest_examples')}
      WHERE ${where(a)} AND format_id = ${row.id} ORDER BY confirmed_at, id
      LIMIT ${examples.limit + 1} OFFSET ${examples.offset}`,
    );
    const sample = page(
      result.rows.map((entry) => {
        const example = catalog(IngestExample, entry);
        return {
          id: example.id,
          fileId: example.fileId,
          passed: example.lastResult?.passed ?? null,
          evidenceWithheld: !a.evidence,
          ...(a.evidence ? { details: example } : {}),
        };
      }),
      examples,
    );
    const reading = row.rules as Record<string, unknown> | null;
    items.push(
      IngestLiveFormat.parse({
        id: row.id,
        name: row.name,
        state: row.state,
        reading: row.reading,
        probationPassed: row.probation_passed,
        evidenceWithheld: !a.evidence,
        examples: sample.items,
        examplesNextOffset: sample.nextOffset,
        ...(row.reading === 'layout' && a.evidence ? { mapping: reading?.columns ?? {} } : {}),
        ...(row.reading === 'reader' && a.schema && a.evidence ? { code: reading?.code } : {}),
      }),
    );
  }
  return page(items, input);
}

export async function summary(a: LiveAccess) {
  const count = async (catalogName: string, filter: Sql) =>
    Number(
      (
        await query<{ count: string }>(
          a.c.db,
          sql`SELECT count(*) FROM ${ident(a.c.schemas.app, catalogName)} q
      WHERE q.org_id = ${a.context.orgId} AND q.table_id = ${a.context.tableId} AND ${filter}`,
        )
      ).rows[0]!.count,
    );
  const openQuestions = await count('ingest_questions', sql`q.active AND ${unresolved(a)}`);
  const heldFiles = await count('ingest_files', sql`q.state = 'held'`);
  const last = await query<{ received_at: Date }>(
    a.c.db,
    sql`SELECT received_at FROM ${ident(a.c.schemas.app, 'ingest_files')}
    WHERE ${where(a)} ORDER BY seq DESC LIMIT 1`,
  );
  return IngestLiveSummary.parse({
    state: a.table.ingest!.state,
    openQuestions,
    heldFiles,
    lastReceivedAt: last.rows[0]?.received_at.toISOString() ?? null,
  });
}

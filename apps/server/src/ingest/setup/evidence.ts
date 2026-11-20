import { AppError, type IngestTableSettings } from '@riosoma/contracts';
import { checkPair, type ExtractedSource, type PairFinding } from '@riosoma/ingest';
import { ident, query, sql } from '@riosoma/db';
import type { CommandContext } from '../../data/commands/context.js';
import { loadFields } from '../../data/metadata.js';
import { scopeOf } from '../../data/commands/context.js';
import { loadOriginal } from '../../data/files/originals.js';
import { extractSource } from '../extract/index.js';
import { checkPairSignatures, pairFieldType } from '../pairs/index.js';
import { IngestTableStore } from '../tables/store.js';
import { dataStore } from '../../data/context.js';
import { computeReadiness } from './readiness.js';

export function setupStore(c: CommandContext) {
  return new IngestTableStore(dataStore(c.appContext!).pool, c.schemas).inTransaction(c.db);
}

/** Snapshots and originals lack record provenance, so partial record access cannot authorize them. */
export async function requireEvidenceAccess(c: CommandContext, tableId: string, fieldIds?: string[]) {
  const scope = await scopeOf(c, tableId);
  await scope.require(c.databaseId, 'read');
  const fields = await loadFields(c.db, c.schemas, [tableId], { includeTrashed: true });
  const visible = new Set(scope.visibleFields(tableId, fields).map((field) => field.id));
  if (
    scope.limitsRecords(tableId) ||
    (fieldIds ?? fields.map((field) => field.id)).some((id) => !visible.has(id))
  )
    throw new AppError('forbidden', 'data.access.denied');
}

/** Original bytes are bounded, checked when stored, and verified against their arrival hash on read. */
export async function setupEvidence(c: CommandContext, tableId: string, settings: IngestTableSettings) {
  await requireEvidenceAccess(c, tableId);
  const context = { orgId: c.actor.orgId, tableId };
  const store = setupStore(c);
  const fields = await loadFields(c.db, c.schemas, [tableId]);
  const formats = await store.listFormats(context);
  const examples = await store.listExamples(context);
  const files = await store.listFiles(context);
  const sources = new Map<string, ExtractedSource>();
  const unavailable: string[] = [];
  for (const example of examples) {
    const file = files.find((file) => file.id === example.fileId);
    const bytes = file ? await loadOriginal(c.db, c.schemas.app, c.fileConfig!, file) : null;
    if (!file || !bytes || (file.expiresAt !== null && Date.parse(file.expiresAt) <= Date.now())) {
      unavailable.push(example.id);
      continue;
    }
    const extracted = await extractSource(file.name, bytes);
    if (extracted.status !== 'extracted') unavailable.push(example.id);
    else sources.set(example.id, extracted.source);
  }
  const typed = {
    ...settings,
    fields: settings.fields.map((definition) => ({
      ...definition,
      type: pairFieldType(fields.find((field) => field.id === definition.fieldId) ?? { type: 'text' }),
    })),
  };
  const findings = new Map<string, PairFinding[]>();
  for (const example of examples) {
    const source = sources.get(example.id);
    const file = files.find((file) => file.id === example.fileId);
    if (!source || !file) continue;
    findings.set(
      example.id,
      checkPair(
        { source, sha256: file.sha256 },
        example.expected,
        typed,
        examples
          .filter((other) => other.id !== example.id)
          .flatMap((other) => {
            const original = files.find((file) => file.id === other.fileId);
            return original ? [{ id: other.id, sha256: original.sha256 }] : [];
          }),
      ),
    );
  }
  const signatures = checkPairSignatures(
    formats,
    examples.flatMap((example) => {
      const source = sources.get(example.id);
      return source ? [{ id: example.id, formatId: example.formatId, source }] : [];
    }),
  );
  const open = await query<{
    id: string;
    document: {
      kind?: string;
      key?: string;
      messageId?: string;
      target?: { type: string; field?: string; file?: string };
      scopeContext?: { format?: string };
    };
  }>(
    c.db,
    sql`SELECT q.id, q.document FROM ${ident(c.schemas.app, 'ingest_questions')} q
      WHERE q.org_id = ${context.orgId} AND q.table_id = ${tableId} AND q.active
      AND (SELECT a.response->>'type' FROM ${ident(c.schemas.app, 'ingest_answers')} a
        WHERE a.org_id = q.org_id AND a.table_id = q.table_id AND a.question_id = q.id
          AND a.question_version = q.version ORDER BY a.seq DESC LIMIT 1)
        IS DISTINCT FROM 'answer' ORDER BY q.id`,
  );
  const required = new Set(settings.fields.filter((field) => field.required).map((field) => field.key));
  const questions = open.rows.flatMap(({ id, document }) => {
    const field = document.target?.type === 'field' ? document.target.field : document.key;
    return field &&
      required.has(field) &&
      (['valueSource', 'blankRequiredValue', 'absent-value'].includes(document.kind ?? '') ||
        document.messageId === 'ingest.pairs.absentValue')
      ? [{ id, field, formatId: document.scopeContext?.format, fileId: document.target?.file }]
      : [];
  });
  const evidence = {
    settings,
    fields,
    formats,
    examples,
    files,
    findings,
    signatures,
    unavailable,
    questions,
  };
  return { ...evidence, sources, readiness: computeReadiness(evidence) };
}

export function requireSettings(settings: IngestTableSettings | null | undefined): IngestTableSettings {
  if (!settings) throw new AppError('conflict', 'ingest.setup.state');
  return settings;
}

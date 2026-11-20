import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError, type IngestSetupCommand } from '@riosoma/contracts';
import { canonical } from '@riosoma/ingest';
import { ident, query, sql } from '@riosoma/db';
import type { Actor } from '../../http/policy.js';
import type { CommandContext } from '../../data/commands/context.js';
import { dataStore } from '../../data/context.js';
import { loadTable } from '../../data/metadata.js';
import { loadOriginal } from '../../data/files/originals.js';
import { PairReadUnavailable, pairFieldType, runFormatPairs, type PairRunResult } from '../pairs/index.js';
import { requireSettings, setupEvidence } from '../setup/evidence.js';
import { DecisionStore } from '../decisions/store.js';
import { createAiReader } from './index.js';

export interface PreparedAiPairs {
  fingerprint: string;
  pairs: PairRunResult;
}
type Evidence = Awaited<ReturnType<typeof setupEvidence>>;

/** Evidence is rechecked under the command lock after the model work finishes. */
export async function aiPairsFingerprint(
  c: CommandContext,
  evidence: Evidence,
  tableId: string,
): Promise<string> {
  const rules = await new DecisionStore(dataStore(c.appContext!).pool, c.schemas)
    .inTransaction(c.db)
    .listRules({
      orgId: c.actor.orgId,
      tableId,
    });
  return createHash('sha256')
    .update(
      canonical({
        settings: evidence.settings,
        fields: evidence.fields,
        formats: evidence.formats,
        examples: evidence.examples.map(({ lastResult: _lastResult, ...example }) => example),
        files: evidence.files.map(({ id, sha256, storedFile, expiresAt }) => ({
          id,
          sha256,
          storedFile,
          expiresAt,
        })),
        rules,
      }),
    )
    .digest('hex');
}

/** Model calls use the pool before runStored opens its transaction or takes a command lock. */
export async function prepareAiPairs(
  app: FastifyInstance,
  actor: Actor,
  command: IngestSetupCommand,
): Promise<PreparedAiPairs | undefined> {
  if (command.kind !== 'ingest.format.rules' || command.reading !== 'ai') return undefined;
  const { pool, schemas } = dataStore(app.ctx);
  const existing = await query(
    pool,
    sql`SELECT id FROM ${ident(schemas.app, 'commands')} WHERE id = ${command.id}`,
  );
  if (existing.rowCount) return undefined;
  const table = await loadTable(pool, schemas, command.tableId);
  if (!table || table.orgId !== actor.orgId) throw new AppError('not_found', 'errors.notFound');
  const settings = requireSettings(table.ingest);
  const c: CommandContext = {
    db: pool,
    schemas,
    actor,
    databaseId: table.databaseId,
    appContext: app.ctx,
    fileConfig: app.ctx.config,
  };
  const evidence = await setupEvidence(c, table.id, settings);
  const before = evidence.formats.find((format) => format.id === command.formatId);
  if (!before) throw new AppError('not_found', 'errors.notFound');
  if (before.revision !== command.revision) throw new AppError('conflict', 'ingest.tables.stale');
  const fingerprint = await aiPairsFingerprint(c, evidence, table.id);
  const read = createAiReader(app.ctx, actor);
  const context = { orgId: actor.orgId, tableId: table.id, userId: actor.userId };
  const pairs = await runFormatPairs(
    table,
    { ...before, reading: 'ai', rules: null, signature: command.signature },
    evidence.examples.filter((example) => example.formatId === before.id),
    {
      actor: context,
      fieldTypes: Object.fromEntries(
        settings.fields.map((definition) => [
          definition.key,
          pairFieldType(evidence.fields.find((field) => field.id === definition.fieldId) ?? { type: 'text' }),
        ]),
      ),
      store: {
        readFile: async (_context, id) => evidence.files.find((file) => file.id === id) ?? null,
        updateExample: async (_context, id, patch) => ({
          ...evidence.examples.find((example) => example.id === id)!,
          ...patch,
        }),
      },
      loadOriginal: (file) => loadOriginal(pool, schemas.app, app.ctx.config, file),
      readWithAi: async (source, format) => {
        const reading = await read(source, format, table);
        if (reading.status !== 'read') throw new PairReadUnavailable(reading.failure!.messageId);
        if (reading.flagged) throw new AppError('validation_failed', 'ingest.aiReader.flagged');
        return reading.rows;
      },
    },
  );
  return { fingerprint, pairs };
}

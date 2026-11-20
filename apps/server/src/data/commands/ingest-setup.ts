import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  FieldCreate,
  GridConfig,
  INGEST_PROCESS_FIELDS,
  IngestOrganizationSettings,
  IngestSetupCommand,
  IngestSetupDetails,
  type IngestTableSettings,
  newId,
  type IngestSetupResult,
  type IngestOutputInput,
  type IngestReadiness,
} from '@riosoma/contracts';
import {
  checkPair,
  parseLayout,
  serializableValue,
  type ExampleRows,
  type FormatDefinition,
  type ExtractedSource,
} from '@riosoma/ingest';
import { compile, ident, query, sql, withTransaction } from '@riosoma/db';
import { z } from 'zod';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { auditEvent } from '../../auth/database.js';
import { refuseDemo } from '../../demo/boundary.js';
import { dataStore } from '../context.js';
import { AccessScope } from '../access.js';
import { loadField, loadFields, loadTable, loadViews } from '../metadata.js';
import { inspectOriginal, loadOriginal, storeOriginal, type OriginalRow } from '../files/originals.js';
import { fileStorage } from '../files/storage.js';
import { formulaRead } from '../physical/records.js';
import { extractSource } from '../../ingest/extract/index.js';
import { checkPairSignatures, pairFieldType, runFormatPairs } from '../../ingest/pairs/index.js';
import { aiPairsFingerprint, prepareAiPairs, type PreparedAiPairs } from '../../ingest/ai-reader/setup.js';
import { applyDraftCommand, matchingDraft } from '../../ingest/drafts/commands.js';
import { draftResponse } from '../../ingest/drafts/store.js';
import { startDraftWork } from '../../ingest/drafts/worker.js';
import { runReader } from '../../ingest/readers/index.js';
import { ReaderBindings } from '../../ingest/readers/bindings.js';
import { TOOLKIT_VERSION } from '../../ingest/readers/toolkit-bundle.js';
import { ingestCapability } from '../../ingest/tables/capability.js';
import { formatSignatureFindings, outputFingerprint } from '../../ingest/setup/readiness.js';
import {
  requireEvidenceAccess,
  requireSettings,
  setupEvidence,
  setupStore,
} from '../../ingest/setup/evidence.js';
import { expectedSheet, proposeSheet, setupSheet, uploadBytes } from '../../ingest/setup/sheets.js';
import { applyFields } from './fields.js';
import { applySchema } from './schema.js';
import { settingsFor } from '../../ai/settings.js';
import { buildFingerprint, type BuiltEvidence } from '../../ingest/build/evidence.js';
import { valueSources } from '../../ingest/build/provenance.js';
import { lock, recordChange, runStored } from './transaction.js';
import { publicField, publicTable, scopeOf, table, type CommandContext, type Mutation } from './context.js';
import { messages } from './messages.js';

type Result = IngestSetupResult;
type Door = 'person' | 'mcp' | 'proposal';
class SetupRefusal extends AppError {
  constructor(
    messageId: string,
    readonly details: Record<string, unknown>,
  ) {
    super('validation_failed', messageId);
  }
}
const stale = () => new AppError('conflict', 'ingest.tables.stale');
const wrongState = () => new AppError('conflict', 'ingest.setup.state');
const actorContext = (c: CommandContext, tableId: string) => ({ ...c.actor, tableId });

export function requireSetupPerson(actor: Actor, door: Door = 'person'): void {
  if (
    door !== 'person' ||
    actor.token ||
    actor.automation ||
    actor.script ||
    actor.routine ||
    actor.aiField ||
    actor.source ||
    !actor.sessionId
  )
    throw new AppError('forbidden', 'ingest.setup.personMustGoLive');
}

async function keepDays(c: CommandContext, settings: IngestTableSettings) {
  if (settings.originals.keepDays !== null) return settings.originals.keepDays;
  const org = await query<{ settings: { ingest?: unknown } }>(
    c.db,
    sql`SELECT settings FROM ${ident(c.schemas.app, 'orgs')} WHERE id = ${c.actor.orgId}`,
  );
  return IngestOrganizationSettings.parse(org.rows[0]?.settings.ingest ?? {}).originalKeepDays;
}

async function saveSettings(
  c: CommandContext,
  tableId: string,
  before: IngestTableSettings | null,
  after: Omit<IngestTableSettings, 'revision'> | null,
) {
  return setupStore(c).changeSettings(actorContext(c, tableId), before?.revision ?? null, after);
}

async function outputFormat(
  c: CommandContext,
  command: Extract<IngestSetupCommand, { kind: 'ingest.output' }>,
  settings: IngestTableSettings,
  mutations: Mutation[],
) {
  const { tableId, output } = command;
  if (settings.state !== 'setup') throw wrongState();
  if (settings.revision !== output.revision) throw stale();
  const store = setupStore(c);
  const context = actorContext(c, tableId);
  c.ingestCapability = ingestCapability;
  const previous = await loadFields(c.db, c.schemas, [tableId]);
  // Clear data marks first so keys can be renamed or swapped atomically without violating their unique index.
  for (const field of previous.filter((field) => field.ingest?.role === 'data'))
    await store.markField(context, field.id, null);
  const definitions: IngestTableSettings['fields'] = [];
  for (const definition of output.fields) {
    let fieldId: string;
    if ('id' in definition.field) {
      fieldId = definition.field.id;
      const field = await loadField(c.db, c.schemas, fieldId);
      if (!field || field.tableId !== tableId || field.trashed || field.ingest?.role === 'process')
        throw new AppError('not_found', 'errors.notFound');
      if (!(await scopeOf(c, tableId)).visibleFields(tableId, [field]).length)
        throw new AppError('not_found', 'errors.notFound');
    } else {
      fieldId = newId('field');
      const field = parse(FieldCreate, { ...definition.field, id: fieldId });
      mutations.push(
        await applyFields(c, {
          id: command.id,
          groupId: newId('action'),
          kind: 'field.create',
          tableId,
          field,
        }),
      );
    }
    const choiceChange = await allowedValues(c, command.id, fieldId, definition);
    if (choiceChange) mutations.push(choiceChange);
    await store.markField(context, fieldId, { key: definition.key, role: 'data' });
    definitions.push({
      key: definition.key,
      fieldId,
      meaning: definition.meaning,
      required: definition.required,
    });
  }
  if (new Set(definitions.map((definition) => definition.fieldId)).size !== definitions.length)
    throw new AppError('validation_failed', 'ingest.tables.invalid');
  const saved = await saveSettings(c, tableId, settings, {
    ...settings,
    rowMeaning: output.rowMeaning,
    identity: output.identity,
    identityDecided: true,
    fields: definitions,
  });
  return { settings: saved };
}

async function allowedValues(
  c: CommandContext,
  commandId: string,
  fieldId: string,
  definition: IngestOutputInput['fields'][number],
) {
  if (!definition.allowedValues) return;
  const field = (await loadField(c.db, c.schemas, fieldId))!;
  if (field.type !== 'singleSelect' && field.type !== 'multipleSelect')
    throw new AppError('validation_failed', 'ingest.setup.choiceValues');
  if (
    new Set(definition.allowedValues.map((value) => value.toLowerCase())).size !==
    definition.allowedValues.length
  )
    throw new AppError('validation_failed', 'ingest.setup.choiceValues');
  const choices = definition.allowedValues.map(
    (name) =>
      field.options.choices.find((choice) => choice.name === name) ?? {
        id: newId('choice'),
        name,
        color: 'gray' as const,
      },
  );
  return applyFields(c, {
    id: commandId,
    groupId: newId('action'),
    kind: 'field.update',
    fieldId,
    options: { ...field.options, choices },
  });
}

async function expectedRows(
  c: CommandContext,
  command: Extract<IngestSetupCommand, { kind: 'ingest.example.add' }>,
  settings: IngestTableSettings,
): Promise<{ rows: ExampleRows; own: boolean }> {
  const { expected, tableId } = command;
  if (expected.kind === 'draft') {
    await requireEvidenceAccess(c, tableId);
    const draft = await setupStore(c).readExample(actorContext(c, tableId), expected.exampleId);
    if (!draft) throw new AppError('not_found', 'errors.notFound');
    return { rows: draft.expected, own: false };
  }
  if (expected.kind === 'records') {
    const fields = await loadFields(c.db, c.schemas, [tableId]);
    const scope = await scopeOf(c, tableId);
    const readable = scope.visibleFields(tableId, fields);
    if (settings.fields.some((definition) => !readable.some((field) => field.id === definition.fieldId)))
      throw new AppError('not_found', 'errors.notFound');
    const read = formulaRead(readable, { now: new Date(), timeZone: 'UTC' }, true);
    const result = await query<Parameters<typeof read.decode>[0]>(
      c.db,
      sql`SELECT ${read.select} FROM ${ident(c.schemas.data, tableId)}
      WHERE __id = ANY(${expected.recordIds}::text[]) AND __deleted_at IS NULL AND NOT __source_gone AND (${scope.recordPredicate(tableId)})`,
    );
    const rows = result.rows.map((row) => read.decode(row));
    if (rows.length !== new Set(expected.recordIds).size) throw new AppError('not_found', 'errors.notFound');
    return {
      rows: expected.recordIds.map((recordId) => {
        const row = rows.find((row) => row.id === recordId)!;
        return {
          values: Object.fromEntries(
            settings.fields.map((definition) => [
              definition.key,
              serializableValue(row.values[definition.fieldId]),
            ]),
          ),
        };
      }),
      own: true,
    };
  }
  const file =
    expected.kind === 'upload'
      ? { name: expected.file.name, bytes: uploadBytes(expected.file), statedType: expected.file.mediaType }
      : { name: 'expected.tsv', bytes: Buffer.from(expected.text, 'utf8') };
  const fields = await loadFields(c.db, c.schemas, [tableId]);
  return {
    rows: expectedSheet(
      await setupSheet(c, file),
      settings.fields.map((definition) => ({
        key: definition.key,
        name: fields.find((field) => field.id === definition.fieldId)?.name ?? definition.key,
      })),
    ),
    own: true,
  };
}

export async function validateOfferedPair(
  c: CommandContext,
  command: { id: string; tableId: string; formatId: string; confirm: boolean; confirmationId?: string },
  settings: IngestTableSettings,
  offered: { rows: ExampleRows; own: boolean },
  sha256: string,
  source: ExtractedSource,
) {
  const fields = await loadFields(c.db, c.schemas, [command.tableId]);
  const examples = await setupStore(c).listExamples(actorContext(c, command.tableId));
  const files = await setupStore(c).listFiles(actorContext(c, command.tableId));
  const findings = checkPair(
    { source, sha256 },
    offered.rows,
    {
      ...settings,
      fields: settings.fields.map((definition) => ({
        ...definition,
        type: pairFieldType(fields.find((field) => field.id === definition.fieldId) ?? { type: 'text' }),
      })),
    },
    examples.flatMap((example) => {
      const file = files.find((file) => file.id === example.fileId);
      return file ? [{ id: example.id, sha256: file.sha256 }] : [];
    }),
  );
  if (findings.some((finding) => finding.blocks))
    throw new SetupRefusal('ingest.setup.pairBlocked', { findings });
  if (findings.length) {
    const confirmationHash = createHash('sha256')
      .update(
        JSON.stringify({
          tableId: command.tableId,
          formatId: command.formatId,
          sha256,
          rows: offered.rows,
          own: offered.own,
          output: outputFingerprint(settings, fields),
          findings,
        }),
      )
      .digest('hex');
    const previous =
      command.confirm && command.confirmationId
        ? await query<{ result: Result }>(
            c.db,
            sql`SELECT result FROM ${ident(c.schemas.app, 'commands')} WHERE id = ${command.confirmationId}
        AND org_id = ${c.actor.orgId} AND actor_id = ${c.actor.userId} AND database_id = ${c.databaseId}`,
          )
        : null;
    if (
      !previous?.rows.some(
        ({ result }) =>
          result.status === 'rejected' &&
          result.error?.messageKey === 'ingest.setup.confirmPair' &&
          result.details?.confirmationHash === confirmationHash,
      )
    )
      throw new SetupRefusal('ingest.setup.confirmPair', {
        findings,
        needsConfirmation: true,
        confirmationId: command.id,
        confirmationHash,
      });
  }
  return findings;
}

async function addExample(
  c: CommandContext,
  command: Extract<IngestSetupCommand, { kind: 'ingest.example.add' }>,
  settings: IngestTableSettings,
  outsideWrites: OriginalRow[],
) {
  await requireEvidenceAccess(c, command.tableId);
  const store = setupStore(c);
  const context = actorContext(c, command.tableId);
  if (!(await store.readFormat(context, command.formatId)))
    throw new AppError('not_found', 'errors.notFound');
  const fileInput = {
    name: command.file.name,
    bytes: uploadBytes(command.file),
    statedType: command.file.mediaType,
  };
  const checked = await inspectOriginal(c.db, c.schemas.app, c.fileConfig!, c.actor.orgId, fileInput);
  const extracted = await extractSource(fileInput.name, fileInput.bytes);
  if (extracted.status !== 'extracted') throw new AppError('validation_failed', extracted.messageKey);
  const offered = await expectedRows(c, command, settings);
  const matching = await matchingDraft(c, command.tableId, checked.sha256, offered.rows);
  if (matching)
    return {
      draft: draftResponse(matching, true),
      requiresSpotChecks: true,
      messageId: 'ingest.drafts.matchesDraft',
    };
  const findings = await validateOfferedPair(c, command, settings, offered, checked.sha256, extracted.source);
  const file = await store.createFile(context, {
    origin: 'drop',
    name: fileInput.name,
    mediaType: checked.type,
    sha256: checked.sha256,
    sizeBytes: fileInput.bytes.length,
    storedFile: null,
  });
  const original = await storeOriginal(
    c.db,
    c.schemas.app,
    c.fileConfig!,
    { ...context, fileId: file.id, userId: c.actor.userId },
    fileInput,
    (row) => outsideWrites.push(row),
  );
  await store.updateFile(context, file.id, {
    storedFile: original.id,
    formatId: command.formatId,
    checks: { safety: checked.safety, findings },
  });
  const example = await store.createExample(context, {
    formatId: command.formatId,
    fileId: file.id,
    expected: offered.rows,
    own: offered.own,
    confirmedFindings: findings.filter((finding) => !finding.blocks),
  });
  // Adding a pair changes what the saved rules must reproduce.  No old all-pairs verdict remains current.
  await store.saveFormatChecks(context, command.formatId, {});
  return { example, findings };
}

async function saveRules(
  c: CommandContext,
  command: Extract<IngestSetupCommand, { kind: 'ingest.format.rules' }>,
  settings: IngestTableSettings,
  prepared?: PreparedAiPairs,
) {
  if (c.builtIngestEvidence) {
    const build = await query<{ state: string }>(
      c.db,
      sql`SELECT state FROM ${ident(c.schemas.app, 'ingest_builds')}
      WHERE id = ${c.builtIngestEvidence.buildId} AND org_id = ${c.actor.orgId} AND table_id = ${command.tableId}
      AND format_id = ${command.formatId} AND user_id = ${c.actor.userId} FOR UPDATE`,
    );
    if (build.rows[0]?.state !== 'running') throw new AppError('conflict', 'ingest.build.finished');
  }
  await requireEvidenceAccess(c, command.tableId);
  const context = actorContext(c, command.tableId);
  const store = setupStore(c);
  const before = await store.readFormat(context, command.formatId);
  if (!before) throw new AppError('not_found', 'errors.notFound');
  if (before.revision !== command.revision) throw stale();
  let definition: FormatDefinition;
  if (command.reading === 'layout') {
    try {
      definition = {
        ...before,
        signature: command.signature,
        reading: 'layout',
        rules: parseLayout(command.rules),
      };
    } catch {
      throw new AppError('validation_failed', 'ingest.layout.invalidData');
    }
  } else if (command.reading === 'reader') {
    definition = {
      ...before,
      signature: command.signature,
      reading: 'reader',
      rules: parse(
        z.strictObject({
          code: z.string().min(1).max(1_000_000),
          toolkitVersion: z.string().min(1).max(200),
          facts: z.record(z.string(), z.json()).optional(),
          bindings: ReaderBindings.optional(),
          anonymousSheets: z.boolean().optional(),
        }),
        command.rules,
      ),
    };
  } else {
    if (command.rules !== null) throw new AppError('validation_failed', 'ingest.tables.invalid');
    definition = { ...before, signature: command.signature, reading: 'ai', rules: null };
  }
  const evidence = await setupEvidence(c, command.tableId, settings);
  if (
    (command.reading === 'ai' &&
      (!prepared || prepared.fingerprint !== (await aiPairsFingerprint(c, evidence, command.tableId)))) ||
    (c.builtIngestEvidence &&
      c.builtIngestEvidence.fingerprint !==
        buildFingerprint(settings, evidence.examples, evidence.files, evidence.fields))
  )
    throw stale();
  const signatures = checkPairSignatures(
    evidence.formats.map((format) =>
      format.id === before.id ? { ...format, signature: command.signature } : format,
    ),
    evidence.examples.flatMap((example) => {
      const source = evidence.sources.get(example.id);
      return source ? [{ id: example.id, formatId: example.formatId, source }] : [];
    }),
  );
  const format = await store.updateFormat(
    context,
    before.id,
    command.revision,
    definition,
    valueSources(
      definition,
      settings.fields.map((field) => field.key),
    ),
  );
  const pairs =
    command.reading === 'ai'
      ? prepared!.pairs
      : (c.builtIngestEvidence?.pairs ??
        (await runFormatPairs(
          { id: command.tableId, ingest: settings },
          format,
          evidence.examples.filter((example) => example.formatId === format.id),
          {
            actor: context,
            store,
            fieldTypes: Object.fromEntries(
              settings.fields.map((definition) => [
                definition.key,
                pairFieldType(
                  evidence.fields.find((field) => field.id === definition.fieldId) ?? { type: 'text' },
                ),
              ]),
            ),
            loadOriginal: (file) => loadOriginal(c.db, c.schemas.app, c.fileConfig!, file),
            readWithReader: async (source, reader) => {
              if (reader.reading !== 'reader' || reader.rules.toolkitVersion !== TOOLKIT_VERSION)
                throw new AppError('validation_failed', 'ingest.setup.toolkitVersion');
              const result = await runReader(source, reader.rules.code, {}, reader.rules.facts, {
                bindings: reader.rules.bindings,
                anonymousSheets: reader.rules.anonymousSheets,
              });
              if (result.status !== 'read') throw new AppError('validation_failed', result.messageKey);
              return result.rows;
            },
          },
        )));
  if (command.reading === 'ai')
    for (const example of pairs.examples)
      await store.updateExample(context, example.exampleId, { lastResult: example.result });
  if (signatures.some((finding) => finding.kind === 'other-signature-matched'))
    throw new SetupRefusal('ingest.setup.signatureOverlap', { signatures, pairs });
  const checks = {
    signatures,
    pairs,
    outputFingerprint: outputFingerprint(settings, evidence.fields),
    formatRevision: format.revision,
  };
  if (c.builtIngestEvidence) {
    for (const { exampleId, result } of pairs.examples)
      await store.updateExample(context, exampleId, { lastResult: result });
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'ingest_builds')}
      SET state = 'passed', status = ${JSON.stringify(c.builtIngestEvidence.status)}::jsonb
      WHERE id = ${c.builtIngestEvidence.buildId}`,
    );
  }
  await store.saveFormatChecks(context, format.id, checks);
  return { format: { ...format, checks }, signatures, pairs };
}

async function goLive(
  c: CommandContext,
  command: Extract<IngestSetupCommand, { kind: 'ingest.goLive' }>,
  settings: IngestTableSettings,
  mutations: Mutation[],
  door: Door,
) {
  requireSetupPerson(c.actor, door);
  if (settings.state !== 'setup') throw wrongState();
  const evidence = await setupEvidence(c, command.tableId, settings);
  if (!evidence.readiness.ready)
    throw new SetupRefusal('ingest.setup.notReady', { readiness: evidence.readiness });
  c.ingestCapability = ingestCapability;
  const store = setupStore(c);
  const context = actorContext(c, command.tableId);
  const process = new Map(
    evidence.fields
      .filter((field) => field.ingest?.role === 'process')
      .map((field) => [field.ingest!.key, field.id]),
  );
  for (const [key, type] of Object.entries(INGEST_PROCESS_FIELDS)) {
    if (process.has(key)) continue;
    const names = messages['en-US'];
    const baseName = names[`ingest.names.${key}` as keyof typeof names];
    const name = await availableName(c, command.tableId, 'fields', baseName);
    const field = parse(FieldCreate, {
      id: newId('field'),
      name,
      type,
      ...(key === 'received' ? { options: { includeTime: true } } : {}),
    });
    mutations.push(
      await applyFields(c, {
        id: command.id,
        groupId: newId('action'),
        kind: 'field.create',
        tableId: command.tableId,
        field,
      }),
    );
    await store.markField(context, field.id, { role: 'process', key });
    process.set(key, field.id);
  }
  const reviewName = await availableName(
    c,
    command.tableId,
    'views',
    messages['en-US']['ingest.names.reviewView'],
  );
  mutations.push(
    await applySchema(c, {
      id: command.id,
      groupId: newId('action'),
      kind: 'view.create',
      view: {
        id: newId('view'),
        tableId: command.tableId,
        name: reviewName,
        type: 'grid',
        config: parse(GridConfig, {
          filter: {
            conjunction: 'and',
            conditions: [
              { id: 'needsReview', fieldId: process.get('needsReview')!, operator: 'is', value: true },
            ],
          },
        }),
      },
    }),
  );
  const views = await loadViews(c.db, c.schemas, [command.tableId]);
  const defaultView = views[0];
  if (defaultView)
    mutations.push(
      await applySchema(c, {
        id: command.id,
        groupId: newId('action'),
        kind: 'view.update',
        viewId: defaultView.id,
        config: {
          hiddenFieldIds: [
            ...new Set([
              ...defaultView.config.hiddenFieldIds,
              ...['readByAi', 'source', 'received'].map((key) => process.get(key)!),
            ]),
          ],
        },
      }),
    );
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'ingest_formats')} SET state = CASE WHEN id = ANY(${evidence.formats
      .filter((format) => {
        const examples = evidence.examples.filter((example) => example.formatId === format.id);
        return (
          examples.length > 0 &&
          examples.every(
            (example) =>
              example.lastResult?.passed &&
              !example.lastResult.differences.length &&
              !evidence.unavailable.includes(example.id) &&
              !(evidence.findings.get(example.id) ?? []).some((finding) => finding.blocks),
          ) &&
          format.checks?.outputFingerprint === outputFingerprint(settings, evidence.fields) &&
          format.checks?.formatRevision === format.revision &&
          !formatSignatureFindings(evidence.signatures, format.id).length &&
          !evidence.readiness.formats
            .find((candidate) => candidate.formatId === format.id)!
            .gaps.some((gap) => gap.messageId === 'ingest.ready.valueSource')
        );
      })
      .map((format) => format.id)}::text[]) THEN 'live' ELSE 'draft' END, updated_at = now()
    WHERE org_id = ${c.actor.orgId} AND table_id = ${command.tableId}`,
  );
  return {
    settings: await saveSettings(c, command.tableId, settings, {
      ...settings,
      state: 'live',
      ownerId: c.actor.userId,
    }),
    readiness: evidence.readiness,
  };
}

async function availableName(
  c: CommandContext,
  tableId: string,
  catalog: 'fields' | 'views',
  base: string,
): Promise<string> {
  const used = await query<{ name: string }>(
    c.db,
    sql`SELECT name FROM ${ident(c.schemas.app, catalog)} WHERE table_id = ${tableId} AND trashed_at IS NULL`,
  );
  const names = new Set(used.rows.map((row) => row.name.toLowerCase()));
  let name = base;
  for (let number = 2; names.has(name.toLowerCase()); number++) name = `${base} ${number}`;
  return name;
}

async function redoSetup(
  c: CommandContext,
  command: Extract<IngestSetupCommand, { kind: 'ingest.redo' }>,
  settings: IngestTableSettings,
) {
  if (command.revision !== settings.revision) throw stale();
  const store = setupStore(c);
  const context = actorContext(c, command.tableId);
  const formats = await store.listFormats(context);
  const examples = await store.listExamples(context);
  const fields = await loadFields(c.db, c.schemas, [command.tableId]);
  const catalogs = ['ingest_rules', 'ingest_questions', 'ingest_answers'] as const;
  const erased: Record<string, unknown> = {
    output: {
      rowMeaning: Boolean(settings.rowMeaning),
      identityDecided: Boolean(settings.identityDecided),
      fields: settings.fields.map(({ fieldId }) => ({ fieldId })),
      fieldCount: settings.fields.length,
    },
    formats: formats.map(({ id }) => ({ id })),
    examples: examples.map(({ id, formatId, fileId }) => ({ id, formatId, fileId })),
    fieldMarks: fields.filter((field) => field.ingest).map((field) => ({ fieldId: field.id })),
    fieldMarkCount: fields.filter((field) => field.ingest).length,
  };
  for (const catalog of catalogs) {
    const rows = await query(
      c.db,
      sql`SELECT id FROM ${ident(c.schemas.app, catalog)} WHERE org_id = ${c.actor.orgId} AND table_id = ${command.tableId} ORDER BY id`,
    );
    erased[catalog] = rows.rows;
  }
  const stays = {
    fields: fields.map(({ id }) => ({ id })),
    fieldCount: fields.length,
    senders: (await store.listSenders(context)).map(({ id }) => ({ id })),
    files: (await store.listFiles(context)).map(({ id }) => ({ id })),
  };
  if (command.dryRun) return { erased, stays };
  if (!command.confirm) throw new AppError('validation_failed', 'ingest.setup.confirmRedo');
  for (const format of formats) await store.removeFormat(context, format.id, await keepDays(c, settings));
  for (const catalog of ['ingest_rules', 'ingest_answers', 'ingest_questions'])
    await query(
      c.db,
      sql`DELETE FROM ${ident(c.schemas.app, catalog)} WHERE org_id = ${c.actor.orgId} AND table_id = ${command.tableId}`,
    );
  for (const field of fields.filter((field) => field.ingest)) await store.markField(context, field.id, null);
  return {
    erased,
    stays,
    settings: await saveSettings(c, command.tableId, settings, {
      ...settings,
      state: 'setup',
      ownerId: null,
      rowMeaning: '',
      identity: null,
      identityDecided: false,
      fields: [],
    }),
  };
}

/** Store only an inventory because other command buses can replay it without this response projection. */
async function visibleRedoResult(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  databaseId: string,
  result: Result,
): Promise<Result> {
  if (!result.output || result.status === 'rejected') return result;
  const { pool, schemas } = dataStore(app.ctx);
  return withTransaction(pool, async (db) => {
    const scope = new AccessScope(db, schemas, actor);
    await scope.require(databaseId, 'editSchema');
    const erased = result.output!.erased as Record<string, unknown>;
    const output = erased.output as { fields: Array<{ fieldId: string }> };
    const marks = erased.fieldMarks as Array<{ fieldId: string }>;
    const stays = result.output!.stays as { fields: Array<{ id: string }>; senders: Array<{ id: string }> };
    const kept = new Set(stays.fields.map((field) => field.id));
    const fields = scope
      .visibleFields(tableId, await loadFields(db, schemas, [tableId]))
      .filter((field) => kept.has(field.id))
      .map(({ id, name, type }) => ({ id, name, type }));
    const visible = new Set(fields.map((field) => field.id));
    const store = setupStore({ db, schemas, actor, databaseId, appContext: app.ctx });
    const keptSenders = new Set(stays.senders.map((sender) => sender.id));
    const senders = (await store.listSenders({ orgId: actor.orgId, tableId })).filter((sender) =>
      keptSenders.has(sender.id),
    );
    const count = await query<{ count: string }>(
      db,
      sql`SELECT count(*) AS count FROM ${ident(schemas.data, tableId)} WHERE ${scope.recordPredicate(tableId)}`,
    );
    return {
      ...result,
      output: {
        ...result.output,
        erased: {
          ...erased,
          output: { ...output, fields: output.fields.filter((field) => visible.has(field.fieldId)) },
          fieldMarks: marks.filter((field) => visible.has(field.fieldId)),
        },
        stays: {
          ...stays,
          rows: Number(count.rows[0]!.count),
          fields,
          senders,
        },
      },
    };
  });
}

async function applySetup(
  c: CommandContext,
  command: IngestSetupCommand,
  mutations: Mutation[],
  outsideWrites: OriginalRow[],
  door: Door,
  prepared?: PreparedAiPairs,
): Promise<Record<string, unknown>> {
  const parent = await table(c, command.tableId);
  const scope = await scopeOf(c, parent.id);
  await scope.require(c.databaseId, 'editSchema');
  await query(c.db, sql`SELECT id FROM ${ident(c.schemas.app, 'tables')} WHERE id = ${parent.id} FOR UPDATE`);
  const settings = parent.ingest ?? null;
  const store = setupStore(c);
  const context = actorContext(c, parent.id);
  if (command.kind === 'ingest.begin') {
    if (settings) throw wrongState();
    if (parent.source || parent.joined) throw new AppError('conflict', 'ingest.tables.exclusive');
    const ai = await settingsFor(c.appContext!, c.actor.orgId, undefined, c.db);
    if (!ai.enabled || !ai.ingest) throw new AppError('forbidden', 'ingest.setup.disabled');
    return {
      settings: await saveSettings(c, parent.id, null, {
        state: 'setup',
        ownerId: null,
        rowMeaning: '',
        identity: null,
        identityDecided: false,
        fields: [],
        originals: { keepDays: null, readOnlyAccess: false },
        reply: true,
      }),
    };
  }
  const current = requireSettings(settings);
  switch (command.kind) {
    case 'ingest.draft.start':
    case 'ingest.draft.correct':
    case 'ingest.draft.discard':
    case 'ingest.draft.checks':
    case 'ingest.draft.answer':
    case 'ingest.draft.confirm':
      requireSetupPerson(c.actor, door);
      return applyDraftCommand(c, command, current, outsideWrites, await keepDays(c, current));
    case 'ingest.output':
      return outputFormat(c, command, current, mutations);
    case 'ingest.propose':
      return proposeSheet(
        await setupSheet(c, {
          name: command.file.name,
          bytes: uploadBytes(command.file),
          statedType: command.file.mediaType,
        }),
      );
    case 'ingest.sender.add':
      return {
        sender: await store.createSender(context, {
          label: command.label,
          kind: command.senderKind,
          value: command.value,
          approved: command.approved,
        }),
      };
    case 'ingest.sender.update':
      return {
        sender: await store.updateSender(context, command.senderId, {
          ...(command.label !== undefined ? { label: command.label } : {}),
          ...(command.approved !== undefined ? { approved: command.approved } : {}),
        }),
      };
    case 'ingest.sender.remove':
      await store.removeSender(context, command.senderId);
      return {};
    case 'ingest.format.add':
      return {
        format: await store.createFormat(context, {
          name: command.name,
          state: 'draft',
          signature: { id: randomUUID(), kind: 'text', headerGroups: [], markers: [randomUUID()] },
          reading: 'ai',
          rules: null,
          probationPassed: 0,
        }),
      };
    case 'ingest.format.rename':
      await requireEvidenceAccess(c, parent.id);
      return { format: await store.renameFormat(context, command.formatId, command.name) };
    case 'ingest.format.remove':
      await store.removeFormat(context, command.formatId, await keepDays(c, current));
      return {};
    case 'ingest.format.rules':
      return saveRules(c, command, current, prepared);
    case 'ingest.example.add':
      return addExample(c, command, current, outsideWrites);
    case 'ingest.example.remove':
      await store.removeExample(context, command.exampleId, await keepDays(c, current));
      return {};
    case 'ingest.goLive':
      return goLive(c, command, current, mutations, door);
    case 'ingest.pause':
      if (current.state !== 'live') throw wrongState();
      return { settings: await saveSettings(c, parent.id, current, { ...current, state: 'paused' }) };
    case 'ingest.resume':
      if (current.state !== 'paused') throw wrongState();
      return { settings: await saveSettings(c, parent.id, current, { ...current, state: 'live' }) };
    case 'ingest.takeOver':
      requireSetupPerson(c.actor, door);
      return {
        previousOwnerId: current.ownerId,
        settings: await saveSettings(c, parent.id, current, { ...current, ownerId: c.actor.userId }),
      };
    case 'ingest.redo':
      return redoSetup(c, command, current);
    case 'ingest.turnOff':
      await saveSettings(c, parent.id, current, null);
      return { settings: null };
  }
}

interface StoredSetupDescriptor {
  tableId: string;
  kind: IngestSetupCommand['kind'];
  fieldIds: string[];
  evidence: boolean;
}

/** Shared replay has only an envelope or the redo inventory, never evidence or uploaded values. */
function sharedSetupResult(result: Result, command: IngestSetupCommand): Result {
  return {
    id: result.id,
    status: result.status,
    ...(result.seq !== undefined ? { seq: result.seq } : {}),
    ...(result.error
      ? {
          error: {
            code: result.error.code,
            messageKey: result.error.messageKey,
            userFault: result.error.userFault,
          },
        }
      : {}),
    ...(command.kind === 'ingest.redo' && result.output ? { output: result.output } : {}),
    ...(result.details?.confirmationHash
      ? {
          details: {
            confirmationHash: result.details.confirmationHash,
            confirmationId: result.details.confirmationId,
            needsConfirmation: true,
          },
        }
      : {}),
  };
}

async function storeSetupResponse(c: CommandContext, command: IngestSetupCommand, result: Result) {
  const descriptor: StoredSetupDescriptor = {
    tableId: command.tableId,
    kind: command.kind,
    fieldIds: (await loadFields(c.db, c.schemas, [command.tableId], { includeTrashed: true })).map(
      (field) => field.id,
    ),
    evidence:
      command.kind.startsWith('ingest.draft.') ||
      ['ingest.example.add', 'ingest.format.rules', 'ingest.format.rename', 'ingest.goLive'].includes(
        command.kind,
      ),
  };
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'commands')}
    SET ingest_result = ${JSON.stringify({ ...descriptor, result })}::jsonb WHERE id = ${command.id}`,
  );
}

/** Authorize the saved operation before loading its private response, regardless of the replay input. */
async function visibleSetupResponse(
  app: FastifyInstance,
  actor: Actor,
  command: IngestSetupCommand,
  databaseId: string,
  result: Result,
  door: Door,
): Promise<Result> {
  const { pool, schemas } = dataStore(app.ctx);
  const projected = await withTransaction(pool, async (db) => {
    const c: CommandContext = {
      db,
      schemas,
      actor,
      databaseId,
      appContext: app.ctx,
      fileConfig: app.ctx.config,
    };
    await lock(c, [`database:${databaseId}`]);
    const scope = await scopeOf(c, command.tableId);
    await scope.require(databaseId, 'editSchema');
    const saved = await query<{ descriptor: StoredSetupDescriptor }>(
      db,
      sql`SELECT ingest_result - 'result' AS descriptor FROM ${ident(schemas.app, 'commands')}
        WHERE id = ${command.id} AND org_id = ${actor.orgId} AND actor_id = ${actor.userId}
          AND database_id = ${databaseId} AND ingest_result IS NOT NULL`,
    );
    const descriptor = saved.rows[0]?.descriptor;
    if (!descriptor) return result;
    if (descriptor.tableId !== command.tableId || descriptor.kind !== command.kind)
      throw new AppError('not_found', 'errors.notFound');
    if (descriptor.kind === 'ingest.goLive') requireSetupPerson(actor, door);
    if (descriptor.evidence) await requireEvidenceAccess(c, descriptor.tableId, descriptor.fieldIds);
    const response = await query<{ result: Result }>(
      db,
      sql`SELECT ingest_result->'result' AS result FROM ${ident(schemas.app, 'commands')}
        WHERE id = ${command.id}`,
    );
    const original = response.rows[0]!.result;
    return { ...original, status: result.status };
  });
  return command.kind === 'ingest.redo'
    ? visibleRedoResult(app, actor, command.tableId, databaseId, projected)
    : projected;
}

/** Setup commands share the bus's locks, savepoints, replay store, and transaction deadlines. */
export async function runIngestSetupCommand(
  app: FastifyInstance,
  actor: Actor,
  input: unknown,
  door: Door = 'person',
  builtEvidence?: BuiltEvidence,
): Promise<Result> {
  refuseDemo(actor);
  const command = parse(IngestSetupCommand, input);
  const { pool, schemas } = dataStore(app.ctx);
  const parent = await loadTable(pool, schemas, command.tableId);
  if (!parent || parent.orgId !== actor.orgId || parent.trashed)
    throw new AppError('not_found', 'errors.notFound');
  // Replays recheck access too, since stored output may contain setup evidence.
  await new AccessScope(pool, schemas, actor).require(parent.databaseId, 'editSchema');
  if (command.kind === 'ingest.goLive' || command.kind.startsWith('ingest.draft.'))
    requireSetupPerson(actor, door);
  const outsideWrites: OriginalRow[] = [];
  try {
    const prepared = await prepareAiPairs(app, actor, command);
    const result = await runStored<Result>(
      app,
      actor,
      parent.databaseId,
      {
        commandId: command.id,
        groupId: command.id,
        long: true,
        duplicate: (value) => {
          const result = value as Result;
          return result.status === 'applied' ? { ...result, status: 'duplicate' } : result;
        },
        storedResult: (result) => sharedSetupResult(result, command),
        afterStore: (c, result) => storeSetupResponse(c, command, result),
        rejected: (error) => ({
          id: command.id,
          status: 'rejected',
          error: error.toBody().error,
          ...(error instanceof SetupRefusal ? { details: error.details } : {}),
        }),
      },
      async (c) => {
        c.builtIngestEvidence = builtEvidence;
        const beforeFields = await loadFields(c.db, schemas, [command.tableId]);
        const mutations: Mutation[] = [];
        const output = await applySetup(c, command, mutations, outsideWrites, door, prepared);
        let seq: number | undefined;
        if (command.kind !== 'ingest.propose' && !(command.kind === 'ingest.redo' && command.dryRun)) {
          const current = (await loadTable(c.db, schemas, command.tableId))!;
          const fields = await loadFields(c.db, schemas, [command.tableId]);
          // Field marks are part of the metadata collaborators need after this setup command.
          for (const field of fields.filter(
            (field) =>
              JSON.stringify(field) !== JSON.stringify(beforeFields.find((before) => before.id === field.id)),
          ))
            mutations.push({
              body: { kind: 'field.updated', field: publicField(field), removedChoiceIds: [] },
              prev: {},
            });
          mutations.push({ body: { kind: 'table.updated', table: publicTable(current) }, prev: {} });
          for (const mutation of mutations)
            seq = await recordChange(c, mutation, {
              commandId: command.id,
              groupId: command.id,
              clientId: null,
              system: true,
            });
        }
        await auditEvent(c.db, compile(sql`${ident(schemas.audit)}`).text, `data.${command.kind}`, actor, {
          tableId: command.tableId,
          commandId: command.id,
          ...(command.kind === 'ingest.takeOver' ? { previousOwnerId: output.previousOwnerId } : {}),
        });
        return { id: command.id, status: 'applied', output, ...(seq !== undefined ? { seq } : {}) };
      },
    );
    const visible = await visibleSetupResponse(app, actor, command, parent.databaseId, result, door);
    if (command.kind === 'ingest.draft.start' && visible.status !== 'rejected') {
      const draft = visible.output?.draft as { id: string } | undefined;
      if (draft) startDraftWork(app, actor, command.tableId, draft.id);
    }
    return visible;
  } finally {
    for (const original of outsideWrites) {
      const kept = await query(
        pool,
        sql`SELECT id FROM ${ident(schemas.app, 'files')} WHERE id = ${original.id}`,
      );
      if (!kept.rowCount)
        await fileStorage(original.storage, pool, schemas.app, app.ctx.config).delete(original.storage_key);
    }
  }
}

async function readSetup<T>(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  read: (c: CommandContext, settings: IngestTableSettings) => Promise<T>,
): Promise<T> {
  refuseDemo(actor);
  const { pool, schemas } = dataStore(app.ctx);
  return withTransaction(pool, async (db) => {
    const parent = await loadTable(db, schemas, tableId);
    if (!parent || parent.orgId !== actor.orgId || parent.trashed)
      throw new AppError('not_found', 'errors.notFound');
    const c: CommandContext = {
      db,
      schemas,
      actor,
      databaseId: parent.databaseId,
      appContext: app.ctx,
      fileConfig: app.ctx.config,
    };
    await (await scopeOf(c, tableId)).require(parent.databaseId, 'read');
    await lock(c, [`database:${parent.databaseId}`]);
    const current = (await loadTable(db, schemas, tableId))!;
    return read(c, requireSettings(current.ingest));
  });
}

export async function readIngestReadiness(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
): Promise<IngestReadiness> {
  return readSetup(
    app,
    actor,
    tableId,
    async (c, settings) => (await setupEvidence(c, tableId, settings)).readiness,
  );
}

export async function readIngestSetup(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
): Promise<IngestSetupDetails> {
  return readSetup(app, actor, tableId, async (c, settings) => {
    await requireEvidenceAccess(c, tableId);
    const store = setupStore(c);
    const context = { orgId: actor.orgId, tableId };
    return IngestSetupDetails.parse({
      settings,
      fields: (await loadFields(c.db, c.schemas, [tableId])).map(publicField),
      formats: await store.listFormats(context),
      examples: await store.listExamples(context),
      senders: await store.listSenders(context),
      files: (await store.listFiles(context)).map(
        ({
          id,
          name,
          mediaType,
          sizeBytes,
          sha256,
          receivedAt,
          expiresAt,
          formatId,
          senderId,
          isExample,
        }) => ({
          id,
          name,
          mediaType,
          sizeBytes,
          sha256,
          receivedAt,
          expiresAt,
          formatId,
          senderId,
          isExample,
        }),
      ),
    });
  });
}

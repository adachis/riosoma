import { AppError, newId } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '@riosoma/db';
import type { Actor } from '../../http/policy.js';
import { IngestTableStore } from '../tables/store.js';
import { dataStore } from '../../data/context.js';
import { loadFields } from '../../data/metadata.js';
import { uniqueName } from '../../data/imports/core/names.js';
import { actorFor } from '../../automations/run.js';
import { runCommands } from '../../data/commands/index.js';
import type { StoredTable } from '../../data/types.js';
import { liveAccess } from '../live/access.js';
import type { IngestWorker } from '../pipeline/worker.js';
import type { IngestClaim } from '../pipeline/types.js';
import { ingestCapability } from '../tables/capability.js';
import { checkpointStudy, type StudyDocument } from './store.js';

/** Field requests from record editors stay visible without acquiring schema authority. */
export async function ownField(
  worker: IngestWorker,
  claim: IngestClaim,
  table: StoredTable,
  study: StudyDocument,
  heading: string,
  questionId: string,
): Promise<string | null> {
  const answer = await worker.store.decisions.findAnswer(claim.file, questionId);
  const { pool, schemas } = worker.store.data;
  const actor = answer?.answeredBy ? await actorFor(pool, schemas, answer.answeredBy, table.orgId) : null;
  const access = actor ? await liveAccess(worker.app, actor, table.id) : null;
  if (!access?.schema || !actor) {
    if (!study.fieldRequests.includes(heading)) study.fieldRequests.push(heading);
    return null;
  }
  prepareField(table, study, heading);
  await checkpointStudy(worker.store, claim, study);
  return worker.store.fenced(claim, (db, _file, current) =>
    createStudyField(worker.app, actor, current, study, heading, db, table),
  );
}

function prepareField(table: StoredTable, study: StudyDocument, heading: string) {
  study.createdFields ??= {};
  let created = study.createdFields[heading];
  if (!created) {
    let index = table.ingest!.fields.length + 1;
    while (table.ingest!.fields.some((field) => field.key === `column${index}`)) index++;
    created = { key: `column${index}`, fieldId: newId('field'), commandId: newId('command') };
    study.createdFields[heading] = created;
  }
  return created;
}

/** Field creation shares the answer transaction so rejected corrections cannot leave schema behind. */
export async function createStudyField(
  app: FastifyInstance,
  actor: Actor,
  current: StoredTable,
  study: StudyDocument,
  heading: string,
  db: Queryable,
  table: StoredTable = current,
) {
  const target = prepareField(current, study, heading);
  const { pool, schemas } = dataStore(app.ctx);
  const file = { orgId: current.orgId, tableId: current.id };
  const fields = await loadFields(db, schemas, [table.id]);
  const name =
    fields.find((field) => field.id === target.fieldId)?.name ??
    uniqueName(new Set(fields.map((field) => field.name.toLowerCase())), heading, heading);

  const result = await runCommands(
    app,
    actor,
    table.databaseId,
    {
      clientId: newId('client'),
      commands: [
        {
          id: target.commandId,
          groupId: newId('action'),
          kind: 'field.create',
          tableId: table.id,
          field: { id: target.fieldId, name, type: 'text', options: {}, isPrimary: false },
        },
      ],
    },
    db,
    undefined,
    undefined,
    { ingestCapability },
  );
  if (result.results.some((item) => item.status !== 'applied' && item.status !== 'duplicate'))
    throw new AppError('conflict', 'ingest.study.fieldRequest');
  const tables = new IngestTableStore(pool, schemas).inTransaction(db);
  if (!current.ingest!.fields.some((field) => field.key === target.key)) {
    await tables.markField({ ...file, userId: actor.userId }, target.fieldId, {
      key: target.key,
      role: 'data',
    });
    const changed = await tables.changeSettings({ ...file, userId: actor.userId }, current.ingest!.revision, {
      ...current.ingest!,
      fields: [
        ...current.ingest!.fields,
        { key: target.key, fieldId: target.fieldId, meaning: '', required: false },
      ],
    });
    table.ingest = changed ?? undefined;
  } else table.ingest = current.ingest ?? undefined;
  return target.key;
}

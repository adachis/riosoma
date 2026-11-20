import { ident, query, sql } from '@riosoma/db';
import { loadFields, loadTable } from '../../data/metadata.js';
import { loadOriginal } from '../../data/files/originals.js';
import { PairReadFailed, pairFieldType, runFormatPairs, type PairReader } from '../pairs/index.js';
import type { IngestWorker } from '../pipeline/worker.js';
import type { IngestClaim } from '../pipeline/types.js';
import type { IngestContext } from '../tables/store.js';
import { readFormat } from '../pipeline/reading.js';

/** Pair evaluation stays outside command locks and stores its result only for the evaluated revision. */
export async function recheckFormat(
  worker: IngestWorker,
  context: IngestContext,
  formatId: string,
  claim?: IngestClaim,
) {
  const { pool, schemas } = worker.store.data;
  const format = await worker.store.tables.readFormat(context, formatId);
  const table = await loadTable(pool, schemas, context.tableId);
  if (!format || !table?.ingest) return;
  const fields = await loadFields(pool, schemas, [table.id]);
  const examples = await worker.store.tables.listExamples(context, formatId);
  if (!examples.length) return { passed: true, examples: [] };
  const readExample: PairReader = async (source, definition, _output, file) => {
    const reading = await readFormat(source, definition, table, file, {}, {}, {});
    if (!reading || reading.failure)
      throw new PairReadFailed(
        reading?.failure?.messageId ?? 'ingest.pipeline.readFailed',
        reading?.failure?.params,
      );
    return reading.rows;
  };
  const result = await runFormatPairs(table, format, examples, {
    actor: { ...context, userId: null },
    fieldTypes: Object.fromEntries(
      table.ingest.fields.map((field) => [
        field.key,
        pairFieldType(fields.find((item) => item.id === field.fieldId)!),
      ]),
    ),
    store: {
      readFile: (c, id) => worker.store.tables.readFile(c, id),
      updateExample: async (_c, id, patch) => ({
        ...examples.find((example) => example.id === id)!,
        ...patch,
      }),
    },
    loadOriginal: (file) => loadOriginal(pool, schemas.app, worker.app.ctx.config, file),
    readWithLayout: readExample,
    readWithReader: readExample,
  });
  const persist = async (db: Parameters<typeof worker.store.saveJob>[0]) => {
    const current = await worker.store.tables.inTransaction(db).readFormat(context, formatId);
    if (current?.revision !== format.revision) return;
    for (const example of result.examples)
      await worker.store.tables
        .inTransaction(db)
        .updateExample({ ...context, userId: null }, example.exampleId, { lastResult: example.result });
    if (!result.passed)
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'ingest_formats')} SET state = 'failing', checks = checks || ${JSON.stringify({ examples: result.examples })}::jsonb WHERE org_id = ${context.orgId} AND table_id = ${context.tableId} AND id = ${formatId} AND revision = ${format.revision}`,
      );
  };
  if (claim) await worker.store.fenced(claim, persist);
  else await worker.store.locked(context, persist);
  return result;
}

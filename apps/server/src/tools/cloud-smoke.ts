import { smokeProfile } from '../config.js';
import { FieldSpec, newId, type FilterGroup } from '@riosoma/contracts';
import { connectDatabase, migrate, probeDatabase, sql } from '@riosoma/db';
import { createRecordTable, dropRecordTable } from '../data/physical/ddl.js';
import { orderedRids } from '../data/physical/order.js';
import { fetchPageByRid, insertRecords } from '../data/physical/records.js';
import type { ReadContext, StoredField } from '../data/types.js';
import { MIGRATIONS } from '../migrations/index.js';

/**
 * Proves Riosoma works against a real cloud Postgres: the connection check, the migrations, and
 * storing, ordering, and paging records, cleaning up the records it made.
 *
 *   RIOSOMA_SMOKE_PROFILE='<DatabaseProfile JSON>' node apps/server/dist/tools/cloud-smoke.js
 *
 * Cloud sign-in comes from each provider's usual sources (AWS environment variables, Google
 * Application Default Credentials, or the Azure service principal in the profile).  Prints a JSON
 * report and exits with 1 when anything fails.
 */

const now = new Date().toISOString();

function field(tableId: string, name: string, spec: unknown): StoredField {
  const id = newId('field');
  return {
    ...FieldSpec.parse(spec),
    id,
    tableId,
    name,
    description: '',
    position: 0,
    createdAt: now,
    updatedAt: now,
    columnName: id,
  };
}

async function main(): Promise<void> {
  const profile = smokeProfile();
  const report: Record<string, unknown> = {
    host: profile.host,
    auth: profile.auth.method,
    tls: profile.tls.mode,
  };
  const started = performance.now();
  const probe = await probeDatabase(profile);
  report.probe = probe.steps.map((step) => ({
    step: step.step,
    status: step.status,
    ms: step.elapsedMs,
    ...(step.status === 'ok' ? {} : { messageKey: step.messageKey }),
  }));
  if (!probe.ok) {
    console.log(JSON.stringify({ ...report, ok: false, error: 'connection check failed' }, null, 2));
    process.exit(1);
  }

  const db = await connectDatabase(profile);
  try {
    report.migrations = await migrate(db.pool, profile.schemas, MIGRATIONS);
    const tableId = newId('table');
    const name = field(tableId, 'Name', { type: 'text' });
    const score = field(tableId, 'Score', { type: 'number' });
    await createRecordTable(db.pool, profile.schemas.data, tableId, [name, score]);
    try {
      const rows = Array.from({ length: 2_000 }, (_, i) => ({
        id: newId('record'),
        values: { [name.id]: `Item ${i + 1}`, [score.id]: (i * 7919) % 1000 },
      }));
      let t = performance.now();
      await insertRecords(db.pool, profile.schemas.data, tableId, [name, score], rows.slice(0, 1_000), null);
      await insertRecords(db.pool, profile.schemas.data, tableId, [name, score], rows.slice(1_000), null);
      report.insertMs = Math.round(performance.now() - t);

      const natural = await db.pool.query<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
          WHERE n.nspname = $1 AND c.collname = 'rio_natural') AS ok`,
        [profile.schemas.data],
      );
      const ctx: ReadContext = { timeZone: 'UTC', now: new Date(), natural: natural.rows[0]!.ok };
      report.naturalSort = ctx.natural;
      const filter: FilterGroup = {
        conjunction: 'and',
        conditions: [{ id: 'a', fieldId: score.id, operator: 'gte', value: 500 }],
      };
      t = performance.now();
      const rids = await orderedRids(
        db.pool,
        profile.schemas,
        tableId,
        new Map([name, score].map((f) => [f.id, f])),
        { filter, sorts: [{ fieldId: name.id, direction: 'desc' }] },
        sql`TRUE`,
        ctx,
      );
      report.orderMs = Math.round(performance.now() - t);
      const expected = rows.filter((r) => (r.values[score.id] as number) >= 500).length;
      if (rids.length !== expected) throw new Error(`ordered ${rids.length} rows, expected ${expected}`);
      const page = await fetchPageByRid(
        db.pool,
        profile.schemas.data,
        tableId,
        [name, score],
        Array.from(rids.subarray(0, 200)),
      );
      const names = page.map((row) => row?.values[name.id] as string);
      const sorted = [...names].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      if (ctx.natural && names.join('|') !== sorted.join('|')) throw new Error('page is out of natural order');
      report.pageRows = page.length;
    } finally {
      await dropRecordTable(db.pool, profile.schemas.data, tableId);
    }
  } finally {
    await db.close();
  }
  report.totalMs = Math.round(performance.now() - started);
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});

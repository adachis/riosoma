import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { CATALOG_PLAN, CATALOGS, DATABASE_CATALOGS, LEFT_OUT, ORG_CATALOGS } from './catalog.js';
import { OWN_STEPS } from './import.js';
import { outsideFindings } from './outside.js';

let kit: TestPostgres;
let server: ServerFixture;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'archive_coverage');
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

/** Every table in a schema after all migrations, read from the database, so no stale list can hide one */
async function tablesIn(db: Queryable, schema: string): Promise<string[]> {
  const result = await query<{ name: string }>(
    db,
    sql`SELECT c.relname AS name FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      ORDER BY c.relname`,
  );
  return result.rows.map((row) => row.name);
}

/** The app tables with no decision: neither in the plan nor left out with a reason */
async function undecided(
  db: Queryable,
  catalogs: readonly string[] = CATALOGS,
  leftOut: Readonly<Record<string, string>> = LEFT_OUT,
): Promise<string[]> {
  return (await tablesIn(db, server.schemas.app)).filter(
    (name) => !catalogs.includes(name) && !leftOut[name]?.trim(),
  );
}

/** The audit tables with no decision, so a new one there needs a reason of its own too */
async function undecidedAudit(
  db: Queryable,
  catalogs: readonly string[] = CATALOGS,
  leftOut: Readonly<Record<string, string>> = LEFT_OUT,
): Promise<string[]> {
  return (await tablesIn(db, server.schemas.audit)).filter(
    (name) => !catalogs.includes(name) && !leftOut[name]?.trim(),
  );
}

/**
 * The names in the plan or in `LEFT_OUT` that aren't tables.  The audit log, and the record of the
 * events that expired out of it, live in a schema of their own.
 */
async function unknownNames(
  db: Queryable,
  catalogs: readonly string[] = CATALOGS,
  leftOut: Readonly<Record<string, string>> = LEFT_OUT,
): Promise<string[]> {
  const app = new Set(await tablesIn(db, server.schemas.app));
  const audit = new Set(await tablesIn(db, server.schemas.audit));
  return [...catalogs, ...Object.keys(leftOut)].filter((name) => {
    const table = /^(knowledge_libraries|knowledge_documents):personal$/.test(name)
      ? name.split(':')[0]!
      : name;
    return !app.has(table) && !audit.has(table);
  });
}

describe('organization archive catalog coverage', () => {
  it('decides every table in the app schema after all migrations', async () => {
    expect(
      await undecided(server.pool),
      'Every app table needs a place in CATALOG_PLAN or a reason in LEFT_OUT',
    ).toEqual([]);
    for (const [table, reason] of Object.entries(LEFT_OUT)) {
      expect(CATALOGS, table).not.toContain(table);
      expect(reason.trim(), table).not.toBe('');
      expect(reason, table).not.toMatch(/[\r\n]/);
    }
  });

  it('decides every table in the audit schema after all migrations', async () => {
    expect(
      await undecidedAudit(server.pool),
      'Every audit table needs a place in CATALOG_PLAN or a reason in LEFT_OUT',
    ).toEqual([]);
    // Without a decision of its own the record of expired events is undecided, so the check sees it.
    expect(await undecidedAudit(server.pool, CATALOGS, {})).toEqual(['purged']);
  });

  it('names only tables that exist', async () => {
    expect(await unknownNames(server.pool)).toEqual([]);
    expect(await unknownNames(server.pool, [...CATALOGS, 'archive_coverage_gone'])).toEqual([
      'archive_coverage_gone',
    ]);
    expect(
      await unknownNames(server.pool, CATALOGS, { ...LEFT_OUT, archive_coverage_gone: 'Removed long ago' }),
    ).toEqual(['archive_coverage_gone']);
  });

  it.each(['org_id', 'database_id', 'table_id'])(
    'fails for a new table with %s until it has an explicit decision',
    async (column) => {
      await withTransaction(server.pool, async (db) => {
        const name = `archive_coverage_${column}`;
        await query(db, sql`CREATE TABLE ${ident(server.schemas.app, name)} (${ident(column)} text)`);
        try {
          expect(await undecided(db)).toContain(name);
          expect(await undecided(db, [...CATALOGS, name])).not.toContain(name);
          expect(await undecided(db, CATALOGS, { ...LEFT_OUT, [name]: 'Temporary job state' })).not.toContain(
            name,
          );
          expect(await undecided(db, CATALOGS, { ...LEFT_OUT, [name]: ' ' })).toContain(name);
        } finally {
          await query(db, sql`DROP TABLE ${ident(server.schemas.app, name)}`);
        }
      });
    },
  );

  it('restores every catalog the export writes, each in one way', () => {
    // The export writes every planned catalog to some entry, and nothing else.
    expect(new Set([...ORG_CATALOGS, ...DATABASE_CATALOGS])).toEqual(new Set(CATALOGS));
    expect(new Set(CATALOGS).size).toBe(CATALOGS.length);
    const own = CATALOG_PLAN.filter((plan) => plan.restore === 'own').map((plan) => plan.catalog);
    // A catalog restored by a step of its own has that step in the import, and only those do.
    expect(new Set(own)).toEqual(new Set(OWN_STEPS));
    // A catalog restored only from the review list becomes a review item for each live row.
    for (const { catalog } of CATALOG_PLAN.filter((plan) => plan.restore === 'review')) {
      const row = { catalog, entry: 'organization.jsonl', row: { id: catalog }, omitted: [] };
      const findings = outsideFindings(new Map([[catalog, [row]]]), () => false);
      expect(
        findings.map((finding) => finding.catalog),
        catalog,
      ).toEqual([catalog]);
    }
  });

  it('restores each catalog after the catalogs it refers to', async () => {
    const references = await query<{ catalog: string; target: string }>(
      server.pool,
      sql`SELECT DISTINCT source.relname AS catalog, target.relname AS target
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class source ON source.oid = con.conrelid
        JOIN pg_catalog.pg_class target ON target.oid = con.confrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = source.relnamespace
        WHERE con.contype = 'f' AND NOT con.condeferred AND n.nspname = ${server.schemas.app}`,
    );
    const inserted = CATALOG_PLAN.filter((plan) => plan.restore !== 'review').map((plan) => plan.catalog);
    const checked: string[] = [];
    const early: string[] = [];
    for (const { catalog, target } of references.rows) {
      const at = inserted.indexOf(catalog);
      const before = inserted.indexOf(target);
      if (at < 0 || before < 0 || catalog === target) continue;
      checked.push(`${catalog} -> ${target}`);
      if (before > at) early.push(`${catalog} -> ${target}`);
    }
    expect(checked).toEqual(expect.arrayContaining(['tables -> databases', 'fields -> tables']));
    expect(early, 'A catalog restored before a catalog it refers to').toEqual([]);
  });
});

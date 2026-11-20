import { describe, expect, it } from 'vitest';
import { parse } from 'libpg-query';
import { rewriteSql } from './guard.js';
import { friendlyNames } from './projection.js';

const tables = new Map([
  ['People', { select: 'SELECT 1 AS "Name", 2 AS "Amount"', columns: ['Name', 'Amount'] }],
  ['Teams', { select: 'SELECT 1 AS "Name"', columns: ['Name'] }],
  ['Résumé', { select: 'SELECT 1 AS "Name"', columns: ['Name'] }],
]);
const accepted = [
  'SELECT 1',
  'SELECT 1;',
  'SELECT 1 -- end',
  '/* before */ SELECT 1 /* after */',
  'SELECT * FROM "People"',
  'SELECT "Name" FROM "People"',
  'SELECT p."Name" FROM "People" p',
  'SELECT "People"."Name" FROM "People"',
  'SELECT * FROM "Résumé"',
  'SELECT * FROM "People" p JOIN "Teams" t ON p."Name" = t."Name"',
  'SELECT * FROM "People" p LEFT JOIN "Teams" t USING ("Name")',
  'SELECT * FROM "People" CROSS JOIN "Teams"',
  'SELECT * FROM (SELECT * FROM "People") p',
  'WITH p AS (SELECT * FROM "People") SELECT * FROM p',
  'WITH p AS (WITH t AS (SELECT * FROM "People") SELECT * FROM t) SELECT * FROM p',
  'WITH p AS (SELECT * FROM "People"), t AS (SELECT * FROM p) SELECT * FROM t',
  'SELECT * FROM "People" UNION SELECT * FROM "People"',
  'SELECT * FROM "People" UNION ALL SELECT * FROM "People"',
  'SELECT * FROM "People" INTERSECT SELECT * FROM "People"',
  'SELECT * FROM "People" EXCEPT SELECT * FROM "People"',
  'SELECT count(*), sum("Amount"), avg("Amount") FROM "People"',
  'SELECT "Name", count(*) FROM "People" GROUP BY "Name" HAVING count(*) > 1',
  'SELECT row_number() OVER (PARTITION BY "Name" ORDER BY "Amount") FROM "People"',
  'SELECT sum("Amount") OVER w FROM "People" WINDOW w AS (ORDER BY "Name")',
  'SELECT * FROM "People" ORDER BY "Name" DESC NULLS LAST LIMIT 10 OFFSET 1',
  "SELECT abs(-2), lower('TEXT'), length('text')",
  "SELECT date_trunc('day', CURRENT_TIMESTAMP)",
  "SELECT jsonb_build_object('x', 1)",
  'SELECT CASE WHEN 2 > 1 THEN 3 ELSE 4 END',
  'SELECT coalesce(NULL, 1), greatest(1, 2), nullif(1, 2)',
  "SELECT 1::integer, 'text'::text, true::boolean",
  'SELECT EXISTS (SELECT 1 FROM "People")',
  'SELECT * FROM "People" WHERE "Amount" IN (1, 2)',
  'SELECT * FROM "People" WHERE "Amount" BETWEEN 1 AND 2',
  'SELECT * FROM "People" WHERE "Name" IS NOT NULL',
  'SELECT * FROM "People" WHERE "Name" LIKE \'x%\'',
  'SELECT ARRAY[1, 2], (ARRAY[1, 2])[1]',
  'SELECT \'pg_sleep(10); COPY x\' AS "pg_class"',
  // Every column reference resolves against the columns of a relation in scope.
  'SELECT p.* FROM "People" p',
  'SELECT count(p.*) FROM "People" p',
  'SELECT s.n FROM (SELECT "Name" AS n FROM "People") s',
  'SELECT s."Name" FROM (SELECT p."Name" FROM "People" p) s',
  'SELECT s."Amount" FROM (SELECT * FROM "People") s',
  'SELECT x.a, x."Amount" FROM "People" x(a)',
  'WITH c AS (SELECT count(*) AS total FROM "People") SELECT c.total FROM c',
  'WITH c(total) AS (SELECT count(*) FROM "People") SELECT c.total FROM c',
  'SELECT "Name" AS n FROM "People" ORDER BY n',
  'SELECT "Name" AS n, count(*) FROM "People" GROUP BY n',
  'SELECT u."Name" FROM "People" JOIN "Teams" USING ("Name") AS u',
  'SELECT j."Amount" FROM ("People" p JOIN "Teams" t USING ("Name")) AS j',
  'SELECT * FROM "People" NATURAL JOIN "Teams"',
  'SELECT (SELECT max(t."Name") FROM "Teams" t WHERE t."Name" = p."Name") FROM "People" p',
  'SELECT * FROM "People" p, LATERAL (SELECT p."Amount" * 2 AS twice) s WHERE s.twice > 1',
  'SELECT "Name" FROM "People" UNION SELECT "Name" FROM "Teams" ORDER BY "Name"',
  'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5) SELECT n.x FROM n',
  'WITH RECURSIVE a AS (SELECT * FROM b), b AS (SELECT "Name" FROM "People") SELECT a."Name" FROM a',
];
const rejected = [
  '',
  '-- comment only',
  'SELECT',
  'COPY "People" TO STDOUT',
  "COPY (SELECT 1) TO PROGRAM 'x'",
  'INSERT INTO "People" VALUES (1)',
  'UPDATE "People" SET "Name" = 1',
  'DELETE FROM "People"',
  'DROP TABLE "People"',
  'CREATE TABLE x (a int)',
  'EXPLAIN SELECT 1',
  'SHOW search_path',
  'SET search_path = public',
  'SELECT 1;;',
  'SELECT * FROM "People"*',
  'SELECT 1; SELECT 2',
  'SELECT 1; /* hidden */ DELETE FROM "People"',
  'SELECT * INTO other FROM "People"',
  'SELECT * FROM "People" FOR UPDATE',
  'SELECT * FROM "People" FOR SHARE',
  'SELECT * FROM "People" FOR KEY SHARE',
  'WITH x AS (DELETE FROM "People" RETURNING *) SELECT * FROM x',
  'SELECT * FROM public."People"',
  'SELECT * FROM pg_catalog.pg_class',
  'SELECT * FROM information_schema.tables',
  'SELECT * FROM pg_class',
  'SELECT * FROM "pg_class"',
  'SELECT * FROM "PG_CLASS"',
  'SELECT * FROM "Peоple"',
  'SELECT * FROM "pg＿class"',
  'SELECT pg_sleep(1)',
  'SELECT (SELECT pg_sleep(1)) FROM "People"',
  'WITH a AS (WITH b AS (SELECT pg_sleep(1)) SELECT * FROM b) SELECT * FROM a',
  "SELECT pg_read_file('/etc/passwd')",
  "SELECT pg_ls_dir('.')",
  "SELECT pg_notify('x', 'y')",
  "SELECT set_config('search_path', 'public', false)",
  "SELECT current_setting('search_path')",
  "SELECT dblink('x', 'SELECT 1')",
  "SELECT lo_import('x')",
  "SELECT lo_export(1, 'x')",
  "SELECT nextval('x')",
  'SELECT random()',
  "SELECT public.lower('x')",
  "SELECT pg_catalog.lower('x')",
  'SELECT "LOWER"(\'x\')',
  'SELECT current_user',
  'SELECT session_user',
  'SELECT current_schema',
  "SELECT 'pg_class'::regclass",
  "SELECT 'x'::public.text",
  'SELECT 1::pg_catalog.int4',
  'SELECT 1::"pg_catalog"."int4"',
  'SELECT CAST(1 AS "pg_catalog" /* hidden */ . "int4")',
  'SELECT 1 OPERATOR(public.+) 2',
  'SELECT * FROM ONLY "People"',
  'SELECT * FROM "People" TABLESAMPLE SYSTEM (1)',
  'SELECT $1',
  'WITH "pg_class" AS (SELECT 1) SELECT * FROM "pg_class"',
  'SELECT * FROM generate_series(1, 100)',
  'VALUES (1)',
  'SELECT 1\u0000; DELETE FROM "People"',
  // Attribute notation calls a function on the whole row unless the name is one of its columns.
  'SELECT p.pg_typeof FROM "People" p',
  'SELECT p.pg_column_size FROM "People" p',
  'SELECT p.hash_record FROM "People" p',
  'SELECT p.quote_literal FROM "People" p',
  'SELECT p.record_send FROM "People" p',
  'SELECT p.num_nulls FROM "People" p',
  'SELECT p.any_value FROM "People" p',
  'SELECT p.json_agg_strict FROM "People" p',
  'SELECT p.count FROM "People" p',
  'SELECT p."Name" FROM "People" p WHERE p.pg_column_size > 0 ORDER BY p.hash_record',
  'WITH c AS (SELECT 1 AS a) SELECT c.pg_typeof FROM c',
  'SELECT j.pg_typeof FROM ("People" p JOIN "Teams" t ON true) AS j',
  'SELECT "Name" FROM "People" p WHERE p.pg_typeof IS NOT NULL',
  'SELECT "Name" FROM "People" p ORDER BY p.hash_record',
  'SELECT count(*) FROM "People" p GROUP BY p.pg_typeof',
  'SELECT count(*) FROM "People" p GROUP BY p."Name" HAVING max(p.num_nulls) > 0',
  'SELECT 1 FROM "People" p JOIN "Teams" t ON p.pg_typeof = t.pg_typeof',
  'SELECT 1 FROM "People" p LEFT JOIN "Teams" t ON t."Name" = p.hash_record::text',
  'SELECT u.pg_typeof FROM "People" JOIN "Teams" USING ("Name") AS u',
  'SELECT s.pg_typeof FROM (SELECT "Name" FROM "People") s',
  'SELECT s.count FROM (SELECT count(*) FROM "People") s',
  'SELECT s.lower FROM (SELECT lower("Name") FROM "People") s',
  'SELECT s."Name" FROM (SELECT "Name"::text FROM "People") s',
  'SELECT 1 FROM "People" p, LATERAL (SELECT p.pg_typeof) s',
  'SELECT (SELECT p.pg_typeof) FROM "People" p',
  'SELECT 1 FROM "People" p WHERE EXISTS (SELECT 1 FROM "Teams" t WHERE t."Name" = p.hash_record::text)',
  'SELECT row_number() OVER (ORDER BY p.hash_record) FROM "People" p',
  'SELECT max(p.pg_column_size) FROM "People" p',
  'SELECT (SELECT 1 FROM (SELECT 1 AS pg_typeof) x, (SELECT x.pg_typeof) y) FROM "People" x',
  'SELECT (SELECT 1 FROM (SELECT 1 AS pg_typeof) x, "Teams" y JOIN "Teams" z ON x.pg_typeof IS NOT NULL) FROM "People" x',
  'WITH c(a) AS (SELECT "Name" FROM "People") SELECT c."Name" FROM c',
  'WITH c AS (SELECT * FROM "People") SELECT c.pg_typeof FROM c',
  'SELECT s.pg_typeof FROM (SELECT "Name" FROM "People" UNION SELECT "Name" FROM "Teams") s',
  'SELECT "Name" FROM "People" UNION SELECT "Name" FROM "Teams" ORDER BY "People".pg_typeof',
  'SELECT p."Name" FROM ("People" p JOIN "Teams" t ON true) AS j',
  'SELECT x.b FROM "People" x(a, b, c)',
  'SELECT pg_typeof FROM "People"',
  'SELECT "Missing" FROM "People"',
  'SELECT p FROM "People" p',
  'SELECT to_jsonb(p) FROM "People" p',
  'SELECT count FROM (SELECT count(*) FROM "People") s',
  'SELECT "Name" FROM "People" WHERE n = 1',
  'WITH RECURSIVE r AS (SELECT r.pg_typeof FROM r) SELECT * FROM r',
  'WITH RECURSIVE a AS (SELECT * FROM b), b AS (SELECT * FROM a) SELECT * FROM a',
];

describe('SQL guard', () => {
  it.each(accepted)('fully rewrites accepted query %s', async (source) => {
    const rewritten = await rewriteSql(source, tables);
    expect(rewritten).not.toContain('FROM "People"');
    expect(rewritten).not.toContain('FROM "Teams"');
    await expect(parse(`SELECT * FROM (${rewritten}) result LIMIT 10`)).resolves.toBeDefined();
  });
  it.each(rejected)('refuses unsafe query %s', async (source) => {
    await expect(rewriteSql(source, tables)).rejects.toHaveProperty('messageKey');
  });
  it('lets every name in a WITH RECURSIVE list reach every member, forward references included', async () => {
    for (const source of [
      'WITH RECURSIVE a AS (SELECT * FROM "People"), "People" AS (SELECT \'fake\' AS "Name") SELECT * FROM a',
      'WITH RECURSIVE b AS (SELECT * FROM "Teams"), "Teams" AS (SELECT \'cte\' AS x) SELECT * FROM b',
    ])
      expect(await rewriteSql(source, tables)).toBe(`${source}\n`);
    const shadowed = 'WITH a AS (SELECT * FROM "People"), "People" AS (SELECT 1 AS x) SELECT * FROM a';
    expect(await rewriteSql(shadowed, tables)).not.toContain('FROM "People"),');
  });
  it('uses stable names for duplicate and catalog names', () => {
    const items = [
      { id: 'tbl_a', name: 'People' },
      { id: 'tbl_b', name: 'People' },
      { id: 'tbl_c', name: 'pg_class' },
    ];
    expect([...friendlyNames(items).values()]).toEqual(['tbl_a', 'tbl_b', 'tbl_c']);
    expect(friendlyNames([...items].reverse())).toEqual(friendlyNames(items));
  });
  it('never accepts a random token soup that cannot be fully rewritten', async () => {
    let state = 197;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    const tokens = [
      'SELECT',
      '*',
      'FROM',
      '"People"',
      'pg_class',
      'pg_sleep',
      '(',
      ')',
      ';',
      '--\n',
      '/*x*/',
      'WITH',
      'AS',
      '1',
      'UNION',
      '"Peоple"',
      'COPY',
      "'x'",
      ',',
      'count',
      'WHERE',
      '=',
    ];
    let admitted = 0;
    for (let i = 0; i < 1500; i++) {
      const source =
        i % 10 === 0
          ? `${accepted[random() % accepted.length]} /* ${i} */`
          : Array.from({ length: 1 + (random() % 25) }, () => tokens[random() % tokens.length]).join(' ');
      let rewritten: string;
      try {
        rewritten = await rewriteSql(source, tables);
      } catch {
        continue;
      }
      admitted++;
      expect(rewritten).not.toContain('FROM "People"');
      await expect(parse(`SELECT * FROM (${rewritten}) result LIMIT 10`)).resolves.toBeDefined();
    }
    expect(admitted).toBeGreaterThan(100);
  });
});

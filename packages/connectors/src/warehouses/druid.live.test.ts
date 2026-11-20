/**
 * Druid against a real cluster.  It runs only when this is set, and skips otherwise:
 *
 * - `RIOSOMA_TEST_DRUID_URL`, the router as `http://user:password@host:port`, or without a user
 *   for a cluster that doesn't sign anyone in.  The user needs to ingest with SQL (the
 *   `druid-multi-stage-query` extension), and with `druid-basic-security` loaded, to manage users.
 *
 * Druid's own image runs a whole single-server cluster, started with a `wh_open_` name so it's
 * easy to find and remove.  Its micro quickstart wants several gigabytes of memory, and the nano
 * one fits in about four:
 *
 *     docker run -d --name wh_open_druid -p 127.0.0.1::8888 apache/druid … (the nano quickstart)
 *
 * The suite ingests a small datasource whose rows mostly share one `__time`, reads it through the
 * connector in pages smaller than those ties, signs in as a user who may read no datasource, and
 * drops it all.
 */
import type { SourceConnection, SourceSelect } from '@riosoma/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorContext, SourceRow } from '../types.js';
import { createDruidConnector, druidConnector } from './druid.js';

const url = process.env.RIOSOMA_TEST_DRUID_URL || undefined;

type DruidSettings = Extract<SourceConnection, { kind: 'druid' }>;

describe.skipIf(!url)('druid against a real cluster', () => {
  const parsed = new URL(url ?? 'http://localhost:8888');
  const secure = parsed.protocol === 'https:';
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const settings: DruidSettings = {
    kind: 'druid',
    host: parsed.hostname,
    port: Number(parsed.port) || (secure ? 9088 : 8888),
    ...(user ? { user } : {}),
    secure,
  };
  const ctx: ConnectorContext = {
    connection: settings,
    secrets: user ? { password } : {},
    timeoutMs: 120_000,
  };
  const base = `${parsed.protocol}//${parsed.host}`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(user ? { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } : {}),
  };
  const suffix = Math.random().toString(36).slice(2, 8);
  const datasource = `rio_sample_${suffix}`;
  const outsider = `rio_outsider_${suffix}`;
  // Built from parts, so no stand-in reads as a stored secret.
  const outsiderPassword = ['stand', 'in', suffix, 'Outsider7'].join('-');
  const select: SourceSelect = { kind: 'object', object: { schema: null, name: datasource } };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
    return text ? (JSON.parse(text) as unknown) : null;
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    // Ten rows share one moment, so paging has to keep rows at the same `__time` in one order.
    const rows = Array.from({ length: 13 }, (_unused, n) =>
      JSON.stringify({
        ts: n < 10 ? '2026-02-03T04:05:06.789Z' : `2026-02-0${n - 6}T00:00:00Z`,
        label: `row ${n}`,
        n: `${9007199254740993n + BigInt(n)}`,
        part: n,
        amount: 1.25,
        ratio: 0.5,
        tags: ['a', 'b'],
        doc: { hello: [1, 2] },
        note: n === 0 ? null : 'a note',
      }),
    ).join('\n');
    const input = JSON.stringify({ type: 'inline', data: rows }).replaceAll("'", "''");
    const signature = JSON.stringify([
      { name: 'ts', type: 'string' },
      { name: 'label', type: 'string' },
      { name: 'n', type: 'long' },
      { name: 'part', type: 'long' },
      { name: 'amount', type: 'double' },
      { name: 'ratio', type: 'double' },
      { name: 'tags', type: 'ARRAY<STRING>' },
      { name: 'doc', type: 'COMPLEX<json>' },
      { name: 'note', type: 'string' },
    ]);
    const task = (await call('POST', '/druid/v2/sql/task', {
      query: `REPLACE INTO "${datasource}" OVERWRITE ALL
        SELECT TIME_PARSE("ts") AS "__time", "label", "n", "part", "amount", CAST("ratio" AS FLOAT) AS "ratio",
          "tags", "doc", "note"
        FROM TABLE(EXTERN('${input}', '{"type":"json"}', '${signature}'))
        PARTITIONED BY DAY`,
      context: { maxNumTasks: 2 },
    })) as { taskId: string };
    for (let tries = 0; ; tries++) {
      const status = (await call('GET', `/druid/indexer/v1/task/${task.taskId}/status`)) as {
        status: { status: string; errorMsg?: string };
      };
      if (status.status.status === 'SUCCESS') break;
      if (status.status.status === 'FAILED' || tries > 120)
        throw new Error(`the ingestion ended ${status.status.status}: ${status.status.errorMsg ?? ''}`);
      await wait(2_000);
    }
    // Segments take a moment to load after the task, and a query counts only the loaded ones.
    for (let tries = 0; ; tries++) {
      const counted = (await call('POST', '/druid/v2/sql', {
        query: `SELECT COUNT(*) AS "rows" FROM "${datasource}"`,
      }).catch(() => [])) as Array<{ rows: number }>;
      if (counted[0]?.rows === 13) break;
      if (tries > 60) throw new Error('the datasource never loaded');
      await wait(2_000);
    }
    if (user) {
      await call(
        'POST',
        `/proxy/coordinator/druid-ext/basic-security/authentication/db/basic/users/${outsider}`,
      );
      await call(
        'POST',
        `/proxy/coordinator/druid-ext/basic-security/authentication/db/basic/users/${outsider}/credentials`,
        {
          password: outsiderPassword,
        },
      );
      await call(
        'POST',
        `/proxy/coordinator/druid-ext/basic-security/authorization/db/basic/users/${outsider}`,
      );
      // Every service polls for new users, so the outsider can't sign in until the router hears of it.
      const signIn = `Basic ${Buffer.from(`${outsider}:${outsiderPassword}`).toString('base64')}`;
      for (let tries = 0; ; tries++) {
        const response = await fetch(`${base}/druid/v2/sql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: signIn },
          body: JSON.stringify({ query: 'SELECT 1' }),
        });
        await response.body?.cancel();
        if (response.status !== 401) break;
        if (tries > 90) throw new Error(`the outsider still gets ${response.status}`);
        await wait(2_000);
      }
    }
  }, 900_000);

  afterAll(async () => {
    await call('DELETE', `/druid/coordinator/v1/datasources/${datasource}`).catch(() => undefined);
    await call(
      'DELETE',
      `/druid/coordinator/v1/datasources/${datasource}/intervals/1000-01-01_3000-01-01`,
    ).catch(() => undefined);
    if (user) {
      await call(
        'DELETE',
        `/proxy/coordinator/druid-ext/basic-security/authorization/db/basic/users/${outsider}`,
      ).catch(() => undefined);
      await call(
        'DELETE',
        `/proxy/coordinator/druid-ext/basic-security/authentication/db/basic/users/${outsider}`,
      ).catch(() => undefined);
    }
  }, 120_000);

  it('climbs every step of a connection test', async () => {
    const result = await druidConnector.test(ctx);
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', secure ? 'ok' : 'skipped'],
      ['authenticate', 'ok'],
      ['query', 'ok'],
    ]);
    expect(result.serverVersion).toMatch(/^Apache Druid \d+/);
  }, 120_000);

  it.skipIf(!user)(
    'tells a refused sign-in from a user who may read nothing, which passes with a note',
    async () => {
      const wrong = await druidConnector.test({ ...ctx, secrets: { password: `${outsiderPassword}-wrong` } });
      expect(wrong.steps.at(-1)).toMatchObject({
        step: 'authenticate',
        messageKey: 'sources.test.authenticate',
      });
      const outsiderCtx: ConnectorContext = {
        ...ctx,
        connection: { ...settings, user: outsider },
        secrets: { password: outsiderPassword },
      };
      // Druid lists only what a user may read, so this looks like a cluster with nothing in it yet.
      const empty = await druidConnector.test(outsiderCtx);
      expect(empty.ok, JSON.stringify(empty.steps)).toBe(true);
      expect(empty.steps.at(-1)).toMatchObject({
        step: 'query',
        status: 'ok',
        messageKey: 'sources.test.noDatasources',
      });
      await expect(druidConnector.preview(outsiderCtx, select, 1)).rejects.toMatchObject({
        messageKey: 'sources.sync.objectMissing',
        detail: `the source has no datasource named ${datasource} that this user may read`,
      });
    },
    120_000,
  );

  it('lists datasources as tables, with the rows their segments count', async () => {
    const objects = await druidConnector.listObjects(ctx);
    expect(objects.find((object) => object.name === datasource)).toEqual({
      schema: null,
      name: datasource,
      type: 'table',
      rowEstimate: 13,
    });
  }, 120_000);

  it('maps every type, with __time as a date and time', async () => {
    const columns = new Map(
      (await druidConnector.describe(ctx, select)).map((column) => [column.name, column]),
    );
    expect(columns.get('__time')).toMatchObject({
      sourceType: 'TIMESTAMP',
      nullable: false,
      suggested: { type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
    });
    expect(columns.get('label')?.suggested?.type).toBe('text');
    for (const name of ['n', 'part'])
      expect(columns.get(name)?.suggested).toEqual({ type: 'number', options: { precision: 0 } });
    for (const name of ['amount', 'ratio'])
      expect(columns.get(name)?.suggested).toEqual({ type: 'number', options: { precision: null } });
    for (const name of ['tags', 'doc']) expect(columns.get(name)?.suggested?.type).toBe('longText');
    const queried = await druidConnector.describe(ctx, {
      kind: 'query',
      sql: `SELECT "label", COUNT(*) AS "rows" FROM "${datasource}" GROUP BY "label"`,
    });
    expect(queried.map((column) => [column.name, column.suggested?.type])).toEqual([
      ['label', 'text'],
      ['rows', 'number'],
    ]);
  }, 120_000);

  it('previews values in Riosoma’s forms, and a query through the guard', async () => {
    const preview = await druidConnector.preview(ctx, select, 2);
    expect(preview.rowEstimate).toBe(13);
    const row = Object.fromEntries(
      preview.columns.map((column, index) => [column.name, preview.rows[0]?.[index]]),
    );
    expect(row).toMatchObject({
      __time: '2026-02-03T04:05:06.789Z',
      amount: 1.25,
      ratio: 0.5,
      tags: '["a","b"]',
      doc: '{"hello":[1,2]}',
    });
    await expect(
      druidConnector.preview(ctx, { kind: 'query', sql: `SELECT 1; DELETE FROM "${datasource}"` }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    await expect(
      druidConnector.preview(ctx, { kind: 'object', object: { schema: null, name: `gone_${suffix}` } }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.objectMissing' });
  }, 120_000);

  it('offers no key, since a datasource has none', async () => {
    expect(await druidConnector.keyCandidates(ctx, { schema: null, name: datasource })).toEqual([]);
  }, 120_000);

  it('pages by __time, reading the rows at a page’s last __time together, every row once', async () => {
    // Ten rows share one __time, so the first page ends among them and they're read in one request.
    const paged = createDruidConnector({ pageRows: 4 });
    const batches: SourceRow[][] = [];
    for await (const batch of paged.read(ctx, select, {
      columns: ['label', '__time', 'note'],
      types: { label: 'text', __time: 'date', note: 'text' },
      keyColumns: ['n'],
      batchSize: 5,
    }))
      batches.push(batch);
    const rows = batches.flat();
    expect(rows).toHaveLength(13);
    expect(new Set(rows.map((row) => row.key))).toEqual(
      new Set(
        Array.from({ length: 13 }, (_unused, n) => JSON.stringify([String(9007199254740993n + BigInt(n))])),
      ),
    );
    expect(rows.find((row) => row.values.label === 'row 0')?.values).toEqual({
      label: 'row 0',
      __time: '2026-02-03T04:05:06.789Z',
      note: null,
    });
    // A query with `__time` pages by it the same way, and one without reads in one request.
    const timed: SourceRow[] = [];
    for await (const batch of paged.read(
      ctx,
      { kind: 'query', sql: `SELECT "__time", "label", "n" FROM "${datasource}"` },
      { columns: ['label'], types: { label: 'text' }, keyColumns: ['n'] },
    ))
      timed.push(...batch);
    expect(new Set(timed.map((row) => row.key)).size).toBe(13);
    expect(timed).toHaveLength(13);
    const grouped: SourceRow[] = [];
    for await (const batch of paged.read(
      ctx,
      { kind: 'query', sql: `SELECT "label", COUNT(*) AS "rows" FROM "${datasource}" GROUP BY "label"` },
      { columns: ['rows'], types: { rows: 'number' }, keyColumns: ['label'] },
    ))
      grouped.push(...batch);
    expect(grouped).toHaveLength(13);
  }, 120_000);

  it('stops with a plain error when more rows share one __time than a read takes at once', async () => {
    const read = async () => {
      for await (const batch of createDruidConnector({ pageRows: 4, tieRows: 5 }).read(ctx, select, {
        columns: ['label'],
        types: { label: 'text' },
        keyColumns: ['n'],
      }))
        void batch;
    };
    await expect(read()).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
      detail:
        'Druid holds more than 5 rows at the one __time 2026-02-03T04:05:06.789Z, more than a read takes at once, so it stopped',
    });
  }, 120_000);
});

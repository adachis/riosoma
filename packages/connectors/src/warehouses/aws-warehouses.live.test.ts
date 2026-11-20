import { describe, expect, it } from 'vitest';
import { SourceConnection } from '@riosoma/contracts';
import { createAthenaConnector } from './athena.js';
import { createRedshiftConnector } from './redshift.js';

const env = process.env;
const redshiftReady =
  ['HOST', 'DATABASE', 'REGION', 'TABLE', 'KEY_COLUMN'].every((key) => env[`RIOSOMA_TEST_REDSHIFT_${key}`]) &&
  (env.RIOSOMA_TEST_REDSHIFT_PASSWORD
    ? Boolean(env.RIOSOMA_TEST_REDSHIFT_USER)
    : Boolean(
        env.RIOSOMA_TEST_REDSHIFT_ACCESS_KEY_ID &&
        env.RIOSOMA_TEST_REDSHIFT_SECRET_ACCESS_KEY &&
        (env.RIOSOMA_TEST_REDSHIFT_WORKGROUP ||
          (env.RIOSOMA_TEST_REDSHIFT_CLUSTER_IDENTIFIER && env.RIOSOMA_TEST_REDSHIFT_USER)),
      ));
const athenaReady = [
  'REGION',
  'DATABASE',
  'WORKGROUP',
  'RESULTS_LOCATION',
  'ACCESS_KEY_ID',
  'SECRET_ACCESS_KEY',
  'TABLE',
  'KEY_COLUMN',
].every((key) => env[`RIOSOMA_TEST_ATHENA_${key}`]);

describe.skipIf(!redshiftReady)('Redshift with RIOSOMA_TEST_REDSHIFT_* settings', () => {
  it('tests TLS and credentials, browses the catalog, and reads snapshot and live rows', async () => {
    const ctx = {
      connection: SourceConnection.parse({
        kind: 'redshift',
        host: env.RIOSOMA_TEST_REDSHIFT_HOST,
        port: Number(env.RIOSOMA_TEST_REDSHIFT_PORT ?? 5439),
        database: env.RIOSOMA_TEST_REDSHIFT_DATABASE,
        region: env.RIOSOMA_TEST_REDSHIFT_REGION,
        user: env.RIOSOMA_TEST_REDSHIFT_USER,
        auth: env.RIOSOMA_TEST_REDSHIFT_PASSWORD ? 'password' : 'iam',
        deployment: env.RIOSOMA_TEST_REDSHIFT_WORKGROUP ? 'serverless' : 'provisioned',
        workgroup: env.RIOSOMA_TEST_REDSHIFT_WORKGROUP,
        clusterIdentifier: env.RIOSOMA_TEST_REDSHIFT_CLUSTER_IDENTIFIER,
      }),
      secrets: {
        password: env.RIOSOMA_TEST_REDSHIFT_PASSWORD,
        accessKeyId: env.RIOSOMA_TEST_REDSHIFT_ACCESS_KEY_ID,
        secretAccessKey: env.RIOSOMA_TEST_REDSHIFT_SECRET_ACCESS_KEY,
        sessionToken: env.RIOSOMA_TEST_REDSHIFT_SESSION_TOKEN,
      },
      timeoutMs: 60_000,
    };
    const connector = createRedshiftConnector();
    expect((await connector.test(ctx)).ok).toBe(true);
    const object = {
      schema: env.RIOSOMA_TEST_REDSHIFT_SCHEMA ?? 'public',
      name: env.RIOSOMA_TEST_REDSHIFT_TABLE!,
    };
    expect(await connector.listObjects(ctx)).toContainEqual(expect.objectContaining(object));
    const select = { kind: 'object' as const, object };
    const preview = await connector.preview(ctx, select, 3);
    expect(preview.columns.some((c) => c.name === env.RIOSOMA_TEST_REDSHIFT_KEY_COLUMN)).toBe(true);
    const session = await connector.session!(ctx);
    try {
      expect(await session.select('SELECT CAST($1 AS integer) AS value', ['7'])).toEqual([{ value: '7' }]);
      expect((await session.describe(select)).length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  }, 180_000);
});

describe.skipIf(!athenaReady)('Athena with RIOSOMA_TEST_ATHENA_* settings', () => {
  it('checks the workgroup guard, lists Glue metadata, and reads snapshot and live results', async () => {
    const ctx = {
      connection: SourceConnection.parse({
        kind: 'athena',
        region: env.RIOSOMA_TEST_ATHENA_REGION,
        database: env.RIOSOMA_TEST_ATHENA_DATABASE,
        workgroup: env.RIOSOMA_TEST_ATHENA_WORKGROUP,
        catalog: env.RIOSOMA_TEST_ATHENA_CATALOG ?? 'AwsDataCatalog',
        resultsLocation: env.RIOSOMA_TEST_ATHENA_RESULTS_LOCATION,
        maxScannedBytes: Number(env.RIOSOMA_TEST_ATHENA_MAX_SCANNED_BYTES ?? 1_000_000_000),
      }),
      secrets: {
        accessKeyId: env.RIOSOMA_TEST_ATHENA_ACCESS_KEY_ID,
        secretAccessKey: env.RIOSOMA_TEST_ATHENA_SECRET_ACCESS_KEY,
        sessionToken: env.RIOSOMA_TEST_ATHENA_SESSION_TOKEN,
      },
      timeoutMs: 60_000,
    };
    const connector = createAthenaConnector();
    expect((await connector.test(ctx)).ok).toBe(true);
    const object = { schema: env.RIOSOMA_TEST_ATHENA_DATABASE!, name: env.RIOSOMA_TEST_ATHENA_TABLE! };
    expect(await connector.listObjects(ctx)).toContainEqual(expect.objectContaining(object));
    const preview = await connector.preview(ctx, { kind: 'object', object }, 3);
    expect(preview.columns.some((c) => c.name === env.RIOSOMA_TEST_ATHENA_KEY_COLUMN)).toBe(true);
    const session = await connector.session!(ctx);
    try {
      expect(await session.select('SELECT 7 AS value', [])).toEqual([{ value: '7' }]);
    } finally {
      await session.close();
    }
  }, 180_000);
});

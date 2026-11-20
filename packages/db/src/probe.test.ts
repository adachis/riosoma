import { createServer, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusedPort, startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { DiagnosticReport } from '@riosoma/contracts';
import { DIAGNOSTIC_MESSAGE_KEYS, isSupportedVersion, probeDatabase } from './probe.js';
import { connectDatabase } from './connection.js';

let kit: TestPostgres;
let secured: TestPostgres;
let db: Awaited<ReturnType<TestPostgres['createDatabase']>>;
let securedDb: typeof db;

beforeAll(async () => {
  kit = await startTestPostgres();
  db = await kit.createDatabase('probe');
  secured = await startTestPostgres({ password: 'scram-test-password' });
  securedDb = await secured.createDatabase('password');
}, 60_000);

afterAll(async () => {
  await securedDb?.drop();
  await secured?.stop();
  await db?.drop();
  await kit?.stop();
});

function checkReport(report: DiagnosticReport) {
  expect(DiagnosticReport.safeParse(report).success).toBe(true);
  for (const step of report.steps) {
    expect(DIAGNOSTIC_MESSAGE_KEYS).toContain(step.messageKey);
    if (step.fixKey) expect(DIAGNOSTIC_MESSAGE_KEYS).toContain(step.fixKey);
  }
}

describe('diagnostic ladder', () => {
  it('reaches every applicable rung in order', async () => {
    const report = await probeDatabase(db.profile);
    checkReport(report);
    expect(report.ok).toBe(true);
    expect(report.serverVersion).toBeTruthy();
    expect(report.steps.map((step) => step.step)).toEqual([
      'dns',
      'tcp',
      'tls',
      'auth',
      'database',
      'privileges',
      'extensions',
      'version',
      'latency',
    ]);
    expect(report.steps[0]?.status).toBe('skipped');
    expect(report.steps.find((step) => step.step === 'extensions')?.params).toEqual({
      installed: expect.any(String),
      available: expect.any(String),
      missing: expect.any(String),
    });
  });

  it('resolves hostnames', async () => {
    const report = await probeDatabase({ ...db.profile, host: 'localhost' });
    expect(report.steps[0]).toMatchObject({ step: 'dns', status: 'ok' });
  });

  it('stops at DNS failure', async () => {
    const report = await probeDatabase({ ...db.profile, host: 'database.invalid' });
    checkReport(report);
    expect(report.ok).toBe(false);
    expect(report.steps).toEqual([
      expect.objectContaining({
        step: 'dns',
        status: 'fail',
        messageKey: 'setup.diagnose.dns.notFound',
        fixKey: 'setup.fix.checkHost',
      }),
    ]);
  });

  it('distinguishes refused TCP connections', async () => {
    // A port nothing answers on, which no other test's server can be holding in the meantime.
    const report = await probeDatabase({ ...db.profile, port: await refusedPort() });
    checkReport(report);
    expect(report.ok).toBe(false);
    expect(report.steps.map((step) => step.step)).toEqual(['dns', 'tcp']);
    expect(report.steps.at(-1)?.messageKey).toBe('setup.diagnose.tcp.refused');
  });

  it('rejects a wrong SCRAM password at auth', async () => {
    expect((await probeDatabase(securedDb.profile)).ok).toBe(true);
    const report = await probeDatabase({
      ...securedDb.profile,
      auth: { method: 'password', password: 'wrong' },
    });
    checkReport(report);
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ step: 'auth', messageKey: 'setup.diagnose.auth.rejected' });
  });

  it('reports token acquisition failure with the provider', async () => {
    const report = await probeDatabase(
      { ...db.profile, auth: { method: 'aws-rds-iam', region: 'us-east-1' } },
      {
        password: async () => {
          throw new Error('token unavailable');
        },
      },
    );
    checkReport(report);
    expect(report.steps.at(-1)).toMatchObject({
      step: 'auth',
      status: 'fail',
      messageKey: 'setup.diagnose.auth.tokenFailed',
      params: { provider: 'aws-rds-iam' },
    });
  });

  it('attributes a missing database to the database rung after successful auth', async () => {
    const report = await probeDatabase({ ...securedDb.profile, database: 'does_not_exist' });
    checkReport(report);
    expect(report.ok).toBe(false);
    expect(report.steps.at(-2)).toMatchObject({ step: 'auth', status: 'ok' });
    expect(report.steps.at(-1)).toMatchObject({
      step: 'database',
      status: 'fail',
      messageKey: 'setup.diagnose.database.missing',
    });
  });

  it('falls back only in prefer mode when TLS is unsupported', async () => {
    const profile = { ...db.profile, tls: { mode: 'prefer' as const } };
    const report = await probeDatabase(profile);
    checkReport(report);
    expect(report.ok).toBe(true);
    expect(report.steps.find((step) => step.step === 'tls')).toMatchObject({
      status: 'warn',
      messageKey: 'setup.diagnose.tls.plaintext',
    });
    const connection = await connectDatabase(profile);
    try {
      expect((await connection.pool.query('SELECT 1 AS value')).rows[0].value).toBe(1);
    } finally {
      await connection.close();
    }
  });

  it('calls a sign-in that never answers a timeout at sign-in, not an unreachable network', async () => {
    // Accepts the connection and then says nothing, as a cloud database does for a minute after
    // a new instance or user is created.
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    try {
      const report = await probeDatabase(
        { ...db.profile, port: address.port, tls: { mode: 'disable' } },
        { connectTimeoutMs: 300 },
      );
      checkReport(report);
      expect(report.steps.find((step) => step.step === 'tcp')).toMatchObject({ status: 'ok' });
      expect(report.steps.at(-1)).toMatchObject({
        step: 'auth',
        status: 'fail',
        messageKey: 'setup.diagnose.auth.timedOut',
        fixKey: 'setup.fix.retrySoon',
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not downgrade or attempt authentication after an invalid TLS response', async () => {
    let connections = 0;
    let credentialsRequested = false;
    const server = createServer((socket) => {
      connections++;
      socket.on('error', () => undefined);
      socket.once('data', () => socket.end('X'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    try {
      const report = await probeDatabase(
        { ...db.profile, port: address.port, tls: { mode: 'prefer' } },
        {
          password: async () => {
            credentialsRequested = true;
            return 'test';
          },
        },
      );
      checkReport(report);
      expect(report.ok).toBe(false);
      expect(report.steps.at(-1)).toMatchObject({
        step: 'tls',
        status: 'fail',
        messageKey: 'setup.diagnose.tls.protocol',
      });
      expect(credentialsRequested).toBe(false);
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['require', 'verify-ca', 'verify-full'] as const)(
    'fails %s against a plaintext server',
    async (mode) => {
      const report = await probeDatabase({ ...db.profile, tls: { mode } });
      checkReport(report);
      expect(report.ok).toBe(false);
      expect(report.steps.at(-1)).toMatchObject({
        step: 'tls',
        messageKey: 'setup.diagnose.tls.unsupported',
      });
    },
  );

  it.each([
    [139999, false],
    [140000, true],
    [140012, true],
    [180000, true],
    [NaN, false],
  ])('checks server version %s', (version, expected) => {
    expect(isSupportedVersion(version as number)).toBe(expected);
  });
});

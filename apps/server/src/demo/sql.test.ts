import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import type { SqlLogin } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { readFixture, numbers } from '../data/snapshots.test-helpers.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { prepareDemo } from './sessions.js';
import { closeLogins } from '../sql/login.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'demosql', { sqlOutsideLogins: true });
}, 60_000);
afterAll(async () => {
  if (server) await closeLogins(server.pool, server.schemas);
  await server?.close();
  await kit?.stop();
});

it('refuses preexisting SQL credentials and ends their connections before demo startup while preserving operator logins', async () => {
  const member = await server.addMember();
  const read = await readFixture(server);
  const privateRead = await readFixture(server);
  await numbers(server, read, [42]);
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".grants
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES ($1, 'database', $2, 'user', $3, 'reader')`,
    [member.info.org.id, read.table.databaseId, member.userId],
  );
  async function login(databaseId: string, personId: string) {
    const settings = await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${databaseId}/sql/settings`,
      headers: server.owner.headers,
      payload: { roles: ['owner', 'reader'], timeoutMs: 15_000, rowCap: 10_000 },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/sql/login`,
      headers: server.owner.headers,
      payload: { action: 'enable', personId },
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<SqlLogin>();
    expect(result.ready, response.body).toBe(true);
    return result;
  }
  const demoLogin = await login(read.table.databaseId, member.userId);
  const operatorLogin = await login(privateRead.table.databaseId, server.owner.userId);
  const client = new pg.Client({
    ...server.pool.options,
    user: demoLogin.role,
    password: demoLogin.password,
  });
  client.on('error', () => undefined);
  await client.connect();
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const view = (
    await client.query(`SELECT table_name FROM information_schema.views WHERE table_schema = $1`, [
      demoLogin.schema,
    ])
  ).rows[0].table_name;
  expect((await client.query(`SELECT * FROM "${demoLogin.schema}"."${view}"`)).rowCount).toBe(1);
  try {
    server.config.demoAccount = member.email;
    server.config.demoMode = true;
    await prepareDemo(server.ctx);
    const reopened = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${read.table.databaseId}/sql/login`,
      headers: server.owner.headers,
      payload: { action: 'enable', personId: member.userId },
    });
    expect(reopened.statusCode, reopened.body).toBe(403);
    expect(reopened.json().error.messageKey).toBe('demo.readOnly');
    const attempt = new pg.Client({
      ...server.pool.options,
      user: demoLogin.role,
      password: demoLogin.password,
    });
    try {
      await expect(attempt.connect()).rejects.toThrow();
    } finally {
      await attempt.end();
    }
    await expect
      .poll(
        async () =>
          (await server.pool.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rowCount,
      )
      .toBe(0);
    const operator = new pg.Client({
      ...server.pool.options,
      user: operatorLogin.role,
      password: operatorLogin.password,
    });
    try {
      await operator.connect();
      expect((await operator.query('SELECT 1 AS readable')).rows).toEqual([{ readable: 1 }]);
    } finally {
      await operator.end();
    }
  } finally {
    await client.end();
  }
}, 30_000);

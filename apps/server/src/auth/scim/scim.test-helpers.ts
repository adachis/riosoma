import { randomBytes } from 'node:crypto';
import type { FastifyRequest, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest';
import { newId, type ScimToken } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { authDatabase, randomToken, tokenHash } from '../database.js';
import { createSession, findIdentity } from '../sessions.js';
import { GROUP_SCHEMA, PATCH_SCHEMA, USER_SCHEMA } from './patch.js';

/**
 * Shared setup for the SCIM suites.  Each file gets one Postgres, and each test that calls `setup`
 * gets a fresh server whose organization has verified `example.test`, so provisioning can claim
 * addresses there.
 */
export let server: ServerFixture;
let kit: TestPostgres | undefined;

export function useScimServer(): void {
  beforeAll(async () => {
    kit = await startTestPostgres();
  }, 60000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.close();
  });
  afterAll(async () => {
    await kit?.stop();
  });
}

/** Marks a domain verified for an organization, as a finished DNS challenge would. */
export async function verifyDomain(orgId: string, domain: string): Promise<string> {
  const { app } = authDatabase(server.ctx);
  const providerId = randomBytes(16).toString('hex');
  await server.pool.query(
    `INSERT INTO ${app}.sso_providers (id, org_id, kind, name, issuer, client_id, sealed_secret, allowed_domains)
    VALUES ($1, $2, 'oidc', $3, $4, $5, $6, ARRAY[$7])`,
    [
      providerId,
      orgId,
      `Directory for ${domain}`,
      `https://${domain}/identity`,
      randomToken(),
      randomToken(),
      domain,
    ],
  );
  await server.pool.query(
    `INSERT INTO ${app}.sso_domain_verifications (org_id, provider_id, domain, challenge, verified_at)
    VALUES ($1, $2, $3, $4, clock_timestamp())`,
    [orgId, providerId, domain, randomToken()],
  );
  return providerId;
}

export async function setup(options: { domain?: string | null } = {}) {
  server = await startServer(kit!, 'scim');
  const domain = options.domain === undefined ? 'example.test' : options.domain;
  if (domain) await verifyDomain(server.owner.info.org.id, domain);
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/admin/scim/tokens',
    headers: server.owner.headers,
    payload: { name: 'Directory provisioning' },
  });
  expect(created.statusCode).toBe(200);
  return created.json<ScimToken & { token: string }>();
}

/** A second organization with its own token and, optionally, its own verified domain. */
export async function otherOrganization(domain?: string) {
  const { app } = authDatabase(server.ctx);
  const orgId = newId('org');
  const token = randomToken();
  const tokenId = randomBytes(16).toString('hex');
  await server.pool.query(`INSERT INTO ${app}.orgs (id, name) VALUES ($1, $2)`, [
    orgId,
    'Another organization',
  ]);
  await server.pool.query(
    `INSERT INTO ${app}.scim_tokens (id, org_id, name, secret_hash) VALUES ($1, $2, $3, $4)`,
    [tokenId, orgId, 'Other directory', tokenHash(token)],
  );
  if (domain) await verifyDomain(orgId, domain);
  return { orgId, token, tokenId };
}

export function call(
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method,
    url: `/scim/v2/${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/scim+json' }),
    },
    ...(payload === undefined
      ? {}
      : { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
  });
}

export const user = (overrides: Record<string, unknown> = {}) => ({
  schemas: [USER_SCHEMA],
  userName: 'bjensen@example.test',
  externalId: 'directory-person',
  displayName: 'Barbara Jensen',
  name: { givenName: 'Barbara', familyName: 'Jensen' },
  active: true,
  emails: [{ value: 'bjensen@example.test', primary: true, type: 'work' }],
  ...overrides,
});

export const group = (overrides: Record<string, unknown> = {}) => ({
  schemas: [GROUP_SCHEMA],
  displayName: 'Operators',
  members: [],
  ...overrides,
});

export const patch = (Operations: unknown[]) => ({ schemas: [PATCH_SCHEMA], Operations });

/** Provisions a person and returns their ID. */
export async function provision(token: string, overrides: Record<string, unknown> = {}) {
  const response = await call(token, 'POST', 'Users', user(overrides));
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

/** Signs a person in the way a finished single sign-on would. */
export async function signedIn(userId: string) {
  const { app } = authDatabase(server.ctx);
  const identity = (await findIdentity(server.pool, app, userId))!;
  const request = { headers: {}, protocol: 'http', ip: '127.0.0.1' } as FastifyRequest;
  const session = await createSession(server.pool, server.ctx, identity, request);
  return {
    userId,
    headers: { cookie: `rio_session=${session.token}`, 'x-csrf-token': session.info.csrfToken },
  };
}

export async function createDatabase(headers: Record<string, string> = server.owner.headers) {
  const id = newId('database');
  const tableId = newId('table');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers,
    payload: {
      id,
      name: 'Directory access',
      table: {
        id: tableId,
        name: 'Records',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'All records' },
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return {
    id,
    tableId,
    viewId: response.json<{ views: Array<{ id: string }> }>().views[0]!.id,
  };
}

import { exportArchive, importArchive } from '../organization-archives/organization-archives.test-support.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { withTransaction } from '@riosoma/db';
import type { OrganizationBranding, OrganizationCommandResult, SessionInfo } from '@riosoma/contracts';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { archiveLogo, restoreLogo } from './store.js';
import { AccessScope } from '../access.js';

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
const upload = {
  type: 'image/svg+xml',
  data: Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><path d="M0 0 L100 40" stroke="black"/></svg>',
  ).toString('base64'),
};
const command = (payload: object, who: SignedIn = server.owner) =>
  server.app.inject({ method: 'POST', url: '/api/org/admin-commands', headers: who.headers, payload });
const read = async () =>
  (
    await server.app.inject({ method: 'GET', url: '/api/org/appearance', headers: server.owner.headers })
  ).json<OrganizationBranding>();

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'brand_logo');
  member = await server.addMember();
}, 120_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

describe('organization logos', () => {
  it('keeps appearance commands scoped, validates themes, and undoes only their appearance values', async () => {
    const change = { kind: 'organization.appearance', defaultTheme: null, allowedThemes: null };
    expect((await command(change, member)).statusCode).toBe(403);
    expect((await command({ ...change, defaultTheme: 'missing-brand-theme' })).statusCode).toBe(422);
    const response = await command(change);
    expect(response.statusCode, response.body).toBe(200);
    const changed = response.json<OrganizationCommandResult>();
    expect(changed.undoable).toBe(true);
    const undone = await command({ kind: 'organization.undo', eventId: changed.eventId });
    expect(undone.statusCode, undone.body).toBe(200);
  });
  it.each([null, ['nature', 'synthwave']])(
    'replaces older theme restrictions with %j and restores them on undo',
    async (allowedThemes) => {
      const previous = { defaultTheme: { theme: 'nature', scheme: 'grove' }, allowedThemes: ['nature'] };
      await server.pool.query(
        `UPDATE "${server.schemas.app}".orgs SET settings = settings - 'unitPolicy' || $1::jsonb WHERE id = $2`,
        [JSON.stringify(previous), server.owner.info.org.id],
      );
      const response = await command({
        kind: 'organization.appearance',
        defaultTheme: 'synthwave',
        allowedThemes,
      });
      expect(response.statusCode, response.body).toBe(200);
      const session = (
        await server.app.inject({ method: 'GET', url: '/api/auth/session', headers: member.headers })
      ).json<SessionInfo>();
      expect(session.effectiveSettings?.allowedThemes ?? null).toEqual(allowedThemes);
      expect(session.effectiveSettings?.defaultTheme?.theme).toBe('synthwave');
      const preference = await server.app.inject({
        method: 'PATCH',
        url: '/api/me/preferences',
        headers: member.headers,
        payload: { theme: 'synthwave' },
      });
      expect(preference.statusCode, preference.body).toBe(200);
      const undone = await command({
        kind: 'organization.undo',
        eventId: response.json<OrganizationCommandResult>().eventId,
      });
      expect(undone.statusCode, undone.body).toBe(200);
      const stored = (
        await server.pool.query<{ settings: object }>(
          `SELECT settings FROM "${server.schemas.app}".orgs WHERE id = $1`,
          [server.owner.info.org.id],
        )
      ).rows[0]!.settings;
      expect(stored).toMatchObject(previous);
      const restored = (
        await server.app.inject({ method: 'GET', url: '/api/auth/session', headers: member.headers })
      ).json<SessionInfo>();
      expect(restored.effectiveSettings?.allowedThemes).toEqual(['nature']);
      expect(restored.effectiveSettings?.defaultTheme?.theme).toBe('nature');
    },
  );
  it('authorizes through the organization scope, audits changes, serves passive images, and undoes them', async () => {
    expect(
      (await command({ kind: 'organization.logo', main: upload, mode: 'theme' }, member)).statusCode,
    ).toBe(403);
    const response = await command({
      kind: 'organization.logo',
      main: upload,
      compact: upload,
      mode: 'theme',
    });
    expect(response.statusCode, response.body).toBe(200);
    const changed = response.json<OrganizationCommandResult>();
    expect(changed.undoable).toBe(true);
    const brand = await read();
    expect(brand.logo?.main.key).toBeTruthy();
    const image = await server.app.inject({
      method: 'GET',
      url: `/api/org/logo/${brand.logo!.main.key}`,
      headers: member.headers,
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/svg+xml');
    expect(image.headers['content-security-policy']).toContain('sandbox');
    expect(image.headers['content-disposition']).toBe('attachment');
    expect(
      (await server.app.inject({ method: 'GET', url: `/api/auth/logo/${brand.logo!.main.key}` })).statusCode,
    ).toBe(200);
    const undo = await command({ kind: 'organization.undo', eventId: changed.eventId });
    expect(undo.statusCode, undo.body).toBe(200);
    expect((await read()).logo).toBeNull();
  });
  it('retains untouched assets when changing modes, refuses hostile files atomically, and removes the logo', async () => {
    await command({ kind: 'organization.logo', main: upload, mode: 'theme' });
    const before = (await read()).logo!;
    const mode = await command({ kind: 'organization.logo', mode: 'original' });
    expect(mode.statusCode, mode.body).toBe(200);
    expect((await read()).logo).toEqual({ ...before, mode: 'original' });
    const hostile = {
      ...upload,
      data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>').toString('base64'),
    };
    expect((await command({ kind: 'organization.logo', main: hostile, mode: 'theme' })).statusCode).toBe(422);
    expect((await read()).logo?.main.key).toBe(before.main.key);
    expect(
      (await command({ kind: 'organization.logo', main: null, compact: null, mode: 'theme' })).statusCode,
    ).toBe(200);
    expect((await read()).logo).toBeNull();
  });
  it('exports bytes with appearance and imports fresh organization-owned assets through sanitation', async () => {
    await command({ kind: 'organization.logo', main: upload, compact: upload, mode: 'original' });
    const before = (await read()).logo!;
    await withTransaction(server.pool, async (db) => {
      const archive = await archiveLogo(db, server.schemas.app, server.app.ctx.config, before);
      expect(JSON.stringify(archive)).not.toContain(before.main.key);
      const restored = await restoreLogo(db, server.schemas.app, server.app.ctx.config, archive);
      expect(restored?.mode).toBe('original');
      expect(restored?.main.key).not.toBe(before.main.key);
      expect(restored?.compact).toBeTruthy();
      await expect(restoreLogo(db, server.schemas.app, server.app.ctx.config, before)).rejects.toMatchObject({
        messageKey: 'branding.archive',
      });
    });
  });
  it('carries both logo assets through a full organization export and import', async () => {
    const source = await read();
    const exported = await exportArchive(server, { files: false });
    const destination = await startServer(kit, 'brand_import');
    try {
      await importArchive(destination, exported.bytes);
      const restored = (
        await destination.app.inject({
          method: 'GET',
          url: '/api/org/appearance',
          headers: destination.owner.headers,
        })
      ).json<OrganizationBranding>();
      expect(restored.logo?.mode).toBe(source.logo?.mode);
      expect(restored.logo?.compact).toBeTruthy();
      expect(restored.logo?.main.key).not.toBe(source.logo?.main.key);
      const image = await destination.app.inject({
        method: 'GET',
        url: `/api/org/logo/${restored.logo!.main.key}`,
        headers: destination.owner.headers,
      });
      expect(image.statusCode, image.body).toBe(200);
      expect(image.body).toContain('M0 0 L100 40');
    } finally {
      await destination.close();
    }
  });
  it('does not expose a logo from an ambiguous organization before sign-in', async () => {
    expect(await AccessScope.signInBranding(server.pool, server.schemas.app)).toMatchObject({
      name: server.owner.info.org.name,
    });
    await withTransaction(server.pool, async (db) => {
      await db.query(`INSERT INTO "${server.schemas.app}".orgs (id, name) VALUES ($1, $2)`, [
        'brand_other',
        'Another organization',
      ]);
      expect(await AccessScope.signInBranding(db, server.schemas.app)).toBeNull();
      throw new Error('rollback');
    }).catch((error) => {
      expect((error as Error).message).toBe('rollback');
    });
  });
});

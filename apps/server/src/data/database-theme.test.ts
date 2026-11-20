import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseSchema,
  newId,
  type BookingPage,
  type CommandBatchResult,
  type CommandResult,
  type DatabaseCopy,
  type PublicBookingPage,
  type PublicForm,
  type PublicFormLink,
  type SharedView,
  type SharedViewLink,
  type TemplateSummary,
  type ThemePick,
  type UndoResult,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';

/**
 * A database's forced theme and the themes public pages pick for themselves: who may set them,
 * how they're checked and stored, what public pages read, and what copies keep.
 */

const BAUHAUS: ThemePick = { id: 'bauhaus', scheme: 'midnight' };
const KAWAII: ThemePick = { id: 'kawaii', scheme: 'bubblegum' };
const JAPANDI: ThemePick = { id: 'japandi', scheme: 'kiln' };

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'dbtheme');
}, 60_000);
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: unknown,
  who = server.owner,
) {
  const response = await server.app.inject({
    method,
    url,
    headers: who.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: response.statusCode,
    body: (response.body ? response.json() : null) as T,
    raw: response.body,
  };
}

async function ok<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: unknown,
  who = server.owner,
) {
  const result = await call<T>(method, url, payload, who);
  expect(result.status, result.raw).toBe(200);
  return result.body;
}

async function send(
  databaseId: string,
  input: Record<string, unknown>,
  who: SignedIn = server.owner,
  groupId = newId('action'),
): Promise<CommandResult> {
  const body = await ok<CommandBatchResult>(
    'POST',
    `/api/databases/${databaseId}/commands`,
    { clientId, commands: [{ id: newId('command'), groupId, ...input }] },
    who,
  );
  return body.results[0]!;
}

async function applied(databaseId: string, input: Record<string, unknown>, who: SignedIn = server.owner) {
  const result = await send(databaseId, input, who);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
  return result;
}

const schemaOf = async (databaseId: string, who: SignedIn = server.owner) =>
  DatabaseSchema.parse(await ok('GET', `/api/databases/${databaseId}/schema`, undefined, who));

/** What the database keeps in its settings, as stored. */
async function storedSettings(databaseId: string): Promise<Record<string, unknown>> {
  const result = await query<{ settings: Record<string, unknown> }>(
    server.pool,
    sql`SELECT settings FROM ${ident(server.schemas.app, 'databases')} WHERE id = ${databaseId}`,
  );
  return result.rows[0]!.settings;
}

async function auditOf(action: string) {
  const result = await query<{ actor_id: string | null; metadata: Record<string, unknown> }>(
    server.pool,
    sql`SELECT actor_id, metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = ${action} ORDER BY id`,
  );
  return result.rows;
}

async function grant(databaseId: string, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${who.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

/** Limits the themes everyone in the organization may choose, until the test ends. */
async function limitThemes(allowed: string[], defaultTheme: ThemePick) {
  const orgs = ident(server.schemas.app, 'orgs');
  const id = server.owner.info.org.id;
  const before = (
    await query<{ settings: unknown }>(server.pool, sql`SELECT settings FROM ${orgs} WHERE id = ${id}`)
  ).rows[0]!.settings;
  await query(
    server.pool,
    sql`UPDATE ${orgs} SET settings = settings || ${JSON.stringify({
      allowedThemes: allowed,
      defaultTheme: { theme: defaultTheme.id, scheme: defaultTheme.scheme },
    })}::jsonb WHERE id = ${id}`,
  );
  cleanups.push(async () => {
    await query(
      server.pool,
      sql`UPDATE ${orgs} SET settings = ${JSON.stringify(before)}::jsonb WHERE id = ${id}`,
    );
  });
}

/** A database with one table, whose fields are a name, an email address, and a time. */
async function database(name = 'Studio') {
  const f = { name: newId('field'), email: newId('field'), when: newId('field') };
  const databaseId = newId('database');
  const tableId = newId('table');
  const gridViewId = newId('view');
  await ok('POST', '/api/databases', {
    id: databaseId,
    name,
    table: {
      id: tableId,
      name: 'Visits',
      fields: [
        { id: f.name, name: 'Name', type: 'text' },
        { id: f.email, name: 'Email', type: 'email' },
        { id: f.when, name: 'When', type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
      ],
      view: { id: gridViewId, name: 'Grid' },
      records: [],
    },
  });
  return { databaseId, tableId, gridViewId, f };
}

describe('a database that forces its theme', () => {
  it('lets its owner force a theme, keeps it in the settings, audits it, and undoes it', async () => {
    const { databaseId } = await database();
    expect((await schemaOf(databaseId)).database.theme).toBeUndefined();

    const groupId = newId('action');
    const result = await send(databaseId, { kind: 'database.update', theme: BAUHAUS }, server.owner, groupId);
    expect(result).toMatchObject({ status: 'applied' });
    expect((await schemaOf(databaseId)).database.theme).toEqual(BAUHAUS);
    // No migration: it lives beside the sidebar's folders in the settings.
    expect(await storedSettings(databaseId)).toMatchObject({ theme: BAUHAUS });
    // Everyone who has the database open hears about it, so their screens change at once.
    const change = await query<{ body: { kind: string; database: { theme?: ThemePick } } }>(
      server.pool,
      sql`SELECT body FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${databaseId} ORDER BY seq DESC LIMIT 1`,
    );
    expect(change.rows[0]!.body).toMatchObject({ kind: 'database.updated', database: { theme: BAUHAUS } });
    expect(
      (await auditOf('data.database.themeChanged')).filter((row) => row.metadata.databaseId === databaseId),
    ).toEqual([
      {
        actor_id: server.owner.userId,
        metadata: expect.objectContaining({ databaseId, theme: BAUHAUS, previous: null }),
      },
    ]);

    // Undoing puts each person's own theme back.
    const undone = await ok<UndoResult>('POST', `/api/databases/${databaseId}/undo`, {
      clientId,
      groupId,
      commandId: newId('command'),
    });
    expect(undone.status).toBe('applied');
    expect((await schemaOf(databaseId)).database.theme).toBeUndefined();
    expect(await storedSettings(databaseId)).not.toHaveProperty('theme');

    // Null stops forcing a theme, and the rest of the settings stay.
    await applied(databaseId, { kind: 'database.update', theme: KAWAII });
    await applied(databaseId, { kind: 'database.update', theme: null, name: 'Studio two' });
    const after = await schemaOf(databaseId);
    expect(after.database).toMatchObject({ name: 'Studio two' });
    expect(after.database.theme).toBeUndefined();
  });

  it('leaves the theme to the owner, while others may still change what their role allows', async () => {
    const { databaseId } = await database();
    const creator = await server.addMember({ name: 'Casey Creator' });
    const editor = await server.addMember({ name: 'Eden Editor' });
    const reader = await server.addMember({ name: 'Reese Reader' });
    await grant(databaseId, creator, 'creator');
    await grant(databaseId, editor, 'editor');
    await grant(databaseId, reader, 'reader');

    for (const who of [creator, editor, reader]) {
      const refused = await send(databaseId, { kind: 'database.update', theme: KAWAII }, who);
      expect(refused).toMatchObject({ status: 'rejected', error: { code: 'forbidden' } });
    }
    expect((await schemaOf(databaseId)).database.theme).toBeUndefined();
    // A creator still renames the database, and sending the theme it already has asks nothing more.
    await applied(databaseId, { kind: 'database.update', theme: BAUHAUS });
    await applied(databaseId, { kind: 'database.update', name: 'Renamed', theme: BAUHAUS }, creator);
    // Everyone who can open the database reads the theme, so it applies to them too.
    expect((await schemaOf(databaseId, reader)).database).toMatchObject({ name: 'Renamed', theme: BAUHAUS });
  });

  it('refuses a theme or color scheme this server does not have', async () => {
    const { databaseId } = await database();
    for (const theme of [
      { id: 'not-a-theme', scheme: 'grove' },
      { id: 'bauhaus', scheme: 'not-a-scheme' },
    ]) {
      const refused = await send(databaseId, { kind: 'database.update', theme });
      expect(refused).toMatchObject({
        status: 'rejected',
        error: { code: 'validation_failed', messageKey: 'themes.unknown' },
      });
    }
    // Text that isn't a theme's name at all never reaches the database.
    const malformed = await send(databaseId, {
      kind: 'database.update',
      theme: { id: 'Bauhaus!', scheme: 'x' },
    });
    expect(malformed).toMatchObject({ status: 'rejected', error: { code: 'validation_failed' } });
    expect(await storedSettings(databaseId)).not.toHaveProperty('theme');
  });

  it('keeps to the themes the organization allows, and never rewrites a theme that falls outside them later', async () => {
    const { databaseId } = await database();
    await applied(databaseId, { kind: 'database.update', theme: KAWAII });
    await limitThemes(['nature', 'bauhaus'], { id: 'nature', scheme: 'grove' });
    const refused = await send(databaseId, { kind: 'database.update', theme: JAPANDI });
    expect(refused).toMatchObject({
      status: 'rejected',
      error: { code: 'forbidden', messageKey: 'orgUnits.policy.theme' },
    });
    // The theme forced before the list changed stays as it was.  Each screen falls back on its own.
    expect((await schemaOf(databaseId)).database.theme).toEqual(KAWAII);
    expect(await storedSettings(databaseId)).toMatchObject({ theme: KAWAII });
    await applied(databaseId, { kind: 'database.update', theme: BAUHAUS });
    expect((await schemaOf(databaseId)).database.theme).toEqual(BAUHAUS);
  });
});

/** A form view on the database's table, shared by link. */
async function sharedForm(databaseId: string, tableId: string, f: { name: string }, theme?: ThemePick) {
  const viewId = newId('view');
  const form = {
    title: 'Book a visit',
    description: '',
    questions: [{ fieldId: f.name, label: '', help: '', required: false }],
    submitLabel: '',
    thankYou: '',
    allowAnother: true,
  };
  await applied(databaseId, {
    kind: 'view.create',
    view: { id: viewId, name: 'Visit form', tableId, type: 'form', config: { form } },
  });
  if (theme) await applied(databaseId, { kind: 'view.update', viewId, config: { form: { ...form, theme } } });
  const link = await ok<PublicFormLink>('PUT', `/api/views/${viewId}/public-form`);
  return { viewId, form, formId: link.formId };
}

const publicForm = (formId: string) =>
  server.app.inject({ url: `/api/public/forms/${formId}` }).then((response) => response.json<PublicForm>());
const publicView = (linkId: string) =>
  server.app.inject({ url: `/api/public/views/${linkId}` }).then((response) => response.json<SharedView>());
const publicBooking = (pageId: string) =>
  server.app
    .inject({ url: `/api/public/bookings/${pageId}` })
    .then((response) => response.json<PublicBookingPage>());

const ALL_DAY = Array.from({ length: 7 }, () => [{ start: '00:00', end: '24:00' }]);

describe('public pages pick their own theme', () => {
  it.each([
    { theme: { id: 'not-a-theme', scheme: 'grove' }, messageKey: 'themes.unknown' },
    { theme: { id: 'japandi', scheme: 'not-a-scheme' }, messageKey: 'themes.unknown' },
    { theme: KAWAII, messageKey: 'orgUnits.policy.theme' },
  ])('rejects a form theme at creation with $messageKey for $theme', async ({ theme, messageKey }) => {
    const { databaseId, tableId } = await database();
    await limitThemes(['japandi'], JAPANDI);
    const viewId = newId('view');
    const result = await send(databaseId, {
      kind: 'view.create',
      view: {
        id: viewId,
        name: 'Visit form',
        tableId,
        type: 'form',
        config: { form: { theme } },
      },
    });
    expect(result).toMatchObject({ status: 'rejected', error: { messageKey } });
    expect((await schemaOf(databaseId)).views.some((view) => view.id === viewId)).toBe(false);
  });

  it('creates a form with an allowed theme and publishes the same scheme', async () => {
    const { databaseId, tableId, f } = await database();
    await limitThemes(['japandi'], JAPANDI);
    const viewId = newId('view');
    await applied(databaseId, {
      kind: 'view.create',
      view: {
        id: viewId,
        name: 'Visit form',
        tableId,
        type: 'form',
        config: { form: { theme: JAPANDI, questions: [{ fieldId: f.name }] } },
      },
    });
    const link = await ok<PublicFormLink>('PUT', `/api/views/${viewId}/public-form`);
    expect((await publicForm(link.formId)).theme).toEqual(JAPANDI);
  });

  it('uses the allowed organization default for public pages without theme picks', async () => {
    const { databaseId, tableId, gridViewId, f } = await database();
    const { formId } = await sharedForm(databaseId, tableId, f);
    const link = await ok<SharedViewLink>('PUT', `/api/views/${gridViewId}/shared-view`);
    const page = await ok<BookingPage>('POST', `/api/tables/${tableId}/booking-pages`, {
      settings: {
        title: 'Studio visits',
        timeFieldId: f.when,
        lengthMinutes: 60,
        timeZone: 'UTC',
        hours: ALL_DAY,
        nameFieldId: f.name,
        emailFieldId: f.email,
      },
      enabled: true,
    });
    await limitThemes(['japandi'], JAPANDI);
    expect((await publicForm(formId)).theme).toEqual(JAPANDI);
    expect((await publicView(link.linkId)).theme).toEqual(JAPANDI);
    expect((await publicBooking(page.pageId)).theme).toEqual(JAPANDI);
    await ok('PATCH', `/api/views/${gridViewId}/shared-view`, { password: 'a password for the link' });
    expect(await publicView(link.linkId)).toEqual({ status: 'locked', theme: JAPANDI });

    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET settings = settings - 'defaultTheme'
      WHERE id = ${server.owner.info.org.id}`,
    );
    expect((await publicForm(formId)).theme).toEqual({ id: 'japandi', scheme: 'sumi' });
    expect((await publicView(link.linkId)).theme).toEqual({ id: 'japandi', scheme: 'sumi' });
    expect((await publicBooking(page.pageId)).theme).toEqual({ id: 'japandi', scheme: 'sumi' });
  });

  it.each([
    { defaultTheme: { id: 'japandi', scheme: 'not-a-scheme' }, expected: { id: 'japandi', scheme: 'sumi' } },
    { defaultTheme: BAUHAUS, expected: { id: 'japandi', scheme: 'sumi' } },
  ])(
    'uses a manifest scheme when the organization scheme does not fit $defaultTheme',
    async ({ defaultTheme, expected }) => {
      const { databaseId, gridViewId } = await database();
      await applied(databaseId, { kind: 'database.update', theme: KAWAII });
      const link = await ok<SharedViewLink>('PUT', `/api/views/${gridViewId}/shared-view`);
      await limitThemes(['japandi'], defaultTheme);
      expect((await publicView(link.linkId)).theme).toEqual(expected);
    },
  );

  it('shows a public form in its own theme over its database one, and checks who picks it', async () => {
    const { databaseId, tableId, f } = await database();
    const { formId, viewId, form } = await sharedForm(databaseId, tableId, f);
    expect((await publicForm(formId)).theme).toEqual({ id: 'nature', scheme: 'grove' });
    await applied(databaseId, { kind: 'database.update', theme: BAUHAUS });
    expect((await publicForm(formId)).theme).toEqual(BAUHAUS);
    await applied(databaseId, { kind: 'view.update', viewId, config: { form: { ...form, theme: KAWAII } } });
    expect((await publicForm(formId)).theme).toEqual(KAWAII);

    // A theme that doesn't exist, or one the person picking may not choose, is refused.
    const unknown = await send(databaseId, {
      kind: 'view.update',
      viewId,
      config: { form: { ...form, theme: { id: 'kawaii', scheme: 'not-a-scheme' } } },
    });
    expect(unknown).toMatchObject({ status: 'rejected', error: { messageKey: 'themes.unknown' } });
    await limitThemes(['nature', 'bauhaus'], { id: 'nature', scheme: 'grove' });
    const outside = await send(databaseId, {
      kind: 'view.update',
      viewId,
      config: { form: { ...form, theme: JAPANDI } },
    });
    expect(outside).toMatchObject({ status: 'rejected', error: { messageKey: 'orgUnits.policy.theme' } });
    // The form's own theme is no longer allowed, so its database's shows instead.
    expect((await publicForm(formId)).theme).toEqual(BAUHAUS);
    // Null goes back to the database's theme.
    await applied(databaseId, { kind: 'view.update', viewId, config: { form: { ...form, theme: null } } });
    expect((await publicForm(formId)).theme).toEqual(BAUHAUS);
  });

  it('shows a view link in its own theme, locked or open, and falls back to the default when nothing is allowed', async () => {
    const { databaseId, gridViewId } = await database();
    const link = await ok<SharedViewLink>('PUT', `/api/views/${gridViewId}/shared-view`);
    expect(link.settings.theme).toBeUndefined();
    expect(await publicView(link.linkId)).toMatchObject({
      status: 'open',
      theme: { id: 'nature', scheme: 'grove' },
    });

    await applied(databaseId, { kind: 'database.update', theme: KAWAII });
    expect((await publicView(link.linkId)).theme).toEqual(KAWAII);
    const changed = await ok<SharedViewLink>('PATCH', `/api/views/${gridViewId}/shared-view`, {
      theme: BAUHAUS,
    });
    expect(changed.settings.theme).toEqual(BAUHAUS);
    expect((await publicView(link.linkId)).theme).toEqual(BAUHAUS);
    // A password hides everything but how the page looks, and the page's theme is part of that.
    await ok('PATCH', `/api/views/${gridViewId}/shared-view`, { password: 'a password for the link' });
    expect(await publicView(link.linkId)).toEqual({ status: 'locked', theme: BAUHAUS });

    const shareChanges = (await auditOf('data.view.shareChanged')).filter(
      (row) => row.metadata.viewId === gridViewId,
    );
    expect(shareChanges.map((row) => row.metadata.changed)).toEqual([['theme'], ['password']]);

    const unknown = await call('PATCH', `/api/views/${gridViewId}/shared-view`, {
      theme: { id: 'not-a-theme', scheme: 'grove' },
    });
    expect(unknown.status).toBe(422);
    // Neither the link's theme nor the database's is allowed now, so the organization's default shows.
    await limitThemes(['nature', 'japandi'], JAPANDI);
    const outside = await call<{ error: { messageKey: string } }>(
      'PATCH',
      `/api/views/${gridViewId}/shared-view`,
      { theme: KAWAII },
    );
    expect(outside.status).toBe(403);
    expect(outside.body.error.messageKey).toBe('orgUnits.policy.theme');
    expect((await publicView(link.linkId)).theme).toEqual(JAPANDI);
    // With no default named, the first theme on the list stands in.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET settings = settings - 'defaultTheme'
      WHERE id = ${server.owner.info.org.id}`,
    );
    expect((await publicView(link.linkId)).theme).toEqual({ id: 'nature', scheme: 'grove' });

    // Null goes back to the database's theme, and the stored settings lose the key.
    await ok('PATCH', `/api/views/${gridViewId}/shared-view`, { theme: null });
    const settings = (
      await query<{ settings: Record<string, unknown> }>(
        server.pool,
        sql`SELECT settings FROM ${ident(server.schemas.app, 'shared_views')} WHERE id = ${link.linkId}`,
      )
    ).rows[0]!.settings;
    expect(settings).not.toHaveProperty('theme');
  });

  it('shows a booking page in its own theme without making the person who picks it the owner', async () => {
    const { databaseId, tableId, f } = await database();
    const settings = {
      title: 'Studio visits',
      timeFieldId: f.when,
      lengthMinutes: 60,
      timeZone: 'UTC',
      hours: ALL_DAY,
      nameFieldId: f.name,
      emailFieldId: f.email,
    };
    const page = await ok<BookingPage>('POST', `/api/tables/${tableId}/booking-pages`, {
      settings,
      enabled: true,
    });
    expect((await publicBooking(page.pageId)).theme).toEqual({ id: 'nature', scheme: 'grove' });
    await applied(databaseId, { kind: 'database.update', theme: KAWAII });
    expect((await publicBooking(page.pageId)).theme).toEqual(KAWAII);

    // Someone else who manages the table picks the page's theme.  The page still books as its owner.
    const creator = await server.addMember({ name: 'Blair Creator' });
    await grant(databaseId, creator, 'creator');
    const saved = await ok<BookingPage>(
      'PUT',
      `/api/booking-pages/${page.pageId}`,
      { settings: { ...page.settings, theme: BAUHAUS }, enabled: true },
      creator,
    );
    expect(saved.settings.theme).toEqual(BAUHAUS);
    expect(saved.owner?.id).toBe(server.owner.userId);
    expect((await publicBooking(page.pageId)).theme).toEqual(BAUHAUS);
    const changes = (await auditOf('data.bookingPage.changed')).filter(
      (row) => row.metadata.pageId === page.pageId,
    );
    expect(changes.map((row) => row.metadata.changed)).toEqual([['theme']]);

    const unknown = await call('PUT', `/api/booking-pages/${page.pageId}`, {
      settings: { ...page.settings, theme: { id: 'bauhaus', scheme: 'not-a-scheme' } },
      enabled: true,
    });
    expect(unknown.status).toBe(422);
  });
});

describe('copies keep a forced theme', () => {
  it('duplicates, snapshots, and templates carry the theme along', async () => {
    const { databaseId } = await database('Theme source');
    await applied(databaseId, { kind: 'database.update', theme: BAUHAUS });

    const duplicate = await ok<DatabaseCopy>('POST', `/api/databases/${databaseId}/duplicate`, {
      name: 'Theme copy',
      withRecords: false,
    });
    await server.ctx.databaseCopies!.settled(duplicate.id);
    const copied = await ok<DatabaseCopy>('GET', `/api/database-copies/${duplicate.id}`);
    expect(copied.state).toBe('finished');
    expect((await schemaOf(copied.databaseId!)).database.theme).toEqual(BAUHAUS);

    const snapshot = await ok<{ id: string }>('POST', `/api/databases/${databaseId}/snapshots`, {
      name: 'With its theme',
    });
    const restoring = await ok<DatabaseCopy>('POST', `/api/snapshots/${snapshot.id}/restore`, {
      name: 'Restored with its theme',
    });
    await server.ctx.databaseCopies!.settled(restoring.id);
    const restored = await ok<DatabaseCopy>('GET', `/api/database-copies/${restoring.id}`);
    expect((await schemaOf(restored.databaseId!)).database.theme).toEqual(BAUHAUS);

    const template = await ok<TemplateSummary>('POST', `/api/databases/${databaseId}/save-as-template`, {
      name: 'Themed template',
    });
    const fromTemplate = newId('database');
    const made = DatabaseSchema.parse(
      await ok('POST', '/api/databases/from-template', {
        id: fromTemplate,
        templateId: template.id,
        name: 'Made',
      }),
    );
    expect(made.database.theme).toEqual(BAUHAUS);
  });
});

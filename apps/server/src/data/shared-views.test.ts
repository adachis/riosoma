import { formFileAccepted } from './public-form-files.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  AttachmentMeta,
  encodeWhere,
  newId,
  SharedViewId,
  type CommandBatchResult,
  type PositionResult,
  type SharedRowsPage,
  type SharedStackCounts,
  type SharedView,
  type SharedViewLink,
  type SharedViewOpen,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import {
  fileAddress,
  passCookie,
  passCookieName,
  passCookieOptions,
  PASSWORD_LINK_TRIES,
  PASSWORD_TRIES,
  type FilePlace,
} from './shared-view-reads.js';

const LIMIT = 40;
let kit: TestPostgres;
let server: ServerFixture;
let webDir: string;
let quinn: SignedIn;

beforeAll(async () => {
  kit = await startTestPostgres();
  // A stand-in for the built web app, so the page route has a page to send.
  webDir = mkdtempSync(join(tmpdir(), 'rio-shared-views-web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Riosoma</title><div id="root"></div>');
  server = await startServer(kit, 'shviews', { sharedViewMinuteLimit: LIMIT, webDir });
  quinn = await server.addMember({ name: 'Quinn Outofview' });
  const policy = await server.app.inject({
    method: 'POST',
    url: '/api/public-sharing/commands',
    headers: server.owner.headers,
    payload: { id: newId('command'), action: { kind: 'policy', policy: { publicFiles: true } } },
  });
  expect(policy.statusCode, policy.body).toBe(200);
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
  if (webDir) rmSync(webDir, { recursive: true, force: true });
});

let addresses = 0;
/** A different address each time, so tests that aren't about the limit never reach it. */
const nextAddress = () => `198.51.100.${(addresses += 1) % 250}`;
const clientId = newId('client');

async function run(databaseId: string, input: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: { clientId, commands: [{ id: newId('command'), groupId: newId('action'), ...input }] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

async function grant(databaseId: string, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

async function png(color: string): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: color } })
    .png()
    .toBuffer();
}

/**
 * Projects, and the clients they link to.  The grid shows Name, Score, Owner, Photo, Notes,
 * Status, and Client, hides Secret, Visible, and Contract, sorts by Score from high to low, and
 * keeps only visible records whose secret doesn't mention "classified".  Bravo isn't visible, and
 * Quinn owns only Bravo, so neither should ever reach the public.
 */
async function fixture() {
  const databaseId = newId('database');
  const tableId = newId('table');
  const clientsId = newId('table');
  const gridId = newId('view');
  const f = {
    name: newId('field'),
    secret: newId('field'),
    visible: newId('field'),
    score: newId('field'),
    owner: newId('field'),
    photo: newId('field'),
    notes: newId('field'),
    status: newId('field'),
    client: newId('field'),
    contract: newId('field'),
    clientName: newId('field'),
    budget: newId('field'),
  };
  const draft = newId('choice');
  const published = newId('choice');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Garden',
      table: {
        id: tableId,
        name: 'Projects',
        fields: [{ id: f.name, name: 'Name', type: 'text' }],
        view: { id: gridId, name: 'Open projects' },
        records: [],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  await grant(databaseId, quinn, 'reader');
  await run(databaseId, {
    kind: 'table.create',
    table: {
      id: clientsId,
      name: 'Clients',
      fields: [
        { id: f.clientName, name: 'Client name', type: 'text' },
        { id: f.budget, name: 'Budget', type: 'number' },
      ],
      view: { id: newId('view'), name: 'Grid' },
      records: [],
    },
  });
  const fields: Array<[string, string, Record<string, unknown>]> = [
    [f.secret, 'Secret', { type: 'text' }],
    [f.visible, 'Visible', { type: 'checkbox' }],
    [f.score, 'Score', { type: 'number' }],
    [f.owner, 'Owner', { type: 'user' }],
    [f.photo, 'Photo', { type: 'attachment' }],
    [f.notes, 'Notes', { type: 'longText' }],
    [
      f.status,
      'Status',
      {
        type: 'singleSelect',
        options: {
          choices: [
            { id: draft, name: 'Draft', color: 'gray' },
            { id: published, name: 'Published', color: 'green' },
          ],
        },
      },
    ],
    [f.client, 'Client', { type: 'link', options: { linkedTableId: clientsId } }],
    [f.contract, 'Contract', { type: 'attachment' }],
  ];
  for (const [id, name, spec] of fields)
    await run(databaseId, { kind: 'field.create', tableId, field: { id, name, ...spec } });

  const upload = async (fieldId: string, bytes: Buffer, name: string) => {
    const uploaded = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${tableId}/fields/${fieldId}/files`,
      headers: {
        ...server.owner.headers,
        'content-type': 'image/png',
        'x-file-name': encodeURIComponent(name),
      },
      payload: bytes,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    return AttachmentMeta.parse(uploaded.json());
  };
  const alphaPhoto = await upload(f.photo, await png('#336699'), 'alpha-cover.png');
  const bravoPhoto = await upload(f.photo, await png('#993366'), 'bravo-cover.png');
  const contract = await upload(f.contract, await png('#669933'), 'alpha-contract.png');

  const acme = newId('record');
  await run(databaseId, {
    kind: 'record.create',
    tableId: clientsId,
    records: [{ id: acme, values: { [f.clientName]: 'Acme Corp', [f.budget]: 987654 } }],
  });
  const records = { acme, alpha: newId('record'), bravo: newId('record'), charlie: newId('record') };
  await run(databaseId, {
    kind: 'record.create',
    tableId,
    records: [
      {
        id: records.alpha,
        values: {
          [f.name]: 'Alpha',
          [f.secret]: 'alpha hidden note',
          [f.visible]: true,
          [f.score]: 1,
          [f.owner]: [server.owner.userId],
          [f.photo]: [alphaPhoto.id],
          [f.notes]: 'first notes',
          [f.status]: draft,
          [f.client]: [acme],
          [f.contract]: [contract.id],
        },
      },
      {
        id: records.bravo,
        values: {
          [f.name]: 'Bravo',
          [f.secret]: 'bravo hidden note',
          [f.visible]: false,
          [f.score]: 2,
          [f.owner]: [quinn.userId],
          [f.photo]: [bravoPhoto.id],
          [f.notes]: 'second notes',
          [f.status]: published,
        },
      },
      {
        id: records.charlie,
        values: {
          [f.name]: 'Charlie',
          [f.secret]: 'charlie hidden note',
          [f.visible]: true,
          [f.score]: 3,
          [f.notes]: 'third notes',
          [f.status]: published,
        },
      },
    ],
  });
  const filter = {
    conjunction: 'and',
    conditions: [
      { id: 'visible', fieldId: f.visible, operator: 'is', value: true },
      { id: 'secret', fieldId: f.secret, operator: 'doesNotContain', value: 'classified' },
    ],
  };
  const hiddenFieldIds = [f.secret, f.visible, f.contract];
  await run(databaseId, {
    kind: 'view.update',
    viewId: gridId,
    config: { filter, hiddenFieldIds, sorts: [{ fieldId: f.score, direction: 'desc' }] },
  });
  let views = 0;
  const view = async (type: string, config: Record<string, unknown>) => {
    const id = newId('view');
    views += 1;
    await run(databaseId, {
      kind: 'view.create',
      view: { id, tableId, name: `View ${views}`, type, config: { filter, hiddenFieldIds, ...config } },
    });
    return id;
  };
  return {
    databaseId,
    tableId,
    gridId,
    f,
    records,
    files: { alphaPhoto, bravoPhoto, contract },
    choices: { draft, published },
    view,
    edit: (recordId: string, values: Record<string, unknown>) =>
      run(databaseId, { kind: 'record.update', tableId, records: [{ id: recordId, values }] }),
  };
}

const linkRoute = (viewId: string) => `/api/views/${viewId}/shared-view`;
const manage = (
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
  viewId: string,
  payload?: Record<string, unknown>,
  who: SignedIn = server.owner,
) =>
  server.app.inject({
    method,
    url: linkRoute(viewId),
    headers: who.headers,
    ...(payload ? { payload } : {}),
  });

async function publish(viewId: string, update?: Record<string, unknown>): Promise<SharedViewLink> {
  let response = await manage('PUT', viewId);
  expect(response.statusCode, response.body).toBe(200);
  if (update) {
    response = await manage('PATCH', viewId, update);
    expect(response.statusCode, response.body).toBe(200);
  }
  return response.json<SharedViewLink>();
}

/** A request from someone who isn't signed in: another browser, at another address. */
function visit(
  url: string,
  options: { cookie?: string; address?: string; method?: 'GET' | 'POST'; payload?: unknown } = {},
) {
  return server.app.inject({
    method: options.method ?? 'GET',
    url,
    remoteAddress: options.address ?? nextAddress(),
    ...(options.cookie ? { headers: { cookie: options.cookie } } : {}),
    ...(options.payload !== undefined ? { payload: options.payload as Record<string, unknown> } : {}),
  });
}

async function layout(linkId: string, cookie?: string): Promise<SharedView> {
  const response = await visit(`/api/public/views/${linkId}`, { cookie });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SharedView>();
}

async function open(linkId: string, cookie?: string): Promise<SharedViewOpen> {
  const shared = await layout(linkId, cookie);
  if (shared.status !== 'open') throw new Error('expected an open view');
  return shared;
}

async function rows(linkId: string, params: Record<string, string> = {}, cookie?: string) {
  const response = await visit(`/api/public/views/${linkId}/rows?${new URLSearchParams(params)}`, { cookie });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SharedRowsPage>();
}

function cookieOf(response: LightMyRequestResponse): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') throw new Error('no cookie');
  return value.split(';')[0]!;
}

async function events(viewId: string) {
  const result = await query<{ action: string; actor_id: string | null; metadata: Record<string, unknown> }>(
    server.pool,
    sql`SELECT action, actor_id, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action LIKE 'data.view.%share%' AND metadata ->> 'viewId' = ${viewId} ORDER BY id`,
  );
  return result.rows;
}

describe('publishing a shared view', () => {
  it('lets only people who can change views read, publish, change, and stop a link', async () => {
    const f = await fixture();
    const reader = await server.addMember();
    const editor = await server.addMember();
    const creator = await server.addMember();
    const outsider = await server.addMember();
    await grant(f.databaseId, reader, 'reader');
    await grant(f.databaseId, editor, 'editor');
    await grant(f.databaseId, creator, 'creator');

    expect((await server.app.inject({ url: linkRoute(f.gridId) })).statusCode).toBe(401);
    let response = await manage('GET', f.gridId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toBeNull();
    for (const who of [reader, editor]) {
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
        response = await manage(method, f.gridId, method === 'PATCH' ? { allowCopy: true } : undefined, who);
        expect(response.statusCode, `${method} ${response.body}`).toBe(403);
        expect(response.json().error).toMatchObject({ code: 'forbidden', messageKey: 'data.access.denied' });
      }
    }
    expect((await manage('PUT', f.gridId, undefined, outsider)).statusCode).toBe(404);
    // Changing a link that doesn't exist says so.
    response = await manage('PATCH', f.gridId, { allowCopy: true });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.messageKey).toBe('shareView.notShared');

    response = await manage('PUT', f.gridId);
    expect(response.statusCode, response.body).toBe(200);
    const link = response.json<SharedViewLink>();
    expect(SharedViewId.safeParse(link.linkId).success).toBe(true);
    expect(link).toEqual({
      linkId: link.linkId,
      viewId: f.gridId,
      path: `/v/${link.linkId}`,
      url: `${server.config.baseUrl}/v/${link.linkId}`,
      createdAt: expect.any(String),
      createdBy: server.owner.userId,
      updatedAt: expect.any(String),
      settings: { fieldIds: null, allowCopy: false, embed: { enabled: false, sites: [] } },
      hasPassword: false,
      requiredFieldIds: [f.f.name],
      suspendedSharer: null,
    });
    // Publishing a shared view keeps its link, whoever does it.
    expect((await manage('PUT', f.gridId, undefined, creator)).json<SharedViewLink>().linkId).toBe(
      link.linkId,
    );
    response = await manage('PATCH', f.gridId, { allowCopy: true }, creator);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<SharedViewLink>().settings.allowCopy).toBe(true);
    expect(
      (await manage('GET', f.gridId, undefined, creator)).json<SharedViewLink>().settings.allowCopy,
    ).toBe(true);

    response = await manage('DELETE', f.gridId);
    expect(response.statusCode).toBe(204);
    expect((await manage('GET', f.gridId)).json()).toBeNull();
    expect((await manage('DELETE', f.gridId)).statusCode).toBe(204);
    const again = (await manage('PUT', f.gridId, undefined, creator)).json<SharedViewLink>();
    expect(again.linkId).not.toBe(link.linkId);
    expect(again.settings.allowCopy).toBe(false);
    expect((await events(f.gridId)).map((event) => [event.action, event.actor_id])).toEqual([
      ['data.view.shared', server.owner.userId],
      ['data.view.shareChanged', creator.userId],
      ['data.view.unshared', server.owner.userId],
      ['data.view.shared', creator.userId],
    ]);
  });

  it('shares grids, galleries, kanbans, calendars, lists, and maps, but not forms', async () => {
    const f = await fixture();
    const form = newId('view');
    await run(f.databaseId, {
      kind: 'view.create',
      view: { id: form, tableId: f.tableId, name: 'Signups', type: 'form', config: {} },
    });
    const response = await manage('PUT', form);
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({
      messageKey: 'data.view.badSetting',
      params: { setting: 'type' },
    });
    expect((await manage('GET', form)).json()).toBeNull();
    const gallery = await f.view('gallery', { gallery: { coverFieldId: f.f.photo } });
    const kanban = await f.view('kanban', { kanban: { stackFieldId: f.f.status } });
    const calendar = await f.view('calendar', { calendar: { startFieldId: null } });
    const list = await f.view('list', { list: { groupFieldId: f.f.status } });
    const map = await f.view('map', {});
    const types = new Map([
      [gallery, 'gallery'],
      [kanban, 'kanban'],
      [calendar, 'calendar'],
      [list, 'list'],
      [map, 'map'],
    ]);
    for (const [viewId, type] of types) {
      const link = await publish(viewId);
      expect((await open(link.linkId)).type).toBe(type);
    }
    expect((await publish(list)).requiredFieldIds).toEqual([f.f.name, f.f.status]);
    expect((await publish(map)).requiredFieldIds).toEqual([f.f.name]);
    expect((await publish(gallery)).requiredFieldIds).toEqual([f.f.name, f.f.photo]);
    expect((await publish(kanban)).requiredFieldIds).toEqual([f.f.name, f.f.status]);
  });

  it('shares lists and maps in their own order, with only the shared fields and the ones their layouts need', async () => {
    const f = await fixture();
    const place = newId('field');
    const parent = newId('field');
    await run(f.databaseId, {
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: place, name: 'Place', type: 'location' },
    });
    await run(f.databaseId, {
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: parent, name: 'Parent', type: 'link', options: { linkedTableId: f.tableId } },
    });
    await f.edit(f.records.alpha, { [place]: { lat: 51.5, lng: -0.12, label: 'Alpha yard' } });
    await f.edit(f.records.bravo, { [place]: { lat: 48.85, lng: 2.35, label: 'Bravo yard' } });
    await f.edit(f.records.charlie, {
      [place]: { lat: 40.7, lng: -74, label: 'Charlie yard' },
      [parent]: [f.records.alpha],
    });
    const hidden = [f.f.secret, f.f.visible, f.f.contract, parent, place, f.f.status];

    // A list nested by Parent, with Charlie moved above Alpha in the list's own order.
    const list = await f.view('list', { list: { parentFieldId: parent }, hiddenFieldIds: hidden });
    await run(f.databaseId, {
      kind: 'record.move',
      tableId: f.tableId,
      viewId: list,
      recordIds: [f.records.charlie],
      place: { before: f.records.alpha },
    });
    const listLink = await publish(list, { fieldIds: [f.f.notes] });
    expect(listLink.requiredFieldIds).toEqual([f.f.name, parent]);
    const sharedList = await open(listLink.linkId);
    expect(sharedList.type).toBe('list');
    expect(sharedList.fields.map((field) => field.name)).toEqual(['Name', 'Notes', 'Parent']);
    expect(sharedList.display.hiddenFieldIds).toEqual([parent]);
    expect(sharedList.display.list).toMatchObject({ parentFieldId: parent, groupFieldId: null });
    const listPage = await rows(listLink.linkId);
    expect(listPage.rows.map((row) => row?.id)).toEqual([f.records.charlie, f.records.alpha]);
    expect(listPage.rows.map((row) => Object.keys(row!.values).sort())).toEqual([
      [f.f.name, f.f.notes, parent].sort(),
      [f.f.name, f.f.notes, parent].sort(),
    ]);
    expect(listPage.linked).toEqual({});
    expect(listPage.attachments).toEqual({});

    const orgChart = await f.view('orgChart', {
      orgChart: { parentFieldId: parent },
      hiddenFieldIds: hidden,
    });
    const orgLink = await publish(orgChart, { fieldIds: [f.f.notes] });
    expect(orgLink.requiredFieldIds).toEqual([f.f.name, parent]);
    const sharedOrg = await open(orgLink.linkId);
    expect(sharedOrg.type).toBe('orgChart');
    expect(sharedOrg.display.orgChart).toEqual({ parentFieldId: parent });
    expect(sharedOrg.fields.map((field) => field.name)).toEqual(['Name', 'Notes', 'Parent']);
    const orgPage = await rows(orgLink.linkId);
    expect(orgPage.linked).toEqual({});
    expect(orgPage.rows.map((row) => row?.id)).toEqual([f.records.alpha, f.records.charlie]);
    expect(orgPage.rows.map((row) => Object.keys(row!.values).sort())).toEqual([
      [f.f.name, f.f.notes, parent].sort(),
      [f.f.name, f.f.notes, parent].sort(),
    ]);

    // A map by Place, colored by Status, sharing Photo besides, behind a password.
    const map = await f.view('map', {
      map: { locationFieldId: place, colorFieldId: f.f.status },
      hiddenFieldIds: hidden,
    });
    const mapLink = await publish(map, { fieldIds: [f.f.photo], password: 'harbor lights 7' });
    expect(mapLink.requiredFieldIds).toEqual([f.f.name, place, f.f.status]);
    expect((await layout(mapLink.linkId)).status).toBe('locked');
    expect((await visit(`/api/public/views/${mapLink.linkId}/rows`)).statusCode).toBe(403);
    const unlocked = await visit(`/api/public/views/${mapLink.linkId}/password`, {
      method: 'POST',
      payload: { password: 'harbor lights 7' },
    });
    expect(unlocked.statusCode, unlocked.body).toBe(204);
    const cookie = cookieOf(unlocked);
    const sharedMap = await open(mapLink.linkId, cookie);
    expect(sharedMap.type).toBe('map');
    expect(sharedMap.fields.map((field) => field.name)).toEqual(['Name', 'Photo', 'Place', 'Status']);
    expect(sharedMap.display.map).toEqual({ locationFieldId: place, colorFieldId: f.f.status });
    const mapPage = await rows(mapLink.linkId, { tz: 'UTC' }, cookie);
    expect(mapPage.rows.map((row) => row?.values[place])).toEqual([
      { lat: 51.5, lng: -0.12, label: 'Alpha yard' },
      { lat: 40.7, lng: -74, label: 'Charlie yard' },
    ]);
    const photo = mapPage.attachments![f.files.alphaPhoto.id]!;
    expect(photo.url.startsWith(`/api/public/views/${mapLink.linkId}/files/${f.records.alpha}/`)).toBe(true);
    expect(new URL(photo.url, 'http://localhost').searchParams.get('signature')).toMatch(/^[\w-]{43}$/);
    // Files behind a password need it too.
    expect((await visit(photo.url)).statusCode).toBe(403);
    expect((await visit(photo.url, { cookie })).statusCode).toBe(200);

    const everything = JSON.stringify([sharedList, listPage, sharedMap, mapPage, sharedOrg, orgPage]);
    for (const absent of [
      f.f.secret,
      f.f.visible,
      f.f.contract,
      f.f.score,
      f.f.owner,
      f.f.client,
      f.records.bravo,
      'Bravo yard',
      'hidden note',
      'Acme Corp',
      f.files.contract.id,
      f.files.bravoPhoto.id,
      server.owner.email,
      '/api/files/',
    ])
      expect(everything, absent).not.toContain(absent);
    expect(JSON.stringify([sharedList, listPage])).not.toContain('Alpha yard');
    expect(JSON.stringify([sharedMap, mapPage])).not.toContain('first notes');
    await f.edit(f.records.alpha, { [parent]: [f.records.bravo] });
    const filteredParentPage = await rows(orgLink.linkId);
    expect(filteredParentPage.linked).toEqual({});
    expect(JSON.stringify(filteredParentPage)).not.toContain('Bravo');
  });

  it('names a hidden link that groups a public list or grid, or lanes and labels a timeline', async () => {
    const f = await fixture();
    const start = newId('field');
    await run(f.databaseId, {
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: start, name: 'Start', type: 'date' },
    });
    await f.edit(f.records.alpha, { [start]: '2026-03-02' });
    await f.edit(f.records.charlie, { [start]: '2026-03-05' });
    // The sharer leaves Client off the cards, but each layout still reads it as a name.
    const hidden = [f.f.secret, f.f.visible, f.f.contract, f.f.client];

    const list = await f.view('list', { list: { groupFieldId: f.f.client }, hiddenFieldIds: hidden });
    const listLink = await publish(list, { fieldIds: [f.f.notes] });
    expect(listLink.requiredFieldIds).toEqual([f.f.name, f.f.client]);
    expect((await open(listLink.linkId)).display.hiddenFieldIds).toEqual([f.f.client]);
    expect((await rows(listLink.linkId)).linked).toEqual({ [f.records.acme]: 'Acme Corp' });

    const grid = await f.view('grid', {
      groups: [{ fieldId: f.f.client, direction: 'asc' }],
      hiddenFieldIds: hidden,
    });
    expect((await rows((await publish(grid, { fieldIds: [f.f.notes] })).linkId)).linked).toEqual({
      [f.records.acme]: 'Acme Corp',
    });

    const timeline = await f.view('timeline', {
      timeline: { startFieldId: start, groupFieldId: f.f.client, labelFieldId: f.f.client },
      hiddenFieldIds: hidden,
    });
    const timelineLink = await publish(timeline, { fieldIds: [] });
    expect(timelineLink.requiredFieldIds).toEqual([f.f.name, start, f.f.client]);
    expect((await rows(timelineLink.linkId)).linked).toEqual({ [f.records.acme]: 'Acme Corp' });

    // A parent link stays IDs only, since the names behind it can belong to records the filter hides.
    const parent = newId('field');
    await run(f.databaseId, {
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: parent, name: 'Parent', type: 'link', options: { linkedTableId: f.tableId } },
    });
    await f.edit(f.records.charlie, { [parent]: [f.records.alpha] });
    const chart = await f.view('orgChart', {
      orgChart: { parentFieldId: parent },
      hiddenFieldIds: [...hidden, parent],
    });
    const chartPage = await rows((await publish(chart, { fieldIds: [f.f.notes] })).linkId);
    expect(chartPage.linked).toEqual({});
    expect(JSON.stringify(chartPage)).not.toContain('Acme Corp');
  });

  it('checks each setting, and never sends a password back', async () => {
    const f = await fixture();
    await publish(f.gridId);
    for (const payload of [
      { password: 'short' },
      { embed: { enabled: true, sites: ['https://example.test; script-src *'] } },
      // A host may hold these as far as the URL parser is concerned, and each one would start a
      // directive of its own in the frame policy the page sends.
      { embed: { enabled: true, sites: ['https://example.test;sandbox'] } },
      { embed: { enabled: true, sites: ['https://example.test,https://collector.test'] } },
      { embed: { enabled: true, sites: ["https://example.test'"] } },
      { embed: { enabled: true, sites: ['javascript:alert(1)'] } },
      { embed: { enabled: true, sites: ['https://example.test/path'] } },
      { embed: { enabled: true, sites: ['https://*.example.test'] } },
      { fieldIds: ['not a field'] },
    ]) {
      const response = await manage('PATCH', f.gridId, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(422);
    }
    const response = await manage('PATCH', f.gridId, {
      password: 'garden gate 42',
      fieldIds: [f.f.score, f.f.score, newId('field')],
      embed: {
        enabled: true,
        sites: ['https://a.example.test', 'https://a.example.test', 'https://b.test:8443'],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain('garden gate');
    expect(response.body).not.toContain('argon2');
    const link = response.json<SharedViewLink>();
    expect(link.hasPassword).toBe(true);
    expect(link.settings).toEqual({
      fieldIds: [f.f.score],
      allowCopy: false,
      embed: { enabled: true, sites: ['https://a.example.test', 'https://b.test:8443'] },
    });
    const stored = await query<{ password_hash: string }>(
      server.pool,
      sql`SELECT password_hash FROM ${ident(server.schemas.app, 'shared_views')} WHERE id = ${link.linkId}`,
    );
    expect(stored.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    const [changed] = (await events(f.gridId)).filter((event) => event.action === 'data.view.shareChanged');
    expect(changed!.metadata).toMatchObject({ changed: ['fields', 'password'] });
    expect(JSON.stringify(changed)).not.toContain('garden gate');
    expect((await manage('PATCH', f.gridId, { password: null })).json<SharedViewLink>().hasPassword).toBe(
      false,
    );
  });
});

describe('what a shared view sends', () => {
  it('sends only the shared fields and the filtered records, from every route', async () => {
    const f = await fixture();
    const link = await publish(f.gridId, { allowCopy: true });
    const bodies: string[] = [];
    const keep = async (response: LightMyRequestResponse) => {
      expect(response.statusCode, response.body).toBe(200);
      bodies.push(response.body);
      return response;
    };

    const shared = await open(link.linkId);
    bodies.push(JSON.stringify(shared));
    expect(shared).toMatchObject({
      status: 'open',
      linkId: link.linkId,
      name: 'Open projects',
      type: 'grid',
    });
    expect(shared.fields.map((field) => field.name)).toEqual([
      'Name',
      'Score',
      'Owner',
      'Photo',
      'Notes',
      'Status',
      'Client',
    ]);
    expect(shared.primaryFieldId).toBe(f.f.name);
    expect(shared.display.hiddenFieldIds).toEqual([]);
    // Links show their records' names alone, so nothing names the table they point at.
    expect(shared.fields.find((field) => field.id === f.f.client)!.options).toEqual({ prefersSingle: false });
    expect(Object.keys(shared)).not.toContain('filter');

    const page = await rows(link.linkId);
    bodies.push(JSON.stringify(page));
    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row?.values[f.f.name])).toEqual(['Charlie', 'Alpha']);
    const alpha = page.rows[1]!;
    expect(Object.keys(alpha.values).sort()).toEqual(
      [f.f.name, f.f.score, f.f.owner, f.f.photo, f.f.notes, f.f.status, f.f.client].sort(),
    );
    // Who made or changed a record goes out only as a field, and no field here shows it.
    expect(alpha).toMatchObject({ createdAt: '', createdBy: null, updatedAt: '', updatedBy: null });
    expect(alpha.overrides).toBeUndefined();
    expect(page.linked).toEqual({ [f.records.acme]: 'Acme Corp' });
    expect(page.people).toEqual({ [server.owner.userId]: 'Owner' });
    const photo = page.attachments![f.files.alphaPhoto.id]!;
    expect(photo.name).toBe('alpha-cover.png');
    expect(
      photo.url.startsWith(
        `/api/public/views/${link.linkId}/files/${f.records.alpha}/${f.f.photo}/${photo.id}/file?`,
      ),
    ).toBe(true);
    expect(Object.keys(page.attachments!)).toEqual([f.files.alphaPhoto.id]);

    await keep(await visit(`/api/public/views/${link.linkId}/position?recordId=${f.records.alpha}`));
    expect(JSON.parse(bodies.at(-1)!)).toMatchObject({ index: 1, total: 2 });
    const bravo = await keep(
      await visit(`/api/public/views/${link.linkId}/position?recordId=${f.records.bravo}`),
    );
    expect(bravo.json<PositionResult>().index).toBeNull();
    for (const q of ['alpha hidden', 'Bravo', 'classified', '987654', 'second notes'])
      expect((await rows(link.linkId, { q })).total, q).toBe(0);
    const searches: Array<[string, string[]]> = [
      ['charlie', ['Charlie']],
      ['acme', ['Alpha']],
      ['publish', ['Charlie']],
      ['owner', ['Alpha']],
      ['cover', ['Alpha']],
      ['first', ['Alpha']],
    ];
    for (const [q, names] of searches) {
      const found = await rows(link.linkId, { q });
      bodies.push(JSON.stringify(found));
      expect(
        found.rows.map((row) => row?.values[f.f.name]),
        q,
      ).toEqual(names);
    }
    const csv = await keep(
      await visit(`/api/public/views/${link.linkId}/download?timeZone=UTC&locale=en-US`),
    );
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toContain('Open projects.csv');
    expect(
      csv.body
        .replace(/^\uFEFF/, '')
        .trim()
        .split(/\r?\n/),
    ).toEqual([
      'Name,Score,Owner,Photo,Notes,Status,Client',
      'Charlie,3,,,third notes,Published,',
      'Alpha,1,Owner,alpha-cover.png,first notes,Draft,Acme Corp',
    ]);
    const where = encodeWhere({
      conjunction: 'and',
      conditions: [{ id: 'part', fieldId: f.f.name, operator: 'is', value: 'Charlie' }],
    });
    const withToken = await keep(
      await visit(
        `/api/public/views/${link.linkId}/download?${new URLSearchParams({
          timeZone: 'UTC',
          locale: 'en-US',
          where,
        })}`,
      ),
    );
    expect(withToken.body).toBe(csv.body);
    await keep(await visit(photo.url));

    const everything = bodies.join('\n');
    for (const absent of [
      f.f.secret,
      f.f.visible,
      f.f.contract,
      f.f.budget,
      f.records.bravo,
      f.files.bravoPhoto.id,
      f.files.contract.id,
      quinn.userId,
      'Quinn Outofview',
      'hidden note',
      'Bravo',
      'bravo-cover',
      'alpha-contract',
      'classified',
      '987654',
      server.owner.email,
      '/api/files/',
    ])
      expect(everything, absent).not.toContain(absent);
  });

  it('shares only the picked fields the view shows, and the ones its layout needs', async () => {
    const f = await fixture();
    const link = await publish(f.gridId, { fieldIds: [f.f.score, f.f.secret, f.f.notes] });
    let shared = await open(link.linkId);
    // Secret is picked, but the view hides it, so it stays private.
    expect(shared.fields.map((field) => field.name)).toEqual(['Name', 'Score', 'Notes']);
    let page = await rows(link.linkId);
    expect(page.rows.map((row) => Object.keys(row!.values).sort())).toEqual([
      [f.f.name, f.f.score, f.f.notes].sort(),
      [f.f.name, f.f.score, f.f.notes].sort(),
    ]);
    expect(page.attachments).toEqual({});
    expect(page.linked).toEqual({});
    expect(page.people).toEqual({});
    expect((await rows(link.linkId, { q: 'owner' })).total).toBe(0);

    // A field the view stops showing stops being shared at once.
    await run(f.databaseId, {
      kind: 'view.update',
      viewId: f.gridId,
      config: { hiddenFieldIds: [f.f.secret, f.f.visible, f.f.contract, f.f.notes] },
    });
    shared = await open(link.linkId);
    expect(shared.fields.map((field) => field.name)).toEqual(['Name', 'Score']);
    page = await rows(link.linkId);
    expect(JSON.stringify(page)).not.toContain('notes');

    // A kanban's stack field is shared even when the cards hide it.
    const kanban = await f.view('kanban', {
      kanban: { stackFieldId: f.f.status, stackOrder: [f.choices.published, ''] },
      hiddenFieldIds: [f.f.secret, f.f.visible, f.f.contract, f.f.status],
    });
    const board = await publish(kanban, { fieldIds: [f.f.score] });
    shared = await open(board.linkId);
    expect(shared.fields.map((field) => field.name)).toEqual(['Name', 'Score', 'Status']);
    expect(shared.display.hiddenFieldIds).toEqual([f.f.status]);
    expect(shared.display.kanban).toMatchObject({
      stackFieldId: f.f.status,
      stackOrder: [f.choices.published, ''],
    });
  });

  it('never lets a record edited out of the view through an order taken before', async () => {
    const f = await fixture();
    const link = await publish(f.gridId);
    const first = await rows(link.linkId);
    expect(first.rows.map((row) => row?.id)).toEqual([f.records.charlie, f.records.alpha]);
    await f.edit(f.records.alpha, { [f.f.secret]: 'now classified' });
    const again = await rows(link.linkId, { snapshot: first.snapshot });
    // Either the old order with the record gone, or a new order without it.
    expect(again.rows.filter(Boolean).map((row) => row?.id)).toEqual([f.records.charlie]);
    expect(JSON.stringify(again)).not.toContain('Alpha');
    expect((await rows(link.linkId, { refresh: '1' })).total).toBe(1);
  });

  it('stops, rather than showing every record, while a condition of its filter can never apply', async () => {
    const f = await fixture();
    const link = await publish(f.gridId, { allowCopy: true });
    expect((await rows(link.linkId)).total).toBe(2);
    // The app leaves out a condition on a field that's gone, which would show Bravo to the public.
    await run(f.databaseId, { kind: 'field.trash', fieldId: f.f.visible });
    for (const suffix of ['', '/rows', '/stacks', '/download?timeZone=UTC&locale=en-US']) {
      const response = await visit(`/api/public/views/${link.linkId}${suffix}`);
      expect(response.statusCode, suffix).toBe(404);
      expect(response.json().error.messageKey).toBe('shareView.notFound');
      expect(response.body).not.toContain('Bravo');
    }
    await run(f.databaseId, { kind: 'field.restore', fieldId: f.f.visible });
    expect((await rows(link.linkId, { refresh: '1' })).total).toBe(2);
    // A condition still waiting for its value is left out, as it is in the app.
    await run(f.databaseId, {
      kind: 'view.update',
      viewId: f.gridId,
      config: {
        filter: {
          conjunction: 'and',
          conditions: [
            { id: 'visible', fieldId: f.f.visible, operator: 'is', value: true },
            { id: 'unfinished', fieldId: f.f.notes, operator: 'contains', value: '' },
          ],
        },
      },
    });
    expect((await rows(link.linkId, { refresh: '1' })).total).toBe(2);
  });

  it('counts a kanban’s stacks through the filter, naming only people with cards', async () => {
    const f = await fixture();
    const byStatus = await publish(await f.view('kanban', { kanban: { stackFieldId: f.f.status } }));
    let response = await visit(`/api/public/views/${byStatus.linkId}/stacks?tz=UTC`);
    expect(response.statusCode, response.body).toBe(200);
    const statuses = response.json<SharedStackCounts>().stacks;
    expect(new Map(statuses.map((stack) => [stack.id, stack.count]))).toEqual(
      new Map([
        [f.choices.draft, 1],
        [f.choices.published, 1],
        ['', 0],
      ]),
    );
    const stack = await rows(byStatus.linkId, { stack: f.choices.published });
    expect(stack.rows.map((row) => row?.values[f.f.name])).toEqual(['Charlie']);

    const byOwner = await publish(
      await f.view('kanban', {
        kanban: { stackFieldId: f.f.owner, stackOrder: [quinn.userId, server.owner.userId, ''] },
      }),
    );
    response = await visit(`/api/public/views/${byOwner.linkId}/stacks?tz=UTC&q=char`);
    expect(response.json<SharedStackCounts>()).toEqual({ stacks: [{ id: '', count: 1 }], people: {} });
    response = await visit(`/api/public/views/${byOwner.linkId}/stacks?tz=UTC`);
    const owners = response.json<SharedStackCounts>();
    expect(owners.people).toEqual({ [server.owner.userId]: 'Owner' });
    expect(new Set(owners.stacks.map((stack) => stack.id))).toEqual(new Set([server.owner.userId, '']));
    const shared = await open(byOwner.linkId);
    expect(shared.display.kanban.stackOrder).toEqual([server.owner.userId, '']);
    const bodies = [response.body, JSON.stringify(shared)].join('\n');
    expect(bodies).not.toContain(quinn.userId);
    expect(bodies).not.toContain('Quinn');
  });

  it('hands out files through short-lived signed addresses, only while their records are in view', async () => {
    const f = await fixture();
    const gallery = await f.view('gallery', { gallery: { coverFieldId: f.f.photo } });
    const link = await publish(gallery, { fieldIds: [] });
    expect((await open(link.linkId)).fields.map((field) => field.name)).toEqual(['Name', 'Photo']);
    const page = await rows(link.linkId, { tz: 'UTC' });
    const photo = page.attachments![f.files.alphaPhoto.id]!;
    expect(photo.createdAt).toBe('');
    for (const url of [photo.url, photo.thumbnails.small!, photo.thumbnails.large!]) {
      const response = await visit(url);
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-security-policy']).toContain('sandbox');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect((await visit(photo.url)).headers['content-type']).toBe('image/png');

    const expires = Number(new URL(photo.url, 'http://localhost').searchParams.get('expires'));
    const address = (
      place: Partial<FilePlace> = {},
      when = expires,
      key = createHmac('sha256', server.config.secretKey)
        .update(JSON.stringify(['riosoma.publicFile', null, null]))
        .digest(),
    ) =>
      fileAddress(
        key,
        {
          linkId: link.linkId,
          recordId: f.records.alpha,
          fieldId: f.f.photo,
          attachmentId: f.files.alphaPhoto.id,
          variant: 'file',
          timeZone: 'UTC',
          ...place,
        },
        when,
      );
    expect(address()).toBe(photo.url);
    const now = Math.floor(Date.now() / 1000);
    for (const url of [
      // Altered: another file, size, expiry, or time zone under the old signature.
      photo.url.replace(f.files.alphaPhoto.id, f.files.bravoPhoto.id),
      photo.url.replace('/file?', '/small?'),
      photo.url.replace(`expires=${expires}`, `expires=${expires + 60}`),
      photo.url.replace('tz=UTC', 'tz=Asia%2FTokyo'),
      // Signed with another key, run out, or reaching too far ahead.
      address({}, expires, Buffer.alloc(32, 7)),
      address({}, now - 60),
      address({}, now + 3 * 3_600),
      // Properly signed, but for a hidden field's file, a filtered-out record's file, or a file
      // named under a record or field that doesn't hold it.
      address({ fieldId: f.f.contract, attachmentId: f.files.contract.id }),
      address({ recordId: f.records.bravo, attachmentId: f.files.bravoPhoto.id }),
      address({ attachmentId: f.files.bravoPhoto.id }),
      address({ recordId: f.records.charlie }),
      address({ fieldId: f.f.contract }),
    ]) {
      const response = await visit(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.json().error.messageKey).toBe('shareView.notFound');
    }
    for (const state of ['quarantined', 'infected', 'unavailable']) {
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'files')}
        SET scan_state = ${state} WHERE id = ${photo.id}`,
      );
      for (const url of [photo.url, photo.thumbnails.small!, photo.thumbnails.large!])
        expect((await visit(url)).statusCode).toBe(404);
      expect((await rows(link.linkId, { tz: 'UTC' })).attachments?.[photo.id]).toBeUndefined();
    }
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'files')}
      SET scan_state = 'clean' WHERE id = ${photo.id}`,
    );
    // A record that leaves the view takes its files with it at once, and brings them back on return.
    await f.edit(f.records.alpha, { [f.f.visible]: false });
    expect((await visit(photo.url)).statusCode).toBe(404);
    await f.edit(f.records.alpha, { [f.f.visible]: true });
    expect((await visit(photo.url)).statusCode).toBe(200);
    // So does a field that stops being shared.
    await run(f.databaseId, {
      kind: 'view.update',
      viewId: gallery,
      config: { gallery: { coverFieldId: null } },
    });
    expect((await visit(photo.url)).statusCode).toBe(404);
  });
});

describe('passwords', () => {
  it('asks once, remembers it for that link only, and forgets it when the password changes', async () => {
    const f = await fixture();
    const other = await publish(await f.view('grid', {}), { password: 'other gate 42' });
    const link = await publish(f.gridId, { password: 'garden gate 42' });
    const base = `/api/public/views/${link.linkId}`;
    expect(await layout(link.linkId)).toEqual({
      status: 'locked',
      theme: { id: 'nature', scheme: 'grove' },
    });
    for (const url of [`${base}/rows`, `${base}/stacks`, `${base}/position?recordId=${f.records.alpha}`]) {
      const response = await visit(url);
      expect(response.statusCode, url).toBe(403);
      expect(response.json().error.messageKey).toBe('shareView.passwordRequired');
    }

    let response = await visit(`${base}/password`, {
      method: 'POST',
      payload: { password: 'wrong gate 42' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.messageKey).toBe('shareView.passwordWrong');
    expect(response.headers['set-cookie']).toBeUndefined();
    response = await visit(`${base}/password`, { method: 'POST', payload: { password: 'garden gate 42' } });
    expect(response.statusCode, response.body).toBe(204);
    const header = String(response.headers['set-cookie']);
    expect(header).toContain(`${passCookieName(link.linkId)}=`);
    expect(header).toContain(`Path=${base}`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toMatch(/Max-Age=28800/);
    expect(header).not.toContain('garden');
    const cookie = cookieOf(response);

    expect((await open(link.linkId, cookie)).name).toBe('Open projects');
    expect((await rows(link.linkId, {}, cookie)).total).toBe(2);
    // The cookie opens its own link and no other.
    expect((await layout(other.linkId, cookie.replace(link.linkId, other.linkId))).status).toBe('locked');
    expect((await visit(`/api/public/views/${other.linkId}/rows`, { cookie })).statusCode).toBe(403);
    // A cookie that was tampered with, or made with another key, opens nothing.  The replacement
    // comes from a list that can never hold the character already there, so the tampering always
    // changes the decoded bytes.  The final character is left alone, since a change there can land
    // in bits that only pad a partial byte and so never reach the decoded value.
    const [name, value] = cookie.split('=') as [string, string];
    const swapped = ['B', 'A', 'C'].find((letter) => letter !== value.at(-2))!;
    const flipped = `${value.slice(0, -2)}${swapped}${value.slice(-1)}`;
    expect((await layout(link.linkId, `${name}=${flipped}`)).status).toBe('locked');
    const stored = await query<{ password_hash: string }>(
      server.pool,
      sql`SELECT password_hash FROM ${ident(server.schemas.app, 'shared_views')} WHERE id = ${link.linkId}`,
    );
    const foreign = passCookie(Buffer.alloc(32, 9), link.linkId, stored.rows[0]!.password_hash);
    expect((await layout(link.linkId, `${name}=${foreign}`)).status).toBe('locked');
    // An expired proof opens nothing either.
    const old = passCookie(
      server.config.secretKey,
      link.linkId,
      stored.rows[0]!.password_hash,
      Date.now() - 9 * 3_600_000,
    );
    expect((await layout(link.linkId, `${name}=${old}`)).status).toBe('locked');

    // A new password, even the same one again, needs asking again.
    await manage('PATCH', f.gridId, { password: 'garden gate 42' });
    expect((await layout(link.linkId, cookie)).status).toBe('locked');
    await manage('PATCH', f.gridId, { password: null });
    expect((await layout(link.linkId)).status).toBe('open');
  });

  it('stops answering an address that keeps guessing', async () => {
    const f = await fixture();
    const link = await publish(f.gridId, { password: 'garden gate 42' });
    const address = '192.0.2.77';
    const guess = (password: string, from = address) =>
      visit(`/api/public/views/${link.linkId}/password`, {
        method: 'POST',
        payload: { password },
        address: from,
      });
    for (let attempt = 0; attempt < 10; attempt += 1)
      expect((await guess(`guess ${attempt}`)).statusCode).toBe(403);
    const response = await guess('garden gate 42');
    expect(response.statusCode).toBe(429);
    expect(response.json().error.messageKey).toBe('shareView.tooManyTries');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect((await guess('garden gate 42', '192.0.2.78')).statusCode).toBe(204);
  });

  it('counts one IPv6 network as one address, however its guesses move around inside it', async () => {
    const f = await fixture();
    const link = await publish(f.gridId, { password: 'garden gate 42' });
    const guess = (password: string, address: string) =>
      visit(`/api/public/views/${link.linkId}/password`, { method: 'POST', payload: { password }, address });
    for (let attempt = 0; attempt < PASSWORD_TRIES.limit; attempt += 1)
      expect(
        (await guess(`guess ${attempt}`, `2001:db8:77:1::${(attempt + 1).toString(16)}`)).statusCode,
      ).toBe(403);
    const response = await guess('garden gate 42', '2001:db8:77:1:ffff::1');
    expect(response.statusCode).toBe(429);
    expect(response.json().error.messageKey).toBe('shareView.tooManyTries');
    // An address written the IPv6 way counts with its IPv4 self, and another network starts fresh.
    for (let attempt = 0; attempt < PASSWORD_TRIES.limit; attempt += 1)
      expect(
        (await guess(`guess ${attempt}`, attempt % 2 ? '192.0.2.79' : '::ffff:192.0.2.79')).statusCode,
      ).toBe(403);
    expect((await guess('garden gate 42', '192.0.2.79')).statusCode).toBe(429);
    expect((await guess('garden gate 42', '2001:db8:77:2::1')).statusCode).toBe(204);
  });

  it('stops taking guesses at one link’s password, wherever they come from', async () => {
    const f = await fixture();
    const link = await publish(f.gridId, { password: 'garden gate 42' });
    const guess = (password: string, address: string) =>
      visit(`/api/public/views/${link.linkId}/password`, { method: 'POST', payload: { password }, address });
    // The right password costs the link nothing, so its visitors never use up the wrong guesses.
    for (let visitor = 0; visitor < 5; visitor += 1)
      expect((await guess('garden gate 42', `203.0.113.${200 + visitor}`)).statusCode).toBe(204);
    // Every guess comes from an address of its own, so no address reaches its own limit.
    const addresses = Array.from(
      { length: PASSWORD_LINK_TRIES.limit },
      (_, index) => `203.0.${113 + Math.floor(index / 100)}.${1 + (index % 100)}`,
    );
    for (let start = 0; start < addresses.length; start += 20) {
      const answers = await Promise.all(
        addresses.slice(start, start + 20).map((address, index) => guess(`guess ${start + index}`, address)),
      );
      expect(answers.map((answer) => answer.statusCode)).toEqual(answers.map(() => 403));
    }
    const response = await guess('garden gate 42', '203.0.115.1');
    expect(response.statusCode).toBe(429);
    expect(response.json().error.messageKey).toBe('shareView.tooManyTries');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    // A browser that already gave the password keeps reading, and other links are untouched.
    const stored = await query<{ password_hash: string }>(
      server.pool,
      sql`SELECT password_hash FROM ${ident(server.schemas.app, 'shared_views')} WHERE id = ${link.linkId}`,
    );
    const pass = passCookie(server.config.secretKey, link.linkId, stored.rows[0]!.password_hash);
    expect((await rows(link.linkId, {}, `${passCookieName(link.linkId)}=${pass}`)).total).toBe(2);
    const other = await fixture();
    const second = await publish(other.gridId, { password: 'garden gate 42' });
    expect(
      (
        await visit(`/api/public/views/${second.linkId}/password`, {
          method: 'POST',
          payload: { password: 'garden gate 42' },
          address: '203.0.115.2',
        })
      ).statusCode,
    ).toBe(204);
  }, 120_000);
});

describe('abuse limits and headers', () => {
  it('limits how often one address may read shared views', async () => {
    const f = await fixture();
    const link = await publish(f.gridId);
    const address = '192.0.2.10';
    for (let request = 0; request < LIMIT; request += 1)
      expect((await visit(`/api/public/views/${link.linkId}`, { address })).statusCode).toBe(200);
    const response = await visit(`/api/public/views/${link.linkId}/rows`, { address });
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toMatchObject({
      code: 'rate_limited',
      messageKey: 'shareView.rateLimited',
    });
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect((await visit(`/v/${link.linkId}`, { address })).statusCode).toBe(429);
    expect((await visit(`/api/public/views/${link.linkId}`, { address: '192.0.2.11' })).statusCode).toBe(200);
    // Signed-in people changing links aren't counted.
    expect((await manage('GET', f.gridId)).statusCode).toBe(200);
  });

  it('lets only exact listed origins frame enabled pages and keeps other pages same-origin', async () => {
    const f = await fixture();
    const link = await publish(f.gridId);
    const page = () => visit(`/v/${link.linkId}`);
    const ancestors = (response: LightMyRequestResponse) =>
      /frame-ancestors ([^;]+)/.exec(String(response.headers['content-security-policy']))?.[1];

    let response = await page();
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<div id="root">');
    expect(ancestors(response)).toBe("'self'");
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    // The rest of the page's policy stays as strict as everywhere else.
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(String(response.headers['content-security-policy']).match(/frame-ancestors/g)).toHaveLength(1);

    await manage('PATCH', f.gridId, {
      embed: { enabled: true, sites: ['https://blog.example.test', 'https://docs.example.test'] },
    });
    response = await page();
    expect(ancestors(response)).toBe('https://blog.example.test https://docs.example.test');
    expect(response.headers['x-frame-options']).toBeUndefined();
    await manage('PATCH', f.gridId, { embed: { enabled: true, sites: [] } });
    expect(ancestors(await page())).toBe("'self'");
    await manage('PATCH', f.gridId, { embed: { enabled: false, sites: ['https://blog.example.test'] } });
    expect(ancestors(await page())).toBe("'self'");

    // Other pages keep framing to this site alone, and forged or stopped links can't be framed.
    expect(ancestors(await visit('/'))).toBe("'self'");
    await manage('PATCH', f.gridId, { embed: { enabled: true, sites: [] } });
    response = await visit(`/v/${'A'.repeat(22)}`);
    expect(response.statusCode).toBe(200);
    expect(ancestors(response)).toBe("'self'");
    await manage('DELETE', f.gridId);
    response = await page();
    expect(ancestors(response)).toBe("'self'");
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('keeps a stored site that isn’t an exact origin out of the frame policy', async () => {
    const f = await fixture();
    const link = await publish(f.gridId);
    // A rule from before origins were checked strictly, or one written past the checks.  The URL
    // parser reads a semicolon and a quote as part of a host, so each of these would start a
    // directive of its own once the sites were joined into the header.
    const stored = JSON.stringify({
      enabled: true,
      sites: ['https://a.test;sandbox', "https://d.test'", 'https://e.test;report-uri'],
    });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'shared_views')}
        SET settings = jsonb_set(settings, '{embed}', ${stored}::jsonb) WHERE id = ${link.linkId}`,
    );
    const response = await visit(`/v/${link.linkId}`);
    expect(response.statusCode).toBe(200);
    const policy = String(response.headers['content-security-policy']);
    expect(policy.match(/frame-ancestors/g)).toHaveLength(1);
    expect(/frame-ancestors ([^;]+)/.exec(policy)?.[1]).toBe("'self'");
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    // The page carries the same directives as any other page, so no listed site added one.
    const names = (value: string) =>
      value
        .split(';')
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean)
        .sort();
    expect(names(policy)).toEqual(names(String((await visit('/')).headers['content-security-policy'])));
    expect(policy).not.toContain('sandbox');
    expect(policy).not.toContain('report-uri');
    // The link still reads, with the rest of its settings as they were.
    expect((await open(link.linkId)).status).toBe('open');
    expect((await manage('GET', f.gridId)).json<SharedViewLink>().settings.allowCopy).toBe(false);
  });

  it('sets a cookie an embedded page can read over a secure connection', async () => {
    const f = await fixture();
    const link = await publish(f.gridId, {
      password: 'garden gate 42',
      embed: { enabled: true, sites: ['https://blog.example.test'] },
    });
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/public/views/${link.linkId}/password`,
      remoteAddress: nextAddress(),
      headers: { 'x-forwarded-proto': 'https' },
      payload: { password: 'garden gate 42' },
    });
    expect(response.statusCode).toBe(204);
    // Proxies aren't trusted here, so the connection reads as plain and the cookie stays first-party.
    expect(String(response.headers['set-cookie'])).toContain('SameSite=Lax');
    expect(passCookieOptions(link.linkId, true, true)).toMatchObject({
      secure: true,
      sameSite: 'none',
      partitioned: true,
      httpOnly: true,
    });
    expect(passCookieOptions(link.linkId, true, false)).toMatchObject({ secure: true, sameSite: 'lax' });
    expect(passCookieOptions(link.linkId, true, false)).not.toHaveProperty('partitioned');
    expect(passCookieOptions(link.linkId, false, true)).toMatchObject({ secure: false, sameSite: 'lax' });
  });
});

describe('stopped and forged links', () => {
  it('stops working at once, everywhere, when sharing stops', async () => {
    const f = await fixture();
    const link = await publish(f.gridId, { allowCopy: true });
    const page = await rows(link.linkId);
    const photo = page.attachments![f.files.alphaPhoto.id]!;
    const base = `/api/public/views/${link.linkId}`;
    const urls = [
      base,
      `${base}/rows`,
      `${base}/rows?snapshot=${page.snapshot}&offset=0`,
      `${base}/position?recordId=${f.records.alpha}`,
      `${base}/download?timeZone=UTC&locale=en-US`,
      photo.url,
    ];
    for (const url of urls) expect((await visit(url)).statusCode, url).toBe(200);
    await manage('DELETE', f.gridId);
    for (const url of urls) {
      const response = await visit(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.json().error).toMatchObject({ code: 'not_found', messageKey: 'shareView.notFound' });
    }
    const response = await visit(`${base}/password`, {
      method: 'POST',
      payload: { password: 'anything at all' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers forged and malformed links as missing', async () => {
    for (const linkId of [
      'A'.repeat(22),
      'B1c2D3e4F5g6H7i8J9k0Lm',
      'short',
      '%3Cscript%3E',
      `${'A'.repeat(22)}x`,
    ]) {
      for (const suffix of ['', '/rows', '/stacks', '/download?timeZone=UTC&locale=en-US']) {
        const response = await visit(`/api/public/views/${linkId}${suffix}`);
        expect(response.statusCode, `${linkId}${suffix}`).toBe(404);
        expect(response.json().error.messageKey).toBe('shareView.notFound');
      }
    }
  });

  it('closes while its view, table, or database is in the trash, and opens again on restore', async () => {
    const f = await fixture();
    const link = await publish(f.gridId);
    // A table keeps at least one view, so the grid gets company before it goes to the trash.
    await f.view('gallery', {});
    for (const [trash, restore] of [
      [
        { kind: 'view.trash', viewId: f.gridId },
        { kind: 'view.restore', viewId: f.gridId },
      ],
      [
        { kind: 'table.trash', tableId: f.tableId },
        { kind: 'table.restore', tableId: f.tableId },
      ],
      [{ kind: 'database.trash' }, { kind: 'database.restore' }],
    ]) {
      await run(f.databaseId, trash!);
      expect((await visit(`/api/public/views/${link.linkId}`)).statusCode, trash!.kind).toBe(404);
      await run(f.databaseId, restore!);
      expect((await visit(`/api/public/views/${link.linkId}`)).statusCode, restore!.kind).toBe(200);
    }
  });

  it('refuses downloads unless the link allows copying', async () => {
    const f = await fixture();
    const link = await publish(f.gridId);
    const response = await visit(`/api/public/views/${link.linkId}/download?timeZone=UTC&locale=en-US`);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.messageKey).toBe('shareView.noDownload');
  });

  it('serves password-protected files without cookies on a custom host and revokes them after password changes', async () => {
    const host = 'files.example.test';
    const domainId = randomUUID();
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}".custom_domains
        (id, org_id, host, challenge, kinds, verified_at, first_verified_at, checked_at)
        VALUES ($1, $2, $3, $4, ARRAY['views'], clock_timestamp(), clock_timestamp(), clock_timestamp())`,
      [domainId, server.owner.info.org.id, host, randomBytes(32).toString('hex')],
    );
    try {
      const f = await fixture();
      const gallery = await f.view('gallery', { gallery: { coverFieldId: f.f.photo } });
      const password = randomBytes(24).toString('hex');
      const link = await publish(gallery, { password });
      const base = `/api/public/views/${link.linkId}`;
      const unlock = await server.app.inject({
        method: 'POST',
        url: `${base}/password`,
        headers: { host },
        payload: { password },
      });
      expect(unlock.statusCode, unlock.body).toBe(200);
      expect(unlock.headers['set-cookie']).toBeUndefined();
      const page = await server.app.inject({
        url: `${base}/rows?tz=UTC`,
        headers: { host, 'x-public-view-pass': unlock.json<{ pass: string }>().pass },
      });
      expect(page.statusCode, page.body).toBe(200);
      const photo = page.json<SharedRowsPage>().attachments![f.files.alphaPhoto.id]!;
      for (const url of [photo.url, photo.thumbnails.small!, photo.thumbnails.large!]) {
        const response = await server.app.inject({ url, headers: { host } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
      }
      const mainUnlock = await visit(`${base}/password`, { method: 'POST', payload: { password } });
      const cookie = cookieOf(mainUnlock);
      const mainPhoto = (await rows(link.linkId, { tz: 'UTC' }, cookie)).attachments![photo.id]!;
      expect((await server.app.inject({ url: mainPhoto.url, headers: { host, cookie } })).statusCode).toBe(
        404,
      );
      expect((await visit(photo.url, { cookie })).statusCode).toBe(404);
      expect((await manage('PATCH', gallery, { password: randomBytes(24).toString('hex') })).statusCode).toBe(
        200,
      );
      expect((await server.app.inject({ url: photo.url, headers: { host } })).statusCode).toBe(404);
    } finally {
      await server.pool.query(`DELETE FROM "${server.schemas.app}".custom_domains WHERE id = $1`, [domainId]);
    }
  });
});

async function sharingCommand(action: Record<string, unknown>, who = server.owner) {
  return server.app.inject({
    method: 'POST',
    url: '/api/public-sharing/commands',
    headers: who.headers,
    payload: { id: newId('command'), action },
  });
}

it.each(['timeline', 'gantt', 'chart', 'pivot'] as const)(
  'shares only required and selected fields for %s',
  async (type) => {
    const f = await fixture();
    const start = newId('field');
    await run(f.databaseId, {
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: start, name: 'Start', type: 'date' },
    });
    const settings = {
      timeline: { startFieldId: start, groupFieldId: f.f.status, labelFieldId: f.f.notes },
      gantt: { startFieldId: start, progressFieldId: f.f.score, labelFieldId: f.f.notes },
      chart: { groupBy: { fieldId: f.f.status }, value: { fn: 'sum', fieldId: f.f.score } },
      pivot: { rows: [{ fieldId: f.f.status }], values: [{ fn: 'sum', fieldId: f.f.score }] },
    };
    const viewId = await f.view(type, {
      [type]: settings[type],
      hiddenFieldIds: [f.f.secret, f.f.score, start, f.f.status],
    });
    const link = await publish(viewId, type === 'chart' || type === 'pivot' ? undefined : { fieldIds: [] });
    const required =
      type === 'timeline'
        ? [f.f.name, start, f.f.status, f.f.notes]
        : type === 'gantt'
          ? [f.f.name, start, f.f.score, f.f.notes]
          : [f.f.name, f.f.status, f.f.score];
    const opened = await open(link.linkId);
    expect(new Set(opened.fields.map((field) => field.id))).toEqual(new Set(required));
    const page = await rows(link.linkId);
    for (const row of page.rows) if (row) expect(new Set(Object.keys(row.values))).toEqual(new Set(required));
    expect(JSON.stringify([opened, page])).not.toContain(f.f.secret);
    expect(JSON.stringify([opened, page])).not.toContain(f.f.owner);
    if (type === 'chart' || type === 'pivot') {
      const result = await visit(`/api/public/views/${link.linkId}/aggregate`, {
        method: 'POST',
        payload: { timeZone: 'UTC' },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().kind).toBe(type);
      const records = await visit(`/api/public/views/${link.linkId}/aggregate`, {
        method: 'POST',
        payload: { timeZone: 'UTC', records: {} },
      });
      expect(records.statusCode, records.body).toBe(200);
      for (const row of records.json().rows) {
        expect(Object.keys(row.values).every((id) => required.includes(id))).toBe(true);
        expect(row.createdBy).toBeNull();
      }
      expect(records.body).not.toContain('Bravo yard');
      expect(records.body).not.toContain(f.f.secret);
    }
  },
);

it('keeps files private by default and revokes signed links when the policy is disabled', async () => {
  const f = await fixture();
  const link = await publish(f.gridId);
  const reset = await sharingCommand({ kind: 'policy', policy: {} });
  expect(reset.statusCode, reset.body).toBe(200);
  try {
    const policy = await server.app.inject({
      url: '/api/admin/public-sharing',
      headers: server.owner.headers,
    });
    expect(policy.json()).toEqual({ embeddingEnabled: true, publicFiles: false, fileLifetimeSeconds: 3600 });
    const privateFile = (await rows(link.linkId)).attachments![f.files.alphaPhoto.id]!;
    expect(privateFile.url).toMatch(/^\/api\/files\//);
    expect((await visit(privateFile.url)).statusCode).toBe(401);
    expect(
      (
        await sharingCommand(
          { kind: 'policy', policy: { publicFiles: true, fileLifetimeSeconds: 120 } },
          quinn,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await sharingCommand({ kind: 'policy', policy: { publicFiles: true, fileLifetimeSeconds: 120 } }))
        .statusCode,
    ).toBe(200);
    const signed = (await rows(link.linkId)).attachments![f.files.alphaPhoto.id]!.url;
    const expires = Number(new URL(signed, 'https://example.test').searchParams.get('expires'));
    expect(expires - Math.floor(Date.now() / 1000)).toBeGreaterThan(115);
    expect(expires - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(120);
    expect((await visit(signed)).statusCode).toBe(200);
    await sharingCommand({ kind: 'policy', policy: { publicFiles: false } });
    expect((await visit(signed)).statusCode).toBe(404);
  } finally {
    await sharingCommand({ kind: 'policy', policy: { publicFiles: true } });
  }
});

it('serves HTML and SVG form attachments as sandboxed downloads with detected content types', async () => {
  const f = await fixture();
  const formView = await f.view('form', { form: { questions: [{ fieldId: f.f.name }] } });
  const published = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${formView}/public-form`,
    headers: server.owner.headers,
  });
  expect(published.statusCode, published.body).toBe(200);
  const formId = published.json().formId as string;
  for (const [body, type] of [
    ['<!doctype html><script>alert(1)</script>', 'application/octet-stream'],
    ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml'],
  ] as const) {
    const uploaded = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${f.tableId}/fields/${f.f.photo}/files`,
      headers: { ...server.owner.headers, 'content-type': 'image/png', 'x-file-name': 'picture.png' },
      payload: Buffer.from(body),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const file = AttachmentMeta.parse(uploaded.json());
    await run(f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.records.alpha, values: { [f.f.photo]: [file.id] } }],
    });
    const selected = await sharingCommand({ kind: 'formFiles', linkId: formId, fileIds: [file.id] });
    expect(selected.statusCode, selected.body).toBe(200);
    const definition = await visit(`/api/public/forms/${formId}`);
    const signed = definition.json().files[0] as AttachmentMeta;
    expect(signed.id).toBe(file.id);
    const downloaded = await visit(signed.url);
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.body).toBe(body);
    expect(downloaded.headers['content-type']).toBe(type);
    expect(downloaded.headers['content-disposition']).toMatch(/^attachment;/);
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    expect(downloaded.headers['content-security-policy']).toBe(
      "sandbox; default-src 'none'; frame-ancestors 'self'",
    );
  }
});

it('embeds public pages only on exact listed origins and supports policy undo', async () => {
  const f = await fixture();
  const formView = await f.view('form', { form: { questions: [{ fieldId: f.f.name }] } });
  const published = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${formView}/public-form`,
    headers: server.owner.headers,
  });
  expect(published.statusCode, published.body).toBe(200);
  const formId = published.json().formId as string;
  const start = newId('field');
  const email = newId('field');
  await run(f.databaseId, {
    kind: 'field.create',
    tableId: f.tableId,
    field: { id: start, name: 'Start', type: 'date', options: { includeTime: true } },
  });
  await run(f.databaseId, {
    kind: 'field.create',
    tableId: f.tableId,
    field: { id: email, name: 'Email', type: 'email' },
  });
  const booking = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${f.tableId}/booking-pages`,
    headers: server.owner.headers,
    payload: {
      settings: {
        title: 'Visits',
        lengthMinutes: 30,
        timeFieldId: start,
        nameFieldId: f.f.name,
        emailFieldId: email,
        timeZone: 'UTC',
        hours: Array.from({ length: 7 }, () => [{ start: '09:00', end: '17:00' }]),
      },
    },
  });
  expect(booking.statusCode, booking.body).toBe(200);
  const sharedView = await publish(f.gridId);
  const targets = [
    { kind: 'view', linkId: sharedView.linkId, path: sharedView.path },
    { kind: 'form', linkId: formId, path: `/f/${formId}` },
    { kind: 'booking', linkId: booking.json().pageId, path: booking.json().path },
  ];
  const ancestors = (response: LightMyRequestResponse) =>
    /frame-ancestors ([^;]+)/.exec(String(response.headers['content-security-policy']))?.[1];
  for (const { path, ...target } of targets) {
    expect(ancestors(await visit(path))).toBe("'self'");
    const saved = await sharingCommand({
      kind: 'embed',
      target,
      embed: { enabled: true, sites: ['https://example.test'] },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const page = await visit(path);
    expect(ancestors(page)).toBe('https://example.test');
    expect(page.headers['x-frame-options']).toBeUndefined();
    expect(
      (
        await sharingCommand({
          kind: 'embed',
          target,
          embed: {
            enabled: true,
            sites: Array.from({ length: 21 }, (_, index) => `https://site${index}.test`),
          },
        })
      ).statusCode,
    ).toBe(422);
    // A site that would add a directive of its own to the page's policy is refused here too.
    expect(
      (
        await sharingCommand({
          kind: 'embed',
          target,
          embed: { enabled: true, sites: ['https://a.test;sandbox'] },
        })
      ).statusCode,
    ).toBe(422);
    expect(ancestors(await visit(path))).toBe('https://example.test');
  }
  const disabled = await sharingCommand({
    kind: 'policy',
    policy: { embeddingEnabled: false, publicFiles: true },
  });
  expect(disabled.statusCode, disabled.body).toBe(200);
  for (const target of targets) expect(ancestors(await visit(target.path))).toBe("'self'");
  const undo = await server.app.inject({
    method: 'POST',
    url: '/api/public-sharing/commands',
    headers: server.owner.headers,
    payload: { id: newId('command'), undoOf: disabled.json().id },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  for (const target of targets) expect(ancestors(await visit(target.path))).toBe('https://example.test');
  expect(ancestors(await visit('/settings/public-sharing'))).toBe("'self'");
  const files = await sharingCommand({ kind: 'formFiles', linkId: formId, fileIds: [f.files.alphaPhoto.id] });
  expect(files.statusCode, files.body).toBe(200);
  const definition = await visit(`/api/public/forms/${formId}`);
  const file = definition.json().files[0];
  expect(file.id).toBe(f.files.alphaPhoto.id);
  const signedFile = new URL(file.url, 'https://example.test');
  const expires = Number(signedFile.searchParams.get('expires'));
  const signature = signedFile.searchParams.get('signature')!;
  expect(
    formFileAccepted(
      server.config.secretKey,
      formId,
      file.id,
      expires,
      signature,
      3600,
      (expires - 1) * 1000,
    ),
  ).toBe(true);
  expect(
    formFileAccepted(server.config.secretKey, formId, file.id, expires, signature, 3600, expires * 1000),
  ).toBe(false);
  const downloaded = await visit(file.url);
  expect(downloaded.statusCode).toBe(200);
  expect(downloaded.headers['content-type']).toBe('image/png');
  expect(downloaded.headers['content-disposition']).toMatch(/^inline;/);
  expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
  expect(downloaded.headers['content-security-policy']).toBe(
    "sandbox; default-src 'none'; frame-ancestors 'self'",
  );
  expect((await visit(file.url.replace(file.id, f.files.bravoPhoto.id))).statusCode).toBe(404);
  const altered = new URL(file.url, 'https://example.test');
  altered.searchParams.set('expires', String(Math.floor(Date.now() / 1000) - 1));
  expect((await visit(altered.pathname + altered.search)).statusCode).toBe(404);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'files')} SET scan_state = 'quarantined' WHERE id = ${file.id}`,
  );
  expect((await visit(file.url)).statusCode).toBe(404);
  expect((await visit(`/api/public/forms/${formId}`)).json().files ?? []).toEqual([]);
});

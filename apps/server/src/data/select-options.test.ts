import { loadLiveShare, sharedRead } from './shared-view-reads.js';
import { sourceChoices, sourceOptionsPage } from './select-options.js';
import { AccessScope } from './access.js';
import { loadFields, loadTable } from './metadata.js';
import { insertRecords, updateRecords } from './physical/records.js';
import { recordChange } from './commands/transaction.js';
import { publicTable } from './commands/context.js';
import { setTimeout as delay } from 'node:timers/promises';
import { RealtimeHub, type RealtimeTab } from '../realtime/hub.js';
import type { ServerMessage } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { actorFor } from '../automations/run.js';
import { writeArchive } from './archives/write.js';
import { Restore } from './archives/restore.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId, sourceChoiceId, type FieldMeta } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { applied, command, inject, schemaOf, tokenFor } from './permissions/permissions.test-helpers.js';
import { grant } from '../automations/automations.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let editor: SignedIn;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'selectsources', { automationsPollMs: 0 });
  editor = await server.addMember({ name: 'Editor' });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function fixture(multiple = false) {
  const databaseId = newId('database');
  const tableId = newId('table');
  const name = newId('field');
  const country = newId('field');
  const city = newId('field');
  const us = newId('choice');
  const ca = newId('choice');
  const seattle = newId('choice');
  const toronto = newId('choice');
  const choices = [
    { id: seattle, name: 'Seattle', color: 'blue' },
    { id: toronto, name: 'Toronto', color: 'green' },
  ];
  const response = await inject(server, server.owner, 'POST', '/api/databases', {
    id: databaseId,
    name: 'Select options',
    table: {
      id: tableId,
      name: 'Entries',
      view: { id: newId('view'), name: 'Grid' },
      records: [],
      fields: [
        { id: name, name: 'Name', type: 'text' },
        {
          id: country,
          name: 'Country',
          type: multiple ? 'multipleSelect' : 'singleSelect',
          options: {
            choices: [
              { id: us, name: 'United States', color: 'blue' },
              { id: ca, name: 'Canada', color: 'green' },
            ],
          },
        },
        {
          id: city,
          name: 'City',
          type: multiple ? 'multipleSelect' : 'singleSelect',
          options: { choices, cascade: { fieldId: country, mapping: { [us]: [seattle], [ca]: [toronto] } } },
        },
      ],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  await grant(server, databaseId, editor, 'editor');
  const run = (input: Record<string, unknown>, who = server.owner) => command(server, who, databaseId, input);
  const add = (values: Record<string, unknown>, who = server.owner) =>
    run({ kind: 'record.create', tableId, records: [{ id: newId('record'), values }] }, who);
  return { databaseId, tableId, name, country, city, us, ca, seattle, toronto, choices, run, add };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function source(f: Fixture, multiple = false) {
  const tableId = newId('table');
  const name = newId('field');
  const label = newId('field');
  const enabled = newId('field');
  const select = newId('field');
  const first = newId('record');
  const second = newId('record');
  await applied(server, server.owner, f.databaseId, {
    kind: 'table.create',
    table: {
      id: tableId,
      name: 'Source',
      view: { id: newId('view'), name: 'Grid' },
      fields: [
        { id: name, name: 'Name', type: 'text' },
        { id: label, name: 'Label', type: 'text' },
        { id: enabled, name: 'Enabled', type: 'checkbox' },
      ],
      records: [],
    },
  });
  await applied(server, server.owner, f.databaseId, {
    kind: 'record.create',
    tableId,
    records: [
      { id: first, values: { [name]: 'First', [label]: 'Visible', [enabled]: true } },
      { id: second, values: { [name]: 'Second', [label]: 'Private', [enabled]: false } },
    ],
  });
  const options = {
    choices: [],
    source: {
      tableId,
      fieldId: label,
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'enabled', fieldId: enabled, operator: 'is', value: true }],
      },
    },
  };
  await applied(server, server.owner, f.databaseId, {
    kind: 'field.create',
    tableId: f.tableId,
    field: { id: select, name: 'Source choice', type: multiple ? 'multipleSelect' : 'singleSelect', options },
  });
  const choices = async (who = server.owner) => {
    const field = (await schemaOf(server, who, f.databaseId)).fields.find(
      (field) => field.id === select,
    ) as Extract<FieldMeta, { type: 'singleSelect' | 'multipleSelect' }>;
    return field?.options.choices ?? [];
  };
  return { tableId, name, label, enabled, select, first, second, options, choices };
}

describe('select dependencies', () => {
  it('withholds source labels and source configuration from anonymous share links', async () => {
    const f = await fixture();
    const s = await source(f);
    await f.add({ [s.select]: await sourceChoiceId(s.first) });
    const view = (await schemaOf(server, server.owner, f.databaseId)).views.find(
      (view) => view.tableId === f.tableId,
    )!;
    const published = await inject(server, server.owner, 'PUT', `/api/views/${view.id}/shared-view`);
    expect(published.statusCode, published.body).toBe(200);
    const response = await server.app.inject({ url: `/api/public/views/${published.json().linkId}` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain('Visible');
    expect(response.body).not.toContain(s.label);
    expect(response.body).not.toContain(s.enabled);
    expect(response.body).not.toContain(s.tableId);
    const live = await loadLiveShare(server.pool, server.schemas, published.json().linkId);
    const read = await sharedRead(server.pool, server.schemas, live);
    expect(read.fields.find((field) => field.id === s.select)?.options).not.toHaveProperty('source');
  });

  it('never publishes source labels in site summary tiles', async () => {
    const f = await fixture();
    const s = await source(f);
    await f.add({ [s.select]: await sourceChoiceId(s.first) });
    const interfaceId = newId('interface');
    await applied(server, server.owner, f.databaseId, {
      kind: 'interface.create',
      interface: {
        id: interfaceId,
        name: 'Public choices',
        pages: [
          {
            id: 'page01',
            name: 'Choices',
            blocks: [
              {
                id: 'chart001',
                kind: 'chart',
                place: { x: 0, y: 0, w: 6, h: 4 },
                source: { tableId: f.tableId },
                groupBy: { fieldId: s.select },
                value: { fn: 'count' },
              },
            ],
          },
        ],
      },
    });
    const slug = `choices-${interfaceId.toLowerCase()}`;
    const published = await inject(server, server.owner, 'PUT', `/api/interfaces/${interfaceId}/site`, {
      slug,
      title: 'Choices',
      pages: [{ pageId: 'page01', slug: 'choices', title: 'Choices' }],
      theme: { id: 'palette', scheme: 'house' },
    });
    expect(published.statusCode, published.body).toBe(200);
    await inject(server, server.owner, 'PUT', `/api/fields/${s.label}/permissions`, {
      restricted: { roles: ['owner'], users: [] },
      locked: null,
    });
    const page = await server.app.inject({ url: `/api/public/sites/${slug}/choices` });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.body).not.toContain('Visible');
  });

  it('withholds cascade definitions and error details when the parent is hidden', async () => {
    const f = await fixture();
    await inject(server, server.owner, 'PUT', `/api/fields/${f.country}/permissions`, {
      restricted: { roles: ['owner'], users: [] },
      locked: null,
    });
    const schema = await schemaOf(server, editor, f.databaseId);
    expect(schema.fields.some((field) => field.id === f.city)).toBe(false);
    const result = await f.add({ [f.city]: f.seattle }, editor);
    expect(JSON.stringify(result)).not.toContain('data.select.parentChoice');
  });

  it('refuses public source questions and cascade questions without their parent', async () => {
    const f = await fixture();
    const s = await source(f);
    const viewId = newId('view');
    await applied(server, server.owner, f.databaseId, {
      kind: 'view.create',
      view: {
        id: viewId,
        tableId: f.tableId,
        name: 'Source questions',
        type: 'form',
        config: { form: { questions: [{ fieldId: s.select, required: true }] } },
      },
    });
    const shared = await inject(server, server.owner, 'PUT', `/api/views/${viewId}/public-form`);
    expect(shared.statusCode).toBe(422);
    expect(shared.json().error.messageKey).toBe('data.select.formSource');
    expect(
      await f.run({
        kind: 'view.create',
        view: {
          id: newId('view'),
          tableId: f.tableId,
          name: 'Questions',
          type: 'form',
          config: { form: { questions: [{ fieldId: f.city }] } },
        },
      }),
    ).toMatchObject({ status: 'rejected' });
  });

  it('searches beyond the initial source page and validates a later choice', async () => {
    const f = await fixture();
    const s = await source(f);
    const later = newId('record');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: s.tableId,
      records: Array.from({ length: 1000 }, (_, i) => ({
        id: i === 999 ? later : newId('record'),
        values: { [s.label]: i === 999 ? 'Later choice' : `Option ${i}`, [s.enabled]: true },
      })),
    });
    const field = (await schemaOf(server, server.owner, f.databaseId)).fields.find(
      (field) => field.id === s.select,
    )!;
    expect(field.options).toMatchObject({ sourceTruncated: true });
    const response = await inject(
      server,
      server.owner,
      'GET',
      `/api/fields/${s.select}/select-options?search=Later`,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [{ id: await sourceChoiceId(later), name: 'Later choice' }],
      truncated: false,
    });
    expect(await f.add({ [s.select]: await sourceChoiceId(later) })).toMatchObject({ status: 'applied' });
    const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
    const scope = new AccessScope(server.pool, server.schemas, actor!);
    const stored = (await loadFields(server.pool, server.schemas, [f.tableId])).find(
      (field) => field.id === s.select,
    )!;
    if (stored.type !== 'singleSelect' || field.type !== 'singleSelect') throw new Error();
    const all = await sourceChoices(server.pool, server.schemas, scope, stored, {
      ids: [...field.options.choices.map((choice) => choice.id), await sourceChoiceId(later)],
    });
    expect(all).toHaveLength(1001);
    const messages: ServerMessage[] = [];
    const hub = new RealtimeHub(server.app);
    const tab: RealtimeTab = {
      actor: actor!,
      clientId: newId('client'),
      name: 'Reader',
      open: true,
      send: (message) => {
        messages.push(message);
        return true;
      },
      terminate() {},
    };
    try {
      hub.attach(tab);
      await hub.handle(tab, {
        type: 'subscribe',
        databaseId: f.databaseId,
        sinceSeq: (await schemaOf(server, server.owner, f.databaseId)).seq,
      });
      await hub.handle(tab, {
        type: 'watchSelectOptions',
        databaseId: f.databaseId,
        fieldId: s.select,
        choiceIds: [await sourceChoiceId(later)],
      });
      messages.length = 0;
      await applied(server, server.owner, f.databaseId, {
        kind: 'record.update',
        tableId: s.tableId,
        records: [{ id: later, values: { [s.label]: 'Renamed later' } }],
      });
      await vi.waitFor(
        () =>
          expect(
            messages.some(
              (message) =>
                message.type === 'selectOptions' && JSON.stringify(message).includes('Renamed later'),
            ),
          ).toBe(true),
        { timeout: 5000 },
      );
      messages.length = 0;
      await applied(server, server.owner, f.databaseId, {
        kind: 'record.trash',
        tableId: s.tableId,
        recordIds: [later],
      });
      await vi.waitFor(
        () => expect(messages.some((message) => message.type === 'selectOptions')).toBe(true),
        { timeout: 5000 },
      );
      expect(
        messages
          .filter((message) => message.type === 'selectOptions')
          .map((message) => JSON.stringify(message))
          .join(''),
      ).not.toContain('Renamed later');
      expect(messages.some((message) => message.type === 'reload')).toBe(false);
    } finally {
      await hub.close();
    }
  });

  it('refreshes only changed visible source choices while keeping subscriptions', async () => {
    const f = await fixture();
    const s = await source(f);
    const rules = await inject(server, server.owner, 'PUT', `/api/tables/${s.tableId}/record-rules`, {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'enabled', fieldId: s.enabled, operator: 'is', value: false }],
          },
        },
      ],
    });
    expect(rules.statusCode, rules.body).toBe(200);
    const hub = new RealtimeHub(server.app);
    const messages: ServerMessage[] = [];
    const limitedMessages: ServerMessage[] = [];
    const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
    const tab: RealtimeTab = {
      actor: actor!,
      clientId: newId('client'),
      name: 'Reader',
      open: true,
      send: (message) => {
        messages.push(message);
        return true;
      },
      terminate() {},
    };
    const limited: RealtimeTab = {
      ...tab,
      actor: (await actorFor(server.pool, server.schemas, editor.userId, server.owner.info.org.id))!,
      clientId: newId('client'),
      send: (message) => {
        limitedMessages.push(message);
        return true;
      },
    };
    try {
      hub.attach(tab);
      hub.attach(limited);
      await hub.handle(tab, {
        type: 'subscribe',
        databaseId: f.databaseId,
        sinceSeq: (await schemaOf(server, server.owner, f.databaseId)).seq,
      });
      await hub.handle(limited, {
        type: 'subscribe',
        databaseId: f.databaseId,
        sinceSeq: (await schemaOf(server, editor, f.databaseId)).seq,
      });
      await hub.handle(limited, {
        type: 'watchSelectOptions',
        databaseId: f.databaseId,
        fieldId: s.select,
        choiceIds: [await sourceChoiceId(s.first)],
      });
      messages.length = 0;
      limitedMessages.length = 0;
      await applied(server, server.owner, f.databaseId, {
        kind: 'record.update',
        tableId: s.tableId,
        records: [{ id: s.first, values: { [s.name]: 'Unrelated' } }],
      });
      await delay(350);
      expect(messages.some((message) => message.type === 'reload')).toBe(false);
      expect(
        limitedMessages.some((message) => message.type === 'selectOptions' || message.type === 'reload'),
      ).toBe(false);
      expect(JSON.stringify(limitedMessages)).not.toContain('Updated option');
      expect(messages.some((message) => (message.type as string) === 'selectOptions')).toBe(false);
      await applied(server, server.owner, f.databaseId, {
        kind: 'record.update',
        tableId: s.tableId,
        records: [{ id: s.second, values: { [s.label]: 'Filtered record' } }],
      });
      await delay(350);
      expect(messages.some((message) => (message.type as string) === 'selectOptions')).toBe(false);
      await applied(server, server.owner, f.databaseId, {
        kind: 'record.update',
        tableId: s.tableId,
        records: [{ id: s.first, values: { [s.label]: 'Updated option' } }],
      });
      await delay(350);
      expect(
        messages.some(
          (message) =>
            (message.type as string) === 'selectOptions' &&
            JSON.stringify(message).includes('Updated option'),
        ),
      ).toBe(true);
      expect(messages.some((message) => message.type === 'reload')).toBe(false);
      expect(
        limitedMessages.some((message) => message.type === 'selectOptions' || message.type === 'reload'),
      ).toBe(false);
      expect(JSON.stringify(limitedMessages)).not.toContain('Updated option');
    } finally {
      await hub.close();
    }
  });

  it('skips a conflicting cascade cell during undo and restores independent cells', async () => {
    const f = await fixture();
    const id = newId('record');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [f.country]: f.us, [f.city]: f.seattle, [f.name]: 'Before' } }],
    });
    const groupId = newId('action');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      groupId,
      records: [{ id, values: { [f.city]: null, [f.name]: 'After' } }],
    });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id, values: { [f.country]: f.ca } }],
    });
    const response = await inject(server, server.owner, 'POST', `/api/databases/${f.databaseId}/undo`, {
      groupId,
      clientId: newId('client'),
      commandId: newId('command'),
    });
    expect(response.json()).toMatchObject({ status: 'applied', skipped: 1 });
    const read = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${id}`);
    expect(read.json().values).toMatchObject({ [f.name]: 'Before', [f.country]: f.ca, [f.city]: null });
  });

  it('builds fixed options on the server instead of trusting a partial reader list', async () => {
    const f = await fixture();
    const s = await source(f);
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.update',
      fieldId: s.select,
      options: { source: { tableId: s.tableId, fieldId: s.label } },
    });
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.update',
      fieldId: s.select,
      options: { choices: [] },
    });
    expect((await s.choices()).map((choice) => choice.name)).toEqual(['Visible', 'Private']);
  });

  it('reports orphaned selections in the conversion preview without discarding their IDs', async () => {
    const f = await fixture();
    const s = await source(f);
    await f.add({ [s.select]: await sourceChoiceId(s.first) });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.trash',
      tableId: s.tableId,
      recordIds: [s.first],
    });
    const response = await inject(
      server,
      server.owner,
      'POST',
      `/api/fields/${s.select}/conversion-preview`,
      {
        to: { type: 'multipleSelect', options: s.options },
        dateOrder: 'mdy',
        timeZone: 'UTC',
      },
    );
    expect(response.json()).toMatchObject({ emptied: 0, dropped: 0, orphaned: 1 });
  });

  it('flags cascade values changed by sync without blocking later system writes', async () => {
    const f = await fixture();
    const id = newId('record');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [f.country]: f.us, [f.city]: f.seattle } }],
    });
    const actor = (await actorFor(
      server.pool,
      server.schemas,
      server.owner.userId,
      server.owner.info.org.id,
    ))!;
    await withTransaction(server.pool, async (db) => {
      const fields = await loadFields(db, server.schemas, [f.tableId]);
      const c = {
        db,
        schemas: server.schemas,
        actor,
        databaseId: f.databaseId,
        scope: new AccessScope(db, server.schemas, actor),
      };
      await updateRecords(
        db,
        server.schemas.data,
        f.tableId,
        fields,
        [{ id, values: { [f.country]: f.ca } }],
        actor.userId,
      );
      const table = (await loadTable(db, server.schemas, f.tableId))!;
      await recordChange(
        c,
        {
          body: {
            kind: 'table.synced',
            table: publicTable(table),
            stats: { added: 0, changed: 1, removed: 0, unchanged: 0, overridesCleared: 0, ms: 1 },
          },
          prev: {},
        },
        { commandId: newId('command'), groupId: newId('action'), clientId: null, system: true },
      );
      const records = await insertRecords(
        db,
        server.schemas.data,
        f.tableId,
        fields,
        [{ id: newId('record'), values: { [f.country]: f.us } }],
        actor.userId,
      );
      await recordChange(
        c,
        { body: { kind: 'record.created', tableId: f.tableId, records }, prev: {} },
        { commandId: newId('command'), groupId: newId('action'), clientId: null, system: true },
      );
    });
    const response = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${id}`);
    expect(response.json()).toMatchObject({
      values: { [f.city]: f.seattle },
      errors: { [f.city]: 'data.select.parentChoice' },
    });
  });

  it('resolves source choices in the compatible schema API', async () => {
    const f = await fixture();
    const s = await source(f);
    const token = await tokenFor(server, server.owner);
    const response = await server.app.inject({
      url: `/v0/meta/bases/${f.databaseId}/tables`,
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    const field = response
      .json()
      .tables.find((table: { id: string }) => table.id === f.tableId)
      .fields.find((field: { id: string }) => field.id === s.select);
    expect(field.options.choices).toMatchObject([{ name: 'Visible' }]);
  });

  it('shares source reads across matching fields within one access scope', async () => {
    const f = await fixture();
    const s = await source(f);
    const actor = (await actorFor(
      server.pool,
      server.schemas,
      server.owner.userId,
      server.owner.info.org.id,
    ))!;
    const scope = new AccessScope(server.pool, server.schemas, actor);
    await scope.prepare(f.databaseId);
    const field = (await loadFields(server.pool, server.schemas, [f.tableId])).find(
      (field) => field.id === s.select,
    )!;
    if (field.type !== 'singleSelect') throw new Error();
    const calls = vi.spyOn(server.pool, 'query');
    try {
      const pages = await Promise.all([
        sourceOptionsPage(server.pool, server.schemas, scope, field),
        sourceOptionsPage(server.pool, server.schemas, scope, { ...field, id: newId('field') }),
      ]);
      expect(pages[0]).toEqual(pages[1]);
      expect(calls.mock.calls.filter(([statement]) => String(statement).includes('btrim('))).toHaveLength(1);
    } finally {
      calls.mockRestore();
    }
  });

  it('preserves hidden source selections while accepting visible additions', async () => {
    const f = await fixture();
    const s = await source(f, true);
    const id = newId('record');
    const first = await sourceChoiceId(s.first);
    const second = await sourceChoiceId(s.second);
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.update',
      fieldId: s.select,
      options: { source: { tableId: s.tableId, fieldId: s.label } },
    });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [s.select]: [second] } }],
    });
    await inject(server, server.owner, 'PUT', `/api/tables/${s.tableId}/record-rules`, {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'enabled', fieldId: s.enabled, operator: 'is', value: true }],
          },
        },
      ],
    });
    expect(
      await f.run(
        { kind: 'record.update', tableId: f.tableId, records: [{ id, values: { [s.select]: [first] } }] },
        editor,
      ),
    ).toMatchObject({ status: 'applied' });
    const read = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${id}`);
    expect(read.json().values[s.select]).toEqual([first, second]);
  });

  it('allows inverse link edits, merges, and unrelated conversions with stale source IDs', async () => {
    const f = await fixture();
    const s = await source(f);
    const id = newId('record');
    const merged = newId('record');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [
        { id, values: { [f.name]: '1', [s.select]: await sourceChoiceId(s.first) } },
        { id: merged, values: { [f.name]: '2' } },
      ],
    });
    const link = newId('field');
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: link, name: 'Related', type: 'link', options: { linkedTableId: s.tableId } },
    });
    const field = (await schemaOf(server, server.owner, f.databaseId)).fields.find(
      (field) => field.id === link,
    )!;
    if (field.type !== 'link') throw new Error();
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.trash',
      tableId: s.tableId,
      recordIds: [s.first],
    });
    expect(
      await f.run({
        kind: 'record.update',
        tableId: s.tableId,
        records: [{ id: s.second, values: { [field.options.inverseFieldId!]: [id] } }],
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await f.run({ kind: 'record.merge', tableId: f.tableId, recordId: id, mergeIds: [merged] }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await f.run({
        kind: 'field.convert',
        fieldId: f.name,
        to: { type: 'number', options: { validation: { required: {} } } },
      }),
    ).toMatchObject({ status: 'applied' });
  });

  it('keeps stale source selections on restore and unchanged writes', async () => {
    const f = await fixture();
    const s = await source(f);
    const id = newId('record');
    const choice = await sourceChoiceId(s.first);
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [s.select]: choice } }],
    });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.trash',
      tableId: s.tableId,
      recordIds: [s.first],
    });
    expect(
      await f.run({
        kind: 'record.update',
        tableId: f.tableId,
        records: [{ id, values: { [s.select]: choice, [f.name]: 'Changed' } }],
      }),
    ).toMatchObject({ status: 'applied' });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.trash',
      tableId: f.tableId,
      recordIds: [id],
    });
    expect(await f.run({ kind: 'record.restore', tableId: f.tableId, recordIds: [id] })).toMatchObject({
      status: 'applied',
    });
    const read = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${id}`);
    expect(read.json().values[s.select]).toBe(choice);
  });

  it('converts only the changed field despite unrelated legacy validation', async () => {
    const f = await fixture();
    await f.add({ [f.country]: f.us });
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.update',
      fieldId: f.name,
      options: { validation: { required: {} } },
    });
    expect(
      await f.run({
        kind: 'field.convert',
        fieldId: f.country,
        to: {
          type: 'multipleSelect',
          options: {
            choices: [
              { id: f.us, name: 'United States', color: 'blue' },
              { id: f.ca, name: 'Canada', color: 'green' },
            ],
            validation: { required: {} },
          },
        },
      }),
    ).toMatchObject({ status: 'applied' });
  });

  it('prunes removed parent options from child mappings', async () => {
    const f = await fixture();
    expect(
      await f.run({
        kind: 'field.update',
        fieldId: f.country,
        options: { choices: [{ id: f.us, name: 'United States', color: 'blue' }] },
      }),
    ).toMatchObject({ status: 'applied' });
    const child = (await schemaOf(server, server.owner, f.databaseId)).fields.find(
      (field) => field.id === f.city,
    )!;
    expect(child.options).toMatchObject({ cascade: { mapping: { [f.us]: [f.seattle] } } });
    expect((child.options as { cascade: { mapping: object } }).cascade.mapping).not.toHaveProperty(f.ca);
  });

  it('uses an intermediate cascade parent as context during a child conversion', async () => {
    const f = await fixture();
    const neighborhood = newId('field');
    const downtown = newId('choice');
    const options = {
      choices: [{ id: downtown, name: 'Downtown', color: 'blue' }],
      cascade: { fieldId: f.city, mapping: { [f.seattle]: [downtown] } },
    };
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: neighborhood, name: 'Neighborhood', type: 'singleSelect', options },
    });
    await f.add({ [f.country]: f.us, [f.city]: f.seattle, [neighborhood]: downtown });
    const converted = await f.run({
      kind: 'field.convert',
      fieldId: neighborhood,
      to: { type: 'multipleSelect', options },
    });
    expect(converted, JSON.stringify(converted)).toMatchObject({ status: 'applied' });
  });

  it('keeps the remaining multiple child option when removing another', async () => {
    const f = await fixture(true);
    await f.add({ [f.country]: [f.us, f.ca], [f.city]: [f.seattle, f.toronto] });
    expect(
      await f.run({
        kind: 'field.update',
        fieldId: f.city,
        options: {
          choices: [f.choices[0]],
          cascade: { fieldId: f.country, mapping: { [f.us]: [f.seattle] } },
        },
      }),
    ).toMatchObject({ status: 'applied' });
  });

  it('explains when a trashed parent is still in use', async () => {
    const f = await fixture();
    expect(await f.run({ kind: 'field.trash', fieldId: f.country })).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.select.parentInUse' },
    });
  });

  it.each([false, true])(
    'preserves unavailable source identities when changing select cardinality with new labels: %s',
    async (changeLabel) => {
      const f = await fixture();
      const s = await source(f);
      const id = newId('record');
      const choice = await sourceChoiceId(s.first);
      await applied(server, server.owner, f.databaseId, {
        kind: 'record.create',
        tableId: f.tableId,
        records: [{ id, values: { [s.select]: choice } }],
      });
      await applied(server, server.owner, f.databaseId, {
        kind: 'record.trash',
        tableId: s.tableId,
        recordIds: [s.first],
      });
      expect(
        await f.run({
          kind: 'field.convert',
          fieldId: s.select,
          to: {
            type: 'multipleSelect',
            options: changeLabel
              ? { ...s.options, source: { ...s.options.source, fieldId: s.name } }
              : s.options,
          },
        }),
      ).toMatchObject({ status: 'applied' });
      const read = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${id}`);
      expect(read.json().values[s.select]).toEqual([choice]);
    },
  );

  it('refuses invalid creates, parent-only edits, and invalid multiple choices atomically', async () => {
    const f = await fixture();
    expect(await f.add({ [f.city]: f.seattle })).toMatchObject({
      status: 'rejected',
      error: { fields: { [f.city]: 'data.select.parentChoice' } },
    });
    const id = newId('record');
    expect(
      await f.run({
        kind: 'record.create',
        tableId: f.tableId,
        records: [{ id, values: { [f.country]: f.us, [f.city]: f.seattle } }],
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await f.run({
        kind: 'record.update',
        tableId: f.tableId,
        records: [{ id, values: { [f.country]: f.ca } }],
      }),
    ).toMatchObject({ status: 'rejected', error: { fields: { [f.city]: 'data.select.parentChoice' } } });
    expect(
      await f.run({
        kind: 'record.update',
        tableId: f.tableId,
        records: [{ id, values: { [f.country]: f.ca, [f.city]: f.toronto } }],
      }),
    ).toMatchObject({ status: 'applied' });
    const multi = await fixture(true);
    expect(
      await multi.add({
        [multi.country]: [multi.us, multi.ca],
        [multi.city]: [multi.seattle, multi.toronto],
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await multi.add({ [multi.country]: [multi.us], [multi.city]: [multi.seattle, multi.toronto] }),
    ).toMatchObject({ status: 'rejected' });
  });

  it('undoes and redoes a parent and child update together', async () => {
    const f = await fixture();
    const recordId = newId('record');
    const groupId = newId('action');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id: recordId, values: { [f.country]: f.us, [f.city]: f.seattle } }],
    });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.update',
      groupId,
      tableId: f.tableId,
      records: [{ id: recordId, values: { [f.country]: f.ca, [f.city]: f.toronto } }],
    });
    for (const [direction, country, city] of [
      ['undo', f.us, f.seattle],
      ['redo', f.ca, f.toronto],
    ]) {
      const response = await inject(
        server,
        server.owner,
        'POST',
        `/api/databases/${f.databaseId}/${direction}`,
        {
          groupId,
          clientId: newId('client'),
          commandId: newId('command'),
        },
      );
      expect(response.json()).toMatchObject({ status: 'applied', skipped: 0 });
      const read = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${recordId}`);
      expect(read.json().values).toMatchObject({ [f.country]: country, [f.city]: city });
    }
  });

  it('refuses cycles, stale mappings, and schema changes that invalidate records', async () => {
    const f = await fixture();
    expect(await f.add({ [f.country]: f.us, [f.city]: f.seattle })).toMatchObject({ status: 'applied' });
    expect(
      await f.run({
        kind: 'field.update',
        fieldId: f.city,
        options: { choices: f.choices, cascade: { fieldId: f.country, mapping: {} } },
      }),
    ).toMatchObject({ status: 'rejected', error: { fields: { [f.city]: 'data.select.parentChoice' } } });
    expect(
      await f.run({
        kind: 'field.update',
        fieldId: f.city,
        options: { choices: f.choices, cascade: { fieldId: f.city, mapping: {} } },
      }),
    ).toMatchObject({ status: 'rejected', error: { messageKey: 'data.select.cycle' } });
    expect(await f.run({ kind: 'field.trash', fieldId: f.country })).toMatchObject({ status: 'rejected' });
  });

  it('enforces cascades through the record API', async () => {
    const f = await fixture();
    const token = await tokenFor(server, server.owner);
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${f.tableId}/records`,
      headers: { authorization: `Bearer ${token.token}` },
      payload: { records: [{ fields: { Country: 'Canada', City: 'Seattle' } }] },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().error.fields).toEqual({ [f.city]: 'data.select.parentChoice' });
  });

  it('keeps record identity through source renames, filters, trash, and restore', async () => {
    const f = await fixture();
    const s = await source(f);
    expect(await s.choices()).toEqual([
      { id: await sourceChoiceId(s.first), name: 'Visible', color: 'gray' },
    ]);
    expect(await f.add({ [s.select]: await sourceChoiceId(s.second) })).toMatchObject({
      status: 'rejected',
      error: { fields: { [s.select]: 'data.select.sourceChoice' } },
    });
    expect(await f.add({ [s.select]: await sourceChoiceId(s.first) })).toMatchObject({ status: 'applied' });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.update',
      tableId: s.tableId,
      records: [{ id: s.first, values: { [s.label]: 'Renamed' } }],
    });
    expect(await s.choices()).toEqual([
      { id: await sourceChoiceId(s.first), name: 'Renamed', color: 'gray' },
    ]);
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.trash',
      tableId: s.tableId,
      recordIds: [s.first],
    });
    expect(await s.choices()).toEqual([]);
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.restore',
      tableId: s.tableId,
      recordIds: [s.first],
    });
    expect((await s.choices())[0]?.id).toBe(await sourceChoiceId(s.first));
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.update',
      tableId: s.tableId,
      records: [{ id: s.first, values: { [s.enabled]: false } }],
    });
    expect(await s.choices()).toEqual([]);
  });

  it('respects source record rules and field permissions on reads and writes', async () => {
    const f = await fixture();
    const s = await source(f, true);
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.update',
      fieldId: s.select,
      options: { source: { tableId: s.tableId, fieldId: s.label } },
    });
    const rules = await inject(server, server.owner, 'PUT', `/api/tables/${s.tableId}/record-rules`, {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'enabled', fieldId: s.enabled, operator: 'is', value: true }],
          },
        },
      ],
    });
    expect(rules.statusCode, rules.body).toBe(200);
    expect((await s.choices(editor)).map((choice) => choice.name)).toEqual(['Visible']);
    expect(
      await f.add({ [s.select]: [await sourceChoiceId(s.first), await sourceChoiceId(s.second)] }, editor),
    ).toMatchObject({ status: 'rejected' });
    const hidden = await inject(server, server.owner, 'PUT', `/api/fields/${s.label}/permissions`, {
      restricted: { roles: [], users: [] },
      locked: null,
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(await s.choices(editor)).toEqual([]);
    expect((await schemaOf(server, editor, f.databaseId)).fields.some((field) => field.id === s.select)).toBe(
      false,
    );
    expect(await f.add({ [s.select]: [await sourceChoiceId(s.first)] }, editor)).toMatchObject({
      status: 'rejected',
    });
  });

  it('preserves source options and stored selections when changing select types', async () => {
    const f = await fixture();
    const s = await source(f);
    const recordId = newId('record');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id: recordId, values: { [s.select]: await sourceChoiceId(s.first) } }],
    });
    expect(
      await f.run({
        kind: 'field.convert',
        fieldId: s.select,
        to: { type: 'multipleSelect', options: s.options },
        dateOrder: 'mdy',
        timeZone: 'UTC',
      }),
    ).toMatchObject({ status: 'applied' });
    const schema = await schemaOf(server, server.owner, f.databaseId);
    expect(schema.fields.find((field) => field.id === s.select)).toMatchObject({
      type: 'multipleSelect',
      options: { source: s.options.source },
    });
    const read = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${recordId}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().values[s.select]).toEqual([await sourceChoiceId(s.first)]);
  });

  it('remaps cascading choices and source record identities when copying a database', async () => {
    const f = await fixture();
    const s = await source(f);
    expect(
      await f.add({
        [f.name]: 'Copied entry',
        [f.country]: f.us,
        [f.city]: f.seattle,
        [s.select]: await sourceChoiceId(s.first),
      }),
    ).toMatchObject({ status: 'applied' });
    const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
    const archive = await withTransaction(server.pool, (db) =>
      writeArchive(
        db,
        server.schemas,
        f.databaseId,
        { records: 'all', comments: false },
        new AccessScope(db, server.schemas, actor!),
      ),
    );
    const databaseId = newId('database');
    await new Restore(server.app.ctx, actor!, { archive, databaseId, name: 'Copied selects' }).run();
    const schema = await schemaOf(server, server.owner, databaseId);
    const table = schema.tables.find((table) => table.name === 'Entries')!;
    const view = schema.views.find((view) => view.tableId === table.id)!;
    const choice = schema.fields.find((field) => field.name === 'Source choice') as Extract<
      FieldMeta,
      { type: 'singleSelect' }
    >;
    expect(choice.options.source?.tableId).not.toBe(s.tableId);
    expect(choice.options.choices[0]?.name).toBe('Visible');
    expect(choice.options.choices[0]?.id).not.toBe(await sourceChoiceId(s.first));
    const response = await inject(server, server.owner, 'GET', `/api/views/${view.id}/rows?limit=500`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().rows[0].values[choice.id]).toBe(choice.options.choices[0]?.id);
  });

  it('uses primary values by default and refuses a source from another database', async () => {
    const f = await fixture();
    const s = await source(f);
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.update',
      fieldId: s.select,
      options: { source: { tableId: s.tableId } },
    });
    expect((await s.choices()).map((choice) => choice.name)).toEqual(['First', 'Second']);
    const other = await fixture();
    expect(
      await f.run({
        kind: 'field.update',
        fieldId: s.select,
        options: { source: { tableId: other.tableId } },
      }),
    ).toMatchObject({ status: 'rejected' });
  });
});

describe('source selection regressions', () => {
  it.each(['trash', 'filter', 'blank'])('allows explicit removal after source %s', async (reason) => {
    const f = await fixture();
    const s = await source(f);
    const id = newId('record');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [s.select]: await sourceChoiceId(s.first) } }],
    });
    await applied(
      server,
      server.owner,
      f.databaseId,
      reason === 'trash'
        ? {
            kind: 'record.trash',
            tableId: s.tableId,
            recordIds: [s.first],
          }
        : {
            kind: 'record.update',
            tableId: s.tableId,
            records: [
              { id: s.first, values: reason === 'filter' ? { [s.enabled]: false } : { [s.label]: '' } },
            ],
          },
    );
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id, values: { [s.select]: null } }],
    });
    const read = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${id}`);
    expect(read.json().values[s.select]).toBeNull();
  });

  it('requires conversion before changing a populated option source', async () => {
    const f = await fixture();
    const s = await source(f);
    const id = newId('record');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [f.city]: f.seattle, [f.country]: f.us } }],
    });
    expect(
      await f.run({ kind: 'field.update', fieldId: f.city, options: { source: s.options.source } }),
    ).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.select.conversionRequired' },
    });
    const read = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${id}`);
    expect(read.json().values[f.city]).toBe(f.seattle);
  });

  it('refuses conversion when a stored source value has no label', async () => {
    const f = await fixture();
    const s = await source(f);
    await f.add({ [s.select]: await sourceChoiceId(s.first) });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.trash',
      tableId: s.tableId,
      recordIds: [s.first],
    });
    expect(await f.run({ kind: 'field.convert', fieldId: s.select, to: { type: 'text' } })).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.select.conversionUnavailable' },
    });
    const preview = await inject(server, server.owner, 'POST', `/api/fields/${s.select}/conversion-preview`, {
      to: { type: 'text' },
      dateOrder: 'mdy',
      timeZone: 'UTC',
    });
    expect(preview.statusCode).toBe(422);
    expect(preview.json().error.messageKey).toBe('data.select.conversionUnavailable');
    expect(await f.run({ kind: 'field.update', fieldId: s.select, options: { choices: [] } })).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.select.conversionUnavailable' },
    });
  });

  it('explains parent option removal with the dependent field and record count', async () => {
    const f = await fixture();
    await f.add({ [f.country]: f.ca, [f.city]: f.toronto });
    expect(
      await f.run({
        kind: 'field.update',
        fieldId: f.country,
        options: {
          choices: [{ id: f.us, name: 'United States', color: 'blue' }],
        },
      }),
    ).toMatchObject({
      status: 'rejected',
      error: {
        messageKey: 'data.select.dependentValues',
        params: { field: 'City', count: 1 },
      },
    });
  });

  it('explains a hidden dependency without identifying its field', async () => {
    const f = await fixture();
    const id = newId('record');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [f.country]: f.us, [f.city]: f.seattle } }],
    });
    await inject(server, server.owner, 'PUT', `/api/fields/${f.city}/permissions`, {
      restricted: { roles: ['owner'], users: [] },
      locked: null,
    });
    const result = await f.run(
      { kind: 'record.update', tableId: f.tableId, records: [{ id, values: { [f.country]: f.ca } }] },
      editor,
    );
    expect(result).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.select.hiddenDependency' },
    });
    expect(JSON.stringify(result)).not.toContain(f.city);
  });
});

describe('source label coverage', () => {
  it('reads and writes a choice beyond the first page through both record APIs', async () => {
    const f = await fixture();
    const s = await source(f);
    const later = newId('record');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: s.tableId,
      records: Array.from({ length: 1000 }, (_, i) => ({
        id: i === 999 ? later : newId('record'),
        values: { [s.label]: i === 999 ? 'Later label' : `Label ${i}`, [s.enabled]: true },
      })),
    });
    const id = newId('record');
    const choice = await sourceChoiceId(later);
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [s.select]: choice } }],
    });
    const token = await tokenFor(server, server.owner);
    const headers = { authorization: `Bearer ${token.token}` };
    for (const url of [
      `/api/v1/tables/${f.tableId}/records/${id}?shape=airtable`,
      `/v0/${f.databaseId}/${f.tableId}/${id}`,
    ]) {
      const read = await server.app.inject({ url, headers });
      expect(read.statusCode, read.body).toBe(200);
      expect((read.json().records?.[0] ?? read.json()).fields['Source choice']).toBe('Later label');
    }
    for (const value of ['Later label', choice]) {
      const write = await server.app.inject({
        method: 'PATCH',
        url: `/api/v1/tables/${f.tableId}/records`,
        headers,
        payload: { records: [{ id, fields: { 'Source choice': value } }] },
      });
      expect(write.statusCode, write.body).toBe(200);
    }
    const formula = newId('field');
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.create',
      tableId: f.tableId,
      field: {
        id: formula,
        name: 'Selected label',
        type: 'formula',
        options: { expression: `{${s.select}} & "!"` },
      },
    });
    const record = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${id}`);
    expect(record.json().values[formula]).toBe('Later label!');
    expect(record.json().selectChoices[s.select]).toMatchObject([{ id: choice, name: 'Later label' }]);
    const linked = newId('field');
    const lookup = newId('field');
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.create',
      tableId: s.tableId,
      field: { id: linked, name: 'Entries', type: 'link', options: { linkedTableId: f.tableId } },
    });
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.create',
      tableId: s.tableId,
      field: {
        id: lookup,
        name: 'Selected entries',
        type: 'lookup',
        options: { linkFieldId: linked, targetFieldId: s.select },
      },
    });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.update',
      tableId: s.tableId,
      records: [{ id: s.first, values: { [linked]: [id] } }],
    });
    const lookedUp = await inject(server, server.owner, 'GET', `/api/tables/${s.tableId}/records/${s.first}`);
    expect(lookedUp.json().values[lookup]).toEqual([choice]);
    expect(lookedUp.json().selectChoices?.[s.select]).toMatchObject([{ id: choice, name: 'Later label' }]);
    const view = (await schemaOf(server, server.owner, f.databaseId)).views.find(
      (view) => view.tableId === f.tableId,
    )!;
    const exported = await inject(
      server,
      server.owner,
      'GET',
      `/api/views/${view.id}/export?format=csv&timeZone=UTC&locale=en-US`,
    );
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain('Later label');
    const chart = newId('view');
    await applied(server, server.owner, f.databaseId, {
      kind: 'view.create',
      view: {
        id: chart,
        tableId: f.tableId,
        name: 'Choice totals',
        type: 'chart',
        config: { chart: { groupBy: { fieldId: s.select } } },
      },
    });
    const grouped = await inject(
      server,
      server.owner,
      'POST',
      `/api/databases/${f.databaseId}/views/${chart}/aggregate`,
      { timeZone: 'UTC' },
    );
    expect(grouped.statusCode, grouped.body).toBe(200);
    expect(grouped.body).toContain('Later label');
    await f.add({ [s.select]: await sourceChoiceId(s.first) });
    await applied(server, server.owner, f.databaseId, {
      kind: 'view.update',
      viewId: view.id,
      config: { groups: [{ fieldId: s.select, direction: 'asc' }] },
    });
    const page = await inject(server, server.owner, 'GET', `/api/views/${view.id}/rows?limit=1`);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().rows[0].values[s.select]).toBe(await sourceChoiceId(s.first));
    expect(page.json().selectChoices?.[s.select]).toContainEqual({
      id: choice,
      name: 'Later label',
      color: 'gray',
    });

    await applied(server, server.owner, f.databaseId, {
      kind: 'record.trash',
      tableId: s.tableId,
      recordIds: [later],
    });
    const read = await server.app.inject({ url: `/v0/${f.databaseId}/${f.tableId}/${id}`, headers });
    expect(read.json().fields['Source choice']).toBe(choice);
    const replaced = await server.app.inject({
      method: 'PUT',
      url: `/v0/${f.databaseId}/${f.tableId}/${id}`,
      headers,
      payload: { fields: { 'Source choice': read.json().fields['Source choice'] } },
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
  });

  it('uses an indexed identity lookup with the same IDs as the contract', async () => {
    const f = await fixture();
    const s = await source(f);
    const result = await query<{ id: string }>(
      server.pool,
      sql`SELECT ${ident(server.schemas.data, 'source_choice_id')}(__id) AS id FROM ${ident(server.schemas.data, s.tableId)} WHERE __id = ${s.first}`,
    );
    expect(result.rows[0]!.id).toBe(await sourceChoiceId(s.first));
    await vi.waitFor(async () => {
      const indexes = await query<{ definition: string }>(
        server.pool,
        sql`SELECT indexdef AS definition FROM pg_indexes WHERE schemaname = ${server.schemas.data} AND tablename = ${s.tableId}`,
      );
      expect(indexes.rows.some((row) => row.definition.includes('source_choice_id'))).toBe(true);
    });
    const unrelated = await query<{ definition: string }>(
      server.pool,
      sql`SELECT indexdef AS definition FROM pg_indexes WHERE schemaname = ${server.schemas.data} AND tablename = ${f.tableId}`,
    );
    expect(unrelated.rows.some((row) => row.definition.includes('source_choice_id'))).toBe(false);
  });
});

it('asks to restore the parent before restoring a dependent field', async () => {
  const f = await fixture();
  await applied(server, server.owner, f.databaseId, { kind: 'field.trash', fieldId: f.city });
  await applied(server, server.owner, f.databaseId, { kind: 'field.trash', fieldId: f.country });
  expect(await f.run({ kind: 'field.restore', fieldId: f.city })).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'data.select.restoreParent' },
  });
});

it('refuses label conversions through a partial source view', async () => {
  const f = await fixture();
  const s = await source(f);
  await grant(server, f.databaseId, editor, 'creator');
  await f.add({ [s.select]: await sourceChoiceId(s.first) });
  await inject(server, server.owner, 'PUT', `/api/tables/${s.tableId}/record-rules`, {
    rules: [
      {
        id: newId('recordRule'),
        roles: ['creator'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'enabled', fieldId: s.enabled, operator: 'is', value: true }],
        },
      },
    ],
  });
  expect(
    await f.run({ kind: 'field.convert', fieldId: s.select, to: { type: 'text' } }, editor),
  ).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'data.select.fixedAccess' },
  });
});

it.each([false, true])(
  'keeps source identities through field update undo and redo with multiple %s',
  async (multiple) => {
    const f = await fixture();
    const s = await source(f, multiple);
    const id = newId('record');
    const choice = await sourceChoiceId(s.first);
    const value = multiple ? [choice] : choice;
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [s.select]: value } }],
    });
    const groupId = newId('action');
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.update',
      fieldId: s.select,
      groupId,
      options: { choices: [] },
    });
    for (const direction of ['undo', 'redo', 'undo']) {
      const response = await inject(
        server,
        server.owner,
        'POST',
        `/api/databases/${f.databaseId}/${direction}`,
        {
          groupId,
          clientId: newId('client'),
          commandId: newId('command'),
        },
      );
      expect(response.json()).toMatchObject({ status: 'applied', skipped: 0 });
      const read = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${id}`);
      expect(read.json().values[s.select]).toEqual(value);
    }
  },
);

it.each([false, true])(
  'preserves duplicate source labels through both record APIs with multiple %s',
  async (multiple) => {
    const f = await fixture();
    const s = await source(f, multiple);
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.update',
      tableId: s.tableId,
      records: [{ id: s.second, values: { [s.label]: 'Visible', [s.enabled]: true } }],
    });
    const id = newId('record');
    const later = newId('record');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: s.tableId,
      records: Array.from({ length: 1000 }, (_, i) => ({
        id: i === 999 ? later : newId('record'),
        values: { [s.label]: i === 999 ? 'Visible' : `Label ${i}`, [s.enabled]: true },
      })),
    });
    const choice = await sourceChoiceId(later);
    const value = multiple ? [choice] : choice;
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [s.select]: value } }],
    });
    const token = await tokenFor(server, server.owner);
    const headers = { authorization: `Bearer ${token.token}` };
    for (const url of [
      `/api/v1/tables/${f.tableId}/records/${id}?shape=airtable`,
      `/v0/${f.databaseId}/${f.tableId}/${id}`,
    ]) {
      const read = await server.app.inject({ url, headers });
      expect(read.statusCode, read.body).toBe(200);
      const fields = (read.json().records?.[0] ?? read.json()).fields;
      const saved = await server.app.inject({
        method: 'PUT',
        url: url.startsWith('/api/v1') ? `/api/v1/tables/${f.tableId}/records` : url,
        headers,
        payload: url.startsWith('/api/v1') ? { records: [{ id, fields }] } : { fields },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const stored = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${id}`);
      expect(stored.json().values[s.select]).toEqual(value);
    }
    const ambiguous = await server.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${f.tableId}/records`,
      headers,
      payload: { records: [{ fields: { 'Source choice': multiple ? ['Visible'] : 'Visible' } }] },
    });
    expect(ambiguous.statusCode, ambiguous.body).toBe(422);
  },
);

it.each(['label', 'filter'] as const)(
  'preserves selections when the source %s is unreadable',
  async (hidden) => {
    const f = await fixture();
    const s = await source(f, true);
    const id = newId('record');
    const selected = await sourceChoiceId(s.first);
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [s.select]: [selected] } }],
    });
    const actor = await actorFor(server.pool, server.schemas, editor.userId, server.owner.info.org.id);
    const scope = new AccessScope(server.pool, server.schemas, actor!);
    await scope.prepare(f.databaseId);
    await scope.ensureTable(s.tableId);
    const visible = scope.visibleFields.bind(scope);
    vi.spyOn(scope, 'limitsRecords').mockImplementation((tableId) => tableId === s.tableId);
    vi.spyOn(scope, 'visibleFields').mockImplementation((tableId, fields) =>
      visible(tableId, fields).filter(
        (field) => tableId !== s.tableId || field.id !== (hidden === 'label' ? s.label : s.enabled),
      ),
    );
    const { writeGuard } = await import('./permissions/enforce.js');
    const guard = writeGuard(
      server.pool,
      server.schemas,
      scope,
      f.tableId,
      await loadFields(server.pool, server.schemas, [f.tableId]),
    );
    const rows = await guard.keepHiddenLinks([{ id, values: { [s.select]: [] } }], true);
    expect(rows[0]!.values[s.select]).toEqual([selected]);
  },
);

it('commits source field changes while the choice index waits for another writer', async () => {
  const f = await fixture();
  const s = await source(f);
  await vi.waitFor(
    async () => {
      const indexes = await query<{ valid: boolean }>(
        server.pool,
        sql`SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass(${`"${server.schemas.data}"."${s.tableId}_choice"`})`,
      );
      expect(indexes.rows[0]?.valid).toBe(true);
    },
    { timeout: 5000 },
  );
  await query(server.pool, sql`DROP INDEX ${ident(server.schemas.data, `${s.tableId}_choice`)}`);
  const writer = await server.pool.connect();
  await writer.query('BEGIN');
  await query(writer, sql`LOCK TABLE ${ident(server.schemas.data, s.tableId)} IN ROW EXCLUSIVE MODE`);
  const change = f.run({
    kind: 'field.create',
    tableId: f.tableId,
    field: { id: newId('field'), name: 'Another source', type: 'singleSelect', options: s.options },
  });
  try {
    const result = await Promise.race([change, delay(2000).then(() => ({ status: 'waiting' }))]);
    expect(result).toMatchObject({ status: 'applied' });
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    await change;
  }
  await vi.waitFor(
    async () => {
      const indexes = await query<{ valid: boolean }>(
        server.pool,
        sql`SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass(${`"${server.schemas.data}"."${s.tableId}_choice"`})`,
      );
      expect(indexes.rows[0]?.valid).toBe(true);
    },
    { timeout: 5000 },
  );
});

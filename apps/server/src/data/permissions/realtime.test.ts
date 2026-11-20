import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GridConfig,
  newId,
  visibleFormQuestions,
  type ClientMessage,
  type ServerMessage,
} from '@riosoma/contracts';
import { sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { AccessScope } from '../access.js';
import {
  applied,
  forbiddenFor,
  inject,
  leaks,
  permissionFixture,
  SALARY,
  schemaOf,
  tokenFor,
  type PermissionFixture,
  type Person,
} from './permissions.test-helpers.js';

/**
 * Realtime as a path of its own: every change, presence notice, and view delta a tab receives is
 * filtered for the person the tab belongs to, and a rule change reloads every tab before anything
 * goes out under the old rules.
 */

let kit: TestPostgres;
let server: ServerFixture;
let address: string;
let f: PermissionFixture;
const tabs: Tab[] = [];

async function until(check: () => boolean, timeout = 8_000): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeout) throw new Error('condition timed out');
    await delay(10);
  }
}

class Tab {
  readonly clientId = newId('client');
  readonly socket: WebSocket;
  readonly received: ServerMessage[] = [];
  readonly opened: Promise<void>;

  constructor(readonly person: Person) {
    this.socket = new WebSocket(address.replace(/^http/, 'ws') + '/api/realtime', {
      headers: { cookie: person.signed.headers.cookie, origin: new URL(address).origin },
    } as unknown as string[]);
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error('upgrade refused')), { once: true });
    });
    this.socket.addEventListener('message', (event) =>
      this.received.push(JSON.parse(String(event.data)) as ServerMessage),
    );
    tabs.push(this);
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  get text(): string {
    return JSON.stringify(this.received);
  }

  lastSeq(): number {
    let seq = 0;
    for (const message of this.received) {
      if (message.type === 'change') seq = Math.max(seq, message.change.seq);
      if (message.type === 'caughtUp') seq = Math.max(seq, message.seq);
    }
    return seq;
  }
}

async function open(person: Person, sinceSeq: number): Promise<Tab> {
  const tab = new Tab(person);
  await tab.opened;
  tab.send({ type: 'hello', csrf: person.signed.info.csrfToken, clientId: tab.clientId });
  await until(() => tab.received.some((message) => message.type === 'ready'));
  tab.send({ type: 'subscribe', databaseId: f.databaseId, sinceSeq });
  await until(() => tab.received.some((message) => message.type === 'caughtUp'));
  return tab;
}

async function currentSeq(): Promise<number> {
  const result = await server.pool.query<{ change_seq: string }>(
    `SELECT change_seq FROM "${server.schemas.app}".databases WHERE id = $1`,
    [f.databaseId],
  );
  return Number(result.rows[0]!.change_seq);
}

/** Changes the owner makes while tabs watch: to hidden records, to Salary, to links, and to a view. */
async function busyOwner(): Promise<void> {
  const { people, teams } = f;
  const owner = server.owner;
  await applied(server, owner, f.databaseId, {
    kind: 'record.update',
    tableId: people.tableId,
    records: [
      { id: people.records.zanzibar, values: { [people.fields.notes]: 'East secret, again' } },
      { id: people.records.ana, values: { [people.fields.salary]: SALARY.ana + 1 } },
    ],
  });
  await applied(server, owner, f.databaseId, {
    kind: 'record.create',
    tableId: people.tableId,
    records: [
      {
        id: newId('record'),
        values: {
          [people.fields.name]: 'Zanzibar Newcomer',
          [people.fields.region]: people.choices.east,
          [people.fields.salary]: SALARY.zanzibar,
          [people.fields.team]: [teams.records.alpha],
        },
      },
    ],
  });
  await applied(server, owner, f.databaseId, {
    kind: 'comment.create',
    tableId: people.tableId,
    recordId: people.records.zanzibar,
    comment: { id: newId('comment'), body: 'Zanzibar realtime note' },
  });
  await applied(server, owner, f.databaseId, {
    kind: 'view.update',
    viewId: people.viewId,
    config: {
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'rich', fieldId: people.fields.salary, operator: 'lt', value: 987654.25 }],
      },
    },
  });
  await applied(server, owner, f.databaseId, {
    kind: 'record.trash',
    tableId: people.tableId,
    recordIds: [people.records.zulu],
  });
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'permrealtime');
  server.config.baseUrl = undefined;
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  f = await permissionFixture(server);
}, 180_000);

afterEach(async () => {
  vi.restoreAllMocks();
  for (const tab of tabs.splice(0)) if (tab.socket.readyState === WebSocket.OPEN) tab.socket.close();
});
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

it('redacts hidden show-if comparisons in schema reads and realtime while preserving stored conditions', async () => {
  const viewer = await open(f.persons.reader, await currentSeq());
  const viewId = newId('view');
  const questions = [
    { fieldId: f.people.fields.salary },
    { fieldId: f.people.fields.name, showIf: { fieldId: f.people.fields.salary, equals: SALARY.ana } },
  ];
  await applied(server, server.owner, f.databaseId, {
    kind: 'view.create',
    view: {
      id: viewId,
      tableId: f.people.tableId,
      name: 'Conditional intake',
      type: 'form',
      config: { form: { questions } },
    },
  });
  const created = () =>
    viewer.received.find(
      (message) =>
        message.type === 'change' &&
        message.change.kind === 'view.created' &&
        message.change.view.id === viewId,
    );
  await until(() => Boolean(created()));
  const shown = (await schemaOf(server, f.persons.reader.signed, f.databaseId)).views.find(
    (view) => view.id === viewId,
  )!;
  const message = created()!;
  if (message.type !== 'change' || message.change.kind !== 'view.created')
    throw new Error('Expected a created view');
  const token = await tokenFor(server, f.persons.reader.signed);
  const response = await server.app.inject({
    url: `/api/v1/databases/${f.databaseId}/tables`,
    headers: { authorization: `Bearer ${token.token}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  const restView = response
    .json<{ tables: Array<{ views: Array<{ id: string; config: GridConfig }> }> }>()
    .tables.flatMap((table) => table.views)
    .find((view) => view.id === viewId)!;
  for (const config of [shown.config, restView.config, message.change.view.config]) {
    expect(JSON.stringify(config)).not.toContain(String(SALARY.ana));
    expect(GridConfig.safeParse(config).success).toBe(true);
    expect(config.form.questions[1]!.showIf).toMatchObject({ fieldId: f.people.fields.salary });
    expect(
      visibleFormQuestions(config.form.questions, { [f.people.fields.salary]: SALARY.ana }).map(
        (question) => question.fieldId,
      ),
    ).toEqual([f.people.fields.salary]);
  }
  await applied(server, f.persons.creator.signed, f.databaseId, {
    kind: 'view.update',
    viewId,
    name: 'Renamed intake',
    config: shown.config,
  });
  const stored = (await schemaOf(server, server.owner, f.databaseId)).views.find(
    (view) => view.id === viewId,
  )!;
  expect(stored.config.form.questions[1]!.showIf).toEqual(questions[1]!.showIf);
  const updated = () =>
    viewer.received.find(
      (message) =>
        message.type === 'change' &&
        message.change.kind === 'view.updated' &&
        message.change.view.id === viewId,
    );
  await until(() => Boolean(updated()));
  expect(JSON.stringify(updated())).not.toContain(String(SALARY.ana));
});

async function watchOwnerChanges(): Promise<Tab[]> {
  const since = await currentSeq();
  const watching = [
    await open(f.persons.hr, since),
    await open(f.persons.creator, since),
    await open(f.persons.editor, since),
    await open(f.persons.pat, since),
  ];
  await busyOwner();
  const last = await currentSeq();
  // The control sees every change, so once it has the last one everyone has been sent theirs.
  await until(() => watching[0]!.lastSeq() >= last);
  await delay(200);
  return watching;
}

describe('realtime', () => {
  it('sends each tab only what its person may see', async () => {
    const watching = await watchOwnerChanges();
    const [hr, ...limited] = watching;
    expect(hr!.text).toContain('Zanzibar');
    expect(hr!.text).toContain(String(SALARY.ana + 1));
    for (const tab of limited)
      expect(leaks(tab.text, forbiddenFor(f, tab.person)), tab.person.label).toEqual([]);
    // What they may see still arrives, with hidden links counted rather than named.
    const creator = watching[1]!;
    expect(creator.text).toContain('Zanzibar realtime note');
    const editor = watching[2]!;
    expect(editor.text).not.toContain('record.created');
    expect(
      editor.received.some((message) => message.type === 'change' && message.change.kind === 'view.updated'),
    ).toBe(true);
  });

  it('leaks once the rules stop applying, so the filter above is what keeps them out', async () => {
    const permissive = AccessScope.prototype;
    vi.spyOn(permissive, 'limited').mockReturnValue(false);
    vi.spyOn(permissive, 'visibleFields').mockImplementation(function <F extends { id: string }>(
      _tableId: string,
      fields: readonly F[],
    ) {
      return [...fields];
    });
    vi.spyOn(permissive, 'recordPredicate').mockImplementation(() => sql`TRUE`);
    const watching = await watchOwnerChanges();
    const leaked = watching.slice(1).some((tab) => leaks(tab.text, forbiddenFor(f, tab.person)).length > 0);
    expect(leaked).toBe(true);
  });

  it('keeps others’ places in hidden records and fields out of presence', async () => {
    const since = await currentSeq();
    const editor = await open(f.persons.editor, since);
    const owner = await open(f.persons.owner, since);
    owner.send({
      type: 'presence',
      databaseId: f.databaseId,
      where: {
        tableId: f.people.tableId,
        viewId: f.people.viewId,
        recordId: f.people.records.zanzibar,
        cell: { recordId: f.people.records.zanzibar, fieldId: f.people.fields.salary },
      },
    });
    await until(() =>
      editor.received.some((message) => message.type === 'presence' && message.peers.length > 0),
    );
    const presence = editor.received.filter((message) => message.type === 'presence');
    expect(JSON.stringify(presence)).not.toContain(f.people.records.zanzibar);
    expect(JSON.stringify(presence)).not.toContain(f.people.fields.salary);
    expect(JSON.stringify(presence)).toContain(f.people.viewId);
  });

  it('reloads every tab when a rule changes, before anything goes out under the old rules', async () => {
    const since = await currentSeq();
    const creator = await open(f.persons.creator, since);
    const hr = await open(f.persons.hr, since);
    const response = await inject(
      server,
      server.owner,
      'PUT',
      `/api/fields/${f.people.fields.notes}/permissions`,
      { restricted: { roles: [], users: [] }, locked: null },
    );
    expect(response.statusCode, response.body).toBe(200);
    // Anything after the rule change can't reach the old subscription.
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.update',
      tableId: f.people.tableId,
      records: [{ id: f.people.records.ana, values: { [f.people.fields.notes]: 'After the change' } }],
    });
    for (const tab of [creator, hr]) {
      await until(() =>
        tab.received.some((message) => message.type === 'reload' && message.reason === 'accessChanged'),
      );
      expect(tab.text).not.toContain('After the change');
    }
    const restored = await inject(
      server,
      server.owner,
      'PUT',
      `/api/fields/${f.people.fields.notes}/permissions`,
      { restricted: null, locked: { roles: ['creator'], users: [f.persons.lead.signed.userId] } },
    );
    expect(restored.statusCode, restored.body).toBe(200);
  });
});

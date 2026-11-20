import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTOMATION_VERSIONS_KEPT,
  AutomationConfig,
  UndoResult,
  newId,
  type AutomationRun,
  type AutomationVersionsList,
} from '@riosoma/contracts';
import { createPool, ident, migrate, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { MIGRATIONS } from '../migrations/index.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import {
  apply,
  automate,
  createBase,
  createRecords,
  engine,
  grant,
  records,
  runRows,
  runsPage,
  schema,
  send,
  testRun,
  type Base,
} from './automations.test-helpers.js';
import { messageSecret, sealMessages, type MessageStep } from './messaging.js';
import { toAutomation, type AutomationRow } from './store.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: Base;
let creator: SignedIn;
let editor: SignedIn;
let reader: SignedIn;
let receiver: http.Server;
let receiverUrl: string;
const hits: string[] = [];
let answers: number[] = [];

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'autover', { automationsPollMs: 0, automationsAllowPrivateHosts: true });
  base = await createBase(server);
  creator = await server.addMember({ name: 'Casey Creator' });
  editor = await server.addMember({ name: 'Eddie Editor' });
  reader = await server.addMember({ name: 'Riley Reader' });
  await grant(server, base.databaseId, creator, 'creator');
  await grant(server, base.databaseId, editor, 'editor');
  await grant(server, base.databaseId, reader, 'reader');
  receiver = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      hits.push(request.url ?? '');
      response.writeHead(answers.shift() ?? 200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  engine(server).messagingTestBaseUrls = { slack: receiverUrl };
}, 60_000);

afterEach(async () => {
  hits.length = 0;
  answers = [];
  // Every test's automations watch the same table, so each test's go off when it's done.
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'automations')} SET enabled = false WHERE database_id = ${base.databaseId}`,
  );
});

afterAll(async () => {
  receiver?.closeAllConnections();
  if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await server?.close();
  await kit?.stop();
});

/** A stand-in credential path, made fresh so no test ever holds a real-looking one as a literal. */
const standIn = (label: string) => `/services/${label}/${randomBytes(6).toString('hex')}`;

/** The names of the credentials sealed for an automation. */
async function sealedNames(id: string): Promise<string[]> {
  const result = await query<{ messaging_secrets: Record<string, string> | null }>(
    server.pool,
    sql`SELECT messaging_secrets FROM ${ident(server.schemas.app, 'automations')} WHERE id = ${id}`,
  );
  return Object.keys(result.rows[0]?.messaging_secrets ?? {}).sort();
}

/** Replaces a table's record rules, which leave out records whose name isn't `visible` for `roles`. */
async function recordRules(tableId: string, roles: string[], visible = 'Nothing'): Promise<void> {
  const response = await server.app.inject({
    method: 'PUT',
    url: `/api/tables/${tableId}/record-rules`,
    headers: server.owner.headers,
    payload: {
      rules: roles.length
        ? [
            {
              id: newId('recordRule'),
              roles,
              users: [],
              condition: {
                conjunction: 'and',
                conditions: [{ id: 'named', fieldId: base.f.name, operator: 'is', value: visible }],
              },
            },
          ]
        : [],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** Restricts a field to no one but the owner, or lifts that. */
async function restrictField(fieldId: string, restricted: boolean): Promise<void> {
  const response = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${fieldId}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: restricted ? { roles: [], users: [] } : null, locked: null },
  });
  expect(response.statusCode, response.body).toBe(200);
}

const logging = (summary: string) => ({
  trigger: { kind: 'recordCreated', tableId: base.tasks },
  steps: [{ id: 'log-it', kind: 'createRecord', tableId: base.log, values: { [base.f.summary]: summary } }],
});

const automationOf = async (id: string, who = server.owner) =>
  (await schema(server, base.databaseId, who)).automations!.find((automation) => automation.id === id)!;

async function versions(id: string, who = server.owner): Promise<AutomationVersionsList> {
  const response = await server.app.inject({ url: `/api/automations/${id}/versions`, headers: who.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AutomationVersionsList>();
}

async function summaries(): Promise<string[]> {
  return (await records(server, base.log)).map((row) => String(row[base.f.summary]));
}

/** Adds a task, lets the automations run, and returns what they logged for it. */
async function addTask(): Promise<string[]> {
  const before = (await summaries()).length;
  await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Task' }]);
  await engine(server).drain();
  return (await summaries()).slice(before);
}

async function reverse(groupId: string, direction: 'undo' | 'redo', who: SignedIn = server.owner) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${base.databaseId}/${direction}`,
    headers: who.headers,
    payload: { clientId: newId('client'), groupId, commandId: newId('command') },
  });
  expect(response.statusCode, response.body).toBe(200);
  return UndoResult.parse(response.json());
}

async function again(
  automationId: string,
  runId: string,
  how: 'rerun' | 'resume',
  who: SignedIn = server.owner,
  stepId?: string,
) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${automationId}/runs/${runId}/${how}`,
    headers: who.headers,
    payload: stepId ? { stepId } : {},
  });
  return { status: response.statusCode, run: response.json<AutomationRun>(), body: response.body };
}

describe('drafts and publishing', () => {
  it('saves changes to a draft that runs only once it is published', async () => {
    const id = await automate(server, base.databaseId, logging('First'));
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, config: logging('Second') },
    ]);
    const drafted = await automationOf(id);
    expect(drafted).toMatchObject({ version: 1, draft: { updatedBy: server.owner.userId } });
    expect(drafted.config.steps[0]).toMatchObject({ values: { [base.f.summary]: 'First' } });
    expect(drafted.draft?.config.steps[0]).toMatchObject({ values: { [base.f.summary]: 'Second' } });
    expect(await addTask()).toEqual(['First']);

    await apply(server, base.databaseId, [{ kind: 'automation.publish', automationId: id }], creator);
    const published = await automationOf(id);
    expect(published).toMatchObject({ version: 2, draft: null, publishedBy: creator.userId });
    expect(published.config.steps[0]).toMatchObject({ values: { [base.f.summary]: 'Second' } });
    expect(await addTask()).toEqual(['Second']);
    // Each run says which version it ran.
    expect((await runRows(server, id)).map((row) => row.version)).toEqual([1, 2]);
    expect((await runsPage(server, id)).page.runs.map((run) => run.version)).toEqual([2, 1]);
    expect((await versions(id)).versions).toMatchObject([
      { version: 2, live: true, publishedBy: creator.userId, steps: 1 },
      { version: 1, live: false, publishedBy: server.owner.userId, steps: 1 },
    ]);
    const audit = await query<{ metadata: { version: number } }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action = 'data.automation.published' AND metadata ->> 'automationId' = ${id}`,
    );
    expect(audit.rows.map((row) => row.metadata.version)).toEqual([2]);
  });

  it('turns on and off what is published, and keeps a draft that matches it from existing', async () => {
    const id = await automate(server, base.databaseId, logging('Live'), { enabled: false });
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, config: logging('Unpublished') },
      { kind: 'automation.update', automationId: id, enabled: true },
    ]);
    expect(await addTask()).toEqual(['Live']);
    expect((await automationOf(id)).draft).not.toBeNull();
    // Changing it back to what's published leaves no draft to publish.
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, config: logging('Live') },
    ]);
    expect((await automationOf(id)).draft).toBeNull();
    const [nothing] = await send(server, base.databaseId, [{ kind: 'automation.publish', automationId: id }]);
    expect(nothing).toMatchObject({ status: 'rejected', error: { messageKey: 'automations.draft.none' } });
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
    expect(await addTask()).toEqual([]);
  });

  it('checks the draft when publishing, and throws a draft away without touching what runs', async () => {
    const id = await automate(server, base.databaseId, logging('Kept'));
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, config: logging('Thrown away') },
    ]);
    await apply(server, base.databaseId, [{ kind: 'automation.discardDraft', automationId: id }]);
    expect(await automationOf(id)).toMatchObject({ version: 1, draft: null });
    expect(await addTask()).toEqual(['Kept']);

    // A draft that was fine when saved is checked again, since the database may have changed.
    const fieldId = newId('field');
    await apply(server, base.databaseId, [
      { kind: 'field.create', tableId: base.log, field: { id: fieldId, name: 'Extra', type: 'text' } },
    ]);
    const config = logging('Uses a field');
    config.steps[0]!.values[fieldId] = 'x';
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, config }]);
    await apply(server, base.databaseId, [{ kind: 'field.trash', fieldId }]);
    const [refused] = await send(server, base.databaseId, [{ kind: 'automation.publish', automationId: id }]);
    expect(refused).toMatchObject({ status: 'rejected' });
    expect(await automationOf(id)).toMatchObject({ version: 1 });
  });

  it('restores any kept version as a new draft', async () => {
    const id = await automate(server, base.databaseId, logging('One'));
    for (const summary of ['Two', 'Three'])
      await apply(server, base.databaseId, [
        { kind: 'automation.update', automationId: id, config: logging(summary) },
        { kind: 'automation.publish', automationId: id },
      ]);
    await apply(server, base.databaseId, [
      { kind: 'automation.restoreVersion', automationId: id, version: 1 },
    ]);
    const restored = await automationOf(id);
    expect(restored.version).toBe(3);
    expect(restored.draft?.config.steps[0]).toMatchObject({ values: { [base.f.summary]: 'One' } });
    expect(await addTask()).toEqual(['Three']);
    await apply(server, base.databaseId, [{ kind: 'automation.publish', automationId: id }]);
    // A number is never used twice, so the restored configuration is version 4.
    expect(await automationOf(id)).toMatchObject({ version: 4, draft: null });
    expect(await addTask()).toEqual(['One']);
    // Restoring the published version leaves nothing to publish.
    await apply(server, base.databaseId, [
      { kind: 'automation.restoreVersion', automationId: id, version: 4 },
    ]);
    expect((await automationOf(id)).draft).toBeNull();
    const [unknown] = await send(server, base.databaseId, [
      { kind: 'automation.restoreVersion', automationId: id, version: 99 },
    ]);
    expect(unknown).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
  });

  it(`keeps the last ${AUTOMATION_VERSIONS_KEPT} versions besides the published one`, async () => {
    const id = await automate(server, base.databaseId, logging('v1'), { enabled: false });
    const total = AUTOMATION_VERSIONS_KEPT + 3;
    for (let version = 2; version <= total; version += 1)
      await apply(server, base.databaseId, [
        { kind: 'automation.update', automationId: id, config: logging(`v${version}`) },
        { kind: 'automation.publish', automationId: id },
      ]);
    const list = (await versions(id)).versions;
    expect(list).toHaveLength(AUTOMATION_VERSIONS_KEPT + 1);
    expect(list[0]).toMatchObject({ version: total, live: true });
    expect(list.at(-1)).toMatchObject({ version: total - AUTOMATION_VERSIONS_KEPT, live: false });
    const [gone] = await send(server, base.databaseId, [
      { kind: 'automation.restoreVersion', automationId: id, version: 1 },
    ]);
    expect(gone).toMatchObject({ status: 'rejected', error: { messageKey: 'automations.version.gone' } });
    // Anyone who can open the database can read the list.
    expect((await versions(id, reader)).versions).toHaveLength(AUTOMATION_VERSIONS_KEPT + 1);
  });

  it('undoes a publish so what ran before runs again, and redoes it', async () => {
    const id = await automate(server, base.databaseId, logging('Before'));
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, config: logging('After') },
    ]);
    const group = newId('action');
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.publish', automationId: id }],
      server.owner,
      group,
    );
    expect(await addTask()).toEqual(['After']);

    expect(await reverse(group, 'undo')).toMatchObject({ status: 'applied' });
    const undone = await automationOf(id);
    expect(undone).toMatchObject({ version: 1 });
    expect(undone.draft?.config.steps[0]).toMatchObject({ values: { [base.f.summary]: 'After' } });
    expect(await addTask()).toEqual(['Before']);

    expect(await reverse(group, 'redo')).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({ version: 2, draft: null });
    expect(await addTask()).toEqual(['After']);
    expect((await versions(id)).versions.map((version) => version.version)).toEqual([2, 1]);
  });

  it('undoes a draft save, a rename, and a move without bringing back what ran before', async () => {
    const id = await automate(server, base.databaseId, logging('Before'));
    const save = newId('action');
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.update', automationId: id, config: logging('After') }],
      server.owner,
      save,
    );
    const rename = newId('action');
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.update', automationId: id, name: 'Renamed' }],
      server.owner,
      rename,
    );
    const move = newId('action');
    const position = (await automationOf(id)).position;
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.move', automationId: id, position: position + 10 }],
      server.owner,
      move,
    );
    // A teammate publishes the draft while it's on, so it acts as them now.
    await apply(server, base.databaseId, [{ kind: 'automation.publish', automationId: id }], creator);
    expect(await automationOf(id)).toMatchObject({ version: 2, runAsId: creator.userId });

    for (const group of [move, rename, save])
      expect(await reverse(group, 'undo')).toMatchObject({ status: 'applied' });
    // None of those changes published anything, so undoing them leaves the teammate's publish live.
    const undone = await automationOf(id);
    expect(undone).toMatchObject({
      version: 2,
      name: 'Automation',
      position,
      runAsId: creator.userId,
      draft: null,
    });
    expect(undone.config.steps[0]).toMatchObject({ values: { [base.f.summary]: 'After' } });
    expect(await addTask()).toEqual(['After']);
    // Redoing the draft save leaves it the same, since that's what's published now.
    expect(await reverse(save, 'redo')).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({ version: 2, draft: null, runAsId: creator.userId });
  });

  it('undoes turning it off as whoever undoes it, as turning it on does', async () => {
    const id = await automate(server, base.databaseId, logging('Back on'));
    const turnOff = async (who: SignedIn) => {
      const group = newId('action');
      await apply(
        server,
        base.databaseId,
        [{ kind: 'automation.update', automationId: id, enabled: false }],
        who,
        group,
      );
      return group;
    };
    // The person it already acts as stays that person.
    expect(await reverse(await turnOff(server.owner), 'undo')).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({ enabled: true, version: 1, runAsId: server.owner.userId });
    // Anyone else who turns it back on this way is who it acts as from then on.
    expect(await reverse(await turnOff(creator), 'undo', creator)).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({ enabled: true, version: 1, runAsId: creator.userId });
    expect(await addTask()).toEqual(['Back on']);
    expect((await runRows(server, id)).at(-1)).toMatchObject({ actor_id: creator.userId });
  });

  it('never runs what someone published while it was off as the person it acted as before', async () => {
    const id = await automate(server, base.databaseId, logging('Owner'));
    const off = newId('action');
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.update', automationId: id, enabled: false }],
      creator,
      off,
    );
    await apply(
      server,
      base.databaseId,
      [
        { kind: 'automation.update', automationId: id, config: logging('Creator') },
        { kind: 'automation.publish', automationId: id },
      ],
      creator,
    );
    expect(await automationOf(id)).toMatchObject({ enabled: false, version: 2 });
    // Undoing the earlier turn-off turns on what's published now, so it acts as whoever undid it.
    expect(await reverse(off, 'undo', creator)).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({ enabled: true, version: 2, runAsId: creator.userId });
    expect(await addTask()).toEqual(['Creator']);
    expect((await runRows(server, id)).at(-1)).toMatchObject({ actor_id: creator.userId });
    expect((await records(server, base.log)).at(-1)?.__created_by).toBe(creator.userId);
  });

  it('never runs a publish redone while it was off as the person it acted as before', async () => {
    const id = await automate(server, base.databaseId, logging('Owner'), { enabled: false });
    // While it's off, a teammate publishes a change and takes it back.
    const publish = newId('action');
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.update', automationId: id, config: logging('Creator') }],
      creator,
    );
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.publish', automationId: id }],
      creator,
      publish,
    );
    expect(await reverse(publish, 'undo', creator)).toMatchObject({ status: 'applied' });
    // The owner turns on what they made, so it acts as them.
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: true }]);
    expect(await automationOf(id)).toMatchObject({ enabled: true, version: 1, runAsId: server.owner.userId });
    const off = newId('action');
    await apply(
      server,
      base.databaseId,
      [{ kind: 'automation.update', automationId: id, enabled: false }],
      creator,
      off,
    );
    expect(await reverse(publish, 'redo', creator)).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({ enabled: false, version: 2 });
    expect(await reverse(off, 'undo', creator)).toMatchObject({ status: 'applied' });
    expect(await automationOf(id)).toMatchObject({ enabled: true, version: 2, runAsId: creator.userId });
    expect(await addTask()).toEqual(['Creator']);
    expect((await runRows(server, id)).at(-1)).toMatchObject({ actor_id: creator.userId });
  });

  it('tests the draft, marked as a test of the draft', async () => {
    const id = await automate(server, base.databaseId, logging('Published'), { enabled: false });
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, config: logging('Draft') },
    ]);
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Try' }]);
    const tested = await testRun(server, id, { recordId });
    expect(tested.run).toMatchObject({ state: 'succeeded', test: true, draft: true, version: null });
    expect((await summaries()).at(-1)).toBe('Draft');
    await apply(server, base.databaseId, [{ kind: 'automation.discardDraft', automationId: id }]);
    expect((await testRun(server, id, { recordId })).run).toMatchObject({ version: 1 });
    expect((await summaries()).at(-1)).toBe('Published');
  });

  it('lists tests of the draft only for people who can change the automation', async () => {
    const id = await automate(server, base.databaseId, logging('Published'), { enabled: false });
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, config: logging('Draft') },
    ]);
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Try' }]);
    const ofDraft = await testRun(server, id, { recordId });
    expect(ofDraft.run).toMatchObject({ draft: true });
    await apply(server, base.databaseId, [{ kind: 'automation.discardDraft', automationId: id }]);
    const ofPublished = await testRun(server, id, { recordId });
    const listed = async (who: SignedIn) => {
      const { status, page } = await runsPage(server, id, who);
      expect(status).toBe(200);
      return page.runs.map((run) => run.id);
    };
    expect(await listed(server.owner)).toEqual([ofPublished.run.id, ofDraft.run.id]);
    expect(await listed(creator)).toEqual([ofPublished.run.id, ofDraft.run.id]);
    for (const who of [editor, reader]) expect(await listed(who)).toEqual([ofPublished.run.id]);
  });

  it('keeps editors who can see less from publishing or discarding what uses a hidden field', async () => {
    const id = await automate(server, base.databaseId, logging('Visible'), { enabled: false });
    const config = logging('Noted');
    config.steps[0]!.values[base.f.logNote] = 'Private note';
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, config }]);
    const restrict = async (restricted: unknown) => {
      const response = await server.app.inject({
        method: 'PUT',
        url: `/api/fields/${base.f.logNote}/permissions`,
        headers: server.owner.headers,
        payload: { restricted, locked: null },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    await restrict({ roles: [], users: [] });
    for (const kind of ['automation.publish', 'automation.discardDraft'])
      expect((await send(server, base.databaseId, [{ kind, automationId: id }], creator))[0]).toMatchObject({
        status: 'rejected',
        error: { messageKey: 'data.access.fieldHidden' },
      });
    // What they can't see comes to them without its values, the draft included.
    const seen = await automationOf(id, creator);
    expect(seen.draft?.config.steps[0]).toMatchObject({ values: { [base.f.summary]: 'Noted' } });
    expect(JSON.stringify(seen.draft)).not.toContain('Private note');
    await restrict(null);
    await apply(server, base.databaseId, [{ kind: 'automation.publish', automationId: id }], creator);
  });
});

describe('messaging credentials in drafts and versions', () => {
  it('keeps the published version sending where it did while a draft replaces the address', async () => {
    const key = randomBytes(32);
    const automationId = newId('automation');
    const first = standIn('first');
    const second = standIn('second');
    const slack = (webhookUrl: string, extra: Partial<MessageStep> = {}): MessageStep =>
      ({ id: 'slack001', name: '', kind: 'slack', webhookUrl, body: 'Hi', ...extra }) as MessageStep;
    const config = (step: MessageStep) =>
      AutomationConfig.parse({ trigger: { kind: 'webhook' }, steps: [step] });
    const live = await sealMessages(
      key,
      automationId,
      'organization',
      config(slack(`https://hooks.slack.com${first}`)),
    );
    const draft = await sealMessages(
      key,
      automationId,
      'organization',
      config(slack(`https://hooks.slack.com${second}`)),
      live.secrets,
      live.config,
    );
    const liveStep = live.config.steps[0] as MessageStep;
    const draftStep = draft.config.steps[0] as MessageStep;
    expect(liveStep.secretRef).not.toBe(draftStep.secretRef);
    expect(await messageSecret(key, automationId, 'organization', liveStep, draft.secrets)).toContain(first);
    expect(await messageSecret(key, automationId, 'organization', draftStep, draft.secrets)).toContain(
      second,
    );
    // A step that comes back without its name keeps the one it had.
    const resent = await sealMessages(
      key,
      automationId,
      'organization',
      config(slack('', { secretRef: undefined })),
      draft.secrets,
      draft.config,
    );
    expect((resent.config.steps[0] as MessageStep).secretRef).toBe(draftStep.secretRef);
    // A name another step was given doesn't count.
    const borrowed = await sealMessages(
      key,
      automationId,
      'organization',
      config({ ...slack(''), id: 'slack002', secretRef: draftStep.secretRef }),
      draft.secrets,
    );
    expect(borrowed.config.steps[0]).toMatchObject({ secretSaved: false });
    expect((borrowed.config.steps[0] as MessageStep).secretRef).toBeUndefined();
  });

  it('lets go of credentials nothing uses once it publishes, discards, or stops keeping a version', async () => {
    const posting = (webhookUrl: string, body = 'Hi') => ({
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [{ id: 'tell-slack', kind: 'slack', webhookUrl, body }],
    });
    const url = (label: string) => `https://hooks.slack.com${standIn(label)}`;
    const id = await automate(server, base.databaseId, posting(url('first')), { enabled: false });
    const [first] = await sealedNames(id);
    const update = (config: ReturnType<typeof posting>) =>
      apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, config }]);

    // A new address in a draft that's thrown away goes with it.
    await update(posting(url('second')));
    expect(await sealedNames(id)).toHaveLength(2);
    await apply(server, base.databaseId, [{ kind: 'automation.discardDraft', automationId: id }]);
    expect(await sealedNames(id)).toEqual([first]);

    // A draft that changes the address twice keeps only the last once it's published, and the
    // version it replaced keeps its own.
    await update(posting(url('third')));
    await update(posting(url('fourth')));
    expect(await sealedNames(id)).toHaveLength(3);
    await apply(server, base.databaseId, [{ kind: 'automation.publish', automationId: id }]);
    const published = (await automationOf(id)).config.steps[0] as MessageStep;
    expect(published).toMatchObject({ secretSaved: true });
    expect(await sealedNames(id)).toEqual([first, published.secretRef].sort());

    // Once no kept version uses the first address, it goes too.
    for (let n = 0; n <= AUTOMATION_VERSIONS_KEPT; n += 1)
      await apply(server, base.databaseId, [
        { kind: 'automation.update', automationId: id, config: posting('', `Hi ${n}`) },
        { kind: 'automation.publish', automationId: id },
      ]);
    expect(await sealedNames(id)).toEqual([published.secretRef]);
    expect((await automationOf(id)).config.steps[0]).toMatchObject({
      secretSaved: true,
      secretRef: published.secretRef,
    });
  });
});

describe('rerun and resume', () => {
  const failing = () => ({
    trigger: { kind: 'recordCreated', tableId: base.tasks },
    steps: [
      {
        id: 'tell-slack',
        kind: 'slack',
        webhookUrl: `https://hooks.slack.com${standIn('announce')}`,
        body: `New task {{trigger.record.${base.f.name}}}`,
      },
      { id: 'call-app', kind: 'callWebhook', url: `${receiverUrl}/app`, body: '{"n": 1}' },
    ],
  });

  async function failedRun(): Promise<{ id: string; runId: string; recordId: string }> {
    const id = await automate(server, base.databaseId, failing());
    answers = [200, 500];
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Ship' }]);
    await engine(server).drain();
    const [run] = await runRows(server, id);
    expect(run).toMatchObject({ state: 'failed', version: 1 });
    expect(hits).toHaveLength(2);
    hits.length = 0;
    return { id, runId: run!.id, recordId: recordId! };
  }

  it('reruns the published version with the same trigger, as the automation’s person', async () => {
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'webhook' },
      steps: [
        {
          id: 'log-body',
          kind: 'createRecord',
          tableId: base.log,
          values: { [base.f.summary]: 'Order {{trigger.body.order}}' },
        },
      ],
    });
    const path = (await automationOf(id)).webhookPath!;
    const called = await server.app.inject({ method: 'POST', url: path, payload: { order: 'A-7' } });
    expect(called.statusCode).toBe(202);
    await engine(server).drain();
    const [first] = await runRows(server, id);
    await apply(server, base.databaseId, [
      {
        kind: 'automation.update',
        automationId: id,
        config: {
          trigger: { kind: 'webhook' },
          steps: [
            {
              id: 'log-body',
              kind: 'createRecord',
              tableId: base.log,
              values: { [base.f.summary]: 'Again {{trigger.body.order}}' },
            },
          ],
        },
      },
      { kind: 'automation.publish', automationId: id },
    ]);
    const rerun = await again(id, first!.id, 'rerun', creator);
    expect(rerun.status, rerun.body).toBe(200);
    expect(rerun.run).toMatchObject({
      state: 'queued',
      test: false,
      version: 2,
      from: { runId: first!.id, kind: 'rerun' },
    });
    // It names the run it came from and when that one started, exactly.
    const started = (first!.started_at ?? first!.queued_at).toISOString();
    expect(rerun.run.from?.at).toBe(started);
    await engine(server).drain();
    const rows = await records(server, base.log);
    expect(rows.slice(-2).map((row) => row[base.f.summary])).toEqual(['Order A-7', 'Again A-7']);
    // It acts as the automation's person, not whoever asked for it.
    expect(rows.at(-1)?.__created_by).toBe(server.owner.userId);
    const [, second] = await runRows(server, id);
    expect(second).toMatchObject({ state: 'succeeded', body: { order: 'A-7' }, source_kind: 'rerun' });
    expect((await runsPage(server, id)).page.runs[0]).toMatchObject({
      from: { runId: first!.id, kind: 'rerun', at: started },
    });
  });

  it('resumes from a failed step, reusing what the steps before it did without sending again', async () => {
    const { id, runId, recordId } = await failedRun();
    // Fixing the step that failed is fine: only the steps before it have to be the same.
    const fixed = failing();
    fixed.steps[0] = (await automationOf(id)).config.steps[0] as (typeof fixed.steps)[number];
    fixed.steps[1] = { ...fixed.steps[1]!, body: '{"n": 2}' };
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, config: fixed },
      { kind: 'automation.publish', automationId: id },
    ]);
    const resumed = await again(id, runId, 'resume', server.owner, 'call-app');
    expect(resumed.status, resumed.body).toBe(200);
    expect(resumed.run).toMatchObject({
      state: 'queued',
      version: 2,
      trigger: { recordId },
      from: { runId, kind: 'resume', stepId: 'call-app' },
      steps: [{ stepId: 'tell-slack', state: 'succeeded', reused: true }],
    });
    await engine(server).drain();
    // Only the step that failed ran again.  The message went out once, in the first run.
    expect(hits).toEqual(['/app']);
    const latest = (await runsPage(server, id)).page.runs[0]!;
    expect(latest).toMatchObject({
      state: 'succeeded',
      steps: [
        { stepId: 'tell-slack', state: 'succeeded', reused: true },
        { stepId: 'call-app', state: 'succeeded' },
      ],
    });
  });

  it('refuses to resume once a step before the failed one changed, and says which', async () => {
    const { id, runId } = await failedRun();
    const changed = failing();
    changed.steps[0] = {
      ...(await automationOf(id)).config.steps[0],
      body: 'Something else',
    } as (typeof changed.steps)[number];
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, config: changed },
      { kind: 'automation.publish', automationId: id },
    ]);
    const refused = await again(id, runId, 'resume', server.owner, 'call-app');
    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body)).toMatchObject({
      error: { messageKey: 'automations.resume.stepChanged', params: { step: '1' } },
    });
    // Only a failed step can be resumed from, and a rerun is still there.
    const earlier = await again(id, runId, 'resume', server.owner, 'tell-slack');
    expect(JSON.parse(earlier.body)).toMatchObject({ error: { messageKey: 'automations.resume.notFailed' } });
    expect((await again(id, runId, 'rerun')).status).toBe(200);
    expect((await runRows(server, id)).length).toBe(2);
  });

  /** Publishes the automation again with only its failed step changed, as `who`. */
  async function publishFix(id: string, who: SignedIn = server.owner): Promise<void> {
    const fixed = failing();
    fixed.steps[0] = (await automationOf(id)).config.steps[0] as (typeof fixed.steps)[number];
    fixed.steps[1] = { ...fixed.steps[1]!, body: '{"n": 3}' };
    await apply(
      server,
      base.databaseId,
      [
        { kind: 'automation.update', automationId: id, config: fixed },
        { kind: 'automation.publish', automationId: id },
      ],
      who,
    );
  }

  it('records who each run acted as, and refuses to resume once the automation acts as someone else', async () => {
    const { id, runId } = await failedRun();
    expect((await runRows(server, id))[0]).toMatchObject({ actor_id: server.owner.userId });
    // A teammate publishes a fix while it's on, so it acts as them from now on.
    await publishFix(id, creator);
    expect((await automationOf(id)).runAsId).toBe(creator.userId);
    for (const who of [creator, server.owner]) {
      const refused = await again(id, runId, 'resume', who, 'call-app');
      expect(refused.status, refused.body).toBe(422);
      expect(JSON.parse(refused.body)).toMatchObject({
        error: { messageKey: 'automations.resume.runAsChanged' },
      });
    }
    expect(hits).toEqual([]);
    // A rerun runs every step again as the person it acts as now, so it's still there.
    const rerun = await again(id, runId, 'rerun', creator);
    expect(rerun.status, rerun.body).toBe(200);
    answers = [200, 200];
    await engine(server).drain();
    expect((await runRows(server, id)).at(-1)).toMatchObject({
      state: 'succeeded',
      actor_id: creator.userId,
      source_kind: 'rerun',
    });
  });

  it('fails a resumed run that would start as someone else, without sending anything', async () => {
    const { id, runId } = await failedRun();
    const resumed = await again(id, runId, 'resume', server.owner, 'call-app');
    expect(resumed.status, resumed.body).toBe(200);
    // Before it starts, a teammate turns it off and on again, so it acts as them.
    await apply(
      server,
      base.databaseId,
      [
        { kind: 'automation.update', automationId: id, enabled: false },
        { kind: 'automation.update', automationId: id, enabled: true },
      ],
      creator,
    );
    await engine(server).drain();
    expect(hits).toEqual([]);
    const latest = (await runsPage(server, id)).page.runs[0]!;
    expect(latest).toMatchObject({
      id: resumed.run.id,
      state: 'failed',
      steps: [
        { stepId: 'tell-slack', state: 'succeeded', reused: true },
        { stepId: 'call-app', state: 'failed', error: { messageKey: 'automations.resume.runAsChanged' } },
      ],
    });
  });

  it('fails a rerun queued as one person once the automation acts as someone else, without running it', async () => {
    const id = await automate(server, base.databaseId, logging('Owner'));
    expect(await addTask()).toEqual(['Owner']);
    const [first] = await runRows(server, id);
    // A teammate publishes a change while it's on, so it acts as them, and runs their version again.
    await apply(
      server,
      base.databaseId,
      [
        { kind: 'automation.update', automationId: id, config: logging('Creator') },
        { kind: 'automation.publish', automationId: id },
      ],
      creator,
    );
    const rerun = await again(id, first!.id, 'rerun', creator);
    expect(rerun.status, rerun.body).toBe(200);
    expect(rerun.run).toMatchObject({ state: 'queued', version: 2 });
    expect((await runRows(server, id)).at(-1)).toMatchObject({ version: 2, actor_id: creator.userId });
    // Before it starts, the owner publishes a correction, so it acts as the owner again.
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, config: logging('Owner again') },
      { kind: 'automation.publish', automationId: id },
    ]);
    expect(await automationOf(id)).toMatchObject({ version: 3, runAsId: server.owner.userId });
    const before = (await summaries()).length;
    await engine(server).drain();
    // The teammate's version never runs with the owner's access or under the owner's name.
    expect((await summaries()).slice(before)).toEqual([]);
    expect((await runRows(server, id)).at(-1)).toMatchObject({
      id: rerun.run.id,
      state: 'failed',
      version: 2,
      actor_id: creator.userId,
      steps: [{ stepId: 'log-it', state: 'failed', error: { messageKey: 'automations.runAs.changed' } }],
    });
    // A rerun asked for now runs what's published now, as the person it acts as now.
    const now = await again(id, first!.id, 'rerun', creator);
    expect(now.status, now.body).toBe(200);
    await engine(server).drain();
    expect((await summaries()).slice(before)).toEqual(['Owner again']);
    expect((await runRows(server, id)).at(-1)).toMatchObject({
      state: 'succeeded',
      version: 3,
      actor_id: server.owner.userId,
    });
    expect((await records(server, base.log)).at(-1)?.__created_by).toBe(server.owner.userId);
  });

  it('fails a run that started as one person once the automation acts as someone else, before any step', async () => {
    const id = await automate(server, base.databaseId, logging('Owner'));
    await apply(
      server,
      base.databaseId,
      [
        { kind: 'automation.update', automationId: id, config: logging('Creator') },
        { kind: 'automation.publish', automationId: id },
      ],
      creator,
    );
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Task' }]);
    // A worker takes the run, which records the version and the person it acts as together.
    const claimed = (await engine(server).claim(4)).find((row) => row.automation_id === id)!;
    expect(claimed).toMatchObject({ state: 'running', version: 2, actor_id: creator.userId });
    // Before its first step, the owner publishes a correction, so the automation acts as the owner.
    await apply(server, base.databaseId, [
      { kind: 'automation.update', automationId: id, config: logging('Owner again') },
      { kind: 'automation.publish', automationId: id },
    ]);
    const before = (await summaries()).length;
    expect(await engine(server).run(claimed)).toMatchObject({
      state: 'failed',
      version: 2,
      actor_id: creator.userId,
      steps: [{ stepId: 'log-it', state: 'failed', error: { messageKey: 'automations.runAs.changed' } }],
    });
    expect((await summaries()).slice(before)).toEqual([]);
  });

  it('fails a run picked up again once the automation acts as someone else, without running the rest', async () => {
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [
        { id: 'log-it', kind: 'createRecord', tableId: base.log, values: { [base.f.summary]: 'Picked up' } },
        { id: 'call-app', kind: 'callWebhook', url: `${receiverUrl}/app`, body: '{}' },
      ],
    });
    expect(await addTask()).toEqual(['Picked up']);
    const [done] = await runRows(server, id);
    expect(done).toMatchObject({ state: 'succeeded', actor_id: server.owner.userId });
    expect(hits).toEqual(['/app']);
    hits.length = 0;
    // As if the server stopped after the first step, before the second ran.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'automation_runs')} SET state = 'running', finished_at = NULL,
      steps = ${JSON.stringify(done!.steps.slice(0, 1))}::jsonb, lease_token = 'gone',
      lease_at = now() - interval '1 hour' WHERE id = ${done!.id}`,
    );
    // Before it's picked up again, a teammate turns it off and on again, so it acts as them.
    await apply(
      server,
      base.databaseId,
      [
        { kind: 'automation.update', automationId: id, enabled: false },
        { kind: 'automation.update', automationId: id, enabled: true },
      ],
      creator,
    );
    await engine(server).drain();
    expect(hits).toEqual([]);
    expect((await runRows(server, id))[0]).toMatchObject({
      id: done!.id,
      state: 'failed',
      actor_id: server.owner.userId,
      steps: [
        { stepId: 'log-it', state: 'succeeded' },
        { stepId: 'call-app', state: 'failed', error: { messageKey: 'automations.resume.runAsChanged' } },
      ],
    });
  });

  it('refuses to resume for someone a rule limits on a table the earlier steps read', async () => {
    // The first step reads the trigger's record, in Tasks.
    const { id, runId } = await failedRun();
    await recordRules(base.tasks, ['creator']);
    try {
      const refused = await again(id, runId, 'resume', creator, 'call-app');
      expect(refused.status, refused.body).toBe(422);
      expect(JSON.parse(refused.body)).toMatchObject({ error: { messageKey: 'automations.resume.limited' } });
    } finally {
      await recordRules(base.tasks, []);
    }
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
    // A step that made a record read its table, so a hidden field there counts too.
    const logged = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [
        { id: 'log-it', kind: 'createRecord', tableId: base.log, values: { [base.f.summary]: 'Logged' } },
        { id: 'call-app', kind: 'callWebhook', url: `${receiverUrl}/app`, body: '{}' },
      ],
    });
    answers = [500];
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Log me' }]);
    await engine(server).drain();
    const [failed] = await runRows(server, logged);
    expect(failed).toMatchObject({ state: 'failed' });
    await restrictField(base.f.logNote, true);
    try {
      const refused = await again(logged, failed!.id, 'resume', creator, 'call-app');
      expect(JSON.parse(refused.body)).toMatchObject({ error: { messageKey: 'automations.resume.limited' } });
    } finally {
      await restrictField(base.f.logNote, false);
    }
    // Once no rule limits them, they can.
    answers = [200];
    expect((await again(logged, failed!.id, 'resume', creator, 'call-app')).status).toBe(200);
    await engine(server).drain();
    expect((await runRows(server, logged)).at(-1)).toMatchObject({ state: 'succeeded' });
  });

  it('needs the right to change the automation, and the automation to be on', async () => {
    const { id, runId } = await failedRun();
    for (const who of [editor, reader]) {
      expect((await again(id, runId, 'rerun', who)).status).toBe(403);
      expect((await again(id, runId, 'resume', who, 'call-app')).status).toBe(403);
    }
    const outsider = await server.addMember();
    expect((await again(id, runId, 'rerun', outsider)).status).toBe(404);
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: false }]);
    expect(JSON.parse((await again(id, runId, 'rerun')).body)).toMatchObject({
      error: { messageKey: 'automations.rerun.off' },
    });
    expect((await runRows(server, id)).length).toBe(1);
    // Tests, whole or single-step, are never run again, since they're tests.
    const [recordId] = await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'T' }]);
    answers = [200, 200];
    const tested = await testRun(server, id, { recordId });
    await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: true }]);
    expect(JSON.parse((await again(id, tested.run.id, 'rerun')).body)).toMatchObject({
      error: { messageKey: 'automations.rerun.test' },
    });
  });
});

describe('upgrading', () => {
  it('makes existing automations their published version 1, with no draft', async () => {
    const legacy = await kit.createDatabase('autover_legacy');
    const schemas = { app: 'legacy_app', data: 'legacy_data', audit: 'legacy_audit' };
    const pool = createPool({ ...legacy.profile, schemas });
    try {
      await migrate(
        pool,
        schemas,
        MIGRATIONS.filter(
          (migration) =>
            migration.id !== '0048_automation_versions' && migration.id !== '0081_automation_publication',
        ),
      );
      const orgId = newId('org');
      const databaseId = newId('database');
      const automationId = newId('automation');
      const config = { trigger: { kind: 'webhook' }, conditions: null, steps: [] };
      await query(pool, sql`INSERT INTO ${ident(schemas.app, 'orgs')} (id, name) VALUES (${orgId}, 'Org')`);
      await query(
        pool,
        sql`INSERT INTO ${ident(schemas.app, 'databases')} (id, org_id, name) VALUES (${databaseId}, ${orgId}, 'Db')`,
      );
      await query(
        pool,
        sql`INSERT INTO ${ident(schemas.app, 'automations')}
        (id, org_id, database_id, name, position, enabled, config, webhook_secret_hash, webhook_salt, updated_at)
        VALUES (${automationId}, ${orgId}, ${databaseId}, 'Old', 0, true, ${JSON.stringify(config)}::jsonb,
          ${randomBytes(32).toString('hex')}, ${randomBytes(16).toString('base64url')}, now() - interval '2 days')`,
      );
      await query(
        pool,
        sql`INSERT INTO ${ident(schemas.app, 'automation_runs')}
        (id, automation_id, org_id, database_id, state, trigger_kind)
        VALUES (${newId('job')}, ${automationId}, ${orgId}, ${databaseId}, 'succeeded', 'webhook')`,
      );
      await migrate(pool, schemas, MIGRATIONS);
      const row = await query<AutomationRow>(
        pool,
        sql`SELECT * FROM ${ident(schemas.app, 'automations')} WHERE id = ${automationId}`,
      );
      const upgraded = toAutomation(row.rows[0]!);
      expect(upgraded).toMatchObject({ version: 1, draft: null, enabled: true, config: { steps: [] } });
      expect(upgraded.publishedAt).toBe(upgraded.updatedAt);
      const runs = await query<{ version: number | null; draft: boolean }>(
        pool,
        sql`SELECT version, draft FROM ${ident(schemas.app, 'automation_runs')} WHERE automation_id = ${automationId}`,
      );
      // What an earlier run ran can't be told apart from what's published now, so it has no version.
      expect(runs.rows).toEqual([{ version: null, draft: false }]);
      const kept = await query(pool, sql`SELECT 1 FROM ${ident(schemas.app, 'automation_versions')}`);
      expect(kept.rowCount).toBe(0);
      expect((await migrate(pool, schemas, MIGRATIONS)).applied).toEqual([]);
    } finally {
      await pool.end();
      await legacy.drop();
    }
  });
});

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  newId,
  type AutomationRun,
  type NotificationRecipients,
  type NotificationsPage,
  type AutomationSimulation,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import {
  apply,
  automate,
  createBase,
  createRecords,
  engine,
  grant,
  runsPage,
  testRun,
  type Base,
} from './automations.test-helpers.js';
import { runNotificationCommand } from '../data/commands/notifications.js';
import { actorFor } from './run.js';
import { queueNotificationChannels, deliverableNotifications } from '../data/notification-delivery.js';
import {
  NOTIFICATION_BURST,
  notificationRecipients,
  scopedNotificationContent,
} from '../data/automation-notifications.js';
import { AccessScope } from '../data/access.js';
import { MIGRATIONS } from '../migrations/index.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: Base;
let person: SignedIn;
let recordId: string;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'automationnotify', { automationsPollMs: 0 });
}, 60_000);
beforeEach(async () => {
  server.ctx.notifications?.pause();
  base = await createBase(server);
  person = await server.addMember({ name: 'Notification recipient' });
  await grant(server, base.databaseId, person, 'reader');
  [recordId] = (await createRecords(server, base.databaseId, base.tasks, [
    { [base.f.name]: 'Private task', [base.f.owner]: [person.userId] },
  ])) as [string];
});
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const notification = (recipients: NotificationRecipients, extra: Record<string, unknown> = {}) => ({
  id: 'notify01',
  kind: 'sendNotification',
  recipients,
  title: `Review {{trigger.record.${base.f.name}}}`,
  body: `Assigned {{trigger.record.${base.f.name}}}`,
  ...extra,
});
const automation = (steps: unknown[]) =>
  automate(
    server,
    base.databaseId,
    { trigger: { kind: 'recordCreated', tableId: base.tasks }, steps },
    { enabled: false },
  );
async function notifications(who = person) {
  const response = await server.app.inject({
    method: 'GET',
    url: '/api/notifications',
    headers: who.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response
    .json<NotificationsPage>()
    .notifications.filter((item) => item.kind === 'automationNotification');
}
async function run(step: Record<string, unknown>) {
  const id = await automation([step]);
  const result = await testRun(server, id, { recordId });
  expect(result.status, result.body).toBe(200);
  return { id, run: result.run };
}

it.each(['recipients', 'fields'] as const)('uses the current people scope for %s', async (kind) => {
  const actor = (await actorFor(server.pool, server.schemas, person.userId, person.info.org.id))!;
  const scope = new AccessScope(server.pool, server.schemas, actor);
  if (kind === 'recipients') {
    const people = await notificationRecipients(
      server.pool,
      server.schemas,
      scope,
      newId('automation'),
      { kind: 'people', userIds: [person.userId] },
      null,
    );
    expect(people).toEqual([{ id: person.userId, name: person.info.user.name }]);
  } else {
    const rendered = await scopedNotificationContent(
      server.pool,
      server.schemas,
      scope,
      {
        databaseId: base.databaseId,
        title: '{{owner}}',
        message: '',
        link: '',
        tokens: {
          owner: {
            text: '',
            source: { tableId: base.tasks, recordId, fieldId: base.f.owner, accessKey: '' },
          },
        },
      },
      true,
    );
    expect(rendered.title).toBe(person.info.user.name);
  }
});

it.each(['people', 'group', 'personField', 'recordCreator', 'automationOwner'] as const)(
  'delivers to %s recipients with rendered fields and a record link',
  async (kind) => {
    let recipients: NotificationRecipients;
    let who = person;
    if (kind === 'group') {
      const groupId = newId('group');
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'groups')}(id, org_id, name) VALUES (${groupId}, ${server.owner.info.org.id}, 'Review group')`,
      );
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'group_members')}(org_id, group_id, user_id) VALUES (${server.owner.info.org.id}, ${groupId}, ${person.userId})`,
      );
      recipients = { kind, groupId };
    } else if (kind === 'people') recipients = { kind, userIds: [person.userId, person.userId] };
    else if (kind === 'personField') recipients = { kind, fieldId: base.f.owner };
    else {
      recipients = { kind };
      who = server.owner;
    }
    const result = await run(notification(recipients));
    expect(result.run.state, JSON.stringify(result.run)).toBe('succeeded');
    expect(result.run.steps[0]?.output).toMatchObject({
      recipients: [{ id: who.userId, title: 'Review Private task', message: 'Assigned Private task' }],
    });
    const shown = (await notifications(who)).find((item) => item.target.title === 'Review Private task');
    expect(shown?.target).toMatchObject({
      message: 'Assigned Private task',
      link: `/${base.databaseId}/${base.tasks}/${base.grid}/${recordId}`,
    });
    expect(shown?.target).not.toHaveProperty('automationContent');
  },
);

it('inserts earlier record fields and step outputs without rerunning the earlier steps', async () => {
  const id = await automation([
    {
      id: 'create01',
      kind: 'createRecord',
      tableId: base.log,
      values: { [base.f.logNote]: 'Earlier value' },
    },
    notification(
      { kind: 'people', userIds: [person.userId] },
      { body: `{{steps.create01.record.${base.f.logNote}}}`, title: '{{steps.create01.output.tableId}}' },
    ),
  ]);
  const result = await testRun(server, id, { recordId });
  expect(result.run.state, result.body).toBe('succeeded');
  expect(result.run.steps[1]?.output).toMatchObject({
    recipients: [{ message: 'Earlier value', title: base.log }],
  });
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/steps/notify01/test`,
    headers: server.owner.headers,
    payload: { recordId, preview: true },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ inputs: { recipients: [{ message: 'Earlier value' }] } });
});

it('omits field values and the link for a recipient without record access', async () => {
  await grant(server, base.databaseId, person, null);
  const result = await run(notification({ kind: 'people', userIds: [person.userId] }));
  expect(result.run.state, JSON.stringify(result.run)).toBe('succeeded');
  expect((await notifications())[0]?.target).toEqual({ title: 'Review ', message: 'Assigned ', link: '' });
});

it('omits values and links when a record rule hides the triggering record', async () => {
  const response = await server.app.inject({
    method: 'PUT',
    url: `/api/tables/${base.tasks}/record-rules`,
    headers: server.owner.headers,
    payload: {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['reader'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'visible', fieldId: base.f.name, operator: 'is', value: 'Other task' }],
          },
        },
      ],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect((await run(notification({ kind: 'people', userIds: [person.userId] }))).run.state).toBe('succeeded');
  expect((await notifications())[0]?.target).toEqual({ title: 'Review ', message: 'Assigned ', link: '' });
});

it('rechecks field and record rules before the bell and queued channels read a notification', async () => {
  await run(notification({ kind: 'people', userIds: [person.userId] }));
  const before = (await notifications())[0]!;
  const rule = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${base.f.name}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: [], users: [] }, locked: null },
  });
  expect(rule.statusCode, rule.body).toBe(200);
  const after = (await notifications())[0]!;
  expect(after.target.title).toBe('Review ');
  const actor = (await actorFor(server.pool, server.schemas, person.userId, person.info.org.id))!;
  const queued = await deliverableNotifications(server.pool, server.schemas, actor, [before.id]);
  expect(queued[0]?.target.message).toBe('Assigned ');
  await grant(server, base.databaseId, person, null);
  expect((await notifications())[0]?.target.link).toBe('');
});

it('hides inserted values after their source field is deleted', async () => {
  await apply(server, base.databaseId, [
    {
      kind: 'record.update',
      tableId: base.tasks,
      records: [{ id: recordId, values: { [base.f.note]: 'Private note' } }],
    },
  ]);
  await run(
    notification(
      { kind: 'people', userIds: [person.userId] },
      {
        body: `Note {{trigger.record.${base.f.note}}}`,
      },
    ),
  );
  const before = (await notifications())[0]!;
  expect(before.target.message).toBe('Note Private note');
  await apply(server, base.databaseId, [{ kind: 'field.trash', fieldId: base.f.note }]);
  expect((await notifications())[0]?.target.message).toBe('Note ');
  const actor = (await actorFor(server.pool, server.schemas, person.userId, person.info.org.id))!;
  const queued = await deliverableNotifications(server.pool, server.schemas, actor, [before.id]);
  expect(queued[0]?.target.message).toBe('Note ');
});

it('honors bell, email, push, chat, and digest preferences through the shared pipeline', async () => {
  const actor = (await actorFor(server.pool, server.schemas, person.userId, person.info.org.id))!;
  const preferences = await runNotificationCommand(server.app, actor, {
    id: newId('command'),
    kind: 'notifications.preferences',
    update: {
      channels: {
        bell: { automationNotification: false },
        email: { automationNotification: false },
        push: { automationNotification: false },
        slack: { automationNotification: false },
        teams: { automationNotification: false },
      },
    },
  });
  expect(preferences.status).toBe('applied');
  expect((await run(notification({ kind: 'people', userIds: [person.userId] }))).run.state).toBe('succeeded');
  expect(await notifications()).toEqual([]);
  await queueNotificationChannels(server.ctx);
  const rows = await query<{ email: string; count: number }>(
    server.pool,
    sql`SELECT n.email,
    (SELECT count(*)::int FROM ${ident(server.schemas.app, 'notification_deliveries')} d WHERE d.notification_id = n.id) AS count
    FROM ${ident(server.schemas.app, 'notifications')} n WHERE recipient_id = ${person.userId}`,
  );
  expect(rows.rows).toEqual([{ email: 'none', count: 0 }]);
  await runNotificationCommand(server.app, actor, {
    id: newId('command'),
    kind: 'notifications.preferences',
    update: {
      channels: {
        bell: { automationNotification: true },
        email: { automationNotification: true },
        digest: { automationNotification: true },
      },
      digest: { frequency: 'daily', hour: 9, timeZone: 'UTC' },
    },
  });
  expect((await run(notification({ kind: 'people', userIds: [person.userId] }))).run.state).toBe('succeeded');
  const digest = await query<{ email: string }>(
    server.pool,
    sql`SELECT email FROM ${ident(server.schemas.app, 'notifications')} WHERE recipient_id = ${person.userId}`,
  );
  expect(digest.rows.every((row) => row.email === 'none')).toBe(true);
  expect(await notifications()).toHaveLength(2);
});

it('removes stored linked labels when a related record becomes inaccessible', async () => {
  const ruleId = newId('recordRule');
  const rules = [
    {
      id: ruleId,
      roles: ['reader'],
      users: [],
      condition: {
        conjunction: 'and',
        conditions: [{ id: 'visible', fieldId: base.f.name, operator: 'is', value: 'Private task' }],
      },
    },
  ];
  const rule = await server.app.inject({
    method: 'PUT',
    url: `/api/tables/${base.tasks}/record-rules`,
    headers: server.owner.headers,
    payload: { rules },
  });
  expect(rule.statusCode, rule.body).toBe(200);
  const [logId] = await createRecords(server, base.databaseId, base.log, [{ [base.f.logTask]: [recordId] }]);
  const id = await automate(
    server,
    base.databaseId,
    {
      trigger: { kind: 'recordCreated', tableId: base.log },
      steps: [
        notification(
          { kind: 'people', userIds: [person.userId] },
          {
            title: 'Linked task',
            body: `{{trigger.record.${base.f.logTask}}}`,
          },
        ),
      ],
    },
    { enabled: false },
  );
  const result = await testRun(server, id, { recordId: logId });
  expect(result.run.state).toBe('succeeded');
  expect((await notifications())[0]?.target.message).toBe('Private task');
  await apply(server, base.databaseId, [
    {
      kind: 'record.update',
      tableId: base.tasks,
      records: [{ id: recordId, values: { [base.f.name]: 'Hidden task' } }],
    },
  ]);
  expect((await notifications())[0]?.target.message).toBe('');
});

it.each(['count', 'lookup', 'rollup', 'formula'] as const)(
  'rechecks stored %s values before bell reads and queued delivery when a linked record changes',
  async (kind) => {
    const countId = newId('field');
    const fieldId = kind === 'count' ? countId : newId('field');
    await apply(server, base.databaseId, [
      {
        kind: 'field.create',
        tableId: base.log,
        field: { id: countId, name: 'Linked count', type: 'count', options: { linkFieldId: base.f.logTask } },
      },
      ...(kind === 'count'
        ? []
        : [
            {
              kind: 'field.create',
              tableId: base.log,
              field: {
                id: fieldId,
                name: 'Computed value',
                type: kind,
                options:
                  kind === 'formula'
                    ? { expression: '{Linked count} * 2' }
                    : kind === 'lookup'
                      ? { linkFieldId: base.f.logTask, targetFieldId: base.f.name }
                      : { linkFieldId: base.f.logTask, targetFieldId: base.f.count, fn: 'sum' },
              },
            },
          ]),
      {
        kind: 'record.update',
        tableId: base.tasks,
        records: [{ id: recordId, values: { [base.f.count]: 7 } }],
      },
    ]);
    const rule = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${base.tasks}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['reader'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'visible', fieldId: base.f.name, operator: 'is', value: 'Private task' }],
            },
          },
        ],
      },
    });
    expect(rule.statusCode, rule.body).toBe(200);
    const [logId] = await createRecords(server, base.databaseId, base.log, [
      { [base.f.logTask]: [recordId] },
    ]);
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'recordCreated', tableId: base.log },
        steps: [
          notification(
            { kind: 'people', userIds: [person.userId] },
            {
              title: 'Linked value',
              body: `Value {{trigger.record.${fieldId}}}`,
            },
          ),
        ],
      },
      { enabled: false },
    );
    const result = await testRun(server, id, { recordId: logId });
    expect(result.run.state, result.body).toBe('succeeded');
    const before = (await notifications())[0]!;
    expect(before.target.message).toBe(
      `Value ${kind === 'count' ? '1' : kind === 'formula' ? '2' : kind === 'lookup' ? 'Private task' : '7'}`,
    );
    const actor = (await actorFor(server.pool, server.schemas, person.userId, person.info.org.id))!;
    const previousScope = new AccessScope(server.pool, server.schemas, actor);
    await previousScope.prepare(base.databaseId);
    const fingerprint = await previousScope.fingerprint(base.databaseId);
    await apply(server, base.databaseId, [
      {
        kind: 'record.update',
        tableId: base.tasks,
        records: [{ id: recordId, values: { [base.f.name]: 'Hidden task' } }],
      },
    ]);
    const currentScope = new AccessScope(server.pool, server.schemas, actor);
    await currentScope.prepare(base.databaseId);
    expect(await currentScope.fingerprint(base.databaseId)).toBe(fingerprint);
    expect((await notifications())[0]?.target.message).toBe('Value ');
    const queued = await deliverableNotifications(server.pool, server.schemas, actor, [before.id]);
    expect(queued[0]?.target.message).toBe('Value ');
  },
);

it.each(['..', '%2e%2e', '.%2e', '%2e.'])(
  'checks relative record links after normalizing %s dot segments',
  async (segment) => {
    const link = `/settings/${segment}/${base.databaseId}/${base.tasks}/${base.grid}/${recordId}?from=notification#record`;
    const render = async (scope: AccessScope) =>
      scopedNotificationContent(server.pool, server.schemas, scope, {
        databaseId: base.databaseId,
        title: 'Review',
        message: '',
        link,
        tokens: {},
      });
    const actor = (await actorFor(server.pool, server.schemas, person.userId, person.info.org.id))!;
    const allowed = await render(new AccessScope(server.pool, server.schemas, actor));
    expect(allowed.link).toBe(
      `/${base.databaseId}/${base.tasks}/${base.grid}/${recordId}?from=notification#record`,
    );
    const rule = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${base.tasks}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['reader'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'visible', fieldId: base.f.name, operator: 'is', value: 'Other task' }],
            },
          },
        ],
      },
    });
    expect(rule.statusCode, rule.body).toBe(200);
    expect((await render(new AccessScope(server.pool, server.schemas, actor))).link).toBe('');
    await grant(server, base.databaseId, person, null);
    expect((await render(new AccessScope(server.pool, server.schemas, actor))).link).toBe('');
  },
);

it('removes stored values when the recipient access rules change without hiding the source', async () => {
  const ruleId = newId('recordRule');
  for (const conditionId of ['visible-before', 'visible-after']) {
    const response = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${base.tasks}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: ruleId,
            roles: ['reader'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: conditionId, fieldId: base.f.name, operator: 'is', value: 'Private task' }],
            },
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    if (!(await notifications()).length)
      await run(notification({ kind: 'people', userIds: [person.userId] }));
  }
  expect((await notifications())[0]?.target.title).toBe('Review ');
});

it.each(['empty', 'deleted'] as const)(
  'reports an %s recipient failure without delivering any notification',
  async (failure) => {
    const step = notification({
      kind: 'people',
      userIds: failure === 'empty' ? [] : [person.userId, newId('user')],
    });
    const result = await run(step);
    expect(result.run.state).toBe('failed');
    expect(result.run.steps[0]?.error?.messageKey).toBe(
      failure === 'empty'
        ? 'automations.notification.noRecipients'
        : 'automations.notification.personDeleted',
    );
    expect(await notifications()).toHaveLength(0);
  },
);

it('bounds bursts across concurrent runs and reports the excess as a step failure', async () => {
  const id = await automation([notification({ kind: 'people', userIds: [person.userId] })]);
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'notifications')}(id, org_id, recipient_id, kind, subject_id, target)
    SELECT 'ntf' || lpad(n::text, 14, '0'), ${person.info.org.id}, ${person.userId}, 'automationNotification', ${id}, '{}'
    FROM generate_series(1, ${NOTIFICATION_BURST - 1}) AS n`,
  );
  const results = await Promise.all([testRun(server, id, { recordId }), testRun(server, id, { recordId })]);
  expect(results.map((result) => result.run.state).sort()).toEqual(['failed', 'succeeded']);
  expect(results.find((result) => result.run.state === 'failed')?.run.steps[0]?.error?.detail).toBe(
    'automations.notification.burst',
  );
  const count = await query<{ count: number }>(
    server.pool,
    sql`SELECT count(*)::int AS count FROM ${ident(server.schemas.app, 'notifications')} WHERE recipient_id = ${person.userId}`,
  );
  expect(count.rows[0]?.count).toBe(NOTIFICATION_BURST);
});

it('previews, simulates, tests, and executes the same recipients and message', async () => {
  const id = await automation([notification({ kind: 'people', userIds: [person.userId] })]);
  const preview = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/steps/notify01/test`,
    headers: server.owner.headers,
    payload: { recordId, preview: true },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  expect(preview.json()).toMatchObject({
    inputs: { recipients: [{ id: person.userId, title: 'Review Private task' }] },
  });
  expect(await notifications()).toHaveLength(0);
  const simulation = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/simulate`,
    headers: server.owner.headers,
    payload: { recordId },
  });
  expect(simulation.statusCode, simulation.body).toBe(200);
  expect(simulation.json<AutomationSimulation>().steps[0]?.sends[0]).toMatchObject({
    kind: 'notification',
    recipients: [{ id: person.userId, message: 'Assigned Private task' }],
  });
  expect(await notifications()).toHaveLength(0);
  const tested = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/steps/notify01/test`,
    headers: server.owner.headers,
    payload: { recordId, confirm: true },
  });
  expect(tested.statusCode, tested.body).toBe(200);
  expect(tested.json<AutomationRun>().state).toBe('succeeded');
  await apply(server, base.databaseId, [{ kind: 'automation.update', automationId: id, enabled: true }]);
  await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Live record' }]);
  await engine(server).drain();
  expect(
    (await runsPage(server, id)).page.runs.some((item) => !item.test && item.state === 'succeeded'),
  ).toBe(true);
  expect((await notifications()).some((item) => item.target.title === 'Review Live record')).toBe(true);
});

it('audits the send, rejects direct client sends, and removes the bell notification on undo', async () => {
  const result = await run(notification({ kind: 'people', userIds: [person.userId] }));
  const change = await query<{ group_id: string; body: unknown; prev: unknown }>(
    server.pool,
    sql`SELECT group_id, body, prev FROM ${ident(server.schemas.app, 'changes')}
    WHERE database_id = ${base.databaseId} AND body ->> 'kind' = 'automation.notified'`,
  );
  expect(change.rows).toHaveLength(1);
  expect(JSON.stringify(change.rows[0]?.body)).not.toContain('Private task');
  const audit = await query(
    server.pool,
    sql`SELECT 1 FROM ${ident(server.schemas.audit, 'events')} WHERE metadata ->> 'runId' = ${result.run.id}`,
  );
  expect(audit.rowCount).toBeGreaterThan(0);
  const denied = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${base.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'automation.notify',
          automationId: result.id,
          subjectId: newId('command'),
          notifications: [
            {
              recipientId: person.userId,
              content: { databaseId: base.databaseId, title: 'Forged', message: '', link: '', tokens: {} },
            },
          ],
        },
      ],
    },
  });
  expect(denied.json().results[0]).toMatchObject({ status: 'rejected', error: { code: 'forbidden' } });
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${base.databaseId}/undo`,
    headers: server.owner.headers,
    payload: { commandId: newId('command'), clientId: newId('client'), groupId: change.rows[0]!.group_id },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  expect(await notifications()).toHaveLength(0);
});

it('adds the notification kind in its own migration, in PostgreSQL 14 syntax, and leaves shipped migrations alone', () => {
  const sqlOf = (id: string) => MIGRATIONS.find((item) => item.id === id)!.sql;
  const added = sqlOf('0126_automation_notifications');
  expect(added).toContain("'automationNotification'");
  expect(added).toContain("'vaultUnavailable'");
  expect(added).not.toMatch(/NULLS NOT DISTINCT|SET NULL\s*\(|MERGE INTO/);
  // Existing databases record these two as they shipped, and refuse to start if their text changes.
  for (const id of ['0083_automation_steps', '0088_notification_vault_kind']) {
    expect(sqlOf(id)).toContain("'vaultUnavailable'");
    expect(sqlOf(id)).not.toContain("'automationNotification'");
  }
});

it('undoes a notification after its recipient leaves', async () => {
  await run(notification({ kind: 'people', userIds: [person.userId] }));
  const change = await query<{ group_id: string }>(
    server.pool,
    sql`SELECT group_id FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${base.databaseId} AND body ->> 'kind' = 'automation.notified'`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'users')}
    SET deactivated_at = statement_timestamp() WHERE id = ${person.userId}`,
  );
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${base.databaseId}/undo`,
    headers: server.owner.headers,
    payload: { commandId: newId('command'), clientId: newId('client'), groupId: change.rows[0]!.group_id },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  expect(undo.json()).toMatchObject({ status: 'applied' });
  const remaining = await query(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'notifications')}
    WHERE recipient_id = ${person.userId} AND kind = 'automationNotification'`,
  );
  expect(remaining.rowCount).toBe(0);
});

it('records empty recipients as a failure in a confirmed single-step test', async () => {
  const id = await automation([notification({ kind: 'people', userIds: [] })]);
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/automations/${id}/steps/notify01/test`,
    headers: server.owner.headers,
    payload: { recordId, confirm: true },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<AutomationRun>()).toMatchObject({
    state: 'failed',
    steps: [{ error: { messageKey: 'automations.notification.noRecipients' } }],
  });
});

it('redacts derived outputs when a recipient cannot read their source database', async () => {
  await grant(server, base.databaseId, person, null);
  const id = await automation([
    {
      id: 'script01',
      kind: 'script',
      input: { secret: `{{trigger.record.${base.f.name}}}` },
      script: 'await output({ secret: input.secret })',
    },
    notification({ kind: 'people', userIds: [person.userId] }, { title: '{{steps.script01.output.secret}}' }),
  ]);
  const result = await testRun(server, id, { recordId });
  expect(result.run.state, result.body).toBe('succeeded');
  expect((await notifications())[0]?.target).toEqual({ title: '', message: 'Assigned ', link: '' });
});

it('supports omitted and custom links, and reports invalid schemes in the run', async () => {
  const step = notification({ kind: 'people', userIds: [person.userId] }, { link: { kind: 'none' } });
  expect((await run(step)).run.state).toBe('succeeded');
  expect((await notifications())[0]?.target.link).toBe('');
  expect((await run({ ...step, link: { kind: 'custom', url: '/settings/notifications' } })).run.state).toBe(
    'succeeded',
  );
  expect((await notifications())[0]?.target.link).toBe('/settings/notifications');
  const invalid = await run({ ...step, link: { kind: 'custom', url: 'javascript:alert(1)' } });
  expect(invalid.run.state).toBe('failed');
  expect(invalid.run.steps[0]?.error?.messageKey).toBe('automations.notification.linkInvalid');
});

it('reports text that grows past the notification limit after values are inserted', async () => {
  await apply(server, base.databaseId, [
    {
      kind: 'record.update',
      tableId: base.tasks,
      records: [{ id: recordId, values: { [base.f.note]: 'x'.repeat(6000) } }],
    },
  ]);
  const result = await run(
    notification(
      { kind: 'people', userIds: [person.userId] },
      {
        body: `{{trigger.record.${base.f.note}}}{{trigger.record.${base.f.note}}}`,
      },
    ),
  );
  expect(result.run.state).toBe('failed');
  expect(result.run.steps[0]?.error?.messageKey).toBe('errors.tooLarge');
  expect(await notifications()).toHaveLength(0);
});

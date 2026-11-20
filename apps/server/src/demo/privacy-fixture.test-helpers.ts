import { randomBytes } from 'node:crypto';
import { AutomationConfig, flattenAutomationSteps, newId } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { ServerFixture, SignedIn } from '../test/fixture.js';
import type { readFixture } from '../data/snapshots.test-helpers.js';

type Fixture = Awaited<ReturnType<typeof readFixture>>;

/** Each planted value identifies one field, so a leak names the missing privacy decision. */
export async function plantPrivateConfiguration(server: ServerFixture, read: Fixture, member: SignedIn) {
  const privateMarkers = new Map<string, string>();
  const publicMarkers = new Map<string, string>();
  const prefix = `privacy${randomBytes(10).toString('hex')}`;
  const marker = (path: string, publicDisplay = false): string => {
    const value = `${prefix}${String(privateMarkers.size + publicMarkers.size).padStart(6, '0')}z`;
    (publicDisplay ? publicMarkers : privateMarkers).set(value, path);
    return value;
  };
  const address = (path: string) => `${marker(path)}@${randomBytes(8).toString('hex')}.test`;
  const orgId = member.info.org.id;
  const databaseId = read.table.databaseId;
  const insert = async (table: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    const values = Object.values(row).map((value) =>
      value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
        ? JSON.stringify(value)
        : value,
    );
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}"."${table}" (${keys.map((key) => `"${key}"`).join(', ')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(', ')})`,
      values,
    );
  };
  const guest = await server.addMember({ kind: 'guest', name: marker('guest.name') });
  const people = await server.pool.query<{ id: string }>(`SELECT id FROM "${server.schemas.app}".users`);
  for (const person of people.rows) {
    const email = address(`people.${person.id}.email`);
    await server.pool.query(
      `UPDATE "${server.schemas.app}".users SET email = $1, name = name || ' ' || $2 WHERE id = $3`,
      [email, marker(`people.${person.id}.name`, person.id === member.userId), person.id],
    );
    if (person.id === member.userId) member.email = email;
  }
  await server.pool.query(`UPDATE "${server.schemas.app}".users SET preferences = $1 WHERE id = $2`, [
    {
      theme: 'palette',
      scheme: 'house',
      level: 'advanced',
      recordLayout: 'panel',
      mode: 'dark',
      locale: 'en-US',
      privateSetting: marker('preferences.privateSetting'),
    },
    member.userId,
  ]);
  await insert('groups', { id: newId('group'), org_id: orgId, name: marker('groups.name') });
  await insert('rio_routines', {
    id: newId('routine'),
    org_id: orgId,
    database_id: databaseId,
    owner_id: member.userId,
    name: marker('routines.name'),
    instructions: marker('routines.instructions'),
    plan: {
      steps: [
        { kind: 'email', to: [address('routines.plan.steps.to')], body: marker('routines.plan.steps.body') },
      ],
    },
    schedule: { kind: 'daily', at: marker('routines.schedule.at') },
    time_zone: marker('routines.timeZone'),
    locale: marker('routines.locale'),
    cost_cap_usd: 1,
    approved_recipients: JSON.stringify([address('routines.approvedRecipients')]),
    paused_at: new Date(),
    paused_reason: marker('routines.pausedReason'),
  });
  await insert('webhooks', {
    id: newId('webhook'),
    org_id: orgId,
    database_id: databaseId,
    enabled: false,
    url: `https://${marker('webhooks.url')}.invalid`,
    events: ['record.created'],
    secret: marker('webhooks.secret'),
    previous_secret: marker('webhooks.previousSecret'),
    disabled_reason: marker('webhooks.disabledReason'),
  });
  await insert('outbound_syncs', {
    id: newId('outboundSync'),
    org_id: orgId,
    database_id: databaseId,
    table_id: read.table.id,
    view_id: read.view.id,
    created_by: member.userId,
    name: marker('syncs.name'),
    kind: 'airtable',
    destination: {
      baseId: marker('syncs.destination.baseId'),
      tableId: marker('syncs.destination.tableId'),
      address: marker('syncs.destination.address'),
      name: marker('syncs.destination.name'),
    },
    settings: { timeZone: marker('syncs.settings.timeZone'), locale: marker('syncs.settings.locale') },
    sealed_credential: marker('syncs.credential'),
    key_column_id: marker('syncs.keyColumnId'),
    mapping: JSON.stringify([
      { name: marker('syncs.mapping.name'), columnId: marker('syncs.mapping.columnId') },
    ]),
    enabled: false,
    status: { error: { detail: marker('syncs.status.error.detail') } },
  });
  const reportId = newId('report');
  await insert('report_schedules', {
    id: reportId,
    org_id: orgId,
    database_id: databaseId,
    table_id: read.table.id,
    view_id: read.view.id,
    owner_id: member.userId,
    name: marker('reports.name'),
    format: 'none',
    enabled: false,
    frequency: { kind: 'daily', at: marker('reports.frequency.at') },
    time_zone: marker('reports.timeZone'),
    locale: marker('reports.locale'),
    stopped_because: marker('reports.stoppedBecause'),
  });
  await insert('report_recipients', {
    report_id: reportId,
    position: 0,
    address: address('reports.recipients.address'),
  });
  await insert('notifications', {
    id: newId('notification'),
    org_id: orgId,
    recipient_id: member.userId,
    kind: 'routineReport',
    subject_id: databaseId,
    target: {
      databaseName: marker('notifications.target.databaseName'),
      routineSent: [address('notifications.target.routineSent')],
      contact: marker('notifications.target.contact'),
    },
  });
  await insert('api_tokens', {
    id: newId('token'),
    org_id: orgId,
    user_id: member.userId,
    name: marker('tokens.name'),
    scopes: ['data.records:read'],
    secret_hash: randomBytes(32).toString('hex'),
  });
  await insert('sql_logins', {
    database_id: databaseId,
    person_id: member.userId,
    enabled_by: server.owner.userId,
    role_name: marker('logins.roleName'),
    schema_name: marker('logins.schemaName'),
    verifier: marker('logins.verifier'),
    sealed_password: marker('logins.password'),
  });
  const sourceRows = await server.pool.query<{ id: string; connection: Record<string, unknown> }>(
    `SELECT id, connection FROM "${server.schemas.app}".sources`,
  );
  for (const row of sourceRows.rows) {
    const port = 50000 + (randomBytes(2).readUInt16BE() % 10000);
    privateMarkers.set(String(port), 'fixture.sources.connection.port');
    await server.pool.query(
      `UPDATE "${server.schemas.app}".sources SET description = $1, connection = $2 WHERE id = $3`,
      [
        marker('fixture.sources.description'),
        {
          ...row.connection,
          host: `${marker('fixture.sources.connection.host')}.invalid`,
          port,
          user: marker('fixture.sources.connection.user'),
          database: marker('fixture.sources.connection.database'),
          ssh: {
            host: marker('fixture.sources.connection.ssh.host'),
            user: marker('fixture.sources.connection.ssh.user'),
          },
        },
        row.id,
      ],
    );
  }
  await insert('scripts', {
    id: newId('script'),
    org_id: orgId,
    database_id: databaseId,
    name: marker('scripts.name', true),
    description: marker('scripts.description', true),
    source: marker('scripts.source'),
    position: 0,
  });
  await insert('shared_views', {
    id: randomBytes(11).toString('hex'),
    org_id: orgId,
    database_id: databaseId,
    view_id: read.view.id,
    settings: { address: marker('sharing.settings.address'), contact: address('sharing.settings.contact') },
    password_hash: marker('sharing.passwordHash'),
    created_by: member.userId,
  });
  await insert('public_forms', {
    id: randomBytes(11).toString('hex'),
    org_id: orgId,
    database_id: databaseId,
    view_id: read.view.id,
    created_by: member.userId,
  });
  await server.pool.query(
    `UPDATE "${server.schemas.app}".fields SET options = options || $1::jsonb WHERE id = $2`,
    [
      {
        defaultValue: { kind: 'value', value: marker('fields.options.defaultValue.value') },
        validation: { required: { message: marker('fields.options.validation.required.message') } },
      },
      read.fields[0]!.id,
    ],
  );
  const step = (kind: string, settings: Record<string, unknown>) => ({
    id: newId('action'),
    name: marker(`automations.steps.${kind}.name`, true),
    kind,
    ...settings,
  });
  const input = (kind: string, key: string) => marker(`automations.steps.${kind}.${key}`);
  const email = () =>
    step('sendEmail', {
      to: [address('automations.steps.sendEmail.to')],
      subject: input('sendEmail', 'subject'),
      body: input('sendEmail', 'body'),
    });
  const steps = [
    email(),
    step('callWebhook', {
      url: `https://${input('callWebhook', 'url')}.invalid`,
      method: 'POST',
      headers: { authorization: input('callWebhook', 'headers.authorization') },
      body: input('callWebhook', 'body'),
    }),
    step('script', {
      script: input('script', 'script'),
      input: { parameter: input('script', 'input.parameter') },
    }),
    ...['slack', 'teams', 'discord'].map((kind) =>
      step(kind, { webhookUrl: input(kind, 'webhookUrl'), body: input(kind, 'body') }),
    ),
    step('studioFlow', {
      webhookUrl: input('studioFlow', 'webhookUrl'),
      body: input('studioFlow', 'body'),
      title: input('studioFlow', 'title'),
      recipient: input('studioFlow', 'recipient'),
      recordUrl: input('studioFlow', 'recordUrl'),
    }),
    step('sms', {
      accountSid: `AC${randomBytes(16).toString('hex')}`,
      authToken: input('sms', 'authToken'),
      from: `+1${String(randomBytes(4).readUInt32BE()).padStart(10, '0')}`,
      to: input('sms', 'to'),
      body: input('sms', 'body'),
    }),
    step('askAi', { prompt: input('askAi', 'prompt') }),
    step('createCalendarEvent', {
      provider: 'google-calendar',
      calendarId: input('createCalendarEvent', 'calendarId'),
      title: input('createCalendarEvent', 'title'),
      description: input('createCalendarEvent', 'description'),
      start: input('createCalendarEvent', 'start'),
      end: input('createCalendarEvent', 'end'),
    }),
    step('sendNotification', {
      recipients: { kind: 'people', userIds: [guest.userId] },
      title: input('sendNotification', 'title'),
      body: input('sendNotification', 'body'),
      link: { kind: 'custom', url: input('sendNotification', 'link.url') },
    }),
    step('generateDocument', {
      tableId: read.table.id,
      record: 'trigger',
      templateFieldId: '',
      attachmentFieldId: '',
      format: 'pdf',
      filename: input('generateDocument', 'filename'),
      values: { parameter: input('generateDocument', 'values.parameter') },
    }),
    step('findRecords', { tableId: read.table.id }),
    step('createRecord', {
      tableId: read.table.id,
      values: { [read.fields[0]!.id]: input('createRecord', 'values.field') },
    }),
    step('updateRecord', {
      tableId: read.table.id,
      record: 'trigger',
      values: { [read.fields[0]!.id]: input('updateRecord', 'values.field') },
      baseValues: { [read.fields[0]!.id]: input('updateRecord', 'baseValues.field') },
    }),
    step('if', { conditions: null, then: [email()], otherwise: [email()] }),
    step('repeat', { list: input('repeat', 'list'), steps: [email()] }),
    step('switch', {
      value: input('switch', 'value'),
      cases: [{ id: newId('action'), value: input('switch', 'cases.value'), steps: [email()] }],
      otherwise: [email()],
    }),
    step('wait', {
      mode: 'date',
      seconds: 1,
      date: input('wait', 'date'),
      conditions: null,
      timeoutSeconds: 1,
    }),
  ];
  AutomationConfig.parse({ trigger: { kind: 'webhook' }, steps });
  const stepKinds = new Set(
    flattenAutomationSteps(AutomationConfig.parse({ trigger: { kind: 'webhook' }, steps }).steps).map(
      (item) => item.kind,
    ),
  );
  await insert('automations', {
    id: newId('automation'),
    org_id: orgId,
    database_id: databaseId,
    name: marker('automations.name', true),
    position: 1,
    enabled: false,
    config: {
      trigger: { kind: 'webhook' },
      steps,
      notes: [{ id: newId('action'), text: marker('automations.notes.text'), x: 0, y: 0 }],
    },
    webhook_secret_hash: randomBytes(32).toString('hex'),
    webhook_salt: randomBytes(16).toString('hex'),
  });
  await server.pool.query(
    `UPDATE "${server.schemas.app}".orgs SET settings = settings || $1::jsonb WHERE id = $2`,
    [
      {
        defaultTheme: {
          theme: 'palette',
          scheme: 'house',
          mode: 'dark',
          unreviewedSetting: marker('organization.defaultTheme.unreviewedSetting'),
        },
        unreviewedSetting: marker('organization.unreviewedSetting'),
        fileSafety: {
          outsideFiles: marker('organization.fileSafety.outsideFiles'),
          allowOutsideMacros: marker('organization.fileSafety.allowOutsideMacros'),
        },
        fileScannerSelfTest: {
          address: marker('organization.fileScannerSelfTest.address'),
          tested: marker('organization.fileScannerSelfTest.tested'),
        },
      },
      orgId,
    ],
  );
  await server.pool.query(
    `UPDATE "${server.schemas.app}".databases SET settings = settings || $1::jsonb WHERE id = $2`,
    [
      {
        theme: { id: 'palette', scheme: 'house' },
        navigation: {
          folders: [
            {
              id: 'folder001',
              name: marker('navigation.folders.name', true),
              section: 'table',
              parentId: null,
              position: 0,
            },
          ],
          parents: {
            [read.table.id]: 'folder001',
            unreviewedSetting: marker('navigation.parents.unreviewedSetting'),
          },
        },
      },
      databaseId,
    ],
  );
  await server.pool.query(
    `UPDATE "${server.schemas.app}".views SET config = config || $1::jsonb WHERE id = $2`,
    [
      {
        form: {
          title: marker('form.title', true),
          description: marker('form.description', true),
          submitLabel: marker('form.submitLabel', true),
          thankYou: marker('form.thankYou', true),
          questions: [
            {
              fieldId: read.fields[0]!.id,
              label: marker('form.questions.label', true),
              help: marker('form.questions.help', true),
              showIf: null,
            },
          ],
        },
      },
      read.view.id,
    ],
  );
  const interfaces = await server.pool.query<{ id: string; pages: Array<{ blocks: unknown[] }> }>(
    `SELECT id, pages FROM "${server.schemas.app}".interfaces`,
  );
  for (const item of interfaces.rows) {
    item.pages[0]!.blocks.push({
      id: 'code001',
      kind: 'code',
      title: marker('interfaces.code.title', true),
      place: { x: 0, y: 5, w: 6, h: 2 },
      html: marker('interfaces.code.html'),
      css: marker('interfaces.code.css'),
      javascript: marker('interfaces.code.javascript'),
    });
    await server.pool.query(`UPDATE "${server.schemas.app}".interfaces SET pages = $1 WHERE id = $2`, [
      JSON.stringify(item.pages),
      item.id,
    ]);
    await server.pool.query(
      `UPDATE "${server.schemas.app}".published_sites SET pages = $1 WHERE interface_id = $2`,
      [JSON.stringify(item.pages), item.id],
    );
  }
  const statuses = await server.pool.query<{
    table_id: string;
    settings: Record<string, unknown>;
    status: { error: { detail: string; params: Record<string, unknown> } };
  }>(`SELECT table_id, settings, status FROM "${server.schemas.app}".table_sources`);
  for (const item of statuses.rows) {
    item.status.error.detail += ` ${marker('fixture.sources.status.error.detail')}`;
    item.status.error.params = { object: marker('fixture.sources.status.error.params.object') };
    item.settings.keyColumns = [marker('fixture.sources.settings.keyColumns')];
    await server.pool.query(
      `UPDATE "${server.schemas.app}".table_sources SET settings = $1, status = $2 WHERE table_id = $3`,
      [item.settings, item.status, item.table_id],
    );
  }
  for (const table of ['databases', 'tables', 'fields', 'scripts', 'sources']) {
    const rows = await server.pool.query<{ id: string; database_id?: string; table_id?: string }>(
      `SELECT * FROM "${server.schemas.app}"."${table}"`,
    );
    for (const row of rows.rows) {
      const visible =
        table === 'databases'
          ? row.id === databaseId
          : table === 'tables'
            ? row.id === read.table.id
            : table === 'fields'
              ? row.table_id === read.table.id
              : table === 'scripts';
      await server.pool.query(
        `UPDATE "${server.schemas.app}"."${table}" SET description = $1 WHERE id = $2`,
        [marker(`${table}.description`, visible), row.id],
      );
    }
  }
  // A declared display name is public only inside the database the visitor can already read.
  for (const table of ['databases', 'tables', 'fields', 'views', 'dashboards', 'interfaces', 'automations']) {
    const rows = await query<{ id: string; database_id?: string; table_id?: string }>(
      server.pool,
      sql`SELECT * FROM ${ident(server.schemas.app, table)}`,
    );
    for (const row of rows.rows) {
      const publicDisplay =
        table === 'databases'
          ? row.id === databaseId
          : table === 'tables'
            ? row.id === read.table.id
            : table === 'fields' || table === 'views'
              ? row.table_id === read.table.id
              : row.database_id === databaseId;
      await server.pool.query(
        `UPDATE "${server.schemas.app}"."${table}" SET name = name || ' ' || $1 WHERE id = $2`,
        [marker(`${table}.${row.id}.name`, publicDisplay), row.id],
      );
    }
  }
  return { privateMarkers, publicMarkers, marker, address, stepKinds };
}

/** Stored JSON gets an unrecognized field at every level, in addition to its known private inputs. */
export function plantUnreviewedFields(value: unknown, marker: (path: string) => string, path = ''): unknown {
  if (Array.isArray(value))
    return value.map((item, index) => plantUnreviewedFields(item, marker, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  if (/\.(?:headerColors|columnWidths|summaries|mapping|values|baseValues)$/.test(path)) return value;
  return {
    ...Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        plantUnreviewedFields(item, marker, `${path}.${key}`),
      ]),
    ),
    unreviewedSetting: marker(`${path}.unreviewedSetting`),
  };
}

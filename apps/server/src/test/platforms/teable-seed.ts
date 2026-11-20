import { PIXEL } from './harness.js';

/**
 * A Teable base with every kind of field Teable's API can make, for the live import suite:
 * projects, tasks, and people, linked both ways, with lookups, rollups, formulas, attachments, and
 * views of every kind.  `removeTeableBase` deletes it again.  What it makes is what the recording
 * the unit tests replay holds, so one set of checks covers both.
 */

export interface TeableSeed {
  baseId: string;
  name: string;
}

interface Named {
  id: string;
  name: string;
}

interface Signature {
  url: string;
  uploadMethod: string;
  token: string;
  requestHeaders: Record<string, string>;
}

function client(url: string, token: string) {
  const base = url.replace(/\/+$/, '');
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Teable answered ${response.status} to ${method} ${path}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  return { base, call };
}

/** The IDs of a table's fields, by name, once they've been made. */
async function fieldsOf(url: string, token: string, tableId: string): Promise<Record<string, string>> {
  const { call } = client(url, token);
  const fields = await call<Named[]>('GET', `/api/table/${tableId}/field`);
  return Object.fromEntries(fields.map((field) => [field.name, field.id]));
}

export async function seedTeable(url: string, token: string): Promise<TeableSeed> {
  const { base, call } = client(url, token);
  const name = `Riosoma import ${Date.now().toString(36)}`;
  const spaces = await call<Named[]>('GET', '/api/space');
  const spaceId = spaces[0]?.id ?? (await call<Named>('POST', '/api/space', { name })).id;
  const baseId = (await call<Named>('POST', '/api/base', { spaceId, name })).id;

  // A base comes with a table of its own, which these three replace, so nothing extra is imported.
  const started = await call<Named[]>('GET', `/api/base/${baseId}/table`);
  const make = (tableName: string, primary: string) =>
    call<Named>('POST', `/api/base/${baseId}/table`, {
      name: tableName,
      fields: [{ name: primary, type: 'singleLineText' }],
      records: [],
      views: [{ name: tableName, type: 'grid' }],
    });
  const projects = (await make('Projects', 'Title')).id;
  const tasks = (await make('Tasks', 'Name')).id;
  const people = (await make('People', 'Name')).id;
  for (const table of started) await call('DELETE', `/api/base/${baseId}/table/${table.id}`);

  const add = (tableId: string, field: Record<string, unknown>) =>
    call<Named>('POST', `/api/table/${tableId}/field`, field);
  const day = { date: 'YYYY-MM-DD', time: 'None', timeZone: 'UTC' };
  const minute = { date: 'YYYY-MM-DD', time: 'HH:mm', timeZone: 'Europe/Berlin' };
  for (const field of [
    { name: 'Id', type: 'autoNumber' },
    { name: 'Notes', type: 'longText' },
    { name: 'Brief', type: 'longText', options: { showAs: { type: 'markdown' } } },
    { name: 'Site', type: 'singleLineText', options: { showAs: { type: 'url' } } },
    { name: 'Contact', type: 'singleLineText', options: { showAs: { type: 'email' } } },
    { name: 'Phone', type: 'singleLineText', options: { showAs: { type: 'phone' } } },
    { name: 'Count', type: 'number', options: { formatting: { type: 'decimal', precision: 0 } } },
    { name: 'Weight', type: 'number', options: { formatting: { type: 'decimal', precision: 2 } } },
    {
      name: 'Budget',
      type: 'number',
      options: { formatting: { type: 'currency', precision: 2, symbol: '$' } },
    },
    { name: 'Share', type: 'number', options: { formatting: { type: 'percent', precision: 0 } } },
    { name: 'Score', type: 'rating', options: { icon: 'star', color: 'yellowBright', max: 5 } },
    { name: 'Effort', type: 'rating', options: { icon: 'flame', color: 'redBright', max: 5 } },
    { name: 'Active', type: 'checkbox' },
    { name: 'Start', type: 'date', options: { formatting: day } },
    { name: 'Due', type: 'date', options: { formatting: minute } },
    { name: 'Made', type: 'createdTime', options: { formatting: { ...minute, timeZone: 'UTC' } } },
    { name: 'Changed', type: 'lastModifiedTime', options: { formatting: { ...minute, timeZone: 'UTC' } } },
    { name: 'Author', type: 'createdBy' },
    { name: 'Owner', type: 'user', options: { isMultiple: false } },
    { name: 'Team', type: 'user', options: { isMultiple: true } },
    {
      name: 'Status',
      type: 'singleSelect',
      options: {
        choices: [
          { name: 'Todo', color: 'blueBright' },
          { name: 'Doing', color: 'cyanBright' },
          { name: 'Done', color: 'greenBright' },
        ],
      },
    },
    {
      name: 'Tags',
      type: 'multipleSelect',
      options: {
        choices: [
          { name: 'Web', color: 'purpleBright' },
          { name: 'Mobile', color: 'pinkBright' },
        ],
      },
    },
    { name: 'Files', type: 'attachment' },
    {
      name: 'Progress',
      type: 'number',
      options: {
        formatting: { type: 'decimal', precision: 0 },
        showAs: { type: 'bar', color: 'greenBright', showValue: true, maxValue: 100 },
      },
    },
  ])
    await add(projects, field);
  await add(tasks, { name: 'Id', type: 'autoNumber' });
  await add(tasks, {
    name: 'Hours',
    type: 'number',
    options: { formatting: { type: 'decimal', precision: 1 } },
  });
  await add(people, { name: 'Id', type: 'autoNumber' });
  await add(people, { name: 'Email', type: 'singleLineText', options: { showAs: { type: 'email' } } });

  // Links, which Teable pairs with a field of its own on the other table.
  const linkTasks = await add(projects, {
    name: 'Tasks',
    type: 'link',
    options: { relationship: 'oneMany', foreignTableId: tasks },
  });
  await add(tasks, {
    name: 'People',
    type: 'link',
    options: { relationship: 'manyMany', foreignTableId: people },
  });
  const own = await fieldsOf(url, token, projects);
  const theirs = await fieldsOf(url, token, tasks);
  own.Tasks = linkTasks.id;
  await add(projects, {
    name: 'Task names',
    type: 'singleLineText',
    isLookup: true,
    lookupOptions: {
      linkFieldId: own.Tasks,
      lookupFieldId: theirs.Name,
      foreignTableId: tasks,
      relationship: 'oneMany',
    },
  });
  await add(projects, {
    name: 'Hours',
    type: 'rollup',
    options: { expression: 'sum({values})' },
    lookupOptions: {
      linkFieldId: own.Tasks,
      lookupFieldId: theirs.Hours,
      foreignTableId: tasks,
      relationship: 'oneMany',
    },
  });
  await add(projects, {
    name: 'Summary',
    type: 'formula',
    options: { expression: `CONCATENATE({${own.Title}}, " (", {${own.Status}}, ")")` },
  });
  await add(projects, {
    name: 'Double',
    type: 'formula',
    options: { expression: `{${own.Budget}} * 2`, formatting: { type: 'decimal', precision: 2 } },
  });
  await add(projects, {
    name: 'Ago',
    type: 'formula',
    options: { expression: `FROMNOW({${own.Due}})` },
  });
  await add(projects, { name: 'Ref', type: 'button', options: { label: 'Open', color: 'blueBright' } });
  const fields = await fieldsOf(url, token, projects);

  // Files Teable stores itself, attached through the signature, upload, and notify steps.
  const upload = async (filename: string) => {
    const signature = await call<Signature>('POST', '/api/attachments/signature', {
      contentType: 'image/png',
      contentLength: PIXEL.length,
      type: 1,
      baseId,
    });
    const sent = await fetch(new URL(signature.url, base), {
      method: signature.uploadMethod,
      headers: { authorization: `Bearer ${token}`, ...signature.requestHeaders },
      body: PIXEL,
    });
    if (!sent.ok) throw new Error(`Teable refused the upload: ${await sent.text()}`);
    return call<Record<string, unknown>>(
      'POST',
      `/api/attachments/notify/${signature.token}?filename=${filename}`,
    );
  };
  const first = await upload('pixel.png');
  const second = await upload('plan.png');

  const me = await call<{ id: string; name: string; email: string }>('GET', '/api/auth/user/me');
  const person = { id: me.id, title: me.name, email: me.email };
  const records = async (tableId: string, rows: Array<Record<string, unknown>>) =>
    call<{ records: Named[] }>('POST', `/api/table/${tableId}/record`, {
      fieldKeyType: 'name',
      typecast: true,
      records: rows.map((values) => ({ fields: values })),
    });
  const made = await records(projects, [
    {
      Title: 'Website',
      Notes: 'Line one\nLine two',
      Brief: '**Bold** start',
      Site: 'https://example.com/website',
      Contact: 'ada@example.com',
      Phone: '555-0100',
      Count: 3,
      Weight: 1.25,
      Budget: 800,
      Share: 0.5,
      Score: 2,
      Effort: 3,
      Active: true,
      Start: '2026-01-05T00:00:00.000Z',
      Due: '2026-01-20T14:30:00.000Z',
      Owner: person,
      Team: [person],
      Status: 'Doing',
      Tags: ['Web', 'Mobile'],
      Files: [first],
      Progress: 60,
    },
    {
      Title: 'App',
      Budget: 300,
      Start: '2026-02-01T00:00:00.000Z',
      Status: 'Todo',
      Tags: ['Mobile'],
      Files: [second],
    },
    { Title: 'Docs', Budget: 950, Active: false, Status: 'Doing' },
  ]);
  const madeTasks = await records(tasks, [
    { Name: 'Design', Hours: 2 },
    { Name: 'Build', Hours: 3.5 },
    { Name: 'Plan', Hours: 1 },
  ]);
  const madePeople = await records(people, [
    { Name: 'Ada', Email: 'ada@example.com' },
    { Name: 'Grace', Email: 'grace@example.com' },
  ]);
  const taskFields = await fieldsOf(url, token, tasks);
  const link = (tableId: string, recordId: string, fieldId: string, targets: string[]) =>
    call('PATCH', `/api/table/${tableId}/record/${recordId}`, {
      fieldKeyType: 'id',
      typecast: true,
      record: { fields: { [fieldId]: targets.map((id) => ({ id })) } },
    });
  await link(projects, made.records[0]!.id, fields.Tasks!, [
    madeTasks.records[0]!.id,
    madeTasks.records[1]!.id,
  ]);
  await link(projects, made.records[1]!.id, fields.Tasks!, [madeTasks.records[2]!.id]);
  await link(tasks, madeTasks.records[0]!.id, taskFields.People!, [madePeople.records[0]!.id]);
  await link(tasks, madeTasks.records[1]!.id, taskFields.People!, [
    madePeople.records[0]!.id,
    madePeople.records[1]!.id,
  ]);

  // Views of every kind Teable has, with the settings it shares.
  const view = (body: Record<string, unknown>) => call<Named>('POST', `/api/table/${projects}/view`, body);
  await view({
    name: 'Doing',
    type: 'grid',
    sort: { sortObjs: [{ fieldId: fields.Budget, order: 'desc' }] },
    filter: {
      conjunction: 'and',
      filterSet: [{ fieldId: fields.Status, operator: 'is', value: 'Doing' }],
    },
    columnMeta: Object.fromEntries(
      Object.values(fields).map((fieldId, index) => [
        fieldId,
        { order: index + 1, hidden: fieldId === fields.Notes },
      ]),
    ),
  });
  await view({
    name: 'Recent',
    type: 'grid',
    sort: { sortObjs: [{ fieldId: fields.Start, order: 'asc' }] },
    filter: {
      conjunction: 'or',
      filterSet: [
        {
          fieldId: fields.Start,
          operator: 'isOnOrAfter',
          value: { mode: 'exactDate', exactDate: '2026-01-10T00:00:00.000Z', timeZone: 'UTC' },
        },
        { fieldId: fields.Tags, operator: 'hasAnyOf', value: ['Web'] },
        { fieldId: fields.Status, operator: 'isNotExactly', value: ['Done'] },
      ],
    },
    group: [{ fieldId: fields.Status, order: 'asc' }],
  });
  await view({
    name: 'Pictures',
    type: 'gallery',
    options: { coverFieldId: fields.Files, isCoverFit: true },
  });
  await view({
    name: 'Board',
    type: 'kanban',
    options: { stackFieldId: fields.Status, coverFieldId: fields.Files },
  });
  await view({
    name: 'Intake',
    type: 'form',
    description: 'Tell us about the work.',
    options: { submitLabel: 'Send it' },
    columnMeta: Object.fromEntries(
      [fields.Title, fields.Notes, fields.Status, fields.Files].map((fieldId, index) => [
        fieldId,
        { order: index + 1, visible: true, required: index === 0 },
      ]),
    ),
  });
  await view({
    name: 'Timeline',
    type: 'calendar',
    options: {
      startDateFieldId: fields.Start,
      endDateFieldId: fields.Due,
      colorConfig: { type: 'field', fieldId: fields.Status },
    },
  });
  return { baseId, name };
}

export async function removeTeableBase(url: string, token: string, baseId: string): Promise<void> {
  await client(url, token).call('DELETE', `/api/base/${baseId}`);
}

import { PIXEL } from './harness.js';

/**
 * A Baserow database with every kind of field, made through Baserow's own API for the live import
 * suite: projects, tasks, and people, linked both ways and one way, with lookups, rollups, counts,
 * formulas, an attachment, and views with filters and sorts.  Making it takes signing in, since a
 * database token can't make fields or views, and it makes a database token for the import to use
 * as well.  `removeBaserowDatabase` deletes both again.
 */

export interface BaserowSeed {
  databaseId: string;
  name: string;
  /** A database token for the workspace, for importing without signing in */
  token: string;
  tokenId: number;
}

async function signIn(url: string, email: string, password: string): Promise<string> {
  const response = await fetch(`${url.replace(/\/+$/, '')}/api/user/token-auth/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Baserow refused the sign-in: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

function client(url: string, access: string) {
  const root = url.replace(/\/+$/, '');
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {
        authorization: `JWT ${access}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Baserow answered ${response.status} to ${method} ${path}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
}

interface Field {
  id: number;
  name: string;
  primary?: boolean;
  select_options?: Array<{ id: number; value: string }>;
}

export async function seedBaserow(url: string, email: string, password: string): Promise<BaserowSeed> {
  const call = client(url, await signIn(url, email, password));
  const name = `Riosoma import ${Date.now().toString(36)}`;
  const workspaces = await call<Array<{ id: number }>>('GET', '/api/workspaces/');
  const workspace =
    workspaces[0] ?? (await call<{ id: number }>('POST', '/api/workspaces/', { name: 'Riosoma tests' }));
  const database = await call<{ id: number }>('POST', `/api/applications/workspace/${workspace.id}/`, {
    type: 'database',
    name,
  });
  const table = (title: string) =>
    call<{ id: number }>('POST', `/api/database/tables/database/${database.id}/`, {
      name: title,
      data: [['Name']],
      first_row_header: true,
    });
  const people = await table('People');
  const projects = await table('Projects');
  const tasks = await table('Tasks');
  const add = (tableId: number, field: Record<string, unknown>) =>
    call<Field>('POST', `/api/database/fields/table/${tableId}/`, field);
  const fields = async (tableId: number) =>
    Object.fromEntries(
      (await call<Field[]>('GET', `/api/database/fields/table/${tableId}/`)).map((field) => [
        field.name,
        field,
      ]),
    );

  await add(people.id, { name: 'Email', type: 'email' });
  await add(tasks.id, { name: 'Hours', type: 'number', number_decimal_places: 1 });
  for (const field of [
    { name: 'Notes', type: 'long_text' },
    { name: 'Brief', type: 'long_text', long_text_enable_rich_text: true },
    { name: 'Site', type: 'url' },
    { name: 'Contact', type: 'email' },
    { name: 'Phone', type: 'phone_number' },
    { name: 'Count', type: 'number', number_decimal_places: 0 },
    { name: 'Budget', type: 'number', number_decimal_places: 2, number_prefix: '$' },
    { name: 'Share', type: 'number', number_decimal_places: 1, number_suffix: '%' },
    { name: 'Weight', type: 'number', number_decimal_places: 2, number_suffix: 'kg' },
    { name: 'Score', type: 'rating', max_value: 5, color: 'dark-orange', style: 'heart' },
    { name: 'Active', type: 'boolean' },
    { name: 'Start', type: 'date', date_format: 'ISO', date_include_time: false },
    { name: 'End', type: 'date', date_format: 'ISO', date_include_time: false },
    {
      name: 'Due',
      type: 'date',
      date_format: 'US',
      date_include_time: true,
      date_time_format: '12',
      date_force_timezone: 'America/New_York',
    },
    { name: 'Estimate', type: 'duration', duration_format: 'h:mm:ss' },
    {
      name: 'Status',
      type: 'single_select',
      select_options: [
        { value: 'Todo', color: 'blue' },
        { value: 'Doing', color: 'yellow' },
        { value: 'Done', color: 'dark-green' },
      ],
    },
    {
      name: 'Tags',
      type: 'multiple_select',
      select_options: [
        { value: 'Web', color: 'light-blue' },
        { value: 'Mobile', color: 'red' },
      ],
    },
    { name: 'Files', type: 'file' },
    { name: 'Owner', type: 'multiple_collaborators' },
    { name: 'Made', type: 'created_on', date_include_time: true },
    { name: 'Author', type: 'created_by' },
    { name: 'Serial', type: 'autonumber' },
    { name: 'Key', type: 'uuid' },
    { name: 'Secret', type: 'password' },
    { name: 'Label', type: 'formula', formula: "concat(field('Name'), ' (', totext(field('Status')), ')')" },
    { name: 'Double', type: 'formula', formula: "field('Budget') * 2" },
    { name: 'Shout', type: 'formula', formula: "upper(field('Name'))" },
    { name: 'Since', type: 'formula', formula: "date_diff('dd', field('Start'), field('End'))" },
  ])
    await add(projects.id, field);
  const link = await add(projects.id, {
    name: 'Tasks',
    type: 'link_row',
    link_row_table_id: tasks.id,
    has_related_field: true,
  });
  await add(tasks.id, {
    name: 'People',
    type: 'link_row',
    link_row_table_id: people.id,
    has_related_field: true,
  });
  await add(projects.id, {
    name: 'Lead',
    type: 'link_row',
    link_row_table_id: people.id,
    has_related_field: false,
    link_row_multiple_relationships: false,
  });
  const theirs = await fields(tasks.id);
  await add(projects.id, { name: 'Task count', type: 'count', through_field_id: link.id });
  await add(projects.id, {
    name: 'Hours',
    type: 'rollup',
    through_field_id: link.id,
    target_field_id: theirs.Hours!.id,
    rollup_function: 'sum',
  });
  await add(projects.id, {
    name: 'Task names',
    type: 'lookup',
    through_field_id: link.id,
    target_field_id: theirs.Name!.id,
  });
  await add(projects.id, { name: 'Most hours', type: 'formula', formula: "max(lookup('Tasks', 'Hours'))" });

  const form = new FormData();
  form.append('file', new Blob([PIXEL], { type: 'image/png' }), 'pixel.png');
  const access = await signIn(url, email, password);
  const uploaded = await fetch(`${url.replace(/\/+$/, '')}/api/user-files/upload-file/`, {
    method: 'POST',
    headers: { authorization: `JWT ${access}` },
    body: form,
  });
  if (!uploaded.ok) throw new Error(`Baserow refused the upload: ${await uploaded.text()}`);
  const file = (await uploaded.json()) as { name: string };

  const own = await fields(projects.id);
  const option = (field: string, value: string) =>
    own[field]!.select_options!.find((item) => item.value === value)!.id;
  const rows = (tableId: number, items: Array<Record<string, unknown>>) =>
    call<{ items: Array<{ id: number }> }>(
      'POST',
      `/api/database/rows/table/${tableId}/batch/?user_field_names=true`,
      {
        items,
      },
    );
  const madePeople = await rows(people.id, [
    { Name: 'Ada', Email: 'ada@example.com' },
    { Name: 'Grace', Email: 'grace@example.com' },
  ]);
  const madeTasks = await rows(tasks.id, [
    { Name: 'Design', Hours: '2', People: [madePeople.items[0]!.id] },
    { Name: 'Build', Hours: '3.5', People: [madePeople.items[0]!.id, madePeople.items[1]!.id] },
    { Name: 'Plan', Hours: '1' },
  ]);
  await rows(projects.id, [
    {
      Name: 'Website',
      Notes: 'Line one\nLine two',
      Brief: '**Bold** start',
      Site: 'https://example.com/website',
      Contact: 'ada@example.com',
      Phone: '555-0100',
      Count: '3',
      Budget: '800',
      Share: '50',
      Weight: '1.25',
      Score: 2,
      Active: true,
      Start: '2026-01-05',
      End: '2026-01-20',
      Due: '2026-01-20T15:30:00Z',
      Estimate: 5400,
      Status: option('Status', 'Doing'),
      Tags: [option('Tags', 'Web'), option('Tags', 'Mobile')],
      Files: [{ name: file.name, visible_name: 'pixel.png' }],
      Tasks: [madeTasks.items[0]!.id, madeTasks.items[1]!.id],
      Lead: [madePeople.items[0]!.id],
    },
    {
      Name: 'App',
      Status: option('Status', 'Todo'),
      Budget: '300',
      Start: '2026-02-01',
      Tags: [option('Tags', 'Mobile')],
      Tasks: [madeTasks.items[2]!.id],
    },
    { Name: 'Docs', Status: option('Status', 'Doing'), Budget: '950' },
  ]);

  const view = (body: Record<string, unknown>) =>
    call<{ id: number }>('POST', `/api/database/views/table/${projects.id}/`, body);
  const doing = await view({ name: 'Doing', type: 'grid', filter_type: 'AND' });
  await call('POST', `/api/database/views/${doing.id}/filters/`, {
    field: own.Status!.id,
    type: 'single_select_equal',
    value: String(option('Status', 'Doing')),
  });
  await call('POST', `/api/database/views/${doing.id}/sortings/`, { field: own.Budget!.id, order: 'DESC' });
  await call('PATCH', `/api/database/views/${doing.id}/field-options/`, {
    field_options: { [own.Notes!.id]: { hidden: true } },
  });
  const recent = await view({ name: 'Recent', type: 'grid', filter_type: 'OR' });
  await call('POST', `/api/database/views/${recent.id}/filters/`, {
    field: own.Start!.id,
    type: 'date_is_on_or_after',
    value: 'UTC?2026-01-10?exact_date',
  });
  await call('POST', `/api/database/views/${recent.id}/filters/`, {
    field: own.Tags!.id,
    type: 'multiple_select_has',
    value: String(option('Tags', 'Web')),
  });
  await view({
    name: 'Board',
    type: 'kanban',
    single_select_field: own.Status!.id,
    card_cover_image_field: own.Files!.id,
  });
  await view({ name: 'Pictures', type: 'gallery', card_cover_image_field: own.Files!.id });
  await view({ name: 'Calendar', type: 'calendar', date_field: own.Start!.id });
  await view({
    name: 'Plan',
    type: 'timeline',
    start_date_field: own.Start!.id,
    end_date_field: own.End!.id,
  });
  const intake = await view({
    name: 'Intake',
    type: 'form',
    title: 'Tell us',
    description: 'About it',
    submit_text: 'Send',
  });
  await call('PATCH', `/api/database/views/${intake.id}/field-options/`, {
    field_options: {
      [own.Name!.id]: { enabled: true, required: true, name: 'Project name' },
      [own.Status!.id]: { enabled: true, required: false, description: 'Where it is' },
    },
  });

  const token = await call<{ id: number; key: string }>('POST', '/api/database/tokens/', {
    name: name,
    workspace: workspace.id,
  });
  return { databaseId: String(database.id), name, token: token.key, tokenId: token.id };
}

export async function removeBaserowDatabase(
  url: string,
  email: string,
  password: string,
  seed: BaserowSeed,
): Promise<void> {
  const call = client(url, await signIn(url, email, password));
  await call('DELETE', `/api/database/tokens/${seed.tokenId}/`);
  await call('DELETE', `/api/applications/${seed.databaseId}/`);
}

import { PIXEL } from './harness.js';

/**
 * A NocoDB base with every kind of field, made through NocoDB's own API for the live import suite:
 * projects, tasks, and people, linked every way NocoDB links, with lookups, rollups, formulas,
 * attachments, and views with filters and sorts.  `removeNocodbBase` deletes it again.
 */

export interface NocodbSeed {
  baseId: string;
  name: string;
}

interface Column {
  id: string;
  title: string;
}

function client(url: string, token: string) {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { 'xc-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`NocoDB answered ${response.status} to ${method} ${path}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
}

export async function seedNocodb(url: string, token: string): Promise<NocodbSeed> {
  const call = client(url, token);
  const name = `Riosoma import ${Date.now().toString(36)}`;
  const base = await call<{ id: string }>('POST', '/api/v2/meta/bases', { title: name });
  const table = (title: string, first: string) =>
    call<{ id: string }>('POST', `/api/v2/meta/bases/${base.id}/tables`, {
      title,
      columns: [{ column_name: first.toLowerCase(), title: first, uidt: 'SingleLineText' }],
    });
  const projects = await table('Projects', 'Title');
  const tasks = await table('Tasks', 'Name');
  const people = await table('People', 'Name');
  const columns = async (tableId: string) =>
    Object.fromEntries(
      (await call<{ columns: Column[] }>('GET', `/api/v2/meta/tables/${tableId}`)).columns.map((column) => [
        column.title,
        column.id,
      ]),
    );
  const add = (tableId: string, column: Record<string, unknown>) =>
    call('POST', `/api/v2/meta/tables/${tableId}/columns`, column);

  for (const column of [
    { title: 'Notes', uidt: 'LongText' },
    { title: 'Brief', uidt: 'LongText', meta: { richMode: true } },
    { title: 'Contact', uidt: 'Email' },
    { title: 'Site', uidt: 'URL' },
    { title: 'Phone', uidt: 'PhoneNumber' },
    { title: 'Count', uidt: 'Number' },
    { title: 'Weight', uidt: 'Decimal', meta: { precision: 2 } },
    { title: 'Budget', uidt: 'Currency', meta: { currency_locale: 'en-US', currency_code: 'USD' } },
    { title: 'Share', uidt: 'Percent' },
    { title: 'Estimate', uidt: 'Duration', meta: { duration: 1 } },
    { title: 'Score', uidt: 'Rating', meta: { max: 5, iconIdx: 0, color: '#fcb401' } },
    { title: 'Active', uidt: 'Checkbox' },
    { title: 'Start', uidt: 'Date', meta: { date_format: 'YYYY-MM-DD' } },
    { title: 'Due', uidt: 'DateTime', meta: { date_format: 'YYYY-MM-DD', time_format: 'HH:mm' } },
    { title: 'Alarm', uidt: 'Time' },
    { title: 'Year', uidt: 'Year' },
    {
      title: 'Status',
      uidt: 'SingleSelect',
      colOptions: {
        options: [
          { title: 'Todo', color: '#cfdffe' },
          { title: 'Doing', color: '#d0f1fd' },
          { title: 'Done', color: '#c2f5e8' },
        ],
      },
    },
    {
      title: 'Tags',
      uidt: 'MultiSelect',
      colOptions: {
        options: [
          { title: 'Web', color: '#cfdffe' },
          { title: 'Mobile', color: '#ffdce5' },
        ],
      },
    },
    { title: 'Place', uidt: 'GeoData' },
    { title: 'Data', uidt: 'JSON' },
    { title: 'Files', uidt: 'Attachment' },
    { title: 'Owner', uidt: 'User' },
    { title: 'Made', uidt: 'CreatedTime' },
    { title: 'Author', uidt: 'CreatedBy' },
    { title: 'Label', uidt: 'Formula', formula_raw: 'CONCAT({Title}, " (", {Status}, ")")' },
    { title: 'Double', uidt: 'Formula', formula_raw: '{Budget} * 2' },
    { title: 'Link', uidt: 'Formula', formula_raw: 'URL({Site})' },
  ])
    await add(projects.id, column);
  let own = await columns(projects.id);
  await add(projects.id, {
    title: 'Code',
    uidt: 'Barcode',
    fk_barcode_value_column_id: own.Title,
    meta: { barcodeFormat: 'CODE128' },
  });
  await add(projects.id, { title: 'QR', uidt: 'QrCode', fk_qr_value_column_id: own.Title });
  await add(tasks.id, { title: 'Hours', uidt: 'Decimal', meta: { precision: 1 } });
  await add(people.id, { title: 'Email', uidt: 'Email' });
  // Projects have many tasks, which each belong to one project, and tasks and people link many to many.
  await add(projects.id, {
    title: 'Tasks',
    uidt: 'Links',
    parentId: projects.id,
    childId: tasks.id,
    type: 'hm',
  });
  await add(tasks.id, { title: 'People', uidt: 'Links', parentId: tasks.id, childId: people.id, type: 'mm' });
  own = await columns(projects.id);
  const theirs = await columns(tasks.id);
  await add(projects.id, {
    title: 'Task names',
    uidt: 'Lookup',
    fk_relation_column_id: own.Tasks,
    fk_lookup_column_id: theirs.Name,
  });
  await add(projects.id, {
    title: 'Hours',
    uidt: 'Rollup',
    fk_relation_column_id: own.Tasks,
    fk_rollup_column_id: theirs.Hours,
    rollup_function: 'sum',
  });

  // An attachment NocoDB stores itself.
  const form = new FormData();
  form.append('file', new Blob([PIXEL], { type: 'image/png' }), 'pixel.png');
  const uploaded = await fetch(`${url.replace(/\/+$/, '')}/api/v2/storage/upload`, {
    method: 'POST',
    headers: { 'xc-token': token },
    body: form,
  });
  if (!uploaded.ok) throw new Error(`NocoDB refused the upload: ${await uploaded.text()}`);
  const files: unknown = await uploaded.json();

  const users = await call<{ users: { list: Array<{ email: string }> } }>(
    'GET',
    `/api/v2/meta/bases/${base.id}/users`,
  );
  const owner = users.users.list[0]?.email;
  const made = await call<Array<{ Id: number }>>('POST', `/api/v2/tables/${projects.id}/records`, [
    {
      Title: 'Website',
      Notes: 'Line one\nLine two',
      Brief: '**Bold** start',
      Contact: 'ada@example.com',
      Site: 'https://example.com/website',
      Phone: '555-0100',
      Count: 3,
      Weight: 1.25,
      Budget: 800,
      Share: 50,
      Estimate: '5400',
      Score: 2,
      Active: true,
      Start: '2026-01-05',
      Due: '2026-01-20 15:30:00+00:00',
      Alarm: '08:30:00',
      Year: 2026,
      Status: 'Doing',
      Tags: 'Web,Mobile',
      Place: '37.7749;-122.4194',
      Data: { stage: 1 },
      Files: files,
      ...(owner ? { Owner: owner } : {}),
    },
    { Title: 'App', Status: 'Todo', Budget: 300, Start: '2026-02-01', Tags: 'Mobile' },
    { Title: 'Docs', Status: 'Doing', Budget: 950, Active: false },
  ]);
  const madeTasks = await call<Array<{ Id: number }>>('POST', `/api/v2/tables/${tasks.id}/records`, [
    { Name: 'Design', Hours: 2 },
    { Name: 'Build', Hours: 3.5 },
    { Name: 'Plan', Hours: 1 },
  ]);
  const madePeople = await call<Array<{ Id: number }>>('POST', `/api/v2/tables/${people.id}/records`, [
    { Name: 'Ada', Email: 'ada@example.com' },
    { Name: 'Grace', Email: 'grace@example.com' },
  ]);
  const link = (tableId: string, columnId: string, record: number, targets: number[]) =>
    call(
      'POST',
      `/api/v2/tables/${tableId}/links/${columnId}/records/${record}`,
      targets.map((Id) => ({ Id })),
    );
  await link(projects.id, own.Tasks!, made[0]!.Id, [madeTasks[0]!.Id, madeTasks[1]!.Id]);
  await link(projects.id, own.Tasks!, made[1]!.Id, [madeTasks[2]!.Id]);
  await link(tasks.id, theirs.People!, madeTasks[0]!.Id, [madePeople[0]!.Id]);
  await link(tasks.id, theirs.People!, madeTasks[1]!.Id, [madePeople[0]!.Id, madePeople[1]!.Id]);

  // Views, with the settings NocoDB shares.
  const view = (kind: string, body: Record<string, unknown>) =>
    call<{ id: string }>('POST', `/api/v2/meta/tables/${projects.id}/${kind}`, body);
  const doing = await view('grids', { title: 'Doing' });
  await call('POST', `/api/v2/meta/views/${doing.id}/filters`, {
    fk_column_id: own.Status,
    comparison_op: 'eq',
    value: 'Doing',
  });
  await call('POST', `/api/v2/meta/views/${doing.id}/sorts`, { fk_column_id: own.Budget, direction: 'desc' });
  const recent = await view('grids', { title: 'Recent' });
  const group = await call<{ id: string }>('POST', `/api/v2/meta/views/${recent.id}/filters`, {
    is_group: true,
    logical_op: 'or',
  });
  await call('POST', `/api/v2/meta/views/${recent.id}/filters`, {
    fk_parent_id: group.id,
    fk_column_id: own.Start,
    comparison_op: 'gte',
    comparison_sub_op: 'exactDate',
    value: '2026-01-10',
    logical_op: 'or',
  });
  await call('POST', `/api/v2/meta/views/${recent.id}/filters`, {
    fk_parent_id: group.id,
    fk_column_id: own.Tags,
    comparison_op: 'anyof',
    value: 'Web',
    logical_op: 'or',
  });
  await view('galleries', { title: 'Pictures', fk_cover_image_col_id: own.Files });
  await view('kanbans', { title: 'Board', fk_grp_col_id: own.Status });
  await view('forms', { title: 'Intake' });
  await view('maps', { title: 'Places', fk_geo_data_col_id: own.Place });
  return { baseId: base.id, name };
}

export async function removeNocodbBase(url: string, token: string, baseId: string): Promise<void> {
  await client(url, token)('DELETE', `/api/v2/meta/bases/${baseId}`);
}

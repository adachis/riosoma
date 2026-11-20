import { PIXEL } from './harness.js';

/**
 * A SeaTable base with every kind of column its API can make, for the live import suite: projects,
 * tasks, and people, linked both ways, with lookups, rollups, counts, formulas, files, and views
 * with filters, sorts, and groups.  `removeSeaTableBase` deletes it again.  What it makes is what
 * the recording the unit tests replay holds, so one set of checks covers both.
 *
 * Signing in makes the base and its columns, and the API token it makes for the base is what the
 * import reads with, the way a person would give Riosoma one.
 */

export interface SeaTableSeed {
  baseId: string;
  name: string;
  /** The API token the import reads the base with */
  apiToken: string;
  workspaceId: number;
}

interface Column {
  key: string;
  name: string;
  type: string;
  data?: Record<string, unknown>;
}

interface Table {
  _id: string;
  name: string;
  columns: Column[];
}

function rest(url: string) {
  const base = url.replace(/\/+$/, '');
  const send = async <T>(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
    form?: boolean,
  ): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined
          ? {}
          : { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }),
      },
      ...(body === undefined
        ? {}
        : {
            body: form
              ? new URLSearchParams(body as Record<string, string>).toString()
              : JSON.stringify(body),
          }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`SeaTable answered ${response.status} to ${method} ${path}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  return { base, send };
}

export async function seedSeaTable(url: string, email: string, password: string): Promise<SeaTableSeed> {
  const { base, send } = rest(url);
  const account = (
    await send<{ token: string }>(null, 'POST', '/api2/auth-token/', { username: email, password }, true)
  ).token;
  const name = `Riosoma import ${Date.now().toString(36)}`;
  const workspaces = await send<Array<{ id: number }>>(account, 'GET', '/api/v2.1/workspaces/');
  const workspaceId = workspaces[0]!.id;
  const created = await send<{ uuid: string }>(
    account,
    'POST',
    '/api/v2.1/dtables/',
    { name, workspace_id: String(workspaceId) },
    true,
  );
  const uuid = created.uuid;
  const opened = await send<{ access_token: string }>(
    account,
    'GET',
    `/api/v2.1/workspace/${workspaceId}/dtable/${encodeURIComponent(name)}/access-token/`,
  );
  const token = opened.access_token;
  const gateway = (path: string) => `/api-gateway/api/v2/dtables/${uuid}${path}`;
  const call = <T>(method: string, path: string, body?: unknown) => send<T>(token, method, path, body);
  const metadata = async () =>
    (await call<{ metadata: { tables: Table[] } }>('GET', gateway('/metadata/'))).metadata.tables;

  // The base comes with a table of its own, which becomes Projects, and three empty rows to drop.
  await call('PUT', gateway('/tables/'), { table_name: 'Table1', new_table_name: 'Projects' });
  await call('PUT', gateway('/columns/'), {
    table_name: 'Projects',
    column: 'Name',
    op_type: 'rename_column',
    new_column_name: 'Title',
  });
  const empty = await call<{ rows: Array<{ _id: string }> }>(
    'GET',
    `${gateway('/rows/')}?table_name=Projects&start=0&limit=100`,
  );
  if (empty.rows.length)
    await call('DELETE', gateway('/rows/'), {
      table_name: 'Projects',
      row_ids: empty.rows.map((row) => row._id),
    });
  for (const tableName of ['Tasks', 'People'])
    await call('POST', gateway('/tables/'), {
      table_name: tableName,
      columns: [{ column_name: 'Name', column_type: 'text' }],
    });

  const append = (tableName: string, columns: Array<Record<string, unknown>>) =>
    call('POST', gateway('/batch-append-columns/'), { table_name: tableName, columns });
  const add = (tableName: string, column: Record<string, unknown>) =>
    call<Column>('POST', gateway('/columns/'), { table_name: tableName, ...column });
  const options = [
    { id: 'op0001', name: 'Todo', color: '#B4D8FE', textColor: '#212529' },
    { id: 'op0002', name: 'Doing', color: '#9FE0DB', textColor: '#212529' },
    { id: 'op0003', name: 'Done', color: '#C2E9C0', textColor: '#212529' },
  ];
  const tags = [
    { id: 'tg0001', name: 'Web', color: '#E1C5FF', textColor: '#212529' },
    { id: 'tg0002', name: 'Mobile', color: '#FFC5D9', textColor: '#212529' },
  ];
  await append('Projects', [
    { column_name: 'Id', column_type: 'auto-number', column_data: { format: '0000', digits: 4 } },
    { column_name: 'Notes', column_type: 'long-text' },
    {
      column_name: 'Count',
      column_type: 'number',
      column_data: { format: 'number', decimal: 'dot', thousands: 'comma' },
    },
    {
      column_name: 'Weight',
      column_type: 'number',
      column_data: {
        format: 'number',
        decimal: 'dot',
        thousands: 'no',
        enable_precision: true,
        precision: 2,
      },
    },
    {
      column_name: 'Budget',
      column_type: 'number',
      column_data: { format: 'dollar', decimal: 'dot', thousands: 'comma' },
    },
    {
      column_name: 'Share',
      column_type: 'number',
      column_data: { format: 'percent', decimal: 'dot', thousands: 'no' },
    },
    {
      column_name: 'Price',
      column_type: 'number',
      column_data: {
        format: 'custom_currency',
        decimal: 'dot',
        thousands: 'comma',
        currency_symbol: 'CHF',
        currency_symbol_position: 'before',
      },
    },
    {
      column_name: 'Fee',
      column_type: 'number',
      column_data: {
        format: 'custom_currency',
        decimal: 'dot',
        thousands: 'no',
        currency_symbol: '¤',
        currency_symbol_position: 'after',
      },
    },
    { column_name: 'Start', column_type: 'date', column_data: { format: 'YYYY-MM-DD' } },
    { column_name: 'Due', column_type: 'date', column_data: { format: 'YYYY-MM-DD HH:mm' } },
    { column_name: 'Made', column_type: 'ctime' },
    { column_name: 'Changed', column_type: 'mtime' },
    {
      column_name: 'Estimate',
      column_type: 'duration',
      column_data: { format: 'duration', duration_format: 'h:mm:ss' },
    },
    { column_name: 'Active', column_type: 'checkbox' },
    {
      column_name: 'Score',
      column_type: 'rate',
      column_data: { rate_max_number: 5, rate_style_color: '#FFB114', rate_style_type: 'dtable-icon-rate' },
    },
    { column_name: 'Status', column_type: 'single-select', column_data: { options } },
    { column_name: 'Tags', column_type: 'multiple-select', column_data: { options: tags } },
    { column_name: 'Cover', column_type: 'image' },
    { column_name: 'Files', column_type: 'file' },
    { column_name: 'Owner', column_type: 'collaborator' },
    { column_name: 'Author', column_type: 'creator' },
    { column_name: 'Editor', column_type: 'last-modifier' },
    { column_name: 'Site', column_type: 'url' },
    { column_name: 'Contact', column_type: 'email' },
    { column_name: 'Place', column_type: 'geolocation', column_data: { geo_format: 'lng_lat' } },
    { column_name: 'Region', column_type: 'geolocation', column_data: { geo_format: 'country_region' } },
    { column_name: 'Send', column_type: 'button', column_data: { button_type: '' } },
  ]);
  await append('Tasks', [
    { column_name: 'Id', column_type: 'auto-number', column_data: { format: '0000', digits: 4 } },
    {
      column_name: 'Hours',
      column_type: 'number',
      column_data: { format: 'number', decimal: 'dot', thousands: 'no' },
    },
  ]);
  await append('People', [
    { column_name: 'Id', column_type: 'auto-number', column_data: { format: '0000', digits: 4 } },
    { column_name: 'Email', column_type: 'email' },
  ]);

  // Links, which SeaTable makes on both tables at once and names by a link ID of its own.
  await add('Projects', {
    column_name: 'Tasks',
    column_type: 'link',
    column_data: { table: 'Projects', other_table: 'Tasks' },
  });
  await add('Tasks', {
    column_name: 'People',
    column_type: 'link',
    column_data: { table: 'Tasks', other_table: 'People' },
  });
  const tables = await metadata();
  const columnsOf = (tableName: string) => tables.find((table) => table.name === tableName)!.columns;
  const keyOf = (tableName: string, columnName: string) =>
    columnsOf(tableName).find((column) => column.name === columnName)!.key;
  await add('Projects', {
    column_name: 'Summary',
    column_type: 'formula',
    column_data: { formula: 'CONCATENATE({Title}, " (", {Status}, ")")' },
  });
  await add('Projects', {
    column_name: 'Double',
    column_type: 'formula',
    column_data: { formula: '{Budget} * 2' },
  });
  await add('Projects', {
    column_name: 'Shown',
    column_type: 'formula',
    column_data: { formula: 'TEXT({Count}, "0.00")' },
  });
  await add('Projects', {
    column_name: 'Task names',
    column_type: 'link-formula',
    column_data: { formula: 'lookup', link_column: 'Tasks', level1_linked_column: 'Name' },
  });
  await add('Projects', {
    column_name: 'Hours',
    column_type: 'link-formula',
    column_data: { formula: 'rollup', link_column: 'Tasks', summary_column: 'Hours', summary_method: 'sum' },
  });
  await add('Projects', {
    column_name: 'Task count',
    column_type: 'link-formula',
    column_data: { formula: 'count_links', link_column: 'Tasks' },
  });
  await add('Projects', {
    column_name: 'Longest',
    column_type: 'link-formula',
    column_data: {
      formula: 'findmax',
      link_column: 'Tasks',
      searched_column: 'Name',
      comparison_column: 'Hours',
    },
  });

  // A file SeaTable stores itself, and one it only points at, the way an image column holds both.
  const made = await send<{ app_name: string; api_token: string }>(
    account,
    'POST',
    `/api/v2.1/workspace/${workspaceId}/dtable/${encodeURIComponent(name)}/api-tokens/`,
    { app_name: 'riosoma-import', permission: 'r' },
    true,
  );
  const apiToken = made.api_token;
  const link = await send<{
    upload_link: string;
    workspace_id: number;
    parent_path: string;
    img_relative_path: string;
    file_relative_path: string;
  }>(apiToken, 'GET', '/api/v2.1/dtable/app-upload-link/');
  const store = async (relative: string, filename: string) => {
    const form = new FormData();
    form.append('parent_dir', link.parent_path);
    form.append('relative_path', relative);
    form.append('replace', '0');
    form.append('file', new Blob([PIXEL], { type: 'image/png' }), filename);
    const sent = await fetch(link.upload_link, { method: 'POST', body: form });
    if (!sent.ok) throw new Error(`SeaTable refused the upload: ${await sent.text()}`);
    const [stored] = (await sent.json()) as Array<{ name: string; size: number }>;
    return {
      path: `/workspace/${link.workspace_id}${link.parent_path}/${relative}/${stored!.name}`,
      name: stored!.name,
      size: stored!.size,
    };
  };
  const image = await store(link.img_relative_path, 'pixel.png');
  const file = await store(link.file_relative_path, 'plan.pdf');
  const mine = await send<{ email: string }>(account, 'GET', '/api2/account/info/');
  const collaborators = (
    await call<{ user_list: Array<{ email: string }> }>('GET', gateway('/related-users/'))
  ).user_list;
  const me = collaborators[0]?.email ?? mine.email;

  const rows = async (tableName: string, list: Array<Record<string, unknown>>) =>
    call<{ row_ids: Array<{ _id: string }> }>('POST', gateway('/rows/'), {
      table_name: tableName,
      rows: list,
    });
  const projects = await rows('Projects', [
    {
      Title: 'Website',
      Notes: 'Line one\nLine two',
      Count: 3,
      Weight: 1.25,
      Budget: 800,
      Share: 0.5,
      Price: 1200,
      Fee: 15,
      Start: '2026-01-05',
      Due: '2026-01-20 15:30',
      Estimate: 5400,
      Active: true,
      Score: 2,
      Status: 'Doing',
      Tags: ['Web', 'Mobile'],
      Cover: [image.path, `${base}/media/avatars/default.png`],
      Files: [{ name: file.name, size: file.size, type: 'file', url: file.path }],
      Owner: [me],
      Site: 'https://example.com/website',
      Contact: 'ada@example.com',
      Place: { lng: -122.4194, lat: 37.7749 },
      Region: { country_region: 'Sweden' },
    },
    { Title: 'App', Budget: 300, Start: '2026-02-01', Status: 'Todo', Tags: ['Mobile'] },
    { Title: 'Docs', Budget: 950, Active: false, Status: 'Doing' },
  ]);
  const tasks = await rows('Tasks', [
    { Name: 'Design', Hours: 2 },
    { Name: 'Build', Hours: 3.5 },
    { Name: 'Plan', Hours: 1 },
  ]);
  const people = await rows('People', [
    { Name: 'Ada', Email: 'ada@example.com' },
    { Name: 'Grace', Email: 'grace@example.com' },
  ]);
  const at = (made: { row_ids: Array<{ _id: string }> }, index: number) => made.row_ids[index]!._id;
  const relate = (tableName: string, otherTable: string, columnName: string, map: Record<string, string[]>) =>
    call('POST', gateway('/links/'), {
      table_id: tables.find((table) => table.name === tableName)!._id,
      other_table_id: tables.find((table) => table.name === otherTable)!._id,
      link_id: columnsOf(tableName).find((column) => column.name === columnName)!.data!.link_id,
      other_rows_ids_map: map,
    });
  await relate('Projects', 'Tasks', 'Tasks', {
    [at(projects, 0)]: [at(tasks, 0), at(tasks, 1)],
    [at(projects, 1)]: [at(tasks, 2)],
  });
  await relate('Tasks', 'People', 'People', {
    [at(tasks, 0)]: [at(people, 0)],
    [at(tasks, 1)]: [at(people, 0), at(people, 1)],
  });

  // Views, with the filters, sorts, groups, and hidden columns SeaTable's views hold.
  const view = async (viewName: string, settings: Record<string, unknown>) => {
    await call('POST', `${gateway('/views/')}?table_name=Projects`, { name: viewName, type: 'table' });
    await call('PUT', `${gateway('/views/')}${encodeURIComponent(viewName)}/?table_name=Projects`, settings);
  };
  await view('Doing', {
    filter_conjunction: 'And',
    filters: [{ column_key: keyOf('Projects', 'Status'), filter_predicate: 'is', filter_term: 'Doing' }],
    sorts: [{ column_key: keyOf('Projects', 'Budget'), sort_type: 'down' }],
    hidden_columns: [keyOf('Projects', 'Notes')],
  });
  await view('Recent', {
    filter_conjunction: 'Or',
    filters: [
      {
        column_key: keyOf('Projects', 'Start'),
        filter_predicate: 'is_on_or_after',
        filter_term: '2026-01-10',
        filter_term_modifier: 'exact_date',
      },
      {
        column_key: keyOf('Projects', 'Tags'),
        filter_predicate: 'has_any_of',
        filter_term: ['Web'],
      },
      { column_key: keyOf('Projects', 'Owner'), filter_predicate: 'include_me', filter_term: '' },
    ],
    groupbys: [{ column_key: keyOf('Projects', 'Status'), sort_type: 'up' }],
  });
  await view('This month', {
    filters: [
      {
        column_key: keyOf('Projects', 'Due'),
        filter_predicate: 'is_within',
        filter_term: '',
        filter_term_modifier: 'the_past_month',
      },
    ],
  });
  return { baseId: uuid, name, apiToken, workspaceId };
}

export async function removeSeaTableBase(
  url: string,
  email: string,
  password: string,
  seed: SeaTableSeed,
): Promise<void> {
  const { send } = rest(url);
  const account = (
    await send<{ token: string }>(null, 'POST', '/api2/auth-token/', { username: email, password }, true)
  ).token;
  await send(account, 'DELETE', `/api/v2.1/workspace/${seed.workspaceId}/dtable/`, { name: seed.name }, true);
}

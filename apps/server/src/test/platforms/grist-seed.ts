import { PIXEL } from './harness.js';

/**
 * A Grist document with every kind of column, made through Grist's own API for the live import
 * suite: projects, tasks, and people, with references both ways, formulas that translate and ones
 * that don't, an attachment, and pages with sorted and filtered widgets.  `removeGristDocument`
 * deletes it again.
 */

export interface GristSeed {
  docId: string;
  name: string;
}

function client(url: string, key: string) {
  const root = url.replace(/\/+$/, '');
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Grist answered ${response.status} to ${method} ${path}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
}

const options = (value: Record<string, unknown>) => JSON.stringify(value);
const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1_000;

export async function seedGrist(url: string, key: string): Promise<GristSeed> {
  const call = client(url, key);
  const name = `Riosoma import ${Date.now().toString(36)}`;
  const [org] = await call<Array<{ id: number }>>('GET', '/api/orgs');
  const [workspace] = await call<Array<{ id: number }>>('GET', `/api/orgs/${org!.id}/workspaces`);
  const docId = await call<string>('POST', `/api/workspaces/${workspace!.id}/docs`, { name });
  const doc = `/api/docs/${docId}`;
  const apply = (actions: unknown[]) =>
    call<{ retValues: Array<Record<string, number>> }>('POST', `${doc}/apply`, actions);
  // One table at a time, each after the tables it refers to.
  const table = (id: string, columns: Array<{ id: string; fields: Record<string, unknown> }>) =>
    call('POST', `${doc}/tables`, { tables: [{ id, columns }] });
  await table('People', [
    { id: 'Name', fields: { label: 'Name', type: 'Text' } },
    { id: 'Email', fields: { label: 'Email', type: 'Text' } },
  ]);
  await table('Projects', [
    { id: 'Name', fields: { label: 'Name', type: 'Text' } },
    { id: 'Notes', fields: { label: 'Notes', type: 'Text', widgetOptions: options({ wrap: true }) } },
    { id: 'Brief', fields: { label: 'Brief', type: 'Text', widgetOptions: options({ widget: 'Markdown' }) } },
    { id: 'Site', fields: { label: 'Site', type: 'Text', widgetOptions: options({ widget: 'HyperLink' }) } },
    { id: 'Count', fields: { label: 'Count', type: 'Int' } },
    {
      id: 'Budget',
      fields: {
        label: 'Budget',
        type: 'Numeric',
        widgetOptions: options({ numMode: 'currency', currency: 'EUR', decimals: 2 }),
      },
    },
    {
      id: 'Share',
      fields: {
        label: 'Share',
        type: 'Numeric',
        widgetOptions: options({ numMode: 'percent', decimals: 1 }),
      },
    },
    { id: 'Weight', fields: { label: 'Weight', type: 'Numeric', widgetOptions: options({ decimals: 2 }) } },
    {
      id: 'Active',
      fields: { label: 'Active', type: 'Bool', widgetOptions: options({ widget: 'CheckBox' }) },
    },
    {
      id: 'Start',
      fields: { label: 'Start', type: 'Date', widgetOptions: options({ dateFormat: 'YYYY-MM-DD' }) },
    },
    {
      id: 'Due',
      fields: {
        label: 'Due',
        type: 'DateTime:America/New_York',
        widgetOptions: options({ dateFormat: 'MM/DD/YYYY', timeFormat: 'h:mma' }),
      },
    },
    {
      id: 'Status',
      fields: {
        label: 'Status',
        type: 'Choice',
        widgetOptions: options({
          choices: ['Todo', 'Doing', 'Done'],
          choiceOptions: {
            Todo: { fillColor: '#1C7ED6' },
            Doing: { fillColor: '#FCC419' },
            Done: { fillColor: '#37B24D' },
          },
        }),
      },
    },
    {
      id: 'Tags',
      fields: { label: 'Tags', type: 'ChoiceList', widgetOptions: options({ choices: ['Web', 'Mobile'] }) },
    },
    { id: 'Files', fields: { label: 'Files', type: 'Attachments' } },
    { id: 'Anything', fields: { label: 'Anything', type: 'Any' } },
    { id: 'Lead', fields: { label: 'Lead', type: 'Ref:People' } },
    { id: 'Code', fields: { label: 'Code', type: 'Text', isFormula: false, formula: '$Name.upper()' } },
  ]);
  await table('Tasks', [
    { id: 'Name', fields: { label: 'Name', type: 'Text' } },
    { id: 'Hours', fields: { label: 'Hours', type: 'Numeric' } },
    { id: 'Project', fields: { label: 'Project', type: 'Ref:Projects' } },
    { id: 'Helpers', fields: { label: 'Helpers', type: 'RefList:People' } },
  ]);
  // A new document starts with an empty table, which this one doesn't need.
  await apply([['RemoveTable', 'Table1']]);
  // Projects list their tasks through the other side of each task's project.
  await apply([['AddReverseColumn', 'Tasks', 'Project']]);
  await call('POST', `${doc}/tables/Projects/columns`, {
    columns: [
      {
        id: 'Label',
        fields: { label: 'Label', type: 'Text', isFormula: true, formula: '$Name + " (" + $Status + ")"' },
      },
      { id: 'Double', fields: { label: 'Double', type: 'Numeric', isFormula: true, formula: '$Budget * 2' } },
      {
        id: 'Shout',
        fields: { label: 'Shout', type: 'Text', isFormula: true, formula: 'UPPER($Name) if $Active else ""' },
      },
      {
        id: 'Rounded',
        fields: { label: 'Rounded', type: 'Numeric', isFormula: true, formula: 'round($Weight * 3, 1)' },
      },
      {
        id: 'Tidy',
        fields: { label: 'Tidy', type: 'Text', isFormula: true, formula: '$Name.strip().lower()' },
      },
      {
        id: 'Hours',
        fields: {
          label: 'Hours',
          type: 'Numeric',
          isFormula: true,
          formula: 'SUM(Tasks.lookupRecords(Project=$id).Hours)',
        },
      },
      {
        id: 'Tripled',
        fields: {
          label: 'Tripled',
          type: 'Numeric',
          isFormula: true,
          formula: 'x = $Count or 0\nreturn x * 3',
        },
      },
      { id: 'Proper', fields: { label: 'Proper', type: 'Text', isFormula: true, formula: 'PROPER($Name)' } },
      {
        id: 'Task_count',
        fields: {
          label: 'Task count',
          type: 'Int',
          isFormula: true,
          formula: 'len(Tasks.lookupRecords(Project=$id))',
        },
      },
      {
        id: 'Task_names',
        fields: {
          label: 'Task names',
          type: 'Any',
          isFormula: true,
          formula: 'Tasks.lookupRecords(Project=$id).Name',
        },
      },
    ],
  });

  const form = new FormData();
  form.append('upload', new Blob([PIXEL], { type: 'image/png' }), 'pixel.png');
  const uploaded = await fetch(`${url.replace(/\/+$/, '')}${doc}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  if (!uploaded.ok) throw new Error(`Grist refused the upload: ${await uploaded.text()}`);
  const [attachment] = (await uploaded.json()) as number[];

  const add = (table: string, records: Array<Record<string, unknown>>) =>
    call<{ records: Array<{ id: number }> }>('POST', `${doc}/tables/${table}/records`, {
      records: records.map((fields) => ({ fields })),
    });
  const people = await add('People', [
    { Name: 'Ada', Email: 'ada@example.com' },
    { Name: 'Grace', Email: 'grace@example.com' },
  ]);
  const projects = await add('Projects', [
    {
      Name: 'Website',
      Notes: 'Line one\nLine two',
      Brief: '**Bold** start',
      Site: 'Example https://example.com/website',
      Count: 3,
      Budget: 800,
      Share: 0.5,
      Weight: 1.25,
      Active: true,
      Start: day('2026-01-05'),
      Due: Date.parse('2026-01-20T15:30:00Z') / 1_000,
      Status: 'Doing',
      Tags: ['L', 'Web', 'Mobile'],
      Files: ['L', attachment],
      Anything: 'hello',
      Lead: people.records[0]!.id,
    },
    { Name: 'App', Status: 'Todo', Budget: 300, Count: 1, Start: day('2026-02-01'), Tags: ['L', 'Mobile'] },
    { Name: 'Docs', Status: 'Doing', Budget: 950, Active: false },
  ]);
  await add('Tasks', [
    { Name: 'Design', Hours: 2, Project: projects.records[0]!.id, Helpers: ['L', people.records[0]!.id] },
    {
      Name: 'Build',
      Hours: 3.5,
      Project: projects.records[0]!.id,
      Helpers: ['L', people.records[0]!.id, people.records[1]!.id],
    },
    { Name: 'Plan', Hours: 1, Project: projects.records[1]!.id },
  ]);

  // Pages with widgets that sort, filter, and show cards.
  const tables = await call<{ records: Array<{ id: number; fields: { tableId: string } }> }>(
    'GET',
    `${doc}/tables/_grist_Tables/records`,
  );
  const columns = await call<{ records: Array<{ id: number; fields: { colId: string; parentId: number } }> }>(
    'GET',
    `${doc}/tables/_grist_Tables_column/records`,
  );
  const projectsRef = tables.records.find((row) => row.fields.tableId === 'Projects')!.id;
  const column = (id: string) =>
    columns.records.find((row) => row.fields.parentId === projectsRef && row.fields.colId === id)!.id;
  const page = async (kind: string, title: string) => {
    const made = await apply([['CreateViewSection', projectsRef, 0, kind, null, null]]);
    const { viewRef, sectionRef } = made.retValues[0]!;
    await apply([['UpdateRecord', '_grist_Views', viewRef, { name: title }]]);
    return sectionRef!;
  };
  const doing = await page('record', 'Doing');
  await apply([
    ['UpdateRecord', '_grist_Views_section', doing, { sortColRefs: JSON.stringify([-column('Budget')]) }],
    [
      'AddRecord',
      '_grist_Filters',
      null,
      {
        viewSectionRef: doing,
        colRef: column('Status'),
        filter: JSON.stringify({ included: ['Doing'] }),
        pinned: true,
      },
    ],
  ]);
  const big = await page('record', 'Big budgets');
  await apply([
    [
      'AddRecord',
      '_grist_Filters',
      null,
      { viewSectionRef: big, colRef: column('Budget'), filter: JSON.stringify({ min: 500 }), pinned: true },
    ],
  ]);
  await page('detail', 'Cards');
  await page('chart', 'Chart');
  return { docId, name };
}

export async function removeGristDocument(url: string, key: string, docId: string): Promise<void> {
  await client(url, key)('DELETE', `/api/docs/${docId}`);
}

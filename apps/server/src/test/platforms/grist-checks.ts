import assert from 'node:assert/strict';
import type { Imported } from './harness.js';

/** The recording the unit tests replay, next to this file */
export const GRIST_RECORDING = 'grist.recording.json';

/** What importing the seeded Grist document has to bring across, live or from its recording. */
export async function checkGristImport(imported: Imported): Promise<void> {
  const { schema, field, job } = imported;
  const types = (table: string) =>
    Object.fromEntries(imported.fields(table).map((item) => [item.name, item.type]));
  // Tables in the order the document's pages list them.
  assert.deepEqual(
    schema.tables.map((table) => table.name),
    ['People', 'Projects', 'Tasks'],
  );
  assert.deepEqual(types('Projects'), {
    Name: 'text',
    Notes: 'longText',
    Brief: 'longText',
    Site: 'url',
    Count: 'number',
    Budget: 'currency',
    Share: 'percent',
    Weight: 'number',
    Active: 'checkbox',
    Start: 'date',
    Due: 'date',
    Status: 'singleSelect',
    Tags: 'multipleSelect',
    Files: 'attachment',
    Anything: 'text',
    Code: 'text',
    Label: 'formula',
    Double: 'formula',
    Shout: 'formula',
    Rounded: 'formula',
    Tidy: 'formula',
    Hours: 'rollup',
    Tripled: 'number',
    Proper: 'text',
    'Task count': 'count',
    'Task names': 'lookup',
    Tasks: 'link',
    Lead: 'link',
  });
  assert.deepEqual(types('Tasks'), { Name: 'text', Hours: 'number', Project: 'link', Helpers: 'link' });
  // One-way references show on both tables here, and those fields stay out of People's views.
  assert.deepEqual(types('People'), { Name: 'text', Email: 'text', Projects: 'link', Tasks: 'link' });
  assert.deepEqual(imported.view('People', 'People').config.hiddenFieldIds, [
    field('People', 'Projects').id,
    field('People', 'Tasks').id,
  ]);

  const status = field('Projects', 'Status');
  assert.ok(status.type === 'singleSelect');
  assert.deepEqual(
    status.options.choices.map((choice) => `${choice.name}:${choice.color}`),
    ['Todo:blue', 'Doing:yellow', 'Done:green'],
  );
  assert.deepEqual(field('Projects', 'Budget').options, { code: 'EUR', precision: 2, allowNegative: true });
  assert.deepEqual(field('Projects', 'Share').options, { precision: 1, allowNegative: true });
  assert.deepEqual(field('Projects', 'Brief').options, { richText: true });
  assert.deepEqual(field('Projects', 'Due').options, {
    includeTime: true,
    dateFormat: 'us',
    timeFormat: '12h',
    timeZone: 'America/New_York',
  });
  // Grist's two-way references come across as one link, seen from both tables.
  assert.equal(
    (field('Tasks', 'Project').options as { inverseFieldId: string }).inverseFieldId,
    field('Projects', 'Tasks').id,
  );

  const website = await imported.record('Projects', 'Website');
  const choice = (name: string) =>
    status.type === 'singleSelect' ? status.options.choices.find((item) => item.name === name)!.id : '';
  const { Tags, Files, Tasks, Lead, ...plain } = website;
  assert.deepEqual(plain, {
    Name: 'Website',
    Notes: 'Line one\nLine two',
    Brief: '**Bold** start',
    Site: 'https://example.com/website',
    Count: 3,
    Budget: 800,
    Share: 0.5,
    Weight: 1.25,
    Active: true,
    Start: '2026-01-05',
    Due: '2026-01-20T15:30:00.000Z',
    Status: choice('Doing'),
    Anything: 'hello',
    Code: 'WEBSITE',
    Label: 'Website (Doing)',
    Double: 1600,
    Shout: 'WEBSITE',
    Rounded: 3.8,
    Tidy: 'website',
    Hours: 5.5,
    Tripled: 9,
    Proper: 'Website',
    'Task count': 2,
    'Task names': ['Design', 'Build'],
  });
  assert.equal((Tags as string[]).length, 2);
  assert.equal((Files as string[]).length, 1);
  const projects = await imported.rows('Projects');
  const names = (page: typeof projects, ids: unknown) =>
    (ids as string[]).map((id) => page.linked?.[id] ?? id);
  assert.deepEqual(names(projects, Lead), ['Ada']);
  assert.deepEqual(names(projects, Tasks), ['Design', 'Build']);
  const build = await imported.record('Tasks', 'Build');
  const tasks = await imported.rows('Tasks');
  assert.deepEqual(names(tasks, build.Helpers), ['Ada', 'Grace']);
  assert.equal(job.report!.files, 1);
  assert.equal(job.report!.records, 8);

  // Formulas that translate are formulas here, and lookups through a reference are rollups.
  assert.equal(
    (field('Projects', 'Label').options as { expression: string }).expression,
    `((({${field('Projects', 'Name').id}} & " (") & {${status.id}}) & ")")`,
  );
  assert.deepEqual(field('Projects', 'Hours').options, {
    linkFieldId: field('Projects', 'Tasks').id,
    targetFieldId: field('Tasks', 'Hours').id,
    fn: 'sum',
    precision: null,
    resultType: 'number',
  });
  for (const name of ['Label', 'Double', 'Shout', 'Rounded', 'Tidy'])
    assert.equal(
      imported.item('Projects', name, 'import.platform.report.formulaTranslated').status,
      'exact',
      name,
    );

  // Each widget on a page is a view, with its columns, sort, and filter.
  assert.deepEqual(
    schema.views.filter((view) => view.tableId === status.tableId).map((view) => `${view.name}:${view.type}`),
    ['Projects:grid', 'Doing:grid', 'Big budgets:grid', 'Cards:gallery'],
  );
  const doing = imported.view('Projects', 'Doing').config;
  assert.deepEqual(doing.filter, {
    conjunction: 'and',
    conditions: [{ id: 'imported0', fieldId: status.id, operator: 'is', value: choice('Doing') }],
  });
  assert.deepEqual(doing.sorts, [{ fieldId: field('Projects', 'Budget').id, direction: 'desc' }]);
  assert.deepEqual(
    (await imported.rows('Projects', 'Doing')).rows.map((row) => row?.values[field('Projects', 'Name').id]),
    ['Docs', 'Website'],
  );
  assert.deepEqual(imported.view('Projects', 'Big budgets').config.filter?.conditions, [
    { id: 'imported0', fieldId: field('Projects', 'Budget').id, operator: 'gte', value: 500 },
  ]);

  const changed = job
    .report!.items.filter((item) => item.status !== 'exact')
    .map(
      (item) =>
        `${item.table ?? ''}.${item.name ?? ''} ${item.messageKey.replace('import.platform.report.', '')}`,
    );
  assert.deepEqual(changed.sort(), [
    '. notShared',
    'Projects.Anything anyText',
    'Projects.Chart viewUnsupported',
    'Projects.Code triggerFormula',
    'Projects.Hours formulaRelation',
    'Projects.Lead linkBothWays',
    'Projects.Proper formulaFunctions',
    'Projects.Site linkLabels',
    'Projects.Task count formulaRelation',
    'Projects.Task names formulaRelation',
    'Projects.Tripled formulaUnread',
    'Tasks.Helpers linkBothWays',
  ]);
}

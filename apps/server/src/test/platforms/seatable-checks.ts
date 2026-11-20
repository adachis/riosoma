import assert from 'node:assert/strict';
import type { FilterGroup } from '@riosoma/contracts';
import type { Imported } from './harness.js';

/** The recording the unit tests replay, next to this file */
export const SEATABLE_RECORDING = 'seatable.recording.json';

/** What the recording keeps in place of the tokens it was made with */
export const RECORDED_TOKENS = {
  api: 'recorded-api-token',
  base: 'recorded-base-token',
};

/** What importing the seeded SeaTable base has to bring across, live or from its recording. */
export async function checkSeaTableImport(imported: Imported): Promise<void> {
  const { schema, field, job } = imported;
  const types = (table: string) =>
    Object.fromEntries(imported.fields(table).map((item) => [item.name, item.type]));
  assert.deepEqual(
    schema.tables.map((table) => table.name),
    ['Projects', 'Tasks', 'People'],
  );
  assert.deepEqual(types('Projects'), {
    Title: 'text',
    Id: 'autoNumber',
    Notes: 'longText',
    Count: 'number',
    Weight: 'number',
    Budget: 'currency',
    Share: 'percent',
    Price: 'currency',
    Fee: 'number',
    Start: 'date',
    Due: 'date',
    Made: 'date',
    Changed: 'date',
    Estimate: 'duration',
    Active: 'checkbox',
    Score: 'rating',
    Status: 'singleSelect',
    Tags: 'multipleSelect',
    Cover: 'attachment',
    Files: 'attachment',
    Owner: 'text',
    Author: 'text',
    Editor: 'text',
    Site: 'url',
    Contact: 'email',
    Place: 'location',
    Region: 'text',
    Summary: 'formula',
    Double: 'formula',
    Shown: 'text',
    'Task names': 'lookup',
    Hours: 'rollup',
    'Task count': 'count',
    Longest: 'text',
    Tasks: 'link',
  });
  assert.deepEqual(types('Tasks'), {
    Name: 'text',
    Id: 'autoNumber',
    Hours: 'number',
    Project: 'link',
    People: 'link',
  });
  assert.deepEqual(types('People'), { Name: 'text', Id: 'autoNumber', Email: 'email', Tasks: 'link' });

  // Options keep their names and colors, and formats their settings.
  const status = field('Projects', 'Status');
  assert.ok(status.type === 'singleSelect');
  assert.deepEqual(
    status.options.choices.map((choice) => `${choice.name}:${choice.color}`),
    ['Todo:blue', 'Doing:teal', 'Done:green'],
  );
  assert.deepEqual(field('Projects', 'Notes').options, { richText: true });
  assert.deepEqual(field('Projects', 'Count').options, {
    precision: null,
    thousands: true,
    allowNegative: true,
  });
  assert.deepEqual(field('Projects', 'Weight').options, {
    precision: 2,
    thousands: false,
    allowNegative: true,
  });
  assert.deepEqual(field('Projects', 'Budget').options, {
    code: 'USD',
    precision: 2,
    allowNegative: true,
  });
  assert.deepEqual(field('Projects', 'Price').options, {
    code: 'CHF',
    precision: 2,
    allowNegative: true,
  });
  assert.deepEqual(field('Projects', 'Share').options, { precision: 0, allowNegative: true });
  assert.deepEqual(field('Projects', 'Estimate').options, { format: 'h:mm:ss' });
  assert.deepEqual(field('Projects', 'Score').options, { max: 5, icon: 'star', color: 'yellow' });
  assert.deepEqual(field('Projects', 'Start').options, {
    includeTime: false,
    dateFormat: 'iso',
    timeFormat: 'local',
    timeZone: 'client',
  });
  assert.deepEqual(field('Projects', 'Due').options, {
    includeTime: true,
    dateFormat: 'iso',
    timeFormat: '24h',
    timeZone: 'client',
  });

  // Every value, in the shape Riosoma keeps it.
  const website = await imported.record('Projects', 'Website');
  const choice = (name: string) =>
    status.type === 'singleSelect' ? status.options.choices.find((item) => item.name === name)!.id : '';
  assert.deepEqual(
    {
      Title: website.Title,
      Id: website.Id,
      Notes: website.Notes,
      Count: website.Count,
      Weight: website.Weight,
      Budget: website.Budget,
      Share: website.Share,
      Price: website.Price,
      Fee: website.Fee,
      Start: website.Start,
      Due: website.Due,
      Estimate: website.Estimate,
      Active: website.Active,
      Score: website.Score,
      Status: website.Status,
      Site: website.Site,
      Contact: website.Contact,
      Place: website.Place,
      Region: website.Region,
      Summary: website.Summary,
      Double: website.Double,
      Shown: website.Shown,
      Longest: website.Longest,
      'Task names': website['Task names'],
      Hours: website.Hours,
      'Task count': website['Task count'],
    },
    {
      Title: 'Website',
      Id: 1,
      Notes: 'Line one\nLine two',
      Count: 3,
      Weight: 1.25,
      Budget: 800,
      Share: 0.5,
      Price: 1200,
      Fee: 15,
      Start: '2026-01-05',
      Due: '2026-01-20T15:30:00.000Z',
      Estimate: 5400,
      Active: true,
      Score: 2,
      Status: choice('Doing'),
      Site: 'https://example.com/website',
      Contact: 'ada@example.com',
      Place: { lat: 37.7749, lng: -122.4194, label: null },
      Region: 'Sweden',
      Summary: 'Website (Doing)',
      Double: 1600,
      Shown: '3.00',
      Longest: 'Build',
      'Task names': ['Design', 'Build'],
      Hours: 5.5,
      'Task count': 2,
    },
  );
  const tags = field('Projects', 'Tags');
  assert.ok(tags.type === 'multipleSelect');
  assert.deepEqual(
    (website.Tags as string[]).map((id) => tags.options.choices.find((item) => item.id === id)?.name),
    ['Web', 'Mobile'],
  );
  // One image SeaTable stored, one it only points at, and one file.
  assert.equal((website.Cover as string[]).length, 2);
  assert.equal((website.Files as string[]).length, 1);
  assert.equal(job.report!.files, 3);
  assert.equal(job.report!.records, 8);
  // Who made what, and when, reads the account and the moment the base was seeded with.
  assert.equal(typeof website.Owner, 'string');
  assert.equal(typeof website.Author, 'string');
  assert.equal(typeof website.Editor, 'string');
  assert.equal(typeof website.Made, 'string');
  assert.equal(typeof website.Changed, 'string');

  // Links come across both ways, from the link query rather than the row's own capped column.
  const projects = await imported.rows('Projects');
  const tasks = await imported.rows('Tasks');
  const people = await imported.rows('People');
  const names = (page: typeof projects, ids: unknown) =>
    (ids as string[]).map((id) => page.linked?.[id] ?? id);
  assert.deepEqual(names(projects, website.Tasks), ['Design', 'Build']);
  const build = await imported.record('Tasks', 'Build');
  assert.deepEqual(names(tasks, build.Project), ['Website']);
  assert.deepEqual(names(tasks, build.People).sort(), ['Ada', 'Grace']);
  const ada = await imported.record('People', 'Ada');
  assert.deepEqual(names(people, ada.Tasks).sort(), ['Build', 'Design']);
  assert.deepEqual(field('Tasks', 'Project').options, {
    linkedTableId: schema.tables[0]!.id,
    inverseFieldId: field('Projects', 'Tasks').id,
    prefersSingle: true,
  });
  assert.deepEqual(field('Projects', 'Tasks').options, {
    linkedTableId: schema.tables[1]!.id,
    inverseFieldId: field('Tasks', 'Project').id,
    prefersSingle: false,
  });

  // Computed columns read what SeaTable's read.
  assert.deepEqual(field('Projects', 'Hours').options, {
    linkFieldId: field('Projects', 'Tasks').id,
    targetFieldId: field('Tasks', 'Hours').id,
    fn: 'sum',
    precision: null,
    resultType: 'number',
  });
  assert.deepEqual(field('Projects', 'Task names').options, {
    linkFieldId: field('Projects', 'Tasks').id,
    targetFieldId: field('Tasks', 'Name').id,
    resultType: 'text',
  });
  assert.deepEqual(field('Projects', 'Task count').options, {
    linkFieldId: field('Projects', 'Tasks').id,
  });
  assert.equal(
    imported.item('Projects', 'Summary', 'import.platform.report.formulaTranslated').status,
    'exact',
  );
  assert.equal(
    imported.item('Projects', 'Double', 'import.platform.report.formulaTranslated').status,
    'exact',
  );
  assert.deepEqual(imported.item('Projects', 'Shown', 'import.platform.report.formulaFunctions').params, {
    formula: 'TEXT({Count}, "0.00")',
    functions: 'TEXT',
  });

  // Views keep their filters, sorts, and hidden columns, which is all SeaTable's views hold.
  assert.deepEqual(
    schema.views
      .filter((view) => view.tableId === schema.tables[0]!.id)
      .map((view) => `${view.name}:${view.type}`),
    ['Default View:grid', 'Doing:grid', 'Recent:grid', 'This month:grid'],
  );
  const doing = imported.view('Projects', 'Doing').config;
  assert.deepEqual(doing.filter, {
    conjunction: 'and',
    conditions: [{ id: 'imported0', fieldId: status.id, operator: 'is', value: choice('Doing') }],
  });
  assert.deepEqual(doing.sorts, [{ fieldId: field('Projects', 'Budget').id, direction: 'desc' }]);
  assert.deepEqual(doing.hiddenFieldIds, [field('Projects', 'Notes').id]);
  const recent = imported.view('Projects', 'Recent').config.filter as FilterGroup;
  assert.equal(recent.conjunction, 'or');
  assert.deepEqual(
    recent.conditions.map((condition) => ('operator' in condition ? condition.operator : 'group')),
    ['isOnOrAfter', 'hasAnyOf'],
  );
  assert.deepEqual(imported.view('Projects', 'This month').config.filter, {
    conjunction: 'and',
    conditions: [
      {
        id: 'imported0',
        fieldId: field('Projects', 'Due').id,
        operator: 'isWithin',
        value: { mode: 'pastMonth' },
      },
    ],
  });
  assert.deepEqual(
    (await imported.rows('Projects', 'Doing')).rows.map((row) => row?.values[field('Projects', 'Title').id]),
    ['Docs', 'Website'],
  );

  // The report says what changed, with the rest exact.
  const changed = job
    .report!.items.filter((item) => item.status !== 'exact')
    .map(
      (item) =>
        `${item.table ?? ''}.${item.name ?? ''} ${item.messageKey.replace('import.platform.report.', '')}`,
    );
  assert.deepEqual(changed.sort(), [
    '. notShared',
    'Projects.Author peopleFixed',
    'Projects.Author peopleText',
    'Projects.Changed timeFixed',
    'Projects.Editor peopleFixed',
    'Projects.Editor peopleText',
    'Projects.Fee currencyUnknown',
    'Projects.Longest linkFormulaKept',
    'Projects.Made timeFixed',
    'Projects.Owner peopleText',
    'Projects.Recent viewFilterPartial',
    'Projects.Recent viewGroupDropped',
    'Projects.Region placeText',
    'Projects.Send button',
    'Projects.Shown formulaFunctions',
  ]);
}

import assert from 'node:assert/strict';
import type { FilterGroup } from '@riosoma/contracts';
import type { Imported } from './harness.js';

/** The recording the unit tests replay, next to this file */
export const TEABLE_RECORDING = 'teable.recording.json';

/** What importing the seeded Teable base has to bring across, live or from its recording. */
export async function checkTeableImport(imported: Imported): Promise<void> {
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
    Brief: 'longText',
    Site: 'url',
    Contact: 'email',
    Phone: 'phone',
    Count: 'number',
    Weight: 'number',
    Budget: 'currency',
    Share: 'percent',
    Score: 'rating',
    Effort: 'rating',
    Active: 'checkbox',
    Start: 'date',
    Due: 'date',
    Made: 'date',
    Changed: 'date',
    Owner: 'text',
    Team: 'text',
    Author: 'text',
    Status: 'singleSelect',
    Tags: 'multipleSelect',
    Files: 'attachment',
    Progress: 'number',
    Summary: 'formula',
    Double: 'formula',
    Ago: 'text',
    'Task names': 'lookup',
    Hours: 'rollup',
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
  assert.deepEqual(field('Projects', 'Budget').options, {
    code: 'USD',
    precision: 2,
    allowNegative: true,
  });
  assert.deepEqual(field('Projects', 'Share').options, { precision: 0, allowNegative: true });
  assert.deepEqual(field('Projects', 'Brief').options, { richText: true });
  assert.deepEqual(field('Projects', 'Notes').options, { richText: false });
  assert.deepEqual(field('Projects', 'Weight').options, {
    precision: 2,
    thousands: true,
    allowNegative: true,
  });
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
    timeZone: 'Europe/Berlin',
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
      Brief: website.Brief,
      Site: website.Site,
      Contact: website.Contact,
      Phone: website.Phone,
      Count: website.Count,
      Weight: website.Weight,
      Budget: website.Budget,
      Share: website.Share,
      Score: website.Score,
      Active: website.Active,
      Start: website.Start,
      Due: website.Due,
      Status: website.Status,
      Progress: website.Progress,
      Summary: website.Summary,
      Double: website.Double,
      Ago: website.Ago,
      'Task names': website['Task names'],
      Hours: website.Hours,
    },
    {
      Title: 'Website',
      Id: 1,
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
      Active: true,
      Start: '2026-01-05',
      Due: '2026-01-20T14:30:00.000Z',
      Status: choice('Doing'),
      Progress: 60,
      Summary: 'Website (Doing)',
      Double: 1600,
      Ago: '20 days',
      'Task names': ['Design', 'Build'],
      Hours: 5.5,
    },
  );
  const tags = field('Projects', 'Tags');
  assert.ok(tags.type === 'multipleSelect');
  assert.deepEqual(
    (website.Tags as string[]).map((id) => tags.options.choices.find((item) => item.id === id)?.name),
    ['Web', 'Mobile'],
  );
  assert.equal((website.Files as string[]).length, 1);
  assert.equal(job.report!.files, 2);
  assert.equal(job.report!.records, 8);
  // Who made what, and when, reads the account and the moment the base was seeded with.
  assert.equal(typeof website.Owner, 'string');
  assert.equal(typeof website.Team, 'string');
  assert.equal(typeof website.Author, 'string');
  assert.equal(typeof website.Made, 'string');
  assert.equal(typeof website.Changed, 'string');

  // Links come across both ways, from the cells that name the records on each side.
  const projects = await imported.rows('Projects');
  const tasks = await imported.rows('Tasks');
  const names = (page: typeof projects, ids: unknown) =>
    (ids as string[]).map((id) => page.linked?.[id] ?? id);
  assert.deepEqual(names(projects, website.Tasks), ['Design', 'Build']);
  const build = await imported.record('Tasks', 'Build');
  assert.deepEqual(names(tasks, build.Project), ['Website']);
  assert.deepEqual(names(tasks, build.People).sort(), ['Ada', 'Grace']);
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

  // Computed fields read what Teable's read.
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
  assert.equal(
    imported.item('Projects', 'Summary', 'import.platform.report.formulaTranslated').status,
    'exact',
  );
  assert.equal(
    imported.item('Projects', 'Double', 'import.platform.report.formulaTranslated').status,
    'exact',
  );
  const ago = imported.item('Projects', 'Ago', 'import.platform.report.formulaFunctions');
  // The report shows the formula as Teable wrote it, naming Teable's own fields.
  assert.equal(ago.params.functions, 'FROMNOW');
  assert.match(String(ago.params.formula), /^FROMNOW\(\{fld\w+\}\)$/);

  // Views keep their fields, filters, sorts, stacks, covers, dates, and form questions.
  assert.deepEqual(
    schema.views
      .filter((view) => view.tableId === schema.tables[0]!.id)
      .map((view) => `${view.name}:${view.type}`),
    [
      'Projects:grid',
      'Doing:grid',
      'Recent:grid',
      'Pictures:gallery',
      'Board:kanban',
      'Intake:form',
      'Timeline:calendar',
    ],
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
  assert.deepEqual(
    (await imported.rows('Projects', 'Doing')).rows.map((row) => row?.values[field('Projects', 'Title').id]),
    ['Docs', 'Website'],
  );
  assert.equal(
    imported.view('Projects', 'Pictures').config.gallery.coverFieldId,
    field('Projects', 'Files').id,
  );
  assert.equal(imported.view('Projects', 'Board').config.kanban.stackFieldId, status.id);
  assert.equal(imported.view('Projects', 'Board').config.kanban.coverFieldId, field('Projects', 'Files').id);
  assert.deepEqual(imported.view('Projects', 'Timeline').config.calendar, {
    startFieldId: field('Projects', 'Start').id,
    endFieldId: field('Projects', 'Due').id,
    range: 'month',
  });
  const intake = imported.view('Projects', 'Intake').config.form;
  assert.deepEqual(
    intake.questions.map((question) => `${question.fieldId}:${question.required}`),
    [
      `${field('Projects', 'Title').id}:true`,
      `${field('Projects', 'Notes').id}:false`,
      `${status.id}:false`,
      `${field('Projects', 'Files').id}:false`,
    ],
  );
  assert.equal(intake.submitLabel, 'Send it');
  assert.equal(intake.description, 'Tell us about the work.');

  // The report says what changed, with the rest exact.
  const changed = job
    .report!.items.filter((item) => item.status !== 'exact')
    .map(
      (item) =>
        `${item.table ?? ''}.${item.name ?? ''} ${item.messageKey.replace('import.platform.report.', '')}`,
    );
  assert.deepEqual(changed.sort(), [
    '. notShared',
    'Projects.Ago formulaFunctions',
    'Projects.Author peopleFixed',
    'Projects.Author peopleText',
    'Projects.Changed timeFixed',
    'Projects.Effort ratingIcon',
    'Projects.Made timeFixed',
    'Projects.Owner peopleText',
    'Projects.Progress numberShowAs',
    'Projects.Recent viewFilterPartial',
    'Projects.Recent viewGroupDropped',
    'Projects.Ref button',
    'Projects.Team peopleText',
    'Projects.Timeline viewColors',
  ]);
}

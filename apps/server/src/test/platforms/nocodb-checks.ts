import assert from 'node:assert/strict';
import type { FilterGroup } from '@riosoma/contracts';
import type { Imported } from './harness.js';

/** The recording the unit tests replay, next to this file */
export const NOCODB_RECORDING = 'nocodb.recording.json';

/** What importing the seeded NocoDB base has to bring across, live or from its recording. */
export async function checkNocodbImport(imported: Imported): Promise<void> {
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
    Contact: 'email',
    Site: 'url',
    Phone: 'phone',
    Count: 'number',
    Weight: 'number',
    Budget: 'currency',
    Share: 'percent',
    Estimate: 'duration',
    Score: 'rating',
    Active: 'checkbox',
    Start: 'date',
    Due: 'date',
    Alarm: 'text',
    Year: 'number',
    Status: 'singleSelect',
    Tags: 'multipleSelect',
    Place: 'location',
    Data: 'json',
    Files: 'attachment',
    Owner: 'text',
    Made: 'date',
    Author: 'text',
    Label: 'formula',
    Double: 'formula',
    Link: 'text',
    Code: 'text',
    QR: 'text',
    'Task names': 'lookup',
    Hours: 'rollup',
    Tasks: 'link',
  });
  assert.deepEqual(types('Tasks'), {
    Name: 'text',
    Id: 'autoNumber',
    Hours: 'number',
    Projects: 'link',
    People: 'link',
  });
  assert.deepEqual(types('People'), { Name: 'text', Id: 'autoNumber', Email: 'email', Tasks: 'link' });

  // Options keep their names and colors, and formats their settings.
  const status = field('Projects', 'Status');
  assert.ok(status.type === 'singleSelect');
  assert.deepEqual(
    status.options.choices.map((choice) => `${choice.name}:${choice.color}`),
    ['Todo:blue', 'Doing:teal', 'Done:teal'],
  );
  assert.deepEqual(field('Projects', 'Budget').options, { code: 'USD', precision: 2, allowNegative: true });
  assert.deepEqual(field('Projects', 'Estimate').options, { format: 'h:mm:ss' });
  assert.deepEqual(field('Projects', 'Brief').options, { richText: true });
  assert.deepEqual(field('Projects', 'Weight').options, {
    precision: 2,
    thousands: true,
    allowNegative: true,
  });
  assert.deepEqual(field('Projects', 'Start').options, {
    includeTime: false,
    dateFormat: 'iso',
    timeFormat: 'local',
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
      Brief: website.Brief,
      Contact: website.Contact,
      Site: website.Site,
      Phone: website.Phone,
      Count: website.Count,
      Weight: website.Weight,
      Budget: website.Budget,
      Share: website.Share,
      Estimate: website.Estimate,
      Score: website.Score,
      Active: website.Active,
      Start: website.Start,
      Due: website.Due,
      Alarm: website.Alarm,
      Year: website.Year,
      Status: website.Status,
      Place: website.Place,
      Data: website.Data,
      Label: website.Label,
      Double: website.Double,
      Code: website.Code,
      'Task names': website['Task names'],
      Hours: website.Hours,
    },
    {
      Title: 'Website',
      Id: 1,
      Notes: 'Line one\nLine two',
      Brief: '**Bold** start',
      Contact: 'ada@example.com',
      Site: 'https://example.com/website',
      Phone: '555-0100',
      Count: 3,
      Weight: 1.25,
      Budget: 800,
      Share: 0.5,
      Estimate: 5400,
      Score: 2,
      Active: true,
      Start: '2026-01-05',
      Due: '2026-01-20T15:30:00.000Z',
      Alarm: '08:30:00',
      Year: 2026,
      Status: choice('Doing'),
      Place: { lat: 37.7749, lng: -122.4194, label: null },
      Data: '{"stage":1}',
      Label: 'Website (Doing)',
      Double: 1600,
      Code: 'Website',
      'Task names': ['Design', 'Build'],
      Hours: 5.5,
    },
  );
  assert.equal((website.Tags as string[]).length, 2);
  assert.equal((website.Files as string[]).length, 1);
  assert.equal(typeof website.Owner, 'string');
  assert.equal(job.report!.files, 1);
  assert.equal(job.report!.records, 8);

  // Links come across both ways, from cells that name the record and from ones that only count them.
  const tasks = await imported.rows('Tasks');
  const people = await imported.rows('People');
  const names = (page: typeof tasks, ids: unknown) => (ids as string[]).map((id) => page.linked?.[id] ?? id);
  const projects = await imported.rows('Projects');
  assert.deepEqual(names(projects, website.Tasks), ['Design', 'Build']);
  const build = await imported.record('Tasks', 'Build');
  assert.deepEqual(names(tasks, build.People).sort(), ['Ada', 'Grace']);
  assert.deepEqual(names(tasks, build.Projects), ['Website']);
  const ada = await imported.record('People', 'Ada');
  assert.deepEqual(names(people, ada.Tasks).sort(), ['Build', 'Design']);
  assert.deepEqual(field('Tasks', 'Projects').options, {
    linkedTableId: schema.tables[0]!.id,
    inverseFieldId: field('Projects', 'Tasks').id,
    prefersSingle: true,
  });

  // Computed fields read what NocoDB's read.
  assert.deepEqual(field('Projects', 'Hours').options, {
    linkFieldId: field('Projects', 'Tasks').id,
    targetFieldId: field('Tasks', 'Hours').id,
    fn: 'sum',
    precision: null,
    resultType: 'number',
  });
  assert.equal(
    imported.item('Projects', 'Label', 'import.platform.report.formulaTranslated').status,
    'exact',
  );
  assert.deepEqual(imported.item('Projects', 'Link', 'import.platform.report.formulaFunctions').params, {
    formula: 'URL({Site})',
    functions: 'URL',
  });

  // Views keep their filters, sorts, stacks, covers, places, and fields.
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
      'Places:map',
    ],
  );
  const doing = imported.view('Projects', 'Doing').config;
  assert.deepEqual(doing.filter, {
    conjunction: 'and',
    conditions: [{ id: 'imported0', fieldId: status.id, operator: 'is', value: choice('Doing') }],
  });
  assert.deepEqual(doing.sorts, [{ fieldId: field('Projects', 'Budget').id, direction: 'desc' }]);
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
  assert.equal(imported.view('Projects', 'Places').config.map.locationFieldId, field('Projects', 'Place').id);
  assert.ok(
    imported
      .view('Projects', 'Intake')
      .config.form.questions.some((question) => question.fieldId === status.id),
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
    'Projects.Alarm timeText',
    'Projects.Author peopleFixed',
    'Projects.Author peopleText',
    'Projects.Code codeText',
    'Projects.Link formulaFunctions',
    'Projects.Made timeFixed',
    'Projects.Owner peopleText',
    'Projects.QR codeText',
  ]);
}

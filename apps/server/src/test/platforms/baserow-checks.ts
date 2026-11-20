import assert from 'node:assert/strict';
import type { Imported } from './harness.js';

/** The recording the unit tests replay, next to this file */
export const BASEROW_RECORDING = 'baserow.recording.json';

/** What the recording keeps in place of the tokens it was made with */
export const RECORDED_TOKENS = {
  database: 'recorded-database-token',
  access: 'recorded-access-token',
  refresh: 'recorded-refresh-token',
};

/**
 * What importing the seeded Baserow database has to bring across, live or from its recording:
 * everything but views with a database token, and views as well when signed in.
 */
export async function checkBaserowImport(imported: Imported, signedIn: boolean): Promise<void> {
  const { schema, field, job } = imported;
  const types = (table: string) =>
    Object.fromEntries(imported.fields(table).map((item) => [item.name, item.type]));
  assert.deepEqual(
    schema.tables.map((table) => table.name),
    ['People', 'Projects', 'Tasks'],
  );
  assert.deepEqual(types('Projects'), {
    Name: 'text',
    Notes: 'longText',
    Brief: 'longText',
    Site: 'url',
    Contact: 'email',
    Phone: 'phone',
    Count: 'number',
    Budget: 'currency',
    Share: 'percent',
    Weight: 'number',
    Score: 'rating',
    Active: 'checkbox',
    Start: 'date',
    End: 'date',
    Due: 'date',
    Estimate: 'duration',
    Status: 'singleSelect',
    Tags: 'multipleSelect',
    Files: 'attachment',
    Owner: 'user',
    Made: 'date',
    Author: 'text',
    Serial: 'autoNumber',
    Key: 'text',
    Label: 'formula',
    Double: 'formula',
    Shout: 'formula',
    Since: 'number',
    'Task count': 'count',
    Hours: 'rollup',
    'Task names': 'lookup',
    'Most hours': 'rollup',
    Tasks: 'link',
    Lead: 'link',
  });
  assert.deepEqual(types('Tasks'), { Name: 'text', Hours: 'number', People: 'link', Projects: 'link' });
  assert.deepEqual(types('People'), { Name: 'text', Email: 'email', Tasks: 'link', Projects: 'link' });

  const status = field('Projects', 'Status');
  assert.ok(status.type === 'singleSelect');
  assert.deepEqual(
    status.options.choices.map((choice) => `${choice.name}:${choice.color}`),
    ['Todo:blue', 'Doing:yellow', 'Done:green'],
  );
  // A number with a dollar sign before it is an amount, and one with a percent sign after it a percent.
  // Baserow's numbers aren't negative unless the field says they can be.
  assert.deepEqual(field('Projects', 'Budget').options, { code: 'USD', precision: 2, allowNegative: false });
  assert.deepEqual(field('Projects', 'Share').options, { precision: 1, allowNegative: false });
  assert.deepEqual(field('Projects', 'Score').options, { max: 5, icon: 'heart', color: 'orange' });
  assert.deepEqual(field('Projects', 'Due').options, {
    includeTime: true,
    dateFormat: 'us',
    timeFormat: '12h',
    timeZone: 'America/New_York',
  });
  assert.deepEqual(field('Projects', 'Estimate').options, { format: 'h:mm:ss' });

  const website = await imported.record('Projects', 'Website');
  const choice = (name: string) =>
    status.type === 'singleSelect' ? status.options.choices.find((item) => item.name === name)!.id : '';
  const { Tags, Files, Tasks, Lead, Made, Key, ...plain } = website;
  assert.deepEqual(plain, {
    Name: 'Website',
    Notes: 'Line one\nLine two',
    Brief: '**Bold** start',
    Site: 'https://example.com/website',
    Contact: 'ada@example.com',
    Phone: '555-0100',
    Count: 3,
    Budget: 800,
    Share: 0.5,
    Weight: 1.25,
    Score: 2,
    Active: true,
    Start: '2026-01-05',
    End: '2026-01-20',
    Due: '2026-01-20T15:30:00.000Z',
    Estimate: 5400,
    Status: choice('Doing'),
    Owner: null,
    Author: 'Owner',
    Serial: 1,
    Label: 'Website (Doing)',
    Double: 1600,
    Shout: 'WEBSITE',
    Since: 15,
    'Task count': 2,
    Hours: 5.5,
    'Task names': ['Design', 'Build'],
    'Most hours': 3.5,
  });
  assert.match(String(Made), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(String(Key), /^[0-9a-f-]{36}$/);
  assert.equal((Tags as string[]).length, 2);
  assert.equal((Files as string[]).length, 1);
  const projects = await imported.rows('Projects');
  const tasks = await imported.rows('Tasks');
  const names = (page: typeof tasks, ids: unknown) => (ids as string[]).map((id) => page.linked?.[id] ?? id);
  assert.deepEqual(names(projects, Tasks), ['Design', 'Build']);
  assert.deepEqual(names(projects, Lead), ['Ada']);
  const build = await imported.record('Tasks', 'Build');
  assert.deepEqual(names(tasks, build.People), ['Ada', 'Grace']);
  assert.deepEqual(names(tasks, build.Projects), ['Website']);
  assert.equal(job.report!.files, 1);
  assert.equal(job.report!.records, 8);

  // Rollups, lookups, and counts keep what they read, and so does a formula that rolls a lookup up.
  assert.deepEqual(field('Projects', 'Most hours').options, {
    linkFieldId: field('Projects', 'Tasks').id,
    targetFieldId: field('Tasks', 'Hours').id,
    fn: 'max',
    precision: null,
    resultType: 'number',
  });
  assert.deepEqual(field('Projects', 'Task count').options, { linkFieldId: field('Projects', 'Tasks').id });
  for (const name of ['Label', 'Double', 'Shout'])
    assert.equal(
      imported.item('Projects', name, 'import.platform.report.formulaTranslated').status,
      'exact',
      name,
    );

  const changed = job
    .report!.items.filter((item) => item.status !== 'exact')
    .map(
      (item) =>
        `${item.table ?? ''}.${item.name ?? ''} ${item.messageKey.replace('import.platform.report.', '')}`,
    );
  const always = [
    '. notShared',
    'Projects.Author peopleFixed',
    'Projects.Author peopleText',
    'Projects.Key uuidText',
    'Projects.Lead linkBothWays',
    'Projects.Made timeFixed',
    // Baserow's maximum of no records is 0, and Riosoma's is empty.
    'Projects.Most hours formulaDiffers',
    'Projects.Secret password',
    'Projects.Since formulaFunctions',
    'Projects.Weight numberAffixes',
  ];
  if (!signedIn) {
    // Baserow shares views only with people who sign in.
    assert.deepEqual(
      changed.sort(),
      [...always, '. viewsNeedSignIn', 'People. viewAdded', 'Projects. viewAdded', 'Tasks. viewAdded'].sort(),
    );
    return;
  }
  assert.deepEqual(changed.sort(), always.sort());
  assert.deepEqual(
    schema.views.filter((view) => view.tableId === status.tableId).map((view) => `${view.name}:${view.type}`),
    [
      'Grid:grid',
      'Doing:grid',
      'Recent:grid',
      'Board:kanban',
      'Pictures:gallery',
      'Calendar:calendar',
      'Plan:timeline',
      'Intake:form',
    ],
  );
  const doing = imported.view('Projects', 'Doing').config;
  assert.deepEqual(doing.filter, {
    conjunction: 'and',
    conditions: [{ id: 'imported0', fieldId: status.id, operator: 'is', value: choice('Doing') }],
  });
  assert.deepEqual(doing.sorts, [{ fieldId: field('Projects', 'Budget').id, direction: 'desc' }]);
  assert.deepEqual(doing.hiddenFieldIds, [field('Projects', 'Notes').id]);
  assert.deepEqual(
    (await imported.rows('Projects', 'Doing')).rows.map((row) => row?.values[field('Projects', 'Name').id]),
    ['Docs', 'Website'],
  );
  const recent = imported.view('Projects', 'Recent').config.filter!;
  assert.equal(recent.conjunction, 'or');
  assert.deepEqual(
    recent.conditions.map((condition) => ('operator' in condition ? condition.operator : 'group')),
    ['isOnOrAfter', 'hasAnyOf'],
  );
  assert.equal(imported.view('Projects', 'Board').config.kanban.stackFieldId, status.id);
  assert.equal(imported.view('Projects', 'Board').config.kanban.coverFieldId, field('Projects', 'Files').id);
  assert.equal(
    imported.view('Projects', 'Pictures').config.gallery.coverFieldId,
    field('Projects', 'Files').id,
  );
  assert.equal(
    imported.view('Projects', 'Calendar').config.calendar.startFieldId,
    field('Projects', 'Start').id,
  );
  assert.deepEqual(
    [
      imported.view('Projects', 'Plan').config.timeline.startFieldId,
      imported.view('Projects', 'Plan').config.timeline.endFieldId,
    ],
    [field('Projects', 'Start').id, field('Projects', 'End').id],
  );
  assert.deepEqual(imported.view('Projects', 'Intake').config.form, {
    title: 'Tell us',
    description: 'About it',
    questions: [
      { fieldId: field('Projects', 'Name').id, required: true, label: 'Project name', help: '' },
      { fieldId: status.id, required: false, label: '', help: 'Where it is' },
    ],
    submitLabel: 'Send',
    thankYou: '',
    allowAnother: true,
    allowEdits: false,
    editLinkDays: 30,
    editConfirmationEmail: false,
  });
}

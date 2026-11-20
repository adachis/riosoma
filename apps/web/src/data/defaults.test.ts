import { afterEach, expect, it } from 'vitest';
import { dayIn, newId, type Command } from '@riosoma/contracts';
import { openDatabase } from '.';
import { FakeServer } from './testing';

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});

it('shows a new record’s defaults while it’s added, and sends the time zone a day that follows each person needs', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(0);
  const session = await openDatabase(fixture.databaseId, server.deps());
  dispose.push(() => session.close());
  const due = newId('field');
  await session.run([
    {
      kind: 'field.update',
      fieldId: fixture.textFieldId,
      options: { defaultValue: { kind: 'value', value: 'Draft' } },
    },
    {
      kind: 'field.create',
      tableId: fixture.tableId,
      field: { id: due, name: 'Due', type: 'date', options: { defaultValue: { kind: 'today' } } },
    },
  ]).done;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const id = newId('record');
  const added = session.run([
    {
      kind: 'record.create',
      tableId: fixture.tableId,
      records: [{ id, values: { [fixture.numberFieldId]: 2 } }],
    },
  ]);
  // The row shows its defaults before the server answers, beside the value given.
  expect(session.cachedRecord(fixture.tableId, id)?.values).toMatchObject({
    [fixture.textFieldId]: 'Draft',
    [fixture.numberFieldId]: 2,
    [due]: dayIn(zone, new Date()),
  });
  await added.done;
  const sent = server.requests
    .filter((request) => request.path.endsWith('/commands'))
    .flatMap((request) => (request.options.body as { commands: Command[] }).commands)
    .find((command) => command.kind === 'record.create');
  expect(sent).toMatchObject({ timeZone: zone, records: [{ id, values: { [fixture.numberFieldId]: 2 } }] });
  expect(session.cachedRecord(fixture.tableId, id)?.values[fixture.textFieldId]).toBe('Draft');

  // A value someone gives, even an empty one, stays.
  const empty = newId('record');
  session.run([
    {
      kind: 'record.create',
      tableId: fixture.tableId,
      records: [{ id: empty, values: { [fixture.textFieldId]: null } }],
    },
  ]);
  expect(session.cachedRecord(fixture.tableId, empty)?.values[fixture.textFieldId]).toBeNull();
});

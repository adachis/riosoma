import { expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { fillCommands } from './plans.js';

it('fills mapped output identities in a joined-table preview without changing the source order', () => {
  const base = newId('table');
  const side = newId('table');
  const left = newId('field');
  const right = newId('field');
  const sources = [
    { tableId: base, fieldId: left },
    { tableId: side, fieldId: right },
  ];
  const commands = fillCommands({
    databaseId: newId('database'),
    summary: 'Combine corresponding key columns.',
    steps: ['Use the first nonempty source value.'],
    commands: [
      {
        kind: 'table.create',
        table: {
          name: 'Joined keys',
          fields: [{ name: 'Key', type: 'text' }],
          view: { name: 'Grid' },
          joined: {
            baseTableId: base,
            steps: [
              { tableId: side, leftTableId: base, leftFieldId: left, rightFieldId: right, kind: 'full' },
            ],
            fields: [{ sources }],
          },
        },
      },
    ],
  });
  const command = commands[0]!;
  expect(command.kind).toBe('table.create');
  if (command.kind !== 'table.create') throw new Error('Expected a table creation.');
  expect(command.table.joined!.fields[0]).toEqual({
    ...sources[0],
    sources,
    outputFieldId: command.table.fields[0]!.id,
  });
  expect(command.table.id).toMatch(/^tbl/);
});

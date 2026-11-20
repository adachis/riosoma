import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { newId, type ChoiceColor, type DatabaseCreate } from '@riosoma/contracts';

export interface NewDatabaseValues {
  name: string;
  color: ChoiceColor;
}

export function newDatabasePayload(
  { name, color }: NewDatabaseValues,
  t: (message: MessageDescriptor) => string,
): DatabaseCreate {
  return {
    id: newId('database'),
    name: name.trim(),
    color,
    icon: null,
    table: {
      id: newId('table'),
      name: t(msg({ id: 'home.default.table', message: 'Table 1' })),
      description: '',
      view: { id: newId('view'), name: t(msg({ id: 'home.default.view', message: 'Grid' })) },
      fields: [
        {
          id: newId('field'),
          name: t(msg({ id: 'home.default.name', message: 'Name' })),
          description: '',
          type: 'text',
          options: {},
        },
        {
          id: newId('field'),
          name: t(msg({ id: 'home.default.notes', message: 'Notes' })),
          description: '',
          type: 'longText',
          options: { richText: false },
        },
        {
          id: newId('field'),
          name: t(msg({ id: 'home.default.status', message: 'Status' })),
          description: '',
          type: 'singleSelect',
          options: {
            choices: [
              {
                id: newId('choice'),
                name: t(msg({ id: 'home.default.todo', message: 'Todo' })),
                color: 'gray',
              },
              {
                id: newId('choice'),
                name: t(msg({ id: 'home.default.inProgress', message: 'In progress' })),
                color: 'blue',
              },
              {
                id: newId('choice'),
                name: t(msg({ id: 'home.default.done', message: 'Done' })),
                color: 'green',
              },
            ],
          },
        },
      ],
      records: Array.from({ length: 3 }, () => ({ id: newId('record') })),
    },
  };
}

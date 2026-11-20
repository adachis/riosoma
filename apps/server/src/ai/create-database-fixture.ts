/** A small linked database exercises the blueprint independently of starter definitions. */
export function databaseBlueprint(ownerId?: string) {
  return {
    name: 'Project tracker',
    icon: 'list-check',
    color: 'blue',
    summary: 'Create a project tracker',
    steps: ['Create projects and tasks with linked sample records'],
    tables: [
      {
        key: 'projects',
        name: 'Projects',
        fields: [
          { key: 'name', name: 'Project', type: 'text' },
          {
            key: 'tasks',
            name: 'Tasks',
            type: 'link',
            inverse: true,
            options: { linkedTableKey: 'tasks', inverseFieldKey: 'project' },
          },
        ],
        views: [{ key: 'grid', name: 'All projects', type: 'grid' }],
        records: [{ key: 'launch', values: { name: 'Community launch' } }],
      },
      {
        key: 'tasks',
        name: 'Tasks',
        fields: [
          { key: 'name', name: 'Task', type: 'text' },
          {
            key: 'status',
            name: 'Status',
            type: 'singleSelect',
            options: {
              choices: [
                { name: 'To do', color: 'gray' },
                { name: 'Done', color: 'green' },
              ],
            },
          },
          { key: 'due', name: 'Due date', type: 'date' },
          { key: 'owner', name: 'Owner', type: 'user' },
          { key: 'estimate', name: 'Estimate', type: 'number' },
          { key: 'total', name: 'Total', type: 'formula', options: { expression: '{Estimate} * 2' } },
          {
            key: 'project',
            name: 'Project',
            type: 'link',
            options: { linkedTableKey: 'projects', inverseFieldKey: 'tasks', prefersSingle: true },
          },
        ],
        views: [
          { key: 'grid', name: 'All tasks', type: 'grid' },
          { key: 'board', name: 'By status', type: 'kanban', stackField: 'status' },
          { key: 'calendar', name: 'Deadlines', type: 'calendar', startField: 'due' },
        ],
        records: [
          {
            key: 'invite',
            values: {
              name: 'Invite members',
              status: 'To do',
              due: '2026-10-15',
              estimate: 3,
              ...(ownerId ? { owner: [ownerId] } : {}),
              project: ['launch'],
            },
          },
        ],
      },
    ],
  };
}

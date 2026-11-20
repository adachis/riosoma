import { choices, grid, type StarterTemplate } from './types.js';

const projects = [
  'Website refresh',
  'Customer onboarding',
  'Help center',
  'Mobile checkout',
  'Spring campaign',
  'Partner portal',
  'Accessibility review',
  'Billing improvements',
  'Community launch',
  'Search improvements',
  'Product analytics',
  'Security review',
  'Team handbook',
  'Feedback program',
  'Release planning',
];
export const projectTracker: StarterTemplate = {
  id: 'project-tracker',
  name: 'Project tracker',
  description: 'Keep projects moving with linked tasks, progress, and upcoming deadlines.',
  icon: 'list-check',
  color: 'blue',
  category: 'work',
  tables: [
    {
      key: 'projects',
      name: 'Projects',
      fields: [
        { key: 'name', name: 'Project', type: 'text' },
        { key: 'goal', name: 'Goal', type: 'longText' },
        {
          key: 'priority',
          name: 'Priority',
          type: 'singleSelect',
          options: choices('Normal', 'High', 'Low'),
        },
        {
          key: 'tasks',
          name: 'Tasks',
          type: 'link',
          options: { linkedTableKey: 'tasks', inverseFieldKey: 'project' },
        },
        {
          key: 'total',
          name: 'Task count',
          type: 'rollup',
          options: { linkFieldKey: 'tasks', targetFieldKey: 'name', fn: 'countAll' },
        },
        {
          key: 'done',
          name: 'Completed tasks',
          type: 'rollup',
          options: { linkFieldKey: 'tasks', targetFieldKey: 'done', fn: 'count' },
        },
        {
          key: 'progress',
          name: 'Progress',
          type: 'formula',
          options: { expression: 'IF({Task count} > 0, {Completed tasks} / {Task count}, 0)', precision: 2 },
        },
      ],
      views: [grid],
      records: projects.map((name, i) => ({
        key: `project-${i}`,
        values: {
          name,
          goal: `Deliver a practical first version of ${name.toLowerCase()} and gather feedback.`,
          priority: i % 3 === 0 ? 'High' : 'Normal',
          tasks: [`task-${i * 2}`, `task-${i * 2 + 1}`],
        },
      })),
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
          options: choices('Planned', 'In progress', 'Done'),
        },
        { key: 'due', name: 'Due date', type: 'date' },
        { key: 'effort', name: 'Estimated hours', type: 'number' },
        { key: 'review', name: 'Needs review', type: 'checkbox' },
        {
          key: 'project',
          name: 'Project',
          type: 'link',
          inverse: true,
          options: { linkedTableKey: 'projects', inverseFieldKey: 'tasks', prefersSingle: true },
        },
        {
          key: 'done',
          name: 'Completed on',
          description:
            'Set the completion date when a task is done.  Project progress counts tasks with a completion date.',
          type: 'date',
        },
      ],
      views: [
        grid,
        { key: 'status', name: 'By status', type: 'kanban', stackField: 'status' },
        { key: 'due', name: 'Due dates', type: 'calendar', startField: 'due' },
      ],
      records: Array.from({ length: 30 }, (_, i) => ({
        key: `task-${i}`,
        values: {
          name: `${i % 2 ? 'Review prototype' : 'Define scope'}: ${projects[Math.floor(i / 2)]}`,
          status: ['Planned', 'In progress', 'Done'][i % 3]!,
          due: { days: i - 5 },
          effort: 2 + (i % 7),
          review: i % 4 === 0,
          done: i % 3 === 2 ? { days: -1 - Math.floor(i / 3) } : null,
        },
      })),
    },
  ],
};

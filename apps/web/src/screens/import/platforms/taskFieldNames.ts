import type { I18n, MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { TaskImportField } from '@riosoma/contracts';

const NAMES: Record<TaskImportField, MessageDescriptor> = {
  name: msg({ id: 'import.platform.fields.name', message: 'Name' }),
  description: msg({ id: 'import.platform.fields.description', message: 'Description' }),
  status: msg({ id: 'import.platform.fields.status', message: 'Status' }),
  followers: msg({ id: 'import.platform.fields.followers', message: 'Followers' }),
  customFields: msg({ id: 'import.platform.fields.customFields', message: 'Custom field values' }),
  assignees: msg({ id: 'import.platform.fields.assignees', message: 'Assignees' }),
  start: msg({ id: 'import.platform.fields.start', message: 'Start date' }),
  due: msg({ id: 'import.platform.fields.due', message: 'Due date' }),
  created: msg({ id: 'import.platform.fields.created', message: 'Created' }),
  updated: msg({ id: 'import.platform.fields.updated', message: 'Updated' }),
  completedAt: msg({ id: 'import.platform.fields.completedAt', message: 'Completion date' }),
  dependents: msg({ id: 'import.platform.fields.dependents', message: 'Dependent tasks' }),
  completed: msg({ id: 'import.platform.fields.completed', message: 'Completed' }),
  priority: msg({ id: 'import.platform.fields.priority', message: 'Priority' }),
  tags: msg({ id: 'import.platform.fields.tags', message: 'Tags' }),
  estimate: msg({ id: 'import.platform.fields.estimate', message: 'Time estimate' }),
  spent: msg({ id: 'import.platform.fields.spent', message: 'Time spent' }),
  parent: msg({ id: 'import.platform.fields.parent', message: 'Parent task' }),
  dependencies: msg({ id: 'import.platform.fields.dependencies', message: 'Dependencies' }),
  relationships: msg({ id: 'import.platform.fields.relationships', message: 'Related tasks' }),
  attachments: msg({ id: 'import.platform.fields.attachments', message: 'Attachments' }),
  section: msg({ id: 'import.platform.fields.section', message: 'Section' }),
  projects: msg({ id: 'import.platform.fields.projects', message: 'Projects' }),
  url: msg({ id: 'import.platform.fields.url', message: 'Task URL' }),
  taskType: msg({ id: 'import.platform.fields.taskType', message: 'Task type' }),
  archived: msg({ id: 'import.platform.fields.archived', message: 'Archived' }),
};

export function taskFieldNames(i18n: I18n): Record<TaskImportField, string> {
  return Object.fromEntries(Object.entries(NAMES).map(([key, value]) => [key, i18n._(value)])) as Record<
    TaskImportField,
    string
  >;
}

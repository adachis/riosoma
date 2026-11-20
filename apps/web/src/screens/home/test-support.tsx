import { newId, type DatabaseSummary } from '@riosoma/contracts';
export { renderShell as renderHome } from '../database/shell/test-support';

export function databaseSummary(overrides: Partial<DatabaseSummary> = {}): DatabaseSummary {
  return {
    id: newId('database'),
    name: 'Projects',
    icon: null,
    color: 'blue',
    role: 'owner',
    updatedAt: '2026-09-27T09:00:00Z',
    favorite: false,
    openedAt: null,
    ...overrides,
  };
}

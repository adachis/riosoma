import type { DatabaseRole } from './schema.js';

export type DatabaseAction = 'read' | 'comment' | 'editRecords' | 'editSchema' | 'manage';

const ALLOWED: Record<DatabaseRole, readonly DatabaseAction[]> = {
  owner: ['read', 'comment', 'editRecords', 'editSchema', 'manage'],
  creator: ['read', 'comment', 'editRecords', 'editSchema'],
  editor: ['read', 'comment', 'editRecords'],
  commenter: ['read', 'comment'],
  reader: ['read'],
};

/** What a role lets someone do in a database.  Clients use it to hide what they can't do. */
export function roleAllows(role: DatabaseRole | null | undefined, action: DatabaseAction): boolean {
  return role ? ALLOWED[role].includes(action) : false;
}

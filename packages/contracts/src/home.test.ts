import { expect, it } from 'vitest';
import { newId } from './ids.js';
import { HomeCommand } from './home.js';

it('rejects batches on the single-action home contract', () => {
  const action = { kind: 'folder.trash', folderId: 'folder' };
  expect(HomeCommand.safeParse({ id: newId('command'), action, actions: [action] }).success).toBe(false);
});

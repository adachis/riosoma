import { msg } from '@lingui/core/macro';

// Deferred locale catalogs still reference these IDs.  Keep their source definitions until those catalogs can be refreshed.
export const catalogCompatibilityMessages = [
  msg({ id: 'shell.helpMenu', message: 'Help and feedback' }),
  msg({ id: 'shell.helpMenu.help', message: 'Help topics' }),
  msg({ id: 'shortcuts.action', message: 'Action' }),
  msg({ id: 'shortcuts.done', message: 'Done' }),
  msg({ id: 'shortcuts.keys', message: 'Keys' }),
];

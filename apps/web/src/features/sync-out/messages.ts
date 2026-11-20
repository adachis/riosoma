import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

/**
 * Every message key a Sync out run, stop, refusal, or note can carry.  The server sends only keys
 * and parameters, so each one needs its American English text here to be shown.  Stored keys (a
 * run's error, a stop reason, a note) aren't caught by the emitted-key scan, so this list is kept
 * complete by hand against the design's section 12.
 */
export const SYNC_OUT_MESSAGES: Record<string, MessageDescriptor> = {
  // Refusals
  'syncOut.unavailable.role': msg({
    id: 'syncOut.unavailable.role',
    message: 'Only people who can change this view can set up Sync out.',
  }),
  'syncOut.unavailable.guest': msg({
    id: 'syncOut.unavailable.guest',
    message: 'Guests can’t set up Sync out.',
  }),
  'syncOut.unavailable.policy': msg({
    id: 'syncOut.unavailable.policy',
    message: 'Your organization has turned Sync out off, or keeps sharing inside the organization.',
  }),
  'syncOut.unavailable.viewType': msg({
    id: 'syncOut.unavailable.viewType',
    message: 'This kind of view has no rows to sync out.',
  }),
  'syncOut.unavailable.live': msg({
    id: 'syncOut.unavailable.live',
    message: 'This table reads its source live.  Switch it to a copy to sync it out.',
  }),
  'syncOut.limit.perView': msg({
    id: 'syncOut.limit.perView',
    message: 'A view can sync out to {limit} places at most.',
  }),
  'syncOut.edit.creatorOnly': msg({
    id: 'syncOut.edit.creatorOnly',
    message: 'Only the person who set up this sync can change it, because it runs with their access.',
  }),
  'syncOut.run.off': msg({ id: 'syncOut.run.off', message: 'Turn this sync on before syncing.' }),
  'syncOut.destination.unknownKind': msg({
    id: 'syncOut.destination.unknownKind',
    message: 'This server can’t sync out to that kind of destination.',
  }),
  'syncOut.target.inUse': msg({
    id: 'syncOut.target.inUse',
    message: 'Another sync already sends rows to {name}.  One table or sheet takes one sync.',
  }),
  'syncOut.airtable.tokenRefused': msg({
    id: 'syncOut.airtable.tokenRefused',
    message: 'Airtable didn’t accept this token.  Check that all of it was copied.',
  }),
  'syncOut.smartsheet.tokenRefused': msg({
    id: 'syncOut.smartsheet.tokenRefused',
    message: 'Smartsheet didn’t accept this token.  Check the region, and that all of it was copied.',
  }),

  // Stop reasons
  'syncOut.stopped.viewDeleted': msg({
    id: 'syncOut.stopped.viewDeleted',
    message: 'The view was deleted.',
  }),
  'syncOut.stopped.creatorLostAccess': msg({
    id: 'syncOut.stopped.creatorLostAccess',
    message: 'The person who set it up can’t open this view anymore.',
  }),
  'syncOut.stopped.creatorGone': msg({
    id: 'syncOut.stopped.creatorGone',
    message: 'The person who set it up isn’t in the organization anymore.',
  }),
  'syncOut.stopped.policy': msg({
    id: 'syncOut.stopped.policy',
    message: 'Your organization turned Sync out off, or stopped sharing outside the organization.',
  }),

  // Run and destination problems
  'syncOut.view.nothingToSend': msg({
    id: 'syncOut.view.nothingToSend',
    message: 'None of this view’s fields may leave Riosoma, so there is nothing to sync.',
  }),
  'syncOut.view.withheldCondition': msg({
    id: 'syncOut.view.withheldCondition',
    message:
      'This view filters or sorts by a field that may not leave Riosoma, so nothing is sent.  Change the view’s filter or sort, or the field’s classification.',
  }),
  'syncOut.run.failed': msg({
    id: 'syncOut.run.failed',
    message: 'The sync couldn’t finish because of a problem on this server.',
  }),
  'syncOut.run.timeout': msg({
    id: 'syncOut.run.timeout',
    message: 'The sync ran out of time.  The next one carries on where it stopped.',
  }),
  'syncOut.target.keyColumn': msg({
    id: 'syncOut.target.keyColumn',
    message:
      'Riosoma needs a plain text column named Riosoma record ID that it can write, and couldn’t find or add one.  Add it by hand, or use a token that can add columns.',
  }),
  'syncOut.destination.unreachable': msg({
    id: 'syncOut.destination.unreachable',
    message: 'Riosoma couldn’t reach the destination.  The next sync tries again.',
  }),
  'syncOut.destination.rateLimited': msg({
    id: 'syncOut.destination.rateLimited',
    message:
      'The destination asked Riosoma to slow down, and the sync stopped partway.  The next sync carries on.',
  }),
  'syncOut.destination.unavailable': msg({
    id: 'syncOut.destination.unavailable',
    message: 'The destination isn’t answering right now.  The next sync tries again.',
  }),
  'syncOut.destination.unreadable': msg({
    id: 'syncOut.destination.unreadable',
    message: 'The destination sent an answer Riosoma couldn’t read.',
  }),
  'syncOut.destination.unconfirmed': msg({
    id: 'syncOut.destination.unconfirmed',
    message:
      'The connection dropped before the answer came back.  The next sync checks what arrived, so no row is sent twice.',
  }),
  'syncOut.destination.duplicateKey': msg({
    id: 'syncOut.destination.duplicateKey',
    message: 'Some rows there share a Riosoma record ID.  The next sync removes the extra rows.',
  }),
  'syncOut.destination.private': msg({
    id: 'syncOut.destination.private',
    message: 'That address is on a private network, which this server doesn’t call.',
  }),
  'syncOut.airtable.token': msg({
    id: 'syncOut.airtable.token',
    message: 'Airtable didn’t accept the token.  Delete this sync and set it up again with a new token.',
  }),
  'syncOut.airtable.scopes': msg({
    id: 'syncOut.airtable.scopes',
    message:
      'The token can’t write to this base.  It needs the data.records:write and schema.bases:write scopes, access to the base, and an owner who can edit it.',
  }),
  'syncOut.airtable.baseUnreadable': msg({
    id: 'syncOut.airtable.baseUnreadable',
    message:
      'Riosoma can’t open this base with the token.  The base may be gone, or the token may lack the schema.bases:read scope or access to the base.',
  }),
  'syncOut.airtable.gone': msg({
    id: 'syncOut.airtable.gone',
    message: 'The table isn’t in the base anymore, or the token can’t read it.',
  }),
  'syncOut.airtable.nameTaken': msg({
    id: 'syncOut.airtable.nameTaken',
    message: 'The base already has a table named {name}.  Choose another name, or use that table.',
  }),
  'syncOut.airtable.value': msg({
    id: 'syncOut.airtable.value',
    message: 'Airtable wouldn’t take a value for the column {column}.',
  }),
  'syncOut.airtable.valueUnknown': msg({
    id: 'syncOut.airtable.valueUnknown',
    message: 'Airtable wouldn’t take one of the values.',
  }),
  'syncOut.airtable.full': msg({
    id: 'syncOut.airtable.full',
    message: 'The table or base has reached its Airtable plan’s limit.',
  }),
  'syncOut.airtable.quota': msg({
    id: 'syncOut.airtable.quota',
    message:
      'This Airtable workspace has used up its API calls for the month.  Syncing works again when Airtable’s count starts over.',
  }),
  'syncOut.airtable.rows': msg({
    id: 'syncOut.airtable.rows',
    message: 'This view shows {count} rows.  Sync out sends up to {limit} rows to one Airtable table.',
  }),
  'syncOut.airtable.columns': msg({
    id: 'syncOut.airtable.columns',
    message: 'The table would need {count} fields.  An Airtable table holds up to {limit}.',
  }),
  'syncOut.airtable.cells': msg({
    id: 'syncOut.airtable.cells',
    message:
      'This view would send {count} cells.  Sync out sends up to {limit} cells to one Airtable table.  Hide some fields or narrow the view’s filter.',
  }),
  'syncOut.removal.tooMany': msg({
    id: 'syncOut.removal.tooMany',
    message:
      'This run would have removed {count} rows, more than half of the table, so it stopped and removed nothing.  Check the view’s filter, then choose Sync now.',
  }),
  'syncOut.target.newOnly': msg({
    id: 'syncOut.target.newOnly',
    message: 'Sync out creates a new table for now.  Using a table that already exists is coming later.',
  }),
  'syncOut.view.filtersWithheld': msg({
    id: 'syncOut.view.filtersWithheld',
    message:
      'This view filters or sorts by a field that may not leave Riosoma, so nothing is sent.  Change the view’s filter or sort, or the field’s classification.',
  }),
  'syncOut.smartsheet.token': msg({
    id: 'syncOut.smartsheet.token',
    message: 'Smartsheet didn’t accept the token.  Delete this sync and set it up again with a new token.',
  }),
  'syncOut.smartsheet.permission': msg({
    id: 'syncOut.smartsheet.permission',
    message:
      'The token’s owner can’t edit this sheet.  Syncing needs editor access, and adding columns needs admin access.',
  }),
  'syncOut.smartsheet.gone': msg({
    id: 'syncOut.smartsheet.gone',
    message: 'The sheet isn’t there anymore, or the token can’t open it.',
  }),
  'syncOut.smartsheet.changing': msg({
    id: 'syncOut.smartsheet.changing',
    message: 'The sheet kept changing while Riosoma read it.  Sync again when no one is editing it.',
  }),
  'syncOut.smartsheet.value': msg({
    id: 'syncOut.smartsheet.value',
    message: 'Smartsheet wouldn’t take a value for the column {column}.',
  }),
  'syncOut.smartsheet.valueUnknown': msg({
    id: 'syncOut.smartsheet.valueUnknown',
    message: 'Smartsheet wouldn’t take one of the values.',
  }),
  'syncOut.smartsheet.full': msg({
    id: 'syncOut.smartsheet.full',
    message:
      'The sheet is full.  A Smartsheet sheet holds up to 20,000 rows, 400 columns, and 500,000 cells.',
  }),
  'syncOut.smartsheet.rows': msg({
    id: 'syncOut.smartsheet.rows',
    message: 'This view shows {count} rows.  A Smartsheet sheet holds up to {limit}.',
  }),
  'syncOut.smartsheet.columns': msg({
    id: 'syncOut.smartsheet.columns',
    message: 'The sheet would need {count} columns.  A Smartsheet sheet holds up to {limit}.',
  }),
  'syncOut.smartsheet.cells': msg({
    id: 'syncOut.smartsheet.cells',
    message: 'The sheet would hold {count} cells.  A Smartsheet sheet holds up to {limit}.',
  }),

  // Notes on a run
  'syncOut.note.truncated': msg({
    id: 'syncOut.note.truncated',
    message:
      '{count, plural, one {# value was too long and was cut to fit.} other {# values were too long and were cut to fit.}}',
  }),
  'syncOut.note.duplicates': msg({
    id: 'syncOut.note.duplicates',
    message:
      '{count, plural, one {# extra row with a repeated Riosoma record ID was removed.} other {# extra rows with a repeated Riosoma record ID were removed.}}',
  }),
  'syncOut.note.columnMissing': msg({
    id: 'syncOut.note.columnMissing',
    message: '{name} has no column there, and adding columns is turned off.',
  }),
  'syncOut.note.columnReadOnly': msg({
    id: 'syncOut.note.columnReadOnly',
    message: '{name} matches a column that can’t be written, so it isn’t sent.',
  }),
  'syncOut.note.cleared': msg({
    id: 'syncOut.note.cleared',
    message: '{name} is no longer sent, so its column was cleared.',
  }),

  // Why a previewed field isn't sent (shown in a narrow cell beside the field's name)
  'syncOut.skip.noColumn': msg({ id: 'syncOut.skip.noColumn', message: 'No column there' }),
  'syncOut.skip.readOnly': msg({ id: 'syncOut.skip.readOnly', message: 'That column can’t be written' }),
};

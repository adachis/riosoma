import { msg } from '@lingui/core/macro';

export const ORGANIZATION_ARCHIVE_MESSAGES = {
  'organizationArchive.invalid': msg({
    id: 'organizationArchive.invalid',
    message: 'This archive is incomplete, damaged, or has an invalid entry.  Nothing was imported.',
  }),
  'organizationArchive.tooLarge': msg({
    id: 'organizationArchive.tooLarge',
    message:
      'Part of this archive is larger than {megabytes} MB, the most one line or template may hold.  Nothing was imported.',
  }),
  'organizationArchive.notAuthentic': msg({
    id: 'organizationArchive.notAuthentic',
    message:
      'That passphrase doesn’t match this archive, or the archive was changed after it was exported.  Nothing was imported.  Check the passphrase, or import without one to bring in the data unauthenticated and without credentials.',
  }),
  'organizationArchive.unsigned': msg({
    id: 'organizationArchive.unsigned',
    message:
      'This archive isn’t signed, so a passphrase can’t check it.  Leave the passphrase empty to import it unchecked, without credentials.',
  }),
  'organizationArchive.newerSchema': msg({
    id: 'organizationArchive.newerSchema',
    message:
      'This archive uses schema version {archiveVersion}, but this server supports version {serverVersion}.  Update this server before importing.',
  }),
  'organizationArchive.ownerOnly': msg({
    id: 'organizationArchive.ownerOnly',
    message: 'Only the organization owner can export or import an organization.',
  }),
  'organizationArchive.notEmpty': msg({
    id: 'organizationArchive.notEmpty',
    message: 'Import requires an empty organization with only the importing owner.',
  }),
  'organizationArchive.busy': msg({
    id: 'organizationArchive.busy',
    message: 'An organization archive job is already running.  Wait for it to finish.',
  }),
  'organizationArchive.notPreview': msg({
    id: 'organizationArchive.notPreview',
    message: 'This archive is no longer waiting for confirmation.  Upload it again to review it.',
  }),
  'organizationArchive.interrupted': msg({
    id: 'organizationArchive.interrupted',
    message: 'The server stopped before the archive job finished.  Start it again.',
  }),
  'organizationArchive.failed': msg({
    id: 'organizationArchive.failed',
    message: 'The organization archive job failed.  No partial database was imported.',
  }),
  'organizationArchive.secretsMissing': msg({
    id: 'organizationArchive.secretsMissing',
    message: 'Credentials were not restored.  Enter them again before turning this on.',
  }),
  'organizationArchive.sourcePaused': msg({
    id: 'organizationArchive.sourcePaused',
    message:
      'Paused after an import.  The organization owner turns it on from the import review in Export and import.',
  }),
  'organizationArchive.reviewAutomation': msg({
    id: 'organizationArchive.reviewAutomation',
    message: 'Review this imported automation before turning it on.',
  }),
  'organizationArchive.reviewIntegration': msg({
    id: 'organizationArchive.reviewIntegration',
    message: 'Review this imported integration before turning it on.',
  }),
  'organizationArchive.review.secretNeeded': msg({
    id: 'organizationArchive.review.secretNeeded',
    message:
      'This needs its credential entered again before it can be turned on.  Enter it where this is set up, then try again.',
  }),
  'organizationArchive.review.turnOnFromReview': msg({
    id: 'organizationArchive.review.turnOnFromReview',
    message:
      'This came in with an organization import and is waiting in its review.  The organization owner turns it on from the import review in Export and import.',
  }),
  'organizationArchive.review.passwordNeeded': msg({
    id: 'organizationArchive.review.passwordNeeded',
    message:
      'This link had a password that didn’t come with the archive.  Share the view again to set a new one.',
  }),
  'organizationArchive.unknownSecret': msg({
    id: 'organizationArchive.unknownSecret',
    message:
      'A stored credential could not be exported safely.  Export without credentials or update the server.',
  }),
};

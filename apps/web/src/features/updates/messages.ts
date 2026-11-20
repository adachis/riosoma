import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { FeedStatus, InstallMethod, UpdateRunState, UpdaterProblem } from '@riosoma/contracts';

/** What the server says when an update check, an update, or a usage count choice is refused */
export const UPDATE_MESSAGES = {
  'updates.serverOnly': msg({
    id: 'updates.serverOnly',
    message:
      'Updates belong to the organization that set up this server, so only its owner and admins see them.',
  }),
  'updates.ownerOnly': msg({
    id: 'updates.ownerOnly',
    message: 'Only the owner can update this server.',
  }),
  'updates.checksOff': msg({
    id: 'updates.checksOff',
    message: 'Update checks are off in this server’s settings, so Riosoma doesn’t look for new releases.',
  }),
  'updates.noKeys': msg({
    id: 'updates.noKeys',
    message:
      'This release of Riosoma has no key to verify the update feed with, so it can’t check for updates.  A later release will.',
  }),
  'updates.updaterMissing': msg({
    id: 'updates.updaterMissing',
    message: 'This server has no updater.  Follow the steps on this page to update it.',
  }),
  'updates.notAvailable': msg({
    id: 'updates.notAvailable',
    message:
      'Riosoma {version} isn’t the release this server can update to right now.  Check again, then try.',
  }),
  'updates.updaterNotReady': msg({
    id: 'updates.updaterNotReady',
    message: 'The updater isn’t ready to update.  The updater’s status on this page says why.',
  }),
  'updates.running': msg({
    id: 'updates.running',
    message: 'An update is already running.  Wait for it to finish.',
  }),
  'telemetry.ownerOnly': msg({
    id: 'telemetry.ownerOnly',
    message: 'Only the owner decides whether this server sends usage counts.',
  }),
  'telemetry.off': msg({
    id: 'telemetry.off',
    message: 'Usage counts are off, so there’s no install ID to replace.',
  }),
  'telemetry.forcedOff': msg({
    id: 'telemetry.forcedOff',
    message: 'This server’s settings keep usage counts off, so they can’t be turned on here.',
  }),
} satisfies Record<string, MessageDescriptor>;

/** Why the notice shows nothing, or what the last check found, for the admin screen */
export const FEED_STATUS: Record<FeedStatus, MessageDescriptor> = {
  ok: msg({ id: 'updates.feed.ok', message: 'The update feed was checked and its signature verified.' }),
  off: msg({
    id: 'updates.feed.off',
    message: 'Update checks are off in this server’s settings, so Riosoma doesn’t look for new releases.',
  }),
  noKeys: msg({
    id: 'updates.feed.noKeys',
    message:
      'This release of Riosoma has no key to verify the update feed with, so no feed can be trusted and no update notices show.  A later release will carry the key.',
  }),
  unchecked: msg({ id: 'updates.feed.unchecked', message: 'Riosoma hasn’t checked for updates yet.' }),
  unreachable: msg({
    id: 'updates.feed.unreachable',
    message:
      'The last check couldn’t reach the update feed.  Riosoma tries again tomorrow, or check now once the server can reach it.',
  }),
  invalid: msg({
    id: 'updates.feed.invalid',
    message: 'The last check got something that isn’t an update feed, so it was ignored.',
  }),
  unsigned: msg({
    id: 'updates.feed.unsigned',
    message: 'The last check got an update feed with no signature, so it was ignored.',
  }),
  unknownKey: msg({
    id: 'updates.feed.unknownKey',
    message:
      'The last check got an update feed signed with a key this release doesn’t know, so it was ignored.  Updating by hand to a newer release brings the new key.',
  }),
  badSignature: msg({
    id: 'updates.feed.badSignature',
    message:
      'The last check got an update feed whose signature didn’t match, so it was ignored.  Something between this server and the feed may have changed it.',
  }),
  stale: msg({
    id: 'updates.feed.stale',
    message:
      'The update feed is more than 14 days old, so it was ignored.  An old feed could hide a newer release.',
  }),
  older: msg({
    id: 'updates.feed.older',
    message: 'The last check got an update feed older than one already verified, so the newer one was kept.',
  }),
};

/** Why the updater can't update, or why an update didn't finish */
export const UPDATER_PROBLEM: Record<UpdaterProblem, MessageDescriptor> = {
  unreachable: msg({ id: 'updates.problem.unreachable', message: 'Riosoma can’t reach the updater.' }),
  outdated: msg({
    id: 'updates.problem.outdated',
    message:
      'The updater runs an older release than Riosoma, so it may not trust newer update feeds.  Run docker compose up -d in the Compose folder to bring it up to date, or update by hand with these steps.',
  }),
  token: msg({
    id: 'updates.problem.token',
    message: 'The updater refused Riosoma’s token.  RIOSOMA_UPDATER_TOKEN has to be the same for both.',
  }),
  docker: msg({ id: 'updates.problem.docker', message: 'The updater can’t reach Docker.' }),
  container: msg({
    id: 'updates.problem.container',
    message: 'The updater can’t find Riosoma’s running container.',
  }),
  ambiguous: msg({
    id: 'updates.problem.ambiguous',
    message: 'The updater found more than one Riosoma container and can’t tell which to update.',
  }),
  backup: msg({
    id: 'updates.problem.backup',
    message:
      'The backup service isn’t running.  Turn on the backup profile, since every update starts with a backup.',
  }),
  backupDatabase: msg({
    id: 'updates.problem.backupDatabase',
    message:
      'The backup service backs up a different database from Riosoma’s, so the updater won’t update.  BACKUP_DATABASE_URL in .env has to name the database Riosoma uses.',
  }),
  compose: msg({
    id: 'updates.problem.compose',
    message: 'The updater can’t write to the Compose folder, where .env names the image.',
  }),
  connectors: msg({
    id: 'updates.problem.connectors',
    message:
      'This release runs its database connectors in a service of their own, which this install’s Compose file doesn’t have yet.  Download this release’s compose.yaml into the Compose folder, then run docker compose up -d.',
  }),
  busy: msg({ id: 'updates.problem.busy', message: 'The updater is busy with an update.' }),
  signature: msg({
    id: 'updates.problem.signature',
    message: 'The updater couldn’t verify the feed’s signature.',
  }),
  stale: msg({ id: 'updates.problem.stale', message: 'The feed was too old for the updater to trust.' }),
  older: msg({
    id: 'updates.problem.older',
    message: 'The feed was older than one the updater already trusted, so it may leave out a newer release.',
  }),
  release: msg({
    id: 'updates.problem.release',
    message: 'That isn’t the release the updater would update this version to.',
  }),
  minimum: msg({
    id: 'updates.problem.minimum',
    message: 'This version is too old to update straight to that release.',
  }),
  platform: msg({
    id: 'updates.problem.platform',
    message: 'The release has no image for this machine’s processor.',
  }),
  pull: msg({ id: 'updates.problem.pull', message: 'The new image couldn’t be downloaded.' }),
  verify: msg({
    id: 'updates.problem.verify',
    message: 'The downloaded image wasn’t the release the feed named, so it wasn’t used.',
  }),
  stop: msg({ id: 'updates.problem.stop', message: 'Riosoma couldn’t be stopped for the update.' }),
  backupFailed: msg({
    id: 'updates.problem.backupFailed',
    message: 'The backup failed, so Riosoma started again on the version it had.',
  }),
  rename: msg({
    id: 'updates.problem.rename',
    message:
      'Docker wouldn’t rename Riosoma’s container for the update, so nothing changed, and Riosoma started again on the version it had.',
  }),
  start: msg({ id: 'updates.problem.start', message: 'The new version couldn’t start.' }),
  health: msg({
    id: 'updates.problem.health',
    message: 'The new version didn’t answer that it was running in time.',
  }),
  rollback: msg({
    id: 'updates.problem.rollback',
    message: 'Going back to the previous version didn’t finish.  Follow the rollback steps in the help.',
  }),
  interrupted: msg({
    id: 'updates.problem.interrupted',
    message:
      'The updater stopped in the middle of the update.  Check that Riosoma is running, and follow the help.',
  }),
};

/** Where an update stands, as its progress says */
export const RUN_STATE: Record<UpdateRunState, MessageDescriptor> = {
  requested: msg({ id: 'updates.run.requested', message: 'Starting the update' }),
  pulling: msg({ id: 'updates.run.pulling', message: 'Downloading the new version' }),
  verifying: msg({ id: 'updates.run.verifying', message: 'Checking the download' }),
  stopping: msg({ id: 'updates.run.stopping', message: 'Stopping Riosoma' }),
  backing_up: msg({ id: 'updates.run.backingUp', message: 'Backing up the database' }),
  starting: msg({ id: 'updates.run.starting', message: 'Starting the new version' }),
  checking: msg({ id: 'updates.run.checking', message: 'Waiting for the new version to answer' }),
  rolling_back: msg({ id: 'updates.run.rollingBack', message: 'Going back to the previous version' }),
  succeeded: msg({ id: 'updates.run.succeeded', message: 'Updated' }),
  rolled_back: msg({ id: 'updates.run.rolledBack', message: 'Rolled back' }),
  failed: msg({ id: 'updates.run.failed', message: 'The update failed' }),
};

export const INSTALL_NAMES: Record<InstallMethod, MessageDescriptor> = {
  compose: msg({ id: 'updates.install.compose', message: 'Docker Compose' }),
  docker: msg({ id: 'updates.install.docker', message: 'Docker' }),
  helm: msg({ id: 'updates.install.helm', message: 'the Helm chart' }),
  kubernetes: msg({ id: 'updates.install.kubernetes', message: 'Kubernetes' }),
  'container-apps': msg({ id: 'updates.install.containerApps', message: 'Azure Container Apps' }),
  ecs: msg({ id: 'updates.install.ecs', message: 'Amazon ECS' }),
  'cloud-run': msg({ id: 'updates.install.cloudRun', message: 'Google Cloud Run' }),
  source: msg({ id: 'updates.install.source', message: 'source' }),
};

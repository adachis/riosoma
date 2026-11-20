import { AppError, type Command } from '@riosoma/contracts';
import { loadAutomation } from '../../automations/store.js';
import { calendarAccess, createCalendarEvent, deleteCalendarEvent } from '../../oauth/calendars.js';
import {
  queueCalendarRemoval,
  waitingRemoval,
  withdrawRemoval,
} from '../../automations/calendar-removals.js';
import { scopeOf, type CommandContext, type Mutation } from './context.js';

/** Event creation and removal use the same audited command and undo boundary as other steps. */
async function authorizeCalendar(
  c: CommandContext,
  command: Extract<Command, { kind: 'automation.calendarEvent' }>,
) {
  const scope = await scopeOf(c);
  await scope.require(c.databaseId, 'editSchema');
  if (!command.remove) {
    await scope.requireUse(c.databaseId, 'external');
    await scope.requireUse(c.databaseId, 'export');
  }
  const automation = await loadAutomation(c.db, c.schemas, command.automationId);
  if (
    !automation ||
    automation.trashed ||
    automation.databaseId !== c.databaseId ||
    automation.orgId !== c.actor.orgId
  )
    throw new AppError('not_found', 'errors.notFound');
  if (!c.appContext || c.simulation || c.preview) throw new AppError('unavailable', 'errors.unavailable');
  return automation;
}

/** Provider requests use a deterministic identity before the database write transaction. */
export async function prepareCalendarEvent(
  c: CommandContext,
  command: Extract<Command, { kind: 'automation.calendarEvent' }>,
) {
  await authorizeCalendar(c, command);
  let eventId: string;
  let accountId = command.accountId;
  if (command.remove) {
    if (!command.eventId || !accountId) throw new AppError('validation_failed', 'errors.validationFailed');
    await deleteCalendarEvent(c.appContext!, c.actor, command.event, command.eventId, accountId);
    eventId = command.eventId;
  } else {
    const created = await createCalendarEvent(c.appContext!, c.actor, command.event, command.id, accountId);
    eventId = created.eventId;
    accountId = created.accountId;
  }
  return { eventId, accountId: accountId! };
}

/**
 * Undo checks a removal before its transaction and queues it inside, and the event is removed only
 * after the commit, so a refused undo leaves every event in place.  Removing is idempotent, and a
 * missing event is fine.
 */
export async function checkCalendarRemoval(
  c: CommandContext,
  command: Extract<Command, { kind: 'automation.calendarEvent' }>,
) {
  await authorizeCalendar(c, command);
  if (!command.remove || !command.eventId || !command.accountId)
    throw new AppError('validation_failed', 'errors.validationFailed');
  await calendarAccess(c.appContext!, c.actor, command.event.provider, command.accountId);
  return { eventId: command.eventId, accountId: command.accountId, deferred: true };
}

/**
 * A redo of a removal that hasn't gone through yet keeps the original event, so it never makes a
 * second one.  Null when there's nothing waiting to take back.
 */
export async function reuseCalendarEvent(
  c: CommandContext,
  command: Extract<Command, { kind: 'automation.calendarEvent' }>,
) {
  await authorizeCalendar(c, command);
  if (command.remove || !command.eventId || !command.accountId) return null;
  const reuse = await waitingRemoval(c.db, c.schemas, c.actor.orgId, command.eventId, command.accountId);
  return reuse ? { eventId: command.eventId, accountId: command.accountId, reuse } : null;
}

/** Only the audited change is recorded while the database write lock is held. */
export async function calendarEventCommand(
  c: CommandContext,
  command: Extract<Command, { kind: 'automation.calendarEvent' }>,
): Promise<Mutation> {
  const automation = await authorizeCalendar(c, command);
  const prepared = c.preparedCalendar?.get(command.id);
  // An undo skips an event its account, provider, or automation refused, like a record that's gone.
  if (prepared === null) throw new AppError('not_found', 'errors.notFound');
  if (!prepared) throw new AppError('conflict', 'errors.conflict');
  if (prepared.deferred) {
    if (!c.undoCommandId) throw new AppError('conflict', 'errors.conflict');
    await queueCalendarRemoval(c, command, c.undoCommandId);
  }
  if (prepared.reuse) await withdrawRemoval(c, prepared.reuse);
  const { eventId, accountId } = prepared;
  return {
    body: {
      kind: 'automation.calendarEventChanged',
      automationId: automation.id,
      eventId,
      created: !command.remove,
    },
    prev: { calendarEvent: command.event, calendarAccountId: accountId },
  };
}

import { AppError, type Command } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { loadAutomation } from '../../automations/store.js';
import { notify } from '../../notifications/produce.js';
import { activeMember } from '../../notifications/store.js';
import { AccessScope } from '../access.js';
import {
  NOTIFICATION_BURST,
  NOTIFICATION_WINDOW_MS,
  scopedNotificationContent,
} from '../automation-notifications.js';
import { scopeOf, type CommandContext, type Mutation } from './context.js';
import { lock } from './transaction.js';

type NotifyCommand = Extract<Command, { kind: 'automation.notify' }>;

/** The run supplies templates and token provenance through an internal, idempotent command. */
export async function automationNotificationCommand(
  c: CommandContext,
  command: NotifyCommand,
): Promise<Mutation> {
  const scope = await scopeOf(c);
  await scope.require(c.databaseId, 'read');
  if (c.undoCommandId) await scope.require(c.databaseId, 'editSchema');
  else if (c.actor.automation?.id !== command.automationId || command.remove)
    throw new AppError('forbidden', 'data.access.denied');
  const automation = await loadAutomation(c.db, c.schemas, command.automationId);
  if (
    !automation ||
    automation.trashed ||
    automation.databaseId !== c.databaseId ||
    automation.orgId !== c.actor.orgId
  )
    throw new AppError('not_found', 'errors.notFound');
  if (
    command.notifications.some((item) => item.content.databaseId !== c.databaseId) ||
    new Set(command.notifications.map((item) => item.recipientId)).size !== command.notifications.length
  )
    throw new AppError('validation_failed', 'errors.validationFailed');
  await lock(
    c,
    command.notifications.map((item) => `notification-burst:${c.actor.orgId}:${item.recipientId}`).sort(),
  );
  const recipients = [];
  for (const item of command.remove ? [] : command.notifications) {
    const person = await activeMember(c.db, c.schemas, c.actor.orgId, item.recipientId);
    if (!person) throw new AppError('not_found', 'automations.notification.personDeleted');
    if (!command.remove) {
      const recent = await query<{ count: number }>(
        c.db,
        sql`SELECT count(*)::int AS count FROM ${ident(c.schemas.app, 'notifications')}
        WHERE org_id = ${c.actor.orgId} AND recipient_id = ${item.recipientId} AND kind = 'automationNotification'
        AND created_at > statement_timestamp() - ${NOTIFICATION_WINDOW_MS} * interval '1 millisecond'`,
      );
      if (recent.rows[0]!.count >= NOTIFICATION_BURST)
        throw new AppError('rate_limited', 'automations.notification.burst');
    }
    const rendered = await scopedNotificationContent(
      c.db,
      c.schemas,
      new AccessScope(c.db, c.schemas, person),
      item.content,
    );
    recipients.push({
      id: item.recipientId,
      title: rendered.title,
      message: rendered.message,
      link: rendered.link,
    });
  }
  if (command.remove) {
    await query(
      c.db,
      sql`DELETE FROM ${ident(c.schemas.app, 'notifications')}
      WHERE org_id = ${c.actor.orgId} AND subject_id = ${command.subjectId} AND kind = 'automationNotification'
      AND recipient_id = ANY(${command.notifications.map((item) => item.recipientId)}::text[])`,
    );
  } else {
    for (const item of command.notifications)
      await notify(c.db, c.schemas, {
        orgId: c.actor.orgId,
        recipientId: item.recipientId,
        kind: 'automationNotification',
        actorId: null,
        subjectId: command.subjectId,
        target: { automationContent: item.content },
      });
  }
  for (const item of command.notifications)
    await query(
      c.db,
      sql`SELECT pg_notify(${`${c.schemas.app}_notifications`.slice(0, 63)},
      ${JSON.stringify({ orgId: c.actor.orgId, userId: item.recipientId })})`,
    );
  return {
    body: {
      kind: 'automation.notified',
      automationId: automation.id,
      subjectId: command.subjectId,
      created: !command.remove,
    },
    prev: { notifications: command.notifications },
    output: { recipients },
  };
}

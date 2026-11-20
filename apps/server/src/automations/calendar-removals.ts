import { AppError, newId, type Command } from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { CommandContext } from '../data/commands/context.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import type { Actor } from '../http/policy.js';
import { notifyCalendarEventKept } from '../notifications/produce.js';
import { calendarAccess, removeEvent, type CalendarInput } from '../oauth/calendars.js';

/**
 * Removing a calendar event an undo took out of history happens after the undo commits, from a row
 * the undo wrote in its own transaction.  The undo tries it once right away, and the automation
 * worker tries again on this schedule after a passing failure.  When the calendar refuses, or the
 * schedule runs out, the row is marked failed and kept, and the person is told the event stayed.
 */
export const REMOVAL_RETRY_MS = [1, 5, 15, 60, 180, 720, 1_440].map((minutes) => minutes * 60_000);
export const MAX_REMOVAL_ATTEMPTS = REMOVAL_RETRY_MS.length + 1;
/**
 * How long a claim holds a row.  One attempt is a token refresh and a removal, each limited to 20
 * seconds, plus a wait for the connection's row lock, so ten minutes leaves plenty of room.  Every
 * comparison uses the database's clock, so servers whose clocks disagree still agree on a lease.
 */
const LEASE = sql`interval '10 minutes'`;

type CalendarCommand = Extract<Command, { kind: 'automation.calendarEvent' }>;

export interface RemovalRow {
  id: string;
  org_id: string;
  database_id: string;
  automation_id: string;
  user_id: string;
  command_id: string;
  provider: CalendarInput['provider'];
  calendar_id: string;
  event_id: string;
  account_id: string;
  attempts: number;
  lease_token: string;
}

/** Someone's redo wanted an event whose removal a worker is trying right now. */
export class RemovalInProgress extends AppError {
  constructor() {
    super('conflict', 'errors.conflict');
  }
}

const removals = (schemas: DataSchemas) => ident(schemas.app, 'calendar_removals');
const fresh = sql`lease_at IS NOT NULL AND lease_at > statement_timestamp() - ${LEASE}`;

/** Inside the undo's transaction, so the event is removed only when the undo commits. */
export async function queueCalendarRemoval(
  c: CommandContext,
  command: CalendarCommand,
  undoCommandId: string,
): Promise<void> {
  if (!command.eventId || !command.accountId)
    throw new AppError('validation_failed', 'errors.validationFailed');
  await query(
    c.db,
    sql`INSERT INTO ${removals(c.schemas)} (id, org_id, database_id, automation_id, user_id, command_id,
      provider, calendar_id, event_id, account_id, next_attempt_at, created_at)
    VALUES (${command.id}, ${c.actor.orgId}, ${c.databaseId}, ${command.automationId}, ${c.actor.userId},
      ${undoCommandId}, ${command.event.provider}, ${command.event.calendarId}, ${command.eventId},
      ${command.accountId}, statement_timestamp(), statement_timestamp())
    ON CONFLICT (id) DO NOTHING`,
  );
}

/**
 * A removal of this event a redo can take back: one still waiting, or one that failed and left the
 * event in place.  A worker trying it right now refuses the redo, which can be tried again after.
 */
export async function waitingRemoval(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  eventId: string,
  accountId: string,
): Promise<string | null> {
  const result = await query<{ id: string; leased: boolean }>(
    db,
    sql`SELECT id, (${fresh}) AS leased FROM ${removals(schemas)}
    WHERE org_id = ${orgId} AND event_id = ${eventId} AND account_id = ${accountId}
    ORDER BY leased LIMIT 1`,
  );
  const row = result.rows[0];
  if (row?.leased) throw new RemovalInProgress();
  return row?.id ?? null;
}

/**
 * Inside the redo's transaction: the removal is withdrawn, so the event stays where it is.  A
 * worker that began trying it meanwhile wins, and the redo is refused so it can be tried again.
 */
export async function withdrawRemoval(c: CommandContext, id: string): Promise<void> {
  const result = await query(
    c.db,
    sql`DELETE FROM ${removals(c.schemas)} WHERE id = ${id} AND org_id = ${c.actor.orgId} AND NOT (${fresh})`,
  );
  if (!result.rowCount) throw new RemovalInProgress();
}

/**
 * Claims one due removal, one of a single person's undo request when `request` is given.  The claim
 * counts as an attempt, so a worker that stops partway through still uses one up.
 */
export async function claimRemoval(
  app: FastifyInstance,
  request?: { orgId: string; userId: string; commandId: string },
): Promise<RemovalRow | null> {
  const { pool, schemas } = dataStore(app.ctx);
  const table = removals(schemas);
  const result = await query<RemovalRow>(
    pool,
    sql`UPDATE ${table} SET lease_at = statement_timestamp(), lease_token = ${newId('job')}, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM ${table} WHERE failed_at IS NULL AND next_attempt_at <= statement_timestamp() AND NOT (${fresh})
      ${
        request
          ? sql`AND org_id = ${request.orgId} AND user_id = ${request.userId} AND command_id = ${request.commandId}`
          : sql``
      }
      ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id, org_id, database_id, automation_id, user_id, command_id, provider, calendar_id, event_id,
      account_id, attempts, lease_token`,
  );
  return result.rows[0] ?? null;
}

/** A failure the calendar may get over: it was down, slow, or busy, or the network was. */
function passing(error: unknown): boolean {
  if (!(error instanceof AppError)) return true;
  return error.code === 'unavailable' || error.code === 'rate_limited' || error.code === 'internal';
}

/**
 * Tries a claimed removal once.  Right before asking the calendar, the claim is renewed in the
 * database, and a row a redo withdrew or another worker took over is left alone.  Returns whether
 * the event was removed.
 */
export async function attemptRemoval(
  app: FastifyInstance,
  actor: Actor | null,
  row: RemovalRow,
): Promise<boolean> {
  const { pool, schemas } = dataStore(app.ctx);
  const table = removals(schemas);
  const facts = { automationId: row.automation_id, removalId: row.id, attempts: row.attempts };
  try {
    // A person who left the organization has no calendar connection to remove it with.
    if (!actor || actor.userId !== row.user_id || actor.orgId !== row.org_id)
      throw new AppError('forbidden', 'data.access.denied');
    const access = await calendarAccess(app.ctx, actor, row.provider, row.account_id);
    const held = await query(
      pool,
      sql`UPDATE ${table} SET lease_at = statement_timestamp()
      WHERE id = ${row.id} AND lease_token = ${row.lease_token} AND failed_at IS NULL RETURNING id`,
    );
    if (!held.rowCount) return false;
    await removeEvent(access, { provider: row.provider, calendarId: row.calendar_id }, row.event_id);
    await query(pool, sql`DELETE FROM ${table} WHERE id = ${row.id} AND lease_token = ${row.lease_token}`);
    return true;
  } catch (error) {
    const messageKey = error instanceof AppError ? error.messageKey : 'drives.providerFailed';
    if (passing(error) && row.attempts < MAX_REMOVAL_ATTEMPTS) {
      const delay = REMOVAL_RETRY_MS[row.attempts - 1]!;
      await query(
        pool,
        sql`UPDATE ${table} SET lease_at = NULL, lease_token = NULL,
          next_attempt_at = statement_timestamp() + ${delay} * interval '1 millisecond'
        WHERE id = ${row.id} AND lease_token = ${row.lease_token}`,
      );
      app.log.warn({ ...facts, messageKey }, 'calendar event removal will be tried again');
      return false;
    }
    // The calendar refused, or the tries ran out: the event stays, and its person hears why.
    await withTransaction(pool, async (db) => {
      const failed = await query(
        db,
        sql`UPDATE ${table} SET failed_at = statement_timestamp(), failure_key = ${messageKey},
          lease_at = NULL, lease_token = NULL
        WHERE id = ${row.id} AND lease_token = ${row.lease_token} RETURNING id`,
      );
      if (failed.rowCount)
        await notifyCalendarEventKept(
          db,
          schemas,
          {
            orgId: row.org_id,
            userId: row.user_id,
            databaseId: row.database_id,
            automationId: row.automation_id,
          },
          messageKey,
        );
    });
    app.log.warn({ ...facts, messageKey }, 'calendar event removal stopped');
    return false;
  }
}

/** How an undo request's removals stand: still waiting, or stopped with the event left in place. */
export async function removalsOf(
  app: FastifyInstance,
  request: { orgId: string; userId: string; commandId: string },
): Promise<{ pending: number; failed: number }> {
  const { pool, schemas } = dataStore(app.ctx);
  const result = await query<{ pending: string; failed: string }>(
    pool,
    sql`SELECT count(*) FILTER (WHERE failed_at IS NULL)::text AS pending,
      count(*) FILTER (WHERE failed_at IS NOT NULL)::text AS failed
    FROM ${removals(schemas)}
    WHERE org_id = ${request.orgId} AND user_id = ${request.userId} AND command_id = ${request.commandId}`,
  );
  return { pending: Number(result.rows[0]?.pending ?? 0), failed: Number(result.rows[0]?.failed ?? 0) };
}

/** Failed removals are kept this long, for a redo to keep the original event, then let go. */
export const FAILED_REMOVAL_DAYS = 90;

/** Lets go of failed removals past their time, a batch at a time. */
export async function forgetFailedRemovals(app: FastifyInstance): Promise<number> {
  const { pool, schemas } = dataStore(app.ctx);
  const table = removals(schemas);
  const result = await query(
    pool,
    sql`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table}
      WHERE failed_at < statement_timestamp() - ${FAILED_REMOVAL_DAYS} * interval '1 day' LIMIT 5000)`,
  );
  return result.rowCount ?? 0;
}

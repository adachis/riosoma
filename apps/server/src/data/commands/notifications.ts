import { refuseDemo } from '../../demo/boundary.js';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AppError,
  NotificationCommand,
  NotificationConnection,
  newId,
  adminNotification,
  type NotificationCommandResult,
} from '@riosoma/contracts';
import { compile, ident, query, sql } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent } from '../../auth/database.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { validatePushSubscription } from '../../notifications/push.js';
import { organizationAdmin } from '../../org-units/store.js';
import { seal } from '../../secrets.js';
import { sealCredential } from '../../credentials/service.js';
import { AccessScope } from '../access.js';
import {
  canReceiveSms,
  credential,
  credentialContext,
  currentNotificationState,
  deviceContext,
  ensureVapid,
  openCredential,
  phoneContext,
  phoneFor,
  readPolicy,
  readPreferences,
  writeNotificationState,
  type NotificationState,
  type PhoneState,
} from '../notifications.js';
import type { CommandContext } from './context.js';
import { lock, runStored } from './transaction.js';

async function authorize(c: CommandContext, state?: NotificationState): Promise<void> {
  await new AccessScope(c.db, c.schemas, c.actor).requireOrganization();
  if (
    state &&
    (state.resource === 'organization' || state.resource === 'credential') &&
    !organizationAdmin(c.actor, 'integrations')
  )
    throw new AppError('forbidden', 'errors.adminOnly');
  if (state?.resource === 'phone' && !canReceiveSms(c.actor))
    throw new AppError('forbidden', 'errors.adminOnly');
}

/** A rotated credential changes its stored bytes but not what it says, so those compare by content. */
async function sameState(
  c: CommandContext,
  left: NotificationState,
  right: NotificationState,
): Promise<boolean> {
  if (left.resource !== 'credential' || right.resource !== 'credential')
    return isDeepStrictEqual(left, right);
  const open = async (state: NotificationState) =>
    typeof state.value === 'string'
      ? await openCredential(c.secretKey!, state.value, c.actor.orgId, state.target, c.db)
      : null;
  return left.target === right.target && (await open(left)) === (await open(right));
}

/** Personal changes use the command bus with private, sealed undo history and scoped invalidations. */
export async function runNotificationCommand(
  app: FastifyInstance,
  actor: Actor,
  input: unknown,
): Promise<NotificationCommandResult> {
  refuseDemo(actor);
  const command = parse(NotificationCommand, input);
  return runStored<NotificationCommandResult>(
    app,
    actor,
    '',
    {
      commandId: command.id,
      groupId: command.id,
      duplicate: (value) => {
        const saved = value as NotificationCommandResult;
        return { ...saved, status: saved.status === 'rejected' ? 'rejected' : 'duplicate' };
      },
      rejected: (error) => ({ status: 'rejected', actionId: command.id, error: error.toBody().error }),
    },
    async (c) => {
      await lock(c, [`notifications:${actor.orgId}`]);
      await authorize(c);
      let after: NotificationState | undefined;
      const result: NotificationCommandResult = { status: 'applied', actionId: command.id };
      switch (command.kind) {
        case 'notifications.preferences': {
          const value = await readPreferences(c.db, c.schemas, actor);
          for (const [channel, kinds] of Object.entries(command.update.channels ?? {})) {
            if (
              channel === 'sms' &&
              Object.entries(kinds).some(
                ([kind, on]) => on && (!canReceiveSms(actor) || !adminNotification(kind)),
              )
            )
              throw new AppError('forbidden', 'notifications.sms.adminOnly');
            if (channel === 'email') value.email = { ...value.email, ...kinds };
            else
              value.channels = {
                ...value.channels,
                [channel]: { ...value.channels[channel as keyof typeof value.channels], ...kinds },
              };
          }
          if (command.update.digest) value.digest = command.update.digest;
          after = { resource: 'preferences', target: actor.userId, value };
          break;
        }
        case 'notifications.organization': {
          for (const channel of ['sms', 'slack', 'teams'] as const)
            if (
              command.update.enabled[channel] === true &&
              !(await credential(c.db, c.schemas, c.secretKey!, actor.orgId, channel))
            )
              throw new AppError('validation_failed', 'notifications.connectionRequired');
          after = {
            resource: 'organization',
            target: actor.orgId,
            value: { ...(await readPolicy(c.db, c.schemas, actor)), ...command.update.enabled },
          };
          break;
        }
        case 'notifications.connection':
          after = {
            resource: 'credential',
            target: command.connection.channel,
            value: await sealCredential(
              c.secretKey!,
              JSON.stringify(command.connection),
              credentialContext(actor.orgId, command.connection.channel),
              actor.orgId,
              c.db,
            ),
          };
          break;
        case 'notifications.disconnect':
          after = { resource: 'credential', target: command.channel, value: null };
          break;
        case 'notifications.push.prepare':
          result.publicKey = (await ensureVapid(c)).publicKey;
          break;
        case 'notifications.push.subscribe': {
          if (!(await readPolicy(c.db, c.schemas, actor)).push)
            throw new AppError('forbidden', 'notifications.channel.disabled');
          validatePushSubscription(command.subscription);
          if (command.subscription.expirationTime && command.subscription.expirationTime <= Date.now())
            throw new AppError('validation_failed', 'notifications.push.invalid');
          await ensureVapid(c);
          const id = createHash('sha256').update(command.subscription.endpoint).digest('hex');
          const count = await query<{ count: number }>(
            c.db,
            sql`SELECT count(*)::int AS count FROM ${ident(c.schemas.app, 'notification_devices')}
          WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND id <> ${id}`,
          );
          if (count.rows[0]!.count >= 20) throw new AppError('validation_failed', 'notifications.push.limit');
          after = {
            resource: 'device',
            target: id,
            value: seal(c.secretKey!, JSON.stringify(command.subscription), deviceContext(id)),
          };
          result.deviceId = id;
          break;
        }
        case 'notifications.push.unsubscribe':
          after = { resource: 'device', target: command.deviceId, value: null };
          break;
        case 'notifications.phone.request': {
          if (!canReceiveSms(actor)) throw new AppError('forbidden', 'notifications.sms.adminOnly');
          if (!(await readPolicy(c.db, c.schemas, actor)).sms)
            throw new AppError('forbidden', 'notifications.channel.disabled');
          const connection = await query(
            c.db,
            sql`SELECT 1 FROM ${ident(c.schemas.app, 'notification_credentials')}
          WHERE scope_key = ${actor.orgId} AND name = 'sms'`,
          );
          if (!connection.rowCount)
            throw new AppError('validation_failed', 'notifications.channel.unavailable');
          const attempts = await query<{ count: number; recent: boolean }>(
            c.db,
            sql`SELECT count(*)::int AS count,
          COALESCE(bool_or(created_at > now() - interval '1 minute'), false) AS recent
          FROM ${ident(c.schemas.app, 'notification_deliveries')} WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId}
          AND channel = 'verify' AND created_at > now() - interval '1 hour'`,
          );
          if (attempts.rows[0]!.count >= 3 || attempts.rows[0]!.recent)
            throw new AppError('rate_limited', 'notifications.phone.rateLimited');
          const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
          const phone: PhoneState = {
            number: command.number,
            verified: false,
            hash: createHash('sha256').update(`${command.number}:${code}`).digest('hex'),
            expires: Date.now() + 600_000,
            attempts: 0,
            requestedAt: Date.now(),
          };
          after = {
            resource: 'phone',
            target: actor.userId,
            value: seal(c.secretKey!, JSON.stringify(phone), phoneContext(actor)),
          };
          await query(
            c.db,
            sql`INSERT INTO ${ident(c.schemas.app, 'notification_deliveries')}(id, org_id, user_id, channel, payload)
          VALUES (${command.id}, ${actor.orgId}, ${actor.userId}, 'verify', ${JSON.stringify({ sealed: seal(c.secretKey!, JSON.stringify({ number: command.number, code, requestedAt: phone.requestedAt }), `notifications.verify:${command.id}`) })}::jsonb)`,
          );
          break;
        }
        case 'notifications.phone.verify': {
          if (!canReceiveSms(actor)) throw new AppError('forbidden', 'notifications.sms.adminOnly');
          const phone = await phoneFor(c.db, c.schemas, c.secretKey!, actor);
          if (
            !phone ||
            phone.verified ||
            !phone.hash ||
            !phone.expires ||
            phone.expires <= Date.now() ||
            (phone.attempts ?? 0) >= 5
          )
            throw new AppError('validation_failed', 'notifications.phone.invalidCode');
          phone.attempts = (phone.attempts ?? 0) + 1;
          const hash = createHash('sha256').update(`${phone.number}:${command.code}`).digest('hex');
          if (timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(phone.hash, 'hex'))) {
            phone.verified = true;
            delete phone.hash;
            delete phone.expires;
          } else {
            result.status = 'rejected';
            result.error = { code: 'validation_failed', messageKey: 'notifications.phone.invalidCode' };
          }
          after = {
            resource: 'phone',
            target: actor.userId,
            value: seal(c.secretKey!, JSON.stringify(phone), phoneContext(actor)),
          };
          break;
        }
        case 'notifications.phone.remove':
          after = { resource: 'phone', target: actor.userId, value: null };
          break;
        case 'notifications.read': {
          const rows = await query<{ id: string }>(
            c.db,
            sql`SELECT id FROM ${ident(c.schemas.app, 'notifications')}
          WHERE org_id = ${actor.orgId} AND recipient_id = ${actor.userId} AND read_at IS NULL
          AND ${'ids' in command.read ? sql`id = ANY(${command.read.ids}::text[])` : sql`TRUE`} ORDER BY id`,
          );
          const at = new Date().toISOString();
          after = {
            resource: 'read',
            target: actor.userId,
            value: Object.fromEntries(rows.rows.map(({ id }) => [id, at])),
          };
          break;
        }
        case 'notifications.undo': {
          const stored = await query<{
            before: NotificationState;
            after: NotificationState;
            undone: boolean;
          }>(
            c.db,
            sql`SELECT before, after, undone FROM ${ident(c.schemas.app, 'notification_actions')}
          WHERE id = ${command.actionId} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
          );
          const action = stored.rows[0];
          if (!action || action.undone) throw new AppError('not_found', 'errors.notFound');
          after = action.before;
          await authorize(c, after);
          if (after.resource === 'phone')
            throw new AppError('conflict', 'notifications.phone.undoUnavailable');
          if (!(await sameState(c, await currentNotificationState(c, after), action.after)))
            throw new AppError('conflict', 'errors.conflict');
          await query(
            c.db,
            sql`UPDATE ${ident(c.schemas.app, 'notification_actions')} SET undone = true WHERE id = ${command.actionId}`,
          );
        }
      }
      if (after) {
        await authorize(c, after);
        const before = await currentNotificationState(c, after);
        await writeNotificationState(c, after);
        await query(
          c.db,
          sql`INSERT INTO ${ident(c.schemas.app, 'notification_actions')}(id, org_id, user_id, before, after)
        VALUES (${command.id}, ${actor.orgId}, ${actor.userId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)`,
        );
      }
      await auditEvent(c.db, compile(sql`${ident(c.schemas.audit)}`).text, command.kind, actor, {
        target: after?.resource ?? 'push',
        outcome: result.status,
      });
      await query(
        c.db,
        sql`SELECT pg_notify(${`${c.schemas.app}_notifications`.slice(0, 63)}, ${JSON.stringify({ orgId: actor.orgId, userId: actor.userId })})`,
      );
      return result;
    },
  );
}

/** Token renewal preserves a newer administrator connection and never exposes credentials in results. */
export async function rotateTeamsCredential(
  app: FastifyInstance,
  actor: Actor,
  previous: Extract<NotificationConnection, { channel: 'teams' }>,
  refreshToken: string,
): Promise<void> {
  const connection = NotificationConnection.parse({ ...previous, refreshToken });
  const id = newId('command');
  await runStored<NotificationCommandResult>(
    app,
    actor,
    '',
    {
      commandId: id,
      groupId: id,
      duplicate: () => ({ status: 'duplicate', actionId: id }),
      rejected: (error) => ({ status: 'rejected', actionId: id, error: error.toBody().error }),
    },
    async (c) => {
      await lock(c, [`notifications:${actor.orgId}`]);
      await authorize(c);
      const current = await credential<NotificationConnection>(
        c.db,
        c.schemas,
        c.secretKey!,
        actor.orgId,
        'teams',
      );
      if (isDeepStrictEqual(current, previous)) {
        const after: NotificationState = {
          resource: 'credential',
          target: 'teams',
          value: await sealCredential(
            c.secretKey!,
            JSON.stringify(connection),
            credentialContext(actor.orgId, 'teams'),
            actor.orgId,
            c.db,
          ),
        };
        const before = await currentNotificationState(c, after);
        await writeNotificationState(c, after);
        await query(
          c.db,
          sql`INSERT INTO ${ident(c.schemas.app, 'notification_actions')}(id, org_id, user_id, before, after)
        VALUES (${id}, ${actor.orgId}, ${actor.userId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)`,
        );
        await auditEvent(
          c.db,
          compile(sql`${ident(c.schemas.audit)}`).text,
          'notifications.connection.refreshed',
          actor,
          { channel: 'teams' },
        );
        await query(
          c.db,
          sql`SELECT pg_notify(${`${c.schemas.app}_notifications`.slice(0, 63)}, ${JSON.stringify({ orgId: actor.orgId })})`,
        );
      }
      return { status: 'applied', actionId: id };
    },
  );
}

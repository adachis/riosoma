import {
  AppError,
  MarkNotificationsRead,
  NotificationId,
  NotificationPreferencesUpdate,
  NotificationsQuery,
  TeamsAccount,
  type NotificationPreferences,
  type NotificationsPage,
  type UnreadCount,
} from '@riosoma/contracts';
import { newId, NotificationCommand, type NotificationCommandResult } from '@riosoma/contracts';
import { AccessScope } from '../data/access.js';
import { channelPreferences, credential } from '../data/notifications.js';
import { runNotificationCommand } from '../data/commands/notifications.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { dataStore } from '../data/context.js';
import { parse } from '../http/validate.js';
import { availableApp } from '../oauth/apps.js';
import {
  emailChoices,
  listNotifications,
  toNotification,
  unreadCount,
  type NotificationRow,
} from './store.js';

/**
 * The signed-in person's notifications and email choices.  Every query is limited to their own,
 * in their own organization, so an ID never reaches anyone else's.
 *
 * - `GET /api/notifications?before=<cursor>&limit=`: newest first, 30 a page
 * - `GET /api/notifications/unread`: how many are unread
 * - `POST /api/notifications/read`: marks some read, or all of them
 * - `GET` and `PUT /api/notifications/preferences`: which kinds are emailed
 */

const Cursor = z.object({ at: z.iso.datetime(), id: NotificationId });

function cursorOf(row: NotificationRow): string {
  return Buffer.from(JSON.stringify({ at: row.created_at.toISOString(), id: row.id })).toString('base64url');
}

function readCursor(value: string): z.infer<typeof Cursor> {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new AppError('validation_failed', 'errors.validationFailed');
  }
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  const emailAvailable = () => Boolean(app.ctx.mailer && app.ctx.config.baseUrl);
  app.get('/api/notifications/channels', session, async (request) => {
    const { pool, schemas } = dataStore(app.ctx);
    const actor = requireActor(request);
    const key = app.ctx.config.secretKey;
    const preferences = await channelPreferences(
      pool,
      schemas,
      key,
      actor,
      emailAvailable(),
      Boolean(app.ctx.config.baseUrl?.startsWith('https:')),
    );
    if (!preferences.canAdminister) return preferences;
    const [teamsSignInAvailable, teams] = await Promise.all([
      availableApp(app.ctx, pool, actor.orgId, 'microsoft-teams').then(
        () => true,
        (error: unknown) => {
          if (error instanceof AppError) return false;
          throw error;
        },
      ),
      preferences.available.teams
        ? credential<{ account?: unknown }>(pool, schemas, key, actor.orgId, 'teams').catch(
            (error: unknown) => {
              if (error instanceof AppError && error.messageKey === 'notifications.credentials.unavailable')
                return null;
              throw error;
            },
          )
        : null,
    ]);
    const account = TeamsAccount.safeParse(teams?.account);
    return {
      ...preferences,
      teamsSignInAvailable,
      ...(account.success ? { teamsAccount: account.data } : {}),
    };
  });
  app.post('/api/notifications/commands', session, async (request) => {
    const input = parse(NotificationCommand, request.body);
    return runNotificationCommand(app, requireActor(request), input);
  });
  app.post(
    '/api/admin/notification-channels/commands',
    { config: { policy: { kind: 'admin', area: 'integrations', scope: 'organization' } } },
    async (request) => {
      return runNotificationCommand(app, requireActor(request), request.body);
    },
  );

  app.get('/api/notifications', session, async (request): Promise<NotificationsPage> => {
    const actor = requireActor(request);
    const input = parse(NotificationsQuery, request.query);
    const cursor = input.before === undefined ? null : readCursor(input.before);
    const { pool, schemas } = dataStore(app.ctx);
    const rows = await listNotifications(pool, schemas, actor, cursor, input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      notifications: page.flatMap((row) => toNotification(row) ?? []),
      next: rows.length > input.limit && last ? cursorOf(last) : null,
    };
  });

  app.get('/api/notifications/unread', session, async (request): Promise<UnreadCount> => {
    const { pool, schemas } = dataStore(app.ctx);
    return { count: await unreadCount(pool, schemas, requireActor(request)) };
  });

  app.post('/api/notifications/read', session, async (request): Promise<UnreadCount> => {
    const actor = requireActor(request);
    if (actor.demo) {
      const { pool, schemas } = dataStore(app.ctx);
      return { count: await unreadCount(pool, schemas, actor) };
    }
    const input = parse(MarkNotificationsRead, request.body);
    const { pool, schemas } = dataStore(app.ctx);
    checked(
      await runNotificationCommand(app, actor, {
        id: newId('command'),
        kind: 'notifications.read',
        read: input,
      }),
    );
    return { count: await unreadCount(pool, schemas, actor) };
  });

  app.get('/api/notifications/preferences', session, async (request): Promise<NotificationPreferences> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    await new AccessScope(pool, schemas, actor).requireOrganization();
    return {
      email: await emailChoices(pool, schemas, actor.orgId, actor.userId),
      emailAvailable: emailAvailable(),
    };
  });

  app.put('/api/notifications/preferences', session, async (request): Promise<NotificationPreferences> => {
    const actor = requireActor(request);
    const input = parse(NotificationPreferencesUpdate, request.body);
    const { pool, schemas } = dataStore(app.ctx);
    checked(
      await runNotificationCommand(app, actor, {
        id: newId('command'),
        kind: 'notifications.preferences',
        update: { channels: { email: input.email } },
      }),
    );
    return {
      email: await emailChoices(pool, schemas, actor.orgId, actor.userId),
      emailAvailable: emailAvailable(),
    };
  });
}

function checked(result: NotificationCommandResult): void {
  if (result.status === 'rejected')
    throw new AppError('validation_failed', result.error?.messageKey ?? 'errors.validationFailed');
}

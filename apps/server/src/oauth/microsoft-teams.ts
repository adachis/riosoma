import {
  AppError,
  newId,
  TEAMS_ACCOUNT_EMAIL_MAX_LENGTH,
  TEAMS_ACCOUNT_NAME_MAX_LENGTH,
} from '@riosoma/contracts';
import { runNotificationCommand } from '../data/commands/notifications.js';
import { microsoftCalendar } from './calendars.js';
import type { OAuthProvider } from './providers.js';
import { z } from 'zod';

const directoryId = z.uuid();

export const microsoftTeams: OAuthProvider = {
  id: 'microsoft-teams',
  authorizeUrl: microsoftCalendar.authorizeUrl,
  tokenUrl: microsoftCalendar.tokenUrl,
  account: microsoftCalendar.account,
  scope: 'offline_access User.Read User.ReadBasic.All Chat.Create ChatMessage.Send',
  appComplete: (app) =>
    directoryId.safeParse(app.tenantId).success && directoryId.safeParse(app.clientId).success,
  organization: {
    area: 'integrations',
    landing: '/settings/notifications#organization',
    async complete(server, actor, app, tokens, { name, email }) {
      if (!tokens.refreshToken) throw new AppError('validation_failed', 'drives.connect.failed');
      const accountName = name.trim().slice(0, TEAMS_ACCOUNT_NAME_MAX_LENGTH);
      const accountEmail = email?.trim().slice(0, TEAMS_ACCOUNT_EMAIL_MAX_LENGTH) || null;
      const id = newId('command');
      const result = await runNotificationCommand(server, actor, {
        id,
        kind: 'notifications.connection',
        connection: {
          channel: 'teams',
          tenantId: app.tenantId,
          clientId: app.clientId,
          clientSecret: app.clientSecret,
          refreshToken: tokens.refreshToken,
          account: accountName ? { name: accountName, email: accountEmail } : undefined,
        },
      });
      if (result.status !== 'applied') {
        if (result.error?.code === 'forbidden') throw new AppError('forbidden', 'errors.adminOnly');
        throw new AppError('validation_failed', 'drives.connect.failed');
      }
      return result.actionId;
    },
  },
};

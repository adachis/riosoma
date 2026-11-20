import { AppError } from '@riosoma/contracts';
import { z } from 'zod';
import type { OAuthProvider } from './providers.js';

export const quickbooks: OAuthProvider = {
  id: 'quickbooks',
  authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
  tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  tokenAuth: 'basic',
  callbackValues: ['realmId'],
  scope: 'com.intuit.quickbooks.accounting openid profile email',
  async account(accessToken, signal, accountValues) {
    // Development credentials identify people through the sandbox OpenID service.
    for (const host of ['accounts.platform.intuit.com', 'sandbox-accounts.platform.intuit.com']) {
      const response = await fetch(`https://${host}/v1/openid_connect/userinfo`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal,
      });
      if ((response.status === 401 || response.status === 403) && host === 'accounts.platform.intuit.com')
        continue;
      const parsed = z
        .object({
          sub: z.string().min(1),
          givenName: z.string().optional(),
          familyName: z.string().optional(),
          name: z.string().optional(),
          email: z.string().optional(),
        })
        .safeParse(response.ok ? await response.json() : null);
      if (!parsed.success) throw new AppError('unavailable', 'drives.providerFailed');
      const person = parsed.data;
      return {
        // Choosing another company must replace the connection so existing sources cannot switch companies silently.
        id: accountValues?.realmId ? JSON.stringify([person.sub, accountValues.realmId]) : person.sub,
        name:
          person.name ||
          [person.givenName, person.familyName].filter(Boolean).join(' ') ||
          person.email ||
          person.sub,
        email: person.email ?? null,
      };
    }
    throw new AppError('unavailable', 'drives.providerFailed');
  },
  async revoke(tokens, app, signal) {
    await fetch('https://developer.api.intuit.com/v2/oauth2/tokens/revoke', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ token: tokens.refreshToken ?? tokens.accessToken }),
      signal,
    });
  },
};

import { AppError } from '@riosoma/contracts';
import { z } from 'zod';
import type { OAuthProvider } from './providers.js';

export const xero: OAuthProvider = {
  id: 'xero',
  authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
  tokenUrl: 'https://identity.xero.com/connect/token',
  tokenAuth: 'basic',
  scope:
    'openid profile email offline_access accounting.invoices.read accounting.payments.read accounting.banktransactions.read accounting.contacts.read accounting.settings.read accounting.manualjournals.read',
  async account(accessToken, signal) {
    const response = await fetch('https://api.xero.com/connections', {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal,
    });
    const parsed = z
      .array(
        z.object({
          tenantId: z.string().min(1).max(255),
          tenantName: z.string().min(1),
          tenantType: z.string(),
        }),
      )
      .safeParse(response.ok ? await response.json() : null);
    const organizations = parsed.success
      ? parsed.data.filter((entry) => entry.tenantType === 'ORGANISATION')
      : [];
    const first = organizations[0];
    if (!first) throw new AppError('unavailable', 'drives.providerFailed');
    return {
      id: first.tenantId,
      name: first.tenantName,
      email: null,
      settingChoices: {
        tenantId: organizations.map((entry) => ({ value: entry.tenantId, label: entry.tenantName })),
      },
    };
  },
  async revoke(tokens, app, signal) {
    await fetch('https://identity.xero.com/connect/revocation', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: tokens.refreshToken ?? tokens.accessToken }),
      signal,
    });
  },
};

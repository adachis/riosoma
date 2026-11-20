import { AppError } from '@riosoma/contracts';
import { z } from 'zod';
import type { OAuthProvider } from './providers.js';

const headers = {
  accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'user-agent': 'Riosoma',
};

export const github: OAuthProvider = {
  id: 'github',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  scope: 'repo read:org',
  invalidCodeErrors: ['bad_verification_code'],
  invalidClientErrors: ['incorrect_client_credentials'],
  async account(accessToken, signal) {
    const response = await fetch('https://api.github.com/user', {
      headers: { ...headers, authorization: `Bearer ${accessToken}` },
      signal,
    });
    const account = z
      .object({
        id: z.number().int(),
        login: z.string().min(1),
        name: z.string().nullable(),
        email: z.string().nullable(),
      })
      .safeParse(response.ok ? await response.json() : null);
    if (!account.success) throw new AppError('unavailable', 'drives.providerFailed');
    return {
      id: String(account.data.id),
      name: account.data.name ? `${account.data.name} (${account.data.login})` : account.data.login,
      email: account.data.email,
    };
  },
  async revoke(tokens, app, signal) {
    await fetch(`https://api.github.com/applications/${encodeURIComponent(app.clientId)}/grant`, {
      method: 'DELETE',
      headers: {
        ...headers,
        authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ access_token: tokens.accessToken }),
      signal,
    });
  },
};

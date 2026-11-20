import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppConnection } from '@riosoma/contracts';
import { createAppConnector } from './connector.js';
import { APP_PRESETS } from './index.js';
import type { AppPreset } from './types.js';
import type { FileNetwork, FileRequest } from '../files/network.js';

const clientId = `1000.${'a'.repeat(32)}`;
const regions = [
  ['com', 'accounts.zoho.com', 'www.zohoapis.com'],
  ['eu', 'accounts.zoho.eu', 'www.zohoapis.eu'],
  ['in', 'accounts.zoho.in', 'www.zohoapis.in'],
  ['com.au', 'accounts.zoho.com.au', 'www.zohoapis.com.au'],
  ['jp', 'accounts.zoho.jp', 'www.zohoapis.jp'],
  ['ca', 'accounts.zohocloud.ca', 'www.zohoapis.ca'],
  ['sa', 'accounts.zoho.sa', 'www.zohoapis.sa'],
  ['uk', 'accounts.zoho.uk', 'www.zohoapis.uk'],
];

async function exchange(app: string, settings: Record<string, string>, tokenHost: string, apiHost: string) {
  const secret = randomBytes(24).toString('hex');
  const refreshToken = randomBytes(24).toString('hex');
  const accessToken = randomBytes(24).toString('hex');
  const requests: Array<{ method: string; host: string; path: string; valid: boolean }> = [];
  const respond = (request: FileRequest, document: unknown) => ({
    status: 200,
    headers: {},
    url: request.url,
    body: (async function* () {
      yield Buffer.from(JSON.stringify(document));
    })(),
    close() {},
  });
  const network: FileNetwork = {
    allowsAddress: () => true,
    check: async () => ({ address: '127.0.0.1', family: 4 }),
    async request(request) {
      const form = new URLSearchParams(request.body);
      const token = request.method === 'POST';
      const valid = token
        ? form.get('grant_type') ===
            (app === 'salesforce'
              ? 'client_credentials'
              : app === 'zoom'
                ? 'account_credentials'
                : 'refresh_token') &&
          (app === 'zoom'
            ? request.headers.authorization ===
                `Basic ${Buffer.from(`${settings.clientId}:${secret}`).toString('base64')}` &&
              form.get('account_id') === settings.accountId &&
              !form.has('client_secret')
            : form.get('client_id') === clientId && form.get('client_secret') === secret) &&
          (app !== 'zoho-crm' || form.get('refresh_token') === refreshToken)
        : request.method === 'GET' && request.headers.authorization === `Bearer ${accessToken}`;
      requests.push({ method: request.method, host: request.url.host, path: request.url.pathname, valid });
      return respond(
        request,
        token ? { access_token: accessToken, expires_in: 3_600 } : { id: 'reader', sobjects: [], org: [] },
      );
    },
  };
  const preset = APP_PRESETS.find((entry) => entry.catalog.id === app)!;
  // Keep the real destination, sign-in, and key probe while isolating the exchange from discovery.
  const probe: AppPreset = {
    ...preset,
    objects: [],
    discoveries: [],
    discovery: undefined,
    allowNoObjects: true,
  };
  const connector = createAppConnector(
    { network, sockets: { connect: async () => {}, handshake: async () => {} } },
    [probe],
  );
  expect(
    (
      await connector.test({
        connection: AppConnection.parse({ kind: 'app', app, settings }),
        secrets: { clientSecret: secret, refreshToken },
      })
    ).ok,
  ).toBe(true);
  expect(requests).toEqual([
    {
      method: 'POST',
      host: tokenHost,
      path:
        app === 'salesforce' ? '/services/oauth2/token' : app === 'zoom' ? '/oauth/token' : '/oauth/v2/token',
      valid: true,
    },
    {
      method: 'GET',
      host: apiHost,
      path:
        app === 'salesforce'
          ? '/services/data/v68.0/sobjects'
          : app === 'zoom'
            ? '/v2/users/me'
            : '/crm/v8/org',
      valid: true,
    },
  ]);
}

describe('OAuth preset destinations and exchange forms', () => {
  it('keeps Salesforce credentials and API requests on the validated Developer Edition instance', async () => {
    const host = 'sample-dev-ed.develop.my.salesforce.com';
    await exchange('salesforce', { instance: `https://${host}/`, clientId }, host, host);
  });

  it('uses account credentials and basic client authentication for Zoom', async () => {
    await exchange(
      'zoom',
      { accountId: 'sample-account', clientId: 'sample-client' },
      'zoom.us',
      'api.zoom.us',
    );
  });

  it.each(regions)(
    'uses the documented sign-in and API hosts for Zoho region %s',
    async (region, accounts, api) => {
      await exchange('zoho-crm', { region: region!, clientId }, accounts!, api!);
    },
  );

  it.each([{}, { region: '' }] as Array<Record<string, string>>)(
    'defaults an omitted or empty Zoho region to the United States',
    async (settings) => {
      await exchange('zoho-crm', { ...settings, clientId }, 'accounts.zoho.com', 'www.zohoapis.com');
    },
  );
});

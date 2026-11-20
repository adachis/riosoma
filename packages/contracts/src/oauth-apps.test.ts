import { describe, expect, it } from 'vitest';
import { APP_CATALOG, AppConnection } from './app-sources.js';
import { requiredSecrets, SourceConnection } from './sources.js';

describe('OAuth app source contracts', () => {
  it.each([
    [
      'salesforce',
      { instance: 'https://sample-dev-ed.develop.my.salesforce.com', clientId: 'consumer-key' },
      ['clientSecret'],
    ],
    ['zoom', { accountId: 'sample-account', clientId: 'sample-client' }, ['clientSecret']],
    ['zoho-crm', { clientId: `1000.${'a'.repeat(32)}` }, ['clientSecret', 'refreshToken']],
  ] as const)('requires the declared sealed credentials for %s', (app, settings, secrets) => {
    const connection = SourceConnection.parse({ kind: 'app', app, settings });
    expect(requiredSecrets(connection)).toEqual(secrets);
    expect(APP_CATALOG.find((entry) => entry.id === app)?.name).toBe(
      app === 'salesforce' ? 'Salesforce' : app === 'zoom' ? 'Zoom' : 'Zoho CRM',
    );
  });

  it('validates all eight Zoho region choices without accepting arbitrary hosts', () => {
    for (const region of ['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'sa', 'uk'])
      expect(
        AppConnection.safeParse({
          kind: 'app',
          app: 'zoho-crm',
          settings: { region, clientId: `1000.${'a'.repeat(32)}` },
        }).success,
      ).toBe(true);
    expect(
      AppConnection.safeParse({
        kind: 'app',
        app: 'zoho-crm',
        settings: { region: 'https://elsewhere.example.test', clientId: `1000.${'a'.repeat(32)}` },
      }).error?.issues[0]?.message,
    ).toBe('sources.app.zoho.regionInvalid');
  });
});

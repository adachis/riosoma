import { describe, expect, it } from 'vitest';
import { APP_CATALOG, appConnectionSchema, AppConnection, type AppCatalogEntry } from './app-sources.js';
import { requiredSecrets, SourceConnection } from './sources.js';
import type { SourceTestResult } from './sources.js';
import { isAppKind, SyncStatus } from './source-refs.js';

describe('app source contracts', () => {
  it('exposes company names, key pages, and explicit help IDs without connector imports', () => {
    expect(APP_CATALOG.map((app) => app.name)).toEqual([
      'HubSpot',
      'Pipedrive',
      'Calendly',
      'Jotform',
      'Jira',
      'Confluence',
      'Linear',
      'Trello',
      'Intercom',
      'Shopify',
      'Salesforce',
      'Zoom',
      'Zoho CRM',
      'GitLab',
      'Okta',
      'Freshdesk',
      'Mailchimp',
      'Coda',
      'Typeform',
      'GitHub',
      'Xero',
      'QuickBooks Online',
    ]);
    for (const app of APP_CATALOG) {
      if (app.connect) {
        expect(app.connect).toEqual({
          provider: { github: 'github', xero: 'xero', quickbooks: 'quickbooks' }[app.id],
        });
        expect(app.secret).toBeUndefined();
        expect(app.keyUrl).toBeUndefined();
      } else {
        expect(new URL(app.keyUrl).protocol).toBe('https:');
        expect(app.secret.helpMessageId).toMatch(/^sources\.app\./);
        expect(app.secret.deniedMessageId).toMatch(/^sources\.app\./);
      }
      if (app.id === 'jotform')
        expect(app.settings).toEqual([
          {
            key: 'region',
            type: 'choice',
            values: ['default', 'eu', 'hipaa'],
            required: false,
            labelMessageId: 'sources.app.jotform.region',
            helpMessageId: 'sources.app.jotform.regionHelp',
          },
        ]);
      else if (app.id === 'jira' || app.id === 'confluence') {
        expect(app.settings.map((setting) => setting.key)).toEqual(['site', 'email']);
        for (const setting of app.settings) {
          expect(setting.labelMessageId).toMatch(/^sources\.app\./);
          expect(setting.helpMessageId).toMatch(/^sources\.app\./);
        }
      } else if (['trello', 'intercom', 'shopify', 'salesforce', 'zoom', 'zoho-crm'].includes(app.id)) {
        expect(app.settings.map((setting) => setting.key)).toEqual(
          {
            trello: ['key'],
            intercom: ['region'],
            shopify: ['store'],
            salesforce: ['instance', 'clientId'],
            zoom: ['accountId', 'clientId'],
            'zoho-crm': ['region', 'clientId'],
          }[app.id],
        );
        for (const setting of app.settings) {
          expect(setting.labelMessageId).toMatch(/^sources\.app\./);
          expect(setting.helpMessageId).toMatch(/^sources\.app\./);
          expect(setting.invalidMessageId).toMatch(/^sources\.app\./);
        }
      } else if (app.id === 'okta' || app.id === 'freshdesk') {
        expect(app.settings).toHaveLength(1);
        expect(app.settings[0]).toMatchObject({
          key: app.id === 'okta' ? 'organization' : 'helpdesk',
          type: 'address',
          domain: app.id === 'okta' ? 'okta.com' : 'freshdesk.com',
          required: true,
          allowBareName: true,
          subdomainRequired: true,
        });
      } else if (app.id === 'typeform') {
        expect(app.settings).toEqual([
          expect.objectContaining({ key: 'region', type: 'choice', values: ['default', 'eu', 'eu-new'] }),
        ]);
      } else if (app.id === 'xero') {
        expect(app.settings).toEqual([
          {
            key: 'tenantId',
            type: 'account-choice',
            required: true,
            labelMessageId: 'sources.app.xero.organization',
            helpMessageId: 'sources.app.xero.organizationHelp',
          },
        ]);
      } else if (app.id === 'quickbooks') {
        expect(app.settings).toEqual([
          {
            key: 'environment',
            type: 'choice',
            values: ['production', 'sandbox'],
            required: false,
            valueMessageIds: {
              production: 'sources.app.quickbooks.production',
              sandbox: 'sources.app.quickbooks.sandbox',
            },
            labelMessageId: 'sources.app.quickbooks.environment',
            helpMessageId: 'sources.app.quickbooks.environmentHelp',
          },
        ]);
      } else expect(app.settings).toEqual([]);
    }
  });

  it('joins the source union and uses the existing secret names', () => {
    expect(isAppKind('app')).toBe(true);
    for (const [app, secret] of [
      ['hubspot', 'token'],
      ['pipedrive', 'apiKey'],
      ['calendly', 'token'],
      ['jotform', 'apiKey'],
      ['linear', 'apiKey'],
      ['intercom', 'token'],
      ['coda', 'token'],
      ['typeform', 'token'],
    ]) {
      const connection = SourceConnection.parse({ kind: 'app', app });
      expect(connection).toEqual({ kind: 'app', app, settings: {} });
      expect(requiredSecrets(connection)).toEqual([secret]);
    }
  });

  it.each([
    ['trello', { key: 'a'.repeat(32) }, { key: 'a'.repeat(32) }],
    ['shopify', { store: 'Sample-Store' }, { store: 'https://sample-store.myshopify.com' }],
  ])('validates required settings and uses the API key secret slot for %s', (app, settings, normalized) => {
    const connection = AppConnection.parse({ kind: 'app', app, settings });
    expect(SourceConnection.parse(connection)).toEqual(connection);
    expect(connection.settings).toEqual(normalized);
    expect(requiredSecrets(connection)).toEqual(['apiKey']);
    expect(AppConnection.safeParse({ kind: 'app', app }).success).toBe(false);
  });

  it('accepts every Intercom region and the default without accepting address overrides', () => {
    for (const settings of [{}, { region: '' }, ...['us', 'eu', 'au'].map((region) => ({ region }))])
      expect(AppConnection.safeParse({ kind: 'app', app: 'intercom', settings }).success).toBe(true);
    for (const region of ['other', 'US', 1, null, {}, ['eu']])
      expect(
        AppConnection.safeParse({ kind: 'app', app: 'intercom', settings: { region } }).error?.issues[0]
          ?.message,
      ).toBe('sources.app.intercom.regionInvalid');
  });

  it('accepts only Jotform region choices and keeps addresses and keys out of settings', () => {
    for (const settings of [{}, { region: '' }, ...['default', 'eu', 'hipaa'].map((region) => ({ region }))])
      expect(SourceConnection.safeParse({ kind: 'app', app: 'jotform', settings }).success).toBe(true);
    for (const region of ['other', 'https://api.jotform.com', 'EU', 1, null, {}, ['eu']])
      expect(
        AppConnection.safeParse({ kind: 'app', app: 'jotform', settings: { region } }).error?.issues[0]
          ?.message,
      ).toBe('sources.app.settingInvalid');
    for (const key of ['apiKey', 'baseUrl', 'limit', 'headers'])
      expect(
        AppConnection.safeParse({ kind: 'app', app: 'jotform', settings: { [key]: 'value' } }).error
          ?.issues[0]?.message,
      ).toBe('sources.app.undeclaredSetting');
  });

  it('carries object permission parameters in test notes and saved sync failures', () => {
    const diagnostic = {
      messageKey: 'sources.app.objectNotAllowed',
      params: { object: 'tickets', permission: 'tickets-read', hasPermission: true },
    };
    const result: SourceTestResult = {
      ok: true,
      steps: [{ step: 'rows', status: 'skipped', ms: 0, ...diagnostic }],
    };
    expect(result.steps[0]?.params).toEqual(diagnostic.params);
    expect(
      SyncStatus.parse({
        state: 'failed',
        lastSyncAt: null,
        lastSuccessAt: null,
        nextSyncAt: null,
        error: diagnostic,
        stats: null,
        held: null,
      }).error,
    ).toEqual(diagnostic);
  });

  it('refuses unknown apps, undeclared settings, and connection overrides', () => {
    const unknown = AppConnection.safeParse({ kind: 'app', app: 'missing', settings: {} });
    expect(unknown.error?.issues[0]?.message).toBe('sources.app.unknown');
    const setting = AppConnection.safeParse({ kind: 'app', app: 'hubspot', settings: { token: 'value' } });
    expect(setting.error?.issues[0]?.message).toBe('sources.app.undeclaredSetting');
    expect(
      AppConnection.safeParse({ kind: 'app', app: 'hubspot', baseUrl: 'https://elsewhere.test' }).success,
    ).toBe(false);
  });

  it.each(['jira', 'confluence'])('completes a bare site name and requires the API token for %s', (app) => {
    const input = { kind: 'app', app, settings: { site: 'Sample-Site', email: 'reader@example.test' } };
    const connection = SourceConnection.parse(input);
    expect(connection).toEqual({
      ...input,
      settings: { ...input.settings, site: 'https://sample-site.atlassian.net' },
    });
    expect(input.settings.site).toBe('Sample-Site');
    expect(requiredSecrets(connection)).toEqual(['password']);
    expect(
      AppConnection.parse({
        ...input,
        settings: { ...input.settings, site: 'https://sample-site.atlassian.net/' },
      }).settings.site,
    ).toBe('https://sample-site.atlassian.net/');
    expect(AppConnection.safeParse({ kind: 'app', app }).error?.issues.map((issue) => issue.message)).toEqual(
      ['sources.app.atlassian.siteRequired', 'sources.app.atlassian.emailRequired'],
    );
  });

  it.each([
    '.reader@example.test',
    'reader.@example.test',
    'reader..name@example.test',
    'reader@example..test',
  ])('refuses malformed email punctuation: %s', (email) => {
    expect(
      AppConnection.safeParse({ kind: 'app', app: 'jira', settings: { site: 'sample-site', email } }).error
        ?.issues[0]?.message,
    ).toBe('sources.app.atlassian.emailInvalid');
  });

  const catalog: AppCatalogEntry[] = [
    {
      id: 'example',
      name: 'Example',
      settings: [
        {
          key: 'account',
          required: true,
          labelMessageId: 'sources.app.settingRequired',
          helpMessageId: 'sources.app.settingInvalid',
          type: 'address',
          domain: 'example.test',
        },
        {
          key: 'region',
          required: true,
          labelMessageId: 'sources.app.settingRequired',
          helpMessageId: 'sources.app.settingInvalid',
          type: 'choice',
          values: ['us', 'eu'],
        },
        {
          key: 'name',
          required: false,
          labelMessageId: 'sources.app.settingRequired',
          helpMessageId: 'sources.app.settingInvalid',
          type: 'text',
          maxLength: 20,
          pattern: '^[a-z]+$',
        },
      ],
      secret: {
        name: 'password',
        helpMessageId: 'sources.app.secretMissing',
        deniedMessageId: 'sources.app.authenticate',
      },
      keyUrl: 'https://example.test/settings',
    },
  ];
  const schema = appConnectionSchema(catalog);
  const connection = {
    kind: 'app',
    app: 'example',
    settings: { account: 'https://customer.example.test', region: 'us' },
  };

  it('uses declared required, choice, and text rules', () => {
    expect(schema.safeParse(connection).success).toBe(true);
    expect(schema.safeParse({ ...connection, settings: {} }).error?.issues[0]?.message).toBe(
      'sources.app.settingRequired',
    );
    for (const settings of [
      { ...connection.settings, region: 'other' },
      { ...connection.settings, name: '123' },
      { ...connection.settings, name: 'a'.repeat(21) },
      { ...connection.settings, region: 1 },
    ])
      expect(schema.safeParse({ ...connection, settings }).error?.issues[0]?.message).toBe(
        'sources.app.settingInvalid',
      );
  });

  it('restricts customer addresses to the app domain without URL credentials or parameters', () => {
    for (const account of [
      'https://elsewhere.test',
      'https://example.test.attacker.test',
      'https://customerexample.test',
      'http://customer.example.test',
      'https://user:pass@customer.example.test',
      'https://customer.example.test/path',
      'https://customer.example.test?token=value',
      'https://customer.example.test:444',
    ])
      expect(
        schema.safeParse({ ...connection, settings: { ...connection.settings, account } }).error?.issues[0]
          ?.message,
      ).toBe('sources.app.address');
  });

  it('reads a host pasted without its scheme as the same https address', () => {
    for (const account of ['customer.example.test', 'Customer.Example.test/', ' customer.example.test '])
      expect(schema.parse({ ...connection, settings: { ...connection.settings, account } }).settings).toEqual(
        {
          ...connection.settings,
          account: 'https://customer.example.test',
        },
      );
    for (const account of [
      'customer.example.test.attacker.test',
      'customerexample.test',
      'customer.example.test:444',
    ])
      expect(
        schema.safeParse({ ...connection, settings: { ...connection.settings, account } }).error?.issues[0]
          ?.message,
      ).toBe('sources.app.address');
  });
});

it('requires a connection ID for connecting apps and never asks for a stored key', () => {
  const connection = AppConnection.parse({
    kind: 'app',
    app: 'github',
    settings: { connectionId: 'own-account' },
  });
  expect(requiredSecrets(connection)).toEqual([]);
  for (const settings of [
    {},
    { connectionId: '' },
    { connectionId: 1 },
    { connectionId: 'own-account', token: 'untrusted' },
  ])
    expect(AppConnection.safeParse({ kind: 'app', app: 'github', settings }).success).toBe(false);
});

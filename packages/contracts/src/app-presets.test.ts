import { assert, describe, expect, it } from 'vitest';
import { APP_CATALOG, AppConnection } from './app-sources.js';
import { requiredSecrets, RestEndpoint, SourceConnection } from './sources.js';

describe('additional app preset contracts', () => {
  it.each([
    ['gitlab', {}, 'token'],
    ['okta', { organization: 'Sample' }, 'apiKey'],
    ['freshdesk', { helpdesk: 'Sample' }, 'apiKey'],
    ['mailchimp', {}, 'apiKey'],
  ])('keeps %s in the public source union with its declared sealed key', (app, settings, secret) => {
    const connection = SourceConnection.parse({ kind: 'app', app, settings });
    expect(requiredSecrets(connection)).toEqual([secret]);
    const entry = APP_CATALOG.find((entry) => entry.id === app)!;
    assert(entry.secret);
    expect(entry.secret.name).toBe(secret);
    expect(entry.secret.helpMessageId).toMatch(/^sources\.app\./);
    expect(entry.secret.deniedMessageId).toMatch(/^sources\.app\./);
    for (const setting of entry.settings) {
      expect(setting.labelMessageId).toMatch(/^sources\.app\./);
      expect(setting.helpMessageId).toMatch(/^sources\.app\./);
    }
  });

  it.each([
    ['okta', 'organization', 'okta.com'],
    ['freshdesk', 'helpdesk', 'freshdesk.com'],
  ])('normalizes %s tenant names without changing the supplied settings', (app, field, domain) => {
    const settings = { [field!]: 'Sample-Account' };
    const parsed = AppConnection.parse({ kind: 'app', app, settings });
    expect(parsed.settings).toEqual({ [field!]: `https://sample-account.${domain}` });
    expect(settings[field!]).toBe('Sample-Account');
  });

  it('accepts a declared total-count path while leaving ordinary offset paging intact', () => {
    const paging = {
      style: 'offset',
      offsetParam: 'offset',
      limitParam: 'count',
      limit: 1_000,
      totalPath: 'total_items',
    };
    expect(RestEndpoint.parse({ name: 'audiences', paging }).paging).toEqual(paging);
    expect(RestEndpoint.safeParse({ name: 'audiences', paging: { ...paging, totalPath: '' } }).success).toBe(
      false,
    );
  });
});

describe('connected accounting app contracts', () => {
  it.each([
    ['xero', { connectionId: 'own-account', tenantId: 'organization-one' }],
    ['quickbooks', { connectionId: 'own-account' }],
    ['quickbooks', { connectionId: 'own-account', environment: 'sandbox' }],
  ])('requires a connected account for %s without a source secret', (app, settings) => {
    const connection = SourceConnection.parse({ kind: 'app', app, settings });
    expect(requiredSecrets(connection)).toEqual([]);
  });
  it('requires a Xero organization and refuses malformed organization or environment settings', () => {
    for (const settings of [
      { connectionId: 'own-account' },
      { connectionId: 'own-account', tenantId: 'bad\r\nheader' },
    ])
      expect(AppConnection.safeParse({ kind: 'app', app: 'xero', settings }).success).toBe(false);
    expect(
      AppConnection.safeParse({
        kind: 'app',
        app: 'quickbooks',
        settings: { connectionId: 'own-account', environment: 'other' },
      }).success,
    ).toBe(false);
  });
});

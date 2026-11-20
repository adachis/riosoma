import { describe, expect, it } from 'vitest';
import { registerAppCatalog, type AppCatalogEntry } from './app-sources.js';
import { requiredSecrets, RestAuth, RestConnection, RestPaging, SourceSecrets } from './sources.js';

describe('extended app frame contracts', () => {
  it('requires every declared secret in catalog order and accepts sealed refresh tokens', () => {
    const app: AppCatalogEntry = {
      id: 'frame-fixture',
      name: 'Example',
      settings: [],
      secret: {
        name: 'clientSecret',
        helpMessageId: 'sources.app.key',
        deniedMessageId: 'sources.app.authenticate',
      },
      additionalSecrets: [
        {
          name: 'refreshToken',
          labelMessageId: 'sources.app.refreshToken',
          helpMessageId: 'sources.app.key',
        },
      ],
      keyUrl: 'https://example.test/keys',
    };
    registerAppCatalog([app]);
    expect(requiredSecrets({ kind: 'app', app: app.id, settings: {} })).toEqual([
      'clientSecret',
      'refreshToken',
    ]);
    expect(SourceSecrets.safeParse({ refreshToken: '' }).success).toBe(false);
    expect(SourceSecrets.safeParse({ refreshToken: 'fixture' }).success).toBe(true);
  });

  it('accepts only a short scheme word followed by exactly one space', () => {
    const auth = { method: 'header', name: 'Authorization' };
    expect(RestAuth.safeParse({ ...auth, prefix: 'SSWS ' }).success).toBe(true);
    for (const prefix of ['', 'SSWS', 'SSWS  ', ' SSWS ', 'SSWS\r\n', 'A'.repeat(30) + ' ', 'two words '])
      expect(RestAuth.safeParse({ ...auth, prefix }).success).toBe(false);
    expect(RestAuth.parse({ method: 'basic', user: 'X', secretAsUsername: true })).toMatchObject({
      secretAsUsername: true,
    });
    expect(RestAuth.safeParse({ method: 'basic', user: 'X', secretAsUsername: 'yes' }).success).toBe(false);
  });

  it('defaults existing exchanges and requires a refresh secret only for the refresh grant', () => {
    const auth = { method: 'oauth-client', tokenUrl: 'https://example.test/token', clientId: 'example' };
    const connection = RestConnection.parse({
      kind: 'rest',
      baseUrl: 'https://example.test',
      auth,
      endpoints: [{ name: 'items' }],
    });
    expect(requiredSecrets(connection)).toEqual(['clientSecret']);
    for (const grant of ['client_credentials', 'account_credentials', 'refresh_token']) {
      const parsed = RestConnection.parse({
        ...connection,
        auth: { ...auth, grant, tokenParams: { account_id: 'account' } },
      });
      expect(requiredSecrets(parsed)).toEqual(
        grant === 'refresh_token' ? ['clientSecret', 'refreshToken'] : ['clientSecret'],
      );
    }
    expect(RestAuth.safeParse({ ...auth, grant: 'password' }).success).toBe(false);
    for (const name of ['grant_type', 'client_id', 'client_secret', 'refresh_token', 'scope'])
      expect(RestAuth.safeParse({ ...auth, tokenParams: { [name]: 'override' } }).success).toBe(false);
    expect(RestAuth.safeParse({ ...auth, tokenParams: { account_id: 'bad\nvalue' } }).success).toBe(false);
  });

  it('requires a record cursor field, query parameter, and positive page size', () => {
    const paging = {
      style: 'last-record',
      cursorPath: 'token',
      param: 'before',
      size: 100,
      sizeParam: 'page_size',
    };
    expect(RestPaging.parse(paging)).toEqual(paging);
    for (const patch of [
      { cursorPath: '' },
      { param: '' },
      { size: 0 },
      { size: 10_001 },
      { size: undefined },
    ])
      expect(RestPaging.safeParse({ ...paging, ...patch }).success).toBe(false);
  });
});

describe('accounting app contracts', () => {
  it('validates positions embedded in a query value without changing ordinary page settings', () => {
    const paging = {
      style: 'page',
      param: 'query',
      start: 1,
      step: 1000,
      size: 1000,
      valueTemplate: 'SELECT * FROM Customer STARTPOSITION {page} MAXRESULTS 1000',
    };
    expect(RestPaging.parse(paging)).toEqual(paging);
    for (const patch of [
      { step: 0 },
      { step: 1.5 },
      { step: 10001 },
      { valueTemplate: 'fixed query' },
      { valueTemplate: 'bad\n{page}' },
    ])
      expect(RestPaging.safeParse({ ...paging, ...patch }).success).toBe(false);
  });
});

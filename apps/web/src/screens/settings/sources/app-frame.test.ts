import { RestAuth, RestConnection } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { fromConnection, fromEndpoint, toConnection, toEndpoint, toRestTarget } from './kinds';

describe('app transport settings in the API form', () => {
  it.each([
    { method: 'header', name: 'Authorization', prefix: 'SSWS ' },
    { method: 'basic', user: 'X', secretAsUsername: true },
    {
      method: 'oauth-client',
      tokenUrl: 'https://example.test/token',
      clientId: 'client',
      grant: 'account_credentials',
      tokenParams: { account_id: 'account' },
    },
    {
      method: 'oauth-client',
      tokenUrl: 'https://example.test/token',
      clientId: 'client',
      grant: 'refresh_token',
    },
  ])('preserves configured options while editing $method sources', (input) => {
    const auth = RestAuth.parse(input);
    const connection = RestConnection.parse({
      kind: 'rest',
      baseUrl: 'https://example.test',
      auth,
      endpoints: [{ name: 'items' }],
    });
    const values = fromConnection(connection);
    expect(toRestTarget(values)?.auth).toMatchObject(auth);
    expect(toConnection('rest', values)).toMatchObject({ auth });
    const changed = toRestTarget({ ...values, restAuth: 'none' });
    expect(changed?.auth).toEqual({ method: 'none' });
  });

  it('preserves record cursors and their page size when another endpoint field changes', () => {
    const endpoint = RestConnection.parse({
      kind: 'rest',
      baseUrl: 'https://example.test',
      endpoints: [
        {
          name: 'items',
          paging: {
            style: 'last-record',
            cursorPath: 'token',
            param: 'before',
            size: 100,
            sizeParam: 'page_size',
          },
        },
      ],
    }).endpoints[0]!;
    expect(toEndpoint({ ...fromEndpoint(endpoint), name: 'renamed' })?.paging).toEqual(endpoint.paging);
  });
});

describe('query value paging in the source form', () => {
  it('preserves a query position and page step while editing another endpoint field', () => {
    const endpoint = RestConnection.parse({
      kind: 'rest',
      baseUrl: 'https://example.test',
      endpoints: [
        {
          name: 'customers',
          paging: {
            style: 'page',
            param: 'query',
            start: 1,
            step: 1000,
            size: 1000,
            valueTemplate: 'SELECT * FROM Customer STARTPOSITION {page} MAXRESULTS 1000',
          },
        },
      ],
    }).endpoints[0]!;
    expect(toEndpoint({ ...fromEndpoint(endpoint), name: 'renamed' })?.paging).toEqual(endpoint.paging);
  });
});

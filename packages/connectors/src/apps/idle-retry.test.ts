import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { FileNetworkError, type FileNetwork, type FileRequest } from '../files/network.js';
import type { ConnectorContext } from '../types.js';
import { createAppConnector } from './connector.js';
import { salesforce } from './salesforce.js';
import { zohoCrm } from './zoho-crm.js';

function response(request: FileRequest, document: unknown) {
  return {
    status: 200,
    headers: {},
    url: request.url,
    body: (async function* () {
      yield Buffer.from(JSON.stringify(document));
    })(),
    close: vi.fn(),
  };
}

function stall({ signal }: FileRequest): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new FileNetworkError('failed')), { once: true });
  });
}

function network(request: FileNetwork['request']): FileNetwork {
  return {
    allowsAddress: () => true,
    check: async () => ({ address: '127.0.0.1', family: 4 }),
    request,
  };
}

function select(name: string) {
  return { kind: 'object' as const, object: { schema: null, name } };
}

it.each(['retry', 'cancel'])('handles a Salesforce preview stall with %s', async (action) => {
  const requests: string[] = [];
  const controller = new AbortController();
  let describes = 0;
  const request: FileNetwork['request'] = async (call) => {
    const path = call.url.pathname.split('/').at(-1)!;
    requests.push(path);
    if (path === 'token') return response(call, { access_token: 'preview-token' });
    if (path === 'sobjects') return response(call, { sobjects: [{ name: 'Account', queryable: true }] });
    if (path === 'describe') {
      if (++describes === 1) {
        const pending = stall(call);
        if (action === 'cancel') controller.abort();
        return pending;
      }
      return response(call, { fields: [{ name: 'Id' }, { name: 'Name' }] });
    }
    return response(call, { records: [{ Id: 'account-1', Name: 'Account name' }], done: true });
  };
  const connector = createAppConnector({ network: network(request), retries: 1 }, [salesforce]);
  const context: ConnectorContext = {
    connection: {
      kind: 'app',
      app: 'salesforce',
      settings: { instance: 'https://preview.my.salesforce.com', clientId: randomUUID() },
    },
    secrets: { clientSecret: 'preview-client-secret' },
    timeoutMs: 1_500,
    signal: controller.signal,
  };

  const pending = connector.preview(context, select('Account'), 3);
  if (action === 'cancel') {
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(requests).toEqual(['token', 'sobjects', 'describe']);
    return;
  }
  const preview = await pending;
  expect(preview.columns.map(({ name }) => name)).toEqual(['Id', 'Name']);
  expect(preview.rows).toEqual([['account-1', 'Account name']]);
  expect(requests).toEqual(['token', 'sobjects', 'describe', 'describe', 'query']);
});

it('applies the same overall deadline to Salesforce discovery and field selection', async () => {
  const requests: string[] = [];
  const request: FileNetwork['request'] = async (call) => {
    const path = call.url.pathname.split('/').at(-1)!;
    requests.push(path);
    return response(
      call,
      path === 'token'
        ? { access_token: 'deadline-token' }
        : { sobjects: [{ name: 'Account', queryable: true }] },
    );
  };
  const connector = createAppConnector({ network: network(request), deadlineMs: 800 }, [salesforce]);
  await expect(
    connector.preview(
      {
        connection: {
          kind: 'app',
          app: 'salesforce',
          settings: { instance: 'https://deadline.my.salesforce.com', clientId: randomUUID() },
        },
        secrets: { clientSecret: 'deadline-client-secret' },
        timeoutMs: 1_500,
      },
      select('Account'),
      3,
    ),
  ).rejects.toMatchObject({ messageKey: 'sources.app.timeout' });
  expect(requests).toEqual(['token', 'sobjects']);
});

it.each(['fields', 'page', 'token'])(
  'retries a stalled Zoho CRM %s during a multi-module read and yields each key once',
  async (stalled) => {
    const requests: string[] = [];
    const account = `1000.${randomUUID().replaceAll('-', '')}`;
    const request: FileNetwork['request'] = async (call) => {
      const path = call.url.pathname.split('/').at(-1)!;
      const module = call.url.searchParams.get('module');
      const cursor = call.url.searchParams.get('page_token');
      const name = [path, module ?? cursor].filter(Boolean).join(':');
      const first = !requests.includes(name);
      requests.push(name);
      if (path === 'token') {
        if (stalled === 'token' && first) return stall(call);
        return response(call, { access_token: 'read-token' });
      }
      if (path === 'modules')
        return response(call, {
          modules: ['Accounts', 'Contacts'].map((api_name) => ({ api_name, api_supported: true })),
        });
      if (path === 'fields') {
        if (stalled === 'fields' && module === 'Contacts' && first) return stall(call);
        return response(call, { fields: [{ api_name: 'id' }] });
      }
      if (path === 'Contacts' && !cursor)
        return response(call, {
          data: [{ id: 'contact-1' }],
          info: { more_records: true, next_page_token: 'next' },
        });
      if (stalled === 'page' && name === 'Contacts:next' && first) {
        return {
          ...response(call, undefined),
          body: (async function* () {
            yield Buffer.from('{"data":[{"id":"partial"}');
            await stall(call);
          })(),
        };
      }
      return response(call, {
        data: [{ id: path === 'Accounts' ? 'account-1' : 'contact-2' }],
        info: { more_records: false },
      });
    };
    const connector = createAppConnector({ network: network(request), retries: 1, deadlineMs: 4_000 }, [
      { ...zohoCrm, target: { ...zohoCrm.target, requestsPerSecond: 20 } },
    ]);
    const context: ConnectorContext = {
      connection: { kind: 'app', app: 'zoho-crm', settings: { clientId: account } },
      secrets: { clientSecret: 'read-client-secret', refreshToken: 'read-refresh-token' },
      timeoutMs: 250,
    };
    const rows = [];
    for (const name of ['Accounts', 'Contacts']) {
      for await (const batch of connector.read(context, select(name), {
        columns: ['id'],
        keyColumns: ['id'],
        types: {},
        batchSize: 1,
      }))
        rows.push(...batch);
    }

    expect(rows.map((row) => row.values.id)).toEqual(['account-1', 'contact-1', 'contact-2']);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(requests).toEqual([
      'token',
      ...(stalled === 'token' ? ['token'] : []),
      'modules',
      'fields:Accounts',
      'Accounts',
      'modules',
      'fields:Contacts',
      ...(stalled === 'fields' ? ['fields:Contacts'] : []),
      'Contacts',
      'Contacts:next',
      ...(stalled === 'page' ? ['Contacts:next'] : []),
    ]);
  },
);

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Entra's token address and the parts of Microsoft Graph SharePoint list and Excel
 * workbook sources read, for tests.  It hands out tokens only to its own app with its own secret,
 * answers one site's lists, a list's columns and items (paged), the site's libraries, and a
 * workbook's content, and refuses anything else the way Graph does.  It never reaches Microsoft.
 */

export interface FakeListItem {
  id: string;
  fields: Record<string, unknown>;
}

export interface FakeMicrosoft {
  /** Where Graph and the token address answer, like `http://127.0.0.1:1234` */
  url: string;
  tenant: string;
  clientId: string;
  secret: string;
  /** The site's address, as a source names it */
  site: string;
  siteId: string;
  /** The workbook's address, as a source names it */
  workbook: string;
  /** The list's items, which a test may change between syncs */
  items: FakeListItem[];
  /** The workbook's bytes, which a test sets */
  workbookBytes: Buffer;
  /** Tokens the token address handed out */
  tokens: string[];
  requests: Array<{ method: string; path: string }>;
  close(): Promise<void>;
}

const COLUMNS = [
  { name: 'Title', displayName: 'Plant', text: {} },
  { name: 'Price', displayName: 'Price', currency: {} },
  { name: 'Planted', displayName: 'Planted', dateTime: { format: 'dateOnly' } },
  { name: 'Organic', displayName: 'Organic', boolean: {} },
  { name: 'ID', displayName: 'ID', number: {}, readOnly: true },
];

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function problem(res: ServerResponse, status: number, code: string, message: string) {
  send(res, status, { error: { code, message } });
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

export interface FakeMicrosoftDelegation {
  tenant: string;
  account: { id: string; name: string; email: string };
  messages: unknown[];
  refreshToken?: string;
}

export async function startFakeMicrosoft(delegation?: FakeMicrosoftDelegation): Promise<FakeMicrosoft> {
  const tenant = delegation?.tenant ?? 'garden.onmicrosoft.com';
  const siteId =
    'garden.sharepoint.com,11111111-aaaa-4bbb-8ccc-000000000001,22222222-aaaa-4bbb-8ccc-000000000002';
  const fake: FakeMicrosoft = {
    url: '',
    tenant,
    clientId: '11111111-2222-4333-8444-555555555555',
    secret: ['garden', 'app', 'secret', Math.random().toString(36).slice(2)].join('-'),
    site: 'https://garden.sharepoint.com/sites/Nursery',
    siteId,
    workbook: 'https://garden.sharepoint.com/sites/Nursery/Shared%20Documents/Beds.xlsx',
    items: [],
    workbookBytes: Buffer.alloc(0),
    tokens: [],
    requests: [],
    close: async () => undefined,
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', fake.url);
    fake.requests.push({ method: req.method ?? 'GET', path: url.pathname });
    if (url.pathname === `/${tenant}/oauth2/v2.0/token` && req.method === 'POST') {
      const form = new URLSearchParams(await bodyOf(req));
      if (form.get('client_id') !== fake.clientId || form.get('client_secret') !== fake.secret)
        return send(res, 401, {
          error: 'invalid_client',
          error_description: 'AADSTS7000215: Invalid client secret provided.',
          error_codes: [7000215],
        });
      const token = `eyJ0.fake.${fake.tokens.length + 1}`;
      fake.tokens.push(token);
      const grant = form.get('grant_type');
      let refreshToken: string | undefined;
      if (delegation && grant === 'authorization_code') {
        if (!form.get('code_verifier') || !['approved', 'without-refresh'].includes(form.get('code') ?? ''))
          return send(res, 400, { error: 'invalid_grant' });
        if (form.get('code') === 'approved')
          refreshToken = delegation.refreshToken = randomBytes(24).toString('base64url');
      }
      if (delegation && grant === 'refresh_token') {
        if (!delegation.refreshToken || form.get('refresh_token') !== delegation.refreshToken)
          return send(res, 400, { error: 'invalid_grant' });
        refreshToken = delegation.refreshToken = randomBytes(24).toString('base64url');
      }
      return send(res, 200, {
        token_type: 'Bearer',
        expires_in: 3599,
        access_token: token,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
      });
    }
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!fake.tokens.includes(bearer))
      return problem(res, 401, 'InvalidAuthenticationToken', 'Token is empty.');
    const path = url.pathname;
    if (delegation) {
      const { id, name, email } = delegation.account;
      if (path === '/v1.0/me')
        return send(res, 200, { id, displayName: name, mail: null, userPrincipalName: email });
      if (path === '/v1.0/users') return send(res, 200, { value: [{ id: 'recipient' }] });
      if (path === '/v1.0/chats') return send(res, 201, { id: 'direct' });
      if (path === '/v1.0/chats/direct/messages') {
        delegation.messages.push(JSON.parse(await bodyOf(req)));
        return send(res, 201, { id: 'message' });
      }
    }
    if (path === '/v1.0/sites/garden.sharepoint.com:/sites/Nursery')
      return send(res, 200, { id: siteId, displayName: 'Nursery', webUrl: fake.site });
    const prefix = `/v1.0/sites/${encodeURIComponent(siteId)}`;
    if (path === `${prefix}/lists`)
      return send(res, 200, {
        value: [
          { id: 'list-plants', displayName: 'Plants', list: { template: 'genericList', hidden: false } },
        ],
      });
    if (path === `${prefix}/lists/list-plants/columns`) return send(res, 200, { value: COLUMNS });
    if (path === `${prefix}/lists/list-plants/items`) {
      const skip = Number(url.searchParams.get('$skiptoken') ?? 0);
      const next = new URL(url);
      next.searchParams.set('$skiptoken', String(skip + 2));
      return send(res, 200, {
        value: fake.items.slice(skip, skip + 2),
        ...(skip + 2 < fake.items.length ? { '@odata.nextLink': next.href } : {}),
      });
    }
    if (path === `${prefix}/drives`)
      return send(res, 200, {
        value: [{ id: 'drive-docs', name: 'Documents', webUrl: `${fake.site}/Shared%20Documents` }],
      });
    if (path === '/v1.0/drives/drive-docs/root:/Beds.xlsx')
      return send(res, 200, { id: 'item-beds', name: 'Beds.xlsx', file: {} });
    if (path === '/v1.0/drives/drive-docs/items/item-beds/content') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(fake.workbookBytes);
    }
    problem(res, 404, 'itemNotFound', 'The resource could not be found.');
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) problem(res, 500, 'generalException', 'boom');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}

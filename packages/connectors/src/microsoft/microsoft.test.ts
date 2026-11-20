import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';
/**
 * Microsoft 365 sources against a local stand-in for Entra's token address, Microsoft Graph, and a
 * Dataverse environment's Web API.  The stand-in checks each token request the way Entra does,
 * hands out a token for the scope asked for, and answers the refusals Microsoft gives: a tenant or
 * an app it doesn't know, a wrong secret, an app with no access to a site, an app that isn't one of
 * an environment's users, and requests to slow down.  The network here is a plain one, since the
 * private-network rule belongs to the server, whose own tests hold these sources to it.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { SourceConnection, type SheetCell, type SourceSecrets } from '@riosoma/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SpreadsheetReader } from '../files/engine.js';
import { FileNetworkError, type FileNetwork, type FileResponse } from '../files/network.js';
import { ConnectorError, type Connector, type ConnectorContext, type SourceRow } from '../types.js';
import { nearestDay } from './client.js';
import { createDataverseConnector, ROW_ID } from './dataverse.js';
import { createExcelOnlineConnector } from './excel.js';
import { createSharePointListConnector, ITEM_ID } from './sharepoint.js';

// ------------------------------------------------------------------ the app

const TENANT = 'garden.onmicrosoft.com';
const CLIENT = '11111111-2222-4333-8444-555555555555';
const SECRET = ['garden', 'app', 'secret', 'value', '0123456789'].join('-');
const SITE = 'https://contoso.sharepoint.com/sites/Garden';
const SITE_ID =
  'contoso.sharepoint.com,11111111-aaaa-4bbb-8ccc-000000000001,22222222-aaaa-4bbb-8ccc-000000000002';
const WORKBOOK = `${SITE}/Shared%20Documents/Plans/Beds%202026.xlsx`;
const ENVIRONMENT = 'https://garden.crm.dynamics.com';

// ------------------------------------------------------------ the stand-in

let server: Server;
let origin = '';
let tokenRequests = 0;
const issued = new Map<string, string>();
let throttles = 0;
let retryAfter: string | undefined;
/** Sites the app was given, by Graph ID.  Others answer 403, as Sites.Selected does. */
let granted: Set<string>;
let appUser = true;
let privileged = true;
let nextElsewhere = false;
const seen: Array<{ path: string; query: URLSearchParams }> = [];

const LISTS = [
  { id: 'list-plants', displayName: 'Plants', list: { template: 'genericList', hidden: false } },
  { id: 'list-beds', displayName: 'Beds', list: { template: 'genericList', hidden: false } },
  { id: 'lib-docs', displayName: 'Documents', list: { template: 'documentLibrary', hidden: false } },
  { id: 'list-history', displayName: 'Workflow History', list: { template: 'genericList', hidden: true } },
];

const PLANT_COLUMNS = [
  { name: 'Title', displayName: 'Title', text: { allowMultipleLines: false }, required: true },
  { name: 'Price', displayName: 'Price', currency: { locale: 'en-us' } },
  { name: 'Height', displayName: 'Height', number: { decimalPlaces: 'one' } },
  { name: 'Organic', displayName: 'Organic', boolean: {} },
  { name: 'Planted', displayName: 'Planted', dateTime: { format: 'dateOnly' } },
  { name: 'LastChecked', displayName: 'Last checked', dateTime: { format: 'dateTime' } },
  {
    name: 'Season',
    displayName: 'Season',
    choice: { choices: ['Spring', 'Summer', 'Fall'], displayAs: 'dropDownMenu' },
  },
  {
    name: 'Tags',
    displayName: 'Tags',
    choice: { choices: ['Herb', 'Edible', 'Shade'], displayAs: 'checkBoxes' },
  },
  { name: 'Care', displayName: 'Care', text: { allowMultipleLines: true, textType: 'richText' } },
  { name: 'Guide', displayName: 'Guide', hyperlinkOrPicture: { isPicture: false } },
  { name: 'Gardener', displayName: 'Gardener', personOrGroup: { allowMultipleSelection: false } },
  { name: 'Bed', displayName: 'Bed', lookup: { listId: 'list-beds', columnName: 'Title' } },
  { name: 'Total', displayName: 'Total', calculated: { outputType: 'currency' }, readOnly: true },
  { name: 'Where', displayName: 'Where', geolocation: {} },
  { name: 'Title0', displayName: 'Title', text: {} },
  { name: 'ItemCode', displayName: 'Item ID', text: {} },
  { name: '_Internal', displayName: 'Internal', text: {} },
  { name: 'Secret', displayName: 'Secret', text: {}, hidden: true },
  { name: 'ContentType', displayName: 'Content Type', text: {} },
  { name: 'ID', displayName: 'ID', number: {}, readOnly: true },
  { name: 'Version', displayName: 'Version', text: {}, readOnly: true },
  { name: 'Created', displayName: 'Created', dateTime: { format: 'dateTime' }, readOnly: true },
  { name: 'Author', displayName: 'Created By', personOrGroup: {}, readOnly: true },
];

let plants: Array<{ id: string; fields: Record<string, unknown> }>;

function reset() {
  tokenRequests = 0;
  issued.clear();
  throttles = 0;
  retryAfter = undefined;
  granted = new Set([SITE_ID]);
  appUser = true;
  privileged = true;
  nextElsewhere = false;
  seen.length = 0;
  plants = [
    {
      id: '1',
      fields: {
        Title: 'Basil',
        Price: 3.5,
        Height: 20.5,
        Organic: true,
        // Midnight in Los Angeles, which SharePoint keeps as the instant it was in UTC.
        Planted: '2026-04-02T07:00:00Z',
        LastChecked: '2026-05-01T15:30:00Z',
        Season: 'Spring',
        Tags: ['Herb', 'Edible'],
        Care: '<div><p><strong>Water</strong> daily</p></div>',
        Guide: { Description: 'Growing basil', Url: 'https://example.com/basil' },
        GardenerLookupId: '7',
        BedLookupId: '2',
        Total: 'float;#7',
        Title0: 'Sweet basil',
        ItemCode: 'B-1',
        Created: '2026-04-01T10:00:00Z',
        AuthorLookupId: '7',
      },
    },
    {
      id: '2',
      fields: {
        Title: 'Thyme',
        Price: 4,
        Organic: false,
        // Midnight in Berlin, the day before in UTC.
        Planted: '2026-04-08T22:00:00Z',
        Season: 'Summer',
        Tags: ['Herb'],
        Gardener: [{ LookupId: 8, LookupValue: 'Grace Hopper', Email: 'grace@example.com' }],
        GardenerLookupId: '8',
        ItemCode: 'T-2',
        Created: '2026-04-02T10:00:00Z',
        AuthorLookupId: '8',
      },
    },
    { id: '3', fields: { Title: 'Sage', ItemCode: 'S-3', AuthorLookupId: '7' } },
  ];
}
reset();

const PEOPLE = [
  { id: '7', fields: { Title: 'Ada Lovelace' } },
  { id: '8', fields: { Title: 'Grace Hopper' } },
];
const BEDS = [
  { id: '1', fields: { Title: 'South bed' } },
  { id: '2', fields: { Title: 'North bed' } },
];

/** A workbook as the fake reader reads it, which the stand-in serves as its content. */
const BOOK = {
  sheets: [
    {
      name: 'Beds',
      rows: [
        ['Bed', 'Plant', 'Area', 'Sown', 'Watered'],
        ['N-1', 'Basil', 2.5, { date: '2026-04-02' }, true],
        ['N-2', 'Thyme', 3, { date: '2026-04-09' }, false],
        ['S-1', 'Sage', 1.25, { date: '2026-04-16' }, true],
      ],
    },
    { name: 'Notes', rows: [['Note'], ['Mulch in May']] },
  ],
};

const readBook: SpreadsheetReader = async function* (bytes) {
  const book = JSON.parse(bytes.toString('utf8')) as { sheets: Array<{ name: string; rows: SheetCell[][] }> };
  for (const [position, sheet] of book.sheets.entries()) {
    yield { kind: 'sheet', name: sheet.name, position };
    for (const [index, cells] of sheet.rows.entries()) yield { kind: 'row', number: index + 1, cells };
    yield { kind: 'end', rows: sheet.rows.length, total: sheet.rows.length };
  }
};

function send(res: ServerResponse, status: number, body: unknown, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function graphError(res: ServerResponse, status: number, code: string, message: string) {
  send(res, status, { error: { code, message, innerError: { 'request-id': 'req-1' } } });
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

/** A page of `items`, with a next link while there are more, `$top` at a time. */
function page(res: ServerResponse, url: URL, items: unknown[], top: number) {
  const skip = Number(url.searchParams.get('$skiptoken') ?? 0);
  const next = new URL(url);
  next.searchParams.set('$skiptoken', String(skip + top));
  const more = skip + top < items.length;
  send(res, 200, {
    value: items.slice(skip, skip + top),
    ...(more
      ? {
          '@odata.nextLink': nextElsewhere
            ? `https://elsewhere.example.com${next.pathname}${next.search}`
            : next.href,
        }
      : {}),
  });
}

/** Items with only the fields the request selected, as Graph gives them. */
function selected(url: URL, items: Array<{ id: string; fields: Record<string, unknown> }>) {
  const expand = url.searchParams.get('$expand') ?? '';
  const names = /\$select=([^)]*)\)/.exec(expand)?.[1]?.split(',');
  return items.map((item) => ({
    id: item.id,
    fields: names
      ? Object.fromEntries(Object.entries(item.fields).filter(([name]) => names.includes(name)))
      : item.fields,
  }));
}

async function token(req: IncomingMessage, res: ServerResponse, tenant: string) {
  tokenRequests++;
  const form = new URLSearchParams(await body(req));
  if (tenant !== TENANT)
    return send(res, 400, {
      error: 'invalid_request',
      error_description: `AADSTS90002: Tenant '${tenant}' not found.`,
      error_codes: [90002],
    });
  if (form.get('client_id') !== CLIENT)
    return send(res, 400, {
      error: 'unauthorized_client',
      error_description: `AADSTS700016: Application with identifier '${form.get('client_id')}' was not found.`,
      error_codes: [700016],
    });
  if (form.get('client_secret') !== SECRET)
    return send(res, 401, {
      error: 'invalid_client',
      error_description: `AADSTS7000215: Invalid client secret provided. Secret was ${form.get('client_secret')}`,
      error_codes: [7000215],
    });
  const scope = form.get('scope') ?? '';
  if (form.get('grant_type') !== 'client_credentials' || !scope.endsWith('/.default'))
    return send(res, 400, { error: 'invalid_scope', error_codes: [70011] });
  if (scope.includes('elsewhere.crm'))
    return send(res, 400, {
      error: 'invalid_resource',
      error_description: `AADSTS500011: The resource principal named ${scope} was not found in the tenant.`,
      error_codes: [500011],
    });
  const value = `eyJ0.${scope.replace(/\W/g, '')}.${tokenRequests}`;
  issued.set(value, scope);
  send(res, 200, { token_type: 'Bearer', expires_in: 3599, access_token: value });
}

async function graph(res: ServerResponse, url: URL, path: string) {
  if (throttles > 0) {
    throttles--;
    res.writeHead(429, {
      'content-type': 'application/json',
      ...(retryAfter ? { 'retry-after': retryAfter } : {}),
    });
    return res.end(JSON.stringify({ error: { code: 'TooManyRequests', message: 'Too many requests' } }));
  }
  if (path === `/v1.0/sites/contoso.sharepoint.com:/sites/Garden`)
    return send(res, 200, { id: SITE_ID, displayName: 'Garden', webUrl: SITE });
  if (path.startsWith('/v1.0/sites/contoso.sharepoint.com:/'))
    return graphError(res, 404, 'itemNotFound', 'Requested site could not be found');
  const site = /^\/v1\.0\/sites\/([^/]+)\/(.*)$/.exec(path);
  if (site) {
    const id = decodeURIComponent(site[1]!);
    if (id !== SITE_ID) return graphError(res, 404, 'itemNotFound', 'Item not found');
    if (!granted.has(id)) return graphError(res, 403, 'accessDenied', 'Access denied');
    const rest = site[2]!;
    if (rest === 'lists') return page(res, url, LISTS, 3);
    if (rest === 'drives')
      return send(res, 200, {
        value: [
          { id: 'drive-forms', name: 'Forms', webUrl: `${SITE}/Forms%20Library` },
          { id: 'drive-docs', name: 'Documents', webUrl: `${SITE}/Shared%20Documents` },
        ],
      });
    const list = /^lists\/([^/]+)\/(columns|items)$/.exec(rest);
    if (list) {
      const listId = decodeURIComponent(list[1]!);
      if (list[2] === 'columns') {
        if (listId === 'list-plants') return page(res, url, PLANT_COLUMNS, 50);
        if (listId === 'list-beds')
          return send(res, 200, { value: [{ name: 'Title', displayName: 'Title', text: {} }] });
        return graphError(res, 404, 'itemNotFound', 'List not found');
      }
      const top = Number(url.searchParams.get('$top') ?? 200);
      if (listId === 'list-plants') return page(res, url, selected(url, plants), Math.min(top, 2));
      if (listId === 'list-beds') return page(res, url, selected(url, BEDS), top);
      if (listId === 'User Information List') return page(res, url, selected(url, PEOPLE), top);
      return graphError(res, 404, 'itemNotFound', 'List not found');
    }
    return graphError(res, 400, 'invalidRequest', `Unexpected ${rest}`);
  }
  if (path === '/v1.0/drives/drive-docs/root:/Plans/Beds%202026.xlsx')
    return send(res, 200, {
      id: 'item-beds',
      name: 'Beds 2026.xlsx',
      file: { mimeType: 'application/xlsx' },
    });
  if (path === '/v1.0/drives/drive-docs/items/item-beds/content') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(JSON.stringify(BOOK));
  }
  if (path.startsWith('/v1.0/drives/drive-docs/root:/'))
    return graphError(res, 404, 'itemNotFound', 'The resource could not be found.');
  graphError(res, 400, 'invalidRequest', `Unexpected ${path}`);
}

const PLANT_ATTRIBUTES = [
  {
    LogicalName: 'rio_plantid',
    AttributeType: 'Uniqueidentifier',
    DisplayName: label('Plant'),
    ColumnNumber: 1,
  },
  { LogicalName: 'rio_name', AttributeType: 'String', DisplayName: label('Name'), ColumnNumber: 2 },
  { LogicalName: 'rio_email', AttributeType: 'String', DisplayName: label('Contact email'), ColumnNumber: 3 },
  { LogicalName: 'rio_notes', AttributeType: 'Memo', DisplayName: label('Notes'), ColumnNumber: 4 },
  { LogicalName: 'rio_count', AttributeType: 'Integer', DisplayName: label('Count'), ColumnNumber: 5 },
  { LogicalName: 'rio_price', AttributeType: 'Money', DisplayName: label('Price'), ColumnNumber: 6 },
  { LogicalName: 'rio_organic', AttributeType: 'Boolean', DisplayName: label('Organic'), ColumnNumber: 7 },
  { LogicalName: 'rio_planted', AttributeType: 'DateTime', DisplayName: label('Planted'), ColumnNumber: 8 },
  {
    LogicalName: 'modifiedon',
    AttributeType: 'DateTime',
    DisplayName: label('Modified On'),
    ColumnNumber: 9,
  },
  { LogicalName: 'rio_season', AttributeType: 'Picklist', DisplayName: label('Season'), ColumnNumber: 10 },
  {
    LogicalName: 'rio_tags',
    AttributeType: 'Virtual',
    AttributeTypeName: { Value: 'MultiSelectPicklistType' },
    DisplayName: label('Tags'),
    ColumnNumber: 11,
  },
  { LogicalName: 'rio_bed', AttributeType: 'Lookup', DisplayName: label('Bed'), ColumnNumber: 12 },
  { LogicalName: 'rio_bedname', AttributeType: 'String', AttributeOf: 'rio_bed', ColumnNumber: 13 },
  { LogicalName: 'statecode', AttributeType: 'State', DisplayName: label('Status'), ColumnNumber: 14 },
  { LogicalName: 'rio_photo', AttributeType: 'Image', DisplayName: label('Photo'), ColumnNumber: 15 },
  { LogicalName: 'rio_hidden', AttributeType: 'String', IsValidForRead: false, ColumnNumber: 16 },
  { LogicalName: 'rio_rowid', AttributeType: 'String', DisplayName: label('Row ID'), ColumnNumber: 17 },
];

function label(text: string) {
  return { UserLocalizedLabel: { Label: text, LanguageCode: 1033 } };
}

function options(entries: Array<[number, string]>) {
  return { Options: entries.map(([value, text]) => ({ Value: value, Label: label(text) })) };
}

const DETAILS: Record<string, unknown[]> = {
  StringAttributeMetadata: [
    { LogicalName: 'rio_name', MaxLength: 100, FormatName: { Value: 'Text' } },
    { LogicalName: 'rio_email', MaxLength: 100, FormatName: { Value: 'Email' } },
    { LogicalName: 'rio_rowid', MaxLength: 100, FormatName: { Value: 'Text' } },
  ],
  MoneyAttributeMetadata: [{ LogicalName: 'rio_price', Precision: 2 }],
  DateTimeAttributeMetadata: [
    { LogicalName: 'rio_planted', Format: 'DateOnly', DateTimeBehavior: { Value: 'DateOnly' } },
    { LogicalName: 'modifiedon', Format: 'DateAndTime', DateTimeBehavior: { Value: 'UserLocal' } },
  ],
  PicklistAttributeMetadata: [
    {
      LogicalName: 'rio_season',
      OptionSet: null,
      GlobalOptionSet: options([
        [1, 'Spring'],
        [2, 'Summer'],
      ]),
    },
  ],
  StateAttributeMetadata: [
    {
      LogicalName: 'statecode',
      OptionSet: options([
        [0, 'Active'],
        [1, 'Inactive'],
      ]),
    },
  ],
  MultiSelectPicklistAttributeMetadata: [
    {
      LogicalName: 'rio_tags',
      OptionSet: options([
        [10, 'Herb'],
        [20, 'Edible'],
      ]),
    },
  ],
};

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const PLANT_ROWS = [
  {
    rio_plantid: 'aaaaaaaa-0000-4000-8000-000000000001',
    rio_name: 'Basil',
    rio_email: 'basil@example.com',
    rio_count: 12,
    rio_price: 3.5,
    rio_organic: true,
    rio_planted: '2026-04-02',
    modifiedon: '2026-05-01T15:30:00Z',
    rio_season: 1,
    [`rio_season${FORMATTED}`]: 'Spring',
    rio_tags: '10,20',
    [`rio_tags${FORMATTED}`]: 'Herb; Edible',
    _rio_bed_value: 'bbbbbbbb-0000-4000-8000-000000000002',
    [`_rio_bed_value${FORMATTED}`]: 'North bed',
    statecode: 0,
    [`statecode${FORMATTED}`]: 'Active',
    rio_rowid: 'R-1',
  },
  {
    rio_plantid: 'aaaaaaaa-0000-4000-8000-000000000002',
    rio_name: 'Thyme',
    rio_count: 4,
    rio_organic: false,
    statecode: 1,
    [`statecode${FORMATTED}`]: 'Inactive',
  },
  { rio_plantid: 'aaaaaaaa-0000-4000-8000-000000000003', rio_name: 'Sage' },
];

async function dataverse(res: ServerResponse, url: URL, path: string, bearer: string) {
  if (!issued.get(bearer)?.startsWith(ENVIRONMENT))
    return send(res, 401, { error: { code: '0x80040220', message: 'The token is for another audience' } });
  if (!appUser)
    return send(res, 403, {
      error: { code: '0x80072560', message: 'The user is not a member of the organization.' },
    });
  const rest = path.slice('/dv/api/data/v9.2/'.length);
  if (rest === 'WhoAmI')
    return send(res, 200, { UserId: 'u-1', BusinessUnitId: 'b-1', OrganizationId: 'o-1' });
  if (rest === 'EntityDefinitions')
    return page(
      res,
      url,
      [
        {
          LogicalName: 'rio_plant',
          EntitySetName: 'rio_plants',
          DisplayName: label('Plant'),
          IsCustomEntity: true,
        },
        {
          LogicalName: 'account',
          EntitySetName: 'accounts',
          DisplayName: label('Account'),
          IsValidForAdvancedFind: true,
        },
        {
          LogicalName: 'rio_plant_bed',
          EntitySetName: 'rio_plant_beds',
          IsIntersect: true,
          IsCustomEntity: true,
        },
        { LogicalName: 'plugintracelog', EntitySetName: 'plugintracelogs', IsValidForAdvancedFind: false },
      ],
      2,
    );
  const definition =
    /^EntityDefinitions\(LogicalName='(\w+)'\)(?:\/Attributes\/Microsoft\.Dynamics\.CRM\.(\w+))?$/.exec(
      decodeURIComponent(rest),
    );
  if (definition) {
    if (definition[1] !== 'rio_plant')
      return send(res, 404, { error: { code: '0x80060888', message: 'Could not find entity' } });
    if (definition[2]) return send(res, 200, { value: DETAILS[definition[2]] ?? [] });
    return send(res, 200, {
      LogicalName: 'rio_plant',
      EntitySetName: 'rio_plants',
      PrimaryIdAttribute: 'rio_plantid',
      DisplayName: label('Plant'),
      Attributes: PLANT_ATTRIBUTES,
    });
  }
  if (rest === 'rio_plants') {
    if (!privileged)
      return send(res, 403, {
        error: { code: '0x80040220', message: 'Principal user is missing prvReadrio_plant privilege' },
      });
    const wanted = (url.searchParams.get('$select') ?? '').split(',');
    // An image column can't be selected with the rest, so asking for one fails the request.
    if (wanted.includes('rio_photo'))
      return send(res, 400, { error: { code: '0x80060888', message: 'Could not select rio_photo' } });
    const rows = PLANT_ROWS.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([name]) => wanted.includes(name.split('@')[0]!))),
    );
    return page(res, url, rows, 2);
  }
  send(res, 404, { error: { code: '0x80060888', message: `Resource not found for the segment '${rest}'.` } });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', origin);
  seen.push({ path: url.pathname, query: url.searchParams });
  const tokenPath = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(url.pathname);
  if (tokenPath && req.method === 'POST') return token(req, res, decodeURIComponent(tokenPath[1]!));
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (url.pathname.startsWith('/dv/')) return dataverse(res, url, url.pathname, bearer);
  if (!issued.get(bearer)?.startsWith(origin))
    return graphError(res, 401, 'InvalidAuthenticationToken', 'Access token is empty.');
  return graph(res, url, url.pathname);
}

const plainNetwork: FileNetwork = {
  allowsAddress: (url) => url.protocol === 'https:' || url.hostname === '127.0.0.1',
  check: async () => ({ address: '127.0.0.1', family: 4 }),
  request: ({ url, method, headers, body: sent, maxBytes, signal }) =>
    new Promise<FileResponse>((resolve, reject) => {
      if (url.hostname !== '127.0.0.1') {
        reject(new FileNetworkError('blocked', `nothing may reach ${url.hostname}`));
        return;
      }
      const outgoing = httpRequest(url, { method, headers, signal }, (incoming) => {
        let size = 0;
        resolve({
          status: incoming.statusCode ?? 0,
          headers: Object.fromEntries(
            Object.entries(incoming.headers).map(([name, value]) => [
              name,
              Array.isArray(value) ? value.join(', ') : value,
            ]),
          ),
          url,
          body: (async function* () {
            for await (const chunk of incoming) {
              size += (chunk as Buffer).length;
              if (size > maxBytes) throw new FileNetworkError('tooLarge');
              yield chunk as Buffer;
            }
          })(),
          close: () => incoming.destroy(),
        });
      });
      outgoing.on('error', (error) => reject(new FileNetworkError('failed', error.message)));
      outgoing.end(sent);
    }),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'boom' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  reset();
});

const shared = () => ({
  network: plainNetwork,
  sockets: { connect: async () => undefined, handshake: async () => undefined },
  loginUrl: origin,
  // Fast enough for tests, and still paced.
  requestsPerSecond: 500,
});

const sharePoint = (extra = {}) => createSharePointListConnector({ ...shared(), graphUrl: origin, ...extra });
const excel = (extra = {}) =>
  createExcelOnlineConnector({ ...shared(), graphUrl: origin, spreadsheet: readBook, ...extra });
const dataverseConnector = (extra = {}) =>
  createDataverseConnector({ ...shared(), apiUrlFor: () => `${origin}/dv`, ...extra });

function context(
  connection: Record<string, unknown>,
  secrets: SourceSecrets = { clientSecret: SECRET },
): ConnectorContext {
  return {
    connection: SourceConnection.parse({ tenantId: TENANT, clientId: CLIENT, ...connection }),
    secrets,
    timeoutMs: 20_000,
  };
}

const listsContext = (extra: Record<string, unknown> = {}, secrets?: SourceSecrets) =>
  context({ kind: 'sharepoint-list', sites: [SITE], ...extra }, secrets);
const workbooksContext = (extra: Record<string, unknown> = {}, secrets?: SourceSecrets) =>
  context({ kind: 'excel-online', workbooks: [WORKBOOK], ...extra }, secrets);
const tablesContext = (extra: Record<string, unknown> = {}, secrets?: SourceSecrets) =>
  context({ kind: 'dataverse', environmentUrl: ENVIRONMENT, ...extra }, secrets);

const object = (schema: string | null, name: string) => ({
  kind: 'object' as const,
  object: { schema, name },
});

async function refusal(work: Promise<unknown>): Promise<ConnectorError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  return error as ConnectorError;
}

async function everyRow(
  connector: Connector,
  ctx: ConnectorContext,
  select: ReturnType<typeof object>,
  columns: string[],
  keyColumns: string[],
  types: Record<string, string> = {},
): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for await (const batch of connector.read(ctx, select, { columns, keyColumns, types, batchSize: 2 }))
    rows.push(...batch);
  return rows;
}

/** The secret and every token the stand-in handed out, none of which a message may hold. */
function leaks(text: string): string[] {
  return [SECRET, ...issued.keys()].filter((part) => text.includes(part));
}

// ------------------------------------------------------------------- tests

describe('an Entra app’s sign-in', () => {
  it('asks for a token with the client credentials grant and keeps it until it nearly expires', async () => {
    const ctx = listsContext();
    await sharePoint().listObjects(ctx);
    await sharePoint().listObjects(ctx);
    expect(tokenRequests).toBe(1);
  });

  it('says which part of the sign-in Entra refused, without the secret', async () => {
    const tenant = await refusal(
      sharePoint().listObjects(listsContext({ tenantId: 'elsewhere.onmicrosoft.com' })),
    );
    expect(tenant.messageKey).toBe('sources.microsoft.tenant');
    const client = await refusal(
      sharePoint().listObjects(listsContext({ clientId: '99999999-2222-4333-8444-555555555555' })),
    );
    expect(client.messageKey).toBe('sources.microsoft.client');
    const secret = await refusal(
      sharePoint().listObjects(listsContext({}, { clientSecret: `${SECRET}-old` })),
    );
    expect(secret.messageKey).toBe('sources.microsoft.secret');
    expect(secret.detail).toContain('AADSTS7000215');
    expect(leaks(`${secret.detail} ${secret.message}`)).toEqual([]);
    expect(secret.detail).not.toContain(`${SECRET}-old`);
    const missing = await refusal(sharePoint().listObjects(listsContext({}, {})));
    expect(missing.messageKey).toBe('sources.secretsMissing');
  });

  it('rounds a date SharePoint keeps as a zone’s midnight to the day it names', () => {
    expect(nearestDay('2026-04-02T07:00:00Z')).toBe('2026-04-02');
    expect(nearestDay('2026-04-08T22:00:00Z')).toBe('2026-04-09');
    expect(nearestDay('2026-04-09')).toBe('2026-04-09');
    expect(nearestDay('not a date')).toBeNull();
  });
});

describe('SharePoint list sources', () => {
  it('climbs the test to reading a first item', async () => {
    const result = await sharePoint().test(listsContext());
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['lists', 'ok'],
      ['rows', 'ok'],
    ]);
    expect(result.ok).toBe(true);
  });

  it('says the app needs access when a site wasn’t given to it, and names a site that isn’t there', async () => {
    granted.clear();
    const denied = await sharePoint().test(listsContext());
    expect(denied.steps.at(-1)).toMatchObject({
      step: 'lists',
      status: 'failed',
      messageKey: 'sources.sharepoint.denied',
    });
    expect(leaks(JSON.stringify(denied))).toEqual([]);
    const gone = await sharePoint().test(
      listsContext({ sites: ['https://contoso.sharepoint.com/sites/Orchard'] }),
    );
    expect(gone.steps.at(-1)).toMatchObject({ step: 'lists', messageKey: 'sources.sharepoint.site' });
  });

  it('offers a site’s lists, not its libraries or hidden lists', async () => {
    const objects = await sharePoint().listObjects(listsContext());
    expect(objects).toEqual([
      {
        schema: SITE_ID,
        schemaLabel: 'Garden',
        name: 'list-plants',
        label: 'Plants',
        type: 'list',
        rowEstimate: null,
      },
      {
        schema: SITE_ID,
        schemaLabel: 'Garden',
        name: 'list-beds',
        label: 'Beds',
        type: 'list',
        rowEstimate: null,
      },
    ]);
  });

  it('types each column by its definition and leaves SharePoint’s own columns out', async () => {
    const columns = await sharePoint().describe(listsContext(), object(SITE_ID, 'list-plants'));
    expect(columns.map((column) => [column.name, column.suggested?.type ?? null])).toEqual([
      ['Title', 'text'],
      ['Price', 'number'],
      ['Height', 'number'],
      ['Organic', 'checkbox'],
      ['Planted', 'date'],
      ['Last checked', 'date'],
      ['Season', 'singleSelect'],
      ['Tags', 'multipleSelect'],
      ['Care', 'longText'],
      ['Guide', 'url'],
      ['Gardener', 'text'],
      ['Bed', 'text'],
      ['Total', 'number'],
      ['Where', null],
      ['Title_1', 'text'],
      ['Item ID_1', 'text'],
      ['Created', 'date'],
      ['Created By', 'text'],
      [ITEM_ID, 'number'],
    ]);
    const byName = new Map(columns.map((column) => [column.name, column]));
    expect(byName.get('Height')!.suggested!.options).toEqual({ precision: 1 });
    expect(byName.get('Planted')!.suggested!.options).toEqual({});
    expect(byName.get('Last checked')!.suggested!.options).toEqual({ includeTime: true, timeZone: 'UTC' });
    expect(byName.get('Care')!.suggested!.options).toEqual({ richText: true });
    const season = byName.get('Season')!.suggested!.options as { choices: Array<{ name: string }> };
    expect(season.choices.map((choice) => choice.name)).toEqual(['Spring', 'Summer', 'Fall']);
    expect(byName.get('Bed')!.notes).toEqual([
      { messageKey: 'sources.sharepoint.lookupText', params: { list: 'Beds' } },
    ]);
    expect(byName.get('Gardener')!.notes).toEqual([{ messageKey: 'sources.sharepoint.peopleText' }]);
    expect(byName.get('Total')!.notes).toEqual([{ messageKey: 'sources.sharepoint.computed' }]);
    expect(byName.get(ITEM_ID)).toMatchObject({ role: 'recordId', nullable: false });
    expect(
      await sharePoint().keyCandidates(listsContext(), { schema: SITE_ID, name: 'list-plants' }),
    ).toEqual([[ITEM_ID]]);
  });

  it('reads every item, with people and lookups by name, across pages', async () => {
    const columns = [
      'Title',
      'Price',
      'Planted',
      'Last checked',
      'Season',
      'Tags',
      'Care',
      'Guide',
      'Gardener',
      'Bed',
      'Total',
      'Created By',
    ];
    const rows = await everyRow(
      sharePoint(),
      listsContext(),
      object(SITE_ID, 'list-plants'),
      columns,
      [ITEM_ID],
      {
        Care: 'longText',
      },
    );
    expect(rows.map((row) => row.key)).toEqual(['[1]', '[2]', '[3]']);
    expect(rows[0]!.values).toEqual({
      Title: 'Basil',
      Price: 3.5,
      Planted: '2026-04-02',
      'Last checked': '2026-05-01T15:30:00.000Z',
      Season: 'Spring',
      Tags: ['Herb', 'Edible'],
      Care: '**Water** daily',
      Guide: 'https://example.com/basil',
      Gardener: 'Ada Lovelace',
      Bed: 'North bed',
      Total: 7,
      'Created By': 'Ada Lovelace',
    });
    expect(rows[1]!.values).toMatchObject({ Planted: '2026-04-09', Gardener: 'Grace Hopper', Bed: null });
    expect(rows[2]!.values).toMatchObject({
      Title: 'Sage',
      Price: null,
      Tags: null,
      'Created By': 'Ada Lovelace',
    });
    // Items were asked for with only the fields the columns read.
    const read = seen.find((entry) => entry.path.endsWith('/list-plants/items'))!;
    expect(read.query.get('$expand')).toContain('GardenerLookupId');
  });

  it('reads a column as another type when the field asks, and fails when a column is gone', async () => {
    const rows = await everyRow(
      sharePoint(),
      listsContext(),
      object(SITE_ID, 'list-plants'),
      ['Tags', 'Price'],
      [ITEM_ID],
      {
        Tags: 'text',
        Price: 'text',
      },
    );
    expect(rows[0]!.values).toEqual({ Tags: 'Herb, Edible', Price: '3.5' });
    const gone = await refusal(
      everyRow(sharePoint(), listsContext(), object(SITE_ID, 'list-plants'), ['Shade'], [ITEM_ID]),
    );
    expect(gone).toMatchObject({ messageKey: 'sources.sync.columnMissing', params: { column: 'Shade' } });
    const list = await refusal(
      everyRow(sharePoint(), listsContext(), object(SITE_ID, 'lib-docs'), ['Title'], [ITEM_ID]),
    );
    expect(list.messageKey).toBe('sources.sync.objectMissing');
    const queries = await refusal(
      sharePoint().preview(listsContext(), { kind: 'query', sql: 'SELECT 1' }, 5),
    );
    expect(queries.messageKey).toBe('sources.microsoft.noQueries');
  });

  it('waits out a 429 as long as Graph asks, and gives up past the wait it allows', async () => {
    throttles = 1;
    retryAfter = '1';
    const started = Date.now();
    await sharePoint().listObjects(listsContext());
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    throttles = 10;
    retryAfter = '120';
    const slow = await refusal(sharePoint().listObjects(listsContext()));
    expect(slow.messageKey).toBe('sources.microsoft.rateLimited');
  });

  it('never follows a next page to another address', async () => {
    nextElsewhere = true;
    const moved = await refusal(sharePoint().listObjects(listsContext()));
    expect(moved.messageKey).toBe('sources.microsoft.unreadable');
    expect(seen.some((entry) => entry.path.includes('elsewhere'))).toBe(false);
  });
});

describe('Excel workbook sources', () => {
  it('finds a workbook in its library, and offers its sheets', async () => {
    const objects = await excel().listObjects(workbooksContext());
    expect(objects).toEqual([
      {
        schema: 'item-beds',
        schemaLabel: 'Beds 2026.xlsx',
        name: 'Beds',
        label: 'Beds',
        type: 'sheet',
        rowEstimate: null,
      },
      {
        schema: 'item-beds',
        schemaLabel: 'Beds 2026.xlsx',
        name: 'Notes',
        label: 'Notes',
        type: 'sheet',
        rowEstimate: null,
      },
    ]);
    const result = await excel().test(workbooksContext());
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['workbooks', 'ok'],
      ['rows', 'ok'],
    ]);
  });

  it('types a sheet’s columns the way uploads are typed, and reads it', async () => {
    const preview = await excel().preview(workbooksContext(), object('item-beds', 'Beds'), 2);
    expect(preview.columns.map((column) => [column.name, column.suggested?.type])).toEqual([
      ['Bed', 'text'],
      ['Plant', 'text'],
      ['Area', 'number'],
      ['Sown', 'date'],
      ['Watered', 'checkbox'],
    ]);
    expect(preview.rows).toEqual([
      ['N-1', 'Basil', 2.5, '2026-04-02', true],
      ['N-2', 'Thyme', 3, '2026-04-09', false],
    ]);
    expect(preview.rowEstimate).toBe(3);
    expect(await excel().keyCandidates(workbooksContext(), { schema: 'item-beds', name: 'Beds' })).toEqual([
      ['Bed'],
      ['Plant'],
      ['Area'],
      ['Sown'],
    ]);
    const rows = await everyRow(
      excel(),
      workbooksContext(),
      object('item-beds', 'Beds'),
      ['Plant', 'Area'],
      ['Bed'],
    );
    expect(rows).toEqual([
      { key: '["N-1"]', values: { Plant: 'Basil', Area: 2.5 } },
      { key: '["N-2"]', values: { Plant: 'Thyme', Area: 3 } },
      { key: '["S-1"]', values: { Plant: 'Sage', Area: 1.25 } },
    ]);
  });

  it('says when a workbook isn’t where the source says, or a sheet is gone', async () => {
    const missing = await refusal(
      excel().listObjects(workbooksContext({ workbooks: [`${SITE}/Shared%20Documents/Gone.xlsx`] })),
    );
    expect(missing.messageKey).toBe('sources.excel.notFound');
    const library = await refusal(
      excel().listObjects(workbooksContext({ workbooks: [`${SITE}/Site%20Assets/Beds.xlsx`] })),
    );
    expect(library.messageKey).toBe('sources.excel.notFound');
    const sheet = await refusal(excel().preview(workbooksContext(), object('item-beds', 'Chart'), 2));
    expect(sheet).toMatchObject({ messageKey: 'sources.sync.objectMissing', params: { object: 'Chart' } });
    granted.clear();
    const denied = await refusal(excel().listObjects(workbooksContext()));
    expect(denied.messageKey).toBe('sources.excel.denied');
  });
});

describe('Dataverse sources', () => {
  it('climbs the test to listing the environment’s tables', async () => {
    const result = await dataverseConnector().test(tablesContext());
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['entities', 'ok'],
    ]);
  });

  it('says when the app isn’t one of the environment’s users, or the environment isn’t the tenant’s', async () => {
    appUser = false;
    const result = await dataverseConnector().test(tablesContext());
    expect(result.steps.at(-1)).toMatchObject({ step: 'entities', messageKey: 'sources.dataverse.notUser' });
    const elsewhere = await refusal(
      dataverseConnector().listObjects(
        tablesContext({ environmentUrl: 'https://elsewhere.crm.dynamics.com' }),
      ),
    );
    expect(elsewhere.messageKey).toBe('sources.dataverse.environment');
  });

  it('offers the tables people work with, by display name', async () => {
    const objects = await dataverseConnector().listObjects(tablesContext());
    expect(objects).toEqual([
      { schema: null, name: 'account', label: 'Account', type: 'table', rowEstimate: null },
      { schema: null, name: 'rio_plant', label: 'Plant', type: 'table', rowEstimate: null },
    ]);
  });

  it('types columns by their definitions and reads choices and lookups by name', async () => {
    const preview = await dataverseConnector().preview(tablesContext(), object(null, 'rio_plant'), 5);
    expect(preview.columns.map((column) => [column.name, column.suggested?.type ?? null])).toEqual([
      ['Name', 'text'],
      ['Contact email', 'email'],
      ['Notes', 'longText'],
      ['Count', 'number'],
      ['Price', 'number'],
      ['Organic', 'checkbox'],
      ['Planted', 'date'],
      ['Modified On', 'date'],
      ['Season', 'singleSelect'],
      ['Tags', 'multipleSelect'],
      ['Bed', 'text'],
      ['Status', 'singleSelect'],
      ['Photo', null],
      ['Row ID_1', 'text'],
      [ROW_ID, 'text'],
    ]);
    const season = preview.columns.find((column) => column.name === 'Season')!.suggested!.options as {
      choices: Array<{ name: string }>;
    };
    expect(season.choices.map((choice) => choice.name)).toEqual(['Spring', 'Summer']);
    expect(preview.rows[0]).toEqual([
      'Basil',
      'basil@example.com',
      null,
      12,
      3.5,
      true,
      '2026-04-02',
      '2026-05-01T15:30:00.000Z',
      'Spring',
      ['Herb', 'Edible'],
      'North bed',
      'Active',
      null,
      'R-1',
      'aaaaaaaa-0000-4000-8000-000000000001',
    ]);
    expect(
      await dataverseConnector().keyCandidates(tablesContext(), { schema: null, name: 'rio_plant' }),
    ).toEqual([[ROW_ID]]);
  });

  it('reads every row across pages, and says which privilege the app lacks', async () => {
    const rows = await everyRow(
      dataverseConnector(),
      tablesContext(),
      object(null, 'rio_plant'),
      ['Name', 'Status'],
      [ROW_ID],
    );
    expect(rows.map((row) => row.values)).toEqual([
      { Name: 'Basil', Status: 'Active' },
      { Name: 'Thyme', Status: 'Inactive' },
      { Name: 'Sage', Status: null },
    ]);
    expect(rows[2]!.key).toBe('["aaaaaaaa-0000-4000-8000-000000000003"]');
    privileged = false;
    const denied = await refusal(
      everyRow(dataverseConnector(), tablesContext(), object(null, 'rio_plant'), ['Name'], [ROW_ID]),
    );
    expect(denied.messageKey).toBe('sources.dataverse.denied');
    const missing = await refusal(dataverseConnector().preview(tablesContext(), object(null, 'rio_weed'), 5));
    expect(missing.messageKey).toBe('sources.sync.objectMissing');
    const unsafe = await refusal(
      dataverseConnector().preview(tablesContext(), object(null, "x')/Attributes"), 5),
    );
    expect(unsafe.messageKey).toBe('sources.sync.objectMissing');
  });
});

it.each(['sharepoint-list', 'excel-online', 'dataverse'] as const)(
  'runs every declared %s contract against its service fixture',
  async (kind) => {
    const boundary = new FixtureBoundary();
    const options = boundary.wrap(shared());
    const api =
      kind === 'sharepoint-list'
        ? sharePoint(options)
        : kind === 'excel-online'
          ? excel(options)
          : dataverseConnector(options);
    const ctx =
      kind === 'sharepoint-list'
        ? listsContext()
        : kind === 'excel-online'
          ? workbooksContext()
          : tablesContext();
    const selected =
      kind === 'sharepoint-list'
        ? object(SITE_ID, 'list-plants')
        : kind === 'excel-online'
          ? object('item-beds', 'Beds')
          : object(null, 'rio_plant');
    const key = kind === 'sharepoint-list' ? ITEM_ID : kind === 'excel-online' ? 'Bed' : ROW_ID;
    await strictFixture(api, ctx, selected, [key], 3, boundary);
  },
);

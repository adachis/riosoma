import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConnection, RestEndpoint, type SourceSelect } from '@riosoma/contracts';
import {
  APP_PRESETS,
  ConnectorError,
  createAppConnector,
  type AppPreset,
  type ConnectorContext,
  type SourceRow,
} from '@riosoma/connectors';
import { restConnectorOptions } from './rest.js';

const key = randomBytes(24).toString('hex');
const preset = APP_PRESETS.find((app) => app.catalog.id === 'jotform')!;
let listener: Server;
let origin: string;
let empty = false;
let code = 200;
let httpStatus = 200;
let broken = false;
let retry = false;
let failOffset: number | undefined;
let submissionsStart = 0;
let questionCode = 200;
let questionContent: unknown;
const requests: Array<{ path: string; method: string; query: URLSearchParams; signed: boolean }> = [];

function submission(index: number) {
  return {
    id: String(index + 1),
    created_at: '2026-10-01 12:00:00',
    updated_at: '2026-10-02 12:00:00',
    status: 'ACTIVE',
    ip: '192.0.2.1',
    form_id: '1',
    answers: {
      ...(index === 2
        ? {}
        : {
            '1': {
              name: 'person',
              text: 'Name',
              type: 'control_fullname',
              answer: { first: 'Taylor', last: 'Example' },
            },
          }),
      '2': {
        name: 'other',
        text: index === 2 && submissionsStart === 0 ? 'Changed label' : 'Name',
        type: 'control_textbox',
        answer: 'Second',
      },
      '3': { name: 'third', text: 'Name (2)', type: 'control_textbox', answer: 'Third' },
      '4': { name: 'contact', text: ' ', type: 'control_email', answer: 'person@example.test' },
      '5': { name: 'identifier', text: 'id', type: 'control_textbox', answer: 'answer identifier' },
      '6': { name: 'tags', text: 'Tags', type: 'control_checkbox', answer: ['Red', 'Blue'] },
      '7': {
        name: 'address',
        text: 'Address',
        type: 'control_address',
        answer: { street: '10 Example St', city: 'Sample City', state: 'CA', zip: '90000' },
      },
      '8': { name: 'prototype', text: '__proto__', type: 'control_textbox', answer: 'safe label' },
      '9': { name: 'optional', text: 'Optional', type: 'control_textbox' },
    },
  };
}

function questions() {
  return Object.fromEntries(
    Object.entries(submission(0).answers).map(([qid, question]) => [
      qid,
      { qid, name: question.name, text: question.text, type: question.type },
    ]),
  );
}

beforeAll(async () => {
  listener = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const signed = req.headers.apikey === key;
    requests.push({ path: url.pathname, method: req.method ?? '', query: url.searchParams, signed });
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const responseCode = signed
      ? url.pathname.endsWith('/questions')
        ? questionCode
        : failOffset === offset
          ? 500
          : code
      : 401;
    const content =
      empty || responseCode !== 200
        ? []
        : url.pathname.endsWith('/questions')
          ? (questionContent ?? questions())
          : Array.from(
              {
                length: Math.max(
                  0,
                  Math.min(limit, 5 - offset - (url.pathname === '/user/forms' ? 0 : submissionsStart)),
                ),
              },
              (_, i) =>
                url.pathname === '/user/forms'
                  ? { id: String(offset + i + 1), title: offset + i === 0 ? 'Example form' : 'Another form' }
                  : submission(offset + i + submissionsStart),
            );
    res.writeHead(retry ? 429 : httpStatus, {
      'content-type': 'application/json',
      ...(retry ? { 'retry-after': '0' } : {}),
    });
    if (retry) {
      retry = false;
      res.end(JSON.stringify({ message: 'Try later' }));
      return;
    }
    res.end(
      JSON.stringify({
        responseCode,
        message: responseCode === 200 ? 'success' : `Request refused ${req.headers.apikey ?? ''}`,
        content: broken ? {} : content,
        duration: '0.01ms',
        resultSet: { offset, limit, count: Object.keys(content as object).length },
      }),
    );
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(listener.address() as AddressInfo).port}`;
});

beforeEach(() => {
  requests.length = 0;
  empty = false;
  code = 200;
  httpStatus = 200;
  broken = false;
  retry = false;
  failOffset = undefined;
  submissionsStart = 0;
  questionCode = 200;
  questionContent = undefined;
});

afterAll(async () => {
  listener.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
});

function connector(requestLimit = preset.target.requestLimit) {
  const smallPage = (endpoint: RestEndpoint) =>
    RestEndpoint.parse({ ...endpoint, paging: { style: 'offset', limit: 2 } });
  const local: AppPreset = {
    ...preset,
    // Test-owned settings keep the real transport and projection, with small, fast fixture pages.
    target: { ...preset.target, address: origin, requestsPerSecond: 100, requestLimit },
    objects: preset.objects.map((object) =>
      'endpoint' in object ? { ...object, endpoint: smallPage(object.endpoint) } : object,
    ),
    discovery: {
      ...preset.discovery!,
      endpoint: smallPage(preset.discovery!.endpoint),
      object: { ...preset.discovery!.object, endpoint: smallPage(preset.discovery!.object.endpoint) },
    },
  };
  return createAppConnector(
    restConnectorOptions({ production: false, automationsAllowPrivateHosts: true }, async () => [
      { address: '127.0.0.1', family: 4 },
    ]),
    [local],
  );
}

function context(): ConnectorContext {
  return {
    connection: AppConnection.parse({ kind: 'app', app: 'jotform' }),
    secrets: { apiKey: key },
    timeoutMs: 10_000,
  };
}

const select = (name: string): SourceSelect => ({ kind: 'object', object: { schema: null, name } });

async function read(name: string, columns = ['id'], source = connector(), ctx = context()) {
  const rows: SourceRow[] = [];
  for await (const batch of source.read(ctx, select(name), {
    columns,
    types: Object.fromEntries(columns.map((column) => [column, 'text'])),
    keyColumns: ['id'],
    batchSize: 2,
  }))
    rows.push(...batch);
  return rows;
}

describe('Jotform on the server’s guarded network', () => {
  it('authenticates with one GET, inspects every form across three discovery pages, and retains form titles', async () => {
    expect((await connector().test(context())).ok).toBe(true);
    expect(requests[0]!.query.get('limit')).toBe('1');
    expect(requests.filter((request) => request.query.get('limit') === '1')).toHaveLength(1);
    const inspected = [
      '/user/forms',
      '/user/forms',
      '/user/forms',
      '/user/forms',
      ...Array.from({ length: 5 }, (_, index) => [
        `/form/${index + 1}/submissions`,
        `/form/${index + 1}/questions`,
      ]).flat(),
    ];
    expect(requests.map((request) => request.path)).toEqual(['/user/forms', ...inspected]);
    requests.length = 0;
    const objects = await connector().listObjects(context());
    expect(objects.map((object) => object.name)).toEqual(['forms', '1', '2', '3', '4', '5']);
    expect(objects.slice(1).map((object) => object.label)).toEqual([
      'Example form',
      'Another form',
      'Another form',
      'Another form',
      'Another form',
    ]);
    expect(requests.map((request) => request.path)).toEqual(inspected);
    expect(requests.slice(0, 3).map((request) => request.query.get('offset'))).toEqual(['0', '2', '4']);
    expect(requests.slice(3).map((request) => request.query.get('offset'))).toEqual([
      '0',
      ...Array.from({ length: 5 }, () => ['0', null]).flat(),
    ]);
    for (const object of objects) {
      requests.length = 0;
      const rows = await read(object.name);
      expect(rows).toHaveLength(5);
      expect(new Set(rows.map((row) => row.key)).size).toBe(5);
      const path = object.name === 'forms' ? '/user/forms' : `/form/${object.name}/submissions`;
      expect(
        requests.filter((request) => request.path === path).map((request) => request.query.get('offset')),
      ).toEqual(['0', '2', '4']);
      expect(requests.filter((request) => request.path.endsWith('/questions'))).toHaveLength(
        object.name === 'forms' ? 0 : 1,
      );
      expect((await connector().preview(context(), select(object.name), 3)).rows).toHaveLength(3);
      expect(await connector().keyCandidates(context(), { schema: null, name: object.name })).toEqual([
        ['id'],
      ]);
    }
    expect(requests.every((request) => request.method === 'GET' && request.signed)).toBe(true);
    expect(
      requests.every(
        (request) =>
          !request.query.has('apiKey') &&
          !request.query.has('APIKEY') &&
          !request.query.toString().includes(key),
      ),
    ).toBe(true);
  });

  it('projects answers into unique label columns, retaining metadata and consistent columns across pages', async () => {
    const expected = [
      'id',
      'created_at',
      'updated_at',
      'status',
      'ip',
      'Name',
      'Name (2)',
      'Name (2) (2)',
      'contact',
      'id (2)',
      'Tags',
      'Address',
      '__proto__',
      'Optional',
    ];
    const preview = await connector().preview(context(), select('1'), 5);
    expect(preview.columns.map((column) => column.name)).toEqual(expected);
    expect((await connector().describe(context(), select('1'))).map((column) => column.name)).toEqual(
      expected,
    );
    const rows = await read('1', expected);
    expect(rows[0]!.values).toEqual({
      id: '1',
      created_at: '2026-10-01 12:00:00',
      updated_at: '2026-10-02 12:00:00',
      status: 'ACTIVE',
      ip: '192.0.2.1',
      Name: 'Taylor Example',
      'Name (2)': 'Second',
      'Name (2) (2)': 'Third',
      contact: 'person@example.test',
      'id (2)': 'answer identifier',
      Tags: 'Red, Blue',
      Address: '10 Example St Sample City CA 90000',
      ['__proto__']: 'safe label',
      Optional: null,
    });
    expect(rows[2]!.values.Name).toBeNull();
    expect(rows[2]!.values['Name (2)']).toBe('Second');
    expect(rows[2]!.values['Name (2) (2)']).toBe('Third');
    for (const name of ['Name', 'Name (2)', 'Name (2) (2)', 'contact', 'Tags', 'Address', '__proto__'])
      expect(preview.rows[0]![expected.indexOf(name)]).toBe(rows[0]!.values[name]);
  });

  it('keeps saved duplicate-label columns after earlier submissions are removed', async () => {
    const source = connector();
    const preview = await source.preview(context(), select('1'), 5);
    const columns = preview.columns.map((column) => column.name);
    expect(preview.rows[0]![columns.indexOf('Name')]).toBe('Taylor Example');
    expect(preview.rows[0]![columns.indexOf('Name (2)')]).toBe('Second');

    submissionsStart = 2;
    for (const current of [source, connector()]) {
      const rows = await read('1', columns, current);
      expect(rows).toHaveLength(3);
      expect(rows[0]!.values.Name).toBeNull();
      expect(rows[0]!.values['Name (2)']).toBe('Second');
      expect(rows[0]!.values['Name (2) (2)']).toBe('Third');
      const remaining = await current.preview(context(), select('1'), 3);
      expect(remaining.columns.map((column) => column.name)).toEqual(columns);
      expect(remaining.rows[0]![columns.indexOf('Name')]).toBeNull();
      expect(remaining.rows[0]![columns.indexOf('Name (2)')]).toBe('Second');
    }
    expect(requests.filter((request) => request.path === '/form/1/questions')).toHaveLength(5);
  });

  it('refuses failed or malformed question definitions before returning submission rows', async () => {
    for (const [code, messageKey] of [
      [401, 'sources.app.jotform.deniedKey'],
      [500, 'sources.app.status'],
    ] as const) {
      questionCode = code;
      const error: unknown = await read('1').catch((error: unknown) => error);
      expect(error).toMatchObject({ messageKey });
      expect(JSON.stringify(error).includes(key)).toBe(false);
      await expect(connector().preview(context(), select('1'), 3)).rejects.toMatchObject({ messageKey });
    }
    questionCode = 200;
    for (const content of [[], { '1': 'invalid' }]) {
      questionContent = content;
      await expect(read('1')).rejects.toMatchObject({ messageKey: 'sources.app.records' });
    }
  });

  it('accepts an empty account without inventing submission objects or rows', async () => {
    empty = true;
    expect((await connector().test(context())).ok).toBe(true);
    expect((await connector().listObjects(context())).map((object) => object.name)).toEqual(['forms']);
    expect((await connector().preview(context(), select('forms'), 5)).rows).toEqual([]);
    expect(await read('forms')).toEqual([]);
    await expect(read('1')).rejects.toMatchObject({ messageKey: 'sources.app.objectMissing' });
    expect(await connector().keyCandidates(context(), { schema: null, name: 'forms' })).toEqual([['id']]);
  });

  it('distinguishes key and object refusals for HTTP and envelope errors without exposing the response', async () => {
    for (const status of [401, 403]) {
      for (const envelope of [true, false]) {
        code = status;
        httpStatus = envelope ? 200 : status;
        const tested = await connector().test(context());
        expect(tested.ok).toBe(false);
        expect(tested.steps.at(-1)?.messageKey).toBe('sources.app.jotform.deniedKey');
        expect(JSON.stringify(tested).includes(key)).toBe(false);
        const error: unknown = await read('forms').catch((error: unknown) => error);
        expect(error).toBeInstanceOf(ConnectorError);
        expect(error).toMatchObject(
          status === 401
            ? { messageKey: 'sources.app.jotform.deniedKey', params: { status } }
            : {
                messageKey: 'sources.app.objectNotAllowed',
                params: { object: 'forms', permission: '', hasPermission: false },
              },
        );
        expect(JSON.stringify(error).includes(key)).toBe(false);
        expect(JSON.stringify({ tested, error })).not.toContain('Request refused');
      }
    }
  });

  it('reports envelope status on discovery and later pages without exposing the response', async () => {
    code = 500;
    await expect(connector().listObjects(context())).rejects.toMatchObject({
      messageKey: 'sources.app.status',
      params: { status: 500 },
    });
    expect((await connector().test(context())).steps.at(-1)?.messageKey).toBe('sources.app.status');
    code = 200;
    failOffset = 2;
    const error = await read('forms').catch((error: unknown) => error);
    expect(error).toMatchObject({
      messageKey: 'sources.app.status',
      params: { status: 500 },
    });
    expect(JSON.stringify(error).includes(key)).toBe(false);
    expect(JSON.stringify(error)).not.toContain('Request refused');
    expect(error).not.toHaveProperty('detail', expect.any(String));
    failOffset = undefined;
    broken = true;
    await expect(read('forms')).rejects.toMatchObject({ messageKey: 'sources.app.records' });
    await expect(connector().listObjects(context())).rejects.toMatchObject({
      messageKey: 'sources.app.records',
    });
  });

  it('refuses every connection override, undeclared setting, invalid region, and missing key before making requests', async () => {
    const base = context();
    const cases: Array<[ConnectorContext, string]> = [
      [{ ...base, secrets: {} }, 'sources.app.secretMissing'],
      [{ ...base, connection: { kind: 'app', app: 'missing', settings: {} } }, 'sources.app.unknown'],
      [
        {
          ...base,
          connection: {
            ...base.connection,
            baseUrl: 'https://elsewhere.test',
          } as ConnectorContext['connection'],
        },
        'sources.app.address',
      ],
      ...['apiKey', 'baseUrl', 'headers', 'limit'].map((setting): [ConnectorContext, string] => [
        { ...base, connection: { kind: 'app', app: 'jotform', settings: { [setting]: 'value' } } },
        'sources.app.undeclaredSetting',
      ]),
      ...['other', 'https://api.jotform.com', 'EU', 1, null, {}, ['eu']].map(
        (region): [ConnectorContext, string] => [
          { ...base, connection: { kind: 'app', app: 'jotform', settings: { region } } },
          'sources.app.settingInvalid',
        ],
      ),
    ];
    for (const [ctx, messageKey] of cases) {
      await expect(connector().listObjects(ctx)).rejects.toMatchObject({ messageKey });
      expect((await connector().test(ctx)).steps.at(-1)?.messageKey).toBe(messageKey);
    }
    expect(requests).toEqual([]);
  });

  it('shares the rolling request budget across connector instances and counts retry attempts', async () => {
    const limit = { count: 2, windowMs: 24 * 60 * 60_000 };
    const ctx = { ...context(), secrets: { apiKey: randomBytes(24).toString('hex') } };
    // Refused requests still consume calls, and separate connector instances share that account's budget.
    retry = true;
    expect((await connector(limit).test(ctx)).steps.at(-1)?.messageKey).toBe('sources.app.jotform.deniedKey');
    expect(requests).toHaveLength(2);
    expect((await connector(limit).test(ctx)).steps.at(-1)?.messageKey).toBe('sources.app.rateLimited');
    expect(requests).toHaveLength(2);
    empty = true;
    expect((await connector(limit).preview(context(), select('forms'), 1)).rows).toEqual([]);
    expect(requests).toHaveLength(3);
    await expect(connector(limit).listObjects(context())).rejects.toMatchObject({
      messageKey: 'sources.app.rateLimited',
    });
    expect(requests).toHaveLength(4);
  });
});

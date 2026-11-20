import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppConnection } from '@riosoma/contracts';
import type { FileNetwork } from '../files/network.js';
import { createRestConnector } from '../rest/connector.js';
import type { ConnectorContext } from '../types.js';
import { createAppConnector } from './connector.js';
import { jotform } from './jotform.js';
import { recordProjection } from './records.js';

const select = { kind: 'object', object: { schema: null, name: 'forms' } } as const;

describe('Jotform preset', () => {
  it('uses fixed regional hosts, header authentication, and the full allowed page size', async () => {
    const key = randomBytes(24).toString('hex');
    const requests: Array<{ url: URL; signed: boolean; method: string }> = [];
    const network: FileNetwork = {
      allowsAddress: () => true,
      check: async () => ({ address: '127.0.0.1', family: 4 }),
      async request(request) {
        requests.push({ url: request.url, signed: request.headers.APIKEY === key, method: request.method });
        return {
          status: 200,
          headers: {},
          url: request.url,
          body: (async function* () {
            yield Buffer.from(JSON.stringify({ responseCode: 200, message: 'success', content: [] }));
          })(),
          close() {},
        };
      },
    };
    const connector = createAppConnector({ network }, [jotform]);
    for (const settings of [{}, { region: 'default' }, { region: 'eu' }, { region: 'hipaa' }]) {
      const ctx: ConnectorContext = {
        connection: AppConnection.parse({ kind: 'app', app: 'jotform', settings }),
        secrets: { apiKey: key },
      };
      expect((await connector.preview(ctx, select, 3)).rows).toEqual([]);
    }
    expect(requests.map((request) => request.url.origin)).toEqual([
      'https://api.jotform.com',
      'https://api.jotform.com',
      'https://eu-api.jotform.com',
      'https://hipaa-api.jotform.com',
    ]);
    expect(requests.every((request) => request.method === 'GET' && request.signed)).toBe(true);
    expect(
      requests.every(
        (request) =>
          request.url.pathname === '/user/forms' &&
          request.url.searchParams.get('offset') === '0' &&
          request.url.searchParams.get('limit') === '1000',
      ),
    ).toBe(true);
    expect(requests.every((request) => !request.url.href.includes(key))).toBe(true);
    expect(jotform.target.requestsPerSecond).toBe(0.5);
    expect(jotform.target.requestLimit).toEqual({ count: 500, windowMs: 86_400_000 });
  });

  it('expires a shared rolling budget and keeps separate credentials independent', async () => {
    let now = 0;
    let calls = 0;
    const network: FileNetwork = {
      allowsAddress: () => true,
      check: async () => ({ address: '127.0.0.1', family: 4 }),
      async request(request) {
        calls++;
        return {
          status: 200,
          headers: {},
          url: request.url,
          body: (async function* () {
            yield Buffer.from('[]');
          })(),
          close() {},
        };
      },
    };
    const ctx: ConnectorContext = {
      connection: {
        kind: 'rest',
        baseUrl: `https://${randomBytes(12).toString('hex')}.example.test`,
        auth: { method: 'header', name: 'APIKEY' },
        endpoints: [{ ...jotform.discovery!.endpoint, records: '', paging: { style: 'none' } }],
        requestsPerSecond: 100,
      },
      secrets: { apiKey: randomBytes(24).toString('hex') },
    };
    const source = () =>
      createRestConnector({ network, now: () => now, requestLimit: { count: 2, windowMs: 1_000 } });
    await source().preview(ctx, select, 1);
    now = 100;
    await source().preview(ctx, select, 1);
    now = 999;
    await expect(source().preview(ctx, select, 1)).rejects.toMatchObject({
      messageKey: 'sources.rest.rateLimited',
    });
    expect(calls).toBe(2);
    await source().preview({ ...ctx, secrets: { apiKey: randomBytes(24).toString('hex') } }, select, 1);
    expect(calls).toBe(3);
    now = 1_000;
    await source().preview(ctx, select, 1);
    expect(calls).toBe(4);
    await expect(source().preview(ctx, select, 1)).rejects.toMatchObject({
      messageKey: 'sources.rest.rateLimited',
    });
    expect(calls).toBe(4);
  });

  it('keeps long labels unique, preserves dotted labels, and joins nested answer parts', () => {
    const definition = jotform.discovery!.object;
    const long = 'x'.repeat(300);
    const document = {
      content: [
        {
          id: 'one',
          answers: {
            '1': { text: long, answer: 'first' },
            '2': { text: long, answer: 'second' },
            '3': {
              text: 'Street.name',
              answer: {
                address: { street: '10 Example St', city: 'Sample City' },
                tags: ['Red', 'Blue'],
                absent: null,
              },
            },
            '4': { name: 'fallback', answer: false },
            '5': { text: 'Count', answer: 0 },
            '6': { text: 'List', answer: [{ first: 'Taylor', last: 'Example' }, 'Other'] },
          },
        },
      ],
    };
    const project = recordProjection(definition.projection!, definition.endpoint, {
      content: document.content[0]!.answers,
    });
    const rows = (project(document) as { content: Record<string, unknown>[] }).content;
    expect(rows[0]![long.slice(0, 255)]).toBe('first');
    expect(rows[0]![`${long.slice(0, 251)} (2)`]).toBe('second');
    expect(rows[0]!['Street.name']).toBe('10 Example St Sample City Red, Blue');
    expect(rows[0]!.fallback).toBe(false);
    expect(rows[0]!.Count).toBe(0);
    expect(rows[0]!.List).toEqual(['Taylor Example', 'Other']);
    expect(new Set(Object.keys(rows[0]!)).size).toBe(11);
    expect(Object.keys(rows[0]!).every((name) => name.length <= 255)).toBe(true);
    for (const answers of [[], 'invalid', { '1': 'invalid' }])
      expect(() => project({ content: [{ id: 'one', answers }] })).toThrow('sources.app.records');
  });

  it('reserves every question column from definitions regardless of answer order or missing answers', () => {
    const definition = jotform.discovery!.object;
    const definitions = {
      content: {
        second: { text: 'Name', name: 'second' },
        first: { text: 'Name', name: 'first' },
        third: { text: 'Name (2)', name: 'third' },
      },
    };
    for (const content of [
      definitions.content,
      Object.fromEntries(Object.entries(definitions.content).reverse()),
    ]) {
      const project = recordProjection(definition.projection!, definition.endpoint, { content });
      const page = project({
        content: [
          { id: 'one', answers: { second: { text: 'Changed label', answer: 'Second' } } },
          { id: 'two' },
          { id: 'three', answers: { first: { text: 'Name', answer: 'First' } } },
        ],
      }) as { content: Record<string, unknown>[] };
      expect(page.content[0]).toMatchObject({ Name: null, 'Name (2)': 'Second', 'Name (2) (2)': null });
      expect(page.content[1]).toMatchObject({ Name: null, 'Name (2)': null, 'Name (2) (2)': null });
      expect(page.content[2]).toMatchObject({ Name: 'First', 'Name (2)': null, 'Name (2) (2)': null });
      expect(() =>
        project({ content: [{ id: 'four', answers: { unknown: { text: 'Name', answer: 'Unknown' } } }] }),
      ).toThrow('sources.app.records');
    }
  });
});

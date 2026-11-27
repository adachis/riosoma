import { SourceConnection } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { makeConnector, type Session } from '../common.js';
import { ConnectorError, type Connector } from '../types.js';
import { runConnectorContract, type ConnectorContract } from './kit.js';
import { relationalFixture as relational } from './relational.js';
import { assertBatch, assertSecretFree, ContractViolation } from './assertions.js';
import { requiredCapabilities } from './capabilities.js';
import { createGraphQlConnector } from '../api/graphql.js';
import { FileNetworkError } from '../files/network.js';
import { observeConnector } from './observe.js';

describe('shared connector contract', () => {
  it.each(['postgres', 'mysql', 'sqlserver', 'oracle', 'firebird'] as const)(
    'certifies the %s relational fixture',
    async (kind) => {
      const result = await runConnectorContract(relational(kind));
      expect(result.capabilitiesPassed).toEqual(requiredCapabilities(kind).sort());
    },
  );

  it('requires evidence for every declared pushdown capability', async () => {
    const spec = relational('postgres');
    delete spec.sort;
    await expect(runConnectorContract(spec)).rejects.toMatchObject({ check: 'sort.probe' });
  });

  it('rejects a delayed authentication failure as timeout evidence', async () => {
    const spec = relational('postgres');
    spec.timeout = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      throw new ConnectorError('sources.test.authenticate');
    };
    await expect(runConnectorContract(spec)).rejects.toMatchObject({ check: 'timeout.classification' });
  });

  it('rejects a timeout that exceeds the supplied budget and scheduling tolerance', async () => {
    const spec = relational('postgres');
    spec.timeout = async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      throw new ConnectorError('sources.test.timeout');
    };
    await expect(runConnectorContract(spec)).rejects.toMatchObject({ check: 'timeout.duration' });
  });

  it('rejects forbidden queries that execute before returning an error', async () => {
    const spec = relational('postgres') as ConnectorContract & { executions(): readonly string[] };
    const executions: string[] = [];
    spec.executions = () => executions;
    const original = spec.connector.describe;
    spec.connector.describe = async (ctx, select) => {
      if (select.kind === 'query') {
        executions.push(select.sql);
        throw new ConnectorError('sources.sync.read');
      }
      return original(ctx, select);
    };
    await expect(runConnectorContract(spec)).rejects.toMatchObject({ check: 'query.executed' });
  });

  it('requires driver evidence for query refusal', async () => {
    const spec = relational('postgres');
    delete spec.executions;
    await expect(runConnectorContract(spec)).rejects.toMatchObject({ check: 'query.evidence' });
  });

  it('credits paging only after a completed read with multiple batches', async () => {
    const spec = relational('postgres');
    const observations = new Map();
    const observed = observeConnector(
      {
        ...spec.connector,
        async *read() {
          yield spec.expectedRows.slice(0, 1);
        },
      },
      observations,
    );
    for await (const batch of (observed as Connector).read(spec.context, spec.select, spec.read)) void batch;
    expect(observations.get('postgres')).not.toContain('paging');
  });

  it('tests GraphQL query guards through connection settings and honors its request deadline', async () => {
    let slow = false;
    let stopped = false;
    const executions: string[] = [];
    const data = [1, 2, 3].map((id) => ({ id, title: 'row' }));
    const connector = createGraphQlConnector({
      sockets: { connect: async () => {}, handshake: async () => {} },
      network: {
        allowsAddress: () => true,
        check: async () => ({ address: '192.0.2.1', family: 4 }),
        request: async ({ url, signal, body }) => {
          if (String(body).includes('query First')) executions.push(String(body));
          if (slow)
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  stopped = true;
                  reject(new FileNetworkError('failed'));
                },
                { once: true },
              );
            });
          return {
            url,
            status: 200,
            headers: {},
            close() {},
            body: (async function* () {
              yield Buffer.from(JSON.stringify({ data: { items: data } }));
            })(),
          };
        },
      },
    });
    const context = {
      connection: SourceConnection.parse({
        kind: 'graphql',
        baseUrl: 'https://192.0.2.1/service',
        query: 'query { items { id title } }',
        records: 'data.items',
        requestsPerSecond: 100,
      }),
      secrets: {},
      timeoutMs: 1000,
    };
    const selected = { kind: 'object' as const, object: { schema: null, name: 'query' } };
    const result = await runConnectorContract({
      connector,
      context,
      select: selected,
      types: { id: { type: 'number', options: { precision: 0 } }, title: { type: 'text', options: {} } },
      keys: [['id']],
      read: {
        columns: ['id', 'title'],
        types: { id: 'number', title: 'text' },
        keyColumns: ['id'],
        batchSize: 1,
      },
      expectedRows: data.map((values) => ({ key: JSON.stringify([values.id]), values })),
      failure: (ctx) => connector.describe(ctx, { kind: 'query', sql: 'mutation { remove }' }),
      timeout: (ctx) => {
        slow = true;
        return connector.describe(ctx, selected);
      },
      stopped: () => stopped,
      executions: () => executions,
    });
    expect(result.capabilitiesPassed).toEqual(requiredCapabilities('graphql').sort());
  });

  it('sends the timeout probe’s request even when earlier requests still wait for their turn', async () => {
    // At 100 requests a second, each request's turn is 10 ms after the last, which is the probe's
    // whole budget.  Three requests queued just before the probe put its own turn 20 ms or more
    // past its deadline, so unless the kit waits for those turns the probe times out unsent.
    let slow = false;
    let stopped = false;
    let probes = 0;
    const executions: string[] = [];
    const queued: Promise<unknown>[] = [];
    const data = [1, 2, 3].map((id) => ({ id, title: 'row' }));
    const connector = createGraphQlConnector({
      sockets: { connect: async () => {}, handshake: async () => {} },
      network: {
        allowsAddress: () => true,
        check: async () => ({ address: '192.0.2.1', family: 4 }),
        request: async ({ url, signal, body }) => {
          if (String(body).includes('query First')) executions.push(String(body));
          if (slow && !String(body).includes('query Queued')) {
            probes++;
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  stopped = true;
                  reject(new FileNetworkError('failed'));
                },
                { once: true },
              );
            });
          }
          return {
            url,
            status: 200,
            headers: {},
            close() {},
            body: (async function* () {
              yield Buffer.from(JSON.stringify({ data: { items: data } }));
            })(),
          };
        },
      },
    });
    const graphql = (query: string) => ({
      connection: SourceConnection.parse({
        kind: 'graphql',
        baseUrl: 'https://192.0.2.1/service',
        query,
        records: 'data.items',
        requestsPerSecond: 100,
      }),
      secrets: {},
      timeoutMs: 1000,
    });
    const context = graphql('query { items { id title } }');
    // The same API and pace, told apart by the query they send.
    const waiting = graphql('query Queued { items { id title } }');
    const selected = { kind: 'object' as const, object: { schema: null, name: 'query' } };
    const result = await runConnectorContract({
      connector,
      context,
      select: selected,
      types: { id: { type: 'number', options: { precision: 0 } }, title: { type: 'text', options: {} } },
      keys: [['id']],
      read: {
        columns: ['id', 'title'],
        types: { id: 'number', title: 'text' },
        keyColumns: ['id'],
        batchSize: 1,
      },
      expectedRows: data.map((values) => ({ key: JSON.stringify([values.id]), values })),
      failure: (ctx) => {
        // The step just before the timeout probe leaves three requests waiting for their turns.
        for (let index = 0; index < 3; index++) queued.push(connector.describe(waiting, selected));
        return connector.describe(ctx, { kind: 'query', sql: 'mutation { remove }' });
      },
      timeout: (ctx) => {
        slow = true;
        return connector.describe(ctx, selected);
      },
      stopped: () => stopped,
      executions: () => executions,
    });
    await Promise.all(queued);
    expect(probes).toBe(1);
    expect(result.capabilitiesPassed).toEqual(requiredCapabilities('graphql').sort());
  });

  it('rejects a correct local filter when the request omitted its predicate', async () => {
    const spec = relational('postgres');
    spec.filter!.run = async () => ({
      rows: [{ id: 2, title: 'item-2' }],
      requests: ['SELECT * FROM items'],
    });
    await expect(runConnectorContract(spec)).rejects.toMatchObject({ check: 'filter.pushdown' });
  });

  it('detects missing rows and incorrect native type mappings', async () => {
    const missing = relational('postgres');
    missing.expectedRows[2] = { key: '[4]', values: { id: 4, title: 'item-4' } };
    await expect(runConnectorContract(missing)).rejects.toMatchObject({ check: 'read.expectedRows' });
    const wrongType = relational('postgres');
    wrongType.types.id = { type: 'text', options: {} };
    await expect(runConnectorContract(wrongType)).rejects.toMatchObject({ check: 'describe.nativeMapping' });
  });

  it('detects a secret in nested error causes, parameters, and encoded logs', () => {
    const { context } = relational('postgres');
    const secret = context.secrets.password!;
    expect(() => assertSecretFree(new Error('failure', { cause: new Error(secret) }), context)).toThrow(
      ContractViolation,
    );
    expect(() =>
      assertSecretFree(new ConnectorError('sources.sync.read', 'failure', { token: secret }), context),
    ).toThrow(ContractViolation);
    expect(() => assertSecretFree(Buffer.from(secret).toString('base64'), context)).toThrow(
      ContractViolation,
    );
  });

  it('detects repeats across pages, oversized batches, and invalid keys', () => {
    const { read, expectedRows } = relational('postgres');
    const seen = new Set<string>();
    assertBatch(expectedRows.slice(0, 2), read, seen);
    expect(() => assertBatch(expectedRows.slice(0, 1), read, seen)).toThrow(ContractViolation);
    expect(() => assertBatch(expectedRows, read, new Set())).toThrow(ContractViolation);
    expect(() => assertBatch([{ key: '1', values: { id: 1, title: 'one' } }], read, new Set())).toThrow(
      ContractViolation,
    );
  });

  it('rejects a connector that ignores its timeout and does not finish', async () => {
    const spec = relational('postgres');
    spec.timeout = async () => new Promise(() => undefined);
    await expect(runConnectorContract(spec)).rejects.toMatchObject({ check: 'timeout.watchdog' });
  });
});

describe('pooled SQL contract regressions', () => {
  async function pooled(select: Session['select'], close = async () => {}, signal?: AbortSignal) {
    const spec = relational('postgres');
    const connector = makeConnector('postgres', async () => ({
      close,
      select,
      version: async () => 'fixture-1',
      list: async () => [],
      keys: async () => [],
      describe: async () => [],
      async *rows() {
        yield [];
      },
    }));
    return {
      context: spec.context,
      session: await connector.session!({ ...spec.context, statementTimeoutMs: 10, signal }),
    };
  }

  it('refuses two statements before sending either to a pooled driver', async () => {
    let sent = 0;
    const { session } = await pooled(async () => {
      sent++;
      return [];
    });
    try {
      await expect(session.select('SELECT 1; SELECT 2', [])).rejects.toMatchObject({
        messageKey: 'sources.sync.read',
      });
      expect(sent).toBe(0);
    } finally {
      await session.close();
    }
  });

  it('reads generated SQL with backslashes and delimiters inside quoted identifiers', async () => {
    const sent: string[] = [];
    const { session } = await pooled(async (text) => {
      sent.push(text);
      return [{ id: 1 }];
    });
    const text = 'SELECT "id\\;name" FROM "table\\"";name"';
    try {
      await expect(session.select(text, [])).resolves.toEqual([{ id: 1 }]);
      expect(sent).toEqual([text]);
      await expect(session.select(`${text}; SELECT 2`, [])).rejects.toMatchObject({
        messageKey: 'sources.sync.read',
      });
      expect(sent).toEqual([text]);
    } finally {
      await session.close();
    }
  });

  it('preserves the live timeout classification while sanitizing driver errors', async () => {
    const { context } = relational('postgres');
    const { session } = await pooled(async () => {
      throw Object.assign(new Error(`query timeout: ${context.secrets.password}`), { code: '57014' });
    });
    try {
      const error = await session.select('SELECT 1', []).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ messageKey: 'sources.live.timeout' });
      assertSecretFree(error, context);
    } finally {
      await session.close();
    }
  });

  it('closes a pooled driver that never returns within its statement budget', async () => {
    let closed = false;
    const { session } = await pooled(
      async () => new Promise(() => undefined),
      async () => {
        closed = true;
      },
    );
    try {
      await expect(session.select('SELECT 1', [])).rejects.toMatchObject({
        messageKey: 'sources.live.timeout',
      });
      expect(closed).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('reuses a healthy pooled session after its opening request ends', async () => {
    const controller = new AbortController();
    const { session } = await pooled(
      async () => [{ id: 1 }],
      async () => {},
      controller.signal,
    );
    controller.abort();
    try {
      expect(await session.select('SELECT 1', [])).toEqual([{ id: 1 }]);
    } finally {
      await session.close();
    }
  });
});

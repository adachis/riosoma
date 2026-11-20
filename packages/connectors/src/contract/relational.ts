import { SourceConnection } from '@riosoma/contracts';
import { makeConnector, type Session } from '../common.js';
import { fromSql, querySql } from '../sql.js';
import type { Connector, ConnectorContext } from '../types.js';
import { column, type SqlDialect } from '../values.js';
import type { ConnectorContract } from './kit.js';

/**
 * A relational source answered by a stand-in session, for the shared contract.  Native-driver
 * fixtures already test each protocol, so this one exercises what the SQL connectors share: the
 * adapter each dialect builds, its live sessions, and its failures.  The connector service's
 * contract test runs it through the service too.
 */
export function relationalFixture(
  kind: SqlDialect,
  options: {
    serverSecrets?: boolean;
    /** Runs the connector elsewhere, as the connector service does, and gives back how to reach it */
    through?: (connector: Connector) => Connector;
  } = {},
): ConnectorContract {
  const rows = [1, 2, 3].map((id) => ({ id, title: `item-${id}` }));
  const columns = [
    column({ name: 'id', type: 'integer', nullable: false }, kind),
    column({ name: 'title', type: 'varchar(80)', nullable: true }, kind),
  ];
  const context: ConnectorContext = {
    connection: SourceConnection.parse({
      kind,
      host: '127.0.0.1',
      port: 5432,
      database: 'fixture',
      serviceName: 'fixture',
      user: 'reader',
      tls: { mode: 'disable' },
    }),
    secrets: { password: ['fixture', 'password', '39821'].join('-') },
    ...(options.serverSecrets === false ? {} : { serverSecrets: [['server', 'secret', '79461'].join('-')] }),
    timeoutMs: 1_000,
  };
  let stopped = false;
  let closed = Promise.resolve();
  let onClose: () => void = () => undefined;
  const requests: string[] = [];
  const direct = makeConnector(kind, async (ctx) => {
    const session: Session = {
      close: async () => {
        stopped = true;
        onClose();
      },
      version: async () => 'fixture-1',
      list: async () =>
        ctx.timeoutMs === 10
          ? new Promise(() => undefined)
          : [{ schema: 'fixture', name: 'items', type: 'table', rowEstimate: rows.length }],
      keys: async () => [['id']],
      describe: async (select) => {
        fromSql(select, kind);
        if (select.kind === 'object' && select.object.name === 'missing')
          throw new Error(`password=${ctx.secrets.password} server=${ctx.serverSecrets?.[0]}`);
        return columns;
      },
      async *rows(select, _columns, size, limit) {
        fromSql(select, kind);
        const bounded = limit ? rows.slice(0, limit) : rows;
        for (let index = 0; index < bounded.length; index += size) yield bounded.slice(index, index + size);
      },
      select: async (text) => {
        querySql(text, kind);
        requests.push(text);
        if (text.includes('WHERE id = 2')) return [rows[1]!];
        if (text.includes('ORDER BY id DESC')) return [...rows].reverse();
        return rows;
      },
    };
    return session;
  });
  const connector = options.through ? options.through(direct) : direct;
  const probe = (text: string) => async (ctx: ConnectorContext) => {
    requests.length = 0;
    const session = await connector.session!(ctx);
    try {
      return { rows: await session.select(text, []), requests: [...requests] };
    } finally {
      await session.close();
    }
  };
  return {
    connector,
    context,
    select: { kind: 'object', object: { schema: 'fixture', name: 'items' } },
    types: Object.fromEntries(columns.map((entry) => [entry.name, entry.suggested])),
    keys: [['id']],
    read: {
      columns: ['id', 'title'],
      types: { id: 'number', title: 'text' },
      keyColumns: ['id'],
      batchSize: 2,
    },
    expectedRows: rows.map((values) => ({ key: JSON.stringify([values.id]), values })),
    filter: {
      run: probe('SELECT * FROM items WHERE id = 2'),
      expectedRows: [rows[1]!],
      requestIncludes: ['WHERE id = 2'],
    },
    sort: {
      run: probe('SELECT * FROM items ORDER BY id DESC'),
      expectedRows: [...rows].reverse(),
      requestIncludes: ['ORDER BY id DESC'],
    },
    failure: (ctx) =>
      connector.describe(ctx, { kind: 'object', object: { schema: 'fixture', name: 'missing' } }),
    timeout: async (ctx) => {
      stopped = false;
      closed = new Promise<void>((resolve) => {
        onClose = resolve;
      });
      try {
        return await connector.listObjects(ctx);
      } finally {
        // The service observes a closed socket after the proxy reports its timeout.  Include that
        // cleanup in the probe's duration, under the contract's existing limit.
        await closed;
      }
    },
    stopped: () => stopped,
    executions: () => requests.filter((text) => text.includes('SELECT 1; SELECT 2')),
  };
}

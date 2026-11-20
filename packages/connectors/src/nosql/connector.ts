import {
  isNoSqlConnection,
  type NoSqlKind,
  type NoSqlConnection,
  type SourceSelect,
  type SourceTestResult,
  type TestStep,
} from '@riosoma/contracts';
import { cellsOf, plainColumn, Sampler, type RestColumn } from '../rest/records.js';
import { sourceKey } from '../registry.js';
import {
  ConnectorError,
  type Connector,
  type ConnectorContext,
  type ReadOptions,
  type SourceRow,
} from '../types.js';
import { documentKey, type DocumentBackend } from './backend.js';
import { assertUnambiguous, fieldName } from './paths.js';
import { couchBackend } from './couch.js';
import { cosmosBackend } from './cosmos.js';
import { dynamoBackend } from './dynamodb.js';
import { firestoreBackend } from './firestore.js';
import { endpoint, resolveEndpoint, type NoSqlOptions } from './http.js';
import { ALL, and, parseSelector, never, simplify, type DocumentOrder, type Predicate } from './query.js';

export interface DocumentRequest extends ReadOptions {
  reads?: readonly { id: string; column: string; type: string }[];
  predicate: Predicate;
  order: DocumentOrder[];
  limit: number;
}
export function createNoSqlConnector(kind: NoSqlKind, options: NoSqlOptions = {}): Connector {
  function settings(ctx: ConnectorContext): NoSqlConnection {
    if (ctx.connection.kind !== kind || !isNoSqlConnection(ctx.connection))
      throw new ConnectorError('sources.nosql.addressInvalid');
    return ctx.connection;
  }
  function backend(ctx: ConnectorContext): DocumentBackend {
    const c = settings(ctx);
    switch (c.kind) {
      case 'dynamodb':
        return dynamoBackend(ctx, c, options);
      case 'couchdb':
      case 'couchbase':
        return couchBackend(ctx, c, options);
      case 'firestore':
        return firestoreBackend(ctx, c, options);
      case 'cosmosdb':
        return cosmosBackend(ctx, c, options);
    }
  }
  function target(select: SourceSelect) {
    if (select.kind !== 'object') throw new ConnectorError('sources.nosql.noQueries');
    return { ref: select.object, predicate: simplify(parseSelector(select.filter)) };
  }
  async function sample(ctx: ConnectorContext, select: SourceSelect, limit = 1000) {
    const c = settings(ctx);
    const { ref, predicate } = target(select);
    const sampler = new Sampler(c, fieldName);
    if (never(predicate)) return { columns: [], documents: [] };
    const documents: Record<string, unknown>[] = [];
    let pages = 0;
    for await (const page of backend(ctx).pages(ref, predicate, [], limit)) {
      for (const document of page.documents) {
        sampler.add(document);
        documents.push(document);
      }
      if (++pages >= 10) break;
    }
    const columns = sampler.describe();
    // A valid partition can be absent from every sampled document and still form part of the key.
    if (kind === 'cosmosdb')
      for (const name of await backend(ctx).keys(ref))
        if (!columns.some((column) => column.column.name === name)) columns.push(plainColumn(name));
    return { columns, documents };
  }
  function row(
    document: Record<string, unknown>,
    columns: RestColumn[],
    c: NoSqlConnection,
    read: ReadOptions,
    reads?: DocumentRequest['reads'],
  ): SourceRow {
    const cells = cellsOf(document, c, fieldName);
    const byName = new Map(columns.map((column) => [column.column.name, column]));
    const column = (name: string) => byName.get(name) ?? plainColumn(name);
    const keys = read.keyColumns.map(
      (name) => documentKey(document, name) ?? column(name).key(cells.get(name)),
    );
    if (keys.some((key) => key === null || key === '')) throw new ConnectorError('sources.sync.keyEmpty');
    return {
      key: sourceKey(keys),
      values: Object.fromEntries(
        (
          reads ??
          read.columns.map((name) => ({
            id: name,
            column: name,
            type: read.types[name] ?? column(name).column.suggested?.type ?? 'text',
          }))
        ).map((entry) => [entry.id, column(entry.column).value(cells.get(entry.column), entry.type)]),
      ),
    };
  }
  return {
    kind,
    async test(ctx) {
      const result: SourceTestResult = { ok: false, steps: [] };
      let step: TestStep = 'resolve';
      let start = Date.now();
      const ok = (name: TestStep) => result.steps.push({ step: name, status: 'ok', ms: Date.now() - start });
      try {
        const c = settings(ctx);
        await resolveEndpoint(endpoint(c), options);
        ok('resolve');
        start = Date.now();
        step = 'authenticate';
        const objects = await backend(ctx).list();
        ok('connect');
        result.steps.push({
          step: 'tls',
          status: endpoint(c).startsWith('https:') ? 'ok' : 'skipped',
          ms: endpoint(c).startsWith('https:') ? Date.now() - start : null,
        });
        ok('authenticate');
        ok('collections');
        step = 'document';
        start = Date.now();
        if (objects[0]) {
          await sample(ctx, { kind: 'object', object: objects[0] }, 1);
          ok('document');
        } else result.steps.push({ step: 'document', status: 'skipped', ms: null });
        result.ok = true;
      } catch (error) {
        if (error instanceof ConnectorError && step === 'authenticate') {
          if (error.messageKey === 'sources.test.resolve') step = 'resolve';
          else if (error.messageKey === 'sources.test.connect') step = 'connect';
          else if (error.messageKey === 'sources.test.tls') step = 'tls';
        }
        result.steps.push({
          step,
          status: 'failed',
          ms: Date.now() - start,
          messageKey: error instanceof ConnectorError ? error.messageKey : 'sources.sync.read',
        });
      }
      return result;
    },
    async listObjects(ctx) {
      return backend(ctx).list();
    },
    async keyCandidates(ctx, ref) {
      return [await backend(ctx).keys(ref)];
    },
    async describe(ctx, select) {
      return (await sample(ctx, select)).columns.map((c) => c.column);
    },
    async preview(ctx, select, limit) {
      const { columns, documents } = await sample(ctx, select, Math.max(1, Math.min(limit, 1000)));
      return {
        columns: columns.map((c) => c.column),
        rowEstimate: null,
        rows: documents.map((document) => {
          const cells = cellsOf(document, settings(ctx), fieldName);
          return columns.map((c) => c.value(cells.get(c.column.name), c.column.suggested?.type ?? 'text'));
        }),
      };
    },
    async *read(ctx, select, read) {
      const c = settings(ctx);
      const { ref, predicate } = target(select);
      if (never(predicate)) return;
      const remote = backend(ctx);
      const columns = (await sample(ctx, select)).columns;
      const incremental =
        kind === 'couchdb' &&
        select.kind === 'object' &&
        !select.filter &&
        read.keyColumns.length === 1 &&
        read.keyColumns[0] === '_id';
      const projection = JSON.stringify([c, select, read.columns, read.types, read.keyColumns]);
      const since = incremental && read.since?.projection === projection ? read.since.cursor : undefined;
      const checkpoint = incremental && !since ? await remote.checkpoint!(ref) : undefined;
      if (since) read.onIncremental?.();
      const pages = since ? remote.changes!(ref, since) : remote.pages(ref, predicate, []);
      let cursor = checkpoint;
      const batchSize = Math.max(1, Math.min(read.batchSize ?? 5000, 5000));
      let batch: SourceRow[] = [];
      for await (const page of pages) {
        for (const document of page.documents) {
          batch.push(row(document, columns, c, read));
          if (batch.length >= batchSize) {
            yield batch;
            batch = [];
          }
        }
        for (const id of page.deleted ?? []) batch.push({ key: sourceKey([id]), values: {}, deleted: true });
        cursor = page.cursor ?? cursor;
      }
      if (batch.length) yield batch;
      if (cursor !== undefined) read.onValidators?.({ cursor, projection });
    },
    async documentQuery(ctx, select, request) {
      const { ref, predicate } = target(select);
      const combined = simplify(and(predicate, request.predicate));
      if (never(combined)) return [];
      const { columns, documents } = await sample(ctx, select);
      const fields = new Set([...request.columns, ...(request.reads ?? []).map((read) => read.column)]);
      const inspect = (p: Predicate): void => {
        if ('terms' in p) p.terms.forEach(inspect);
        else fields.add(p.field);
      };
      inspect(combined);
      request.order.forEach((order) => fields.add(order.field));
      for (const document of documents) assertUnambiguous(document, settings(ctx), fields);
      const rows: SourceRow[] = [];
      for await (const page of backend(ctx).pages(ref, combined, request.order, request.limit)) {
        for (const document of page.documents) assertUnambiguous(document, settings(ctx), fields);
        rows.push(
          ...page.documents.map((document) => row(document, columns, settings(ctx), request, request.reads)),
        );
      }
      return rows;
    },
  };
}
export { ALL };

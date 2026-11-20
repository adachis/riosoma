import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Airtable's Web API, for tests.  It answers who a token belongs to, the bases list,
 * base schemas (with each grid view's visible fields), and records a page at a time with `offset`,
 * `view`, `fields[]`, and `returnFieldsByFieldId`, in the shapes Airtable's documentation gives.  It
 * serves files for attachments too.  Tests can make it answer 429 a number of times, hold a request until they let
 * it go, and see every request it got.  It never reaches the real Airtable.
 */

export interface FakeField {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: Record<string, unknown>;
}

export interface FakeView {
  id: string;
  name: string;
  type: string;
  /** Grid views: the fields it shows, in order */
  visibleFieldIds?: string[];
  /** The records it shows, in its order, or every record in the table's order when left out */
  records?: string[];
}

export interface FakeRecord {
  id: string;
  createdTime?: string;
  /** Values by field ID, leaving empty ones out as Airtable does */
  fields: Record<string, unknown>;
}

export interface FakeTable {
  id: string;
  name: string;
  description?: string;
  primaryFieldId: string;
  fields: FakeField[];
  views: FakeView[];
  records: FakeRecord[];
}

export interface FakeBase {
  id: string;
  name: string;
  permissionLevel?: string;
  tables: FakeTable[];
}

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** The parsed JSON body, for a write */
  body: unknown;
  /** Whether it carried the token the fake expects */
  authorized: boolean;
  /** What the test's clock said when the request came in */
  at: number;
}

export interface FakeAirtable {
  /** The API's address, like `http://127.0.0.1:1234` */
  url: string;
  port: number;
  requests: FakeRequest[];
  bases: FakeBase[];
  /** Files served at `/files/<name>` */
  files: Map<string, Buffer>;
  /** Answers 429 the next `times` requests whose path starts with `prefix` */
  throttle(prefix: string, times: number, retryAfterSeconds?: number): void;
  /** Holds the next request whose path starts with `prefix` until `release` */
  hold(prefix: string): { reached: Promise<void>; release(): void };
  /** Answers every request with this status, for tokens missing a scope */
  refuseWith(status: number | null): void;
  /** Refuses writes with this status and lets reads through, for a token missing the write scope */
  refuseWrites(status: number | null): void;
  /** Fails the next `times` writes the match picks, with Airtable's own error type */
  failWrite(match: (request: FakeRequest) => boolean, times: number, errorType: string): void;
  /** Carries the next `times` writes under `prefix` out, then closes the socket without answering */
  dropAnswer(prefix: string, times: number): void;
  /** Forgets throttles and refusals */
  reset(): void;
  close(): Promise<void>;
}

let fakeIdCounter = 0;
/** A stand-in for an Airtable ID, unique within a test run. */
function airtableId(prefix: string): string {
  fakeIdCounter += 1;
  return `${prefix}${String(fakeIdCounter).padStart(14, '0')}`;
}

const PAGE_LIMIT = 100;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export async function startFakeAirtable(options: {
  token: string;
  bases: FakeBase[];
  /** Base-list pages, to make listing page too */
  basesPerPage?: number;
  now?: () => number;
}): Promise<FakeAirtable> {
  const requests: FakeRequest[] = [];
  const throttles: Array<{ prefix: string; times: number; retryAfter?: number }> = [];
  const holds: Array<{ prefix: string; arrived: () => void; gate: Promise<void> }> = [];
  const files = new Map<string, Buffer>();
  let refusal: number | null = null;
  let writeRefusal: number | null = null;
  const failWrites: Array<{ match: (request: FakeRequest) => boolean; times: number; errorType: string }> =
    [];
  const drops: Array<{ prefix: string; times: number }> = [];

  const isWrite = (method: string) =>
    method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://fake.test');
    const authorized = req.headers.authorization === `Bearer ${options.token}`;
    const method = req.method ?? 'GET';
    let body: unknown;
    if (isWrite(method)) {
      const chunks: Buffer[] = [];
      for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      const text = Buffer.concat(chunks).toString('utf8');
      body = text ? JSON.parse(text) : undefined;
    }
    const entry: FakeRequest = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
      authorized,
      at: options.now?.() ?? Date.now(),
    };
    requests.push(entry);
    if (url.pathname.startsWith('/files/')) {
      const file = files.get(decodeURIComponent(url.pathname.slice('/files/'.length)));
      if (!file) return send(res, 404, { error: 'NOT_FOUND' });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(file);
      return;
    }
    const held = holds.findIndex((hold) => url.pathname.startsWith(hold.prefix));
    if (held >= 0) {
      const [hold] = holds.splice(held, 1);
      hold!.arrived();
      await hold!.gate;
    }
    const throttled = throttles.find((item) => url.pathname.startsWith(item.prefix) && item.times > 0);
    if (throttled) {
      throttled.times--;
      return send(
        res,
        429,
        { errors: [{ error: 'RATE_LIMIT_REACHED', message: 'Rate limit exceeded. Please try again later' }] },
        throttled.retryAfter === undefined ? {} : { 'retry-after': String(throttled.retryAfter) },
      );
    }
    if (!authorized)
      // Some services repeat what they were sent, and the importer has to cope with that.
      return send(res, 401, {
        error: {
          type: 'AUTHENTICATION_REQUIRED',
          message: `Invalid authentication token ${req.headers.authorization ?? ''}`,
        },
      });
    // Any token Airtable takes may say whose it is, whatever it may read.
    if (url.pathname === '/v0/meta/whoami') return send(res, 200, { id: 'usrFakeAirtable00' });
    if (refusal !== null)
      return send(res, refusal, {
        error: { type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', message: 'Invalid permissions' },
      });

    if (url.pathname === '/v0/meta/bases') {
      const per = options.basesPerPage ?? 1_000;
      const start = Number(url.searchParams.get('offset') ?? 0);
      const page = options.bases.slice(start, start + per);
      return send(res, 200, {
        bases: page.map((base) => ({
          id: base.id,
          name: base.name,
          permissionLevel: base.permissionLevel ?? 'create',
        })),
        ...(start + per < options.bases.length ? { offset: String(start + per) } : {}),
      });
    }
    const schema = /^\/v0\/meta\/bases\/([^/]+)\/tables$/.exec(url.pathname);
    if (schema && method === 'GET') {
      const base = options.bases.find((item) => item.id === schema[1]);
      if (!base) return send(res, 404, { error: 'NOT_FOUND' });
      const visible = url.searchParams.getAll('include[]').includes('visibleFieldIds');
      return send(res, 200, {
        tables: base.tables.map((table) => ({
          id: table.id,
          name: table.name,
          ...(table.description === undefined ? {} : { description: table.description }),
          primaryFieldId: table.primaryFieldId,
          fields: table.fields,
          views: table.views.map((view) => ({
            id: view.id,
            name: view.name,
            type: view.type,
            ...(visible && view.type === 'grid'
              ? { visibleFieldIds: view.visibleFieldIds ?? table.fields.map((f) => f.id) }
              : {}),
          })),
        })),
      });
    }
    const records = /^\/v0\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (records && method === 'GET') {
      const base = options.bases.find((item) => item.id === records[1]);
      const table = base?.tables.find(
        (item) =>
          item.id === decodeURIComponent(records[2]!) || item.name === decodeURIComponent(records[2]!),
      );
      if (!table)
        return send(res, 404, { error: { type: 'TABLE_NOT_FOUND', message: 'Could not find table' } });
      const viewId = url.searchParams.get('view');
      const view = viewId
        ? table.views.find((item) => item.id === viewId || item.name === viewId)
        : undefined;
      if (viewId && !view)
        return send(res, 422, { error: { type: 'VIEW_NAME_NOT_FOUND', message: 'Unknown view' } });
      const byId = url.searchParams.get('returnFieldsByFieldId') === 'true';
      const only = url.searchParams.getAll('fields[]');
      const rows = view?.records
        ? view.records.map((id) => table.records.find((record) => record.id === id)!).filter(Boolean)
        : table.records;
      const size = Math.min(PAGE_LIMIT, Number(url.searchParams.get('pageSize') ?? PAGE_LIMIT));
      const start = Number(url.searchParams.get('offset')?.split('/')[1] ?? 0);
      const page = rows.slice(start, start + size);
      return send(res, 200, {
        records: page.map((record) => ({
          id: record.id,
          createdTime: record.createdTime ?? '2026-01-01T00:00:00.000Z',
          fields: Object.fromEntries(
            Object.entries(record.fields)
              .filter(([id]) => !only.length || only.includes(id))
              .map(([id, value]) => [
                byId ? id : (table.fields.find((field) => field.id === id)?.name ?? id),
                value,
              ]),
          ),
        })),
        ...(start + size < rows.length ? { offset: `itr${table.id}/${start + size}` } : {}),
      });
    }

    // Writes, from here on.  A missing write scope, a chosen failure, and a dropped answer are all
    // the engine needs to try again safely.
    if (isWrite(method)) {
      if (writeRefusal !== null)
        return send(res, writeRefusal, {
          error: { type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND', message: 'Insufficient permissions' },
        });
      const failing = failWrites.find((item) => item.times > 0 && item.match(entry));
      if (failing) {
        failing.times--;
        return send(res, 422, { error: { type: failing.errorType, message: 'Write refused' } });
      }
    }
    const maybeDrop = (): boolean => {
      const drop = drops.find((item) => item.times > 0 && url.pathname.startsWith(item.prefix));
      if (!drop) return false;
      drop.times--;
      res.destroy();
      return true;
    };
    const addChoices = (table: FakeTable, fieldId: string, value: unknown) => {
      const field = table.fields.find((candidate) => candidate.id === fieldId);
      if (!field || (field.type !== 'singleSelect' && field.type !== 'multipleSelects')) return;
      const options = (field.options ??= {}) as {
        choices?: Array<{ id: string; name: string; color: string }>;
      };
      options.choices ??= [];
      for (const name of Array.isArray(value) ? value : [value])
        if (typeof name === 'string' && name && !options.choices.some((choice) => choice.name === name))
          options.choices.push({ id: airtableId('sel'), name, color: 'blueLight2' });
    };
    const outFields = (table: FakeTable, record: FakeRecord, byFieldId: boolean) =>
      Object.fromEntries(
        Object.entries(record.fields).map(([id, value]) => [
          byFieldId ? id : (table.fields.find((field) => field.id === id)?.name ?? id),
          value,
        ]),
      );

    const makeTable = /^\/v0\/meta\/bases\/([^/]+)\/tables$/.exec(url.pathname);
    if (makeTable && method === 'POST') {
      const base = options.bases.find((item) => item.id === makeTable[1]);
      if (!base) return send(res, 404, { error: { type: 'NOT_FOUND', message: 'Base not found' } });
      const input = body as { name: string; description?: string; fields: FakeField[] };
      if (base.tables.some((table) => table.name === input.name))
        return send(res, 422, {
          error: { type: 'DUPLICATE_TABLE_NAME', message: 'A table with this name already exists' },
        });
      const fields: FakeField[] = input.fields.map((field) => ({
        id: airtableId('fld'),
        name: field.name,
        type: field.type,
        ...(field.options ? { options: field.options } : {}),
      }));
      const table: FakeTable = {
        id: airtableId('tbl'),
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        primaryFieldId: fields[0]!.id,
        fields,
        views: [],
        records: [],
      };
      base.tables.push(table);
      if (maybeDrop()) return;
      return send(res, 200, {
        id: table.id,
        name: table.name,
        ...(table.description ? { description: table.description } : {}),
        primaryFieldId: table.primaryFieldId,
        fields: table.fields,
        views: [],
      });
    }

    const makeField = /^\/v0\/meta\/bases\/([^/]+)\/tables\/([^/]+)\/fields$/.exec(url.pathname);
    if (makeField && method === 'POST') {
      const base = options.bases.find((item) => item.id === makeField[1]);
      const table = base?.tables.find((item) => item.id === makeField[2]);
      if (!table) return send(res, 404, { error: { type: 'NOT_FOUND', message: 'Table not found' } });
      const input = body as FakeField;
      if (table.fields.some((field) => field.name === input.name))
        return send(res, 422, {
          error: { type: 'DUPLICATE_OR_EMPTY_FIELD_NAME', message: 'Duplicate field name' },
        });
      const field: FakeField = {
        id: airtableId('fld'),
        name: input.name,
        type: input.type,
        ...(input.options ? { options: input.options } : {}),
      };
      table.fields.push(field);
      if (maybeDrop()) return;
      return send(res, 200, field);
    }

    const write = /^\/v0\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (write && (method === 'PATCH' || method === 'POST')) {
      const base = options.bases.find((item) => item.id === write[1]);
      const table = base?.tables.find(
        (item) => item.id === decodeURIComponent(write[2]!) || item.name === decodeURIComponent(write[2]!),
      );
      if (!table)
        return send(res, 404, { error: { type: 'TABLE_NOT_FOUND', message: 'Could not find table' } });
      const input = body as {
        records: Array<{ id?: string; fields: Record<string, unknown> }>;
        performUpsert?: { fieldsToMergeOn: string[] };
        typecast?: boolean;
        returnFieldsByFieldId?: boolean;
      };
      if (!input?.records || input.records.length > 10)
        return send(res, 422, {
          error: { type: 'INVALID_REQUEST_UNKNOWN', message: 'Too many records in one request' },
        });
      const toId = (key: string) =>
        table.fields.find((field) => field.id === key || field.name === key)?.id ?? key;
      const created: string[] = [];
      const updated: string[] = [];
      const out: FakeRecord[] = [];
      for (const rec of input.records) {
        const fields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(rec.fields)) {
          const id = toId(key);
          fields[id] = value;
          if (input.typecast) addChoices(table, id, value);
        }
        let target: FakeRecord | undefined;
        if (input.performUpsert) {
          const mergeId = toId(input.performUpsert.fieldsToMergeOn[0]!);
          const matches = table.records.filter(
            (record) => String(record.fields[mergeId] ?? '') === String(fields[mergeId] ?? ''),
          );
          if (matches.length > 1)
            return send(res, 422, {
              error: { type: 'INVALID_RECORDS', message: 'Multiple records match the upsert key' },
            });
          target = matches[0];
        } else if (rec.id) {
          target = table.records.find((record) => record.id === rec.id);
          if (!target) continue;
        }
        if (target) {
          target.fields = { ...target.fields, ...fields };
          updated.push(target.id);
          out.push(target);
        } else {
          const made: FakeRecord = { id: airtableId('rec'), fields };
          table.records.push(made);
          created.push(made.id);
          out.push(made);
        }
      }
      if (maybeDrop()) return;
      // A record write names this in the body, not the query string, unlike a read.
      const byFieldId =
        input.returnFieldsByFieldId === true || url.searchParams.get('returnFieldsByFieldId') === 'true';
      return send(res, 200, {
        records: out.map((record) => ({
          id: record.id,
          createdTime: record.createdTime ?? '2026-01-01T00:00:00.000Z',
          fields: outFields(table, record, byFieldId),
        })),
        createdRecords: created,
        updatedRecords: updated,
      });
    }

    if (write && method === 'DELETE') {
      const base = options.bases.find((item) => item.id === write[1]);
      const table = base?.tables.find(
        (item) => item.id === decodeURIComponent(write[2]!) || item.name === decodeURIComponent(write[2]!),
      );
      if (!table)
        return send(res, 404, { error: { type: 'TABLE_NOT_FOUND', message: 'Could not find table' } });
      const ids = url.searchParams.getAll('records[]');
      if (ids.length > 10)
        return send(res, 422, {
          error: { type: 'INVALID_REQUEST_UNKNOWN', message: 'Too many records in one request' },
        });
      const deleted = ids.map((id) => {
        const index = table.records.findIndex((record) => record.id === id);
        if (index >= 0) table.records.splice(index, 1);
        return { id, deleted: true };
      });
      if (maybeDrop()) return;
      return send(res, 200, { records: deleted });
    }

    return send(res, 404, { error: 'NOT_FOUND' });
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'SERVER_ERROR' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    bases: options.bases,
    files,
    throttle(prefix, times, retryAfterSeconds) {
      throttles.push({
        prefix,
        times,
        ...(retryAfterSeconds === undefined ? {} : { retryAfter: retryAfterSeconds }),
      });
    },
    hold(prefix) {
      let arrived!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ prefix, arrived, gate });
      return { reached, release };
    },
    refuseWith(status) {
      refusal = status;
    },
    refuseWrites(status) {
      writeRefusal = status;
    },
    failWrite(match, times, errorType) {
      failWrites.push({ match, times, errorType });
    },
    dropAnswer(prefix, times) {
      drops.push({ prefix, times });
    },
    reset() {
      throttles.length = 0;
      refusal = null;
      writeRefusal = null;
      failWrites.length = 0;
      drops.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

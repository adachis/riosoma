import { resolveSelectOptions } from '../data/select-options.js';
import { createHash } from 'node:crypto';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AppError,
  RecordId,
  RecordsQuery,
  SchemaFieldCreate,
  SchemaFieldUpdate,
  SchemaTableCreate,
  SchemaTableUpdate,
  TOKEN_SCOPES,
  checkCellValue,
  newId,
  type Collaborator,
  type TokenScope,
  type TextMergeNotice,
} from '@riosoma/contracts';
import { ident, join, query, sql } from '@riosoma/db';
import { z } from 'zod';
import { RecordReader, rowsById, tableAccess, type ReadOptions, type TableAccess } from '../api-v1/reads.js';
import { incoming, saveRecords, trashRecords, writeAccess } from '../api-v1/writes.js';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { loadCollaborators, loadFields, loadTables, loadViews } from '../data/metadata.js';
import { columnRef, columnType, typeSql } from '../data/physical/columns.js';
import { formulaUsesClock } from '../data/physical/formulas.js';
import { listDatabases } from '../data/routes.js';
import { WindowLimiter } from '../data/shared-view-reads.js';
import type { StoredField } from '../data/types.js';
import {
  airtableErrorHandler,
  invalidRecords,
  invalidRequest,
  iteratorGone,
  missingFields,
  modelNotFound,
  notFound,
  rateLimited,
  readOnlyField,
  rowMissing,
  unknownField,
  viewNotFound,
} from './errors.js';
import { filterFormula, filterPredicate, inDatabase, matchingIds } from './formula.js';
import { bodyParams, queryParams, type ListParams } from './query.js';
import { PERMISSION_LEVELS, baseAlias, fieldSpecFrom, tableMeta } from './schema.js';
import { createField, createTable, updateField, updateTable, withChoices } from '../api-v1/schema.js';
import { parse } from '../http/validate.js';
import { message } from '../api-v1/messages.js';
import { airtableRecords, sentAsText, type AirtableRecord, type OutputOptions } from './values.js';

/**
 * Airtable's Web API, under `/v0/` beside Riosoma's own REST API, so scripts, integrations, and
 * client libraries written for Airtable keep working with a Riosoma personal access token and this
 * server's address.  Paths, request and response shapes, errors, and pagination follow Airtable's.
 * A base is a database, named by its ID, its `app…` alias, or the Airtable base it was imported
 * from.  Tables and fields go by name or ID.  Every read and write acts as the token's owner,
 * through the same checks and command bus as the app, so hidden fields and records never appear.
 */

/** Airtable takes at most this many records in one write */
const WRITE_LIMIT = 10;
/** Bases in one page of `GET /v0/meta/bases` */
const BASES_PAGE = 1_000;
/** Field types an upsert can match records by: plain values that are the same when equal */
const MERGEABLE = new Set<string>([
  'text',
  'longText',
  'email',
  'url',
  'phone',
  'number',
  'currency',
  'percent',
  'duration',
  'rating',
  'date',
  'singleSelect',
  'checkbox',
]);
const BASE = /^(db|app)([0-9A-Za-z]{14})$/;

const TableParams = z.object({ baseId: z.string(), tableIdOrName: z.string().min(1) });
const RecordParams = TableParams.extend({ recordId: z.string() });

interface Entry {
  id?: string;
  fields: Record<string, unknown>;
  baseFields?: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  if (!isObject(request.body)) throw invalidRequest('Invalid request: the body must be a JSON object');
  return request.body;
}

function entry(value: unknown, needsId: boolean): Entry {
  if (!isObject(value)) throw invalidRecords('Each record must be an object');
  if (!isObject(value.fields)) throw missingFields();
  if (value.id !== undefined && typeof value.id !== 'string')
    throw invalidRecords('A record id must be text');
  if (needsId && !value.id) throw invalidRecords('Each record needs an id');
  if (value.baseFields !== undefined && !isObject(value.baseFields))
    throw invalidRequest(message('data.textEdit.unsupported'));
  return {
    ...(value.id ? { id: value.id } : {}),
    fields: value.fields,
    ...(isObject(value.baseFields) ? { baseFields: value.baseFields } : {}),
  };
}

function entries(value: unknown, needsId: boolean): Entry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > WRITE_LIMIT)
    throw invalidRecords(`A request can name from 1 to ${WRITE_LIMIT} records`);
  return value.map((item) => entry(item, needsId));
}

function bool(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw invalidRequest(`Invalid ${name}: it must be true or false`);
  return value;
}

/** Values listed in a query string, under `name`, `name[]`, or `name[0]`. */
function listed(raw: unknown, name: string): string[] {
  if (!isObject(raw)) return [];
  const values: string[] = [];
  const pattern = new RegExp(`^${name}(?:\\[\\d*\\])?$`);
  for (const [key, value] of Object.entries(raw))
    if (pattern.test(key)) values.push(...(Array.isArray(value) ? value.map(String) : [String(value)]));
  return values;
}

/** A field the caller can see, by ID or else by name, or Airtable's error for an unknown one. */
function fieldNamed(access: TableAccess, key: string): StoredField {
  const field = access.fields.find((f) => f.id === key) ?? access.fields.find((f) => f.name === key);
  if (!field) throw unknownField(key);
  return field;
}

/**
 * Fields this API reads but never writes.  A signature is only ever made by a person signing, and
 * here it reads as the time they signed, which couldn't be written back as a signature anyway.  A
 * managed field, such as a payment result, only ever changes when Riosoma writes it.
 */
function readOnly(field: StoredField): boolean {
  return field.type === 'signature' || Boolean(field.managed);
}

/** A field a write names, refused as Airtable refuses a computed one when this API can't write it. */
function writable(access: TableAccess, key: string): StoredField {
  const field = fieldNamed(access, key);
  if (readOnly(field)) throw readOnlyField(field.name);
  return field;
}

/** Field types a formula reads as people's names */
const PEOPLE = new Set<string>(['user', 'createdBy', 'lastModifiedBy']);

/** What decides which records a filter formula keeps, other than what the records hold. */
function selectionKey(formula: StoredField, zone: string, context: { now: Date }): string {
  const plan = formula.formula;
  const fields = plan?.fields ?? [];
  return createHash('sha256')
    .update(
      JSON.stringify([
        formula.options,
        zone,
        formulaUsesClock(formula) ? context.now.getTime() : null,
        fields.map((field) => [field.id, field.type, field.options]),
        fields.some((field) => PEOPLE.has(field.type)) ? [...(plan?.people ?? [])] : null,
      ]),
    )
    .digest('base64url');
}

/** Stands for a value no record holds yet, like a select option `typecast` is about to add */
const UNMATCHED = Symbol('unmatched');

export async function airtableRoutes(app: FastifyInstance): Promise<void> {
  const reader = new RecordReader(app);
  const limiter = new WindowLimiter(app.ctx.config.airtableApiSecondLimit ?? 50, 1_000);
  const policy = (scope: TokenScope | readonly TokenScope[]) => ({
    config: { policy: { kind: 'token' as const, scope } },
  });

  app.setErrorHandler(airtableErrorHandler);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  // The token is known by now: the policy check runs before this plugin's own hooks.
  app.addHook('preHandler', async (request, reply) => {
    const token = request.actor?.token;
    if (!token) return;
    const wait = limiter.take(token.id);
    if (wait) {
      reply.header('retry-after', String(wait));
      throw rateLimited();
    }
  });

  const origin = (request: FastifyRequest) =>
    app.ctx.config.baseUrl?.replace(/\/+$/, '') || `${request.protocol}://${request.host}`;
  const output = (
    request: FastifyRequest,
    params: Pick<ListParams, 'cellFormat' | 'returnFieldsByFieldId' | 'timeZone' | 'userLocale'>,
  ): OutputOptions => ({
    cellFormat: params.cellFormat,
    byId: params.returnFieldsByFieldId,
    timeZone: params.timeZone ?? 'UTC',
    locale: params.userLocale ?? 'en-US',
    origin: origin(request),
  });

  /** The database a base ID names that the caller can open, with the scope that checked it. */
  async function database(request: FastifyRequest, baseId: string) {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const scope = new AccessScope(pool, schemas, actor);
    const match = BASE.exec(baseId);
    if (!match) throw modelNotFound();
    const candidates = [`db${match[2]}`];
    // A base imported from Airtable answers to its Airtable ID too, as the newest import of it.
    if (match[1] === 'app') {
      const imported = await query<{ database_id: string }>(
        pool,
        sql`SELECT database_id FROM ${ident(schemas.app, 'airtable_imports')}
        WHERE org_id = ${actor.orgId} AND base_id = ${baseId} AND state = 'finished' AND database_id IS NOT NULL
        ORDER BY finished_at DESC NULLS LAST, created_at DESC LIMIT 20`,
      );
      candidates.push(...imported.rows.map((row) => row.database_id));
    }
    for (const id of candidates) if (await scope.databaseRole(id)) return { databaseId: id, scope };
    throw modelNotFound();
  }

  /** A table in a base by ID or name, read as the caller may read it, or write to it. */
  async function table(request: FastifyRequest, write: boolean): Promise<TableAccess> {
    const { baseId, tableIdOrName } = TableParams.parse(request.params);
    const { databaseId } = await database(request, baseId);
    const { pool, schemas } = dataStore(app.ctx);
    const tables = await loadTables(pool, schemas, databaseId);
    const found = tables.find((t) => t.id === tableIdOrName) ?? tables.find((t) => t.name === tableIdOrName);
    if (!found) throw modelNotFound();
    try {
      return await (write ? writeAccess : tableAccess)(app, request, found.id);
    } catch (error) {
      if (error instanceof AppError && (error.code === 'not_found' || error.code === 'forbidden'))
        throw modelNotFound();
      throw error;
    }
  }

  /** Records just written, read back as they now stand, in the order they were named. */
  async function written(
    request: FastifyRequest,
    tableId: string,
    ids: readonly string[],
    options: OutputOptions,
  ): Promise<AirtableRecord[]> {
    const fresh = await tableAccess(app, request, tableId);
    const rows = await rowsById(fresh, [...ids], options.timeZone);
    const order = new Map(ids.map((id, index) => [id, index]));
    rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return airtableRecords(fresh, fresh.fields, rows, options);
  }

  function writeOutput(request: FastifyRequest, body: Record<string, unknown>): OutputOptions {
    const fromQuery = queryParams(request.query);
    return output(request, {
      ...fromQuery,
      returnFieldsByFieldId:
        bool(body.returnFieldsByFieldId, 'returnFieldsByFieldId') || fromQuery.returnFieldsByFieldId,
    });
  }

  async function list(request: FastifyRequest, params: ListParams) {
    const access = await table(request, false);
    const fields = params.fields?.map((key) => fieldNamed(access, key).id);
    const sort = params.sort.map((item) => ({
      fieldId: fieldNamed(access, item.field).id,
      direction: item.direction,
    }));
    let view: string | undefined;
    if (params.view) {
      const views = await loadViews(access.pool, access.schemas, [access.table.id]);
      const found = views.find((v) => v.id === params.view) ?? views.find((v) => v.name === params.view);
      if (!found) throw viewNotFound(params.view);
      view = found.id;
    }
    if (params.offset && params.offset.length > 200) throw iteratorGone();
    const input = RecordsQuery.parse({
      view,
      fields,
      sort,
      pageSize: params.pageSize,
      cursor: params.offset,
      fieldKey: params.returnFieldsByFieldId ? 'id' : 'name',
      cellFormat: params.cellFormat,
      timeZone: params.timeZone,
      locale: params.userLocale,
    });
    const text = params.filterByFormula;
    const formula = text ? await filterFormula(text, access) : null;
    const zone = params.timeZone ?? 'UTC';
    const filter: ReadOptions = !formula
      ? {}
      : inDatabase(formula, zone)
        ? { where: (context) => filterPredicate(formula, context), key: text }
        : {
            select: {
              // What decides the records it keeps, besides the records themselves, since a list
              // reuses the order an earlier one made while the table is unchanged.  A formula that
              // reads the clock keeps different records as time passes, and every page of one list
              // reads the same moment, which its offset carries.  A name can come to mean another
              // field, and a person or a choice can take another name, without a record changing.
              key: (context) => selectionKey(formula, zone, context),
              ids: (context, predicate) => matchingIds(formula, access, context, predicate),
            },
            key: text,
          };
    const page = await reader.page(request, access.table.id, input, {
      access,
      // Airtable's `view` picks records and their order.  It returns every field regardless.
      viewFields: false,
      ...filter,
      ...(params.maxRecords ? { limit: params.maxRecords } : {}),
    });
    const records = await airtableRecords(page.access, page.fields, page.rows, output(request, params));
    return { records, ...(page.next ? { offset: page.next } : {}) };
  }

  /**
   * Upserts: each record that names no ID updates the one record whose `fieldsToMergeOn` hold the
   * same values, or is created when none does.  More than one match fails, as in Airtable.
   */
  async function merged(
    access: TableAccess,
    records: readonly Entry[],
    mergeOn: readonly string[],
    typecast: boolean,
  ): Promise<Entry[]> {
    const merge = mergeOn.map((key) => fieldNamed(access, key));
    for (const field of merge)
      if (!MERGEABLE.has(field.type)) throw invalidRequest(`Field "${field.name}" can't be used to merge on`);
    const people: Collaborator[] = await loadCollaborators(
      access.pool,
      access.schemas,
      access.actor.orgId,
      access.scope,
    );
    const claimed = new Set(records.flatMap((record) => (record.id ? [record.id] : [])));
    const keys = new Set<string>();
    const result: Entry[] = [];
    for (const record of records) {
      if (record.id) {
        result.push(record);
        continue;
      }
      const values = merge.map((field) => {
        const key = Object.keys(record.fields).find((name) => {
          const named =
            access.fields.find((f) => f.id === name) ?? access.fields.find((f) => f.name === name);
          return named?.id === field.id;
        });
        if (key === undefined)
          throw invalidRequest(`Each record needs a value for "${field.name}", which it merges on`);
        const copy = { ...field, options: structuredClone(field.options) } as StoredField;
        const added = new Set<string>();
        const value = incoming(copy, record.fields[key], typecast || sentAsText(field), people, added);
        if (added.size) return UNMATCHED;
        const checked = checkCellValue(copy, value);
        if (!checked.ok)
          throw new AppError('validation_failed', checked.messageKey, { params: { field: field.name } });
        return checked.value;
      });
      const key = JSON.stringify(values.map((value) => (value === UNMATCHED ? null : value)));
      if (keys.has(key)) throw invalidRequest('Two records in the request have the same values to merge on');
      keys.add(key);
      let id: string | undefined;
      if (!values.includes(UNMATCHED)) {
        const conditions = merge.map((field, index) => {
          const value = values[index];
          const ref = columnRef(field);
          if (field.type === 'checkbox') return sql`COALESCE(${ref}, false) = ${value === true}`;
          if (value === null) return sql`${ref} IS NULL`;
          return sql`${ref} = ${value}::${typeSql(columnType(field)!)}`;
        });
        const found = await query<{ id: string }>(
          access.pool,
          sql`SELECT __id AS id FROM ${ident(access.schemas.data, access.table.id)}
          WHERE __deleted_at IS NULL AND (${access.scope.recordPredicate(access.table.id)})
          AND ${join(conditions, ' AND ')} LIMIT 2`,
        );
        if (found.rows.length > 1)
          throw invalidRequest('More than one record matches the values to merge on, so the upsert stopped');
        id = found.rows[0]?.id;
      }
      if (id && claimed.has(id))
        throw invalidRequest('Two records in the request would change the same record');
      if (id) claimed.add(id);
      result.push({ ...record, ...(id ? { id } : {}) });
    }
    return result;
  }

  /** Throws Airtable's error for the first record named that isn't there or can't be seen. */
  async function present(access: TableAccess, ids: readonly string[]): Promise<void> {
    const valid = ids.filter((id) => RecordId.safeParse(id).success);
    const found = new Set((await rowsById(access, valid)).map((row) => row.id));
    const missing = ids.find((id) => !found.has(id));
    if (missing) throw rowMissing(missing);
  }

  app.get('/v0/meta/whoami', policy(TOKEN_SCOPES), async (request) => {
    const actor = requireActor(request);
    return { id: actor.userId, scopes: actor.token?.scopes ?? [] };
  });

  app.get('/v0/meta/bases', policy('schema.bases:read'), async (request) => {
    const offset = listed(request.query, 'offset')[0];
    const start = offset === undefined ? 0 : /^\d{1,9}$/.test(offset) ? Number(offset) : NaN;
    if (!Number.isFinite(start)) throw iteratorGone();
    const databases = await listDatabases(app.ctx, requireActor(request));
    const page = databases.slice(start, start + BASES_PAGE);
    return {
      bases: page.map((database) => ({
        id: baseAlias(database.id),
        name: database.name,
        permissionLevel: PERMISSION_LEVELS[database.role],
      })),
      ...(start + BASES_PAGE < databases.length ? { offset: String(start + BASES_PAGE) } : {}),
    };
  });

  /** A base's tables as the meta API describes them, with the fields and views the caller can see. */
  async function metaTables(request: FastifyRequest, baseId: string, withVisible = false) {
    const { databaseId, scope } = await database(request, baseId);
    await scope.require(databaseId, 'read');
    const { pool, schemas } = dataStore(app.ctx);
    const tables = await loadTables(pool, schemas, databaseId);
    const ids = tables.map((t) => t.id);
    const [fields, views] = await Promise.all([
      loadFields(pool, schemas, ids),
      loadViews(pool, schemas, ids),
    ]);
    const resolved = await resolveSelectOptions(
      pool,
      schemas,
      scope,
      tables.flatMap((table) =>
        scope.visibleFields(
          table.id,
          fields.filter((field) => field.tableId === table.id),
        ),
      ),
    );
    return {
      databaseId,
      tables: tables.map((t) =>
        tableMeta(
          t,
          scope.visibleFields(
            t.id,
            resolved.filter((f) => f.tableId === t.id),
          ),
          views.filter((v) => v.tableId === t.id),
          withVisible,
        ),
      ),
    };
  }

  app.get('/v0/meta/bases/:baseId/tables', policy('schema.bases:read'), async (request) => {
    const { baseId } = z.object({ baseId: z.string() }).parse(request.params);
    const withVisible = listed(request.query, 'include').includes('visibleFieldIds');
    return { tables: (await metaTables(request, baseId, withVisible)).tables };
  });

  // Airtable's routes for changing a base's schema, as the REST API's schema writes, which run the
  // app's own commands.  The undo group goes in a header, since Airtable's bodies have no place for it.
  const schemaWrite = {
    ...policy('schema.bases:write'),
    // A schema change the app refuses as invalid is a request Airtable can't take, not a cell's value.
    errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
      if (!(error instanceof AppError) || error.code !== 'validation_failed')
        return airtableErrorHandler(error, request, reply);
      const text = message(error.messageKey);
      const refusal = invalidRequest(
        text === error.messageKey ? undefined : message('api.schema.invalidRequest', { detail: text }),
      );
      return reply.status(refusal.status).send(refusal.body());
    },
  };
  const MetaParams = z.object({ baseId: z.string(), tableIdOrName: z.string().min(1) });
  /** A table in the base by ID or name, as the meta API describes it */
  async function metaTable(request: FastifyRequest) {
    const { baseId, tableIdOrName } = MetaParams.parse(request.params);
    const { tables, databaseId } = await metaTables(request, baseId);
    const found = tables.find((t) => t.id === tableIdOrName) ?? tables.find((t) => t.name === tableIdOrName);
    if (!found) throw modelNotFound();
    return { table: found, databaseId, baseId };
  }
  const undoable = (reply: FastifyReply, undoGroupId: string) => reply.header('x-undo-group-id', undoGroupId);

  app.post('/v0/meta/bases/:baseId/tables', schemaWrite, async (request, reply) => {
    const { baseId } = z.object({ baseId: z.string() }).parse(request.params);
    const { databaseId } = await database(request, baseId);
    const body = bodyOf(request);
    const input = parse(SchemaTableCreate, {
      name: body.name,
      description: body.description,
      fields: Array.isArray(body.fields)
        ? body.fields
            .map((field) => fieldSpecFrom(field))
            .map((field) => ({ ...field, options: withChoices(field.options) }))
        : body.fields,
    });
    const created = await createTable(app, requireActor(request), databaseId, input);
    undoable(reply, created.undoGroupId);
    return (await metaTables(request, baseId)).tables.find((t) => t.id === created.table?.id) ?? null;
  });

  app.patch('/v0/meta/bases/:baseId/tables/:tableIdOrName', schemaWrite, async (request, reply) => {
    const { table, baseId } = await metaTable(request);
    const body = bodyOf(request);
    const input = parse(SchemaTableUpdate, { name: body.name, description: body.description });
    undoable(reply, (await updateTable(app, requireActor(request), table.id, input)).undoGroupId);
    return (await metaTables(request, baseId)).tables.find((t) => t.id === table.id) ?? null;
  });

  const fieldOf = async (request: FastifyRequest, fieldId: string) =>
    (await metaTable(request)).table.fields.find((f) => f.id === fieldId) ?? null;

  app.post('/v0/meta/bases/:baseId/tables/:tableIdOrName/fields', schemaWrite, async (request, reply) => {
    const { table } = await metaTable(request);
    const spec = fieldSpecFrom(bodyOf(request));
    const input = parse(SchemaFieldCreate, { ...spec, options: withChoices(spec.options) });
    const created = await createField(app, requireActor(request), table.id, input);
    undoable(reply, created.undoGroupId);
    return fieldOf(request, created.field?.id ?? '');
  });

  app.patch(
    '/v0/meta/bases/:baseId/tables/:tableIdOrName/fields/:columnId',
    schemaWrite,
    async (request, reply) => {
      const { columnId } = z.object({ columnId: z.string() }).parse(request.params);
      const { table } = await metaTable(request);
      if (!table.fields.some((f) => f.id === columnId)) throw modelNotFound();
      const body = bodyOf(request);
      if ('type' in body || 'options' in body)
        throw invalidRequest(message('api.schema.fieldPatchMetadataOnly'));
      const input = parse(SchemaFieldUpdate, { name: body.name, description: body.description });
      undoable(reply, (await updateField(app, requireActor(request), columnId, input)).undoGroupId);
      return fieldOf(request, columnId);
    },
  );

  const read = policy('data.records:read');
  const change = policy('data.records:write');
  // Airtable's own client adds a slash to the table's path when it writes.
  for (const url of ['/v0/:baseId/:tableIdOrName', '/v0/:baseId/:tableIdOrName/']) {
    app.get(url, read, async (request) => list(request, queryParams(request.query)));

    app.post(url, change, async (request, reply) => {
      const body = bodyOf(request);
      const options = writeOutput(request, body);
      const single = !('records' in body);
      const records = single ? [entry(body, false)] : entries(body.records, false);
      const access = await table(request, true);
      const groupId = newId('action');
      reply.header('x-undo-group-id', groupId);
      const ids = await saveRecords(app, access, groupId, {
        create: true,
        typecast: bool(body.typecast, 'typecast'),
        overrideAiFields: bool(body.overrideAiFields, 'overrideAiFields'),
        records: records.map((record) => ({ fields: record.fields })),
        field: (key) => writable(access, key),
        readOnly,
        addresses: true,
        typecastFields: sentAsText,
      });
      const result = await written(request, access.table.id, ids, options);
      return single ? result[0] : { records: result };
    });

    for (const method of ['PATCH', 'PUT'] as const)
      app.route({
        method,
        url,
        ...change,
        handler: async (request, reply) => {
          const body = bodyOf(request);
          const options = writeOutput(request, body);
          const upsert = body.performUpsert;
          let mergeOn: string[] | undefined;
          if (upsert !== undefined) {
            const parsed = z
              .object({ fieldsToMergeOn: z.array(z.string().min(1)).min(1).max(3) })
              .safeParse(upsert);
            if (!parsed.success)
              throw invalidRequest('performUpsert needs fieldsToMergeOn: from 1 to 3 field names or IDs');
            mergeOn = parsed.data.fieldsToMergeOn;
          }
          const records = entries(body.records, !mergeOn);
          const named = records.flatMap((record) => (record.id ? [record.id] : []));
          if (new Set(named).size !== named.length) throw invalidRecords('A record appears more than once');
          const typecast = bool(body.typecast, 'typecast');
          const access = await table(request, true);
          await present(access, named);
          const targets = mergeOn ? await merged(access, records, mergeOn, typecast) : records;
          const groupId = newId('action');
          reply.header('x-undo-group-id', groupId);
          const textMerges: TextMergeNotice[] = [];
          const ids = await saveRecords(app, access, groupId, {
            create: mergeOn ? 'withoutId' : false,
            replace: method === 'PUT',
            typecast,
            overrideAiFields: bool(body.overrideAiFields, 'overrideAiFields'),
            records: targets,
            onMerged: (notices) => textMerges.push(...notices),
            field: (key) => writable(access, key),
            readOnly,
            addresses: true,
            typecastFields: sentAsText,
          });
          const result = await written(request, access.table.id, ids, options);
          const notices = textMerges.length ? { textMerges } : {};
          if (!mergeOn) return { records: result, ...notices };
          return {
            records: result,
            ...notices,
            createdRecords: ids.filter((_id, index) => !targets[index]!.id),
            updatedRecords: ids.filter((_id, index) => targets[index]!.id),
          };
        },
      });

    app.delete(url, change, async (request, reply) => {
      const ids = [...new Set(listed(request.query, 'records'))];
      if (ids.length < 1 || ids.length > WRITE_LIMIT)
        throw invalidRecords(`A request can delete from 1 to ${WRITE_LIMIT} records`);
      const access = await table(request, true);
      await present(access, ids);
      const groupId = newId('action');
      reply.header('x-undo-group-id', groupId);
      await trashRecords(app, access, ids, groupId, async () => null);
      return { records: ids.map((id) => ({ id, deleted: true })) };
    });
  }

  app.post('/v0/:baseId/:tableIdOrName/listRecords', read, async (request) =>
    list(request, bodyParams(request.body, request.query)),
  );

  /** A record named in the path, which Airtable answers `NOT_FOUND` for when it isn't there. */
  async function one(request: FastifyRequest, write: boolean, timeZone?: string) {
    const { recordId } = RecordParams.parse(request.params);
    const access = await table(request, write);
    if (!RecordId.safeParse(recordId).success) throw notFound();
    const rows = await rowsById(access, [recordId], timeZone);
    if (!rows.length) throw notFound();
    return { access, recordId, rows };
  }

  app.get('/v0/:baseId/:tableIdOrName/:recordId', read, async (request) => {
    const params = queryParams(request.query);
    const { access, rows } = await one(request, false, params.timeZone);
    const [record] = await airtableRecords(access, access.fields, rows, output(request, params));
    return record;
  });

  for (const method of ['PATCH', 'PUT'] as const)
    app.route({
      method,
      url: '/v0/:baseId/:tableIdOrName/:recordId',
      ...change,
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const body = bodyOf(request);
        const options = writeOutput(request, body);
        const record = entry(body, false);
        const { access, recordId } = await one(request, true);
        const groupId = newId('action');
        reply.header('x-undo-group-id', groupId);
        const textMerges: TextMergeNotice[] = [];
        const ids = await saveRecords(app, access, groupId, {
          create: false,
          replace: method === 'PUT',
          typecast: bool(body.typecast, 'typecast'),
          overrideAiFields: bool(body.overrideAiFields, 'overrideAiFields'),
          records: [{ ...record, id: recordId }],
          onMerged: (notices) => textMerges.push(...notices),
          field: (key) => writable(access, key),
          readOnly,
          addresses: true,
          typecastFields: sentAsText,
        });
        const result = (await written(request, access.table.id, ids, options))[0];
        return { ...result, ...(textMerges.length ? { textMerges } : {}) };
      },
    });

  app.delete('/v0/:baseId/:tableIdOrName/:recordId', change, async (request, reply) => {
    const { access, recordId } = await one(request, true);
    const groupId = newId('action');
    reply.header('x-undo-group-id', groupId);
    await trashRecords(app, access, [recordId], groupId, async () => null);
    return { id: recordId, deleted: true };
  });
}

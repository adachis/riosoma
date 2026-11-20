import { runSourceCommand } from '../data/commands/sources.js';
import { checkNoSqlSource } from './nosql.js';
import { ownAppConnection, appConnectionContext } from './app-connections.js';
import { retargets } from './target.js';
import {
  AirtableBasesDraft,
  AppError,
  EndpointPreviewDraft,
  GraphQlSuggestionsDraft,
  EndpointPreviewSaved,
  PreviewRequest,
  SourceCreate,
  SourceCommand,
  isFileApiSource,
  SourceId,
  SourceUpdate,
  newId,
  requiredSecrets,
  type AirtableSourceBase,
  type SourceTestResult,
  type SourceSecrets,
} from '@riosoma/contracts';
import { ConnectorError, connectorFor, type GraphQlConnector } from '@riosoma/connectors';
import { compile, ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditEvent } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { dataStore } from '../data/context.js';
import { parse } from '../http/validate.js';
import { sealCredential } from '../credentials/service.js';
import { isAirtableConnector } from './airtable.js';
import { checkAnalyticsSource } from './analytics.js';
import { checkFeedAddress } from './feed.js';
import { checkFileAddress, checkFileHost } from './files.js';
import { withServiceAccount } from './google-sheets.js';
import { checkMongoSource } from './mongodb.js';
import { checkApiAddress, endpointPreview } from './rest.js';
import { newHookAddress } from './webhook.js';
import {
  checkSecrets,
  connectorCall,
  connectorContext,
  loadSource,
  requireSourceAccess,
  secretsFor,
  safeDetail,
  sourceAdmin,
  sourceMeta,
  sourceSignal,
  usableSecrets,
  type SourceRow,
} from './store.js';
import { administersSource, lockUnits, requirePerson, requireSource, unitAdmin } from '../org-units/store.js';

const Params = z.object({ sourceId: SourceId });

export async function sourceRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  const admin = {
    config: { policy: { kind: 'admin' as const, area: 'data_sources' as const, scope: 'source' as const } },
  };
  const key = app.ctx.config.secretKey;
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/api/sources', session, async (request) => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const everything = sourceAdmin(actor);
    const unit = unitAdmin(actor, 'data_sources');
    const rows = await query<SourceRow>(
      pool,
      sql`SELECT * FROM ${ident(schemas.app, 'sources')}
      WHERE org_id = ${actor.orgId} AND (${everything || unit} OR access = 'creators') ORDER BY name, id`,
    );
    // A unit's Data Sources admin also sees the admin-only sources their units' people made.
    const visible: SourceRow[] = [];
    for (const row of rows.rows)
      if (
        everything ||
        row.access === 'creators' ||
        (await administersSource(pool, `"${schemas.app}"`, actor, row.id))
      ) {
        if (isFileApiSource(row.kind)) {
          try {
            await requireSourceAccess(pool, schemas, actor, row);
          } catch (error) {
            if (error instanceof AppError && error.code === 'forbidden') continue;
            throw error;
          }
        }
        visible.push(row);
      }
    return Promise.all(visible.map((row) => sourceMeta(pool, schemas, row, actor, key)));
  });

  app.post('/api/source-commands', admin, async (request) =>
    runSourceCommand(app, requireActor(request), parse(SourceCommand, request.body)),
  );

  app.post('/api/sources', admin, async (request) => {
    const actor = requireActor(request);
    const input = parse(SourceCreate, request.body);
    if (isFileApiSource(input.connection.kind))
      return (await runSourceCommand(app, actor, { id: newId('command'), action: { kind: 'create', input } }))
        .source;
    checkFileAddress(input.connection, app.ctx.config);
    checkApiAddress(input.connection, app.ctx.config);
    checkFeedAddress(input.connection, app.ctx.config);
    checkMongoSource(input.connection, input.secrets, app.ctx.config);
    checkAnalyticsSource(input.connection, app.ctx.config);
    checkNoSqlSource(input.connection, app.ctx.config);
    checkSecrets(input.connection, input.secrets);
    input.connection = withServiceAccount(input.connection, input.secrets);
    const { pool, schemas } = dataStore(app.ctx);
    const id = newId('source');
    return withTransaction(pool, async (db) => {
      // A unit admin's new source is theirs, so they have to be placed inside their own units.
      await lockUnits(db, actor.orgId);
      await requirePerson(db, `"${schemas.app}"`, actor, actor.userId, 'data_sources');
      input.connection = await ownAppConnection(app.ctx, actor, input.connection, db);
      const result = await query<SourceRow>(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'sources')}
        (id, org_id, name, description, kind, connection, sealed_secrets, access, created_by)
        VALUES (${id}, ${actor.orgId}, ${input.name}, ${input.description}, ${input.connection.kind},
        ${JSON.stringify(input.connection)}::jsonb, ${await sealCredential(key, JSON.stringify(input.secrets), `source:${id}`, actor.orgId, db)}, ${input.access}, ${actor.userId}) RETURNING *`,
      );
      // A webhook's address is made with it, and this answer is the only one that shows it.
      const webhookPath =
        input.connection.kind === 'webhook'
          ? await newHookAddress(db, schemas, { id, orgId: actor.orgId })
          : undefined;
      await auditEvent(db, compile(sql`${ident(schemas.audit)}`).text, 'data.source.created', actor, {
        sourceId: id,
        kind: input.connection.kind,
      });
      const meta = await sourceMeta(db, schemas, result.rows[0]!, actor, key);
      return webhookPath ? { ...meta, webhookPath } : meta;
    });
  });

  app.patch('/api/sources/:sourceId', admin, async (request) => {
    const actor = requireActor(request);
    const { sourceId } = parse(Params, request.params);
    const input = parse(SourceUpdate, request.body);
    const { pool, schemas } = dataStore(app.ctx);
    const existing = await loadSource(pool, schemas, sourceId, actor.orgId);
    if (isFileApiSource(existing.kind))
      return (
        await runSourceCommand(app, actor, {
          id: newId('command'),
          action: { kind: 'update', sourceId, input },
        })
      ).source;
    if (input.connection && isFileApiSource(input.connection.kind))
      throw new AppError('validation_failed', 'sources.kindFixed');
    return withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      await requireSource(db, `"${schemas.app}"`, actor, sourceId);
      await query(
        db,
        sql`SELECT id FROM ${ident(schemas.app, 'sources')} WHERE id = ${sourceId} AND org_id = ${actor.orgId} FOR UPDATE`,
      );
      const before = await loadSource(db, schemas, sourceId, actor.orgId);
      let connection = input.connection ?? before.connection;
      // A webhook stays a webhook, since its address and its tables' columns belong to it.
      if ((connection.kind === 'webhook') !== (before.kind === 'webhook'))
        throw new AppError('validation_failed', 'sources.kindFixed');
      if (input.connection) {
        checkFileAddress(connection, app.ctx.config);
        checkApiAddress(connection, app.ctx.config);
        checkFeedAddress(connection, app.ctx.config);
        checkAnalyticsSource(connection, app.ctx.config);
        checkNoSqlSource(connection, app.ctx.config);
      }
      // Stored secrets never follow a source somewhere new: otherwise anyone who could change the
      // host could collect the password without ever seeing it.
      const retargeted = retargets(before.connection, connection);
      // A file's request headers are optional, so moving the address asks for them again, or for
      // their removal, instead of quietly sending the new address none.
      if (
        retargeted &&
        (before.kind === 'file-url' ||
          before.kind === 'feed' ||
          (before.kind === 'duckdb-file' &&
            connection.kind === 'duckdb-file' &&
            connection.storage === 'url')) &&
        (await secretsFor(before, key, db)).headers &&
        !(input.secrets && 'headers' in input.secrets)
      )
        throw new AppError('validation_failed', 'sources.secretsReenter');
      const secrets: SourceSecrets = retargeted ? {} : await secretsFor(before, key, db);
      for (const name of Object.keys(input.secrets ?? {}) as Array<keyof typeof secrets>) {
        const value = input.secrets![name];
        if (value === null) delete secrets[name];
        else if (value !== undefined) secrets[name] = value;
      }
      if (retargeted && requiredSecrets(connection).some((name) => !secrets[name]))
        throw new AppError('validation_failed', 'sources.secretsReenter');
      // A MongoDB source's address can be in its secrets, so it's checked once they're settled.
      checkMongoSource(connection, secrets, app.ctx.config);
      checkSecrets(connection, secrets);
      // A service account's address follows its key, whichever of the two changed.
      connection = withServiceAccount(connection, secrets);
      connection = await ownAppConnection(app.ctx, actor, connection, db);
      // Validators and document cursors belong to their original connection and credentials.
      // A changed connection requires a complete snapshot and invalidates any held delta.
      if (
        (before.connection.kind === 'couchdb' &&
          (JSON.stringify(before.connection) !== JSON.stringify(connection) ||
            JSON.stringify(await secretsFor(before, key, db)) !== JSON.stringify(secrets))) ||
        (before.connection.kind === 'feed' &&
          (connection.kind !== 'feed' ||
            connection.url !== before.connection.url ||
            ((await secretsFor(before, key, db)).headers ?? '') !== (secrets.headers ?? '')))
      )
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'table_sources')} SET fetch_state = NULL,
            status = CASE WHEN held_token IS NOT NULL THEN status || jsonb_build_object('state', 'queued', 'held', NULL, 'nextSyncAt', now()) ELSE status END,
            next_sync_at = CASE WHEN held_token IS NOT NULL THEN now() ELSE next_sync_at END,
            held_token = NULL, confirm_removals = false
            WHERE source_id = ${sourceId}`,
        );
      const result = await query<SourceRow>(
        db,
        sql`UPDATE ${ident(schemas.app, 'sources')}
        SET name = ${input.name ?? before.name}, description = ${input.description ?? before.description},
        kind = ${connection.kind}, connection = ${JSON.stringify(connection)}::jsonb,
        sealed_secrets = ${await sealCredential(key, JSON.stringify(secrets), `source:${sourceId}`, actor.orgId, db)},
        access = ${input.access ?? before.access}, updated_at = now() WHERE id = ${sourceId} RETURNING *`,
      );
      await auditEvent(db, compile(sql`${ident(schemas.audit)}`).text, 'data.source.updated', actor, {
        sourceId,
        kind: connection.kind,
      });
      return sourceMeta(db, schemas, result.rows[0]!, actor, key);
    });
  });

  app.delete('/api/sources/:sourceId', admin, async (request, reply) => {
    const actor = requireActor(request);
    const { sourceId } = parse(Params, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    const existing = await loadSource(pool, schemas, sourceId, actor.orgId);
    if (isFileApiSource(existing.kind))
      return runSourceCommand(app, actor, { id: newId('command'), action: { kind: 'delete', sourceId } });
    await withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      await requireSource(db, `"${schemas.app}"`, actor, sourceId);
      await query(
        db,
        sql`SELECT id FROM ${ident(schemas.app, 'sources')} WHERE id = ${sourceId} AND org_id = ${actor.orgId} FOR UPDATE`,
      );
      await loadSource(db, schemas, sourceId, actor.orgId);
      const used = await query(
        db,
        sql`SELECT table_id FROM ${ident(schemas.app, 'table_sources')} WHERE source_id = ${sourceId} LIMIT 1`,
      );
      if (used.rowCount) throw new AppError('conflict', 'sources.inUse');
      await query(db, sql`DELETE FROM ${ident(schemas.app, 'sources')} WHERE id = ${sourceId}`);
      await auditEvent(db, compile(sql`${ident(schemas.audit)}`).text, 'data.source.deleted', actor, {
        sourceId,
      });
    });
    return reply.code(204).send();
  });

  app.post('/api/sources/test', admin, async (request): Promise<SourceTestResult> => {
    const input = parse(SourceCreate, request.body);
    checkFileAddress(input.connection, app.ctx.config);
    await checkFileHost(input.connection, app.ctx.config);
    checkApiAddress(input.connection, app.ctx.config);
    checkFeedAddress(input.connection, app.ctx.config);
    checkMongoSource(input.connection, input.secrets, app.ctx.config);
    checkAnalyticsSource(input.connection, app.ctx.config);
    checkNoSqlSource(input.connection, app.ctx.config);
    checkSecrets(input.connection, input.secrets);
    withServiceAccount(input.connection, input.secrets);
    const actor = requireActor(request);
    input.connection = await ownAppConnection(app.ctx, actor, input.connection);
    const context = await connectorCall(() =>
      appConnectionContext(app.ctx, actor.orgId, {
        connection: input.connection,
        secrets: input.secrets,
        signal: sourceSignal(input.connection),
        timeoutMs: 30_000,
      }),
    );
    return test(() => connectorFor(input.connection.kind).test(context), context.secrets);
  });

  app.post('/api/sources/:sourceId/test', admin, async (request, reply) => {
    const actor = requireActor(request);
    const { sourceId } = parse(Params, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    const source = await loadSource(pool, schemas, sourceId, actor.orgId);
    await requireSourceAccess(pool, schemas, actor, source);
    const context = await connectorContext(source, key, undefined, undefined, app.ctx);
    const result = await test(() => connectorFor(source.kind).test(context), context.secrets);
    if (isFileApiSource(source.kind)) {
      const recorded = await runSourceCommand(
        app,
        actor,
        { id: newId('command'), action: { kind: 'update', sourceId, input: {} } },
        {
          sourceId,
          updatedAt: source.updated_at.toISOString(),
          lastTest: { at: new Date().toISOString(), ok: result.ok },
        },
      );
      reply.header('x-source-command-id', recorded.id);
      return result;
    }
    await query(
      pool,
      sql`UPDATE ${ident(schemas.app, 'sources')} SET last_test = ${JSON.stringify({ at: new Date().toISOString(), ok: result.ok })}::jsonb WHERE id = ${sourceId}`,
    );
    return result;
  });

  // An API endpoint's first page while it's set up, before its source is saved.
  app.post('/api/sources/graphql-suggestions', admin, async (request) => {
    const input = parse(GraphQlSuggestionsDraft, request.body);
    checkApiAddress(input.connection, app.ctx.config);
    checkSecrets(input.connection, input.secrets);
    return connectorCall(() =>
      (connectorFor('graphql') as GraphQlConnector).suggest({
        ...input,
        signal: AbortSignal.timeout(30_000),
        timeoutMs: 30_000,
      }),
    );
  });

  app.post('/api/sources/:sourceId/graphql-suggestions', admin, async (request) => {
    const actor = requireActor(request);
    const { sourceId } = parse(Params, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    const source = await loadSource(pool, schemas, sourceId, actor.orgId);
    await requireSourceAccess(pool, schemas, actor, source);
    if (source.kind !== 'graphql') throw new AppError('validation_failed', 'errors.validationFailed');
    const context = await connectorContext(source, key, undefined, undefined, app.ctx);
    return connectorCall(() => (connectorFor('graphql') as GraphQlConnector).suggest(context));
  });

  app.post('/api/sources/endpoint-preview', admin, async (request) => {
    const input = parse(EndpointPreviewDraft, request.body);
    const connection = { ...input.connection, endpoints: [input.endpoint] };
    checkApiAddress(connection, app.ctx.config);
    checkSecrets(connection, input.secrets);
    return endpointPreview(
      { connection, secrets: input.secrets, signal: AbortSignal.timeout(30_000), timeoutMs: 30_000 },
      input.endpoint,
    );
  });

  // The same for a saved source, whose stored address, sign-in, and secrets are the ones used.
  app.post('/api/sources/:sourceId/endpoint-preview', admin, async (request) => {
    const actor = requireActor(request);
    const { sourceId } = parse(Params, request.params);
    const { endpoint } = parse(EndpointPreviewSaved, request.body);
    const { pool, schemas } = dataStore(app.ctx);
    const source = await loadSource(pool, schemas, sourceId, actor.orgId);
    if (source.connection.kind !== 'rest') throw new AppError('validation_failed', 'errors.validationFailed');
    const context = await connectorContext(source, key, undefined, undefined, app.ctx);
    return endpointPreview(
      { ...context, connection: { ...source.connection, endpoints: [endpoint] } },
      endpoint,
    );
  });

  // The bases an Airtable token sees, for choosing a source's bases before it's saved.  The token
  // only ever goes to Airtable, so a typed one may be tried whatever the source stores.
  app.post('/api/sources/airtable-bases', admin, async (request): Promise<AirtableSourceBase[]> => {
    const { token } = parse(AirtableBasesDraft, request.body);
    return airtableBases(token);
  });

  // The same for a saved source, with its stored token, which never comes back to the browser.
  app.post('/api/sources/:sourceId/airtable-bases', admin, async (request) => {
    const actor = requireActor(request);
    const { sourceId } = parse(Params, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    const source = await loadSource(pool, schemas, sourceId, actor.orgId);
    if (source.connection.kind !== 'airtable')
      throw new AppError('validation_failed', 'errors.validationFailed');
    const { token } = await usableSecrets(source, key);
    if (!token) throw new AppError('validation_failed', 'sources.secretsMissing');
    return airtableBases(token);
  });

  app.get('/api/sources/:sourceId/objects', session, async (request) => {
    const actor = requireActor(request);
    const { sourceId } = parse(Params, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    const source = await loadSource(pool, schemas, sourceId, actor.orgId);
    await requireSourceAccess(pool, schemas, actor, source);
    return connectorCall(async () =>
      connectorFor(source.kind).listObjects(
        await connectorContext(source, key, undefined, undefined, app.ctx),
      ),
    );
  });

  app.post('/api/sources/:sourceId/preview', session, async (request) => {
    const actor = requireActor(request);
    const { sourceId } = parse(Params, request.params);
    const { select } = parse(PreviewRequest, request.body);
    const { pool, schemas } = dataStore(app.ctx);
    const source = await loadSource(pool, schemas, sourceId, actor.orgId);
    await requireSourceAccess(pool, schemas, actor, source, select);
    return connectorCall(async () => {
      const connector = connectorFor(source.kind);
      const context = await connectorContext(source, key, undefined, undefined, app.ctx);
      const preview = await connector.preview(context, select, 100);
      const keyCandidates =
        select.kind === 'object' ? await connector.keyCandidates(context, select.object) : [];
      return { ...preview, keyCandidates };
    });
  });
}

function airtableBases(token: string): Promise<AirtableSourceBase[]> {
  return connectorCall(async () => {
    const connector = connectorFor('airtable');
    if (!isAirtableConnector(connector)) throw new ConnectorError('sources.kindUnavailable');
    return connector.bases(token, AbortSignal.timeout(30_000), 30_000);
  });
}

async function test(
  work: () => Promise<SourceTestResult>,
  secrets: SourceSecrets,
): Promise<SourceTestResult> {
  try {
    const result = await connectorCall(work);
    return {
      ok: result.ok,
      steps: result.steps.map(({ detail, ...step }) => {
        const safe = safeDetail(detail, secrets);
        return { ...step, ...(safe ? { detail: safe } : {}) };
      }),
      ...(safeDetail(result.serverVersion, secrets) ? { serverVersion: result.serverVersion } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      steps: [
        {
          step: 'connect',
          status: 'failed',
          ms: null,
          messageKey: error instanceof AppError ? error.messageKey : 'sources.sync.timeout',
        },
      ],
    };
  }
}

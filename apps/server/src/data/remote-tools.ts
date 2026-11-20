import { refuseDemo } from '../demo/boundary.js';
import { seal, unseal } from '../secrets.js';
import { allowsPrivate, checkedUrl } from '../webhooks/url.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  AppError,
  RemoteCall,
  RemoteServerCommand,
  type RemoteServer,
  type RemoteServerConfig,
  type RemoteTool,
  type RemoteApproval,
} from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { ToolSpec } from '@riosoma/ai';
import type { FastifyInstance } from 'fastify';
import {
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { RemoteSchemaValidator } from '../mcp-client/schema.js';
import { auditEvent } from '../auth/database.js';
import { sealCredential, unsealCredential } from '../credentials/service.js';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import {
  REMOTE_TOKEN_TIMEOUT_MS,
  RemoteClients,
  remoteName,
  type RemoteAuthProvider,
} from '../mcp-client/client.js';
import { guardedFetch } from '../mcp-client/fetch.js';
import { checkedAddress } from './imports/download.js';
import { systemResolve } from '../automations/outbound.js';
import { settingsFor } from '../ai/settings.js';
import { AccessScope } from './access.js';
import { dataStore } from './context.js';
import { readKnowledgeSettings } from './knowledge.js';
import { runStored } from './commands/transaction.js';
import type { CommandContext } from './commands/context.js';

export interface ServerRow {
  id: string;
  org_id: string;
  user_id: string | null;
  config: RemoteServerConfig;
  tools: RemoteTool[];
  skipped_tools?: { name: string; reason: string }[];
  sealed: string | null;
  revision: number;
  refreshed_at: Date | null;
  error_key: string | null;
}
interface Credentials {
  secret?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  redirect?: string;
  verifier?: string;
  state?: string;
  person?: string;
  expires?: number;
  authorizationCommand?: string;
  authorizationUrl?: string;
}
interface CallRow {
  id: string;
  server_id: string;
  conversation_id: string | null;
  tool: string;
  revision: number;
  sealed: string;
  status: RemoteApproval['status'];
  result: string | null;
  expires_at: Date;
}
const missing = () => new AppError('not_found', 'errors.notFound');
const conflict = () => new AppError('conflict', 'errors.conflict');
const unavailable = () => new AppError('unavailable', 'remote.unavailable');
const dto = (row: ServerRow): RemoteServer => ({
  id: row.id,
  config: row.config,
  tools: row.tools,
  revision: row.revision,
  refreshedAt: row.refreshed_at?.toISOString() ?? null,
  errorKey: row.error_key,
  hasCredential: !!row.sealed,
  skippedTools: row.skipped_tools ?? [],
});
/** Waits for an earlier turn, or stops waiting when the signal aborts. */
function waitFor(turn: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return turn;
  return new Promise<void>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    void turn.then(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    });
  });
}
/** A wait for another instance's token refresh ran out before its lock was free. */
class RefreshWaitExpired extends Error {}
/** Another instance holds the token lock, so try again shortly. */
const NOT_YET = Symbol('not yet');
const stores = new WeakMap<object, RemoteTools>();
export function remoteTools(app: FastifyInstance): RemoteTools {
  let store = stores.get(app.ctx);
  if (!store) {
    store = new RemoteTools(app);
    stores.set(app.ctx, store);
  }
  return store;
}

export class RemoteTools {
  readonly clients: RemoteClients;
  private readonly queues = new Map<string, Promise<void>>();
  /** How long a call waits for another instance's token refresh, longer than one token request */
  private readonly refreshWaitMs: number;
  constructor(
    private readonly app: FastifyInstance,
    options: { refreshWaitMs?: number } = {},
  ) {
    this.clients = new RemoteClients(15000, 30000, app.ctx.config);
    this.refreshWaitMs = options.refreshWaitMs ?? REMOTE_TOKEN_TIMEOUT_MS + 4000;
  }
  /** Runs work after earlier work with the same key in this process. */
  private async serialized<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    // The next turn waits for this one and every earlier one, even when this waiter stops early.
    const tail = previous.then(() => done);
    this.queues.set(key, tail);
    // The entry goes only when its whole line has finished, so a waiter that stops early never
    // lets a later caller skip ahead of work still running.
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    try {
      await waitFor(previous, signal);
      return await work();
    } finally {
      release();
    }
  }
  private fetch(row: ServerRow) {
    return guardedFetch(
      row.config.allowPrivate,
      AbortSignal.timeout(15000),
      undefined,
      this.app.ctx.config,
      true,
    );
  }
  private checkAddress(config: RemoteServerConfig, before?: RemoteServerConfig | null) {
    try {
      checkedUrl(config.address, this.app.ctx.config);
      // Every request still checks the operator's rules, so a switch saved earlier stays editable.
      // Only turning it on needs the operator's permission now.
      if (config.allowPrivate && !before?.allowPrivate && !allowsPrivate(config.address, this.app.ctx.config))
        throw unavailable();
      if (config.auth !== 'none' && new URL(config.address).protocol !== 'https:') throw unavailable();
    } catch {
      throw new AppError('forbidden', 'remote.blockedAddress');
    }
  }
  private get data() {
    return dataStore(this.app.ctx);
  }
  private async row(
    actor: Actor,
    id: string,
    admin = false,
    db: Queryable = this.data.pool,
  ): Promise<ServerRow> {
    const scope = new AccessScope(db, this.data.schemas, actor);
    if (admin) await scope.requireOrganizationAdmin('ai');
    else await scope.requireOrganization();
    const result = await query<ServerRow>(
      db,
      sql`SELECT * FROM ${ident(this.data.schemas.app, 'remote_servers')} WHERE id = ${id} AND org_id = ${actor.orgId}`,
    );
    const row = result.rows[0];
    if (!row || (!admin && !(await scope.remoteTools(row.config.audience)))) throw missing();
    return row;
  }
  async list(actor: Actor, admin = false): Promise<RemoteServer[]> {
    const { pool, schemas } = this.data;
    const scope = new AccessScope(pool, schemas, actor);
    if (admin) await scope.requireOrganizationAdmin('ai');
    else await scope.requireOrganization();
    const rows = await query<ServerRow>(
      pool,
      sql`SELECT * FROM ${ident(schemas.app, 'remote_servers')} WHERE org_id = ${actor.orgId} ORDER BY config->>'name', id`,
    );
    const visible: RemoteServer[] = [];
    for (const row of rows.rows)
      if (admin || (await scope.remoteTools(row.config.audience))) visible.push(dto(row));
    return visible;
  }
  async audienceChoices(actor: Actor) {
    const { pool, schemas } = this.data;
    await new AccessScope(pool, schemas, actor).requireOrganizationAdmin('ai');
    const groups = await query<{ id: string; name: string }>(
      pool,
      sql`SELECT id, name FROM ${ident(schemas.app, 'groups')} WHERE org_id = ${actor.orgId} ORDER BY name`,
    );
    const units = await query<{ id: string; name: string }>(
      pool,
      sql`SELECT id, name FROM ${ident(schemas.app, 'org_units')} WHERE org_id = ${actor.orgId} ORDER BY name`,
    );
    return {
      groups: groups.rows,
      units: units.rows,
      privateHostsAllowed: this.app.ctx.config.automationsAllowPrivateHosts,
      localDevelopment: !this.app.ctx.config.production,
    };
  }
  async catalog(actor: Actor) {
    return (await this.list(actor))
      .map((server) => ({
        id: server.id,
        name: server.config.name,
        tools: server.tools.filter((tool) => server.config.enabledTools.includes(tool.name)),
      }))
      .filter((server) => server.tools.length > 0);
  }
  /**
   * The connected tools Rio may offer in a conversation.  `withheld` says the person could use
   * some, but the data rules keep them out, so Rio's panel can say why.
   */
  async offer(
    actor: Actor,
    conversationId: string | null = null,
  ): Promise<{ tools: ToolSpec[]; withheld: boolean }> {
    let available: ToolSpec[] = [];
    try {
      available = (await this.list(actor)).flatMap((server) =>
        server.tools
          .filter((tool) => server.config.enabledTools.includes(tool.name))
          .map((tool) => ({
            name: remoteName(server.id, server.config.name, tool.name),
            description: JSON.stringify({
              server: server.config.name,
              tool: tool.name,
              description: tool.description,
              untrusted: true,
            }),
            parameters: tool.inputSchema,
          })),
      );
      if (!available.length) return { tools: [], withheld: false };
      await this.dataAllowed(actor, conversationId);
    } catch (error) {
      if (error instanceof AppError && ['forbidden', 'not_found'].includes(error.code))
        return { tools: [], withheld: available.length > 0 };
      throw error;
    }
    return { tools: available, withheld: false };
  }
  async specs(actor: Actor, conversationId: string | null = null) {
    return (await this.offer(actor, conversationId)).tools;
  }
  async named(actor: Actor, name: string) {
    for (const server of await this.list(actor))
      for (const tool of server.tools)
        if (
          server.config.enabledTools.includes(tool.name) &&
          remoteName(server.id, server.config.name, tool.name) === name
        )
          return { serverId: server.id, tool: tool.name };
    return null;
  }
  /** Scheduled work passes only `{ orgId }`, since no person acted. */
  private async audit(
    db: Queryable,
    identity: Actor | { orgId: string },
    event: string,
    details: Record<string, unknown>,
  ) {
    await auditEvent(db, compile(sql`${ident(this.data.schemas.audit)}`).text, event, identity, details);
  }
  private async bus<T>(
    actor: Actor,
    id: string,
    _key: string,
    work: (c: CommandContext) => Promise<T>,
    replay?: () => T,
    transaction?: Queryable,
  ): Promise<T> {
    const result = await runStored<{
      status: 'applied' | 'duplicate' | 'rejected';
      value?: T;
      error?: ReturnType<AppError['toBody']>['error'];
    }>(
      this.app,
      actor,
      '',
      {
        commandId: id,
        groupId: id,
        lockKey: `remote:${actor.orgId}`,
        ...(transaction ? { transaction } : {}),
        duplicate: (previous) => ({
          value: replay ? replay() : (previous as { value: T }).value,
          error: (previous as { error?: ReturnType<AppError['toBody']>['error'] }).error,
          status: 'duplicate',
        }),
        rejected: (error) => ({ status: 'rejected', error: error.toBody().error }),
      },
      async (c) => ({ status: 'applied', value: await work(c) }),
    );
    if (result.error) throw new AppError(result.error.code, result.error.messageKey);
    return result.value as T;
  }
  private async broadcast(c: CommandContext, serverId: string) {
    await this.notify(c.db, c.actor.orgId, serverId);
  }
  private async notify(db: Queryable, orgId: string, serverId: string) {
    await query(
      db,
      sql`SELECT pg_notify(${`${this.data.schemas.app}_remote`.slice(0, 63)}, ${JSON.stringify({ orgId, serverId })})`,
    );
  }
  private async credentials(row: ServerRow, db?: Queryable): Promise<Credentials> {
    return row.sealed
      ? (JSON.parse(
          await unsealCredential(
            this.app.ctx.config.secretKey,
            row.sealed,
            `remote:${row.id}`,
            row.org_id,
            db,
          ),
        ) as Credentials)
      : {};
  }
  private async persistCredentials(actor: Actor, row: ServerRow, value: Credentials, admin: boolean) {
    const sealed = await sealCredential(
      this.app.ctx.config.secretKey,
      JSON.stringify(value),
      `remote:${row.id}`,
      actor.orgId,
    );
    await this.bus(actor, randomUUID(), row.id, async (c) => {
      const current = await this.row(actor, row.id, admin, c.db);
      if (current.revision !== row.revision || current.sealed !== row.sealed) throw conflict();
      await query(
        c.db,
        sql`UPDATE ${ident(c.schemas.app, 'remote_servers')} SET sealed = ${sealed} WHERE id = ${row.id}`,
      );
      await this.audit(c.db, actor, 'remote.credentials', { serverId: row.id });
    });
    row.sealed = sealed;
  }
  private async oauth(
    actor: Actor | null,
    row: ServerRow,
    interactive = false,
    admin = interactive,
  ): Promise<RemoteAuthProvider & { destination?: string }> {
    const value = await this.credentials(row);
    // Calls and refreshes save only rotated tokens, through refreshGrant.  Everything else needs an
    // admin to authorize the connection again.
    const save = () => {
      if (!interactive || !actor) throw unavailable();
      return this.persistCredentials(actor, row, value, admin);
    };
    const provider: RemoteAuthProvider & { destination?: string } = {
      redirectUrl: value.redirect,
      clientMetadata: {
        client_name: 'Riosoma',
        redirect_uris: value.redirect ? [value.redirect] : [],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: value.client?.client_secret ? 'client_secret_post' : 'none',
      },
      state: () => value.state ?? '',
      clientInformation: () => value.client,
      // Without this, the SDK stops before it would register a client nobody can save.
      ...(interactive
        ? {
            saveClientInformation: async (client: OAuthClientInformationMixed) => {
              value.client = client;
              await save();
            },
          }
        : {}),
      tokens: () => value.tokens,
      saveTokens: async (tokens) => {
        value.tokens = tokens;
        if (interactive) await save();
      },
      refreshGrant: async (refreshToken, send, signal) => {
        const seen = value.tokens?.access_token;
        const tokens = await this.rotateTokens(actor, row, { refreshToken, seen }, send, signal);
        if (tokens instanceof Response) return tokens;
        value.tokens = tokens;
        return Response.json(tokens);
      },
      saveCodeVerifier: async (verifier) => {
        if (!interactive) throw new AppError('forbidden', 'remote.authorizationExpired');
        value.verifier = verifier;
        await save();
      },
      codeVerifier: () => {
        if (!value.verifier) throw conflict();
        return value.verifier;
      },
      redirectToAuthorization: async (url) => {
        if (!interactive) throw new AppError('forbidden', 'remote.authorizationExpired');
        if (url.protocol !== 'https:' || url.username || url.password) throw unavailable();
        try {
          await checkedAddress(url, {
            resolve: systemResolve,
            allowPrivate: () => row.config.allowPrivate && allowsPrivate(url.href, this.app.ctx.config),
          });
        } catch {
          throw new AppError('forbidden', 'remote.blockedAddress');
        }
        provider.destination = url.href;
        value.authorizationUrl = url.href;
        await save();
      },
      invalidateCredentials: async (scope) => {
        if (!interactive) throw new AppError('forbidden', 'remote.authorizationExpired');
        if (scope === 'tokens' || scope === 'all') delete value.tokens;
        if (scope === 'client' || scope === 'all') delete value.client;
        if (scope === 'verifier' || scope === 'all') delete value.verifier;
        await save();
      },
    };
    return provider;
  }
  /**
   * Reads, refreshes, and saves a server's OAuth tokens as one step, so a rotating refresh token is
   * spent once even when calls on several instances find an expired access token together.  Tool
   * calls themselves still run side by side.  `signal` stops only the wait for the lock.  Once the
   * lock is held, the refresh runs to the end, since the server may already have spent the token.
   */
  private async rotateTokens(
    actor: Actor | null,
    row: ServerRow,
    held: { refreshToken: string; seen?: string },
    send: () => Promise<Response>,
    signal: AbortSignal,
  ): Promise<OAuthTokens | Response> {
    const used = held.refreshToken;
    const { pool, schemas } = this.data;
    // Another call already refreshed when the stored tokens differ from the ones this call holds.
    const refreshedElsewhere = (stored: Credentials) =>
      stored.tokens?.refresh_token !== used ||
      (held.seen !== undefined && stored.tokens.access_token !== held.seen);
    const key = `${schemas.app}:remote-oauth:${row.id}`;
    try {
      return await this.serialized(
        `oauth:${row.id}`,
        async () => {
          const deadline = Date.now() + this.refreshWaitMs;
          for (;;) {
            // Each attempt is its own short transaction, so a waiter holds no connection between tries.
            const outcome = await withTransaction(
              pool,
              async (db): Promise<OAuthTokens | Response | typeof NOT_YET> => {
                if (!(await this.tryLock(db, key))) return NOT_YET;
                const current = await this.oauthRow(db, row);
                const stored = await this.credentials(current, db);
                if (refreshedElsewhere(stored)) {
                  if (!stored.tokens) throw unavailable();
                  return stored.tokens;
                }
                const response = await send();
                if (!response.ok) return response;
                const tokens: OAuthTokens = {
                  refresh_token: used,
                  ...OAuthTokensSchema.parse(await response.json()),
                };
                const write = (target: Queryable, identity: Actor | { orgId: string }) =>
                  this.saveRotated(target, identity, current, stored, used, tokens);
                if (actor)
                  await this.bus(actor, randomUUID(), current.id, (c) => write(c.db, actor), undefined, db);
                else {
                  // The same organization lock the command bus takes, after the token lock as there.
                  await query(
                    db,
                    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:remote:${current.org_id}`}, 0))`,
                  );
                  await write(db, { orgId: current.org_id });
                }
                return tokens;
              },
            );
            if (outcome !== NOT_YET) return outcome;
            signal.throwIfAborted();
            if (Date.now() >= deadline) throw new RefreshWaitExpired();
            await pause(100, undefined, { signal });
          }
        },
        signal,
      );
    } catch (error) {
      if (!(error instanceof RefreshWaitExpired)) throw error;
      // The other refresh may have finished just as the wait ran out, so look once more.
      const stored = await this.credentials(await this.oauthRow(pool, row), pool);
      if (refreshedElsewhere(stored) && stored.tokens) return stored.tokens;
      throw unavailable();
    }
  }
  private async tryLock(db: Queryable, key: string) {
    const attempt = await query<{ locked: boolean }>(
      db,
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`,
    );
    return attempt.rows[0]!.locked;
  }
  private async oauthRow(db: Queryable, row: ServerRow): Promise<ServerRow> {
    const found = await query<ServerRow>(
      db,
      sql`SELECT * FROM ${ident(this.data.schemas.app, 'remote_servers')} WHERE id = ${row.id} AND org_id = ${row.org_id}`,
    );
    const current = found.rows[0];
    // Tokens for another address must never reach the server this call connected to.
    if (!current || current.config.auth !== 'oauth' || current.config.address !== row.config.address)
      throw unavailable();
    return current;
  }
  /**
   * Saves rotated tokens over the row read under the lock.  When something else rewrote the row
   * meanwhile, such as a key rotation rewrapping it, the new tokens merge into the current
   * credentials as long as they still hold the refresh token this request spent.
   */
  private async saveRotated(
    db: Queryable,
    identity: Actor | { orgId: string },
    current: ServerRow,
    stored: Credentials,
    used: string,
    tokens: OAuthTokens,
  ) {
    let target = current;
    let credentials = stored;
    for (let attempt = 0; ; attempt++) {
      const sealed = await sealCredential(
        this.app.ctx.config.secretKey,
        JSON.stringify({ ...credentials, tokens }),
        `remote:${target.id}`,
        target.org_id,
        db,
      );
      const updated = await query(
        db,
        sql`UPDATE ${ident(this.data.schemas.app, 'remote_servers')} SET sealed = ${sealed} WHERE id = ${target.id} AND org_id = ${target.org_id} AND sealed IS NOT DISTINCT FROM ${target.sealed}`,
      );
      if (updated.rowCount) break;
      if (attempt >= 3) throw conflict();
      target = await this.oauthRow(db, target);
      credentials = await this.credentials(target, db);
      // Another writer, such as an admin authorizing again, replaced the tokens, so theirs stand.
      if (credentials.tokens?.refresh_token !== used) throw conflict();
    }
    await this.audit(db, identity, 'remote.credentials', { serverId: current.id, refreshed: true });
  }
  async authorize(actor: Actor, serverId: string, redirect: string, commandId: string = randomUUID()) {
    const row = await this.row(actor, serverId, true);
    if (row.config.auth !== 'oauth') throw conflict();
    const value = await this.credentials(row);
    if (value.authorizationCommand === commandId) {
      if (
        value.person !== actor.userId ||
        !value.authorizationUrl ||
        !value.expires ||
        value.expires <= Date.now()
      )
        throw conflict();
      return { url: value.authorizationUrl };
    }
    delete value.authorizationUrl;
    Object.assign(value, {
      authorizationCommand: commandId,
      redirect,
      state: randomUUID(),
      person: actor.userId,
      expires: Date.now() + 600000,
    });
    delete value.tokens;
    await this.persistCredentials(actor, row, value, true);
    const provider = await this.oauth(actor, row, true);
    try {
      await auth(provider, {
        serverUrl: row.config.address,
        fetchFn: this.fetch(row),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
    if (!provider.destination) throw unavailable();
    return { url: provider.destination };
  }
  async finishAuthorization(actor: Actor, serverId: string, state: string, code: string | null) {
    let row = await this.row(actor, serverId, true);
    const value = await this.credentials(row);
    if (
      value.state !== state ||
      value.person !== actor.userId ||
      !value.expires ||
      value.expires <= Date.now()
    )
      throw conflict();
    // Consume state before exchanging the code so a callback cannot replay it.
    delete value.state;
    if (code === null) {
      delete value.verifier;
      delete value.person;
      delete value.expires;
      delete value.authorizationUrl;
      await this.persistCredentials(actor, row, value, true);
      return;
    }
    await this.persistCredentials(actor, row, value, true);
    const provider = await this.oauth(actor, row, true);
    try {
      await auth(provider, {
        serverUrl: row.config.address,
        authorizationCode: code,
        fetchFn: this.fetch(row),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
    row = await this.row(actor, serverId, true);
    const saved = await this.credentials(row);
    delete saved.verifier;
    delete saved.person;
    delete saved.expires;
    delete saved.authorizationUrl;
    await this.persistCredentials(actor, row, saved, true);
    return this.refresh(actor, serverId);
  }
  async command(actor: Actor, input: unknown) {
    refuseDemo(actor);
    const command = parse(RemoteServerCommand, input);
    if (command.kind === 'remote.refresh') return this.refresh(actor, command.serverId, command.id);
    if (command.kind === 'remote.authorize') throw conflict();
    return this.bus(actor, command.id, 'settings', async (c) => {
      await new AccessScope(c.db, c.schemas, actor).requireOrganizationAdmin('ai');
      let id: string;
      let before: ServerRow | null;
      let after: ServerRow | null;
      if (command.kind === 'remote.undo') {
        const actions = await query<{
          server_id: string;
          before: ServerRow | null;
          after: ServerRow | null;
          undone: boolean;
        }>(
          c.db,
          sql`SELECT * FROM ${ident(c.schemas.app, 'remote_actions')} WHERE id = ${command.actionId} AND org_id = ${actor.orgId} AND user_id = ${actor.userId} AND created_at > now() - interval '30 days'`,
        );
        const action = actions.rows[0];
        if (!action || action.undone) throw missing();
        id = action.server_id;
        // The row lock makes a token save or a key rewrap either finish first or wait for this one.
        const current = await query<ServerRow>(
          c.db,
          sql`SELECT * FROM ${ident(c.schemas.app, 'remote_servers')} WHERE id = ${id} AND org_id = ${actor.orgId} FOR UPDATE`,
        );
        before = current.rows[0] ?? null;
        if ((before?.revision ?? null) !== (action.after?.revision ?? null)) throw conflict();
        // Tokens rotate after a change, so undo restores credentials only when the change replaced them.
        const replacedCredentials = (action.before?.sealed ?? null) !== (action.after?.sealed ?? null);
        after = action.before
          ? {
              ...action.before,
              sealed: replacedCredentials || !before ? (action.before.sealed ?? null) : before.sealed,
              user_id: actor.userId,
              revision: (before?.revision ?? action.before.revision) + 1,
              refreshed_at: null,
              tools: [],
              config: { ...action.before.config, enabledTools: [] },
            }
          : null;
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'remote_actions')} SET undone = true WHERE id = ${command.actionId}`,
        );
      } else {
        id = command.serverId;
        const current = await query<ServerRow>(
          c.db,
          sql`SELECT * FROM ${ident(c.schemas.app, 'remote_servers')} WHERE id = ${id} FOR UPDATE`,
        );
        before = current.rows[0] ?? null;
        if (before && before.org_id !== actor.orgId) throw missing();
        if ((before?.revision ?? 0) !== command.revision) throw conflict();
        if (command.kind === 'remote.remove') after = null;
        else {
          this.checkAddress(command.config, before?.config);
          if (!before) {
            const count = await query<{ count: number }>(
              c.db,
              sql`SELECT count(*)::int AS count FROM ${ident(c.schemas.app, 'remote_servers')} WHERE org_id = ${actor.orgId}`,
            );
            if (count.rows[0]!.count >= 100) throw new AppError('validation_failed', 'remote.serverLimit');
          }
          for (const [table, ids] of [
            [
              'groups',
              command.config.audience.groups.filter((id) => !before?.config.audience.groups.includes(id)),
            ],
            [
              'org_units',
              command.config.audience.units.filter((id) => !before?.config.audience.units.includes(id)),
            ],
          ] as const) {
            const matches = await query(
              c.db,
              sql`SELECT id FROM ${ident(c.schemas.app, table)} WHERE org_id = ${actor.orgId} AND id = ANY(${ids}::text[])`,
            );
            if (matches.rowCount !== new Set(ids).size) throw missing();
          }
          const changed =
            !before ||
            ['address', 'auth', 'header'].some(
              (key) =>
                before!.config[key as keyof RemoteServerConfig] !==
                command.config[key as keyof RemoteServerConfig],
            );
          let sealed = changed ? null : before!.sealed;
          if (command.config.auth !== 'none' && (command.secret || command.clientId)) {
            const previous = changed ? {} : await this.credentials(before!, c.db);
            const clientId = command.clientId ?? previous.client?.client_id;
            if (command.config.auth === 'oauth' && command.secret && !clientId)
              throw new AppError('validation_failed', 'remote.clientRequired');
            sealed = await sealCredential(
              this.app.ctx.config.secretKey,
              JSON.stringify(
                command.config.auth === 'header'
                  ? { secret: command.secret }
                  : {
                      client: {
                        ...previous.client,
                        client_id: clientId,
                        ...(command.secret ? { client_secret: command.secret } : {}),
                      },
                    },
              ),
              `remote:${id}`,
              actor.orgId,
              c.db,
            );
          }
          if (command.config.auth === 'header' && !sealed)
            throw new AppError('validation_failed', 'remote.credentialRequired');
          if (command.config.enabledTools.some((name) => !before?.tools.some((tool) => tool.name === name)))
            throw conflict();
          after = {
            id,
            org_id: actor.orgId,
            user_id: actor.userId,
            config: { ...command.config, enabledTools: changed ? [] : command.config.enabledTools },
            tools: changed ? [] : before!.tools,
            sealed: command.config.auth === 'none' ? null : sealed,
            revision: command.revision + 1,
            refreshed_at: changed ? null : before!.refreshed_at,
            error_key: null,
          };
        }
      }
      if (after) this.checkAddress(after.config, before?.config);
      const keepCredentials = !!before && !!after && after.sealed === before.sealed;
      if (!after)
        await query(
          c.db,
          sql`DELETE FROM ${ident(c.schemas.app, 'remote_servers')} WHERE id = ${id} AND org_id = ${actor.orgId}`,
        );
      else
        await query(
          c.db,
          sql`INSERT INTO ${ident(c.schemas.app, 'remote_servers')} AS existing (id, org_id, user_id, config, tools, sealed, revision, refreshed_at, error_key)
        VALUES (${id}, ${actor.orgId}, ${after.user_id}, ${JSON.stringify(after.config)}::jsonb, ${JSON.stringify(after.tools)}::jsonb, ${after.sealed}, ${after.revision}, ${after.refreshed_at}, ${after.error_key})
        ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, user_id = EXCLUDED.user_id, tools = EXCLUDED.tools, sealed = CASE WHEN ${keepCredentials} THEN existing.sealed ELSE EXCLUDED.sealed END, revision = EXCLUDED.revision, refreshed_at = EXCLUDED.refreshed_at, error_key = EXCLUDED.error_key`,
        );
      await query(
        c.db,
        sql`INSERT INTO ${ident(c.schemas.app, 'remote_actions')} (id, org_id, user_id, server_id, before, after)
        VALUES (${command.id}, ${actor.orgId}, ${actor.userId}, ${id}, ${before ? JSON.stringify(before) : null}::jsonb, ${after ? JSON.stringify(after) : null}::jsonb)`,
      );
      if (!after)
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'remote_actions')} SET before = before - 'sealed', after = after - 'sealed' WHERE org_id = ${actor.orgId} AND server_id = ${id}`,
        );
      const changed: Record<string, unknown> = {};
      for (const key of [
        'auth',
        'header',
        'allowPrivate',
        'requireApproval',
        'audience',
        'alwaysAskTools',
      ] as const)
        if (!isDeepStrictEqual(before?.config[key], after?.config[key]))
          changed[key] = after?.config[key] ?? null;
      if (before?.sealed !== after?.sealed) changed.credentialChanged = true;
      if (before?.config.address !== after?.config.address)
        changed.addressHost = after ? new URL(after.config.address).host : null;
      if (!isDeepStrictEqual(before?.config.enabledTools, after?.config.enabledTools))
        changed.enabledTools = {
          added: (after?.config.enabledTools ?? []).filter(
            (name) => !before?.config.enabledTools.includes(name),
          ),
          removed: (before?.config.enabledTools ?? []).filter(
            (name) => !after?.config.enabledTools.includes(name),
          ),
        };
      await this.audit(c.db, actor, command.kind, { serverId: id, changed });
      await this.broadcast(c, id);
      return { actionId: command.id };
    });
  }
  async refresh(actor: Actor, id: string, commandId: string = randomUUID()) {
    return this.serialized(`catalog:${id}`, () => this.refreshNow(actor, id, commandId));
  }
  /** Without an actor, this is the scheduled refresh, which acts for nobody in `orgId`. */
  private async refreshNow(actor: Actor | null, id: string, commandId: string, orgId?: string) {
    const { pool, schemas } = this.data;
    const scheduled = (db: Queryable) =>
      query<ServerRow>(
        db,
        sql`SELECT * FROM ${ident(schemas.app, 'remote_servers')} WHERE id = ${id} AND org_id = ${orgId ?? null}`,
      );
    let row: ServerRow;
    if (actor) row = await this.row(actor, id, true);
    else {
      const found = await scheduled(pool);
      if (!found.rows[0]) throw missing();
      row = found.rows[0];
    }
    let tools: RemoteTool[] = row.tools;
    let errorKey: string | null = null;
    const skipped: { name: string; reason: string }[] = [];
    const credentials = await this.credentials(row);
    // Discovery would only start an authorization nobody can finish, and might register a client.
    if (row.config.auth === 'oauth' && !credentials.tokens) errorKey = 'remote.authorizationNeeded';
    else
      try {
        tools = await this.clients.discover(
          `${row.org_id}:${id}`,
          row.config,
          credentials.secret,
          row.config.auth === 'oauth' ? await this.oauth(actor, row, false, true) : undefined,
          (tool) => {
            if (skipped.length < 100) skipped.push(tool);
            errorKey = tool.reason === 'remote.catalogLimited' ? tool.reason : 'remote.schemaSkipped';
          },
        );
      } catch (error) {
        errorKey = error instanceof AppError ? error.messageKey : 'remote.unavailable';
      }
    const apply = async (db: Queryable, current: ServerRow) => {
      if (current.org_id !== row.org_id || current.revision !== row.revision) throw conflict();
      const changed = !isDeepStrictEqual(tools, current.tools);
      const enabled = current.config.enabledTools.filter((name) =>
        isDeepStrictEqual(
          tools.find((tool) => tool.name === name),
          current.tools.find((tool) => tool.name === name),
        ),
      );
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'remote_servers')} SET tools = ${JSON.stringify(tools)}::jsonb, skipped_tools = ${JSON.stringify(skipped)}::jsonb, config = ${JSON.stringify({ ...current.config, enabledTools: enabled })}::jsonb, revision = revision + ${changed ? 1 : 0}, refreshed_at = now(), error_key = ${errorKey} WHERE id = ${id} AND org_id = ${current.org_id}`,
      );
      const outcome = errorKey ? 'failed' : 'succeeded';
      if (actor) {
        await this.audit(db, actor, 'remote.refresh', { serverId: id, outcome });
        await this.notify(db, actor.orgId, id);
      } else if (
        changed ||
        errorKey !== current.error_key ||
        !isDeepStrictEqual(skipped, current.skipped_tools ?? [])
      ) {
        // A scheduled refresh records only a change in what people can use or see.
        await this.audit(db, { orgId: row.org_id }, 'remote.refresh', {
          serverId: id,
          outcome,
          source: 'schedule',
        });
        await this.notify(db, row.org_id, id);
      }
      return { errorKey };
    };
    if (actor)
      return this.bus(actor, commandId, id, async (c) => apply(c.db, await this.row(actor, id, true, c.db)));
    return withTransaction(pool, async (db) => {
      await query(
        db,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:remote:${row.org_id}`}, 0))`,
      );
      const found = await scheduled(db);
      if (!found.rows[0]) throw missing();
      return apply(db, found.rows[0]);
    });
  }
  async markLabeled(actor: Actor, conversationId: string) {
    await this.bus(actor, randomUUID(), conversationId, async (c) => {
      await new AccessScope(c.db, c.schemas, actor).requireOrganization();
      const changed = await query(
        c.db,
        sql`UPDATE ${ident(c.schemas.app, 'rio_conversations')} SET remote_data_blocked = true WHERE id = ${conversationId} AND org_id = ${actor.orgId} AND user_id = ${actor.userId} AND NOT remote_data_blocked`,
      );
      if (changed.rowCount) await this.audit(c.db, actor, 'remote.data_blocked', { conversationId });
    });
  }
  async labeled(actor: Actor, conversationId: string): Promise<boolean> {
    await new AccessScope(this.data.pool, this.data.schemas, actor).requireOrganization();
    const result = await query<{ remote_data_blocked: boolean }>(
      this.data.pool,
      sql`SELECT remote_data_blocked FROM ${ident(this.data.schemas.app, 'rio_conversations')}
        WHERE id = ${conversationId} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
    );
    if (!result.rows[0]) throw missing();
    return result.rows[0].remote_data_blocked;
  }
  private async dataAllowed(actor: Actor, conversationId: string | null, db: Queryable = this.data.pool) {
    const scope = new AccessScope(db, this.data.schemas, { ...actor, dataUse: 'provider' });
    await scope.requireOrganization();
    const settings = await settingsFor(this.app.ctx, actor.orgId, actor, db);
    const policy = await readKnowledgeSettings(db, this.data.schemas, actor);
    if (!settings.enabled || policy.libraries.rules.internal !== 'allowed')
      throw new AppError('forbidden', 'remote.dataBlocked');
    if (conversationId) {
      const conversations = await query<{ remote_data_blocked: boolean }>(
        db,
        sql`SELECT remote_data_blocked FROM ${ident(this.data.schemas.app, 'rio_conversations')} WHERE id = ${conversationId} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
      );
      if (!conversations.rows[0]) throw missing();
      if (conversations.rows[0].remote_data_blocked) throw new AppError('forbidden', 'remote.dataBlocked');
      const contexts = await query<{ context_database_id: string }>(
        db,
        sql`SELECT DISTINCT context_database_id FROM ${ident(this.data.schemas.app, 'rio_messages')} WHERE conversation_id = ${conversationId} AND org_id = ${actor.orgId} AND user_id = ${actor.userId} AND context_database_id IS NOT NULL`,
      );
      for (const context of contexts.rows) {
        await scope.require(context.context_database_id, 'read');
        try {
          await scope.requireUse(context.context_database_id, 'provider');
        } catch {
          throw new AppError('forbidden', 'remote.dataBlocked');
        }
      }
    }
  }
  async call(
    actor: Actor,
    input: unknown,
    conversationId: string | null,
    options: {
      untrusted?: boolean;
      signal?: AbortSignal;
      onBlock?: (block: { kind: 'remoteApproval'; approvalId: string }) => void;
    } = {},
  ) {
    const call = parse(RemoteCall, input);
    await new AccessScope(this.data.pool, this.data.schemas, actor).requireOrganization();
    try {
      return await this.requestCall(actor, call, conversationId, options);
    } catch (error) {
      await this.bus(actor, randomUUID(), call.serverId, async (c) => {
        await this.audit(c.db, actor, 'remote.call', {
          serverId: call.serverId,
          tool: call.tool,
          outcome: 'blocked',
        });
      });
      throw error;
    }
  }
  private async requestCall(
    actor: Actor,
    call: RemoteCall,
    conversationId: string | null,
    options: {
      untrusted?: boolean;
      signal?: AbortSignal;
      onBlock?: (block: { kind: 'remoteApproval'; approvalId: string }) => void;
    },
  ) {
    options.signal?.throwIfAborted();
    const row = await this.row(actor, call.serverId);
    const tool = row.tools.find(
      (entry) => entry.name === call.tool && row.config.enabledTools.includes(entry.name),
    );
    if (!tool) throw missing();
    const id = randomUUID();
    await this.dataAllowed(actor, conversationId);
    if (Buffer.byteLength(JSON.stringify(call.arguments)) > 32000)
      throw new AppError('payload_too_large', 'remote.resultTooLarge');
    const validation = new RemoteSchemaValidator().getValidator(tool.inputSchema)(call.arguments);
    if (!validation.valid) throw new AppError('validation_failed', 'errors.badRequest');
    const sealed = seal(this.app.ctx.config.secretKey, JSON.stringify(call.arguments), `remote-call:${id}`);
    await this.bus(actor, id, row.id, async (c) => {
      const current = await this.row(actor, row.id, false, c.db);
      if (current.revision !== row.revision) throw conflict();
      const rate = await query<{ person: number; server: number }>(
        c.db,
        sql`SELECT count(*) FILTER (WHERE user_id = ${actor.userId})::int AS person, count(*) FILTER (WHERE server_id = ${row.id})::int AS server FROM ${ident(c.schemas.app, 'remote_calls')} WHERE org_id = ${actor.orgId} AND created_at > now() - interval '1 minute' AND (user_id = ${actor.userId} OR server_id = ${row.id})`,
      );
      if (rate.rows[0]!.person >= 20 || rate.rows[0]!.server >= 120)
        throw new AppError('rate_limited', 'remote.rateLimited');
      await query(
        c.db,
        sql`INSERT INTO ${ident(c.schemas.app, 'remote_calls')} (id, org_id, user_id, server_id, conversation_id, tool, revision, sealed, status)
        VALUES (${id}, ${actor.orgId}, ${actor.userId}, ${row.id}, ${conversationId}, ${tool.name}, ${row.revision}, ${sealed}, 'pending')`,
      );
      await this.audit(c.db, actor, 'remote.call', { serverId: row.id, tool: tool.name, outcome: 'pending' });
    });
    const block = { kind: 'remoteApproval' as const, approvalId: id };
    options.onBlock?.(block);
    if (
      tool.readOnly &&
      !row.config.requireApproval &&
      !row.config.alwaysAskTools?.includes(tool.name) &&
      !options.untrusted
    )
      return { data: await this.decide(actor, id, true, randomUUID(), options.signal), block };
    return {
      data: { approvalId: id, status: 'pending', href: `/#remote-approval=${id}` },
      block: { kind: 'remoteApproval' as const, approvalId: id },
    };
  }
  private async callRow(actor: Actor, id: string, db: Queryable = this.data.pool) {
    await new AccessScope(db, this.data.schemas, actor).requireOrganization();
    const found = await query<CallRow>(
      db,
      sql`SELECT * FROM ${ident(this.data.schemas.app, 'remote_calls')} WHERE id = ${id} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
    );
    if (!found.rows[0]) throw missing();
    return found.rows[0];
  }
  async approval(actor: Actor, id: string): Promise<RemoteApproval> {
    const call = await this.callRow(actor, id);
    const server = await this.row(actor, call.server_id);
    if (
      call.status === 'pending' &&
      (server.revision !== call.revision || call.expires_at.getTime() < Date.now())
    )
      throw new AppError('conflict', 'remote.expired');
    return {
      id,
      server: server.config.name,
      tool: call.tool,
      arguments: JSON.parse(
        unseal(this.app.ctx.config.secretKey, call.sealed, `remote-call:${id}`),
      ) as Record<string, unknown>,
      status: call.status,
      ...(call.result ? { result: call.result } : {}),
    };
  }
  async decide(actor: Actor, id: string, approve: boolean, commandId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const claimed = await this.bus(
      actor,
      commandId,
      id,
      async (c) => {
        const call = await this.callRow(actor, id, c.db);
        const row = await this.row(actor, call.server_id, false, c.db);
        await this.dataAllowed(actor, call.conversation_id, c.db);
        if (
          call.status !== 'pending' ||
          call.expires_at.getTime() <= Date.now() ||
          call.revision !== row.revision ||
          !row.config.enabledTools.includes(call.tool)
        )
          throw new AppError('conflict', 'remote.expired');
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'remote_calls')} SET status = ${approve ? 'running' : 'denied'}, expires_at = CASE WHEN ${approve} THEN now() + interval '1 minute' ELSE expires_at END WHERE id = ${id}`,
        );
        await this.audit(c.db, actor, 'remote.call', {
          serverId: row.id,
          tool: call.tool,
          outcome: approve ? 'running' : 'denied',
        });
        return { execute: approve, serverId: row.id, revision: row.revision, tool: call.tool };
      },
      () => ({ execute: false, serverId: '', revision: 0, tool: '' }),
    );
    if (!claimed.execute) {
      const call = await this.callRow(actor, id);
      await this.row(actor, call.server_id);
      await this.dataAllowed(actor, call.conversation_id);
      return { status: call.status };
    }
    // A separate claim prevents retries or simultaneous approvals from repeating an outside write.
    // Calls to one server run side by side.  Only an OAuth token refresh waits for another.
    let result: string;
    let status: 'succeeded' | 'failed' = 'succeeded';
    try {
      signal?.throwIfAborted();
      const call = await this.callRow(actor, id);
      if (call.status !== 'running' || call.expires_at.getTime() <= Date.now()) throw conflict();
      const row = await this.row(actor, claimed.serverId);
      if (row.revision !== claimed.revision || !row.config.enabledTools.includes(call.tool)) throw conflict();
      await this.dataAllowed(actor, call.conversation_id);
      const args = JSON.parse(
        unseal(this.app.ctx.config.secretKey, call.sealed, `remote-call:${id}`),
      ) as Record<string, unknown>;
      const response = await this.clients.withClient(
        `${actor.orgId}:${row.id}`,
        row.config,
        (await this.credentials(row)).secret,
        row.config.auth === 'oauth' ? await this.oauth(actor, row) : undefined,
        async (client) => {
          const current = await this.row(actor, row.id);
          if (current.revision !== claimed.revision || !current.config.enabledTools.includes(call.tool))
            throw conflict();
          await this.dataAllowed(actor, call.conversation_id);
          return client.callTool({ name: call.tool, arguments: args }, undefined, {
            timeout: 15000,
            signal,
          });
        },
        signal,
      );
      const data = JSON.stringify(response);
      result = JSON.stringify({ untrusted: true, data: data.slice(0, 3000), truncated: data.length > 3000 });
      if (response.isError) status = 'failed';
    } catch (error) {
      status = 'failed';
      result = JSON.stringify({
        messageKey: error instanceof AppError ? error.messageKey : 'remote.unavailable',
      });
    }
    await this.bus(actor, randomUUID(), id, async (c) => {
      await query(
        c.db,
        sql`UPDATE ${ident(c.schemas.app, 'remote_calls')} SET status = ${status}, result = ${result} WHERE id = ${id} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
      );
      await this.audit(c.db, actor, 'remote.call', {
        serverId: claimed.serverId,
        tool: claimed.tool,
        outcome: status,
      });
    });
    return { status, result };
  }
  async tick() {
    const abandoned = await query<CallRow & { org_id: string; user_id: string }>(
      this.data.pool,
      sql`SELECT * FROM ${ident(this.data.schemas.app, 'remote_calls')} WHERE status = 'running' AND expires_at < now() ORDER BY expires_at, id LIMIT 100`,
    );
    for (const call of abandoned.rows) {
      const actor: Actor = {
        orgId: call.org_id,
        userId: call.user_id,
        kind: 'member',
        adminRoles: [],
        sessionId: '',
        csrfToken: '',
      };
      await this.bus(actor, randomUUID(), call.id, async (c) => {
        const updated = await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'remote_calls')} SET status = 'failed', result = ${JSON.stringify({ messageKey: 'remote.uncertain' })} WHERE id = ${call.id} AND status = 'running' AND expires_at < now()`,
        );
        if (updated.rowCount)
          await this.audit(c.db, actor, 'remote.call', {
            serverId: call.server_id,
            tool: call.tool,
            outcome: 'uncertain',
          });
      }).catch(() => {});
    }
    const { pool, schemas } = this.data;
    const calls = ident(schemas.app, 'remote_calls');
    const actions = ident(schemas.app, 'remote_actions');
    const expired = await query<{ org_id: string }>(
      pool,
      sql`SELECT org_id FROM ${calls} WHERE status <> 'running' AND expires_at < now() - interval '1 day'
      UNION SELECT org_id FROM ${actions} WHERE created_at < now() - interval '30 days'`,
    );
    for (const { org_id: orgId } of expired.rows)
      await withTransaction(pool, async (db) => {
        const removedCalls = await query(
          db,
          sql`DELETE FROM ${calls} WHERE org_id = ${orgId} AND status <> 'running' AND expires_at < now() - interval '1 day'`,
        );
        const removedActions = await query(
          db,
          sql`DELETE FROM ${actions} WHERE org_id = ${orgId} AND created_at < now() - interval '30 days'`,
        );
        // Like governance's retention purge, a scheduled purge names only the organization.
        if (removedCalls.rowCount || removedActions.rowCount)
          await this.audit(db, { orgId }, 'remote.retention', {
            calls: removedCalls.rowCount,
            actions: removedActions.rowCount,
          });
      });
    const due = await query<{ id: string; org_id: string }>(
      pool,
      sql`SELECT id, org_id FROM ${ident(schemas.app, 'remote_servers')}
        WHERE refreshed_at IS NULL OR refreshed_at < now() - interval '15 minutes'
        ORDER BY refreshed_at NULLS FIRST, id LIMIT 20`,
    );
    for (const { id, org_id: orgId } of due.rows) {
      try {
        await this.serialized(`catalog:${id}`, () => this.refreshNow(null, id, randomUUID(), orgId));
      } catch {
        /* A removed or changed connection is refreshed again on a later pass */
      }
    }
  }
}

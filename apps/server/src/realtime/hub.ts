import { activeSessionIds, sessionsChannel } from '../auth/account-store.js';
import { loadFields, loadTables } from '../data/metadata.js';
import { hasSelectSources, isSelect, sourceOptionsPage } from '../data/select-options.js';
import { relationalConditions } from '../data/physical/conditional.js';
import type { StoredField } from '../data/types.js';
import { historyExpired } from '../data/retention.js';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  IngestLiveEvent,
  presenceColor,
  roleAllows,
  type Change,
  type ChangeBody,
  type ClientMessage,
  type DatabaseRole,
  type PresenceLocation,
  type PresencePeer,
  type ServerMessage,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { hookPath, loadAutomation, readerAutomation } from '../automations/store.js';
import { readerScript } from '../scripts/store.js';
import { personIdentity } from '../data/people.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import {
  accessChannel,
  changesChannel,
  homeChannel,
  organizationChannel,
  presenceChannel,
} from '../data/notify.js';
import type { ViewWatch } from '../data/services.js';
import type { Actor } from '../http/policy.js';
import { RealtimeListener } from './listener.js';
import { changeFor, changesSchema } from './redact.js';
import { Presence, sealNotice, type PresenceNotice } from './presence.js';

export interface RealtimeTab {
  actor: Actor;
  clientId: string;
  name: string;
  open: boolean;
  send(message: ServerMessage): boolean;
  terminate(code?: number): void;
}

interface Subscription {
  tab: RealtimeTab;
  /** The role the tab subscribed with; a different one now means it must reload */
  role: DatabaseRole;
  /**
   * The tab's person's access, with the database's field and record rules read, and a summary of
   * what those rules decide for them.  A different summary now means the tab must reload.
   */
  scope: AccessScope;
  fingerprint: string;
  dependencies: string;
  seq: number;
  active: boolean;
  watches: Map<string, ViewWatch & { tableId: string }>;
  presence?: PresenceNotice;
  choices: Map<string, string>;
  choiceIds: Map<string, string[]>;
}

interface SourceDependency {
  field: StoredField;
  inputs: Map<string, Set<string>>;
}

interface Database {
  id: string;
  subscriptions: Map<RealtimeTab, Subscription>;
  tail: Promise<void>;
  scheduled: boolean;
  retry: boolean;
  /** When access was last rechecked, for installs that poll instead of listening */
  checkedAt: number;
  accessVersion: number;
  checkedVersion: number;
  sourceDependencies?: SourceDependency[];
  choiceTimer?: NodeJS.Timeout;
  choiceTail?: Promise<void>;
  pendingChoices?: Map<Subscription, Set<string>>;
}

export class RealtimeHub {
  private readonly databases = new Map<string, Database>();
  private readonly tabs = new Set<RealtimeTab>();
  private readonly sessionConnections = new Set<{ sessionId: string; end(): void }>();
  private readonly publishing = new Set<Promise<void>>();

  private async ingestChanged(event: IngestLiveEvent): Promise<void> {
    const database = this.databases.get(event.databaseId);
    if (!database) return;
    await this.checkAccess(database);
    for (const subscription of database.subscriptions.values())
      if (this.current(database, subscription)) subscription.tab.send(event);
  }

  private readonly presence = new Presence(
    (databaseId) => this.sendPresence(databaseId),
    () => this.app.ctx.config.secretKey,
  );
  private listener: RealtimeListener | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  /** Webhook addresses by automation, which never change once made */
  private readonly hookPaths = new Map<string, string | null>();

  constructor(private readonly app: FastifyInstance) {}

  private async remoteChanged(orgId: string) {
    const { pool, schemas } = dataStore(this.app.ctx);
    for (const tab of this.tabs) {
      if (tab.actor.orgId !== orgId) continue;
      try {
        await new AccessScope(pool, schemas, tab.actor).requireOrganizationAdmin('ai');
        tab.send({ type: 'remoteToolsChanged' });
      } catch {
        /* Only current administrators read connection settings */
      }
    }
  }

  private async personChanged(orgId: string, userId: string): Promise<void> {
    const { pool, schemas } = dataStore(this.app.ctx);
    for (const tab of [...this.tabs]) {
      if (tab.actor.orgId !== orgId) continue;
      if (tab.actor.userId === userId) {
        try {
          tab.actor = await new AccessScope(pool, schemas, tab.actor).currentPerson();
          const person = await personIdentity({ db: pool, schemas, actor: tab.actor }, userId);
          if (!person) throw new AppError('not_found', 'errors.notFound');
          tab.name = person.name;
        } catch (error) {
          if (!(error instanceof AppError) || !['unauthenticated', 'not_found'].includes(error.code))
            throw error;
          tab.send({ type: 'accountDeactivated' });
          this.detach(tab);
          tab.terminate(4401);
          continue;
        }
        tab.send({ type: 'organizationChanged' });
        for (const database of this.databases.values()) {
          const subscription = database.subscriptions.get(tab);
          if (!subscription) continue;
          if (subscription.presence) this.locate(tab, database.id, subscription.presence.where);
          this.recheck(database);
        }
      }
      try {
        const outgoing = await personIdentity({ db: pool, schemas, actor: tab.actor }, userId);
        if (outgoing) tab.send({ type: 'personChanged', person: outgoing });
        // People lists and sharing lists re-read only for viewers who can read this person.
        tab.send({ type: 'organizationChanged' });
      } catch {
        // A removed or hidden person sends no identity to this reader.
        const scope = new AccessScope(pool, schemas, tab.actor);
        const managed = await scope.manageablePeople().catch(() => new Set<string>());
        if (managed === null || managed.has(userId)) tab.send({ type: 'organizationChanged' });
      }
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const profile = this.app.ctx.config.database;
    if (!profile || !this.app.ctx.pool) return;
    this.listener = new RealtimeListener(
      profile,
      this.app.log,
      (channel, payload) => {
        if (channel === sessionsChannel(profile.schemas)) {
          this.endSession(payload);
          return;
        }
        if (channel === `${profile.schemas.app}_remote`.slice(0, 63)) {
          try {
            const notice = JSON.parse(payload) as { orgId: string };
            const work = this.remoteChanged(notice.orgId);
            this.publishing.add(work);
            void work.finally(() => this.publishing.delete(work));
          } catch {
            /* Invalid notices have no recipients */
          }
          return;
        }
        if (channel === organizationChannel(profile.schemas)) {
          if (payload.startsWith('{')) {
            try {
              const notice = JSON.parse(payload) as { orgId?: string; personChanged?: string };
              if (typeof notice.orgId === 'string' && typeof notice.personChanged === 'string') {
                const work = this.personChanged(notice.orgId, notice.personChanged);
                this.publishing.add(work);
                void work
                  .catch((error: unknown) =>
                    this.app.log.error({ err: error }, 'Person update delivery failed'),
                  )
                  .finally(() => this.publishing.delete(work));
                return;
              }
            } catch {
              /* Invalid notices have no recipients. */
            }
          }
          const audience = audienceOf(payload);
          for (const tab of this.tabs)
            if (reaches(tab.actor, audience)) tab.send({ type: 'organizationChanged' });
          return;
        }
        if (channel === presenceChannel(profile.schemas)) this.presence.receive(payload);
        if (channel === homeChannel(profile.schemas)) {
          const audience = audienceOf(payload);
          // Organization-wide notices come from publishers that send no separate database access notices.
          if (audience.kind === 'organization')
            for (const database of this.databases.values())
              if ([...database.subscriptions.values()].some((s) => s.tab.actor.orgId === payload))
                this.recheck(database);
          for (const tab of this.tabs)
            if (tab.clientId && reaches(tab.actor, audience)) tab.send({ type: 'homeChanged' });
          return;
        }
        if (channel === accessChannel(profile.schemas)) {
          for (const database of this.databases.values())
            if (
              database.id === payload ||
              [...database.subscriptions.values()].some((subscription) =>
                subscription.scope.dependsOnDatabase(payload),
              )
            )
              this.recheck(database);
          return;
        }
        if (channel !== changesChannel(profile.schemas)) return;
        try {
          const notice: unknown = JSON.parse(payload);
          const ingest = IngestLiveEvent.safeParse(notice);
          if (ingest.success) {
            const work = this.ingestChanged(ingest.data);
            this.publishing.add(work);
            void work.catch(() => undefined).finally(() => this.publishing.delete(work));
            return;
          }
          if (
            typeof notice !== 'object' ||
            !notice ||
            !('databaseId' in notice) ||
            typeof notice.databaseId !== 'string' ||
            !('seq' in notice) ||
            typeof notice.seq !== 'number' ||
            !Number.isSafeInteger(notice.seq)
          )
            return;
          const changedDatabaseId = notice.databaseId;
          const database = this.databases.get(changedDatabaseId);
          if (database) this.schedule(database);
          for (const dependent of this.databases.values())
            if (
              dependent.id !== changedDatabaseId &&
              [...dependent.subscriptions.values()].some((subscription) =>
                subscription.scope.dependsOnDatabase(changedDatabaseId),
              )
            )
              this.recheck(dependent);
        } catch {
          /* A malformed notice cannot interrupt the listener. */
        }
      },
      () => {
        this.recheckSessions();
        for (const tab of this.tabs) if (tab.clientId) tab.send({ type: 'homeChanged' });
        for (const database of this.databases.values()) {
          // Access notices sent while the listener was down were lost.
          this.recheck(database);
          this.schedule(database);
          for (const subscription of database.subscriptions.values()) {
            if (subscription.presence && subscription.presence.timestamp > Date.now() - 60_000) {
              this.publish(subscription.presence);
            }
          }
        }
      },
    );
    this.listener.start();
    this.timer = setInterval(() => {
      this.presence.expire();
      // Polling also closes ended sessions after a missed notice or on transaction poolers.
      if (!this.listener?.ready) this.recheckSessions();
      for (const database of this.databases.values()) {
        if (!this.listener?.ready || database.retry) this.schedule(database, !this.listener?.ready);
      }
    }, 1_000);
    this.timer.unref();
  }

  attach(tab: RealtimeTab): void {
    this.start();
    this.tabs.add(tab);
  }

  watchSession(sessionId: string, end: () => void): () => void {
    this.start();
    const connection = { sessionId, end };
    this.sessionConnections.add(connection);
    this.recheckSessions();
    return () => this.sessionConnections.delete(connection);
  }

  private endSession(sessionId: string) {
    for (const tab of this.tabs)
      if (tab.actor.sessionId === sessionId) {
        this.detach(tab);
        tab.terminate(4401);
      }
    for (const connection of this.sessionConnections)
      if (connection.sessionId === sessionId) {
        this.sessionConnections.delete(connection);
        connection.end();
      }
  }

  private recheckSessions() {
    const ids = [...new Set([...this.sessionConnections].map((connection) => connection.sessionId))];
    if (!ids.length) return;
    const { pool, schemas } = dataStore(this.app.ctx);
    const work = activeSessionIds(pool, schemas, ids)
      .then((live) => {
        for (const id of ids) if (!live.has(id)) this.endSession(id);
      })
      .catch(() => {
        for (const id of ids) this.endSession(id);
      });
    this.publishing.add(work);
    void work.finally(() => this.publishing.delete(work));
  }

  private database(id: string): Database {
    let database = this.databases.get(id);
    if (!database) {
      database = {
        id,
        subscriptions: new Map(),
        tail: Promise.resolve(),
        scheduled: false,
        retry: false,
        checkedAt: -Infinity,
        accessVersion: 0,
        checkedVersion: -1,
      };
      this.databases.set(id, database);
    }
    return database;
  }

  private enqueue(database: Database, task: () => Promise<void>): Promise<void> {
    const result = database.tail.then(task);
    database.tail = result.catch(() => {
      database.retry = true;
    });
    return result;
  }

  async handle(tab: RealtimeTab, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'subscribe':
        return this.subscribe(tab, message.databaseId, message.sinceSeq);
      case 'unsubscribe':
        return this.remove(tab, message.databaseId);
      case 'presence':
        return this.locate(tab, message.databaseId, message.where);
      case 'watch':
        return this.watch(tab, message.databaseId, message.viewId, message.snapshot);
      case 'watchSelectOptions': {
        const database = this.databases.get(message.databaseId);
        const subscription = database?.subscriptions.get(tab);
        if (!database || !subscription) throw new AppError('not_found', 'errors.notFound');
        const dependency = (await this.sourceDependencies(database)).find(
          (item) => item.field.id === message.fieldId,
        );
        if (
          !dependency ||
          !subscription.scope.visibleFields(dependency.field.tableId, [dependency.field]).length
        )
          throw new AppError('not_found', 'errors.notFound');
        subscription.choiceIds.set(message.fieldId, [...new Set(message.choiceIds)]);
        return this.enqueueChoices(database, () =>
          this.refreshChoices(database, new Map([[subscription, new Set([message.fieldId])]])),
        );
      }
      case 'ping':
        tab.send({ type: 'pong' });
        return;
      case 'hello':
        throw new AppError('bad_request', 'errors.badRequest');
    }
  }

  private async subscribe(tab: RealtimeTab, databaseId: string, sinceSeq: number): Promise<void> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const scope = new AccessScope(pool, schemas, tab.actor);
    const role = await scope.require(databaseId, 'read');
    const fingerprint = await scope.fingerprint(databaseId);
    if (!tab.open || this.stopped) return;
    const database = this.database(databaseId);
    // A repeated subscribe must not rewind an existing subscription's cursor.
    if (database.subscriptions.has(tab)) return;
    const subscription: Subscription = {
      tab,
      role,
      scope,
      fingerprint,
      dependencies: scope.dependencyFingerprint(databaseId),
      seq: sinceSeq,
      active: false,
      watches: new Map(),
      choices: new Map(),
      choiceIds: new Map(),
    };
    database.subscriptions.set(tab, subscription);
    // Registration invalidates checks that started before this subscription existed.
    database.accessVersion++;
    try {
      await this.enqueue(database, async () => {
        await this.checkAccess(database);
        if (!this.current(database, subscription)) return;
        const changes = await this.read(databaseId, sinceSeq);
        await this.checkAccess(database);
        if (!this.current(database, subscription)) return;
        if (changes.length > 5_000 || (await historyExpired(pool, schemas, databaseId, sinceSeq))) {
          tab.send({ type: 'reload', databaseId, reason: 'tooFarBehind' });
          this.remove(tab, databaseId);
          return;
        }
        // The first schema refresh reads current dependencies for the entire historical batch.
        let refreshSchema = true;
        for (const change of changes) {
          await this.deliver(database, change, [subscription], refreshSchema);
          if (changesSchema(change)) refreshSchema = false;
        }
        if (!this.current(database, subscription)) return;
        subscription.active = true;
        tab.send({ type: 'caughtUp', databaseId, seq: subscription.seq });
        this.presence.schedule(databaseId);
      });
      await this.enqueueChoices(database, async () =>
        this.refreshChoices(
          database,
          new Map([
            [subscription, new Set((await this.sourceDependencies(database)).map((item) => item.field.id))],
          ]),
        ),
      );
    } catch (error) {
      this.remove(tab, databaseId);
      throw error;
    }
  }

  private current(database: Database, subscription: Subscription): boolean {
    return subscription.tab.open && database.subscriptions.get(subscription.tab) === subscription;
  }

  private async read(databaseId: string, seq: number): Promise<Change[]> {
    const { pool, schemas } = dataStore(this.app.ctx);
    // The bus stores what happened in body and who, when, and in what order in columns.
    const result = await query<{
      seq: string;
      command_id: string;
      group_id: string;
      actor_id: string | null;
      client_id: string | null;
      at: Date;
      undo_of: string | null;
      redo_of: string | null;
      body: ChangeBody;
    }>(
      pool,
      sql`
      /* realtime replay */ SELECT seq, command_id, group_id, actor_id, client_id, at, undo_of, redo_of, body
      FROM ${ident(schemas.app, 'changes')}
      WHERE database_id = ${databaseId} AND seq > ${seq} ORDER BY seq LIMIT 5001`,
    );
    return result.rows.map(
      (row) =>
        ({
          ...row.body,
          seq: Number(row.seq),
          databaseId,
          commandId: row.command_id,
          groupId: row.group_id,
          actorId: row.actor_id,
          clientId: row.client_id,
          at: row.at.toISOString(),
          ...(row.undo_of ? { undoOf: row.undo_of } : {}),
          ...(row.redo_of ? { redoOf: row.redo_of } : {}),
        }) as Change,
    );
  }

  /**
   * Tells tabs whose role in the database changed to reload, and stops sending changes to those
   * who lost access.  Runs in the database's queue, so nothing is delivered on a stale role.
   */
  private recheck(database: Database): void {
    // Invalidate synchronously so a replay already running sees the notice before delivery.
    database.accessVersion++;
    void this.enqueue(database, () => this.checkAccess(database)).catch(() => {
      this.app.log.warn({ messageKey: 'errors.internal' }, 'realtime access check failed');
    });
  }

  private async checkAccess(database: Database, force = false): Promise<void> {
    if (
      !force &&
      database.checkedVersion === database.accessVersion &&
      (this.listener?.ready || Date.now() - database.checkedAt < 1_000)
    )
      return;
    database.checkedVersion = -1;
    do {
      const version = database.accessVersion;
      const checkedAt = Date.now();
      const { pool, schemas } = dataStore(this.app.ctx);
      for (const subscription of [...database.subscriptions.values()]) {
        const scope = new AccessScope(pool, schemas, subscription.tab.actor);
        const role = await scope.databaseRole(database.id);
        const fingerprint = role ? await scope.fingerprint(database.id) : null;
        if (!this.current(database, subscription)) continue;
        if (role === subscription.role && fingerprint === subscription.fingerprint) {
          if (scope.dependencyFingerprint(database.id) !== subscription.dependencies) {
            subscription.tab.send({ type: 'reload', databaseId: database.id, reason: 'dependenciesChanged' });
            // Keep the source stream: inverse audits from the same commit still need delivery.
            subscription.dependencies = scope.dependencyFingerprint(database.id);
          }
          subscription.scope = scope;
          continue;
        }
        subscription.tab.send({ type: 'reload', databaseId: database.id, reason: 'accessChanged' });
        this.remove(subscription.tab, database.id);
      }
      database.checkedAt = checkedAt;
      database.checkedVersion = version;
      // A notice or registration during the check requires another committed snapshot.
    } while (database.checkedVersion !== database.accessVersion);
  }

  private schedule(database: Database, poll = false): void {
    if (database.scheduled || this.stopped) return;
    database.scheduled = true;
    void this.enqueue(database, async () => {
      // Clear before reading so a commit during the query schedules another pass.
      database.scheduled = false;
      database.retry = false;
      await this.checkAccess(database, poll);
      const subscriptions = [...database.subscriptions.values()].filter((s) => s.active && s.tab.open);
      if (!subscriptions.length) return;
      const changes = await this.read(database.id, Math.min(...subscriptions.map((s) => s.seq)));
      for (const change of changes) await this.deliver(database, change, subscriptions);
      if (changes.length === 5_001) this.schedule(database);
    }).catch(() => {
      this.app.log.warn({ messageKey: 'errors.internal' }, 'realtime catch-up failed');
    });
  }

  /**
   * An automation or script change as each kind of person sees it.  People who can change the
   * automation also get its webhook address, which the stored change never holds, and everyone
   * else sees its webhook calls without their secrets and scripts without their code.  Null for
   * changes that aren't about an automation or a script.
   */
  private async automationViews(change: Change): Promise<{ editors: Change; readers: Change } | null> {
    // A script's code, like a script step's, goes only to people who can change it.
    if (
      change.kind === 'script.created' ||
      change.kind === 'script.updated' ||
      change.kind === 'script.restored'
    )
      return { editors: change, readers: { ...change, script: readerScript(change.script) } };
    if (
      change.kind !== 'automation.created' &&
      change.kind !== 'automation.updated' &&
      change.kind !== 'automation.restored'
    )
      return null;
    const readers = { ...change, automation: readerAutomation(change.automation) };
    // The address goes with what's being edited, so it's there to copy before a draft is published.
    const editing = change.automation.draft?.config ?? change.automation.config;
    if (editing.trigger.kind !== 'webhook') return { editors: change, readers };
    const id = change.automation.id;
    let path = this.hookPaths.get(id);
    if (path === undefined) {
      const { pool, schemas } = dataStore(this.app.ctx);
      const automation = await loadAutomation(pool, schemas, id);
      path = automation ? hookPath(this.app.ctx.config.secretKey, automation) : null;
      if (this.hookPaths.size >= 1_000) this.hookPaths.clear();
      this.hookPaths.set(id, path);
    }
    return {
      editors: path ? { ...change, automation: { ...change.automation, webhookPath: path } } : change,
      readers,
    };
  }

  private async sourceDependencies(database: Database): Promise<SourceDependency[]> {
    if (database.sourceDependencies) return database.sourceDependencies;
    const { pool, schemas } = dataStore(this.app.ctx);
    if (!(await hasSelectSources(pool, schemas, database.id))) return (database.sourceDependencies = []);
    const tables = await loadTables(pool, schemas, database.id);
    const fields = await loadFields(
      pool,
      schemas,
      tables.map((table) => table.id),
    );
    const byId = new Map(fields.map((field) => [field.id, field]));
    database.sourceDependencies = fields.flatMap((field) => {
      if (!isSelect(field) || !field.options.source) return [];
      const source = field.options.source;
      const inputs = new Map<string, Set<string>>([[source.tableId, new Set()]]);
      const seen = new Set<string>();
      const add = (input: StoredField | undefined) => {
        if (!input || seen.has(input.id)) return;
        seen.add(input.id);
        const ids = inputs.get(input.tableId) ?? new Set<string>();
        ids.add(input.id);
        if (input.type === 'lastModifiedTime') ids.add('*');
        inputs.set(input.tableId, ids);
        for (const dependency of input.formula?.fields ?? []) add(dependency);
        add(input.relation?.target);
        add(input.relation?.primary);
        for (const dependency of input.relation?.conditionFields ?? []) add(dependency);
      };
      add(
        byId.get(source.fieldId ?? tables.find((table) => table.id === source.tableId)?.primaryFieldId ?? ''),
      );
      for (const condition of relationalConditions(source.filter)) add(byId.get(condition.fieldId));
      return [{ field, inputs }];
    });
    return database.sourceDependencies;
  }

  private async queueChoices(database: Database, change: Change, recipients: Subscription[]): Promise<void> {
    const tableId =
      'tableId' in change
        ? change.tableId
        : 'table' in change
          ? change.table.id
          : 'field' in change
            ? change.field.tableId
            : undefined;
    if (!tableId || !recipients.length || change.kind === 'record.moved') return;
    const updates =
      change.kind === 'record.updated'
        ? new Set(change.records.flatMap((row) => Object.keys(row.values)))
        : null;
    const membership = ['record.created', 'record.trashed', 'record.restored', 'table.synced'].includes(
      change.kind,
    );
    const definitions = changesSchema(change);
    if (!updates && !membership && !definitions && change.kind !== 'record.linksChanged') return;
    for (const dependency of await this.sourceDependencies(database)) {
      const inputs = dependency.inputs.get(tableId);
      if (!inputs && !(definitions && dependency.field.tableId === tableId)) continue;
      for (const subscription of recipients) {
        if (!subscription.scope.visibleFields(dependency.field.tableId, [dependency.field]).length) continue;
        const affected =
          membership ||
          definitions ||
          (updates &&
            (subscription.scope.limitsRecords(tableId) ||
              inputs?.has('*') ||
              [...updates].some((id) => inputs?.has(id)))) ||
          (change.kind === 'record.linksChanged' && inputs?.has(change.fieldId));
        if (!affected) continue;
        database.pendingChoices ??= new Map();
        const ids = database.pendingChoices.get(subscription) ?? new Set<string>();
        if (change.kind.startsWith('field.') && 'field' in change && change.field.id === dependency.field.id)
          subscription.choices.delete(dependency.field.id);
        ids.add(dependency.field.id);
        database.pendingChoices.set(subscription, ids);
      }
    }
    if (!database.pendingChoices?.size || database.choiceTimer) return;
    database.choiceTimer = setTimeout(() => {
      database.choiceTimer = undefined;
      const pending = database.pendingChoices!;
      database.pendingChoices = undefined;
      void this.enqueueChoices(database, () => this.refreshChoices(database, pending)).catch(() => {
        this.app.log.warn({ messageKey: 'errors.internal' }, 'select choices refresh failed');
      });
    }, 50);
    database.choiceTimer.unref();
  }

  private enqueueChoices(database: Database, work: () => Promise<void>): Promise<void> {
    const pending = (database.choiceTail ?? Promise.resolve()).then(work);
    database.choiceTail = pending.catch(() => undefined);
    return pending;
  }

  private async refreshChoices(database: Database, pending: Map<Subscription, Set<string>>): Promise<void> {
    await this.checkAccess(database);
    const { pool, schemas } = dataStore(this.app.ctx);
    const dependencies = await this.sourceDependencies(database);
    for (const [subscription, ids] of pending) {
      if (!this.current(database, subscription)) continue;
      const scope = new AccessScope(pool, schemas, subscription.tab.actor);
      if (!(await scope.databaseRole(database.id))) continue;
      await scope.prepare(database.id);
      const fields: Extract<ServerMessage, { type: 'selectOptions' }>['fields'] = [];
      for (const { field } of dependencies) {
        if (!ids.has(field.id) || !isSelect(field) || !scope.visibleFields(field.tableId, [field]).length)
          continue;
        let page = await sourceOptionsPage(pool, schemas, scope, field);
        const selected = subscription.choiceIds.get(field.id);
        if (selected?.length) {
          const extra = await sourceOptionsPage(pool, schemas, scope, field, { ids: selected });
          page = {
            ...page,
            choices: [
              ...new Map([...page.choices, ...extra.choices].map((choice) => [choice.id, choice])).values(),
            ],
          };
        }
        const fingerprint = JSON.stringify(page);
        if (subscription.choices.get(field.id) === fingerprint) continue;
        fields.push({ fieldId: field.id, ...page });
      }
      await this.checkAccess(database);
      if (
        fields.length &&
        this.current(database, subscription) &&
        subscription.tab.send({ type: 'selectOptions', databaseId: database.id, fields })
      )
        for (const { fieldId, ...page } of fields) subscription.choices.set(fieldId, JSON.stringify(page));
    }
  }

  private async deliver(
    database: Database,
    change: Change,
    subscriptions: Subscription[],
    refreshSchema = true,
  ): Promise<void> {
    await this.checkAccess(database);
    const recipients = subscriptions.filter((s) => this.current(database, s) && change.seq > s.seq);
    // Rules changed: nothing after this goes out under the old ones.  Every tab reads again what it
    // may now see.
    if (change.kind === 'access.changed') {
      for (const subscription of recipients) {
        subscription.tab.send({ type: 'reload', databaseId: database.id, reason: 'accessChanged' });
        this.remove(subscription.tab, database.id);
      }
      return;
    }
    const views = recipients.length ? await this.automationViews(change) : null;
    const { pool, schemas } = dataStore(this.app.ctx);
    if (changesSchema(change) && change.kind !== 'table.synced') database.sourceDependencies = undefined;
    await this.queueChoices(database, change, recipients);
    const delivered: Subscription[] = [];
    for (const subscription of recipients) {
      let outgoing: Change | null = views
        ? roleAllows(subscription.role, 'editSchema')
          ? views.editors
          : views.readers
        : change;
      // Someone a field or record rule limits gets each change as they may see it, and reloads
      // when a schema change moves what they may see.
      if (refreshSchema && changesSchema(change)) {
        const scope = new AccessScope(pool, schemas, subscription.tab.actor);
        const role = await scope.databaseRole(database.id);
        const fingerprint = role ? await scope.fingerprint(database.id) : null;
        if (
          role !== subscription.role ||
          !fingerprint ||
          ((subscription.scope.limited(database.id) || scope.limited(database.id)) &&
            fingerprint !== subscription.fingerprint)
        ) {
          subscription.tab.send({ type: 'reload', databaseId: database.id, reason: 'accessChanged' });
          this.remove(subscription.tab, database.id);
          continue;
        }
        // A new link adds dependencies even when neither database restricts this reader yet.
        subscription.scope = scope;
        subscription.fingerprint = fingerprint;
        subscription.dependencies = scope.dependencyFingerprint(database.id);
      }
      if (subscription.scope.limited(database.id)) {
        try {
          outgoing = await changeFor(pool, schemas, subscription.scope, database.id, outgoing);
        } catch {
          // A change that can't be read as this person can't be sent to them at all.
          subscription.tab.send({ type: 'reload', databaseId: database.id, reason: 'accessChanged' });
          this.remove(subscription.tab, database.id);
          continue;
        }
        if (!this.current(database, subscription)) continue;
        if (!outgoing) {
          subscription.seq = change.seq;
          delivered.push(subscription);
          continue;
        }
      }
      await this.checkAccess(database);
      if (!this.current(database, subscription)) continue;
      if (subscription.tab.send({ type: 'change', change: outgoing })) {
        subscription.seq = change.seq;
        delivered.push(subscription);
      }
    }
    if (change.kind === 'database.trashed') {
      for (const subscription of [...database.subscriptions.values()]) {
        subscription.tab.send({ type: 'reload', databaseId: database.id, reason: 'trashed' });
        this.remove(subscription.tab, database.id);
      }
      return;
    }
    const data = this.app.ctx.data;
    if (!data || !change.kind.startsWith('record.') || !('tableId' in change)) return;
    const watchers = delivered.flatMap((subscription) =>
      [...subscription.watches.values()]
        .filter((watch) => watch.tableId === change.tableId)
        .map((watch) => ({ subscription, watch })),
    );
    if (!watchers.length) return;
    const watches = new Map(
      watchers.map(({ watch }) => [
        JSON.stringify([watch.viewId, watch.snapshot]),
        {
          viewId: watch.viewId,
          snapshot: watch.snapshot,
        },
      ]),
    );
    try {
      const deltas = await data.viewDeltas(change, [...watches.values()]);
      await this.checkAccess(database);
      for (const { subscription, watch } of watchers) {
        if (!this.current(database, subscription) || subscription.watches.get(watch.viewId) !== watch)
          continue;
        const delta = deltas.find((d) => d.viewId === watch.viewId && d.snapshot === watch.snapshot);
        if (delta) subscription.tab.send({ type: 'viewDelta', databaseId: database.id, ...delta });
      }
    } catch {
      for (const { subscription } of watchers) {
        subscription.tab.send({ type: 'error', messageKey: 'errors.internal' });
      }
    }
  }

  private requireSubscription(tab: RealtimeTab, databaseId: string): Subscription {
    const subscription = this.databases.get(databaseId)?.subscriptions.get(tab);
    if (!subscription?.active) throw new AppError('not_found', 'errors.notFound');
    return subscription;
  }

  private async watch(
    tab: RealtimeTab,
    databaseId: string,
    viewId: string,
    snapshot: string | null,
  ): Promise<void> {
    const subscription = this.requireSubscription(tab, databaseId);
    if (snapshot === null) {
      subscription.watches.delete(viewId);
      return;
    }
    const { pool, schemas } = dataStore(this.app.ctx);
    const result = await query<{ table_id: string }>(
      pool,
      sql`
      SELECT v.table_id FROM ${ident(schemas.app, 'views')} v
      JOIN ${ident(schemas.app, 'tables')} t ON t.id = v.table_id
      WHERE v.id = ${viewId} AND t.database_id = ${databaseId}
        AND v.trashed_at IS NULL AND t.trashed_at IS NULL`,
    );
    const view = result.rows[0];
    if (!view) throw new AppError('not_found', 'errors.notFound');
    subscription.watches.set(viewId, { viewId, snapshot, tableId: view.table_id });
  }

  private locate(tab: RealtimeTab, databaseId: string, where: PresenceLocation | null): void {
    const subscription = this.requireSubscription(tab, databaseId);
    const notice: PresenceNotice = {
      databaseId,
      clientId: tab.clientId,
      userId: tab.actor.userId,
      name: tab.name,
      color: presenceColor(tab.actor.userId),
      where,
      timestamp: this.presence.timestamp(databaseId, tab.clientId),
    };
    // PostgreSQL refuses a payload of 8,000 bytes or more, and the limit applies to the sealed notice.
    if (Buffer.byteLength(sealNotice(this.app.ctx.config.secretKey, notice)) >= 8_000)
      throw new AppError('bad_request', 'errors.badRequest');
    subscription.presence = notice;
    this.presence.update(notice);
    this.publish(notice);
  }

  private publish(notice: PresenceNotice): void {
    const { pool, schemas } = dataStore(this.app.ctx);
    const publication = query(
      pool,
      sql`SELECT pg_notify(${presenceChannel(schemas)}, ${sealNotice(this.app.ctx.config.secretKey, notice)})`,
    )
      .then(() => undefined)
      .catch(() => {
        this.app.log.warn({ messageKey: 'errors.internal' }, 'realtime presence announcement failed');
      });
    this.publishing.add(publication);
    void publication.finally(() => this.publishing.delete(publication));
  }

  private sendPresence(databaseId: string): void {
    for (const subscription of this.databases.get(databaseId)?.subscriptions.values() ?? []) {
      if (subscription.active)
        subscription.tab.send({
          type: 'presence',
          databaseId,
          peers: peersFor(
            subscription.scope,
            databaseId,
            this.presence.peers(databaseId, subscription.tab.clientId),
          ),
        });
    }
  }

  private remove(tab: RealtimeTab, databaseId: string): void {
    const database = this.databases.get(databaseId);
    const subscription = database?.subscriptions.get(tab);
    if (!database || !subscription) return;
    database.subscriptions.delete(tab);
    if (subscription.presence) {
      const notice = {
        ...subscription.presence,
        left: true,
        timestamp: this.presence.timestamp(databaseId, tab.clientId),
      };
      this.presence.update(notice);
      this.publish(notice);
    }
    if (!database.subscriptions.size) {
      clearTimeout(database.choiceTimer);
      this.databases.delete(databaseId);
    }
  }

  detach(tab: RealtimeTab): void {
    tab.open = false;
    this.tabs.delete(tab);
    for (const databaseId of this.databases.keys()) this.remove(tab, databaseId);
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    const pending = [...this.databases.values()].map((database) => database.tail);
    for (const tab of this.tabs) {
      this.detach(tab);
      tab.terminate();
    }
    for (const connection of this.sessionConnections) connection.end();
    this.sessionConnections.clear();
    this.presence.close();
    await Promise.allSettled([...pending, ...this.publishing]);
    await this.listener?.close();
  }
}

/**
 * Where others are, as someone a rule limits may know it: no record in a table whose records a
 * rule limits for them, and no cell in a field they can't see.
 */
function peersFor(scope: AccessScope, databaseId: string, peers: PresencePeer[]): PresencePeer[] {
  if (!scope.limited(databaseId)) return peers;
  const hidden = scope.hiddenFieldIds(databaseId);
  return peers.map((peer) => {
    const where = peer.where;
    if (!where) return peer;
    let limitsRecords: boolean;
    try {
      limitsRecords = scope.limitsRecords(where.tableId);
    } catch {
      // A table these rules don't know yet is one to say nothing about.
      return { ...peer, where: null };
    }
    const { recordId, cell, ...rest } = where;
    return {
      ...peer,
      where: {
        ...rest,
        ...(recordId && !limitsRecords ? { recordId } : {}),
        ...(cell && !limitsRecords && !hidden.has(cell.fieldId) ? { cell } : {}),
      },
    };
  });
}

/** Who an organization or Home notice is for. */
type NoticeAudience =
  | { kind: 'person'; orgId: string; userId: string }
  | { kind: 'members'; orgId: string }
  | { kind: 'organization'; orgId: string };

/** Notices name one person, every member who isn't a guest, or, from older publishers, the organization. */
function audienceOf(payload: string): NoticeAudience {
  try {
    const value: unknown = JSON.parse(payload);
    if (value && typeof value === 'object' && 'orgId' in value && typeof value.orgId === 'string') {
      if ('userId' in value && typeof value.userId === 'string')
        return { kind: 'person', orgId: value.orgId, userId: value.userId };
      if ('audience' in value && value.audience === 'members') return { kind: 'members', orgId: value.orgId };
    }
  } catch {
    // Older notices are the organization's ID alone.
  }
  return { kind: 'organization', orgId: payload };
}

function reaches(actor: Actor, audience: NoticeAudience): boolean {
  if (actor.orgId !== audience.orgId) return false;
  if (audience.kind === 'person') return actor.userId === audience.userId;
  return audience.kind === 'organization' || actor.kind !== 'guest';
}

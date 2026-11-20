import {
  checkCellValue,
  LIMITS,
  newId,
  type SyncStatus,
  type TableSourceSettings,
  type WebhookConnection,
} from '@riosoma/contracts';
import { cellsOf, cellValue, sourceKey, valueAt, type CellReading, type FileCell } from '@riosoma/connectors';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { actorFor } from '../automations/run.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { publicField, publicTable, type CommandContext } from '../data/commands/context.js';
import { runCommands } from '../data/commands/index.js';
import { lock, recordChange } from '../data/commands/transaction.js';
import { loadFields, loadTable } from '../data/metadata.js';
import type { StoredField } from '../data/types.js';
import type { Actor } from '../http/policy.js';
import { notify, notifySync, reasonOf } from '../notifications/produce.js';
import type { SourceRow } from './store.js';
import { pruneHooks, readPost } from './webhook.js';

/**
 * Writes the posts a webhook accepted to the tables that sync from it.  Each table's records are
 * written through the command bus as the person who made the table, as if they'd typed them, so
 * automations run, history shows the change, and the person's own permissions hold: a post outside
 * their record rules is refused for that table.  A post is written whole or not at all for each
 * table, apart from records that name a select choice their field can't add, and a webhook's posts
 * are written in the order they came, one at a time.
 *
 * Each post is read from the text that arrived, the way the address read it, so a whole number too
 * long for a JavaScript number stays exact, and keys compare as that exact text.
 *
 * A post the sender was told was accepted is never dropped for a problem that passes, like a lock
 * that timed out, a deadlock, or a lost connection.  Then nothing it wrote to any table stays, and
 * it waits and tries again, 30 seconds later and twice as long each time, up to 15 minutes.  After
 * 10 tries over at least an hour, it's marked failed and kept, its delivery says so, and the
 * source's person hears once.  Only a refusal that would happen again, like a value the mapping
 * refuses, ends a post for a table.
 */

interface PostRow {
  delivery_id: string;
  source_id: string;
  body: string;
  records_path: string;
  split: boolean;
}

/** How a post that meets a passing problem tries again, and when it stops. */
export const POST_RETRIES = {
  /** Tries before it may stop */
  attempts: 10,
  /** And the least time since the first failed try, in minutes */
  minutes: 60,
  /** The first wait, in seconds, which doubles with each try */
  firstWaitSeconds: 30,
  /** The longest wait, in seconds */
  longestWaitSeconds: 900,
} as const;

/**
 * Error codes of problems that pass on their own: PostgreSQL's lock timeouts (`55P03`), deadlocks
 * (`40P01`), serialization failures (`40001`), statement timeouts (`57014`), a server shutting
 * down or starting (`57P01` to `57P03`), too many connections (`53300`), and any connection error
 * (class `08`), and the socket errors a lost connection shows up as.
 */
const TRANSIENT_CODES = new Set([
  '55P03',
  '40P01',
  '40001',
  '57014',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);
/** What the driver says when a connection ends or a query outlasts its deadline. */
const TRANSIENT_MESSAGES =
  /Connection terminated|Connection ended|Query read timeout|timeout exceeded when trying to connect|Client has encountered a connection error/i;

/** Whether a failure is one that passes on its own, here or in what caused it. */
export function transientFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    const code = 'code' in current && typeof current.code === 'string' ? current.code : '';
    if (TRANSIENT_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code)) return true;
    if (current instanceof Error && TRANSIENT_MESSAGES.test(current.message)) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

interface Target {
  table_id: string;
  database_id: string;
  org_id: string;
  created_by: string | null;
  settings: TableSourceSettings;
  status: SyncStatus;
}

/** A post a table refused, which leaves the table as it was. */
class Refused extends Error {
  constructor(readonly messageKey: string) {
    super(messageKey);
  }
}

const PLAIN: CellReading = { type: 'text', precision: 0, dateOrder: 'mdy' };

/** The cell at a path: a flattened column, or for a path deeper than the flattening, the value itself. */
function cellAt(
  record: Record<string, unknown>,
  cells: Map<string, FileCell>,
  path: string,
): FileCell | undefined {
  if (cells.has(path)) return cells.get(path);
  const value = valueAt(record, path);
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

/** A cell as a field takes it, with choices still as their names. */
function rawValue(field: StoredField, cell: FileCell | undefined): unknown {
  if (field.type === 'singleSelect') {
    const text = cellValue(cell, 'text', PLAIN);
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  }
  const includeTime =
    field.type === 'date' && Boolean((field.options as { includeTime?: boolean }).includeTime);
  return cellValue(cell, field.type, includeTime ? { ...PLAIN, type: 'dateTime' } : PLAIN);
}

/** The context a system change is recorded in, like a sync's. */
function systemContext(db: Queryable, schemas: DataSchemas, target: Target): CommandContext {
  return {
    db,
    schemas,
    databaseId: target.database_id,
    actor: { userId: '', orgId: target.org_id, sessionId: '', kind: 'owner', adminRoles: [], csrfToken: '' },
  };
}

type Item = { key: string | null; values: Record<string, unknown> };

/** The choice names a select value holds. */
function namesOf(value: unknown): string[] {
  return (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]).map(String);
}

/**
 * Adds the choices a post names that its select fields don't have yet, the way a sync does, and
 * gives each value its choice's ID.  A post comes from whoever holds the address, so a field takes
 * new names only up to its choice limit, in the order the post brings them, and only names short
 * enough to be one.  A record that names one it can't take is refused, and the rest are written.
 * Answers the records refused.
 */
async function withChoices(c: CommandContext, fields: StoredField[], items: Item[]): Promise<Set<Item>> {
  const refused = new Set<Item>();
  for (const field of fields) {
    if (field.type !== 'singleSelect' && field.type !== 'multipleSelect') continue;
    const choices = (field.options as { choices: Array<{ id: string; name: string; color: string }> })
      .choices;
    const known = new Set(choices.map((choice) => choice.name));
    const additions: Array<{ id: string; name: string; color: 'gray' }> = [];
    for (const item of items) {
      if (refused.has(item)) continue;
      for (const name of namesOf(item.values[field.id])) {
        if (known.has(name) || !name.trim() || name.length > LIMITS.nameLength) continue;
        if (choices.length + additions.length >= LIMITS.choicesPerField) break;
        known.add(name);
        additions.push({ id: newId('choice'), name, color: 'gray' });
      }
    }
    if (additions.length) {
      const before = publicField(field);
      field.options = { ...field.options, choices: [...choices, ...additions] } as typeof field.options;
      await query(
        c.db,
        sql`UPDATE ${ident(c.schemas.app, 'fields')} SET options = ${JSON.stringify(field.options)}::jsonb, updated_at = now() WHERE id = ${field.id}`,
      );
      await recordChange(
        c,
        {
          body: { kind: 'field.updated', field: publicField(field), removedChoiceIds: [] },
          prev: { field: { ...before, columnName: field.columnName } },
        },
        { commandId: newId('command'), groupId: newId('action'), clientId: null, system: true },
      );
    }
    const ids = new Map(
      (field.options as { choices: Array<{ id: string; name: string }> }).choices.map((choice) => [
        choice.name,
        choice.id,
      ]),
    );
    for (const item of items) {
      const value = item.values[field.id];
      if (refused.has(item) || value === null || value === undefined) continue;
      const found = namesOf(value).map((name) => ids.get(name));
      if (found.some((id) => id === undefined)) refused.add(item);
      else item.values[field.id] = Array.isArray(value) ? found : found[0]!;
    }
  }
  return refused;
}

export class InboundWriter {
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly app: FastifyInstance) {}

  private get ready(): boolean {
    return Boolean(this.app.ctx.pool && this.app.ctx.config.database);
  }

  start(): void {
    this.timer = setInterval(() => this.kick(), 5_000);
    this.timer.unref();
  }

  /** Writes what's waiting, soon, without holding up whoever asked. */
  kick(): void {
    if (this.stopped || !this.ready) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.loop().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** Writes everything waiting now, and waits until it's done. */
  async drain(): Promise<void> {
    while (this.running) await this.running;
    this.kick();
    while (this.running) await this.running;
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.running) await this.running;
  }

  private async loop(): Promise<void> {
    const { pool, schemas } = dataStore(this.app.ctx);
    try {
      while (!this.stopped && (await this.writeNext())) {
        /* One post at a time, until none is due. */
      }
    } catch (error) {
      this.app.log.warn({ err: error }, 'webhook posts could not be written');
    }
    try {
      await pruneHooks(pool, schemas);
    } catch (error) {
      this.app.log.warn({ err: error }, 'webhook samples and log bodies could not be pruned');
    }
  }

  /**
   * Writes the next post that's due whose webhook has no earlier post waiting.  A failed post
   * holds up no one.  False when none is due.
   */
  async writeNext(): Promise<boolean> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const posts = ident(schemas.app, 'source_hook_posts');
    let claimed: PostRow | undefined;
    try {
      return await withTransaction(pool, async (db) => {
        const found = await query<PostRow>(
          db,
          sql`SELECT p.delivery_id, p.source_id, p.body, p.records_path, p.split FROM ${posts} p
          WHERE p.failed_at IS NULL AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM ${posts} q WHERE q.source_id = p.source_id AND q.seq < p.seq AND q.failed_at IS NULL)
          ORDER BY p.seq LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        claimed = found.rows[0];
        if (!claimed) return false;
        await this.writePost(db, schemas, claimed);
        return true;
      });
    } catch (error) {
      // Whatever it wrote rolled back with the transaction, so the post tries again later, whole.
      if (!claimed) throw error;
      await this.postpone(claimed, error);
      return true;
    }
  }

  /** One post into every table that syncs from its webhook, and its delivery marked written. */
  private async writePost(db: Queryable, schemas: DataSchemas, post: PostRow): Promise<void> {
    const posts = ident(schemas.app, 'source_hook_posts');
    const source = (
      await query<SourceRow>(
        db,
        sql`SELECT * FROM ${ident(schemas.app, 'sources')} WHERE id = ${post.source_id}`,
      )
    ).rows[0];
    const targets = source
      ? (
          await query<Target>(
            db,
            sql`SELECT ts.table_id, ts.settings, ts.status, t.database_id, t.org_id, t.created_by
            FROM ${ident(schemas.app, 'table_sources')} ts
            JOIN ${ident(schemas.app, 'tables')} t ON t.id = ts.table_id
            JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id
            WHERE ts.source_id = ${post.source_id} AND t.trashed_at IS NULL AND d.trashed_at IS NULL
            ORDER BY t.database_id, ts.table_id`,
          )
        ).rows
      : [];
    // Read as it was accepted, with the parser the address used.
    const records = readPost({ records: post.records_path, split: post.split }, post.body);
    const errors: string[] = records ? [] : ['sources.webhook.writeFailed'];
    for (const target of records ? targets : []) {
      const started = Date.now();
      let error: string | null = null;
      let stats = { added: 0, changed: 0, refused: 0 };
      await query(db, sql`SAVEPOINT inbound_table`);
      try {
        stats = await this.writeTable(db, schemas, source!, post, records!, target);
        await query(db, sql`RELEASE SAVEPOINT inbound_table`);
      } catch (failure) {
        // A passing problem undoes every table's part, and the whole post tries again later.
        if (transientFailure(failure)) throw failure;
        await query(db, sql`ROLLBACK TO SAVEPOINT inbound_table`);
        error = failure instanceof Refused ? failure.messageKey : 'sources.webhook.writeFailed';
        if (!(failure instanceof Refused))
          this.app.log.warn(
            { err: failure, tableId: target.table_id },
            'a webhook post could not be written',
          );
      }
      if (error) errors.push(error);
      // Records that named a choice their field couldn't add are refused, and the rest stand.
      else if (stats.refused) errors.push('sources.webhook.choicesFull');
      await this.saveStatus(db, schemas, target, error, { ...stats, ms: Date.now() - started });
    }
    await query(db, sql`DELETE FROM ${posts} WHERE delivery_id = ${post.delivery_id}`);
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'source_hook_deliveries')} SET written = true,
      error = ${errors[0] ?? (targets.length ? null : 'sources.webhook.noTables')} WHERE id = ${post.delivery_id}`,
    );
  }

  /**
   * A post that met a problem waits to try again, and its delivery says so.  After enough tries
   * over long enough, it's marked failed and kept, and its source's person hears once.
   */
  private async postpone(post: PostRow, failure: unknown): Promise<void> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const posts = ident(schemas.app, 'source_hook_posts');
    this.app.log.warn(
      { err: failure, deliveryId: post.delivery_id, passing: transientFailure(failure) },
      'a webhook post will be tried again',
    );
    await withTransaction(pool, async (db) => {
      const found = await query<{ attempts: number; long: boolean }>(
        db,
        sql`SELECT attempts, first_failed_at <= clock_timestamp() - make_interval(mins => ${POST_RETRIES.minutes}) AS long
        FROM ${posts} WHERE delivery_id = ${post.delivery_id} AND failed_at IS NULL FOR UPDATE`,
      );
      const row = found.rows[0];
      if (!row) return;
      const attempts = row.attempts + 1;
      const failed = attempts >= POST_RETRIES.attempts && row.long === true;
      const wait = Math.min(
        POST_RETRIES.firstWaitSeconds * 2 ** row.attempts,
        POST_RETRIES.longestWaitSeconds,
      );
      await query(
        db,
        sql`UPDATE ${posts} SET attempts = ${attempts},
        first_failed_at = COALESCE(first_failed_at, clock_timestamp()),
        next_attempt_at = ${failed ? null : sql`clock_timestamp() + make_interval(secs => ${wait})`},
        failed_at = ${failed ? sql`clock_timestamp()` : null}
        WHERE delivery_id = ${post.delivery_id}`,
      );
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'source_hook_deliveries')}
        SET error = ${failed ? 'sources.webhook.gaveUp' : 'sources.webhook.retrying'} WHERE id = ${post.delivery_id}`,
      );
      if (!failed) return;
      const source = (
        await query<SourceRow>(
          db,
          sql`SELECT * FROM ${ident(schemas.app, 'sources')} WHERE id = ${post.source_id}`,
        )
      ).rows[0];
      if (source?.created_by)
        await notify(db, schemas, {
          orgId: source.org_id,
          recipientId: source.created_by,
          kind: 'webhookFailed',
          actorId: null,
          subjectId: source.id,
          target: { sourceId: source.id, sourceName: source.name },
        });
    });
  }

  /**
   * One post into one table, whole but for records naming a choice their field can't add, or a
   * refusal that leaves the table as it was.
   */
  private async writeTable(
    db: Queryable,
    schemas: DataSchemas,
    source: SourceRow,
    post: PostRow,
    records: Array<Record<string, unknown>>,
    target: Target,
  ): Promise<{ added: number; changed: number; refused: number }> {
    const settings = source.connection as WebhookConnection;
    // The database's lock comes first, as every command's does, so nothing waits on it in a cycle.
    await lock(systemContext(db, schemas, target), [`database:${target.database_id}`]);
    const person = target.created_by ? await actorFor(db, schemas, target.created_by, target.org_id) : null;
    if (!person) throw new Refused('sources.webhook.ownerGone');
    const { locale: _locale, ...owner } = person;
    const actor: Actor = { ...owner, source: { id: source.id, deliveryId: post.delivery_id } };
    const fields = (await loadFields(db, schemas, [target.table_id])).filter((field) => field.source);
    const keyColumns = target.settings.keyColumns;
    // A later record with the same key in one post stands for it, as a later post would.
    // Keys compare as text, and a long whole number's text is exactly what was sent.
    const items: Item[] = [];
    const byKey = new Map<string, number>();
    for (const record of records) {
      const cells = cellsOf(record, settings);
      const values: Record<string, unknown> = {};
      for (const field of fields)
        values[field.id] = rawValue(field, cellAt(record, cells, field.source!.column));
      if (!keyColumns.length) {
        items.push({ key: null, values });
        continue;
      }
      const parts = keyColumns.map((path) => cellValue(cellAt(record, cells, path), 'text', PLAIN));
      if (parts.some((part) => part === null || part === '')) throw new Refused('sources.sync.keyEmpty');
      const key = sourceKey(parts);
      const seen = byKey.get(key);
      if (seen === undefined) {
        byKey.set(key, items.length);
        items.push({ key, values });
      } else items[seen] = { key, values };
    }
    if (!items.length) return { added: 0, changed: 0, refused: 0 };
    const refused = await withChoices(systemContext(db, schemas, target), fields, items);
    const kept = items.filter((item) => !refused.has(item));
    if (!kept.length) return { added: 0, changed: 0, refused: refused.size };
    for (const item of kept)
      for (const field of fields) {
        const checked = checkCellValue(field, item.values[field.id] ?? null);
        // A value that doesn't fit its field arrives empty, as it does in a sync.
        item.values[field.id] = checked.ok ? checked.value : null;
      }
    const data = ident(schemas.data, target.table_id);
    const keys = kept.flatMap((item) => (item.key ? [item.key] : []));
    const found = keys.length
      ? await query<{ __id: string; __source_key: string }>(
          db,
          sql`SELECT __id, __source_key FROM ${data} WHERE __source_key = ANY(${keys}::text[])`,
        )
      : { rows: [] };
    const existing = new Map(found.rows.map((row) => [row.__source_key, row.__id]));
    const creates: Array<{ id: string; key: string | null; values: Record<string, unknown> }> = [];
    const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
    for (const item of kept) {
      const id = item.key ? existing.get(item.key) : undefined;
      if (id) updates.push({ id, values: item.values });
      else creates.push({ id: newId('record'), key: item.key, values: item.values });
    }
    const groupId = newId('action');
    const commands: Array<Record<string, unknown>> = [];
    if (creates.length)
      commands.push({
        id: newId('command'),
        groupId,
        kind: 'record.create',
        tableId: target.table_id,
        records: creates.map(({ id, values }) => ({ id, values })),
      });
    if (updates.length)
      commands.push({
        id: newId('command'),
        groupId,
        kind: 'record.update',
        tableId: target.table_id,
        records: updates,
      });
    const { results } = await runCommands(
      this.app,
      actor,
      target.database_id,
      { clientId: newId('client'), commands },
      db,
    );
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected) throw new Refused(rejected.error?.messageKey ?? 'sources.webhook.writeFailed');
    const marks = creates.map(({ id, key }) => ({ id, key }));
    await query(
      db,
      sql`UPDATE ${data} r SET __synced_at = now(), __source_key = COALESCE(m.key, r.__source_key)
      FROM jsonb_to_recordset(${JSON.stringify([...marks, ...updates.map(({ id }) => ({ id, key: null }))])}::jsonb) AS m(id text, key text)
      WHERE r.__id = m.id`,
    );
    return { added: creates.length, changed: updates.length, refused: refused.size };
  }

  /**
   * The table's status says when its last post came and how it went.  Clients hear only when it
   * starts or stops failing, since each post's records reach them anyway, and its person hears when
   * it starts.
   */
  private async saveStatus(
    db: Queryable,
    schemas: DataSchemas,
    target: Target,
    error: string | null,
    stats: { added: number; changed: number; ms: number },
  ): Promise<void> {
    const now = new Date().toISOString();
    const before = target.status;
    const status: SyncStatus = {
      ...before,
      state: error ? 'failed' : 'idle',
      lastSyncAt: now,
      lastSuccessAt: error ? before.lastSuccessAt : now,
      nextSyncAt: null,
      error: error ? { messageKey: error } : null,
      stats: error
        ? before.stats
        : {
            added: stats.added,
            changed: stats.changed,
            removed: 0,
            unchanged: 0,
            overridesCleared: 0,
            ms: stats.ms,
          },
      held: null,
    };
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'table_sources')} SET status = ${JSON.stringify(status)}::jsonb,
      failures = ${error ? sql`failures + 1` : sql`0`} WHERE table_id = ${target.table_id}`,
    );
    if ((before.state === 'failed') === Boolean(error)) return;
    const c = systemContext(db, schemas, target);
    const table = await loadTable(db, schemas, target.table_id);
    if (table)
      await recordChange(
        c,
        { body: { kind: 'table.updated', table: publicTable(table) }, prev: {} },
        { commandId: newId('command'), groupId: newId('action'), clientId: null, system: true },
      );
    if (error) await notifySync(db, schemas, 'syncFailed', target.table_id, { reason: reasonOf(error) });
  }
}

export function installInboundWriter(app: FastifyInstance): InboundWriter {
  const writer = new InboundWriter(app);
  app.ctx.inbound = writer;
  app.addHook('onReady', async () => {
    writer.start();
  });
  app.addHook('onClose', async () => {
    await writer.close();
  });
  return writer;
}

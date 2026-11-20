import { AppError, type AutomationConfig, type AutomationMeta, type Command } from '@riosoma/contracts';
import { compile, ident, query, sql, type Sql } from '@riosoma/db';
import { auditEvent } from '../auth/database.js';
import { missing, scopeOf, type CommandContext, type Mutation } from '../data/commands/context.js';
import { refuseWhileInReview } from '../data/organization-archives/review-guard.js';
import { fieldHidden, guardConfig } from '../data/permissions/config-guard.js';
import { mentionsAny } from '../data/permissions/redact.js';
import { sealMessages } from './messaging.js';
import { firstRunAfter } from './schedule.js';
import {
  automationMeta,
  editingConfig,
  loadAutomation,
  newWebhookSecret,
  type StoredAutomation,
} from './store.js';
import { validateConfig } from './validate.js';
import { canonical, loadVersion, pruneSecrets, pruneVersions, retirePublished } from './versions.js';

type AutomationCommand = Exclude<
  Extract<Command, { kind: `automation.${string}` }>,
  { kind: 'automation.calendarEvent' | 'automation.notify' }
>;

async function automation(c: CommandContext, id: string, includeTrashed = false): Promise<StoredAutomation> {
  // Credential migration updates this row too, so keep its values stable through the command
  const value = await loadAutomation(c.db, c.schemas, id, { lock: true });
  if (
    !value ||
    value.databaseId !== c.databaseId ||
    value.orgId !== c.actor.orgId ||
    (!includeTrashed && value.trashed)
  )
    return missing();
  return value;
}

function firstRun(config: AutomationConfig, enabled: boolean): Date | null {
  return enabled && config.trigger.kind === 'schedule' ? firstRunAfter(config.trigger, new Date()) : null;
}

async function changed(c: CommandContext, before: StoredAutomation): Promise<Mutation> {
  return {
    body: { kind: 'automation.updated', automation: automationMeta(await automation(c, before.id)) },
    prev: { automation: automationMeta(before) },
  };
}

function key(c: CommandContext): Buffer {
  if (!c.secretKey) throw new AppError('unavailable', 'errors.unavailable');
  return c.secretKey;
}

/** Fields the person can't see, which the settings they change may not use. */
async function hiddenFields(c: CommandContext): Promise<ReadonlySet<string>> {
  return (await scopeOf(c)).hiddenFieldIds(c.databaseId);
}

/**
 * Someone who can't see a field the automation uses can't change what it does, so they can't
 * publish, throw away, or bring back a configuration that uses one.
 */
function guardWhole(
  hidden: ReadonlySet<string>,
  ...configs: Array<AutomationConfig | null | undefined>
): void {
  if (configs.some((config) => mentionsAny(config, hidden))) throw fieldHidden();
}

/**
 * The draft's columns for a configuration, or for none.  A draft that's the same as the published
 * version is no draft, so changing something and changing it back leaves nothing to publish.
 */
function draftColumns(
  c: CommandContext,
  published: AutomationConfig,
  config: AutomationConfig | null,
  unpublished = false,
): Sql {
  const draft = config && (unpublished || canonical(config) !== canonical(published)) ? config : null;
  return sql`draft_config = ${draft === null ? null : JSON.stringify(draft)}::jsonb,
    draft_updated_at = ${draft === null ? null : sql`statement_timestamp()`},
    draft_updated_by = ${draft === null ? null : c.actor.userId}`;
}

/**
 * The automation commands.  They need the right to change the database's schema, which the
 * command bus checks before calling here, and they undo like views do.  The configuration people
 * change is the draft.  What runs changes only through `automation.publish`, and turning an
 * automation on or off applies to what's published.
 */
export async function applyAutomations(c: CommandContext, command: AutomationCommand): Promise<Mutation> {
  const table = ident(c.schemas.app, 'automations');
  switch (command.kind) {
    case 'automation.cancelRun': {
      const before = await automation(c, command.automationId);
      await (await scopeOf(c)).require(before.databaseId, 'editSchema');
      const result = await query(
        c.db,
        sql`UPDATE ${ident(c.schemas.app, 'automation_runs')}
        SET state = ${command.canceled ? sql`'canceled'` : sql`CASE WHEN wake_at IS NULL THEN 'queued' ELSE 'waiting' END`},
        finished_at = ${command.canceled ? sql`clock_timestamp()` : null}
        WHERE id = ${command.runId} AND automation_id = ${before.id}
        AND ${command.canceled ? sql`state IN ('queued', 'waiting')` : sql`state = 'canceled'`}`,
      );
      if (!result.rowCount) throw new AppError('conflict', 'errors.conflict');
      return {
        body: {
          kind: 'automation.runCanceled',
          automationId: before.id,
          runId: command.runId,
          canceled: command.canceled,
        },
        prev: {},
      };
    }
    case 'automation.create': {
      const input = command.automation;
      guardConfig(await hiddenFields(c), null, input.config);
      const secretKey = key(c);
      const existing = await query(c.db, sql`SELECT id FROM ${table} WHERE id = ${input.id}`);
      if (existing.rowCount) throw new AppError('conflict', 'errors.conflict');
      await validateConfig(c, input.config, !input.draftOnly);
      const sealed = await sealMessages(
        secretKey,
        input.id,
        c.actor.orgId,
        input.config,
        undefined,
        undefined,
        c.db,
        c.preview,
      );
      const secret = newWebhookSecret(secretKey, input.id);
      // Draft-only creations keep publication empty until a person publishes them.
      await query(
        c.db,
        sql`INSERT INTO ${table}
        (id, org_id, database_id, name, position, enabled, config, messaging_secrets, webhook_secret_hash, webhook_salt,
          created_by, version, published_at, published_by, draft_config, draft_updated_at, draft_updated_by)
        VALUES (${input.id}, ${c.actor.orgId}, ${c.databaseId}, ${input.name},
          ${command.position ?? sql`(SELECT COALESCE(max(position), -1) + 1 FROM ${table} WHERE database_id = ${c.databaseId})`},
          false, ${JSON.stringify(input.draftOnly ? { trigger: { kind: 'webhook' }, conditions: null, steps: [] } : sealed.config)}::jsonb, ${JSON.stringify(sealed.secrets)}::jsonb, ${secret.hash}, ${secret.salt},
          ${c.actor.userId}, 1, ${input.draftOnly ? null : sql`statement_timestamp()`}, ${input.draftOnly ? null : c.actor.userId},
          ${input.draftOnly ? JSON.stringify(sealed.config) : null}::jsonb,
          ${input.draftOnly ? sql`statement_timestamp()` : null}, ${input.draftOnly ? c.actor.userId : null})`,
      );
      return {
        body: { kind: 'automation.created', automation: automationMeta(await automation(c, input.id)) },
        prev: {},
      };
    }
    case 'automation.update': {
      const before = await automation(c, command.automationId);
      const secretKey = key(c);
      const editing = editingConfig(before);
      let draft = sql``;
      const secrets = before.messagingSecrets ?? {};
      let addedSecrets: Record<string, string> = {};
      if (command.config !== undefined) {
        // Someone who can't see a field the automation uses can't change what it does.
        const input = guardConfig(await hiddenFields(c), editing, command.config);
        // The same configuration, written with its keys in another order, isn't a change.
        if (canonical(input) !== canonical(editing)) {
          // Wire edits do not change step settings, so an unrelated missing field can remain in a draft.
          if (
            canonical({ ...input, connections: undefined }) !==
            canonical({ ...editing, connections: undefined })
          )
            await validateConfig(c, input);
          const sealed = await sealMessages(
            secretKey,
            before.id,
            c.actor.orgId,
            input,
            secrets,
            editing,
            c.db,
            c.preview,
          );
          // Existing entries may have moved or rotated, and every new credential has its own name
          addedSecrets = Object.fromEntries(
            Object.entries(sealed.secrets).filter(([name]) => !(name in secrets)),
          );
          draft = sql`, ${draftColumns(c, before.config, sealed.config, before.publishedAt === null)}`;
        }
      }
      const enabled = command.enabled ?? before.enabled;
      const turnedOn = enabled && !before.enabled;
      // An imported automation waiting for review turns on only from the review list.
      if (turnedOn) await refuseWhileInReview(c.db, c.schemas.app, c.actor.orgId, 'automation', before.id);
      if (turnedOn && before.publishedAt === null)
        throw new AppError('validation_failed', 'automations.draft.publishFirst');
      if (turnedOn) await validateConfig(c, before.config, true);
      // Turning it on makes it act as whoever did that.
      const runAsId = turnedOn ? c.actor.userId : before.runAsId;
      const nextRunAt =
        turnedOn || !before.nextRunAt ? firstRun(before.config, enabled) : enabled ? before.nextRunAt : null;
      await query(
        c.db,
        sql`UPDATE ${table} SET name = ${command.name ?? before.name}, enabled = ${enabled},
        messaging_secrets = messaging_secrets || ${JSON.stringify(addedSecrets)}::jsonb, run_as_id = ${runAsId},
        stopped_because = ${turnedOn ? null : before.stoppedBecause}, next_run_at = ${nextRunAt},
        updated_at = statement_timestamp() ${draft} WHERE id = ${before.id}`,
      );
      return changed(c, before);
    }
    case 'automation.publish': {
      const before = await automation(c, command.automationId);
      const draft = before.draft;
      if (!draft) throw new AppError('validation_failed', 'automations.draft.none');
      guardWhole(await hiddenFields(c), before.config, draft.config);
      await validateConfig(c, draft.config, true);
      const version = await retirePublished(c.db, c.schemas, before.id);
      // Changing what it does while it's on makes it act as whoever did that.
      await query(
        c.db,
        sql`UPDATE ${table} SET config = draft_config, version = ${version},
        published_at = statement_timestamp(), published_by = ${c.actor.userId},
        draft_config = NULL, draft_updated_at = NULL, draft_updated_by = NULL,
        run_as_id = ${before.enabled ? c.actor.userId : before.runAsId},
        next_run_at = ${firstRun(draft.config, before.enabled)},
        updated_at = statement_timestamp() WHERE id = ${before.id}`,
      );
      await pruneVersions(c.db, c.schemas, before.id, version);
      await auditEvent(
        c.db,
        compile(sql`${ident(c.schemas.audit)}`).text,
        'data.automation.published',
        c.actor,
        { databaseId: c.databaseId, automationId: before.id, version },
      );
      return changed(c, before);
    }
    case 'automation.discardDraft': {
      const before = await automation(c, command.automationId);
      if (before.publishedAt === null)
        throw new AppError('validation_failed', 'automations.draft.publishFirst');
      if (!before.draft) throw new AppError('validation_failed', 'automations.draft.none');
      guardWhole(await hiddenFields(c), before.draft.config);
      await query(
        c.db,
        sql`UPDATE ${table} SET ${draftColumns(c, before.config, null)}, updated_at = statement_timestamp()
        WHERE id = ${before.id}`,
      );
      // An address or token only the draft had goes with it.
      await pruneSecrets(c.db, c.schemas, before.id);
      return changed(c, before);
    }
    case 'automation.restoreVersion': {
      const before = await automation(c, command.automationId);
      const kept = await loadVersion(c.db, c.schemas, before, command.version);
      if (!kept) throw new AppError('not_found', 'automations.version.gone');
      guardWhole(await hiddenFields(c), before.draft?.config, kept.config);
      // It comes back as the draft, to look over and publish.  What runs stays as it is.
      await query(
        c.db,
        sql`UPDATE ${table} SET ${draftColumns(c, before.config, kept.config, before.publishedAt === null)}, updated_at = statement_timestamp()
        WHERE id = ${before.id}`,
      );
      return changed(c, before);
    }
    case 'automation.move': {
      const before = await automation(c, command.automationId);
      await query(
        c.db,
        sql`UPDATE ${table} SET position = ${command.position}, updated_at = statement_timestamp()
        WHERE id = ${before.id}`,
      );
      return changed(c, before);
    }
    case 'automation.trash':
    case 'automation.restore': {
      const before = await automation(c, command.automationId, true);
      const trash = command.kind === 'automation.trash';
      // A restored schedule picks up from now rather than running for the time it was away.
      await query(
        c.db,
        sql`UPDATE ${table} SET
        trashed_at = CASE WHEN ${trash} THEN statement_timestamp() ELSE NULL END,
        trashed_by = ${trash ? c.actor.userId : null},
        next_run_at = ${trash ? null : firstRun(before.config, before.enabled)},
        updated_at = statement_timestamp() WHERE id = ${before.id}`,
      );
      return {
        body: trash
          ? { kind: 'automation.trashed', automationId: before.id }
          : { kind: 'automation.restored', automation: automationMeta(await automation(c, before.id)) },
        prev: { trashed: before.trashed },
      };
    }
  }
}

/**
 * Puts an automation back as it was, for undo and redo: its name, place, whether it's on, and its
 * draft, and its published version when `republish` says the change being undone published
 * something.  That version comes back from the kept versions, so undoing a publish runs what ran
 * before, and redoing it runs what it published.  Undoing any other change, such as a draft save,
 * a rename, a move, or turning it on or off, leaves what's published alone, so it never takes back
 * a publish someone made since.  Who it acts as follows the same rule as the commands: whoever
 * turns it back on this way, or changes what runs while it's on, is that person from then on.  A
 * change saved before versions were kept brings its configuration back as the draft.
 */
export async function revertAutomation(
  c: CommandContext,
  target: AutomationMeta,
  republish: boolean,
): Promise<Mutation> {
  const before = await automation(c, target.id);
  const scope = await scopeOf(c);
  await scope.require(c.databaseId, 'editSchema');
  key(c);
  const hidden = scope.hiddenFieldIds(c.databaseId);
  const table = ident(c.schemas.app, 'automations');
  const legacy = target.version === undefined;
  let published = before.config;
  let version = before.version ?? 1;
  let publishedColumns = sql``;
  let unpublished = before.publishedAt === null;
  const publicationChanged = republish && target.publishedAt !== before.publishedAt;
  if (republish && target.version !== undefined && (target.version !== version || publicationChanged)) {
    guardWhole(hidden, before.config);
    // Kept first, so the version going away can come back too.
    await retirePublished(c.db, c.schemas, before.id);
    const kept =
      target.neverPublished === true
        ? { version: target.version, config: target.config, publishedAt: null, publishedBy: null }
        : await loadVersion(c.db, c.schemas, before, target.version);
    if (!kept) throw new AppError('not_found', 'automations.version.gone');
    guardWhole(hidden, kept.config);
    published = kept.config;
    version = kept.version;
    unpublished = target.neverPublished === true;
    // Older copies kept published versions without timestamps, including in undo snapshots.
    const publishedAt = unpublished ? null : (kept.publishedAt ?? new Date(target.updatedAt));
    publishedColumns = sql`, config = ${JSON.stringify(kept.config)}::jsonb, version = ${kept.version},
      published_at = ${publishedAt}, published_by = ${kept.publishedBy}`;
  }
  const draft = legacy ? target.config : (target.draft?.config ?? null);
  if (canonical(draft) !== canonical(before.draft?.config ?? null))
    guardWhole(hidden, before.draft?.config, draft);
  const liveChanged = version !== before.version || publicationChanged;
  const enabled = target.enabled;
  const turnedOn = enabled && !before.enabled;
  if (enabled && unpublished) throw new AppError('validation_failed', 'automations.draft.publishFirst');
  if (turnedOn || (enabled && liveChanged)) await validateConfig(c, published, true);
  // Turning it back on, or changing what runs while it's on, makes it act as whoever did that, as
  // the commands do.  What's published may have changed while it was off, so turning it back on
  // never keeps the person it acted as before.
  const runAsId = turnedOn || (enabled && liveChanged) ? c.actor.userId : before.runAsId;
  const nextRunAt =
    turnedOn || liveChanged || !before.nextRunAt
      ? firstRun(published, enabled)
      : enabled
        ? before.nextRunAt
        : null;
  await query(
    c.db,
    sql`UPDATE ${table} SET name = ${target.name}, position = ${target.position}, enabled = ${enabled},
    run_as_id = ${runAsId}, stopped_because = ${turnedOn ? null : before.stoppedBecause}, next_run_at = ${nextRunAt},
    ${draftColumns(c, published, draft, unpublished)}, updated_at = statement_timestamp() ${publishedColumns}
    WHERE id = ${before.id}`,
  );
  if (liveChanged) await pruneVersions(c.db, c.schemas, before.id, version);
  return changed(c, before);
}

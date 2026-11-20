import {
  AUTOMATION_VERSIONS_KEPT,
  AutomationConfig,
  flattenAutomationSteps,
  automationPaths,
  connectionAncestors,
  connectionLoopBody,
  type AutomationStep,
  type AutomationVersion,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from '../data/context.js';
import { isMessageStep, secretName } from './messaging.js';
import { storedConfig, type StoredAutomation } from './store.js';

/**
 * An automation's versions.  Its own row holds the published version, and `automation_versions`
 * the ones published before it, the newest 20.  Numbers count up and never come back, so a run's
 * version always names what it ran.
 */

/** JSON with object keys in order, so two configurations compare equal however they were written. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

interface VersionRow {
  version: number;
  config: unknown;
  published_at: Date | null;
  published_by: string | null;
}

export interface KeptVersion {
  version: number;
  config: AutomationConfig;
  publishedAt: Date | null;
  publishedBy: string | null;
}

const versions = (schemas: DataSchemas) => ident(schemas.app, 'automation_versions');

/** A version as it was published: the published one, or a kept one.  Null once it's no longer kept. */
export async function loadVersion(
  db: Queryable,
  schemas: DataSchemas,
  automation: StoredAutomation,
  version: number,
): Promise<KeptVersion | null> {
  if (version === automation.version && automation.publishedAt !== null)
    return {
      version,
      config: automation.config,
      publishedAt: automation.publishedAt ? new Date(automation.publishedAt) : null,
      publishedBy: automation.publishedBy ?? null,
    };
  const result = await query<VersionRow>(
    db,
    sql`SELECT version, config, published_at, published_by FROM ${versions(schemas)}
    WHERE automation_id = ${automation.id} AND version = ${version}`,
  );
  const row = result.rows[0];
  return row
    ? {
        version: Number(row.version),
        config: storedConfig(row.config, automation.messagingSecrets),
        publishedAt: row.published_at,
        publishedBy: row.published_by,
      }
    : null;
}

/**
 * Keeps the published version with the earlier ones as it stops being published, gives the next
 * number, and lets the oldest go past 20.  The caller then writes the new published version.
 */
export async function retirePublished(
  db: Queryable,
  schemas: DataSchemas,
  automationId: string,
): Promise<number> {
  const automations = ident(schemas.app, 'automations');
  await query(
    db,
    sql`INSERT INTO ${versions(schemas)} (automation_id, version, config, published_at, published_by)
    SELECT id, version, config, published_at, published_by FROM ${automations} WHERE id = ${automationId} AND published_at IS NOT NULL
    ON CONFLICT DO NOTHING`,
  );
  const next = await query<{ next: number }>(
    db,
    sql`SELECT GREATEST(CASE WHEN a.published_at IS NULL THEN 0 ELSE a.version END, COALESCE(max(v.version), 0)) + 1 AS next
    FROM ${automations} a LEFT JOIN ${versions(schemas)} v ON v.automation_id = a.id
    WHERE a.id = ${automationId} GROUP BY a.version, a.published_at`,
  );
  return Number(next.rows[0]!.next);
}

/**
 * Lets go of all but the newest 20 versions besides the published one, and then of the messaging
 * credentials only the versions let go of used.
 */
export async function pruneVersions(
  db: Queryable,
  schemas: DataSchemas,
  automationId: string,
  published: number,
): Promise<void> {
  await query(
    db,
    sql`DELETE FROM ${versions(schemas)} WHERE automation_id = ${automationId} AND version <> ${published}
    AND version NOT IN (
      SELECT version FROM ${versions(schemas)} WHERE automation_id = ${automationId} AND version <> ${published}
      ORDER BY version DESC LIMIT ${AUTOMATION_VERSIONS_KEPT}
    )`,
  );
  await pruneSecrets(db, schemas, automationId);
}

/**
 * Lets go of the sealed messaging credentials that neither the published version, the draft, nor
 * a kept version names anymore, so an address or token that was replaced or removed doesn't stay
 * sealed forever.  Publishing, discarding a draft, and pruning versions call this.  A draft save
 * doesn't, so undoing and redoing edits to the draft keeps finding the credentials they used
 * until one of those happens.  When a configuration can't be read, nothing is let go.
 */
export async function pruneSecrets(db: Queryable, schemas: DataSchemas, automationId: string): Promise<void> {
  const automations = ident(schemas.app, 'automations');
  const found = await query<{
    config: unknown;
    draft_config: unknown;
    messaging_secrets: Record<string, string> | null;
  }>(db, sql`SELECT config, draft_config, messaging_secrets FROM ${automations} WHERE id = ${automationId}`);
  const row = found.rows[0];
  const sealed = row?.messaging_secrets ?? {};
  if (!row || !Object.keys(sealed).length) return;
  const kept = await query<{ config: unknown }>(
    db,
    sql`SELECT config FROM ${versions(schemas)} WHERE automation_id = ${automationId}`,
  );
  const waiting = await query<{ config: unknown }>(
    db,
    sql`SELECT config_snapshot AS config FROM ${ident(schemas.app, 'automation_runs')}
    WHERE automation_id = ${automationId} AND state IN ('waiting', 'running', 'queued', 'canceled') AND config_snapshot IS NOT NULL`,
  );
  const used = new Set<string>();
  for (const value of [
    row.config,
    row.draft_config,
    ...kept.rows.map((version) => version.config),
    ...waiting.rows.map((run) => run.config),
  ]) {
    if (value === null || value === undefined) continue;
    const config = AutomationConfig.safeParse(value);
    if (!config.success) return;
    for (const step of flattenAutomationSteps(config.data.steps))
      if (isMessageStep(step)) used.add(secretName(step));
  }
  const names = Object.keys(sealed).filter((name) => used.has(name));
  if (names.length === Object.keys(sealed).length) return;
  const secrets = Object.fromEntries(names.map((name) => [name, sealed[name]!]));
  await query(
    db,
    sql`UPDATE ${automations} SET messaging_secrets = ${JSON.stringify(secrets)}::jsonb WHERE id = ${automationId}`,
  );
}

/** The published version and the kept ones, newest first. */
export async function listVersions(
  db: Queryable,
  schemas: DataSchemas,
  automation: StoredAutomation,
): Promise<AutomationVersion[]> {
  const kept = await query<VersionRow>(
    db,
    sql`SELECT version, config, published_at, published_by FROM ${versions(schemas)}
    WHERE automation_id = ${automation.id} AND (${automation.publishedAt === null} OR version <> ${automation.version})
    ORDER BY version DESC LIMIT ${AUTOMATION_VERSIONS_KEPT}`,
  );
  const summary = (
    version: number,
    config: AutomationConfig,
    publishedAt: Date | string | null,
    publishedBy: string | null,
    live: boolean,
  ): AutomationVersion => ({
    version,
    publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
    publishedBy,
    live,
    trigger: config.trigger.kind,
    steps: flattenAutomationSteps(config.steps).length,
  });
  return [
    ...(automation.publishedAt === null
      ? []
      : [
          summary(
            automation.version ?? 1,
            automation.config,
            automation.publishedAt ?? null,
            automation.publishedBy ?? null,
            true,
          ),
        ]),
    ...kept.rows.map((row) =>
      summary(Number(row.version), storedConfig(row.config), row.published_at, row.published_by, false),
    ),
  ].sort((a, b) => b.version - a.version);
}

/** A step as it counts for resuming: its name is only a label, so renaming it changes nothing. */
function stepKey(step: AutomationStep, wired = false): string {
  const { name: _name, ...rest } = step;
  if (rest.kind === 'if')
    return canonical({
      ...rest,
      then: wired ? [] : rest.then.map((item) => item.id),
      otherwise: wired ? [] : rest.otherwise.map((item) => item.id),
    });
  if (rest.kind === 'switch')
    return canonical({
      ...rest,
      cases: rest.cases.map((path) => ({ ...path, steps: wired ? [] : path.steps.map((item) => item.id) })),
      otherwise: wired ? [] : rest.otherwise.map((item) => item.id),
    });
  if (rest.kind === 'repeat')
    return canonical({ ...rest, steps: wired ? [] : rest.steps.map((item) => item.id) });
  return canonical(rest);
}

/**
 * Why a run of `ran` can't go on from `stepId` in `published`, or null when it can: the trigger
 * and its earlier steps have to be as they were.  Wired runs use their upstream connections,
 * and older runs retain their ordered paths.
 */
export function resumeRefusal(
  ran: AutomationConfig,
  published: AutomationConfig,
  stepId: string,
): { messageKey: string; detail?: string } | null {
  if (canonical(ran.trigger) !== canonical(published.trigger))
    return { messageKey: 'automations.resume.triggerChanged' };
  const pathOf = (steps: AutomationStep[], id: string, path: string[] = []): string | undefined => {
    for (const step of steps) {
      if (step.id === id) return path.join('/');
      for (const branch of automationPaths(step)) {
        const found = pathOf(branch.steps, id, [...path, step.id, branch.id]);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  if (
    (!ran.connections && pathOf(ran.steps, stepId) !== pathOf(published.steps, stepId)) ||
    (ran.loopItemCap ?? 1000) !== (published.loopItemCap ?? 1000) ||
    canonical(ran.connections ?? null) !== canonical(published.connections ?? null)
  )
    return { messageKey: 'automations.resume.stepChanged' };
  const beforeSteps = flattenAutomationSteps(ran.steps);
  const afterSteps = flattenAutomationSteps(published.steps);
  const at = beforeSteps.findIndex((step) => step.id === stepId);
  const now = afterSteps.findIndex((step) => step.id === stepId);
  if (at < 0 || now < 0) return { messageKey: 'automations.resume.stepGone' };
  if (ran.connections) {
    const earlier = connectionAncestors(ran, stepId);
    earlier.delete('trigger');
    for (const step of beforeSteps) {
      if (step.kind !== 'repeat' || !earlier.has(step.id)) continue;
      const body = connectionLoopBody(ran, step.id);
      if (!body.has(stepId)) for (const id of body) earlier.add(id);
    }
    for (const id of earlier) {
      const before = beforeSteps.find((step) => step.id === id);
      const after = afterSteps.find((step) => step.id === id);
      if (!before || !after || stepKey(before, true) !== stepKey(after, true))
        return { messageKey: 'automations.resume.stepChanged', detail: id };
    }
    return null;
  }
  for (let index = 0; index < Math.max(at, now); index += 1) {
    const before = beforeSteps[index];
    const after = afterSteps[index];
    if (!before || !after || index >= at || index >= now || stepKey(before) !== stepKey(after))
      return { messageKey: 'automations.resume.stepChanged', detail: String(index + 1) };
  }
  return null;
}

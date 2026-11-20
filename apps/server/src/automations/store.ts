import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AutomationConfig,
  mapAutomationSteps,
  flattenAutomationSteps,
  type AutomationMeta,
  type AutomationRun,
  type AutomationRunState,
  type AutomationTrigger,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { TokenValue } from './tokens.js';
import { isMessageStep, secretName } from './messaging.js';
import type { DataSchemas } from '../data/context.js';

/**
 * Reads automations and their runs into the shapes the rest of the server uses.  Writes live with
 * the commands, the triggers, and the engine.
 */

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

export interface AutomationRow {
  id: string;
  org_id: string;
  database_id: string;
  name: string;
  position: number;
  enabled: boolean;
  config: unknown;
  messaging_secrets?: Record<string, string>;
  run_as_id: string | null;
  stopped_because: string | null;
  webhook_secret_hash: string;
  webhook_salt: string;
  next_run_at: Date | null;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
  trashed_at: Date | null;
  version: number;
  published_at: Date | null;
  published_by: string | null;
  draft_config: unknown;
  draft_updated_at: Date | null;
  draft_updated_by: string | null;
}

/** An automation as the server keeps it: its public shape plus what never leaves the server. */
export interface StoredAutomation extends AutomationMeta {
  orgId: string;
  trashed: boolean;
  nextRunAt: Date | null;
  secretHash: string;
  salt: string;
  messagingSecrets?: Record<string, string>;
}

/** A stored configuration, with defaults added since it was saved and which credentials it has. */
export function storedConfig(value: unknown, secrets: Record<string, string> = {}): AutomationConfig {
  const config = AutomationConfig.parse(value);
  config.steps = mapAutomationSteps(config.steps, (step) => {
    if (!isMessageStep(step)) return step;
    const secretSaved = Boolean(secrets[secretName(step)]);
    return step.kind === 'sms'
      ? { ...step, authToken: '', secretSaved }
      : { ...step, webhookUrl: '', secretSaved };
  });
  return config;
}

export function toAutomation(row: AutomationRow): StoredAutomation {
  return {
    id: row.id,
    databaseId: row.database_id,
    name: row.name,
    position: Number(row.position),
    enabled: row.enabled,
    config: storedConfig(row.config, row.messaging_secrets),
    version: Number(row.version ?? 1),
    publishedAt: row.published_at ? iso(row.published_at) : null,
    publishedBy: row.published_by ?? null,
    draft:
      row.draft_config === null || row.draft_config === undefined
        ? null
        : {
            config: storedConfig(row.draft_config, row.messaging_secrets),
            updatedAt: iso(row.draft_updated_at ?? row.updated_at),
            updatedBy: row.draft_updated_by ?? null,
          },
    runAsId: row.run_as_id,
    stoppedBecause: row.stopped_because,
    lastRunAt: row.last_run_at ? iso(row.last_run_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    orgId: row.org_id,
    trashed: row.trashed_at !== null,
    nextRunAt: row.next_run_at,
    secretHash: row.webhook_secret_hash,
    salt: row.webhook_salt,
    messagingSecrets: row.messaging_secrets ?? {},
  };
}

/** The configuration someone editing the automation sees: the draft, or the published version. */
export function editingConfig(automation: Pick<StoredAutomation, 'config' | 'draft'>): AutomationConfig {
  return automation.draft?.config ?? automation.config;
}

/** The automation with its draft in place of the published version, as tests of the draft run it. */
export function asDraft(automation: StoredAutomation): StoredAutomation {
  return automation.draft ? { ...automation, config: automation.draft.config } : automation;
}

/** The public shape, without the webhook address, as changes carry it to everyone who can read. */
export function automationMeta(automation: StoredAutomation): AutomationMeta {
  const {
    orgId: _org,
    trashed: _trashed,
    nextRunAt: _next,
    secretHash: _hash,
    salt: _salt,
    webhookPath: _path,
    messagingSecrets: _messaging,
    ...meta
  } = automation;
  return { ...meta, neverPublished: meta.publishedAt === null };
}

export async function loadAutomations(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  options: { includeTrashed?: boolean } = {},
): Promise<StoredAutomation[]> {
  const result = await query<AutomationRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'automations')}
    WHERE database_id = ${databaseId} AND (${options.includeTrashed ?? false} OR trashed_at IS NULL)
    ORDER BY position, id`,
  );
  return result.rows.map(toAutomation);
}

/** One automation, trashed or not, or null when it doesn't exist. */
export async function loadAutomation(
  db: Queryable,
  schemas: DataSchemas,
  id: string,
  options: { lock?: boolean } = {},
): Promise<StoredAutomation | null> {
  const result = await query<AutomationRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'automations')} WHERE id = ${id}
    ${options.lock ? sql`FOR NO KEY UPDATE` : sql``}`,
  );
  return result.rows[0] ? toAutomation(result.rows[0]) : null;
}

export const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{43}$/;

export function secretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** The secret in an automation's webhook address, from the instance key and the automation's salt. */
function deriveSecret(key: Buffer, automationId: string, salt: string): string {
  return createHmac('sha256', key).update(`automation-webhook:${automationId}:${salt}`).digest('base64url');
}

/** A new webhook secret for an automation: the random salt it's derived from, and its hash. */
export function newWebhookSecret(key: Buffer, automationId: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('base64url');
  return { hash: secretHash(deriveSecret(key, automationId, salt)), salt };
}

/** Compares in constant time, and still does the work when there's nothing to compare with. */
export function secretMatches(expectedHash: string | undefined, secret: string): boolean {
  const expected = Buffer.from(expectedHash ?? '0'.repeat(64), 'hex');
  const actual = Buffer.from(secretHash(secret), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual) && expectedHash !== undefined;
}

/**
 * The webhook address `/api/hooks/<id>/<secret>`.  Null when the instance key has changed since
 * the secret was made, since calls with the secret it gives now would fail too.
 */
export function hookPath(
  key: Buffer,
  automation: Pick<StoredAutomation, 'id' | 'salt' | 'secretHash'>,
): string | null {
  const secret = deriveSecret(key, automation.id, automation.salt);
  return secretMatches(automation.secretHash, secret) ? `/api/hooks/${automation.id}/${secret}` : null;
}

/** The webhook address for webhook automations, or null for every other kind. */
export function webhookPath(key: Buffer, automation: StoredAutomation): string | null {
  return automation.config.trigger.kind === 'webhook' ? hookPath(key, automation) : null;
}

function origin(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch {
    return '';
  }
}

/**
 * The automation for people who can read the database but not change it.  Webhook calls often
 * carry their own secrets in the address, the headers, or the body, so those people see only the
 * host a step calls.
 */
export function readerAutomation(meta: AutomationMeta): AutomationMeta {
  // A draft isn't live, so it's for the people working on it.
  const { webhookPath: _path, ...rest } = { ...meta, ...(meta.draft === undefined ? {} : { draft: null }) };
  if (
    !flattenAutomationSteps(rest.config.steps).some(
      (step) => step.kind === 'callWebhook' || step.kind === 'script',
    )
  )
    return rest;
  return {
    ...rest,
    config: {
      ...rest.config,
      steps: mapAutomationSteps(rest.config.steps, (step) =>
        step.kind === 'script'
          ? { ...step, script: '', input: {} }
          : step.kind === 'callWebhook'
            ? {
                ...step,
                url: origin(step.url),
                headers: Object.fromEntries(Object.keys(step.headers).map((name) => [name, ''])),
                body: '',
              }
            : step,
      ),
    },
  };
}

/** The automation as a person reading the schema sees it: the address only for those who can change it. */
export function visibleAutomation(
  automation: StoredAutomation,
  key: Buffer | undefined,
  canChange: boolean,
): AutomationMeta {
  const meta = automationMeta(automation);
  if (!canChange) return readerAutomation(meta);
  if (!key || editingConfig(automation).trigger.kind !== 'webhook') return meta;
  return { ...meta, webhookPath: hookPath(key, automation) };
}

export type StepResult = AutomationRun['steps'][number] & {
  testStep?: boolean;
  /** Recorded values stay private to the executor */
  context?: Record<string, TokenValue>;
  /** A script step's own time, which the limit on a run's scripts counts where `ms` is the whole step's */
  scriptMs?: number;
};

export interface RunRow {
  id: string;
  seq: string;
  config_snapshot?: unknown;
  automation_id: string;
  org_id: string;
  database_id: string;
  state: AutomationRunState;
  trigger_kind: AutomationTrigger['kind'];
  record_id: string | null;
  body: unknown;
  test: boolean;
  actor_id: string | null;
  depth: number;
  steps: StepResult[];
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  lease_at: Date | null;
  lease_token: string | null;
  /** The published version it runs, set when it starts unless a rerun or a resume chose it */
  version: number | null;
  /** A test of the draft */
  draft: boolean;
  source_run_id: string | null;
  source_kind: 'rerun' | 'resume' | null;
  resume_step_id: string | null;
}

/**
 * A run as people see it.  `sourceAt` is when the run it came from started, or was queued if it
 * never started, while that run is still kept.
 */
export function runOf(row: RunRow, sourceAt?: Date | null): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    state: row.state,
    trigger: { kind: row.trigger_kind, recordId: row.record_id, at: iso(row.queued_at) },
    test: row.test,
    version: row.version ?? null,
    ...(row.draft ? { draft: true } : {}),
    ...(row.source_run_id && row.source_kind
      ? {
          from: {
            runId: row.source_run_id,
            kind: row.source_kind,
            ...(row.resume_step_id ? { stepId: row.resume_step_id } : {}),
            at: sourceAt ? iso(sourceAt) : null,
          },
        }
      : {}),
    ...(row.steps.some((step) => step.testStep) ? { testStepId: row.steps[0]?.stepId } : {}),
    steps: row.steps.map(({ context: _context, testStep: _testStep, scriptMs: _scriptMs, ...step }) => step),
    startedAt: row.started_at ? iso(row.started_at) : null,
    finishedAt: row.finished_at ? iso(row.finished_at) : null,
  };
}

export async function loadRun(db: Queryable, schemas: DataSchemas, id: string): Promise<RunRow | null> {
  const result = await query<RunRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'automation_runs')} WHERE id = ${id}`,
  );
  return result.rows[0] ?? null;
}

/** Reservations survive lease recovery, so an interrupted provider call still counts toward the cap. */
export async function reserveAiCost(
  db: Queryable,
  schemas: DataSchemas,
  run: { id: string; orgId: string; userId: string },
  amount: number,
  cap: number,
): Promise<boolean> {
  const result = await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'automation_runs')}
    SET ai_reserved_usd = ai_reserved_usd + ${amount}
    WHERE id = ${run.id} AND org_id = ${run.orgId} AND actor_id = ${run.userId}
      AND ai_reserved_usd + ${amount} <= ${cap}`,
  );
  return result.rowCount === 1;
}

import { createHash } from 'node:crypto';
import {
  AiSettings,
  AppError,
  UNIT_PRESETS,
  UNIT_POLICY_RULES,
  type AuditEntry,
  type AuditFilters,
  type AuditIntegrity,
  type AuditPage,
  type AuditQuery,
  type OrganizationPresetPreview,
  type OrgSettings,
  type SecondStepPolicy,
  type UnitPolicy,
  type UnitPreset,
} from '@riosoma/contracts';
import { compile, ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { Actor } from '../../http/policy.js';
import {
  effectivePolicy,
  organizationPolicy,
  validateSso,
  type PolicyLimits,
} from '../../org-units/policy.js';
import { AccessScope } from '../access.js';
import type { DataSchemas } from '../context.js';

export interface AdminContext {
  db: Queryable;
  schemas: DataSchemas;
  actor: Actor;
}
export const scope = (c: AdminContext) => new AccessScope(c.db, c.schemas, c.actor);
const quoted = (name: string) => compile(sql`${ident(name)}`).text;
export function digest(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : item;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export async function lockOrganization(c: AdminContext): Promise<void> {
  // Serialize settings and membership changes without blocking notification foreign-key checks.
  await query(
    c.db,
    sql`SELECT id FROM ${ident(c.schemas.app, 'orgs')} WHERE id = ${c.actor.orgId} FOR NO KEY UPDATE`,
  );
}

export async function memberRoles(c: AdminContext, userId: string, lock = false): Promise<string[]> {
  await scope(c).requireOrganizationAdmin('people', true);
  const result = await query<{ kind: string; admin_roles: string[] }>(
    c.db,
    sql`SELECT kind, admin_roles FROM ${ident(c.schemas.app, 'memberships')}
      WHERE org_id = ${c.actor.orgId} AND user_id = ${userId} ${lock ? sql`FOR NO KEY UPDATE` : sql``}`,
  );
  if (!result.rows[0]) throw new AppError('not_found', 'errors.notFound');
  if (result.rows[0].kind !== 'member') throw new AppError('conflict', 'orgUnits.admins.membersOnly');
  return result.rows[0].admin_roles;
}

export async function saveRoles(c: AdminContext, userId: string, roles: string[]): Promise<void> {
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'memberships')} SET admin_roles = ${roles}::text[]
    WHERE org_id = ${c.actor.orgId} AND user_id = ${userId}`,
  );
}

export interface PresetState {
  policy: UnitPolicy;
  secondStep: SecondStepPolicy;
  calendarFeeds: boolean;
  reportOutsideRecipients: boolean;
  automationSms: boolean;
  feedbackPublishing: boolean;
  features: { enabled: boolean; aiFields: boolean; automationDiagnose: boolean; routines: boolean };
}

async function presetState(c: AdminContext): Promise<PresetState> {
  const result = await query<{
    settings: OrgSettings;
    second_step_policy: SecondStepPolicy;
    calendar_feeds: boolean;
    report_outside_recipients: boolean;
    automation_sms_enabled: boolean;
    feedback_github_enabled: boolean;
    features: unknown;
  }>(
    c.db,
    sql`SELECT o.settings, o.second_step_policy, o.calendar_feeds, o.report_outside_recipients,
    o.automation_sms_enabled, o.feedback_github_enabled,
    (SELECT settings FROM ${ident(c.schemas.app, 'ai_settings')} WHERE org_id = o.id) AS features
    FROM ${ident(c.schemas.app, 'orgs')} o WHERE o.id = ${c.actor.orgId}`,
  );
  const row = result.rows[0];
  if (!row) throw new AppError('not_found', 'errors.notFound');
  const features = AiSettings.parse(row.features ?? { models: { everyday: null, power: null } });
  return {
    policy: organizationPolicy(row.settings).values,
    secondStep: row.second_step_policy,
    calendarFeeds: row.calendar_feeds,
    reportOutsideRecipients: row.report_outside_recipients,
    automationSms: row.automation_sms_enabled,
    feedbackPublishing: row.feedback_github_enabled,
    features: {
      enabled: features.enabled,
      aiFields: features.aiFields,
      automationDiagnose: features.automationDiagnose,
      routines: features.routines,
    },
  };
}

export async function previewPreset(
  c: AdminContext,
  preset: UnitPreset,
  limits: PolicyLimits,
): Promise<OrganizationPresetPreview & { before: PresetState; after: PresetState }> {
  await scope(c).requireOrganizationAdmin('security');
  const before = await presetState(c);
  const effective = await effectivePolicy(
    c.db,
    quoted(c.schemas.app),
    c.actor.orgId,
    { unitId: null },
    limits,
  );
  const values = UNIT_PRESETS[preset];
  const policy = { ...before.policy };
  for (const key of Object.keys(values) as Array<keyof UnitPolicy>) {
    if (UNIT_POLICY_RULES[key].organization === 'policy') Object.assign(policy, { [key]: values[key] });
    else delete policy[key];
  }
  const after: PresetState = {
    ...before,
    policy,
    secondStep: values.requireMfa === undefined ? before.secondStep : values.requireMfa ? 'everyone' : 'off',
    calendarFeeds: values.calendarFeeds ?? before.calendarFeeds,
    reportOutsideRecipients: values.reportOutsideRecipients ?? before.reportOutsideRecipients,
    automationSms: values.automationSms ?? before.automationSms,
    feedbackPublishing: values.feedbackPublishing ?? before.feedbackPublishing,
    features: {
      enabled: values.aiEnabled ?? before.features.enabled,
      aiFields: values.aiFields ?? before.features.aiFields,
      automationDiagnose: values.aiDiagnose ?? before.features.automationDiagnose,
      routines: values.aiRoutines ?? before.features.routines,
    },
  };
  const diff = (Object.keys(values) as Array<keyof UnitPolicy>).flatMap((key) => {
    const current = key === 'requireMfa' && before.secondStep === 'admins' ? 'admins' : effective.values[key];
    const value = values[key];
    return JSON.stringify(current) === JSON.stringify(value)
      ? []
      : [{ key, before: current, after: value, allowed: true }];
  });
  return { preset, revision: digest({ before, limits }), diff, before, after };
}

export async function currentPresetState(c: AdminContext): Promise<PresetState> {
  await scope(c).requireOrganizationAdmin('security');
  return presetState(c);
}

export async function savePresetState(c: AdminContext, state: PresetState): Promise<void> {
  await validateSso(c.db, quoted(c.schemas.app), c.actor.orgId, state.policy.requireSso);
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'orgs')} SET
    settings = jsonb_set(settings, '{unitPolicy}',
      COALESCE(settings->'unitPolicy', '{}'::jsonb) || jsonb_build_object('values', ${JSON.stringify(state.policy)}::jsonb)),
    second_step_policy = ${state.secondStep}, calendar_feeds = ${state.calendarFeeds},
    report_outside_recipients = ${state.reportOutsideRecipients}, automation_sms_enabled = ${state.automationSms},
    feedback_github_enabled = ${state.feedbackPublishing} WHERE id = ${c.actor.orgId}`,
  );
  const defaults = AiSettings.parse({ models: { everyday: null, power: null } });
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'ai_settings')} AS current (org_id, settings)
    VALUES (${c.actor.orgId}, ${JSON.stringify({ ...defaults, ...state.features })}::jsonb)
    ON CONFLICT (org_id) DO UPDATE SET settings = current.settings || ${JSON.stringify(state.features)}::jsonb`,
  );
}

const eventColumns = sql`e.id::text, e.chain_seq::text AS sequence, e.actor_id AS "actorId",
  u.name AS "actorName", e.action, e.target AS resource,
  to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
  e.metadata, e.prev_hash AS "prevHash", e.hash`;

function filtersSql(filters: AuditFilters): Sql {
  const contains = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
  return sql`TRUE
    ${filters.q ? sql`AND (e.action ILIKE ${contains(filters.q)} OR e.metadata::text ILIKE ${contains(filters.q)} OR e.target ILIKE ${contains(filters.q)} OR u.name ILIKE ${contains(filters.q)})` : sql``}
    ${filters.person ? sql`AND (e.actor_id = ${filters.person} OR u.name ILIKE ${contains(filters.person)} OR u.email ILIKE ${contains(filters.person)})` : sql``}
    ${filters.action ? sql`AND e.action ILIKE ${contains(filters.action)}` : sql``}
    ${
      filters.resource
        ? sql`AND (e.target ILIKE ${contains(filters.resource)} OR EXISTS (
      SELECT 1 FROM jsonb_each_text(e.metadata) item WHERE item.key LIKE '%Id' AND item.value ILIKE ${contains(filters.resource)}))`
        : sql``
    }
    ${filters.from ? sql`AND e.at >= ${filters.from}::timestamptz` : sql``}
    ${filters.to ? sql`AND e.at <= ${filters.to}::timestamptz` : sql``}`;
}

export async function auditPage(c: AdminContext, filters: AuditQuery, ceiling?: string): Promise<AuditPage> {
  await scope(c).requireOrganizationAdmin('audit');
  const result = await query<AuditEntry>(
    c.db,
    sql`SELECT ${eventColumns}
    FROM ${ident(c.schemas.audit, 'events')} e LEFT JOIN ${ident(c.schemas.app, 'users')} u ON u.id = e.actor_id
    WHERE e.org_id = ${c.actor.orgId} AND ${filtersSql(filters)}
      ${filters.before ? sql`AND e.chain_seq < ${filters.before}::bigint` : sql``}
      ${ceiling ? sql`AND e.chain_seq <= ${ceiling}::bigint` : sql``}
    ORDER BY e.chain_seq DESC LIMIT ${filters.limit + 1}`,
  );
  const events = result.rows.slice(0, filters.limit);
  return { events, next: result.rows.length > filters.limit ? events.at(-1)!.sequence : null };
}

export async function auditDetail(c: AdminContext, id: string): Promise<AuditEntry> {
  await scope(c).requireOrganizationAdmin('audit');
  const result = await query<AuditEntry>(
    c.db,
    sql`SELECT ${eventColumns}
    FROM ${ident(c.schemas.audit, 'events')} e LEFT JOIN ${ident(c.schemas.app, 'users')} u ON u.id = e.actor_id
    WHERE e.org_id = ${c.actor.orgId} AND e.id = ${id}::bigint`,
  );
  if (!result.rows[0]) throw new AppError('not_found', 'errors.notFound');
  return result.rows[0];
}

export async function auditCeiling(c: AdminContext): Promise<string> {
  await scope(c).requireOrganizationAdmin('audit');
  const result = await query<{ ceiling: string }>(
    c.db,
    sql`SELECT COALESCE(max(chain_seq), 0)::text AS ceiling
    FROM ${ident(c.schemas.audit, 'events')} WHERE org_id = ${c.actor.orgId}`,
  );
  return result.rows[0]!.ceiling;
}

export async function checkIntegrity(c: AdminContext): Promise<AuditIntegrity> {
  await scope(c).requireOrganizationAdmin('audit');
  const events = ident(c.schemas.audit, 'events');
  const result = await query<{ checked: string; firstBreak: string | null }>(
    c.db,
    sql`
    WITH retained AS (
      SELECT e.id, e.chain_seq, e.prev_hash, e.hash,
        ${ident(c.schemas.audit, 'event_hash')}(e) AS expected, false AS gone
      FROM ${events} e WHERE e.org_id = ${c.actor.orgId}
      UNION ALL
      -- An event a retention pass removed leaves its place and its hash, so its neighbors still
      -- link and the run stays unbroken.  Anything missing from both is a break.
      SELECT NULL::bigint, p.chain_seq, NULL::text, p.hash, p.hash, true
      FROM ${ident(c.schemas.audit, 'purged')} p WHERE p.org_id = ${c.actor.orgId}
    ), chain AS (
      SELECT *, lag(hash) OVER (ORDER BY chain_seq) AS previous,
        row_number() OVER (ORDER BY chain_seq) AS position
      FROM retained
    ) SELECT count(*) FILTER (WHERE NOT gone)::text AS checked,
      (SELECT COALESCE(
        (SELECT e.id::text FROM ${events} e WHERE e.org_id = ${c.actor.orgId}
          AND e.chain_seq >= chain.chain_seq ORDER BY e.chain_seq LIMIT 1),
        chain.chain_seq::text)
      FROM chain WHERE chain_seq <> position
        OR (NOT gone AND (prev_hash IS DISTINCT FROM previous OR hash <> expected))
      ORDER BY chain_seq LIMIT 1) AS "firstBreak" FROM chain`,
  );
  return { checked: Number(result.rows[0]!.checked), firstBreak: result.rows[0]!.firstBreak };
}

export async function recordAdminEvent(
  c: AdminContext,
  action: string,
  target: string | null,
  metadata: Record<string, unknown>,
): Promise<string> {
  const result = await query<{ id: string }>(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.audit, 'events')}
    (org_id, actor_id, action, target, metadata) VALUES (${c.actor.orgId}, ${c.actor.userId}, ${action},
      ${target}, ${JSON.stringify(metadata)}::jsonb) RETURNING id::text`,
  );
  return result.rows[0]!.id;
}

export async function undoEvent(
  c: AdminContext,
  id: string,
): Promise<{ action: string; target: string | null; metadata: Record<string, unknown> }> {
  const result = await query<{ action: string; target: string | null; metadata: Record<string, unknown> }>(
    c.db,
    sql`SELECT action, target, metadata FROM ${ident(c.schemas.audit, 'events')}
      WHERE org_id = ${c.actor.orgId} AND actor_id = ${c.actor.userId} AND id = ${id}::bigint
      AND action IN ('profile.update', 'people.role', 'people.status', 'organization.roles', 'organization.preset', 'organization.files.scanner.changed', 'organization.logo', 'organization.appearance')`,
  );
  if (!result.rows[0]) throw new AppError('not_found', 'errors.notFound');
  const undone = await query(
    c.db,
    sql`SELECT 1 FROM ${ident(c.schemas.audit, 'events')}
    WHERE org_id = ${c.actor.orgId} AND action = 'organization.undo' AND metadata->>'undoOf' = ${id}`,
  );
  if (undone.rowCount) throw new AppError('conflict', 'errors.conflict');
  return result.rows[0];
}

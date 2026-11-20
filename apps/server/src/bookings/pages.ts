import { policyAllows } from '../org-units/policy.js';
import { randomInt } from 'node:crypto';
import {
  AppError,
  BookingPageSettings,
  isBookingQuestionType,
  roleAllows,
  sameTheme,
  type BookingPage,
  type BookingPageInput,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { actorFor } from '../automations/run.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { holding } from '../payments/store.js';
import type { StoredField, StoredTable } from '../data/types.js';
import { refuseWhileInReview } from '../data/organization-archives/review-guard.js';
import type { RuntimeConfig } from '../config.js';
import { requireThemeChoice } from '../themes/choices.js';

/**
 * Booking pages, following `packages/contracts/src/booking-pages.ts`: storing them, checking the
 * fields they use, and the access they run with.  What visitors can do lives in `public.ts`.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A new page ID: 22 base-62 characters from the secure random source, with no bias. */
export function newBookingPageId(): string {
  let id = '';
  for (let i = 0; i < 22; i += 1) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}

export interface PageRow {
  id: string;
  org_id: string;
  database_id: string;
  table_id: string;
  owner_id: string | null;
  settings: unknown;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  /** Whether the organization has units or a unit policy, when the page's lookup read it */
  policy_relevant?: boolean;
}

const COLUMNS = sql`id, org_id, database_id, table_id, owner_id, settings, enabled, created_at, updated_at`;

/** Settings as stored, with defaults added since, or null when they no longer read at all. */
export function settingsOf(stored: unknown): BookingPageSettings | null {
  const parsed = BookingPageSettings.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** The fields a page uses, each checked. */
export interface PageFields {
  time: StoredField;
  resource: StoredField | null;
  name: StoredField;
  email: StoredField;
  questions: Array<{ field: StoredField; required: boolean }>;
}

/** A date field with a time, or a date range field with times: something a booking's time fits in. */
export function isTimeField(field: StoredField): boolean {
  return (field.type === 'date' || field.type === 'dateRange') && field.options.includeTime;
}

/**
 * The fields a page's settings name, among the fields someone may change.  Saving refuses a
 * question that doesn't fit.  Reading for visitors leaves one out instead, since a field changed
 * since the page was saved shouldn't stop it working, while a field it can't do without does.
 */
export function checkFields(
  settings: BookingPageSettings,
  fields: readonly StoredField[],
  canEdit: (field: StoredField) => boolean,
  saving: boolean,
): PageFields {
  const byId = new Map(fields.filter(canEdit).map((field) => [field.id, field]));
  const time = byId.get(settings.timeFieldId);
  if (!time || !isTimeField(time)) throw new AppError('validation_failed', 'bookings.settings.timeField');
  const resource = settings.resourceFieldId ? byId.get(settings.resourceFieldId) : null;
  if (
    resource === undefined ||
    (resource && (resource.type !== 'singleSelect' || !resource.options.choices.length))
  )
    throw new AppError('validation_failed', 'bookings.settings.resourceField');
  const name = byId.get(settings.nameFieldId);
  if (!name || name.type !== 'text') throw new AppError('validation_failed', 'bookings.settings.nameField');
  const email = byId.get(settings.emailFieldId);
  if (!email || email.type !== 'email')
    throw new AppError('validation_failed', 'bookings.settings.emailField');
  const special = [time.id, resource?.id, name.id, email.id].filter((id): id is string => Boolean(id));
  if (new Set(special).size !== special.length)
    throw new AppError('validation_failed', 'bookings.settings.sameField');
  const seen = new Set(special);
  const questions: PageFields['questions'] = [];
  for (const question of settings.questions) {
    const field = byId.get(question.fieldId);
    if (!field || !isBookingQuestionType(field.type) || seen.has(field.id)) {
      if (saving) throw new AppError('validation_failed', 'bookings.settings.question');
      continue;
    }
    seen.add(field.id);
    questions.push({ field, required: question.required });
  }
  return { time, resource: resource ?? null, name, email, questions };
}

/** What a page runs with: its owner's access, and the fields as the owner may use them. */
export interface PageAccess {
  settings: BookingPageSettings;
  owner: Actor & { locale: string };
  scope: AccessScope;
  table: StoredTable;
  fields: PageFields;
}

export type Inspection = { ok: true; access: PageAccess } | { ok: false; problem: string };

/**
 * Whether a page can take bookings as its owner, now.  It can't when the owner is gone or may no
 * longer add records to the table, when the table takes records only from a data source, or when
 * a field the page can't do without is gone, changed, or out of the owner's reach.
 */
export async function inspectPage(db: Queryable, schemas: DataSchemas, row: PageRow): Promise<Inspection> {
  const settings = settingsOf(row.settings);
  if (!settings) return { ok: false, problem: 'bookings.problem.fields' };
  const owner = row.owner_id ? await actorFor(db, schemas, row.owner_id, row.org_id) : null;
  if (!owner) return { ok: false, problem: 'bookings.problem.owner' };
  // A booking page is a public link, which the owner's unit may turn off.  An organization with no
  // units and no unit policy can't turn it off, so its pages check nothing more.
  if (row.policy_relevant !== false && !(await policyAllows(db, `"${schemas.app}"`, owner, 'publicLinks')))
    return { ok: false, problem: 'bookings.problem.publicLinks' };
  const scope = new AccessScope(db, schemas, owner);
  if (!roleAllows(await scope.databaseRole(row.database_id), 'editRecords'))
    return { ok: false, problem: 'bookings.problem.owner' };
  await scope.prepare(row.database_id);
  if (!scope.allowsUse(row.database_id, 'public', { tableId: row.table_id }))
    return { ok: false, problem: 'bookings.problem.publicLinks' };
  const table = await loadTable(db, schemas, row.table_id);
  if (!table || table.trashed) return { ok: false, problem: 'bookings.problem.fields' };
  if (table.source) return { ok: false, problem: 'bookings.problem.synced' };
  const fields = scope.visibleFields(table.id, await loadFields(db, schemas, [table.id]));
  try {
    const checked = checkFields(settings, fields, (field) => scope.canEditField(table.id, field), false);
    return { ok: true, access: { settings, owner, scope, table, fields: checked } };
  } catch {
    return { ok: false, problem: 'bookings.problem.fields' };
  }
}

export async function pageById(
  db: Queryable,
  schemas: DataSchemas,
  pageId: string,
  options: { forUpdate?: boolean } = {},
): Promise<PageRow | undefined> {
  const result = await query<PageRow>(
    db,
    options.forUpdate
      ? sql`SELECT ${COLUMNS} FROM ${ident(schemas.app, 'booking_pages')} WHERE id = ${pageId} FOR UPDATE`
      : sql`SELECT ${COLUMNS} FROM ${ident(schemas.app, 'booking_pages')} WHERE id = ${pageId}`,
  );
  return result.rows[0];
}

/**
 * Checks settings against the fields the person saving them may change.  A page runs as whoever
 * saved it last, so it can never ask about a field they couldn't fill in themselves.
 */
async function checkedFor(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  table: StoredTable,
  settings: BookingPageSettings,
): Promise<void> {
  const fields = scope.visibleFields(table.id, await loadFields(db, schemas, [table.id]));
  checkFields(settings, fields, (field) => scope.canEditField(table.id, field), true);
}

/** The table a page can be made on, with the person's right to change its schema checked. */
export async function pageTable(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  tableId: string,
): Promise<StoredTable> {
  const table = await loadTable(db, schemas, tableId);
  if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
  await scope.require(table.databaseId, 'editSchema');
  return table;
}

/** A page's own theme, when it picks a new one, has to be one the person saving may choose. */
async function checkTheme(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  settings: BookingPageSettings,
  before: BookingPageSettings | null,
  config: Pick<RuntimeConfig, 'themesDir'> | undefined,
): Promise<void> {
  if (settings.theme && !sameTheme(settings.theme, before?.theme))
    await requireThemeChoice(db, `"${schemas.app}"`, actor, settings.theme, config);
}

/** Settings apart from the page's theme, which changes how the page looks and nothing it does. */
function withoutTheme(settings: BookingPageSettings | null): Omit<BookingPageSettings, 'theme'> | null {
  if (!settings) return null;
  const { theme: _theme, ...rest } = settings;
  return rest;
}

export async function createPage(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  table: StoredTable,
  input: BookingPageInput,
  config?: Pick<RuntimeConfig, 'themesDir'>,
): Promise<PageRow> {
  // A synced table takes records only from its source, and a joined one only from its inputs, so
  // no one can book into either.
  if (table.source || table.joined) throw new AppError('forbidden', 'sources.syncedReadOnly');
  if (input.enabled) await scope.requireUse(table.databaseId, 'public', { tableId: table.id });
  await checkedFor(db, schemas, scope, table, input.settings);
  const actor = scope.actor;
  await checkTheme(db, schemas, actor, input.settings, null, config);
  const created = await query<PageRow>(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'booking_pages')}
      (id, org_id, database_id, table_id, owner_id, settings, enabled)
      VALUES (${newBookingPageId()}, ${actor.orgId}, ${table.databaseId}, ${table.id}, ${actor.userId},
        ${JSON.stringify(input.settings)}::jsonb, ${input.enabled})
      RETURNING ${COLUMNS}`,
  );
  const row = created.rows[0]!;
  await audit(db, schemas, actor.orgId, actor.userId, 'data.bookingPage.created', {
    databaseId: table.databaseId,
    tableId: table.id,
    pageId: row.id,
  });
  return row;
}

/**
 * Saves a page.  Changing its settings makes the person saving them its owner, since bookings
 * then do what they chose.  Turning it on or off leaves the owner as they were.
 */
export async function updatePage(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  table: StoredTable,
  row: PageRow,
  input: BookingPageInput,
  config?: Pick<RuntimeConfig, 'themesDir'>,
): Promise<PageRow> {
  const actor = scope.actor;
  if (input.enabled) await refuseWhileInReview(db, schemas.app, actor.orgId, 'bookingPage', row.id);
  if (input.enabled) await scope.requireUse(table.databaseId, 'public', { tableId: table.id });
  const before = settingsOf(row.settings);
  // A new theme changes only how the page looks, so it leaves the page's owner as they were.
  const changed = JSON.stringify(withoutTheme(before)) !== JSON.stringify(withoutTheme(input.settings));
  const themeChanged = !sameTheme(before?.theme, input.settings.theme);
  if (changed) {
    if (table.source || table.joined) throw new AppError('forbidden', 'sources.syncedReadOnly');
    await checkedFor(db, schemas, scope, table, input.settings);
  }
  if (themeChanged) await checkTheme(db, schemas, actor, input.settings, before, config);
  const updated = await query<PageRow>(
    db,
    sql`UPDATE ${ident(schemas.app, 'booking_pages')}
      SET settings = ${JSON.stringify(input.settings)}::jsonb, enabled = ${input.enabled},
        owner_id = ${changed ? actor.userId : row.owner_id}, updated_at = statement_timestamp()
      WHERE id = ${row.id} RETURNING ${COLUMNS}`,
  );
  const what = [
    ...(changed ? ['settings'] : []),
    ...(themeChanged ? ['theme'] : []),
    ...(input.enabled !== row.enabled ? ['enabled'] : []),
  ];
  if (what.length)
    await audit(db, schemas, actor.orgId, actor.userId, 'data.bookingPage.changed', {
      databaseId: row.database_id,
      tableId: row.table_id,
      pageId: row.id,
      changed: what,
      enabled: input.enabled,
    });
  return updated.rows[0]!;
}

export async function deletePage(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  row: PageRow,
): Promise<void> {
  // Deleting the page deletes its bookings and their cancel links, so a page with an upcoming
  // booking that's paid, or waiting for a payment still under way, is turned off instead.
  const active = await query(
    db,
    sql`SELECT 1 FROM ${ident(schemas.app, 'bookings')} b
      JOIN ${ident(schemas.app, 'payments')} p ON p.record_id = b.record_id
      JOIN ${ident(schemas.data, row.table_id)} r ON r.__id = b.record_id AND r.__deleted_at IS NULL
      WHERE b.page_id = ${row.id} AND b.canceled_at IS NULL
        AND b.ends_at > statement_timestamp() AND ${holding('p')} LIMIT 1`,
  );
  if (active.rows.length) throw new AppError('conflict', 'payments.activeBookings');
  await query(db, sql`DELETE FROM ${ident(schemas.app, 'payment_pages')} WHERE target_id = ${row.id}`);
  await query(db, sql`DELETE FROM ${ident(schemas.app, 'booking_pages')} WHERE id = ${row.id}`);
  await audit(db, schemas, actor.orgId, actor.userId, 'data.bookingPage.deleted', {
    databaseId: row.database_id,
    tableId: row.table_id,
    pageId: row.id,
  });
}

/** A table's pages as the people managing them see them, oldest first. */
export async function listPages(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
): Promise<BookingPage[]> {
  const result = await query<PageRow>(
    db,
    sql`SELECT ${COLUMNS} FROM ${ident(schemas.app, 'booking_pages')} WHERE table_id = ${tableId}
      ORDER BY created_at, id`,
  );
  const pages: BookingPage[] = [];
  for (const row of result.rows) pages.push(await pageOf(db, schemas, row));
  return pages;
}

export async function pageOf(db: Queryable, schemas: DataSchemas, row: PageRow): Promise<BookingPage> {
  const settings = settingsOf(row.settings);
  const facts = await query<{ name: string | null; upcoming: string }>(
    db,
    sql`SELECT (SELECT COALESCE(NULLIF(u.name, ''), u.email) FROM ${ident(schemas.app, 'users')} u
          WHERE u.id = ${row.owner_id}) AS name,
        (SELECT count(*) FROM ${ident(schemas.app, 'bookings')} b WHERE b.page_id = ${row.id}
          AND b.canceled_at IS NULL AND b.starts_at > statement_timestamp()) AS upcoming`,
  );
  const inspection = await inspectPage(db, schemas, row);
  return {
    pageId: row.id,
    tableId: row.table_id,
    path: `/b/${row.id}`,
    enabled: row.enabled,
    // Settings that no longer read are shown as the page was made, for the owner to fix.
    settings: settings ?? (row.settings as BookingPageSettings),
    owner: row.owner_id && facts.rows[0]?.name ? { id: row.owner_id, name: facts.rows[0].name } : null,
    upcoming: Number(facts.rows[0]?.upcoming ?? 0),
    problem: inspection.ok ? null : inspection.problem,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function audit(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  actorId: string | null,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.audit, 'events')} (org_id, actor_id, action, metadata)
      VALUES (${orgId}, ${actorId}, ${action}, ${JSON.stringify(metadata)}::jsonb)`,
  );
}

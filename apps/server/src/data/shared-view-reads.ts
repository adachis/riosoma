import { sparklineFields } from './sparklines.js';
import { isChangeLogEntry } from '@riosoma/contracts';
import { limitHistoryFields } from './physical/change-log.js';
import { resolveSelectOptions } from './select-options.js';
import { policyAllows, policyRelevant } from '../org-units/policy.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import {
  AppError,
  cellValue,
  checkCondition,
  EMPTY_STACK,
  GridConfig,
  isShareableViewType,
  SHARED_VIEW_LIMITS,
  requiredFieldIds,
  sharedFieldIds,
  type AttachmentMeta,
  type CellValue,
  type FieldSpec,
  type PositionResult,
  type RowData,
  type RowsQuery,
  type ShareableViewType,
  type SharedDownloadQuery,
  type SharedField,
  type SharedFileQuery,
  type SharedFileVariant,
  type SharedPositionQuery,
  type SharedRowsPage,
  type SharedRowsQuery,
  type SharedStackCounts,
  type SharedViewDisplay,
  type SharedViewOpen,
  type SharedViewSettings,
  type SharedViewTheme,
  type ViewMeta,
  type SharedViewAggregate,
  type ViewAggregateRequest,
} from '@riosoma/contracts';
import { compile, ident, join, query, sql, type Queryable, type Sql } from '@riosoma/db';
import { actorFor } from '../automations/run.js';
import type { Actor } from '../http/policy.js';
import { seal, unseal } from '../secrets.js';
import { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import { CSV_TYPE, csvStream } from './export/csv.js';
import { exportFileName } from './export/filename.js';
import { checkFormat, snapshotOrder, type ExportSource } from './export/source.js';
import { disposition } from './files/detect.js';
import { attachmentFilter } from './files/expressions.js';
import { attachmentMeta, loadFiles, type FileRow } from './files/metadata.js';
import { loadFields } from './metadata.js';
import { mentionsAny } from './permissions/redact.js';
import { columnRef } from './physical/columns.js';
import { relationalConditions } from './physical/conditional.js';
import { compileFilter } from './physical/filters.js';
import { formulaExpression } from './physical/formulas.js';
import { fetchPageByRid } from './physical/records.js';
import { displayExpr, linkedSource } from './physical/relations.js';
import { publicSharingPolicy } from './public-sharing.js';
import { shareSettings } from './shared-views.js';
import type { SnapshotCache, SnapshotRead } from './snapshots.js';
import type { ReadContext, StoredField, StoredTable } from './types.js';
import type { TileRecords } from './dashboards/tiles.js';
import {
  aggregateRecords,
  chartAggregate,
  pivotAggregate,
  viewPlan,
  isAnswer,
  fitsView,
} from './view-aggregates/compute.js';
import { groupLabelRows } from './view-aggregates/grid-groups.js';
import { selectViewRows, viewStackCounts } from './view-rows.js';

/**
 * What a shared view link lets anyone read, following `packages/contracts/src/shared-views.ts`.
 * Every read here goes through the view's own filter, compiled against every field the link reads
 * with, shared or not, so a condition on a field the link doesn't share still applies, and returns
 * values for the shared fields alone.  A filter with a condition that can never apply, or one on a
 * field the link's sharer can't see, closes the link instead of widening it.  Rows are read again
 * with the filter when a page is fetched, so a record edited out of the view since its order was
 * taken reads as missing rather than leaking out.
 */

/** Requests one address may make to shared views in a minute, unless the server says otherwise */
export const DEFAULT_MINUTE_LIMIT = 600;
/** Passwords one address may try on one link in a quarter hour */
export const PASSWORD_TRIES = { limit: 10, windowMs: 15 * 60_000 } as const;
/** Wrong passwords one link takes in a quarter hour, from every address together */
export const PASSWORD_LINK_TRIES = { limit: 100, windowMs: 15 * 60_000 } as const;
const PASSWORD_MS = SHARED_VIEW_LIMITS.passwordHours * 60 * 60_000;
/** Signed file addresses last between one and two of these, so a page reuses one for a while */
const FILE_WINDOW_SECONDS = 3600;

export function notAvailable(): AppError {
  return new AppError('not_found', 'shareView.notFound');
}

export function passwordRequired(): AppError {
  return new AppError('forbidden', 'shareView.passwordRequired');
}

/** Addresses are counted under a keyed hash, so the limiter never holds one. */
export function addressKey(key: Buffer, address: string): string {
  return createHmac('sha256', key).update(`riosoma.sharedView.address\n${address}`).digest('base64url');
}

/**
 * Counts requests per key in fixed windows, in this process's memory.  A flood of new keys only
 * forgets the oldest windows, which gives those keys a fresh count and nothing more.
 */
export class WindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 100_000,
  ) {}

  /** Counts one request.  Returns 0 when it may go ahead, or the seconds until the key may try again. */
  take(key: string, now = Date.now()): number {
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      if (window) this.windows.delete(key);
      else if (this.windows.size >= this.maxKeys) this.sweep(now);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit)
      return Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000));
    window.count += 1;
    return 0;
  }

  /** Takes one counted request back, as when a try that was counted first turns out to be right. */
  refund(key: string): void {
    const window = this.windows.get(key);
    if (window && window.count > 0) window.count -= 1;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows)
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(key);
    }
  }
}

/** A link that works right now: shared, with its view, table, and database all out of the trash. */
export interface LiveShare {
  id: string;
  orgId: string;
  databaseId: string;
  /** Who shared the view.  When rules or another database's records apply, the link reads as they would. */
  createdBy: string | null;
  table: StoredTable;
  view: ViewMeta & { type: ShareableViewType };
  settings: SharedViewSettings;
  passwordHash: string | null;
  databaseSettings: unknown;
  hasUnits: boolean;
}

interface LiveRow {
  id: string;
  org_id: string;
  database_id: string;
  created_by: string | null;
  settings: unknown;
  password_hash: string | null;
  view_id: string;
  view_name: string;
  view_type: string;
  view_config: unknown;
  view_position: number;
  view_created_by: string | null;
  view_created_at: Date;
  view_updated_at: Date;
  table_id: string;
  table_name: string;
  table_description: string;
  primary_field_id: string;
  table_position: number;
  data_version: string;
  table_created_at: Date;
  table_updated_at: Date;
  database_settings: unknown;
  sharer_suspended: boolean;
  policy_relevant: boolean;
  theme_policy_relevant: boolean;
}

export async function loadLiveShare(db: Queryable, schemas: DataSchemas, linkId: string): Promise<LiveShare> {
  const result = await query<LiveRow>(
    db,
    sql`SELECT s.id, s.org_id, s.database_id, s.created_by, s.settings, s.password_hash,
        v.id AS view_id, v.name AS view_name, v.type AS view_type, v.config AS view_config,
        v.position AS view_position, v.created_by AS view_created_by, v.created_at AS view_created_at,
        v.updated_at AS view_updated_at, t.id AS table_id, t.name AS table_name,
        t.description AS table_description, t.primary_field_id, t.position AS table_position,
        t.data_version, t.created_at AS table_created_at, t.updated_at AS table_updated_at,
        d.settings AS database_settings, COALESCE(u.deactivated_at IS NOT NULL, false) AS sharer_suspended,
        ${policyRelevant(schemas.app, sql`s.org_id`)} AS policy_relevant,
        ${policyRelevant(schemas.app, sql`s.org_id`, { unitsOnly: true })} AS theme_policy_relevant
      FROM ${ident(schemas.app, 'shared_views')} s
      LEFT JOIN ${ident(schemas.app, 'users')} u ON u.id = s.created_by
      JOIN ${ident(schemas.app, 'views')} v ON v.id = s.view_id
      JOIN ${ident(schemas.app, 'tables')} t ON t.id = v.table_id
      JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id
     WHERE s.id = ${linkId} AND s.stopped_at IS NULL
       AND d.id = s.database_id AND d.org_id = s.org_id
       AND v.trashed_at IS NULL AND t.trashed_at IS NULL AND d.trashed_at IS NULL`,
  );
  const row = result.rows[0];
  // A view changed to a type that can't be shared keeps its link, which works again if it changes back.
  if (!row || !isShareableViewType(row.view_type)) throw notAvailable();
  // A suspended person's links answer "gone" until they're reactivated, whatever the database's rules.
  if (row.sharer_suspended) throw new AppError('gone', 'shareView.notFound');
  // Public links turned off where its sharer is pause the link the same way.  An organization with
  // no units and no unit policy can't turn them off, so its links check nothing more.
  if (
    row.policy_relevant &&
    row.created_by &&
    !(await policyAllows(
      db,
      `"${schemas.app}"`,
      { orgId: row.org_id, userId: row.created_by },
      'publicLinks',
    ))
  )
    throw new AppError('gone', 'shareView.notFound');
  return {
    id: row.id,
    orgId: row.org_id,
    databaseId: row.database_id,
    createdBy: row.created_by,
    table: {
      id: row.table_id,
      orgId: row.org_id,
      databaseId: row.database_id,
      name: row.table_name,
      description: row.table_description,
      primaryFieldId: row.primary_field_id,
      position: Number(row.table_position),
      dataVersion: Number(row.data_version),
      createdAt: row.table_created_at.toISOString(),
      updatedAt: row.table_updated_at.toISOString(),
    },
    view: {
      id: row.view_id,
      tableId: row.table_id,
      name: row.view_name,
      type: row.view_type,
      // Parsing fills defaults added since the view was saved.
      config: GridConfig.parse(row.view_config ?? {}),
      position: Number(row.view_position),
      createdBy: row.view_created_by,
      createdAt: row.view_created_at.toISOString(),
      updatedAt: row.view_updated_at.toISOString(),
    },
    settings: shareSettings(row.settings),
    passwordHash: row.password_hash,
    databaseSettings: row.database_settings,
    hasUnits: row.theme_policy_relevant,
  };
}

const PASS_CONTEXT = 'riosoma.sharedView.password';
const Pass = z.object({ l: z.string(), s: z.string(), e: z.number() });

export function passCookieName(linkId: string): string {
  return `rio_view_${linkId}`;
}

/** The cookie goes only with requests for its own link. */
export function passCookiePath(linkId: string): string {
  return `/api/public/views/${linkId}`;
}

/** Stands for the password without revealing it.  A new password, even the same one again, changes it. */
function passStamp(key: Buffer, passwordHash: string): string {
  return createHmac('sha256', key).update(`riosoma.sharedView.stamp\n${passwordHash}`).digest('base64url');
}

/** Proof that someone gave this link's current password, sealed so only this server can read it. */
export function passCookie(key: Buffer, linkId: string, passwordHash: string, now = Date.now()): string {
  return seal(
    key,
    JSON.stringify({ l: linkId, s: passStamp(key, passwordHash), e: now + PASSWORD_MS }),
    `${PASS_CONTEXT}\n${linkId}`,
  );
}

/**
 * How the proof is stored.  An embedded view reads its cookie inside another site's page, which
 * only a partitioned, cross-site cookie survives, and those need a secure connection.
 */
export function passCookieOptions(linkId: string, secure: boolean, embeddable: boolean) {
  const framed = secure && embeddable;
  return {
    httpOnly: true,
    secure,
    sameSite: framed ? ('none' as const) : ('lax' as const),
    ...(framed ? { partitioned: true } : {}),
    path: passCookiePath(linkId),
    maxAge: PASSWORD_MS / 1000,
  };
}

export function passAccepted(
  key: Buffer,
  linkId: string,
  passwordHash: string,
  cookie: string | undefined,
  now = Date.now(),
): boolean {
  if (!cookie || cookie.length > 1_000) return false;
  try {
    const pass = Pass.parse(JSON.parse(unseal(key, cookie, `${PASS_CONTEXT}\n${linkId}`)));
    return (
      pass.l === linkId &&
      pass.s === passStamp(key, passwordHash) &&
      pass.e > now &&
      pass.e <= now + PASSWORD_MS
    );
  } catch {
    return false;
  }
}

/** Where a shared file was seen: in which record and field, read in which time zone. */
export interface FilePlace {
  linkId: string;
  recordId: string;
  fieldId: string;
  attachmentId: string;
  variant: SharedFileVariant;
  timeZone: string;
}

export function fileSignature(key: Buffer, place: FilePlace, expires: number): string {
  return createHmac('sha256', key)
    .update(
      [
        'riosoma.sharedView.file',
        place.linkId,
        place.recordId,
        place.fieldId,
        place.attachmentId,
        place.variant,
        place.timeZone,
        expires,
      ].join('\n'),
    )
    .digest('base64url');
}

/** True when this server signed the address for this very file and place, and it hasn't run out. */
export function fileAccepted(
  key: Buffer,
  place: FilePlace,
  input: SharedFileQuery,
  now = Date.now(),
  lifetimeSeconds = FILE_WINDOW_SECONDS,
): boolean {
  const seconds = now / 1000;
  if (input.expires <= seconds || input.expires > seconds + lifetimeSeconds) return false;
  const expected = Buffer.from(fileSignature(key, place, input.expires));
  const given = Buffer.from(input.signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function fileAddress(key: Buffer, place: FilePlace, expires: number): string {
  const { linkId, recordId, fieldId, attachmentId, variant, timeZone } = place;
  return `/api/public/views/${linkId}/files/${recordId}/${fieldId}/${attachmentId}/${variant}?${new URLSearchParams(
    { tz: timeZone, expires: String(expires), signature: fileSignature(key, place, expires) },
  ).toString()}`;
}

/**
 * File details for the public, with signed addresses in place of the app's own.  Each address
 * names the record and field the file was seen in, and works only while that record is still in
 * the view with the file in that field, the field is still shared, and the link still works.
 */
export function fileSigner(
  key: Buffer,
  linkId: string,
  timeZone: string,
  now = Date.now(),
  lifetimeSeconds = FILE_WINDOW_SECONDS,
) {
  const expires = Math.floor(now / 1000) + lifetimeSeconds;
  return (file: FileRow, recordId: string, fieldId: string): AttachmentMeta => {
    const url = (variant: SharedFileVariant) =>
      fileAddress(key, { linkId, recordId, fieldId, attachmentId: file.id, variant, timeZone }, expires);
    return {
      id: file.id,
      name: file.name,
      size: Number(file.size),
      type: file.type,
      width: file.width,
      height: file.height,
      createdAt: '',
      url: url('file'),
      thumbnails: {
        small: file.thumbnails?.small ? url('small') : null,
        large: file.thumbnails?.large ? url('large') : null,
      },
    };
  };
}
export type FileSigner = ReturnType<typeof fileSigner>;

/** A link's view as the public may read it. */
export interface SharedRead {
  live: LiveShare;
  schemas: DataSchemas;
  /** Every field of the table: the view's filter, sorts, stacks, and dates may use any of them */
  fields: StoredField[];
  /** The shared fields the view shows, in its order */
  shown: StoredField[];
  /** The shared fields only the view's layout needs */
  hidden: StoredField[];
  /** Every shared field: the shown ones, then the hidden ones */
  shared: StoredField[];
  /** The access the link reads with: its sharer's, when rules or another database's records apply */
  scope: AccessScope;
  /** Which records the link may show at all, before the view's filter */
  allowed: Sql;
  publicFiles: boolean;
}

/**
 * The access a link reads with.  A database without field or record rules, whose links all stay
 * inside it, reads as it always has.  One with rules, or one linked to another database, reads as
 * the person who shared the view would, so a link never shows a record or a linked record they
 * couldn't see, and it stops working when they can no longer open the database.  A field
 * restricted from anyone, or computed from one, never goes out through a link.
 */
async function sharerAccess(
  db: Queryable,
  schemas: DataSchemas,
  live: LiveShare,
  all: StoredField[],
): Promise<{ scope: AccessScope; fields: StoredField[]; allowed: Sql; restricted: Set<string> }> {
  const sharer = live.createdBy ? await actorFor(db, schemas, live.createdBy, live.orgId) : null;
  const scope = new AccessScope(db, schemas, sharer ?? nobodyIn(live.orgId));
  await scope.prepare(live.databaseId);
  scope.requireTableUse(live.table.id, 'public');
  // Another database's roles and rules decide what a link to it shows, whatever this one's say.
  if (
    !all.some((field) => field.source?.sourceType === 'joined') &&
    !(await scope.hasRules(live.databaseId)) &&
    !scope.readsOtherDatabases(live.databaseId)
  )
    return { scope, fields: all, allowed: sql`TRUE`, restricted: new Set() };
  if (!sharer || !(await scope.databaseRole(live.databaseId))) throw notAvailable();
  return { scope, ...publicAccess(scope, live.table.id, all) };
}

/**
 * What anything public reads of a table through the person behind it: the fields they see, the
 * records they see, and the fields restricted from anyone, or computed from one.  Those never go
 * out publicly, whoever is behind the page.  View links and published sites both read this way.
 */
export function publicAccess(
  scope: AccessScope,
  tableId: string,
  all: readonly StoredField[],
): { fields: StoredField[]; allowed: Sql; restricted: Set<string> } {
  scope.requireTableUse(tableId, 'public');
  scope.usePublicFields();
  const restricted = new Set(
    all.filter((field) => scope.restrictedForAnyone(tableId, field)).map((field) => field.id),
  );
  const visible = scope.visibleFields(tableId, all);
  return {
    fields: limitHistoryFields(
      visible,
      new Set(visible.filter((field) => !restricted.has(field.id)).map((field) => field.id)),
    ),
    allowed: scope.recordPredicate(tableId),
    restricted,
  };
}

/**
 * Whether a view filters, sorts, colors, sums, or lays out by any of these fields.  Anything
 * public read through such a view would show something of them, so it stops until the view
 * stops using them.  Which fields it shows, in what order and width, tells nothing.
 */
export function viewShapedBy(config: GridConfig, ids: ReadonlySet<string>): boolean {
  const {
    fieldOrder: _order,
    hiddenFieldIds: _hidden,
    columnWidths: _widths,
    headerColors: _headers,
    columnGroups: _groups,
    pinnedRecordIds: _pins,
    ...shaping
  } = config;
  return mentionsAny(shaping, ids);
}

/** No one in particular: reads through it see no restricted field and follow no person's rules. */
function nobodyIn(orgId: string): Actor {
  return { userId: '', orgId, sessionId: '', kind: 'guest', adminRoles: [], csrfToken: '' };
}

export async function sharedRead(db: Queryable, schemas: DataSchemas, live: LiveShare): Promise<SharedRead> {
  const all = await loadFields(db, schemas, [live.table.id]);
  const { scope, fields: accessible, allowed, restricted } = await sharerAccess(db, schemas, live, all);
  let fields = await sparklineFields(
    db,
    schemas,
    scope,
    await resolveSelectOptions(db, schemas, undefined, accessible),
    live.view.config.sparklines,
  );
  // A view that needs a restricted field, or is shaped by one, would show something of it through
  // the link, so the link stops working until the view stops using it.
  if (
    requiredFieldIds(live.view, all, live.table.primaryFieldId).some((id) => restricted.has(id)) ||
    viewShapedBy(live.view.config, restricted)
  )
    throw notAvailable();
  const ids = sharedFieldIds(live.view, fields, live.table.primaryFieldId, live.settings);
  fields = limitHistoryFields(fields, new Set(ids.shown.filter((id) => !restricted.has(id))));
  const byId = new Map(fields.map((field) => [field.id, field]));
  // Reading applies the view's filter with these fields alone, and leaves out a condition that can
  // never apply: one on a field that's gone, one on a field the link's sharer can't see, or one
  // whose operator its field no longer offers.  The page would then show records the view was
  // filtering out, so the link stops until the filter is mended.  A condition still missing its
  // value is no condition yet, here as in the app.
  if (
    relationalConditions(live.view.config.filter ?? undefined).some(
      (condition) => !checkCondition(byId.get(condition.fieldId), condition).valid,
    )
  )
    throw notAvailable();
  const pick = (list: readonly string[]) =>
    list.filter((id) => !restricted.has(id)).flatMap((id) => byId.get(id) ?? []);
  const shown = pick(ids.shown);
  const hidden = pick(ids.hidden);
  return {
    live,
    schemas,
    fields,
    shown,
    hidden,
    shared: [...shown, ...hidden],
    scope,
    allowed,
    publicFiles: (await publicSharingPolicy(db, schemas, live.orgId)).publicFiles,
  };
}

/** The field whose values a field shows: itself, or for a lookup, the field it looks up in the end. */
export function shownAs(field: StoredField): StoredField {
  let target = field;
  const seen = new Set<string>();
  while (target.type === 'lookup' && target.relation?.target && !seen.has(target.id)) {
    seen.add(target.id);
    target = target.relation.target;
  }
  return target;
}

/** The options that shape how a field's values look, and none that describe the rest of the database. */
function displayOptions(field: FieldSpec): Record<string, unknown> {
  switch (field.type) {
    case 'number': {
      const { precision, thousands, allowNegative } = field.options;
      return { precision, thousands, allowNegative };
    }
    case 'checkbox':
      return { color: field.options.color };
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime': {
      const { includeTime, dateFormat, timeFormat, timeZone } = field.options;
      return { includeTime, dateFormat, timeFormat, timeZone };
    }
    case 'singleSelect':
    case 'multipleSelect':
      return { choices: field.options.choices.map(({ id, name, color }) => ({ id, name, color })) };
    case 'lineItems':
    case 'link':
      return { prefersSingle: field.options.prefersSingle };
    case 'lookup':
      return { resultType: field.options.resultType };
    case 'rollup': {
      const { fn, precision, resultType } = field.options;
      return { fn, precision, resultType };
    }
    case 'formula': {
      const { resultType, precision, dateFormat, timeFormat, timeZone } = field.options;
      return { resultType, precision, dateFormat, timeFormat, timeZone };
    }
    case 'time':
      return { timeFormat: field.options.timeFormat };
    case 'multiCurrency':
    case 'currency': {
      const { code, precision, allowNegative } = field.options;
      return { code, precision, allowNegative };
    }
    case 'percent': {
      const { precision, allowNegative } = field.options;
      return { precision, allowNegative };
    }
    case 'duration':
      return { format: field.options.format };
    case 'rating': {
      const { max, icon, color } = field.options;
      return { max, icon, color };
    }
    case 'user':
      return { allowMultiple: field.options.allowMultiple };
    case 'longText':
      return { richText: field.options.richText };
    default:
      return {};
  }
}

export function publicField(field: StoredField): SharedField {
  const target = shownAs(field);
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    options: displayOptions(field),
    ...(target !== field ? { lookup: { type: target.type, options: displayOptions(target) } } : {}),
  };
}

function display(read: SharedRead, stackPeople: ReadonlySet<string>): SharedViewDisplay {
  const { view } = read.live;
  const config = view.config;
  const shared = new Map(read.shared.map((field) => [field.id, field]));
  const own = (id: string | null) => (id && shared.has(id) ? id : null);
  const defaults = GridConfig.parse({});
  const stackField = shared.get(config.kanban.stackFieldId ?? '');
  // Stacks are choices or people.  Only people with cards in the view are named to the public.
  const stack = (id: string) =>
    id === EMPTY_STACK ||
    (stackField?.type === 'singleSelect'
      ? stackField.options.choices.some((choice) => choice.id === id)
      : stackPeople.has(id));
  return {
    headerColors: Object.fromEntries(Object.entries(config.headerColors).filter(([id]) => shared.has(id))),
    columnGroups: config.columnGroups.flatMap((group) => {
      const fieldIds = group.fieldIds.filter((id) => shared.has(id));
      return fieldIds.length ? [{ ...group, fieldIds }] : [];
    }),
    groups: config.groups.filter((group) => shared.has(group.fieldId)),
    summaries: Object.fromEntries(Object.entries(config.summaries).filter(([id]) => shared.has(id))),
    hiddenFieldIds: read.hidden.map((field) => field.id),
    columnWidths: Object.fromEntries(Object.entries(config.columnWidths).filter(([id]) => shared.has(id))),
    frozenFieldCount: config.frozenFieldCount,
    rowHeight: config.rowHeight,
    kanban:
      view.type === 'kanban'
        ? {
            ...config.kanban,
            stackFieldId: own(config.kanban.stackFieldId),
            coverFieldId: own(config.kanban.coverFieldId),
            stackOrder: config.kanban.stackOrder.filter(stack),
            hiddenStacks: config.kanban.hiddenStacks.filter(stack),
          }
        : defaults.kanban,
    gallery:
      view.type === 'gallery'
        ? { ...config.gallery, coverFieldId: own(config.gallery.coverFieldId) }
        : defaults.gallery,
    calendar:
      view.type === 'calendar'
        ? {
            ...config.calendar,
            startFieldId: own(config.calendar.startFieldId),
            endFieldId: own(config.calendar.endFieldId),
          }
        : defaults.calendar,
    timeline:
      view.type === 'timeline'
        ? {
            ...config.timeline,
            startFieldId: own(config.timeline.startFieldId),
            endFieldId: own(config.timeline.endFieldId),
            groupFieldId: own(config.timeline.groupFieldId),
            labelFieldId: own(config.timeline.labelFieldId),
          }
        : defaults.timeline,
    gantt:
      view.type === 'gantt'
        ? {
            ...config.gantt,
            startFieldId: own(config.gantt.startFieldId),
            endFieldId: own(config.gantt.endFieldId),
            dependencyFieldId: own(config.gantt.dependencyFieldId),
            progressFieldId: own(config.gantt.progressFieldId),
            labelFieldId: own(config.gantt.labelFieldId),
          }
        : defaults.gantt,
    chart:
      view.type === 'chart'
        ? {
            ...config.chart,
            groupBy: config.chart.groupBy && own(config.chart.groupBy.fieldId) ? config.chart.groupBy : null,
            seriesBy: own(config.chart.seriesBy),
            value: { ...config.chart.value, fieldId: own(config.chart.value.fieldId) },
          }
        : defaults.chart,
    pivot:
      view.type === 'pivot'
        ? {
            ...config.pivot,
            rows: config.pivot.rows.filter((group) => own(group.fieldId)),
            column: config.pivot.column && own(config.pivot.column.fieldId) ? config.pivot.column : null,
            values: config.pivot.values.map((value) => ({ ...value, fieldId: own(value.fieldId) })),
          }
        : defaults.pivot,
    orgChart:
      view.type === 'orgChart' ? { parentFieldId: own(config.orgChart.parentFieldId) } : defaults.orgChart,
    list:
      view.type === 'list'
        ? {
            ...config.list,
            groupFieldId: own(config.list.groupFieldId),
            parentFieldId: own(config.list.parentFieldId),
          }
        : defaults.list,
    map:
      view.type === 'map'
        ? { locationFieldId: own(config.map.locationFieldId), colorFieldId: own(config.map.colorFieldId) }
        : defaults.map,
  };
}

export function sharedLayout(
  read: SharedRead,
  theme: SharedViewTheme | null,
  stackPeople: ReadonlySet<string> = new Set(),
): SharedViewOpen {
  return {
    status: 'open',
    linkId: read.live.id,
    name: read.live.view.name,
    type: read.live.view.type,
    primaryFieldId: read.live.table.primaryFieldId,
    fields: read.shared.map(publicField),
    display: display(read, stackPeople),
    allowCopy: read.live.settings.allowCopy,
    theme,
  };
}

/**
 * The view as the snapshot cache reads it, with its filter moved into the predicate.  Fetching a
 * page applies the predicate again, which is what keeps a record edited out of the view from
 * showing through an order taken before the edit.
 */
export function snapshotRead(read: SharedRead, context: ReadContext): SnapshotRead {
  const { view, table } = read.live;
  return {
    scope: read.scope,
    table,
    view: {
      ...view,
      config: {
        ...view.config,
        filter: null,
        groups: view.config.groups.filter((group) => read.shared.some((field) => field.id === group.fieldId)),
        summaries: Object.fromEntries(
          Object.entries(view.config.summaries).filter(([id]) =>
            read.shared.some((field) => field.id === id),
          ),
        ),
      },
    },
    fields: read.fields,
    predicate: sql`(${read.allowed}) AND (${compileFilter(
      view.config.filter,
      new Map(read.fields.map((field) => [field.id, field])),
      context,
      read.schemas.app,
    )})`,
    access: `shared:${read.live.id}`,
    context,
    values: {
      schemas: read.schemas,
      read: context,
      tableId: table.id,
      visible: (field) => read.scope.visibleFields(field.tableId, [field]).length > 0,
      recordPredicate: (tableId, alias) =>
        alias ? read.scope.linkedPredicate(tableId, alias) : read.scope.recordPredicate(tableId),
    },
  };
}

/**
 * Records with the text in any shared field, ignoring case.  Fields the link doesn't share are
 * never searched, so a search can't tell anyone what they hold.  Dates and checkboxes aren't
 * searched, since how they read depends on who is looking.
 */
export function searchPredicate(fields: readonly StoredField[], text: string, appSchema: string): Sql {
  const found = (value: Sql) => sql`strpos(lower(${value}), lower(${text})) > 0`;
  const lower = text.toLowerCase();
  const people = ident(appSchema, 'users');
  const parts: Sql[] = [];
  for (const field of fields) {
    switch (field.type) {
      case 'text':
      case 'longText':
      case 'email':
      case 'url':
      case 'phone':
      case 'recordId':
        parts.push(found(columnRef(field)));
        break;
      case 'number':
      case 'currency':
      case 'percent':
      case 'duration':
      case 'rating':
      case 'autoNumber':
      case 'count':
      case 'rollup':
        parts.push(found(displayExpr(field)));
        break;
      case 'lookup':
        parts.push(found(sql`(${columnRef(field)})::text`));
        break;
      case 'formula': {
        const expression = formulaExpression(field);
        if (expression) parts.push(found(sql`(${expression})::text`));
        break;
      }
      case 'singleSelect':
      case 'multipleSelect': {
        const ids = field.options.choices
          .filter((choice) => choice.name.toLowerCase().includes(lower))
          .map((choice) => choice.id);
        if (!ids.length) break;
        parts.push(
          field.type === 'singleSelect'
            ? sql`${columnRef(field)} = ANY(${ids}::text[])`
            : sql`${columnRef(field)} && ${ids}::text[]`,
        );
        break;
      }
      case 'user':
        parts.push(sql`EXISTS (SELECT 1 FROM unnest(${columnRef(field)}) AS search_person(id)
          JOIN ${people} search_user ON search_user.id = search_person.id
          WHERE ${found(sql`search_user.name`)})`);
        break;
      case 'createdBy':
      case 'lastModifiedBy':
        parts.push(sql`EXISTS (SELECT 1 FROM ${people} search_user
          WHERE search_user.id = ${columnRef(field)} AND ${found(sql`search_user.name`)})`);
        break;
      case 'lineItems':
      case 'link': {
        const linked = linkedSource(field);
        const primary = field.relation?.primary;
        if (linked && primary)
          parts.push(
            sql`EXISTS (SELECT 1 ${linked.source} AND ${found(displayExpr(primary, linked.record))})`,
          );
        break;
      }
      case 'attachment':
        parts.push(attachmentFilter(appSchema, field, columnRef(field), text));
        break;
      default:
        break;
    }
  }
  return parts.length ? sql`(${join(parts, ' OR ')})` : sql`FALSE`;
}

/** Narrows a read to records matching a search, on top of any stack or days it already has. */
function searched(read: SnapshotRead, shared: SharedRead, q: string | undefined): SnapshotRead {
  const text = q?.trim();
  if (!text) return read;
  const search = searchPredicate(shared.shared, text, shared.schemas.app);
  const previous = read.selection;
  return {
    ...read,
    selection: {
      key: JSON.stringify([previous?.key ?? null, 'search', compile(search)]),
      predicate: previous ? sql`(${previous.predicate}) AND (${search})` : search,
    },
  };
}

/** Only what the shared fields show: the created and modified details go out only as fields. */
export function publicRow(row: RowData, shared: readonly StoredField[]): RowData {
  const ids = new Set(shared.map((field) => field.id));
  const types = new Set(shared.map((field) => field.type));
  const errors = row.errors
    ? Object.fromEntries(Object.entries(row.errors).filter(([id]) => ids.has(id)))
    : {};
  return {
    id: row.id,
    values: Object.fromEntries(Object.entries(row.values).filter(([id]) => ids.has(id))),
    createdAt: types.has('createdTime') ? row.createdAt : '',
    createdBy: types.has('createdBy') ? row.createdBy : null,
    updatedAt: types.has('lastModifiedTime') ? row.updatedAt : '',
    updatedBy: types.has('lastModifiedBy') ? row.updatedBy : null,
    ...(Object.keys(errors).length ? { errors } : {}),
  };
}

function refsOf(value: CellValue): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Names of people in the link's organization, and nothing else about them. */
export async function peopleNames(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  ids: readonly string[],
): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const result = await query<{ id: string; name: string }>(
    db,
    sql`SELECT u.id, u.name FROM ${ident(schemas.app, 'users')} u
      JOIN ${ident(schemas.app, 'memberships')} m ON m.user_id = u.id AND m.org_id = ${orgId}
      WHERE u.id = ANY(${ids}::text[])`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.id, row.name]));
}

/**
 * The names of the records a link points at, among these, that its reader may see.  Records they
 * can't see, and records in the trash, get no name.
 */
export async function linkedNames(
  db: Queryable,
  scope: AccessScope,
  link: StoredField,
  ids: readonly string[],
): Promise<Record<string, string>> {
  const relation = link.relation;
  if (!relation?.primary || !ids.length) return {};
  const result = await query<{ id: string; name: string | null }>(
    db,
    sql`SELECT __id AS id, ${displayExpr(relation.primary)} AS name
      FROM ${ident(relation.dataSchema, relation.linkedTableId)}
      WHERE __id = ANY(${ids}::text[]) AND __deleted_at IS NULL AND NOT __source_gone
        AND (${scope.recordPredicate(relation.linkedTableId)})`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.id, row.name ?? '']));
}

/**
 * The one link a view reads for its shape alone: a nested list's or an org chart's parent, or a
 * Gantt chart's dependencies.  Every other link a layout needs, such as a group, a lane, or a label,
 * is read as the name it shows.
 */
function shapeOnlyLink(view: ViewMeta & { type: ShareableViewType }): string | null {
  if (view.type === 'list') return view.config.list.parentFieldId;
  if (view.type === 'orgChart') return view.config.orgChart?.parentFieldId ?? null;
  if (view.type === 'gantt') return view.config.gantt.dependencyFieldId;
  return null;
}

/**
 * What a page's shared cells point at: linked records' names, people's names, and files with
 * signed addresses.  Each comes only through a shared field, and only for the values on the page.
 */
async function pageRelations(
  db: Queryable,
  read: SharedRead,
  rows: readonly (RowData | null)[],
  sign: FileSigner,
): Promise<Pick<SharedRowsPage, 'linked' | 'attachments' | 'people'>> {
  const linked: Record<string, string> = {};
  const attachments: Record<string, AttachmentMeta> = {};
  const people = new Set<string>();
  const shapeOnly = shapeOnlyLink(read.live.view);
  for (const field of read.shared) {
    const target = shownAs(field);
    if (target.type === 'changeLog') {
      for (const row of rows) {
        const value = row ? cellValue(row, field) : null;
        if (Array.isArray(value))
          for (const entry of value.filter(isChangeLogEntry)) if (entry.actorId) people.add(entry.actorId);
      }
    }
    const ids = [...new Set(rows.flatMap((row) => (row ? refsOf(cellValue(row, field)) : [])))];
    if (!ids.length) continue;
    if (target.type === 'link' || target.type === 'lineItems') {
      // A parent or dependency link the sharer hid from the cards is read for the shape alone: the
      // public gets the IDs it needs to draw that shape, and never the names behind them, which can
      // belong to records the view's filter hides.  A hidden group, lane, or label is read as a
      // name, so it keeps them.
      if (field.id !== shapeOnly || !read.hidden.some((hidden) => hidden.id === field.id))
        Object.assign(linked, await linkedNames(db, read.scope, target, ids));
    } else if (target.type === 'user' || target.type === 'createdBy' || target.type === 'lastModifiedBy') {
      for (const id of ids) people.add(id);
    } else if (target.type === 'attachment') {
      // Each file's address names the first record on the page that holds it.
      const holders = new Map<string, string>();
      for (const row of rows)
        if (row)
          for (const id of refsOf(cellValue(row, field))) if (!holders.has(id)) holders.set(id, row.id);
      for (const file of await loadFiles(db, read.schemas.app, ids)) {
        const holder = holders.get(file.id);
        if (
          file.scan_state === 'clean' &&
          holder &&
          !attachments[file.id] &&
          file.org_id === read.live.orgId &&
          file.table_id === target.tableId &&
          file.field_id === target.id
        )
          attachments[file.id] = read.publicFiles
            ? sign(file, holder, field.id)
            : {
                ...sign(file, holder, field.id),
                url: attachmentMeta(file).url,
                thumbnails: attachmentMeta(file).thumbnails,
              };
      }
    }
  }
  return {
    linked,
    attachments,
    people: await peopleNames(db, read.schemas, read.live.orgId, [...people]),
  };
}

/**
 * The file at a signed place, while everything that let it out still holds: the field is shared
 * and shows files, the file belongs to the field it shows, and the record is still in the view
 * with the file in that field.  The record is found by its ID, so this stays quick on any table.
 */
export async function sharedFile(
  db: Queryable,
  read: SharedRead,
  place: FilePlace,
  context: ReadContext,
): Promise<FileRow | null> {
  read.scope.requireTableUse(read.live.table.id, 'export', [place.fieldId]);
  const field = read.shared.find((candidate) => candidate.id === place.fieldId);
  const target = field && shownAs(field);
  if (!field || target?.type !== 'attachment') return null;
  const [file] = await loadFiles(db, read.schemas.app, [place.attachmentId]);
  if (
    !file ||
    file.scan_state !== 'clean' ||
    file.org_id !== read.live.orgId ||
    file.table_id !== target.tableId ||
    file.field_id !== target.id
  )
    return null;
  const holds =
    field.type === 'lookup'
      ? sql`(${columnRef(field)}) @> ${JSON.stringify([file.id])}::jsonb`
      : sql`${columnRef(field)} @> ARRAY[${file.id}]::text[]`;
  const found = await query(
    db,
    sql`SELECT 1 FROM ${ident(read.schemas.data, read.live.table.id)}
      WHERE __id = ${place.recordId} AND __deleted_at IS NULL AND NOT __source_gone
        AND (${snapshotRead(read, context).predicate}) AND ${holds}`,
  );
  return found.rowCount ? file : null;
}

export async function sharedPage(
  pool: pg.Pool,
  cache: SnapshotCache,
  read: SharedRead,
  input: SharedRowsQuery,
  context: ReadContext,
  sign: FileSigner,
): Promise<SharedRowsPage> {
  const base = snapshotRead(read, context);
  const selected = searched(selectViewRows(base, input), read, input.q);
  const { snapshot, rebuilt } = await cache.get(selected, input.snapshot, input.refresh === '1');
  const rows = (
    await fetchPageByRid(
      pool,
      read.schemas.data,
      read.live.table.id,
      read.shared,
      Array.from(snapshot.rids.subarray(input.offset, input.offset + input.limit)),
      base.predicate,
      context,
    )
  ).map((row) => (row ? publicRow(row, read.shared) : null));
  return {
    snapshot: snapshot.id,
    total: snapshot.rids.length,
    pinnedCount: snapshot.pinnedCount ?? 0,
    offset: input.offset,
    rows,
    ...(!input.snapshot || rebuilt || input.refresh === '1' ? { groups: snapshot.groups } : {}),
    rebuilt,
    ...(await pageRelations(
      pool,
      read,
      [
        ...rows,
        ...(!input.snapshot || rebuilt || input.refresh === '1'
          ? groupLabelRows(snapshot.groups, read.fields)
          : []),
      ],
      sign,
    )),
  };
}

export async function sharedPosition(
  cache: SnapshotCache,
  read: SharedRead,
  input: SharedPositionQuery,
  context: ReadContext,
): Promise<PositionResult> {
  const scope: RowsQuery = { offset: 0, limit: 1, stack: input.stack, from: input.from, to: input.to };
  const selected = searched(selectViewRows(snapshotRead(read, context), scope), read, input.q);
  return cache.position(selected, { snapshot: input.snapshot, recordId: input.recordId });
}

/** A kanban's stacks.  Stacks of people list only the people with cards, by name. */
export async function sharedStacks(
  pool: pg.Pool,
  read: SharedRead,
  q: string | undefined,
  context: ReadContext,
): Promise<SharedStackCounts> {
  const base = snapshotRead(read, context);
  const text = q?.trim();
  const counted = await viewStackCounts(
    pool,
    read.schemas,
    text
      ? {
          ...base,
          predicate: sql`(${base.predicate}) AND (${searchPredicate(read.shared, text, read.schemas.app)})`,
        }
      : base,
  );
  const field = read.fields.find((field) => field.id === read.live.view.config.kanban.stackFieldId);
  if (field?.type !== 'user') return counted;
  const stacks = counted.stacks.filter((stack) => stack.id === EMPTY_STACK || stack.count > 0);
  const people = await peopleNames(
    pool,
    read.schemas,
    read.live.orgId,
    stacks.map((stack) => stack.id).filter((id) => id !== EMPTY_STACK),
  );
  return { stacks: stacks.filter((stack) => stack.id === EMPTY_STACK || stack.id in people), people };
}

/** The view as CSV: the shared fields, worded as the app words them, for every record in it. */
export async function sharedDownload(
  reply: FastifyReply,
  pool: pg.Pool,
  cache: SnapshotCache,
  read: SharedRead,
  input: SharedDownloadQuery,
  context: ReadContext,
): Promise<FastifyReply> {
  read.scope.requireTableUse(read.live.table.id, 'export');
  checkFormat({ format: 'csv', ...input });
  const base = snapshotRead(read, context);
  base.view = { ...base.view, config: { ...base.view.config, groups: [] } };
  const { snapshot } = await cache.get(base);
  // Downloads read with the link's own access.  The scope only names records and files the shared
  // fields point at.
  const source: ExportSource = {
    pool,
    schemas: read.schemas,
    scope: read.scope,
    read: base,
    fields: read.shared,
    locale: input.locale,
    timeZone: input.timeZone,
  };
  reply.header('content-type', CSV_TYPE);
  reply.header('content-disposition', disposition(CSV_TYPE, exportFileName('', read.live.view.name, 'csv')));
  reply.header('x-content-type-options', 'nosniff');
  return reply.send(csvStream(source, snapshotOrder(source, snapshot)));
}

/** Aggregates use the public field set and the same record predicate as public rows. */
export async function sharedAggregate(
  db: Queryable,
  read: SharedRead,
  input: ViewAggregateRequest,
  context: ReadContext,
  q?: string,
  sign?: FileSigner,
): Promise<SharedViewAggregate> {
  const { view, table } = read.live;
  const type = view.type;
  if ((type !== 'chart' && type !== 'pivot') || input.summary)
    throw new AppError('validation_failed', 'errors.validationFailed');
  if (
    (type === 'chart' && !view.config.chart.groupBy) ||
    (type === 'pivot' && !view.config.pivot.rows.length)
  )
    return { kind: 'error', messageKey: 'dashboards.tile.unavailable' };
  const snapshot = snapshotRead(read, context);
  const fields = new Map(read.shared.map((field) => [field.id, field]));
  const records: TileRecords = {
    table,
    view,
    fields,
    from: sql`${ident(read.schemas.data, table.id)}`,
    where: sql`${ident(table.id, '__deleted_at')} IS NULL AND NOT ${ident(table.id, '__source_gone')}
      AND (${snapshot.predicate!}) AND (${q?.trim() ? searchPredicate(read.shared, q.trim(), read.schemas.app) : sql`TRUE`})`,
    scope: snapshot.predicate!,
    values: {
      schemas: read.schemas,
      read: context,
      tableId: table.id,
      visible: (field) =>
        read.scope.visibleFields(field.tableId, [field]).length > 0 &&
        !read.scope.restrictedForAnyone(field.tableId, field),
      recordPredicate: (tableId, alias) =>
        alias ? read.scope.linkedPredicate(tableId, alias) : read.scope.recordPredicate(tableId),
    },
  };
  if (input.records) {
    const plan = viewPlan(records, type, view.config);
    if (isAnswer(plan)) return plan;
    if (!fitsView({ rows: plan.rows.length, column: Boolean(plan.column) }, input.records))
      throw new AppError('validation_failed', 'errors.validationFailed');
    const answer = await aggregateRecords(db, records, plan, input.records, read.schemas);
    return answer.kind === 'records'
      ? {
          ...answer,
          rows: answer.rows.map((row) => publicRow(row, read.shared)),
          ...(sign ? await pageRelations(db, read, answer.rows, sign) : {}),
        }
      : answer;
  }
  const started = performance.now();
  const deadline = () => {
    if (performance.now() - started > 20_000) throw new AppError('unavailable', 'errors.unavailable');
  };
  return type === 'chart'
    ? chartAggregate(db, records, view.config.chart, deadline)
    : pivotAggregate(db, records, view.config.pivot, deadline);
}

import { resolveSelectOptions } from '../data/select-options.js';
import type pg from 'pg';
import {
  CALENDAR_FEED_LIMITS,
  cellValue,
  isCalendarFeedViewType,
  visibleFieldIds,
  type RowData,
} from '@riosoma/contracts';
import { ident, query, sql, type Sql } from '@riosoma/db';
import { actorFor } from '../automations/run.js';
import { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import { formatCellText, relationContext, withButtonSources } from '../data/format.js';
import { loadFields, loadTable, loadView } from '../data/metadata.js';
import { compileFilter } from '../data/physical/filters.js';
import { fetchPageByRid } from '../data/physical/records.js';
import type { ReadContext, StoredField } from '../data/types.js';
import { calendarDay } from '../data/view-rows.js';
import { isCalendarField } from '../data/view-settings.js';
import { readsLive } from '../sources/live.js';
import { dayInZone, eventSpan, type CalendarDocument, type CalendarEvent } from './ical.js';
import { feedByToken, feedsAllowed, type FeedRow } from './store.js';

/**
 * What a feed's address reads: the view as the person who made the feed would see it, through
 * their role and the database's field and record rules, with the view's filter applied.  Every
 * read checks everything again, so a feed stops the moment its person loses the view.
 */

/** Records read and worded a page at a time */
const PAGE = 1_000;

export type FeedRead =
  /** No feed has this address */
  | { status: 'missing' }
  /** The feed is off, replaced, or turned off for the organization, or its person or view is gone */
  | { status: 'gone' }
  /** The view is there but can't be a calendar right now, such as after it changed type */
  | { status: 'unavailable' }
  | { status: 'ok'; feed: FeedRow; document: CalendarDocument };

/** A field that can place records by date, as the database reads it. */
function placing(field: StoredField | undefined): StoredField | undefined {
  if (!field || !isCalendarField(field)) return undefined;
  return field.type === 'formula' && !field.options.sortable ? undefined : field;
}

/** The zone a date field's times are shown in: its own, or the person's when it follows each viewer. */
function zoneOf(field: StoredField | undefined, personal: string): string {
  switch (field?.type) {
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime':
    case 'formula': {
      const zone = field.options.timeZone;
      return zone && zone !== 'client' ? zone : personal;
    }
    default:
      return personal;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function modified(row: RowData, now: Date): Date {
  for (const value of [row.updatedAt, row.createdAt]) {
    const date = new Date(value);
    if (value && Number.isFinite(date.getTime())) return date;
  }
  return now;
}

/**
 * The records to show, nearest to today first when the view has more than the cap, then in order
 * by day.  A record spans from its start day to its end day, and one that spans today is nearest.
 */
async function nearest(
  db: pg.Pool,
  schemas: DataSchemas,
  tableId: string,
  where: Sql,
  first: Sql,
  last: Sql,
  today: string,
): Promise<number[]> {
  const distance = sql`CASE WHEN ${last} < ${today}::date THEN ${today}::date - ${last}
    WHEN ${first} > ${today}::date THEN ${first} - ${today}::date ELSE 0 END`;
  const result = await query<{ rid: string }>(
    db,
    sql`SELECT near.rid FROM (
      SELECT __rid AS rid, ${first} AS day FROM ${ident(schemas.data, tableId)}
      WHERE __deleted_at IS NULL AND NOT __source_gone AND ${first} IS NOT NULL AND ${where}
      ORDER BY ${distance}, ${first}, __rid LIMIT ${CALENDAR_FEED_LIMITS.events}
    ) near ORDER BY near.day, near.rid`,
  );
  return result.rows.map((row) => Number(row.rid));
}

export async function readFeed(
  db: pg.Pool,
  schemas: DataSchemas,
  tokenHash: string,
  /** Where the app is, for each event's link back to its record */
  origin: string,
  now = new Date(),
): Promise<FeedRead> {
  const feed = await feedByToken(db, schemas, tokenHash);
  if (!feed) return { status: 'missing' };
  if (feed.stopped_at || !feed.org_allows || !feed.view_id) return { status: 'gone' };
  const owner = await actorFor(db, schemas, feed.user_id, feed.org_id);
  if (!owner) return { status: 'gone' };
  // A feed's address is a public link, so it stops once the owner's unit turns either off.  Without
  // units or a unit policy, the organization's switch, checked above, is all there is.
  if (feed.policy_relevant && !(await feedsAllowed(db, schemas, owner.orgId, owner)))
    return { status: 'gone' };
  const loaded = await loadView(db, schemas, feed.view_id);
  if (!loaded || loaded.trashed) return { status: 'gone' };
  const scope = new AccessScope(db, schemas, owner);
  // A database in the trash, or one the person no longer has a role in, reads as no role at all.
  if (!(await scope.databaseRole(loaded.databaseId))) return { status: 'gone' };
  await scope.prepare(loaded.databaseId);
  scope.requireTableUse(loaded.view.tableId, 'public');
  scope.requireTableUse(loaded.view.tableId, 'export');
  const table = await loadTable(db, schemas, loaded.view.tableId);
  if (!table || table.trashed) return { status: 'gone' };
  const { view } = loaded;
  if (!isCalendarFeedViewType(view.type) || readsLive(table)) return { status: 'unavailable' };

  const fields = await resolveSelectOptions(
    db,
    schemas,
    scope,
    scope.visibleFields(table.id, await loadFields(db, schemas, [table.id])),
  );
  const byId = new Map(fields.map((field) => [field.id, field]));
  const settings = view.config[view.type];
  const start = placing(byId.get(settings.startFieldId ?? ''));
  const end = placing(byId.get(settings.endFieldId ?? ''));
  const timeZone = zoneOf(start, feed.time_zone);
  const document: CalendarDocument = {
    name: `${table.name}: ${view.name}`,
    timeZone,
    refreshMinutes: CALENDAR_FEED_LIMITS.refreshMinutes,
    events: [],
  };
  // A start the person can't see, or none at all, places nothing, as the view shows them nothing.
  if (!start) return { status: 'ok', feed, document };

  const context: ReadContext = { timeZone: feed.time_zone, now, natural: false };
  const predicate = scope.recordPredicate(table.id);
  const where = sql`(${predicate}) AND (${compileFilter(view.config.filter, byId, context, schemas.app)})`;
  const first = calendarDay(start, context, `${view.type}.startFieldId`);
  const last = end ? sql`GREATEST(${first}, ${calendarDay(end, context, `${view.type}.endFieldId`)})` : first;
  const rids = await nearest(db, schemas, table.id, where, first, last, dayInZone(now, timeZone));

  const primary = byId.get(table.primaryFieldId);
  const described = visibleFieldIds(view.config, fields, table.primaryFieldId).flatMap((id) => {
    const field = id === table.primaryFieldId ? undefined : byId.get(id);
    return field ? [field] : [];
  });
  const wanted = [
    ...new Map(
      [primary, start, end, ...described].flatMap((field) => (field ? [[field.id, field] as const] : [])),
    ).values(),
  ];
  const read = withButtonSources(wanted, fields);
  const readById = new Map(read.map((field) => [field.id, field]));
  const events: CalendarEvent[] = [];
  for (let offset = 0; offset < rids.length; offset += PAGE) {
    // A record deleted since the order was read, or one the person can no longer see, comes back
    // null and is left out.
    const rows = (
      await fetchPageByRid(
        db,
        schemas.data,
        table.id,
        read,
        rids.slice(offset, offset + PAGE),
        predicate,
        context,
      )
    ).filter((row): row is RowData => row !== null);
    if (!rows.length) continue;
    const relations = await relationContext({ db, schemas, table, scope, fields: read, rows, names: true });
    const format = { locale: owner.locale, timeZone: feed.time_zone, ...relations };
    for (const row of rows) {
      const span = eventSpan(text(cellValue(row, start)), end ? text(cellValue(row, end)) : null, timeZone);
      if (!span) continue;
      const lines = described.flatMap((field) => {
        const value = formatCellText(field, row, readById, format).trim();
        return value ? [`${field.name}: ${value}`] : [];
      });
      const lastModified = modified(row, now);
      events.push({
        uid: `${row.id}.${view.id}@riosoma`,
        summary: primary ? formatCellText(primary, row, readById, format) : '',
        ...span,
        description: lines.join('\n'),
        url: `${origin}/${[loaded.databaseId, table.id, view.id, row.id].map(encodeURIComponent).join('/')}`,
        lastModified,
      });
    }
  }
  return { status: 'ok', feed, document: { ...document, events } };
}

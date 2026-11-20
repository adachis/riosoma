import { z } from 'zod';
import { FieldId, isTimeZone, LIMITS, type FieldMeta, type FieldType } from './data/fields.js';
import type { ChartSettings, PivotSettings, ViewAggregate } from './data/aggregates.js';
import { ExportQuery } from './data/export.js';
import { PositionQuery, RowsQuery, type RowsPage, type StackCounts } from './data/rows.js';
import {
  isParentField,
  isDependencyField,
  isProgressField,
  isTimelineGroupField,
  visibleFieldIds,
  type CalendarSettings,
  type TimelineSettings,
  type GanttSettings,
  type GallerySettings,
  type GridConfig,
  type GridGroup,
  type KanbanSettings,
  type ListSettings,
  type MapSettings,
  type OrgChartSettings,
  type RowHeight,
  type ViewType,
} from './data/views.js';
import { ThemePick } from './themes.js';

/**
 * Shared views let anyone with a link read a saved view without signing in.  Forms have their
 * own public pages for submissions.  Exact listed origins may embed public pages.
 *
 * Sharing needs the right to change the database's views.  The link holds a random ID of 22
 * characters and works until someone stops sharing it.  The public routes read exactly the view's
 * filter and sorts, and send only the shared fields: every field the view shows, or the ones
 * picked from those, plus the fields the view's layout needs (see `requiredFieldIds`).  They read
 * as no person: people show as names only, linked records as names only, and there are no
 * comments or history.  Files travel under short-lived signed addresses.
 *
 * A password, when set, is stored as a hash and never sent back.  Opening the view checks it once
 * and remembers it for `SHARED_VIEW_LIMITS.passwordHours` in a sealed cookie for that link alone.
 * Changing or removing the password forgets every one of those at once.
 *
 * Routes:
 * - `GET /api/views/:viewId/shared-view` (session, change views) → `SharedViewLink | null`
 * - `PUT /api/views/:viewId/shared-view` (session, change views) → `SharedViewLink` (publishes, or
 *   shares again a link its suspended sharer paused)
 * - `PATCH /api/views/:viewId/shared-view` (session, change views, `SharedViewUpdate`) → `SharedViewLink`
 * - `DELETE /api/views/:viewId/shared-view` (session, change views) (stops sharing)
 * - `GET /api/public/views/:linkId` (public) → `SharedView`
 * - `POST /api/public/views/:linkId/password` (public, `SharedViewUnlock`) (sets the cookie)
 * - `GET /api/public/views/:linkId/rows` (public, `SharedRowsQuery`) → `SharedRowsPage`
 * - `GET /api/public/views/:linkId/position` (public, `SharedPositionQuery`) → `PositionResult`
 * - `GET /api/public/views/:linkId/stacks` (public, `SharedStacksQuery`) → `SharedStackCounts`
 * - `GET /api/public/views/:linkId/download` (public, `SharedDownloadQuery`) → CSV, when allowed
 * - `GET /api/public/views/:linkId/files/:recordId/:fieldId/:attachmentId/:variant` (public,
 *   `SharedFileQuery`) → the file, while its record is still in the view
 *
 * Every public route counts toward a limit per network address.  The page itself is `/v/:linkId`
 * in the web app, outside the signed-in shell.  Its frame-ancestors policy names the allowed
 * sites when embedding is on and keeps same-origin framing when it's off.
 */

export const SharedViewId = z.string().regex(/^[0-9A-Za-z]{22}$/);

export const SHAREABLE_VIEW_TYPES = [
  'grid',
  'gallery',
  'kanban',
  'calendar',
  'list',
  'map',
  'orgChart',
  'timeline',
  'gantt',
  'pivot',
  'chart',
] as const;
export type ShareableViewType = (typeof SHAREABLE_VIEW_TYPES)[number];

export function isShareableViewType(type: string): type is ShareableViewType {
  return (SHAREABLE_VIEW_TYPES as readonly string[]).includes(type);
}

export const SHARED_VIEW_LIMITS = {
  /** Sites that may embed one view */
  sites: 20,
  passwordMin: 6,
  passwordMax: 200,
  /** How long a correct password is remembered */
  passwordHours: 8,
  /** Characters of a search */
  search: 200,
} as const;

/**
 * Sites go straight into a `frame-ancestors` header, where a space ends one origin and a semicolon
 * starts a directive of its own.  The URL parser is no help here: it reads `;`, `,`, and quotes as
 * part of a host, so `https://a.test;sandbox` has that whole string as its origin.  The host is
 * therefore held to the plain names and IPv6 literals a policy may name, and the text may hold none
 * of the characters that would end an origin.
 */
const EMBED_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const EMBED_HOST = new RegExp(`^${EMBED_LABEL}(?:\\.${EMBED_LABEL})*$`);
const EMBED_IPV6 = /^\[[0-9a-f:.]+]$/i;
const EMBED_UNSAFE = /[\s;,'"`|]/;
const EMBED_SITE_MAX = 300;

/**
 * The text as an exact origin a frame policy may name, or null when it isn't one.  What comes back
 * is the parsed origin, so a header built from it holds nothing but origins.
 */
export function exactOrigin(text: string): string | null {
  if (!text || text.length > EMBED_SITE_MAX || EMBED_UNSAFE.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  const host = url.hostname;
  const named = host.startsWith('[') ? EMBED_IPV6.test(host) : EMBED_HOST.test(host);
  return named && url.origin === text ? url.origin : null;
}

/** Exact HTTP origins can enter a frame policy without expanding its audience. */
export const EmbedSite = z
  .string()
  .max(EMBED_SITE_MAX)
  .refine((value) => exactOrigin(value) !== null);

/** Normalize an origin while refusing paths, credentials, queries, and wildcard hosts. */
export function embedSite(text: string): string | null {
  const value = text.trim();
  try {
    const url = new URL(value);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
    return exactOrigin(url.origin);
  } catch {
    return null;
  }
}

export const SharedViewEmbed = z.object({
  enabled: z.boolean().default(false),
  /** Sites that may embed the view.  Empty keeps embedding limited to this origin. */
  sites: z.array(EmbedSite).max(SHARED_VIEW_LIMITS.sites).default([]),
});
export type SharedViewEmbed = z.infer<typeof SharedViewEmbed>;

/**
 * The origins a frame policy names for these embed settings, each one read again as an exact
 * origin.  A rule that no longer fits, from an older version or a write that skipped the checks,
 * names nobody rather than widening who may frame the page.  Empty means this origin alone.
 */
export function embedAncestors(embed: SharedViewEmbed | null | undefined): string[] {
  const parsed = SharedViewEmbed.safeParse(embed ?? {});
  if (!parsed.success || !parsed.data.enabled) return [];
  const named = parsed.data.sites
    .map((site) => exactOrigin(site))
    .filter((site): site is string => site !== null);
  return [...new Set(named)];
}

export const SharedViewSettings = z.object({
  /**
   * Null shares every field the view shows, following the view as it changes.  A list shares
   * only those of them, and a field the view stops showing stops being shared.
   */
  fieldIds: z.array(FieldId).max(LIMITS.fieldsPerTable).nullable().default(null),
  /** Lets people copy cells and download the view as CSV */
  allowCopy: z.boolean().default(false),
  embed: SharedViewEmbed.prefault({}),
  /** The theme the link's page shows in, over the database's own.  Absent uses the database's. */
  theme: ThemePick.optional(),
});
export type SharedViewSettings = z.infer<typeof SharedViewSettings>;

export const SharedViewPassword = z
  .string()
  .min(SHARED_VIEW_LIMITS.passwordMin)
  .max(SHARED_VIEW_LIMITS.passwordMax);

/** `PATCH`: each key given replaces that setting.  A password left out stays as it is. */
export const SharedViewUpdate = z.object({
  fieldIds: z.array(FieldId).max(LIMITS.fieldsPerTable).nullable().optional(),
  allowCopy: z.boolean().optional(),
  embed: z
    .object({ enabled: z.boolean(), sites: z.array(EmbedSite).max(SHARED_VIEW_LIMITS.sites) })
    .optional(),
  /** A new password, or null to remove it */
  password: SharedViewPassword.nullable().optional(),
  /** The page's own theme, or null to use the database's */
  theme: ThemePick.nullable().optional(),
});
export type SharedViewUpdate = z.infer<typeof SharedViewUpdate>;

export interface SharedViewLink {
  linkId: string;
  viewId: string;
  /** Path on this server, like `/v/<linkId>` */
  path: string;
  /** Absolute public address when the server has a configured origin */
  url?: string;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  settings: SharedViewSettings;
  /** Whether a password guards the link.  The password itself never leaves the server. */
  hasPassword: boolean;
  /** Fields shared whatever is picked, because the view's layout needs them */
  requiredFieldIds: string[];
  /**
   * The person who shared the link, while they're suspended, which pauses it.  Sharing again
   * keeps the address and makes whoever does it the link's sharer.
   */
  suspendedSharer: { id: string; name: string } | null;
}

interface ViewShape {
  type: ViewType;
  config: GridConfig;
}

const isStack = (field: FieldMeta) =>
  field.type === 'singleSelect' || (field.type === 'user' && !field.options.allowMultiple);
const isCover = (field: FieldMeta) => field.type === 'attachment';
const isDay = (field: FieldMeta) =>
  field.type === 'date' ||
  field.type === 'createdTime' ||
  field.type === 'lastModifiedTime' ||
  (field.type === 'formula' &&
    (field.options.resultType === 'date' || field.options.resultType === 'datetime'));

const isLocation = (field: FieldMeta) => field.type === 'location';
const isPinColor = (field: FieldMeta) => field.type === 'singleSelect';

/**
 * The fields a view can't be read without: the primary field, a kanban's stack field, a card's
 * cover, a calendar's dates, a list's groups or parents, a map's places and pin colors, and the
 * dates, groups, and values of timelines and summaries.
 * Picking fields never leaves these out.
 */
export function requiredFieldIds(
  view: ViewShape,
  fields: readonly FieldMeta[],
  primaryFieldId: string,
): string[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const ids: string[] = [];
  const add = (id: string | null, fits: (field: FieldMeta) => boolean) => {
    const field = id ? byId.get(id) : undefined;
    if (field && fits(field)) ids.push(field.id);
  };
  add(primaryFieldId, () => true);
  const { kanban, gallery, calendar, list, map, orgChart, timeline, gantt, chart, pivot } = view.config;
  if (view.type === 'grid') {
    for (const group of view.config.groups) add(group.fieldId, () => true);
  } else if (view.type === 'kanban') {
    add(kanban.stackFieldId, isStack);
    add(kanban.coverFieldId, isCover);
  } else if (view.type === 'gallery') {
    add(gallery.coverFieldId, isCover);
  } else if (view.type === 'calendar') {
    add(calendar.startFieldId, isDay);
    add(calendar.endFieldId, isDay);
  } else if (view.type === 'timeline') {
    add(timeline.startFieldId, isDay);
    add(timeline.endFieldId, isDay);
    add(timeline.groupFieldId, isTimelineGroupField);
    add(timeline.labelFieldId, () => true);
  } else if (view.type === 'gantt') {
    add(gantt.startFieldId, isDay);
    add(gantt.endFieldId, isDay);
    add(gantt.dependencyFieldId, isDependencyField);
    add(gantt.progressFieldId, isProgressField);
    add(gantt.labelFieldId, () => true);
  } else if (view.type === 'chart') {
    add(chart.groupBy?.fieldId ?? null, () => true);
    add(chart.seriesBy, () => true);
    add(chart.value.fieldId, () => true);
  } else if (view.type === 'pivot') {
    for (const group of pivot.rows) add(group.fieldId, () => true);
    add(pivot.column?.fieldId ?? null, () => true);
    for (const value of pivot.values) add(value.fieldId, () => true);
  } else if (view.type === 'list') {
    add(list.groupFieldId, isTimelineGroupField);
    add(list.parentFieldId, isParentField);
  } else if (view.type === 'orgChart') {
    add(orgChart.parentFieldId, isParentField);
  } else if (view.type === 'map') {
    add(map.locationFieldId, isLocation);
    add(map.colorFieldId, isPinColor);
  }
  return [...new Set(ids)];
}

/**
 * The fields a link shares, in the view's order: `shown` are the ones its rows and cards show,
 * and `hidden` the ones the view hides but its layout still needs, such as stacks by a field the
 * cards leave out.  Nothing else the table has ever leaves the server.
 */
export function sharedFieldIds(
  view: ViewShape,
  fields: readonly FieldMeta[],
  primaryFieldId: string,
  settings: Pick<SharedViewSettings, 'fieldIds'>,
): { shown: string[]; hidden: string[] } {
  const required = requiredFieldIds(view, fields, primaryFieldId);
  const picked =
    view.type === 'chart' || view.type === 'pivot'
      ? new Set(required)
      : settings.fieldIds === null
        ? null
        : new Set([...settings.fieldIds, ...required]);
  const shown = visibleFieldIds(view.config, fields, primaryFieldId).filter(
    (id) => picked === null || picked.has(id),
  );
  const showing = new Set(shown);
  return { shown, hidden: required.filter((id) => !showing.has(id)) };
}

/** A field as the public reads it: what's needed to show its values, and nothing else. */
export interface SharedField {
  id: string;
  name: string;
  type: FieldType;
  /** The options that shape how values look: choices, number, date, and currency formats, and the like */
  options: Record<string, unknown>;
  /** For lookups: how the values look, taken from the field they come from */
  lookup?: { type: FieldType; options: Record<string, unknown> };
}

export interface SharedViewTheme {
  id: string;
  scheme: string;
}

/** How the view lays out the shared fields.  Every field ID in it is a shared one. */
export interface SharedViewDisplay {
  headerColors?: GridConfig['headerColors'];
  columnGroups?: GridConfig['columnGroups'];
  groups?: GridGroup[];
  summaries?: GridConfig['summaries'];
  /** Shared fields the view doesn't show on its rows or cards */
  hiddenFieldIds: string[];
  columnWidths: Record<string, number>;
  frozenFieldCount: number;
  rowHeight: RowHeight;
  kanban: KanbanSettings;
  gallery: GallerySettings;
  calendar: CalendarSettings;
  timeline?: TimelineSettings;
  gantt?: GanttSettings;
  chart?: ChartSettings;
  pivot?: PivotSettings;
  /** A list's groups and parents.  A parent field links to the view's own table. */
  list: ListSettings;
  map: MapSettings;
  orgChart?: OrgChartSettings;
}

export interface SharedViewOpen {
  status: 'open';
  linkId: string;
  /** The view's name */
  name: string;
  type: ShareableViewType;
  primaryFieldId: string;
  /** In the view's order: the fields it shows, then the ones only its layout needs */
  fields: SharedField[];
  display: SharedViewDisplay;
  /** Whether people may copy cells and download the view as CSV */
  allowCopy: boolean;
  /** The theme the page shows in: the link's own, else the database's forced one, else the allowed organization default */
  theme: SharedViewTheme | null;
}

/** A link with a password, before the password: nothing but how the page should look. */
export interface SharedViewLocked {
  status: 'locked';
  theme: SharedViewTheme | null;
}

export type SharedView = SharedViewOpen | SharedViewLocked;

export const SharedViewUnlock = z.object({ password: z.string().min(1).max(SHARED_VIEW_LIMITS.passwordMax) });
export type SharedViewUnlock = z.infer<typeof SharedViewUnlock>;

/** Records whose shared fields contain the text, ignoring case.  Empty searches nothing. */
const Search = z.string().max(SHARED_VIEW_LIMITS.search);

// A shared view's link already fixes what it shows, so no `where` token narrows it further.
export const SharedRowsQuery = RowsQuery.omit({ where: true }).extend({ q: Search.optional() });
export type SharedRowsQuery = z.infer<typeof SharedRowsQuery>;

/** A page of the view.  `people` names everyone its shared people fields hold, by user ID. */
export interface SharedRowsPage extends RowsPage {
  people?: Record<string, string>;
}

export const SharedPositionQuery = PositionQuery.omit({ where: true }).extend({
  q: Search.optional(),
  stack: RowsQuery.shape.stack,
  from: RowsQuery.shape.from,
  to: RowsQuery.shape.to,
});
export type SharedPositionQuery = z.infer<typeof SharedPositionQuery>;

export type SharedViewAggregate = ViewAggregate & Pick<SharedRowsPage, 'linked' | 'attachments' | 'people'>;

export const SharedStacksQuery = RowsQuery.pick({ tz: true }).extend({ q: Search.optional() });
export type SharedStacksQuery = z.infer<typeof SharedStacksQuery>;

/** A kanban's stacks.  Stacks of people list only people with cards, named in `people`. */
export interface SharedStackCounts extends StackCounts {
  people?: Record<string, string>;
}

export const SharedDownloadQuery = ExportQuery.pick({ timeZone: true, locale: true });
export type SharedDownloadQuery = z.infer<typeof SharedDownloadQuery>;

/** A file itself, or one of its scaled previews */
export const SHARED_FILE_VARIANTS = ['file', 'small', 'large'] as const;
export const SharedFileVariant = z.enum(SHARED_FILE_VARIANTS);
export type SharedFileVariant = z.infer<typeof SharedFileVariant>;

export const SharedFileQuery = z.object({
  /** The time zone the page read the view in, which its filter may depend on */
  tz: z.string().refine(isTimeZone),
  /** Seconds since 1970 when the address stops working */
  expires: z.coerce.number().int().positive().max(1e10),
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type SharedFileQuery = z.infer<typeof SharedFileQuery>;

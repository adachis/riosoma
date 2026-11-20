import { limitHistoryFields } from '../data/physical/change-log.js';
import { resolveSelectOptions } from '../data/select-options.js';
import {
  AppError,
  cellValue,
  checkCondition,
  isGroup,
  isChangeLogEntry,
  idsOf,
  filterBlockCondition,
  filtersFor,
  isSummaryBlock,
  type InterfacePage,
  type RecordsBlock,
  type RecordsDisplay,
  type SitePageSettings,
  type TileData,
} from '@riosoma/contracts';
import { ident, join, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { FastifyBaseLogger } from 'fastify';
import type { DataSchemas } from '../data/context.js';
import type { FilterGroup } from '@riosoma/contracts';
import { computeDataTiles, naturalCollation } from '../data/dashboards/routes.js';
import { attachmentNames } from '../data/files/expressions.js';
import { loadFiles } from '../data/files/metadata.js';
import type { FileStorageConfig } from '../data/files/storage.js';
import { columnRef } from '../data/physical/columns.js';
import { displayExpr, linkNamesExpr } from '../data/physical/relations.js';
import { loadFields, loadTable, loadView } from '../data/metadata.js';
import { mentionsAny } from '../data/permissions/redact.js';
import { compileFilter } from '../data/physical/filters.js';
import { formulaRead } from '../data/physical/records.js';
import { compileOrder } from '../data/physical/sorts.js';
import { linkedNames, peopleNames, publicAccess, shownAs, viewShapedBy } from '../data/shared-view-reads.js';
import type { ReadContext, StoredField } from '../data/types.js';
import { readsLive } from '../sources/live.js';
import { unavailable, type LiveSite } from './store.js';
import {
  attachmentFiles,
  pictureSizeReader,
  publishableFile,
  readLogoSize,
  type PictureSize,
} from './media.js';

/**
 * Offsets move a whole page at a time, so a list has one address per page of it, up to the
 * limit, and a visitor can't make a new one out of every number.
 */
export const SITE_LIMITS = {
  pageSize: 25,
  offset: 10000,
  bytes: 1024 * 1024,
  text: 10000,
  value: 200,
} as const;
// Unknown video dimensions need a fixed frame so metadata cannot move the following content.
const VIDEO_FRAME: PictureSize = { width: 640, height: 360 };
export interface SiteHistoryEntry {
  at: string;
  actor: string | null;
  fields: string[];
}
export interface SiteRecord {
  address: string;
  values: Record<string, string | SiteHistoryEntry[]>;
  cover?: string;
  coverSize?: PictureSize;
  coverType?: 'image' | 'video';
  coverPoster?: string;
  alt?: string;
  link?: string;
  linkLabel?: string;
}
export interface SiteRecords {
  id: string;
  title: string;
  fields: Array<{ id: string; name: string }>;
  rows: SiteRecord[];
  more: boolean;
  offset: number;
  detail: boolean;
  display: RecordsDisplay;
}
export interface SiteFilter {
  id: string;
  label: string;
  value: string;
  choices?: Array<{ value: string; label: string }>;
  checkbox?: boolean;
}
export interface SiteContent {
  records: SiteRecords[];
  filters: SiteFilter[];
  summaries: Record<string, TileData>;
  media?: Record<string, { path: string; poster?: string; size?: PictureSize; kind?: 'image' | 'video' }>;
  logoSize?: PictureSize;
}
export function invalid(): never {
  throw new AppError('validation_failed', 'errors.validationFailed');
}

const PEOPLE = new Set(['user', 'createdBy', 'lastModifiedBy']);
// Postgres refuses NUL in text, and no address a page makes carries a control character.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const ADDRESS_KEY = /^(filter|offset|sort)\.([0-9A-Za-z_-]{6,40})$/;

/**
 * Refuses an address that no link or form on the page could make, before it costs a read: a
 * key that names no block of its kind on the page, a value that's too long or holds a control
 * character, or an offset that isn't a whole page within the limit.  `readPage` checks the rest.
 * The keys come back in order, so the same address always reads the same way.
 */
export function checkAddress(page: InterfacePage, input: Record<string, unknown>): Record<string, string> {
  const checked: Record<string, string> = {};
  for (const key of Object.keys(input).sort()) {
    // Published pages use English, so a language link never becomes a data filter or cache variant.
    if (key === 'lang') continue;
    const value = input[key];
    const parts = ADDRESS_KEY.exec(key);
    if (!parts || typeof value !== 'string' || value.length > SITE_LIMITS.value || CONTROL.test(value))
      invalid();
    const [, kind, id] = parts;
    const block = page.blocks.find((item) => item.id === id);
    if (kind === 'filter' ? block?.kind !== 'filter' : block?.kind !== 'records') invalid();
    if (
      kind === 'offset' &&
      (!/^\d{1,5}$/.test(value) ||
        (block?.kind === 'records' && Number(value) % (block.pageSize ?? SITE_LIMITS.pageSize)) ||
        Number(value) > SITE_LIMITS.offset)
    )
      invalid();
    checked[key] = value;
  }
  return checked;
}

export function recordAddress(id: string, value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return slug ? `${slug}~${id}` : id;
}

/** What lookups on a page point at, by ID: people's and linked records' names, and file names */
interface Named {
  people: Record<string, string>;
  records: Record<string, string>;
  files: Record<string, string>;
}
const NOTHING_NAMED: Named = { people: {}, records: {}, files: {} };

function flat(value: unknown): unknown[] {
  return Array.isArray(value) ? value.flatMap(flat) : [value];
}

function itemText(item: unknown, target: StoredField, named: Named): string {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') {
    if (target.type === 'singleSelect' || target.type === 'multipleSelect')
      return target.options.choices.find((choice) => choice.id === item)?.name ?? '';
    if (PEOPLE.has(target.type)) return named.people[item] ?? '';
    if (target.type === 'link') return named.records[item] ?? '';
    if (target.type === 'attachment') return named.files[item] ?? '';
  }
  return typeof item === 'object' ? JSON.stringify(item) : String(item);
}

/**
 * A value as the page shows it.  A lookup shows as the field it looks up in the end would, the
 * way a view link shows it: choices, people, linked records, and files by name, never by stored
 * ID, and what has no name to show is left out.
 */
function textValue(value: unknown, field: StoredField, named: Named): string | SiteHistoryEntry[] {
  if (shownAs(field).type === 'changeLog') {
    const names = new Map(shownAs(field).historyFields?.map((item) => [item.id, item.name]));
    return flat(value)
      .filter(isChangeLogEntry)
      .map((entry) => ({
        at: entry.at,
        actor: entry.actorId ? (named.people[entry.actorId] ?? null) : null,
        fields: entry.fieldIds.flatMap((id) => names.get(id) ?? []),
      }))
      .filter((entry) => entry.fields.length);
  }
  if (value === null || value === undefined) return '';
  const target = shownAs(field);
  const texts = (Array.isArray(value) ? flat(value) : [value]).map((item) => itemText(item, target, named));
  return (target === field ? texts : texts.filter(Boolean)).join(', ').slice(0, SITE_LIMITS.text);
}

/**
 * The names behind the lookups on a page, through the publisher's access: people in the site's
 * organization, linked records the publisher may see, and files that belong to the looked-up field.
 */
async function lookupNames(
  db: Queryable,
  schemas: DataSchemas,
  live: LiveSite,
  fields: readonly StoredField[],
  cells: ReadonlyArray<(field: StoredField) => unknown>,
): Promise<Named> {
  const lookups = fields.filter((field) => shownAs(field) !== field || field.type === 'changeLog');
  if (!lookups.length || !cells.length) return NOTHING_NAMED;
  const named: Named = { people: {}, records: {}, files: {} };
  const people = new Set<string>();
  for (const field of lookups) {
    const target = shownAs(field);
    if (target.type === 'changeLog') {
      for (const entry of cells.flatMap((cell) => flat(cell(field))).filter(isChangeLogEntry))
        if (entry.actorId) people.add(entry.actorId);
    }
    const ids = [
      ...new Set(
        cells.flatMap((cell) => flat(cell(field))).filter((id): id is string => typeof id === 'string'),
      ),
    ];
    if (!ids.length) continue;
    if (PEOPLE.has(target.type)) for (const id of ids) people.add(id);
    else if (target.type === 'link')
      Object.assign(named.records, await linkedNames(db, live.scope, target, ids));
    else if (target.type === 'attachment')
      for (const file of await loadFiles(db, schemas.app, ids))
        if (
          file.org_id === live.row.org_id &&
          file.table_id === target.tableId &&
          file.field_id === target.id
        )
          named.files[file.id] = file.name;
  }
  named.people = await peopleNames(db, schemas, live.row.org_id, [...people]);
  return named;
}

/** An unusable filter must close the block instead of broadening its records. */
function checkFilter(filter: FilterGroup | null | undefined, fields: ReadonlyMap<string, StoredField>): void {
  for (const condition of filter?.conditions ?? []) {
    if (isGroup(condition)) checkFilter(condition, fields);
    else {
      const field = fields.get(condition.fieldId);
      if (!field || !checkCondition(field, condition).usable) unavailable();
    }
  }
}

/**
 * A table as a site may read it: the publisher's fields and records, less every field restricted
 * from anyone, as a view link reads it.  `mentions` is the part of the block that shapes what it
 * shows, and the block closes when that or its view names a restricted field, since what it shows
 * would then say something about one.
 */
async function publicTable(
  db: Queryable,
  schemas: DataSchemas,
  live: LiveSite,
  tableId: string,
  viewId: string | null | undefined,
  mentions: unknown,
) {
  const table = await loadTable(db, schemas, tableId);
  if (!table || table.trashed || table.databaseId !== live.row.database_id || readsLive(table)) unavailable();
  const stored = viewId ? await loadView(db, schemas, viewId) : null;
  if (viewId && (!stored || stored.trashed || stored.view.tableId !== table.id)) unavailable();
  const view = stored?.view ?? null;
  const access = publicAccess(live.scope, table.id, await loadFields(db, schemas, [table.id]));
  if (mentionsAny(mentions, access.restricted) || (view && viewShapedBy(view.config, access.restricted)))
    unavailable();
  const resolved = await resolveSelectOptions(db, schemas, undefined, access.fields);
  const fields = new Map(
    resolved.filter((field) => !access.restricted.has(field.id)).map((field) => [field.id, field]),
  );
  return { table, view, fields, allowed: access.allowed };
}

export async function recordsSource(
  db: Queryable,
  schemas: DataSchemas,
  live: LiveSite,
  block: RecordsBlock,
  context: ReadContext,
) {
  const { table, view, fields, allowed } = await publicTable(
    db,
    schemas,
    live,
    block.source.tableId,
    block.source.viewId,
    block.source,
  );
  if (!view) unavailable();
  checkFilter(block.source.filter, fields);
  checkFilter(view.config.filter, fields);
  const where = sql`__deleted_at IS NULL AND NOT __source_gone AND (${allowed})
    AND ${compileFilter(view.config.filter, fields, context, schemas.app)}
    AND ${compileFilter(block.source.filter, fields, context, schemas.app)}`;
  return { table, view, fields, where };
}

/**
 * Public records contain display values alone, with no metadata or implicit primary field.
 * `personKey` names a person in a filter's choices without their stored ID.
 */
export async function readPage(
  db: Queryable,
  schemas: DataSchemas,
  live: LiveSite,
  page: InterfacePage,
  settings: SitePageSettings,
  input: Record<string, string>,
  record: string | undefined,
  log: FastifyBaseLogger,
  personKey: (userId: string) => string,
  fileConfig: FileStorageConfig,
): Promise<SiteContent> {
  const sizeOf = pictureSizeReader(db, schemas, fileConfig);
  const context: ReadContext = {
    timeZone: 'UTC',
    now: new Date(),
    natural: await naturalCollation(db, schemas),
  };
  const records: SiteRecords[] = [];
  const filters = new Map<string, SiteFilter>();
  const accepted = new Set<string>();
  let matched = false;
  const started = performance.now();
  for (const block of page.blocks) {
    if (block.kind !== 'records') continue;
    if (performance.now() - started > 5000) throw new AppError('rate_limited', 'shareView.rateLimited');
    let source: Awaited<ReturnType<typeof recordsSource>>;
    try {
      source = await recordsSource(db, schemas, live, block, context);
    } catch (error) {
      if (error instanceof AppError && error.code === 'not_found') continue;
      throw error;
    }
    const { table, fields, view } = source;
    const details = page.blocks.filter((item) => item.kind === 'record' && item.recordsBlockId === block.id);
    const ids = record
      ? [
          ...new Set([
            ...block.fieldIds,
            ...details.flatMap((item) => (item.kind === 'record' ? item.fieldIds : [])),
          ]),
        ]
      : block.fieldIds;
    const shown = limitHistoryFields(
      ids.flatMap((id) => fields.get(id) ?? []).filter((field) => field.type !== 'button'),
      new Set(ids.filter((id) => fields.has(id))),
    );
    const shownById = new Map(shown.map((field) => [field.id, field]));
    const predicates: Sql[] = [source.where];
    for (const filter of filtersFor(page, block)) {
      const field = fields.get(filter.fieldId);
      if (!field || !block.fieldIds.includes(field.id)) continue;
      const key = `filter.${filter.id}`;
      accepted.add(key);
      const value = input[key] ?? '';
      let operand: string | boolean = field.type === 'checkbox' ? value === 'true' : value;
      filters.set(filter.id, {
        id: filter.id,
        label: filter.title || field.name,
        value,
        ...(filter.control === 'choice' && (field.type === 'singleSelect' || field.type === 'multipleSelect')
          ? { choices: field.options.choices.map((choice) => ({ value: choice.id, label: choice.name })) }
          : {}),
        ...(field.type === 'checkbox' ? { checkbox: true } : {}),
      });
      if (filter.control === 'choice' && PEOPLE.has(field.type)) {
        const choicesRead = formulaRead([field], context);
        const candidates = await query<Parameters<typeof choicesRead.decode>[0]>(
          db,
          sql`SELECT ${choicesRead.select}
          FROM ${ident(schemas.data, table.id)} WHERE ${source.where} LIMIT 100`,
        );
        const people = [
          ...new Set(
            candidates.rows.flatMap((raw) => {
              const cell = cellValue(choicesRead.decode(raw), field);
              return typeof cell === 'string' ? [cell] : idsOf(cell);
            }),
          ),
        ];
        const names = await peopleNames(db, schemas, live.row.org_id, people);
        const named = people
          .filter((id) => names[id] !== undefined)
          .sort((a, b) => names[a]!.localeCompare(names[b]!) || personKey(a).localeCompare(personKey(b)));
        // People are offered, and asked for, by a key only this site uses, never by their ID.
        filters.get(filter.id)!.choices = named.map((id) => ({ value: personKey(id), label: names[id]! }));
        if (value) operand = named.find((id) => personKey(id) === value) ?? invalid();
      }
      if (field.type === 'checkbox' && value && value !== 'true' && value !== 'false') invalid();
      const condition = value ? filterBlockCondition(filter.control, field, operand) : null;
      if (value && !condition) invalid();
      if (condition)
        predicates.push(
          compileFilter({ conjunction: 'and', conditions: [condition] }, fields, context, schemas.app),
        );
    }
    const offsetKey = `offset.${block.id}`;
    const pageSize = block.pageSize ?? SITE_LIMITS.pageSize;
    const sortKey = `sort.${block.id}`;
    accepted.add(offsetKey);
    accepted.add(sortKey);
    const offset = Number(input[offsetKey] ?? 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > SITE_LIMITS.offset || offset % pageSize)
      invalid();
    const requestedSort = input[sortKey];
    const sortId = requestedSort?.replace(/^-/, '');
    if (sortId && (!block.fieldIds.includes(sortId) || !shownById.has(sortId))) invalid();
    const sorts = sortId
      ? [
          {
            fieldId: sortId,
            direction: requestedSort?.startsWith('-') ? ('desc' as const) : ('asc' as const),
          },
        ]
      : view.config.sorts;
    if (record) {
      if (!details.length) continue;
      predicates.push(sql`__id = ${record.split('~').at(-1)!}`);
    }
    const cover =
      ['cards', 'sections', 'list'].includes(block.display) && block.coverFieldId
        ? fields.get(block.coverFieldId)
        : undefined;
    const coverField = cover?.type === 'attachment' ? cover : undefined;
    if (coverField) live.scope.requireTableUse(table.id, 'export', [coverField.id]);
    const extras =
      block.display === 'sections'
        ? [block.altFieldId, block.linkFieldId, block.linkLabelFieldId]
            .flatMap((id) => (id ? (fields.get(id) ?? []) : []))
            .filter((field) => field.type !== 'button')
        : [];
    for (const field of extras) live.scope.requireTableUse(table.id, 'export', [field.id]);
    const readFields = [
      ...new Map(
        [...shown, ...extras, ...(coverField ? [coverField] : [])].map((field) => [field.id, field]),
      ).values(),
    ];
    const read = formulaRead(readFields, context);
    const displayFields = [...new Map([...shown, ...extras].map((field) => [field.id, field])).values()];
    const display = displayFields.flatMap((field) => {
      const expression =
        field.type === 'link'
          ? linkNamesExpr(field)
          : field.type === 'user'
            ? displayExpr(field)
            : field.type === 'attachment'
              ? attachmentNames(schemas.app, field, columnRef(field))
              : field.type === 'createdBy' || field.type === 'lastModifiedBy'
                ? sql`(SELECT name FROM ${ident(schemas.app, 'users')} WHERE id = ${columnRef(field)})`
                : null;
      return expression ? [sql`${expression} AS ${ident(`__display_${field.id}`)}`] : [];
    });
    const result = await query<Parameters<typeof read.decode>[0]>(
      db,
      sql`SELECT ${join([read.select, ...display], ', ')}
      FROM ${ident(schemas.data, table.id)} WHERE ${predicates.reduce((a, b) => sql`(${a}) AND (${b})`)}
      ORDER BY ${compileOrder(sorts, requestedSort ? shownById : fields, context, schemas.data, schemas.app)}
      LIMIT ${record ? 1 : pageSize + 1} OFFSET ${record ? 0 : offset}`,
    );
    const fetched = result.rows.slice(0, pageSize).map((raw) => ({ raw, row: read.decode(raw) }));
    const named = await lookupNames(
      db,
      schemas,
      live,
      readFields,
      fetched.map(
        ({ row }) =>
          (field: StoredField) =>
            cellValue(row, field),
      ),
    );
    const slugField =
      settings.slugFieldId && block.fieldIds.includes(settings.slugFieldId)
        ? shownById.get(settings.slugFieldId)
        : undefined;
    const coverFiles = coverField
      ? await loadFiles(db, schemas.app, [
          ...new Set(fetched.flatMap(({ row }) => idsOf(cellValue(row, coverField)))),
        ])
      : [];
    const rows = await Promise.all(
      fetched.map(async ({ raw, row }): Promise<SiteRecord> => {
        const fieldText = (field: StoredField) =>
          typeof raw[`__display_${field.id}`] === 'string'
            ? String(raw[`__display_${field.id}`]).slice(0, SITE_LIMITS.text)
            : textValue(cellValue(row, field), field, named);
        const values = Object.fromEntries(shown.map((field) => [field.id, fieldText(field)]));
        const slug = slugField ? values[slugField.id] : '';
        const coverFile = coverField
          ? idsOf(cellValue(row, coverField)).flatMap((id) =>
              coverFiles.filter(
                (file) =>
                  file.id === id &&
                  file.org_id === live.row.org_id &&
                  file.table_id === table.id &&
                  file.field_id === coverField.id &&
                  (publishableFile(file, 'image') ||
                    ((block.display === 'sections' || block.enlarge || block.playback === 'loop') &&
                      publishableFile(file, 'video'))),
              ),
            )[0]
          : undefined;
        const poster =
          coverFile && publishableFile(coverFile, 'video') && coverField
            ? idsOf(cellValue(row, coverField)).flatMap((id) =>
                coverFiles.filter(
                  (file) =>
                    file.id === id &&
                    file.org_id === live.row.org_id &&
                    file.table_id === table.id &&
                    file.field_id === coverField.id &&
                    publishableFile(file, 'image'),
                ),
              )[0]
            : undefined;
        const extraText = (id: string | null | undefined) => {
          const field = id ? fields.get(id) : undefined;
          const value = field ? fieldText(field) : '';
          return typeof value === 'string' ? value : '';
        };
        return {
          ...(block.display === 'sections'
            ? {
                alt: extraText(block.altFieldId),
                link: extraText(block.linkFieldId),
                linkLabel: extraText(block.linkLabelFieldId),
              }
            : {}),
          address: recordAddress(row.id, typeof slug === 'string' ? slug : ''),
          values,
          ...(coverFile
            ? {
                cover: `${page.id}.${block.id}.${row.id}.${coverFile.id}`,
                coverSize:
                  (await sizeOf(coverFile)) ??
                  (poster ? await sizeOf(poster) : undefined) ??
                  (publishableFile(coverFile, 'video') ? VIDEO_FRAME : undefined),
                coverType: publishableFile(coverFile, 'video') ? ('video' as const) : ('image' as const),
                ...(poster ? { coverPoster: `${page.id}.${block.id}.${row.id}.${poster.id}` } : {}),
              }
            : {}),
        };
      }),
    );
    if (record) {
      if (!rows.length || rows[0]!.address !== record) continue;
      matched = true;
    }
    records.push({
      id: block.id,
      title: block.title,
      fields: shown.map(({ id, name }) => ({ id, name })),
      rows,
      more: result.rows.length > pageSize,
      offset,
      detail: details.length > 0,
      display: block.display,
    });
  }
  if (Object.keys(input).some((key) => !accepted.has(key))) invalid();
  if (record && !matched) unavailable();
  const eligible = [];
  const summaries: Record<string, TileData> = {};
  if (!record)
    for (const block of page.blocks.filter(isSummaryBlock)) {
      try {
        // A number or chart that counts, sums, groups, or filters by a restricted field closes.
        const { fields, view } = await publicTable(
          db,
          schemas,
          live,
          block.source.tableId,
          block.source.viewId,
          block,
        );
        checkFilter(view?.config.filter, fields);
        checkFilter(block.source.filter, fields);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
        summaries[block.id] = { kind: 'error', messageKey: 'interfaces.block.unavailable' };
        continue;
      }
      eligible.push(block);
    }
  if (eligible.length)
    Object.assign(
      summaries,
      await computeDataTiles(db, schemas, live.scope, live.row.database_id, eligible, 'UTC', log, 2000, true),
    );
  const media: NonNullable<SiteContent['media']> = {};
  if (!record)
    for (const block of page.blocks) {
      const reference =
        block.kind === 'hero' ? block.image : block.kind === 'media' ? block.attachment : null;
      if (!reference) continue;
      try {
        const files = await attachmentFiles(db, schemas, live, reference);
        const kind = block.kind === 'media' || block.kind === 'hero' ? (block.mediaType ?? 'image') : 'image';
        const file = files.find((file) => file.id === reference.attachmentId && publishableFile(file, kind));
        if (!file) continue;
        const poster = kind === 'video' ? files.find((file) => publishableFile(file, 'image')) : undefined;
        const path = `${page.id}.${block.id}`;
        media[block.id] = {
          path,
          kind,
          size:
            (await sizeOf(file)) ??
            (poster ? await sizeOf(poster) : undefined) ??
            (kind === 'video' &&
            (block.kind === 'hero' || (block.kind === 'media' && block.playback === 'loop'))
              ? VIDEO_FRAME
              : undefined),
          ...(poster ? { poster: `${path}.poster` } : {}),
        };
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
      }
    }
  return {
    records,
    filters: [...filters.values()],
    summaries,
    media,
    logoSize: await readLogoSize(db, schemas, live, sizeOf),
  };
}

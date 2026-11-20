import { AppError, isSummaryBlock, type Block, type InterfacePage } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { CommandContext } from '../commands/context.js';
import { filterFieldIds, tileFieldIds } from '../dashboards/config.js';

function invalid(): never {
  throw new AppError('validation_failed', 'errors.validationFailed');
}

/** The table a block reads, or null for text, and for a record block until it follows one. */
export function blockTableId(block: Block, page: Pick<InterfacePage, 'blocks'>): string | null {
  switch (block.kind) {
    case 'records':
    case 'number':
    case 'chart':
      return block.source.tableId;
    case 'filter':
      return block.tableId;
    case 'hero':
      return block.image?.tableId ?? null;
    case 'media':
      return block.attachment?.tableId ?? null;
    case 'button':
      return block.action.kind === 'form' ? block.action.tableId : null;
    case 'record': {
      const followed = page.blocks.find((item) => item.id === block.recordsBlockId);
      return followed?.kind === 'records' ? followed.source.tableId : null;
    }
    case 'code':
    case 'text':
      return null;
  }
}

/** Every field a block reads, including the ones its filter tests. */
export function blockFieldIds(block: Block): string[] {
  if (isSummaryBlock(block)) return tileFieldIds(block);
  switch (block.kind) {
    case 'records':
      return [
        ...new Set([
          ...block.fieldIds,
          ...[block.coverFieldId, block.altFieldId, block.linkFieldId, block.linkLabelFieldId].filter(
            (id): id is string => Boolean(id),
          ),
          ...filterFieldIds(block.source.filter),
        ]),
      ];
    case 'record':
      return [...new Set(block.fieldIds)];
    case 'filter':
      return [block.fieldId];
    case 'hero':
      return block.image ? [block.image.fieldId] : [];
    case 'media':
      return block.attachment ? [block.attachment.fieldId] : [];
    default:
      return [];
  }
}

/** Tables, views, and fields a block names, as keys the database's own can be checked against. */
function referenceKeys(block: Block, page: InterfacePage): string[] {
  const tableId = blockTableId(block, page);
  if (!tableId) return [];
  const views =
    block.kind === 'records' || block.kind === 'number' || block.kind === 'chart'
      ? block.source.viewId
        ? [`view:${tableId}:${block.source.viewId}`]
        : []
      : block.kind === 'button' && block.action.kind === 'form'
        ? [`form:${tableId}:${block.action.viewId}`]
        : [];
  return [
    `table:${tableId}`,
    ...views,
    ...blockFieldIds(block).map((fieldId) => `field:${tableId}:${fieldId}`),
  ];
}

/** Blocks name only blocks on their own page: a record block a records block, a filter block records blocks of its table. */
function checkLinks(page: InterfacePage): void {
  const records = new Map(
    page.blocks.flatMap((block) => (block.kind === 'records' ? [[block.id, block] as const] : [])),
  );
  for (const block of page.blocks) {
    if (block.kind === 'record') {
      if (block.recordsBlockId === null ? block.fieldIds.length > 0 : !records.has(block.recordsBlockId))
        invalid();
    }
    if (block.kind === 'filter')
      for (const id of block.blockIds) if (records.get(id)?.source.tableId !== block.tableId) invalid();
  }
}

/**
 * Checks an interface's pages: IDs unique within the interface, blocks naming only blocks on their
 * own page, and every table, view, and field one of this database's.  Trashed ones pass, since
 * restoring them brings the block back, and so does a reference the interface already held, even
 * once a purge has removed what it pointed at, so one stale block never blocks editing the rest.
 * Anything else reads as not found, so IDs don't reveal what exists.  A form button needs a form.
 */
export async function validateInterfacePages(
  c: CommandContext,
  pages: readonly InterfacePage[],
  previous: readonly InterfacePage[] | null,
): Promise<void> {
  const pageIds = pages.map((page) => page.id);
  const blockIds = pages.flatMap((page) => page.blocks.map((block) => block.id));
  if (new Set(pageIds).size !== pageIds.length || new Set(blockIds).size !== blockIds.length) invalid();
  for (const page of pages) checkLinks(page);
  const wanted = pages.flatMap((page) => page.blocks.flatMap((block) => referenceKeys(block, page)));
  if (!wanted.length) return;
  const held = new Set(
    previous?.flatMap((page) => page.blocks.flatMap((block) => referenceKeys(block, page))) ?? [],
  );
  const parts = wanted.map((key) => key.split(':'));
  const tableIds = [...new Set(parts.map((part) => part[1]!))];
  const viewIds = [
    ...new Set(parts.flatMap((part) => (part[0] === 'view' || part[0] === 'form' ? [part[2]!] : []))),
  ];
  const fieldIds = [...new Set(parts.flatMap((part) => (part[0] === 'field' ? [part[2]!] : [])))];
  const tables = await query<{ id: string }>(
    c.db,
    sql`SELECT id FROM ${ident(c.schemas.app, 'tables')}
    WHERE id = ANY(${tableIds}::text[]) AND database_id = ${c.databaseId} AND org_id = ${c.actor.orgId}`,
  );
  const views = await query<{ id: string; table_id: string; type: string }>(
    c.db,
    sql`SELECT id, table_id, type FROM ${ident(c.schemas.app, 'views')} WHERE id = ANY(${viewIds}::text[])`,
  );
  const fields = await query<{ id: string; table_id: string }>(
    c.db,
    sql`SELECT id, table_id FROM ${ident(c.schemas.app, 'fields')} WHERE id = ANY(${fieldIds}::text[])`,
  );
  const known = new Set([
    ...tables.rows.map((row) => `table:${row.id}`),
    ...views.rows.map((row) => `view:${row.table_id}:${row.id}`),
    ...views.rows.flatMap((row) => (row.type === 'form' ? [`form:${row.table_id}:${row.id}`] : [])),
    ...fields.rows.map((row) => `field:${row.table_id}:${row.id}`),
  ]);
  // Views and fields match only with their own table, and the table only in this database.
  for (const key of wanted)
    if (!known.has(key) && !held.has(key)) throw new AppError('not_found', 'errors.notFound');
}

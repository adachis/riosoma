import { AppError, isShareableViewType, sharedFieldIds } from '@riosoma/contracts';
import { sitePublishers } from '../../sites/store.js';
import { loadFields, loadTable, loadView, loadViews } from '../metadata.js';
import { viewShapedBy } from '../shared-view-reads.js';
import { liveShare, liveSharesOn, shareSettings } from '../shared-views.js';
import type { StoredField } from '../types.js';
import { scopeOf, type CommandContext } from './context.js';

/**
 * A public link, or a published site's block, shows what a view's settings and its fields say,
 * read with the access of whoever shared or published it.  Someone a rule limits changes none of
 * that on a page another person made public, or the page would show them what the rules keep from
 * them.  The person who made it public, and anyone no rule limits, still can.
 */

/** Refuses a change to the settings of a view that another person's link or site reads. */
export async function requireOwnPublicView(
  c: CommandContext,
  view: { id: string; tableId: string },
): Promise<void> {
  if (!(await scopeOf(c)).limited(c.databaseId)) return;
  const link = await liveShare(c.db, c.schemas, view.id);
  const readers = [
    ...(link ? [link.created_by] : []),
    ...(await sitePublishers(c.db, c.schemas, [view.tableId], new Set([view.id]))),
  ];
  if (readers.some((id) => id !== c.actor.userId))
    throw new AppError('forbidden', 'data.access.publicLimited');
}

/**
 * Refuses fields that are new to their table, back from the trash, or about to hold something else
 * when a page another person made public would show the result.  Such a page reads a field when it
 * shows it, shows anything worked out from it, or follows a view that filters, sorts, colors, sums,
 * or lays out by either.  A link that shares every field its view shows takes a new field at once.
 * Call this with a new or restored field already in place, so it's read as the page would read it.
 */
export async function requireOwnPublicFields(
  c: CommandContext,
  changed: ReadonlyArray<{ id: string; tableId: string }>,
): Promise<void> {
  if (!changed.length) return;
  const { db, schemas } = c;
  const scope = await scopeOf(c);
  for (const field of changed) await scope.ensureTable(field.tableId);
  if (!scope.limited(c.databaseId) && !changed.some((field) => scope.limitedFor(field.tableId))) return;
  const reads = new Map([...changed.map((field) => [field.id, field.tableId] as const)]);
  for (const [id, tableId] of scope.computedFrom(reads.keys())) reads.set(id, tableId);
  const ids = new Set(reads.keys());
  const tableIds = [...new Set(reads.values())];
  const refuse = () => new AppError('forbidden', 'data.access.publicFieldLimited');

  const fields = new Map<string, { all: StoredField[]; primaryFieldId: string }>();
  for (const share of await liveSharesOn(db, schemas, tableIds)) {
    if (share.created_by === c.actor.userId) continue;
    const view = (await loadView(db, schemas, share.view_id))?.view;
    if (!view || !isShareableViewType(view.type)) continue;
    if (!fields.has(view.tableId)) {
      const table = await loadTable(db, schemas, view.tableId);
      if (!table) continue;
      fields.set(view.tableId, {
        all: await loadFields(db, schemas, [view.tableId]),
        primaryFieldId: table.primaryFieldId,
      });
    }
    const { all, primaryFieldId } = fields.get(view.tableId)!;
    const shared = sharedFieldIds(view, all, primaryFieldId, shareSettings(share.settings));
    if ([...shared.shown, ...shared.hidden].some((id) => ids.has(id)) || viewShapedBy(view.config, ids))
      throw refuse();
  }

  // A site's blocks name the fields they show, so a new field reaches none, but they follow their
  // views' filters and orders as those are now.
  const views = await loadViews(db, schemas, tableIds, { includeTrashed: true });
  const named = new Set([...ids, ...views.filter((view) => viewShapedBy(view.config, ids)).map((v) => v.id)]);
  if ((await sitePublishers(db, schemas, tableIds, named)).some((id) => id !== c.actor.userId))
    throw refuse();
}

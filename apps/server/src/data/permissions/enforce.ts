import { isDeepStrictEqual } from 'node:util';
import { hiddenSourceIds, isSelect, sourceChoices } from '../select-options.js';
import { requireUnlockedRecordsInScope } from '../record-locks.js';
import { linkVisibilityChanges } from '../physical/links.js';
import { currentValues } from '../physical/records.js';
import { uniqueViolation } from '../physical/unique.js';
import {
  AppError,
  choicesForRecord,
  idsOf,
  validateFieldValue,
  type CellValue,
  type CellValues,
  type ErrorBody,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AccessScope } from '../access.js';
import type { DataSchemas } from '../context.js';
import { granted, type ManagedGrant } from '../managed.js';
import { loadField, loadTable } from '../metadata.js';
import type { StoredField } from '../types.js';

/**
 * How writes honor field and record rules.  The command bus refuses, with a message key of its
 * own each, a change to a locked field (`data.access.fieldLocked`), a change to a record the person
 * can't see (`data.access.recordHidden`), and a change that would leave a record outside their
 * rules (`data.access.recordOutsideRules`).  A field they can't see reads as one that doesn't
 * exist.  Links to records they can't see are kept as they are when they change a link's list,
 * and a link in a field they can't see is kept without checking its limit again.
 */

const selectIds = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string')
      : [];

export const fieldLocked = () => new AppError('forbidden', 'data.access.fieldLocked');
export const recordHidden = () => new AppError('forbidden', 'data.access.recordHidden');
export const outsideRules = () => new AppError('forbidden', 'data.access.recordOutsideRules');

/** Throws for any of these records that exists but that a record rule keeps from the person. */
export async function requireVisibleRecords(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  tableId: string,
  ids: readonly string[],
  options: { trashed?: boolean } = {},
): Promise<void> {
  if (!ids.length || !scope.limitsRecords(tableId)) return;
  const result = await query<{ __id: string }>(
    db,
    sql`SELECT __id FROM ${ident(schemas.data, tableId)} WHERE __id = ANY(${[...ids]}::text[])
      AND ${options.trashed ? sql`TRUE` : sql`__deleted_at IS NULL`}
      AND (${scope.recordPredicate(tableId)}) IS NOT TRUE`,
  );
  if (result.rowCount) throw recordHidden();
}

/** Whether an error is one of the refusals field and record rules make. */
export function isAccessRefusal(error: unknown): boolean {
  return error instanceof AppError && error.messageKey.startsWith('data.access.');
}

export interface WriteGuard {
  /** The table's fields the person can see, as stored: what they may name in a change */
  visible: StoredField[];
  /**
   * The table's fields the person can't see, by ID.  A link among them keeps what it holds without
   * being checked against its limit again, since a refusal would name it and say what it holds.
   */
  unseen: ReadonlySet<string>;
  /**
   * Throws unless the person may change every field these values name, links' other sides
   * included.  A managed field passes only where the grant names it and its record.
   */
  requireEditable(
    rows: ReadonlyArray<{ id?: string; values: CellValues | Record<string, unknown> }>,
  ): Promise<void>;
  /** Checks the resulting values, including omitted fields and only publicly answerable error details */
  requireValid(
    rows: ReadonlyArray<{ id: string; values: Record<string, unknown> }>,
    existing: boolean,
    publicFieldIds?: readonly string[],
    revalidateCascades?: boolean,
  ): Promise<void>;
  /** Checks record locks and, for trash or restore, every inverse list whose visibility changes */
  requireUnlocked(
    ids: readonly string[],
    options?: {
      links?: boolean;
      conditionalCopies?: ReadonlyMap<string, ReadonlySet<string>>;
    },
  ): Promise<void>;
  /** Physical unique indexes arbitrate concurrent writes and return field errors through this guard */
  write<T>(work: () => Promise<T>): Promise<T>;
  /** Throws for any of these records that exists but that the person can't see */
  requireVisible(ids: readonly string[], options?: { trashed?: boolean }): Promise<void>;
  /** Throws when a record rule no longer lets the person see any of these records */
  requireWithinRules(ids: readonly string[]): Promise<void>;
  /**
   * Link values with the links to records the person can't see put back, since they never saw them
   * to keep them.  Refuses a link to a record they can't see.
   */
  keepHiddenLinks<R extends { id: string; values: CellValues }>(rows: R[], existing: boolean): Promise<R[]>;
}

export function writeGuard(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  tableId: string,
  fields: readonly StoredField[],
  grant?: ManagedGrant,
): WriteGuard {
  const shown = new Set(scope.visibleFields(tableId, fields).map((field) => field.id));
  // The fields a grant names are the payment service's to write, whatever the person may see.
  const visible = fields.filter(
    (field) => shown.has(field.id) || Boolean(field.managed && grant?.fieldIds.has(field.id)),
  );
  const seen = new Set(visible.map((field) => field.id));
  const unseen = new Set(fields.map((field) => field.id).filter((id) => !seen.has(id)));
  const byId = new Map(fields.map((field) => [field.id, field]));
  const table = ident(schemas.data, tableId);
  const requireUnlocked = async (
    ids: readonly string[],
    options: {
      links?: boolean;
      conditionalCopies?: ReadonlyMap<string, ReadonlySet<string>>;
    } = {},
  ) => {
    await requireUnlockedRecordsInScope(
      db,
      schemas,
      scope,
      tableId,
      ids,
      options.conditionalCopies?.get(tableId),
    );
    if (options.links)
      for (const change of await linkVisibilityChanges(db, schemas, tableId, fields, ids))
        await requireUnlockedRecordsInScope(
          db,
          schemas,
          scope,
          change.tableId,
          change.records.map((row) => row.id),
          options.conditionalCopies?.get(change.tableId),
        );
  };

  return {
    visible,
    unseen,
    requireUnlocked,

    async write(work) {
      try {
        return await work();
      } catch (error) {
        throw uniqueViolation(error) ?? error;
      }
    },

    async requireValid(rows, existing, publicFieldIds, revalidateCascades = false) {
      const ruled = fields.filter(
        (field) =>
          ('validation' in field.options && field.options.validation) ||
          (isSelect(field) &&
            ((field.options.source && rows.some((row) => Object.hasOwn(row.values, field.id))) ||
              (field.options.cascade &&
                (revalidateCascades ||
                  !existing ||
                  rows.some(
                    (row) =>
                      Object.hasOwn(row.values, field.id) ||
                      Object.hasOwn(row.values, field.options.cascade!.fieldId),
                  ))))),
      );
      if (!ruled.length || !rows.length) return;
      const dependencies = new Set(
        ruled.flatMap((field) =>
          isSelect(field) && field.options.cascade ? [field.options.cascade.fieldId] : [],
        ),
      );
      const inputs = fields.filter((field) => ruled.includes(field) || dependencies.has(field.id));
      const previous = existing
        ? await currentValues(
            db,
            schemas.data,
            tableId,
            inputs,
            rows.map((row) => row.id),
          )
        : new Map();
      const changed = (row: { id: string; values: Record<string, unknown> }, id: string) =>
        Object.hasOwn(row.values, id) &&
        (!existing || !isDeepStrictEqual(row.values[id], previous.get(row.id)?.[id]));
      const available = new Map<string, Set<string>>();
      for (const field of ruled)
        if (isSelect(field) && field.options.source && rows.some((row) => changed(row, field.id)))
          available.set(
            field.id,
            new Set(
              (
                await sourceChoices(db, schemas, scope, field, {
                  ids: [...new Set(rows.flatMap((row) => selectIds(row.values[field.id])))],
                })
              ).map((choice) => choice.id),
            ),
          );
      const issues: NonNullable<ErrorBody['error']['issues']> = [];
      for (const row of rows) {
        const values = { ...previous.get(row.id), ...row.values };
        for (const field of ruled) {
          const issue = validateFieldValue(field, values[field.id]);
          if (issue) issues.push({ recordId: row.id, fieldId: field.id, ...issue });
          if (!isSelect(field)) continue;
          const value = values[field.id];
          const selected = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
          const allowed = field.options.cascade
            ? new Set(choicesForRecord(field.options, values).map((choice) => choice.id))
            : available.get(field.id);
          if (
            allowed &&
            (field.options.cascade
              ? revalidateCascades ||
                !existing ||
                changed(row, field.id) ||
                changed(row, field.options.cascade.fieldId)
              : changed(row, field.id)) &&
            selected.some(
              (id) =>
                !allowed.has(String(id)) &&
                (!field.options.source || !selectIds(previous.get(row.id)?.[field.id]).includes(String(id))),
            )
          )
            issues.push({
              recordId: row.id,
              fieldId: field.id,
              messageKey: field.options.cascade ? 'data.select.parentChoice' : 'data.select.sourceChoice',
            });
        }
      }
      if (!issues.length) return;
      // A public submission may receive details only for questions it was allowed to answer.
      const disclosed = publicFieldIds ? new Set(publicFieldIds) : shown;
      if (
        !publicFieldIds &&
        issues.some((issue) => {
          const field = byId.get(issue.fieldId);
          return (
            issue.messageKey === 'data.select.parentChoice' &&
            !shown.has(issue.fieldId) &&
            field &&
            isSelect(field) &&
            field.options.cascade &&
            shown.has(field.options.cascade.fieldId)
          );
        })
      )
        throw new AppError('validation_failed', 'data.select.hiddenDependency');
      if (
        issues.some((issue) => {
          const field = byId.get(issue.fieldId);
          return (
            !disclosed.has(issue.fieldId) ||
            (field &&
              isSelect(field) &&
              field.options.cascade &&
              !disclosed.has(field.options.cascade.fieldId))
          );
        })
      )
        throw new AppError('validation_failed', 'data.validation.failed');
      const messageKey =
        issues.find((issue) => issue.messageKey.startsWith('data.select.'))?.messageKey ??
        'data.validation.failed';
      throw new AppError('validation_failed', messageKey, {
        fields: Object.fromEntries(issues.map((issue) => [issue.fieldId, issue.messageKey])),
        issues,
      });
    },

    async requireEditable(rows) {
      const named = new Set<string>();
      for (const row of rows)
        for (const id of Object.keys(row.values)) {
          const field = byId.get(id);
          if (!field || !granted(grant, row.id ?? '', field)) named.add(id);
        }
      for (const id of named) {
        const field = byId.get(id);
        if (!field || !shown.has(id)) throw new AppError('validation_failed', 'data.field.unknown');
        if (!scope.canEditField(tableId, field)) throw fieldLocked();
        if (field.type === 'link' && field.options.oneWay) {
          const target = await loadTable(db, schemas, field.options.linkedTableId);
          if (!target || target.trashed) throw new AppError('validation_failed', 'data.link.unavailable');
          await scope.require(target.databaseId, 'editRecords');
        }
        // Changing a link changes its other side's lists too, so a lock there holds here.
        if ((field.type === 'link' || field.type === 'lineItems') && field.options.inverseFieldId) {
          const inverse = await loadField(db, schemas, field.options.inverseFieldId);
          if (inverse && !inverse.trashed && !scope.canEditField(inverse.tableId, inverse))
            throw fieldLocked();
        }
      }
      await requireUnlocked(rows.flatMap((row) => (row.id ? [row.id] : [])));
      for (const field of fields) {
        if ((field.type !== 'link' && field.type !== 'lineItems') || !field.options.inverseFieldId) continue;
        const edits = rows.filter((row) => Object.hasOwn(row.values, field.id));
        if (!edits.length) continue;
        const before = await currentValues(
          db,
          schemas.data,
          tableId,
          [field],
          edits.flatMap((row) => (row.id ? [row.id] : [])),
        );
        const targets = new Set<string>();
        for (const row of edits) {
          const old = idsOf(before.get(row.id ?? '')?.[field.id] ?? null);
          const next = idsOf(row.values[field.id] as CellValue);
          for (const id of [...old, ...next]) if (old.includes(id) !== next.includes(id)) targets.add(id);
        }
        await requireUnlockedRecordsInScope(db, schemas, scope, field.options.linkedTableId, [...targets]);
      }
    },

    async requireVisible(ids, options = {}) {
      await requireVisibleRecords(db, schemas, scope, tableId, ids, options);
    },

    async requireWithinRules(ids) {
      if (!ids.length || !scope.limitsRecords(tableId)) return;
      const result = await query<{ __id: string }>(
        db,
        sql`SELECT __id FROM ${table} WHERE __id = ANY(${[...ids]}::text[])
          AND __deleted_at IS NULL AND (${scope.recordPredicate(tableId)}) IS NOT TRUE`,
      );
      if (result.rowCount) throw outsideRules();
    },

    async keepHiddenLinks<R extends { id: string; values: CellValues }>(rows: R[], existing: boolean) {
      const sources = visible.filter(
        (field) =>
          isSelect(field) &&
          field.options.source &&
          scope.limitsRecords(field.options.source.tableId) &&
          rows.some((row) => Object.hasOwn(row.values, field.id)),
      );
      if (existing && sources.length) {
        const current = await currentValues(
          db,
          schemas.data,
          tableId,
          sources,
          rows.map((row) => row.id),
        );
        rows = rows.map((row) => ({ ...row, values: { ...row.values } }));
        for (const field of sources) {
          if (!isSelect(field)) continue;
          const edits = rows.filter(
            (row) =>
              Object.hasOwn(row.values, field.id) &&
              !isDeepStrictEqual(row.values[field.id], current.get(row.id)?.[field.id]),
          );
          if (!edits.length) continue;
          const previous = [
            ...new Set(edits.flatMap((row) => selectIds(current.get(row.id)?.[field.id] ?? null))),
          ];
          const hiddenIds = await hiddenSourceIds(db, schemas, scope, field, previous);
          for (const row of edits) {
            const hidden = selectIds(current.get(row.id)?.[field.id] ?? null).filter((id) =>
              hiddenIds.has(id),
            );
            if (!hidden.length) continue;
            const sent = selectIds(row.values[field.id] ?? null);
            row.values[field.id] =
              field.type === 'multipleSelect' ? [...new Set([...sent, ...hidden])] : (sent[0] ?? hidden[0]!);
          }
        }
      }
      const links = visible.filter(
        (field) =>
          (field.type === 'link' || field.type === 'lineItems') &&
          field.relation &&
          scope.limitsRecords(field.relation.linkedTableId) &&
          rows.some((row) => Object.hasOwn(row.values, field.id)),
      );
      if (!links.length) return rows;
      const out = rows.map((row) => ({ ...row, values: { ...row.values } }));
      for (const field of links) {
        const relation = field.relation!;
        const linked = relation.linkedTableId;
        const predicate = scope.recordPredicate(linked, 'target');
        const edits = out.filter((row) => Object.hasOwn(row.values, field.id));
        const sent = [...new Set(edits.flatMap((row) => idsOf(row.values[field.id] ?? null)))];
        // What each record links to now that the person can't see, in link order.
        const kept = new Map<string, string[]>();
        if (existing) {
          const other = relation.side === 'left' ? 'right' : 'left';
          const current = await query<{ record_id: string; target_id: string }>(
            db,
            sql`SELECT source.__id AS record_id, target.__id AS target_id
              FROM ${table} AS source
              JOIN ${ident(schemas.data, `lnk_${relation.linkId}`)} AS edge
                ON edge.${ident(`${relation.side}_rid`)} = source.__rid
              JOIN ${ident(schemas.data, linked)} AS target ON target.__rid = edge.${ident(`${other}_rid`)}
              WHERE source.__id = ANY(${edits.map((row) => row.id)}::text[])
                AND target.__deleted_at IS NULL AND NOT target.__source_gone
                AND (${predicate}) IS NOT TRUE
              ORDER BY source.__id, edge.${ident(`${relation.side}_pos`)}`,
          );
          for (const row of current.rows)
            kept.set(row.record_id, [...(kept.get(row.record_id) ?? []), row.target_id]);
        }
        const alreadyHidden = new Set([...kept.values()].flat());
        if (sent.length) {
          const refused = await query<{ __id: string }>(
            db,
            sql`SELECT target.__id FROM ${ident(schemas.data, linked)} AS target
              WHERE target.__id = ANY(${sent}::text[]) AND (${predicate}) IS NOT TRUE`,
          );
          if (refused.rows.some((row) => !alreadyHidden.has(row.__id))) throw recordHidden();
        }
        for (const row of edits) {
          const hidden = kept.get(row.id) ?? [];
          if (!hidden.length) continue;
          const ids = idsOf(row.values[field.id] ?? null).filter((id) => !hidden.includes(id));
          row.values[field.id] = [...ids, ...hidden];
        }
      }
      return out as R[];
    },
  };
}

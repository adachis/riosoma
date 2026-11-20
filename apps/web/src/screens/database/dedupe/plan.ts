import {
  duplicateMatches,
  type DuplicateGroup,
  type DuplicateMatch,
  type FieldMeta,
  type MergeChoice,
  type TableMeta,
} from '@riosoma/contracts';
import type { CommandInput } from '../../../data/types';

/** One field to compare, and how.  The key keeps its row steady while the field changes. */
export interface Criterion {
  key: string;
  fieldId: string;
  match: DuplicateMatch;
}

/** What a merge of one set does: the record it keeps, and the values people picked. */
export interface MergePlan {
  keepId: string;
  /** Only fields someone picked for, since the rest take the default */
  choices: Readonly<Record<string, MergeChoice>>;
}

export type MergeCommand = Extract<CommandInput, { kind: 'record.merge' }>;

/** A set is known by its oldest record, which stays the same whatever gets picked. */
export const groupKey = (group: DuplicateGroup): string => group.records[0]!.id;

/** Text is matched ignoring case and spacing unless someone asks otherwise. */
export function defaultMatch(field: FieldMeta): DuplicateMatch {
  return duplicateMatches(field).includes('loose') ? 'loose' : 'exact';
}

/** The fields a table can be compared by, the primary field first when it can be. */
export function comparableFields(table: TableMeta, fields: readonly FieldMeta[]): FieldMeta[] {
  const comparable = fields.filter((field) => duplicateMatches(field).length > 0);
  const primary = comparable.find((field) => field.id === table.primaryFieldId);
  return primary ? [primary, ...comparable.filter((field) => field !== primary)] : comparable;
}

let keys = 0;
export function criterion(field: FieldMeta): Criterion {
  keys += 1;
  return { key: `criterion-${keys}`, fieldId: field.id, match: defaultMatch(field) };
}

/** The kept record first, then the others in the set's order, as a merge reads them. */
export function keptFirst<T extends { id: string }>(records: readonly T[], keepId: string): T[] {
  const kept = records.find((record) => record.id === keepId);
  return kept ? [kept, ...records.filter((record) => record !== kept)] : [...records];
}

export function defaultPlan(group: DuplicateGroup): MergePlan {
  return { keepId: groupKey(group), choices: {} };
}

export function mergeCommand(
  tableId: string,
  group: DuplicateGroup,
  plan = defaultPlan(group),
): MergeCommand {
  return {
    kind: 'record.merge',
    tableId,
    recordId: plan.keepId,
    mergeIds: group.records.map((record) => record.id).filter((id) => id !== plan.keepId),
    choices: { ...plan.choices },
  };
}

/** A pressed button often goes away with what it did, so the focus stays in the dialog. */
export function stayInDialog(event: { target: Element }): void {
  event.target.closest<HTMLElement>('[role="dialog"]')?.focus();
}

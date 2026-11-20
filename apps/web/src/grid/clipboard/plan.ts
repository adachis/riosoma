import {
  validateFieldValue,
  isComputedType,
  newId,
  type CellValues,
  type FieldMeta,
} from '@riosoma/contracts';
import type { AttachmentClipboard } from '../../files/clipboard';
import { parseText, type ParseFailure, type ParseContext } from '../parse';

export interface CellPosition {
  row: number;
  col: number;
}

/** Inclusive endpoints, matching the grid's cell range. */
export interface CellSelection {
  start: CellPosition;
  end: CellPosition;
}

export interface PasteInput {
  cells: readonly (readonly string[])[];
  attachments?: AttachmentClipboard;
  start: CellPosition;
  selection: { rows: number; cols: number };
  fields: readonly FieldMeta[];
  rowCount: number;
  allowCreate?: boolean;
  readOnlyFieldIds?: ReadonlySet<string>;
  /** The caller loads existing rows before planning. */
  rowIdAt(index: number): string;
  context: ParseContext;
}

export interface PasteRecord {
  id: string;
  values: CellValues;
}

export interface PasteProblem extends CellPosition {
  text: string;
  reason: Exclude<ParseFailure, 'computed'> | 'validation';
  messageKey?: string;
  message?: string;
}

export interface PastePlan {
  refused?: boolean;
  updates: PasteRecord[];
  creates: PasteRecord[];
  newChoices: Map<string, string[]>;
  problems: PasteProblem[];
  /** Number of destination cells in computed fields. */
  skippedComputed: number;
  /** Number of destination columns beyond the visible fields, counted once per column. */
  extraColumns: number;
  /** Destination cells within the visible fields, including invalid and computed cells. */
  cellCount: number;
  /** Reuses the original cells and record IDs after adding select choices. */
  replan(fieldsById: ReadonlyMap<string, FieldMeta>): PastePlan;
}

function buildPlan(input: PasteInput, ids: Map<number, string>): PastePlan {
  const { cells, start, selection, fields, rowCount, context } = input;
  const blockRows = cells.length;
  const blockCols = cells.reduce((width, row) => Math.max(width, row.length), 0);
  const tiles =
    blockRows > 0 &&
    blockCols > 0 &&
    selection.rows >= blockRows &&
    selection.cols >= blockCols &&
    selection.rows % blockRows === 0 &&
    selection.cols % blockCols === 0;
  const requestedHeight = blockCols === 0 ? 0 : tiles ? selection.rows : blockRows;
  const height =
    input.allowCreate === false
      ? Math.min(requestedHeight, Math.max(0, rowCount - start.row))
      : requestedHeight;
  const width = height === 0 ? 0 : tiles ? selection.cols : blockCols;
  const keptWidth = Math.min(width, Math.max(0, fields.length - start.col));
  const plan: PastePlan = {
    updates: [],
    creates: [],
    newChoices: new Map(),
    problems: [],
    skippedComputed: 0,
    extraColumns: width - keptWidth,
    cellCount: height * keptWidth,
    replan: (fieldsById) =>
      buildPlan(
        {
          ...input,
          fields: fields.map((field) => fieldsById.get(field.id) ?? field),
        },
        ids,
      ),
  };
  const choiceKeys = new Map<string, Set<string>>();
  for (let r = 0; r < height && keptWidth > 0; r += 1) {
    const row = start.row + r;
    const values: CellValues = {};
    for (let c = 0; c < keptWidth; c += 1) {
      const col = start.col + c;
      const field = fields[col]!;
      if (isComputedType(field.type) || input.readOnlyFieldIds?.has(field.id)) {
        plan.skippedComputed += 1;
        continue;
      }
      // Ragged clipboard rows represent blank cells inside the block's bounding rectangle.
      const text = cells[r % blockRows]![c % blockCols] ?? '';
      const attachment = input.attachments?.[r % blockRows]?.[c % blockCols];
      if (field.type === 'attachment' && attachment?.fieldId === field.id) {
        values[field.id] = [...attachment.ids];
        continue;
      }
      const parsed = parseText(field, text, context);
      if (parsed.ok === true) {
        const issue = validateFieldValue(field, parsed.value);
        if (issue) plan.problems.push({ row, col, text, reason: 'validation', ...issue });
        else values[field.id] = parsed.value;
      } else if (parsed.ok === 'newChoices') {
        if (
          (field.type === 'singleSelect' || field.type === 'multipleSelect') &&
          (field.options.cascade || field.options.source)
        ) {
          plan.problems.push({
            row,
            col,
            text,
            reason: 'validation',
            messageKey: field.options.source ? 'data.select.sourceChoice' : 'data.select.parentChoice',
          });
          continue;
        }
        const names = plan.newChoices.get(field.id) ?? [];
        const seen = choiceKeys.get(field.id) ?? new Set<string>();
        for (const name of parsed.names) {
          const key = name.trim().toLocaleLowerCase(context.locale);
          if (!seen.has(key)) {
            names.push(name);
            seen.add(key);
          }
        }
        plan.newChoices.set(field.id, names);
        choiceKeys.set(field.id, seen);
      } else if (parsed.reason !== 'computed') {
        plan.problems.push({ row, col, text, reason: parsed.reason });
      }
    }
    let id = ids.get(row);
    if (id === undefined) {
      id = row < rowCount ? input.rowIdAt(row) : newId('record');
      ids.set(row, id);
    }
    const record = { id, values };
    if (row >= rowCount) plan.creates.push(record);
    else if (Object.keys(values).length > 0) plan.updates.push(record);
  }
  return plan;
}

export function planPaste(input: PasteInput): PastePlan {
  // Snapshot mutable input so the second pass still targets the selection that was planned.
  const snapshot: PasteInput = {
    ...input,
    cells: input.cells.map((row) => [...row]),
    fields: [...input.fields],
    start: { ...input.start },
    selection: { ...input.selection },
    context: { ...input.context },
  };
  return buildPlan(snapshot, new Map());
}

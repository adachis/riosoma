import { msg } from '@lingui/core/macro';
import type { FieldMeta, RowData } from '@riosoma/contracts';
import type { CellRef, GridHost } from '../../../../../../packages/grid-core/src/types';
import type { Translate } from '../../../grid/cells/describe';
import { colorDescription, rowColorClass } from './dom';
import type { ViewColors } from './paint';

export interface ColorGridOptions {
  /** The view's current colors, read as each row and cell is drawn */
  colors(): ViewColors | undefined;
  find(cell: CellRef): { row: RowData; field: FieldMeta } | null;
  locale(): string;
  t: Translate;
}

/**
 * Layers a view's colors over the grid's host: a record's tint on its row, an edge and the rule's
 * name on its row header, and the rules behind every color in the sentence a screen reader hears
 * when a cell becomes active.  Cells draw their own colors in the cell renderer.
 */
export function colorGridHost(host: GridHost<RowData>, options: ColorGridOptions): GridHost<RowData> {
  return {
    ...host,
    rowClass(row, index) {
      const record = options.colors()?.record(row) ?? null;
      return [host.rowClass?.(row, index) ?? null, rowColorClass(record)].filter(Boolean).join(' ') || null;
    },
    renderRowHeader(el, index, row, selected) {
      host.renderRowHeader(el, index, row, selected);
      const record = row ? (options.colors()?.record(row) ?? null) : null;
      if (record) el.setAttribute('aria-description', record.label);
      else el.removeAttribute('aria-description');
    },
    describeCell(cell) {
      const described = host.describeCell?.(cell) ?? '';
      const target = options.find(cell);
      const colors = options.colors();
      if (!described || !target || !colors) return described;
      const record = colors.record(target.row);
      const colored = colorDescription(
        [...(record ? [record.label] : []), ...(colors.cell(target.row, target.field)?.labels ?? [])],
        options.locale(),
      );
      return colored
        ? options.t({
            ...msg({ id: 'views.color.announce', message: '{cell}, {colors}' }),
            values: { cell: described, colors: colored },
          })
        : described;
    },
  };
}

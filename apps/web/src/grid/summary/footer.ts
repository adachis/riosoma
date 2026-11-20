import { msg } from '@lingui/core/macro';
import type { FieldMeta, SummaryKind } from '@riosoma/contracts';
import type { GridColumn } from '../../../../../packages/grid-core/src/types';
import type { Translate } from '../cells/describe';
import { setText, span } from '../cells/dom';
import type { FormatContext } from '../format';
import type { GridSummaryState } from './store';
import { recordsText, spokenSummary, summaryKindOf, SUMMARY_LABELS, summaryValueText } from './text';
import './summary.css';

export interface SummaryFooterContext {
  fieldsById: ReadonlyMap<string, FieldMeta>;
  primaryFieldId: string;
  /** Each field's chosen summary, from the view's settings */
  summaries: Readonly<Record<string, SummaryKind>>;
  state: GridSummaryState;
  format: FormatContext;
  /** Whether this person can choose summaries, which is a change to the view */
  editable: boolean;
  t: Translate;
}

interface Shown {
  kind: SummaryKind;
  /** The value as the footer shows it, or empty while there's none */
  value: string;
  status: 'ready' | 'loading' | 'error';
}

/**
 * The summary row's cells: the record count under the primary field, and each other column's
 * chosen summary, labeled and formatted like its field.  Values come from the server, and while a
 * fresh answer loads the footer keeps showing the last one it had.
 */
export function createSummaryFooter(context: SummaryFooterContext) {
  const { state, t } = context;

  function shown(field: FieldMeta): Shown {
    const kind = summaryKindOf(field, context.summaries);
    if (kind === 'none') return { kind, value: '', status: 'ready' };
    if (state.status === 'error') return { kind, value: '', status: 'error' };
    const result = state.status === 'ready' ? state.data.values[field.id] : undefined;
    // An answer for another summary, from before this one was chosen, doesn't count.
    if (!result || result.kind !== kind) return { kind, value: '', status: 'loading' };
    return { kind, value: summaryValueText(field, result, context.format), status: 'ready' };
  }

  function records(): string | null {
    return state.status === 'ready' ? recordsText(state.data.records, t) : null;
  }

  return {
    render(el: HTMLElement, column: GridColumn) {
      const field = context.fieldsById.get(column.id);
      const cell = el.parentElement;
      const primary = column.id === context.primaryFieldId;
      // The primary field's footer always counts records, so only the other columns open a menu.
      if (cell && field && !primary && context.editable) cell.setAttribute('aria-haspopup', 'menu');
      else cell?.removeAttribute('aria-haspopup');
      if (!field) {
        el.replaceChildren();
        return;
      }
      const root = span(el.ownerDocument, 'rio-grid-summary');
      if (primary) {
        const value = span(el.ownerDocument, 'rio-grid-summary__value');
        setText(value, records() ?? '');
        root.append(value);
      } else {
        const summary = shown(field);
        if (summary.kind === 'none') {
          root.classList.add('rio-grid-summary--none');
          // Only someone who can choose a summary is offered one.
          if (context.editable) {
            const hint = span(el.ownerDocument, 'rio-grid-summary__hint');
            setText(hint, t(msg({ id: 'grid.summary.choose', message: 'Summarize' })));
            root.append(hint);
          }
        } else {
          const label = span(el.ownerDocument, 'rio-grid-summary__kind');
          setText(label, t(SUMMARY_LABELS[summary.kind]));
          const value = span(el.ownerDocument, 'rio-grid-summary__value');
          setText(value, summary.value);
          // The flex gap separates the words visually, and a space separates them in the text.
          root.append(label, el.ownerDocument.createTextNode(' '), value);
        }
      }
      el.replaceChildren(root);
    },
    describe(fieldId: string | undefined): string {
      const field = fieldId ? context.fieldsById.get(fieldId) : undefined;
      if (!field) return '';
      if (field.id === context.primaryFieldId)
        return records() ?? t(msg({ id: 'grid.summary.counting', message: 'Counting records' }));
      const summary = shown(field);
      return spokenSummary(field, summary.kind, summary.value, summary.status, t);
    },
  };
}

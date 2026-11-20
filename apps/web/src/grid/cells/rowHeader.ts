import { faGripVertical, faLock, faUpRightAndDownLeftFromCenter } from '@fortawesome/free-solid-svg-icons';
import { msg } from '@lingui/core/macro';
import type { RowData } from '@riosoma/contracts';
import type { RowHeaderRenderer } from '../../../../../packages/grid-core/src/types';
import type { Translate } from './describe';
import { checkbox, icon, setText, span } from './dom';
import './cells.css';

export interface RowHeaderContext {
  t: Translate;
  movable?: boolean;
}

export function createRowHeaderRenderer({ t, movable }: RowHeaderContext): RowHeaderRenderer<RowData> {
  const cache = new WeakMap<
    HTMLElement,
    {
      root: HTMLElement;
      number: HTMLElement;
      select: HTMLButtonElement;
      expand: HTMLButtonElement;
      lock: HTMLElement;
    }
  >();
  return (el, rowIndex, _row, selected) => {
    let state = cache.get(el);
    if (!state) {
      const document = el.ownerDocument;
      const root = span(document, 'rio-cell-row-header');
      const number = span(document, 'rio-cell-row-header__number');
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'rio-cell-row-header__action';
      select.dataset.action = 'select';
      select.setAttribute('role', 'checkbox');
      select.append(checkbox(document));
      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'rio-cell-row-header__action';
      expand.dataset.action = 'expand';
      // A record's card is where its comments and history are, so help points at the way in.
      expand.dataset.anchor = 'grid.record.expand';
      expand.append(icon(document, faUpRightAndDownLeftFromCenter));
      const lock = span(document, 'rio-row-lock');
      lock.append(icon(document, faLock));
      lock.setAttribute('role', 'img');
      root.append(number, lock, select, expand);
      if (movable) {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.dataset.rioDragRow = '';
        handle.className = 'rio-cell-row-header__move';
        handle.append(icon(document, faGripVertical));
        const moveLabel = t(msg({ id: 'grid.drag.row', message: 'Move record' }));
        handle.setAttribute('aria-label', moveLabel);
        handle.title = moveLabel;
        root.append(handle);
      }
      state = { root, number, select, expand, lock };
      cache.set(el, state);
    }
    state.lock.hidden = !_row?.lock;
    const reason =
      _row?.lock?.reason ||
      (_row?.lock?.manual
        ? t(msg({ id: 'locks.record.manualReason', message: 'Locked by hand' }))
        : t(msg({ id: 'locks.record.conditionReason', message: 'Matches the table lock condition' })));
    const label = t(msg({ id: 'locks.record.reason', message: `Locked: ${reason}` }));
    state.lock.title = label;
    state.lock.setAttribute('aria-label', label);
    const row = rowIndex + 1;
    setText(state.number, String(row));
    state.root.dataset.selected = String(selected);
    state.select.setAttribute('aria-checked', String(selected));
    state.select.setAttribute('aria-label', t(msg({ id: 'grid.row.select', message: `Select row ${row}` })));
    state.expand.setAttribute('aria-label', t(msg({ id: 'grid.row.expand', message: `Expand row ${row}` })));
    state.select.title = state.select.getAttribute('aria-label') ?? '';
    state.expand.title = state.expand.getAttribute('aria-label') ?? '';
    if (el.firstChild !== state.root) el.replaceChildren(state.root);
  };
}

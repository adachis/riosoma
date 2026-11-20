import {
  faChevronDown,
  faDatabase,
  faEyeSlash,
  faLock,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { FieldAccess, FieldMeta } from '@riosoma/contracts';
import { lockedMark, restrictedMark } from '../../screens/database/permissions/restricted';
import type { HeaderRenderer } from '../../../../../packages/grid-core/src/types';
import { fieldInfo } from '../../screens/database/fields/fieldTypes';
import type { AiFieldStatusStore } from '../../features/ai-fields/status';
import { serverMessage } from '../../messages/useServerMessage';
import type { Translate } from './describe';
import { icon, setText, span } from './dom';
import './cells.css';

export interface HeaderContext {
  fieldsById: ReadonlyMap<string, FieldMeta>;
  primaryFieldId: string;
  sourceName?: string;
  mappedSources?: (fieldId: string) => string[];
  /** Restricted and locked fields the person can see, for their marks */
  access?: () => ReadonlyMap<string, FieldAccess>;
  /** Bulk runs under way, and why AI fields' runs stop */
  aiFields?: AiFieldStatusStore;
  t: Translate;
}

export function createHeaderRenderer(context: HeaderContext): HeaderRenderer {
  const cache = new WeakMap<
    HTMLElement,
    { root: HTMLElement; label: HTMLElement; type: FieldMeta['type']; ai: boolean }
  >();
  return (el, column) => {
    const field = context.fieldsById.get(column.id);
    // The grid passes the content, but semantics belong to its columnheader parent.
    const heading = el.parentElement?.getAttribute('role') === 'columnheader' ? el.parentElement : el;
    heading.removeAttribute('aria-description');
    if (!field) {
      el.replaceChildren();
      heading.removeAttribute('aria-haspopup');
      cache.delete(el);
      return;
    }
    heading.setAttribute('aria-haspopup', 'menu');
    if (field.id === context.primaryFieldId) {
      heading.setAttribute(
        'aria-description',
        context.t(msg({ id: 'grid.header.primary', message: 'Primary field' })),
      );
    }
    let state = cache.get(el);
    if (!state || state.type !== field.type || state.ai !== Boolean(field.ai)) {
      const root = span(el.ownerDocument, 'rio-cell-header');
      const label = span(el.ownerDocument, 'rio-cell-header__label');
      const chevron = span(el.ownerDocument, 'rio-cell-header__chevron');
      chevron.append(icon(el.ownerDocument, faChevronDown));
      root.append(icon(el.ownerDocument, fieldInfo(field).icon), label, chevron);
      state = { root, label, type: field.type, ai: Boolean(field.ai) };
      cache.set(el, state);
    }
    state.root.querySelector('.rio-synced-source')?.remove();
    heading.removeAttribute('title');
    delete heading.dataset.syncedDescription;
    if (field.source) {
      const source = context.sourceName ?? '';
      const column = field.source.column;
      const sources = context.mappedSources?.(field.id) ?? [];
      const names = sources.join(', ');
      const label =
        sources.length > 0
          ? context.t(msg({ id: 'joined.mapping.header', message: `Mapped from ${names}` }))
          : context.t(msg({ id: 'synced.field.source', message: `From ${source}, column ${column}` }));
      const mark = span(el.ownerDocument, 'rio-synced-source');
      mark.append(icon(el.ownerDocument, faDatabase));
      if (sources.length > 0) mark.setAttribute('aria-hidden', 'true');
      mark.title = label;
      heading.title = label;
      heading.dataset.syncedDescription = label;
      heading.setAttribute('aria-description', label);
      state.root.prepend(mark);
    }
    // Restricted and locked fields carry a mark, so the people who can see them know others can't.
    state.root.querySelectorAll('.rio-permission-mark').forEach((mark) => mark.remove());
    const access = context.access?.().get(field.id);
    const marks: string[] = [];
    for (const [on, glyph, label] of [
      [access?.locked, faLock, lockedMark],
      [access?.restricted, faEyeSlash, restrictedMark],
    ] as const) {
      if (!on) continue;
      const text = context.t(label);
      const mark = span(el.ownerDocument, 'rio-permission-mark');
      mark.append(icon(el.ownerDocument, glyph));
      mark.title = text;
      state.root.insertBefore(mark, state.root.lastElementChild);
      marks.push(text);
    }
    // An AI field shows how far a bulk run has come, or why its runs stop.
    state.root.querySelectorAll('.rio-ai-progress, .rio-ai-problem').forEach((mark) => mark.remove());
    const job = field.ai ? context.aiFields?.job(field.id) : undefined;
    const problem = field.ai ? context.aiFields?.problem(field.id) : undefined;
    if (job?.state === 'running') {
      const done = job.done + job.failed;
      const total = job.total;
      const mark = span(el.ownerDocument, 'rio-ai-progress');
      mark.setAttribute('role', 'progressbar');
      mark.setAttribute('aria-valuemin', '0');
      mark.setAttribute('aria-valuemax', String(total));
      mark.setAttribute('aria-valuenow', String(done));
      setText(mark, context.t(msg({ id: 'fields.ai.progress', message: `${done} of ${total}` })));
      mark.title = context.t(
        msg({
          id: 'fields.ai.progressTitle',
          message: `Generating values: ${done} of ${total}.  Stop from the field’s menu.`,
        }),
      );
      state.root.insertBefore(mark, state.root.lastElementChild);
      marks.push(mark.title);
    } else if (problem) {
      const text = i18n.locale ? serverMessage(i18n, problem) : problem;
      const mark = span(el.ownerDocument, 'rio-ai-problem');
      mark.append(icon(el.ownerDocument, faTriangleExclamation));
      mark.title = text;
      state.root.insertBefore(mark, state.root.lastElementChild);
      marks.push(text);
    }
    if (marks.length)
      heading.setAttribute(
        'aria-description',
        [heading.getAttribute('aria-description'), ...marks].filter(Boolean).join(' '),
      );
    setText(state.label, field.name);
    if (el.firstChild !== state.root) el.replaceChildren(state.root);
  };
}

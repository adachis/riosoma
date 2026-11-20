import { drawSparkline, type SparklinePaint } from '../../screens/database/colors/sparklines';
import '../../screens/database/colors/sparklines.css';
import { overrideDescription, overridesOff, sourceReadOnly } from '../../screens/database/synced/override';
import { followsValues, matchedTooltip } from '../../screens/database/joins/matched';
import '../../screens/database/synced/synced.css';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { DatabaseSession } from '../../data';
import { personLabel, type DisplayPerson } from '../../data/people';
import { serverMessage } from '../../messages/useServerMessage';
import {
  cellValue,
  idsOf,
  isSignatureValue,
  presenceColor,
  ROW_HEIGHT_PX,
  type AttachmentMeta,
  type CellValue,
  type Choice,
  type FieldMeta,
  type RowData,
  type RowHeight,
  type SignatureValue,
} from '@riosoma/contracts';
import type { CellRenderer } from '../../../../../packages/grid-core/src/types';
import { displayField, formatCell, type FormatContext } from '../format';
import { drawAttachments } from '../../files/drawAttachments';
import { ratingIcons } from '../ratingIcons';
import { buttonLabel, buttonTarget, requestButtonRun } from '../../fields/buttons';
import '../editors/AdditionalEditors.css';
import '../../fields/fields.css';
import { checkbox, icon, setText, span } from './dom';
import { hiddenRecordLabel } from '../../screens/database/permissions/restricted';
import { colorDescription, paintElement } from '../../screens/database/colors/dom';
import type { ViewColors } from '../../screens/database/colors/paint';
import type { AiFieldStatusStore } from '../../features/ai-fields/status';
import { PENDING } from '../../features/ai-fields/messages';
import './cells.css';

export interface CellRendererContext {
  fieldsById: ReadonlyMap<string, FieldMeta>;
  session?: DatabaseSession;
  format: FormatContext;
  rowHeight: RowHeight;
  /** The view's conditional colors */
  colors?: ViewColors;
  /** Which AI cells wait for their run or show an error */
  aiFields?: AiFieldStatusStore;
}

type Kind =
  | 'sparkline'
  | 'attachments'
  | 'error'
  | 'empty'
  | 'text'
  | 'link'
  | 'checkbox'
  | 'checks'
  | 'choices'
  | 'person'
  | 'rating'
  | 'users'
  | 'signature'
  | 'action'
  | 'button'
  | 'buttonOff';
interface DrawnCell {
  sparkline?: SparklinePaint;
  visible?: boolean;
  field: FieldMeta | undefined;
  value: CellValue;
  width: number;
  rowHeight: RowHeight;
  locale: string;
  timeZone: string;
  personName: string;
  peoplePictures: string;
  display: string;
  fileDetails: readonly (AttachmentMeta | undefined)[];
  error: string;
  /** Linked records a record rule hides, drawn as "Hidden record" */
  hidden: number;
  kind: Kind;
  root: HTMLElement | null;
}

function equalValue(a: CellValue, b: CellValue): boolean {
  return Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((value, index) => value === b[index])
    : a === b;
}

/** Where a URL, email, or phone value links to, or null when it isn't safely linkable. */
export function linkTarget(type: FieldMeta['type'], text: string): string | null {
  if (!text || /[\s\p{Cc}]/u.test(text)) return null;
  if (type === 'email') {
    return /^[^@:?/#]+@[^@:?/#]+\.[^@:?/#]+$/u.test(text) ? `mailto:${text}` : null;
  }
  if (type === 'phone') return /^\+?[\d().-]+$/u.test(text) && /\d/u.test(text) ? `tel:${text}` : null;
  if (type !== 'url') return null;
  const explicit = /^https?:\/\//iu.test(text);
  // Bare domains may include a port or path, but never credentials or another URI scheme.
  if (
    !explicit &&
    !/^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}(?::\d+)?(?:[/?#]|$)/u.test(text)
  )
    return null;
  try {
    const href = explicit ? text : `https://${text}`;
    const parsed = new URL(href);
    return parsed.hostname && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? href : null;
  } catch {
    return null;
  }
}

const buttonNewTab = msg({ id: 'fields.button.newTab', message: 'Opens in a new tab' });
const buttonEmpty = msg({ id: 'fields.button.noLink', message: 'This button doesn’t have a link yet.' });
const buttonMissing = msg({
  id: 'fields.button.missingField',
  message: 'This button uses a field that was deleted.',
});
const buttonInvalid = msg({
  id: 'fields.button.invalid',
  message: 'This record doesn’t make a web link for this button.',
});

const SVG = 'http://www.w3.org/2000/svg';

/** Drawing a cell must never throw, even before a locale is active. */
function words(descriptor: ReturnType<typeof msg>): string {
  return i18n.locale ? i18n._(descriptor) : descriptor.message!;
}

/** A small signature: the drawing scaled to the row, or the typed name when nothing was drawn. */
function drawSignature(root: HTMLElement, value: SignatureValue): void {
  const document = root.ownerDocument;
  if (!value.drawing) {
    const typed = span(document, 'rio-signature__typed');
    setText(typed, value.name ?? '');
    root.replaceChildren(typed);
    return;
  }
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${value.drawing.width} ${value.drawing.height}`);
  svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG, 'path');
  // Path data is checked to hold only moves, lines, and numbers before it's ever stored.
  path.setAttribute('d', value.drawing.path);
  svg.append(path);
  root.replaceChildren(svg);
}

function drawChoices(root: HTMLElement, choices: readonly Choice[]): void {
  for (const [index, choice] of choices.entries()) {
    let pill = root.children.item(index) as HTMLElement | null;
    if (!pill) {
      // A space keeps the pills' names apart in the text, as the gap shows them apart.
      if (index > 0) root.append(root.ownerDocument.createTextNode(' '));
      pill = span(root.ownerDocument, 'rio-choice-pill');
      pill.dataset.size = 'sm';
      const label = span(root.ownerDocument, 'rio-choice-pill__label');
      label.setAttribute('role', 'img');
      pill.append(label);
      root.append(pill);
    }
    pill.dataset.color = choice.color;
    const label = pill.firstElementChild as HTMLElement;
    setText(label, choice.name);
    label.setAttribute('aria-label', choice.name);
  }
  while (root.children.length > choices.length) {
    const last = root.lastElementChild!;
    const before = last.previousSibling;
    last.remove();
    if (before instanceof Text && before.data === ' ') before.remove();
  }
}

export function createCellRenderer(context: CellRendererContext): CellRenderer<RowData> {
  const cache = new WeakMap<HTMLElement, DrawnCell>();
  const segmenters = new Map<string, Intl.Segmenter>();
  function initials(name: string, locale: string): string {
    let words: string[];
    if (typeof Intl.Segmenter === 'function') {
      let segmenter = segmenters.get(locale);
      if (!segmenter) {
        segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
        segmenters.set(locale, segmenter);
      }
      words = Array.from(segmenter.segment(name))
        .filter((part) => part.isWordLike)
        .map((part) => part.segment);
    } else {
      words = name.trim().split(/\s+/u);
    }
    if (words.length === 0) words = [name.trim()];
    return words
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? '')
      .join('')
      .toLocaleUpperCase(locale);
  }

  function drawPersonAvatar(
    avatar: HTMLElement,
    person: DisplayPerson | undefined,
    name: string,
    locale: string,
  ): void {
    if (person?.deactivated) avatar.dataset.deactivated = 'true';
    else delete avatar.dataset.deactivated;
    const fallback = () => setText(avatar, initials(person?.name ?? name, locale));
    if (!person?.pictureUrl) {
      fallback();
      return;
    }
    const picture = avatar.ownerDocument.createElement('img');
    picture.src = person.pictureUrl;
    picture.alt = '';
    picture.onerror = fallback;
    avatar.replaceChildren(picture);
  }

  return (el, { row, column, visible = true }) => {
    const { rowHeight } = context;
    const format = {
      ...context.format,
      fieldsById: context.session?.getSchema().fieldById ?? context.format.fieldsById ?? context.fieldsById,
      linked: context.session?.linked ?? context.format.linked,
      attachments: context.session?.attachments ?? context.format.attachments,
    };
    const field = context.fieldsById.get(column.id);
    const cell = el.parentElement?.getAttribute('role') === 'gridcell' ? el.parentElement : el;
    const explanation = field ? overrideDescription(field, row, format, i18n._.bind(i18n)) : '';
    const locked = field && sourceReadOnly(field, context.session?.getSchema().tableById.get(field.tableId));
    cell.classList.toggle('rio-synced-override', Boolean(explanation));
    // An AI cell waiting for its run says so, and one whose last run failed gives the reason.
    const ai = field?.ai ? context.aiFields?.cell(row.id, field.id) : undefined;
    const aiText = ai
      ? ai.state === 'pending'
        ? words(PENDING)
        : serverMessage(i18n, ai.messageKey ?? 'aiFields.run.failed', ai.params)
      : '';
    cell.classList.toggle('rio-cell-ai--pending', ai?.state === 'pending');
    cell.classList.toggle('rio-cell-ai--error', ai?.state === 'error');
    if (ai?.state === 'pending') cell.setAttribute('aria-busy', 'true');
    else cell.removeAttribute('aria-busy');
    cell.title =
      aiText ||
      explanation ||
      (locked ? i18n._(overridesOff) : field && followsValues(field) ? i18n._(matchedTooltip) : '');
    cell.dataset.syncedDescription = cell.title;
    // Color is never the only signal: the rules behind a cell's color are part of its description.
    const record = context.colors?.record(row) ?? null;
    const paint = field ? (context.colors?.cell(row, field) ?? null) : null;
    paintElement(cell, paint);
    const colored = colorDescription(
      [...(record ? [record.label] : []), ...(paint?.labels ?? [])],
      context.format.locale,
    );
    const description = [cell.title, colored].filter(Boolean).join(' ');
    if (description) cell.setAttribute('aria-description', description);
    else cell.removeAttribute('aria-description');
    if (paint?.icon) cell.title = [cell.title, paint.icon.label].filter(Boolean).join(' ');
    const value = field ? cellValue(row, field) : null;
    const personName =
      field && (field.type === 'createdBy' || field.type === 'lastModifiedBy') && typeof value === 'string'
        ? personLabel(format.collaborators.get(value))
        : '';
    // A button's link depends on other fields, so the link itself says when to draw it again.
    const link = field?.type === 'button' ? buttonTarget(field, row, format) : null;
    const display = paint?.sparkline
      ? ''
      : link
        ? link.ok
          ? link.url
          : `!${link.reason}`
        : field
          ? field.type === 'lineItems'
            ? [
                formatCell(field, value, format),
                ...field.options.columns.flatMap((column) => {
                  const total = row.lineItemTotals?.[field.id]?.[column.id];
                  const child = format.fieldsById?.get(column.id);
                  return total !== undefined && child
                    ? [`${column.name}: ${formatCell(child, total, format)}`]
                    : [];
                }),
              ].join(' · ')
            : formatCell(field, value, format)
          : '';
    const error = field ? (row.errors?.[field.id] ?? '') : '';
    const hidden = field?.type === 'link' ? (row.hiddenLinks?.[field.id] ?? 0) : 0;
    const drawnField = field ? displayField(field, format) : undefined;
    const fileDetails =
      drawnField?.type === 'attachment' ? idsOf(value).map((id) => format.attachments?.get(id)) : [];
    const personIds = typeof value === 'string' ? [value] : idsOf(value);
    const peoplePictures =
      drawnField && ['user', 'createdBy', 'lastModifiedBy'].includes(drawnField.type)
        ? personIds
            .map((id) => {
              const person = format.collaborators.get(id);
              return `${id}:${person?.pictureUrl ?? ''}:${Boolean(person?.deactivated)}`;
            })
            .join('|')
        : '';
    const previous = cache.get(el);
    // A loading row or a recycled column can clear the host without changing its identity.
    const intact =
      previous &&
      (previous.root ? el.firstChild === previous.root && el.childNodes.length === 1 : !el.hasChildNodes());
    if (
      intact &&
      field?.type !== 'lookup' &&
      fileDetails.length === previous.fileDetails.length &&
      fileDetails.every((file, index) => file === previous.fileDetails[index]) &&
      previous.sparkline === paint?.sparkline &&
      previous.visible === visible &&
      previous.field === field &&
      equalValue(previous.value, value) &&
      previous.width === column.width &&
      previous.rowHeight === rowHeight &&
      previous.locale === format.locale &&
      previous.timeZone === format.timeZone &&
      previous.personName === personName &&
      previous.peoplePictures === peoplePictures &&
      previous.display === display &&
      previous.error === error &&
      previous.hidden === hidden
    )
      return;

    let kind: Kind = 'empty';
    let text = '';
    let href: string | null = null;
    let choices: Choice[] = [];
    if (error) {
      kind = 'error';
      const descriptor = msg({ id: 'grid.formula.error', message: '#ERROR' });
      text = i18n.locale ? i18n._(descriptor) : descriptor.message!;
    } else if (paint?.sparkline) {
      kind = 'sparkline';
    } else if (field?.type === 'button') {
      kind = field.options.action.kind !== 'openUrl' ? 'action' : link?.ok ? 'button' : 'buttonOff';
    } else if (field?.type === 'signature') {
      if (isSignatureValue(value)) kind = 'signature';
    } else if (drawnField?.type === 'rating') {
      kind = 'rating';
    } else if (drawnField?.type === 'user') {
      if (personIds.length) kind = 'users';
    } else if (drawnField?.type === 'attachment') {
      if (idsOf(value).length) kind = 'attachments';
      context.session?.ensureAttachments(idsOf(value));
    } else if (drawnField?.type === 'link') {
      const hiddenName = i18n.locale ? i18n._(hiddenRecordLabel) : hiddenRecordLabel.message!;
      choices = [
        ...idsOf(value).map((id) => ({ id, name: format.linked?.get(id) ?? id, color: 'gray' as const })),
        ...Array.from({ length: hidden }, (_, index) => ({
          id: `hidden:${index}`,
          name: hiddenName,
          color: 'gray' as const,
        })),
      ];
      if (choices.length) kind = 'choices';
    } else if (drawnField?.type === 'checkbox') {
      kind = Array.isArray(value) ? (value.length ? 'checks' : 'empty') : 'checkbox';
    } else if (drawnField?.type === 'singleSelect' || drawnField?.type === 'multipleSelect') {
      const ids = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
      choices = ids.flatMap((id) => {
        const choice = drawnField.options.choices.find((entry) => entry.id === id);
        return choice ? [choice] : [];
      });
      if (choices.length) kind = 'choices';
    } else if (field) {
      text = display;
      if (text) {
        href = linkTarget(field.type, text);
        kind = personName ? 'person' : href ? 'link' : 'text';
      }
    }

    let root = previous?.kind === kind ? previous.root : null;
    if (kind !== 'empty' && !root) {
      root =
        kind === 'action'
          ? el.ownerDocument.createElement('button')
          : kind === 'link' || kind === 'button'
            ? el.ownerDocument.createElement('a')
            : kind === 'checkbox'
              ? checkbox(el.ownerDocument)
              : span(el.ownerDocument, '');
      if (kind === 'person') {
        const avatar = span(el.ownerDocument, 'rio-person-avatar');
        avatar.dataset.size = 'sm';
        avatar.setAttribute('role', 'img');
        // The initials and the name are separate words to a screen reader, as the gap shows.
        root.append(
          avatar,
          el.ownerDocument.createTextNode(' '),
          span(el.ownerDocument, 'rio-cell-person__name'),
        );
      }
    }
    if (root) {
      root.className = `rio-cell-value rio-cell-value--${kind}${kind === 'checkbox' ? ' rio-cell-check' : ''}`;
      root.dataset.rowHeight = rowHeight;
      if (kind === 'sparkline' && paint?.sparkline) {
        root.classList.add('rio-sparkline');
        root.setAttribute('aria-hidden', 'true');
        drawSparkline(root, paint.sparkline, visible);
      } else if (kind === 'text' || kind === 'link' || kind === 'error') {
        root.title = error ? serverMessage(i18n, error) : '';
        setText(root, text);
        if (kind === 'link') {
          root.setAttribute('href', href!);
          root.setAttribute('target', '_blank');
          root.setAttribute('rel', 'noopener noreferrer');
        }
        root.classList.toggle('rio-cell-value--code', field?.type === 'json');
        if ((field?.type === 'longText' || field?.type === 'changeLog') && rowHeight !== 'short') {
          root.classList.add('rio-cell-value--wrap');
          // Keep four pixels above and below the fixed 20px text lines.
          root.style.setProperty(
            '--rio-cell-lines',
            String(Math.max(1, Math.floor((ROW_HEIGHT_PX[rowHeight] - 8) / 20))),
          );
        } else {
          root.style.removeProperty('--rio-cell-lines');
        }
      } else if (kind === 'checkbox' && drawnField?.type === 'checkbox') {
        root.dataset.checked = String(value === true);
        root.style.setProperty('--rio-cell-check-color', `var(--rio-aa-choice-${drawnField.options.color})`);
      } else if (kind === 'checks' && drawnField?.type === 'checkbox' && Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
          let check = root.children.item(index) as HTMLElement | null;
          if (!check) {
            check = checkbox(el.ownerDocument);
            check.className = 'rio-cell-check';
            root.append(check);
          }
          check.dataset.checked = String(item === true);
          check.style.setProperty(
            '--rio-cell-check-color',
            `var(--rio-aa-choice-${drawnField.options.color})`,
          );
        }
        while (root.children.length > value.length) root.lastElementChild!.remove();
      } else if (kind === 'rating' && drawnField?.type === 'rating') {
        const value = typeof cellValue(row, field!) === 'number' ? Number(cellValue(row, field!)) : 0;
        const { max } = drawnField.options;
        root.style.setProperty('--rio-rating-color', `var(--rio-aa-choice-${drawnField.options.color})`);
        root.setAttribute('role', 'img');
        const descriptor = msg({ id: 'grid.rating.label', message: `${value} of ${max}` });
        root.setAttribute(
          'aria-label',
          i18n.locale
            ? i18n._(descriptor)
            : descriptor.message!.replace('{value}', String(value)).replace('{max}', String(max)),
        );
        root.replaceChildren(
          ...Array.from({ length: max }, (_, index) => {
            const node = icon(root!.ownerDocument, ratingIcons[drawnField.options.icon]);
            node.dataset.filled = String(index < value);
            return node;
          }),
        );
      } else if (kind === 'users') {
        root.replaceChildren(
          ...personIds.map((id) => {
            const person = format.collaborators.get(id);
            const name = personLabel(person, id);
            const pill = span(root!.ownerDocument, 'rio-cell-user-pill');
            const avatar = span(root!.ownerDocument, 'rio-person-avatar');
            avatar.dataset.size = 'sm';
            avatar.dataset.color = presenceColor(id);
            avatar.setAttribute('aria-hidden', 'true');
            drawPersonAvatar(avatar, person, name, format.locale);
            const label = span(root!.ownerDocument, 'rio-cell-person__name');
            setText(label, name);
            pill.append(avatar, root!.ownerDocument.createTextNode(' '), label);
            return pill;
          }),
        );
      } else if (kind === 'action' && field?.type === 'button') {
        root.classList.add('rio-field-button', 'rio-field-button--sm');
        root.setAttribute('type', 'button');
        setText(root, buttonLabel(field));
        const id = field.id;
        root.onclick = (event) => {
          event.stopPropagation();
          requestButtonRun(id, row.id);
        };
      } else if ((kind === 'button' || kind === 'buttonOff') && field?.type === 'button') {
        root.classList.add('rio-field-button', 'rio-field-button--sm');
        setText(root, buttonLabel(field));
        if (link?.ok) {
          root.setAttribute('href', link.url);
          root.setAttribute('target', '_blank');
          root.setAttribute('rel', 'noopener noreferrer');
          root.title = words(buttonNewTab);
        } else {
          root.setAttribute('aria-disabled', 'true');
          root.title = words(
            link?.reason === 'missingField'
              ? buttonMissing
              : link?.reason === 'empty'
                ? buttonEmpty
                : buttonInvalid,
          );
        }
      } else if (kind === 'signature' && isSignatureValue(value)) {
        root.classList.add('rio-signature');
        root.setAttribute('role', 'img');
        root.setAttribute('aria-label', display);
        root.title = display;
        drawSignature(root, value);
      } else if (kind === 'attachments') {
        drawAttachments(root, idsOf(value), format.attachments, column.width);
      } else if (kind === 'choices') {
        drawChoices(root, choices);
      } else if (kind === 'person' && typeof value === 'string') {
        const avatar = root.firstElementChild as HTMLElement;
        avatar.dataset.color = presenceColor(value);
        avatar.setAttribute('aria-label', personName);
        drawPersonAvatar(avatar, format.collaborators.get(value), personName, format.locale);
        setText(root.lastElementChild as HTMLElement, personName);
      }
    }
    if (kind === 'empty') {
      if (el.hasChildNodes()) el.replaceChildren();
    } else if (el.firstChild !== root || el.childNodes.length !== 1) {
      el.replaceChildren(root!);
    }
    cache.set(el, {
      sparkline: paint?.sparkline,
      visible,
      field,
      value: Array.isArray(value) ? [...value] : value,
      width: column.width,
      rowHeight,
      locale: format.locale,
      timeZone: format.timeZone,
      personName,
      peoplePictures,
      display,
      fileDetails,
      error,
      hidden,
      kind,
      root,
    });
  };
}

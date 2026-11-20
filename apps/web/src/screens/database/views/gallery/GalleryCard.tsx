import { useState, type PointerEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { cellValue, idsOf, type FieldMeta, type RowData } from '@riosoma/contracts';
import { formatCell } from '../../../../grid/format';
import { CardValue } from '../CardValue';
import type { ViewComponentProps } from '../types';
import { colorDescription, edgeProps } from '../../colors/dom';
import { Painted } from '../../colors/Painted';
import { SortableMovementMenu } from '@riosoma/ui';

interface Props extends Pick<ViewComponentProps, 'attachment' | 'format' | 'colors'> {
  row: RowData | undefined;
  primary: FieldMeta | undefined;
  fields: readonly FieldMeta[];
  settings: ViewComponentProps['view']['config']['gallery'];
  index: number;
  count: number;
  columns: number;
  active: boolean;
  onFocus(): void;
  onOpen(): void;
  onDrag?(event: PointerEvent): void;
  onOrder?(direction: -1 | 1): void;
  destinations?: ReadonlyArray<{ id: string; name: string; move(): void }>;
  dragDescription?: string;
}

export function GalleryCard({
  row,
  primary,
  fields,
  settings,
  attachment,
  format,
  colors,
  index,
  count,
  columns,
  active,
  onFocus,
  onOpen,
  onDrag,
  onOrder,
  dragDescription,
  destinations,
}: Props) {
  'use no memo';
  // Attachment details can arrive through an accessor whose identity stays unchanged.
  const { t, i18n } = useLingui();
  const [failedSource, setFailedSource] = useState<string>();
  const title =
    (row && primary && formatCell(primary, cellValue(row, primary), format)) ||
    t({ id: 'gallery.untitled', message: 'Untitled record' });
  // Stop at unknown metadata so a later image never replaces the first image as details arrive.
  let cover;
  for (const id of idsOf(row?.values[settings.coverFieldId ?? ''] ?? null)) {
    const file = attachment?.(id);
    if (!file) break;
    if (file.type.startsWith('image/')) {
      cover = file;
      break;
    }
  }
  const source = cover?.thumbnails[settings.cardSize === 'large' ? 'large' : 'small'] ?? cover?.url;
  // A record rule draws the card's edge, and the rules behind every color are named for screen readers.
  const edge = edgeProps(row && colors ? colors.record(row) : null);
  const shown = primary ? [primary, ...fields] : fields;
  const colored =
    row && colors ? colorDescription(colors.labels(row, shown), i18n.locale || 'en-US') : undefined;
  return (
    <div
      className={onOrder ? 'rio-gallery-view-card-wrap rio-sortable-surface' : 'rio-gallery-view-card-wrap'}
    >
      <div
        role="gridcell"
        aria-label={row ? undefined : title}
        aria-description={[colored, dragDescription].filter(Boolean).join('  ')}
        aria-keyshortcuts={onOrder ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        aria-selected={active}
        aria-colindex={(index % columns) + 1}
        aria-rowindex={Math.floor(index / columns) + 1}
        aria-busy={!row || undefined}
        tabIndex={active ? 0 : -1}
        data-gallery-index={index}
        data-gallery-draggable={!!onDrag || undefined}
        data-record={row?.id}
        className={`rio-gallery-view-card${edge.className ? ` ${edge.className}` : ''}`}
        style={edge.style}
        onFocus={onFocus}
        onClick={(event) => {
          if (!(event.target as Element).closest('button, a, [role="menu"]')) onOpen();
        }}
        onPointerDown={onDrag}
        onContextMenu={(event) => {
          if (!onOrder) return;
          event.preventDefault();
          event.currentTarget.parentElement
            ?.querySelector<HTMLButtonElement>('.rio-sortable-actions button')
            ?.click();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (onOrder && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
            event.preventDefault();
            event.currentTarget.parentElement
              ?.querySelector<HTMLButtonElement>('.rio-sortable-actions button')
              ?.click();
            return;
          }
          if (onOrder && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            event.stopPropagation();
            onOrder?.(event.key === 'ArrowUp' ? -1 : 1);
            return;
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen();
          }
        }}
      >
        <div className="rio-gallery-view-card__cover" data-fit={settings.coverFit}>
          {source && source !== failedSource && (
            <img src={source} alt="" draggable={false} onError={() => setFailedSource(source)} />
          )}
        </div>
        <div className="rio-gallery-view-card__body">
          <div className="rio-gallery-view-card__title" title={title}>
            {row ? <Painted paint={primary ? colors?.cell(row, primary) : null}>{title}</Painted> : '\u00a0'}
          </div>
          <dl className="rio-gallery-view-card__fields">
            {fields.map((field) => {
              const value = row ? formatCell(field, cellValue(row, field), format) : '';
              return (
                <div key={field.id}>
                  <dt>{field.name}</dt>
                  <dd title={value}>
                    {row && (value || field.type === 'button') ? (
                      // The card opens as one option, so a button inside it is for pointers only.
                      <CardValue
                        field={field}
                        value={cellValue(row, field)}
                        format={format}
                        row={row}
                        focusable={false}
                        paint={colors?.cell(row, field)}
                      />
                    ) : (
                      '\u00a0'
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
        {onOrder ? (
          <SortableMovementMenu
            name={title}
            tabIndex={-1}
            up={index > 0 ? () => onOrder(-1) : undefined}
            down={index < count - 1 ? () => onOrder(1) : undefined}
            destinations={destinations ?? []}
          />
        ) : null}
      </div>
    </div>
  );
}

import { useMemo, type CSSProperties } from 'react';
import { useLingui } from '@lingui/react/macro';
import { faCaretDown } from '@fortawesome/free-solid-svg-icons';
import { AGGREGATE_CAPS, type FieldMeta, type PivotAggregate, type PivotSettings } from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import type { FormatContext } from '../../../../grid/format';
import { pivotModel, type BodyRow, type CellTarget } from './layout';
import { pivotWords } from './messages';
import './pivot.css';

/** The accessible, scrolling pivot table shared by views and dashboard tiles. */
export function PivotTable({
  data,
  settings,
  fields,
  format,
  label,
  refreshing,
  collapsed,
  onCollapsedChange,
  onPick,
  popup,
}: {
  data: PivotAggregate;
  settings: PivotSettings;
  fields: readonly FieldMeta[];
  format: FormatContext;
  label: string;
  refreshing: boolean;
  collapsed: ReadonlySet<string>;
  onCollapsedChange(next: ReadonlySet<string>): void;
  onPick(target: CellTarget): void;
  popup?: 'dialog';
}) {
  const { t, i18n } = useLingui();
  const words = useMemo(() => pivotWords(i18n), [i18n]);
  const model = useMemo(
    () => pivotModel(data, settings, fields, format, words, collapsed),
    [data, settings, fields, format, words, collapsed],
  );
  function toggle(row: BodyRow) {
    const next = new Set(collapsed);
    if (next.has(row.id)) next.delete(row.id);
    else next.add(row.id);
    onCollapsedChange(next);
  }
  const rows = i18n.number(AGGREGATE_CAPS.rows);
  const columns = i18n.number(AGGREGATE_CAPS.columns);
  const note =
    data.capped.rows && data.capped.columns
      ? t({
          id: 'views.pivot.capped.both',
          message: `Showing the first ${rows} rows and the first ${columns} columns.  Totals count every record.`,
        })
      : data.capped.rows
        ? t({
            id: 'views.pivot.capped.rows',
            message: `Showing the first ${rows} rows.  Totals count every record.`,
          })
        : data.capped.columns
          ? t({
              id: 'views.pivot.capped.columns',
              message: `Showing the first ${columns} columns.  Totals count every record.`,
            })
          : null;

  const renderRow = (row: BodyRow, footer = false) => (
    <tr key={row.id} data-group={row.group || undefined} data-total={footer || undefined}>
      <th
        scope="row"
        className="rio-pivot__label"
        style={{ '--rio-pivot-depth': row.depth } as CSSProperties}
      >
        {row.group ? (
          <button
            type="button"
            className="rio-pivot__toggle"
            aria-expanded={!row.collapsed}
            onClick={() => toggle(row)}
          >
            <Icon icon={faCaretDown} className="rio-pivot__caret" />
            <span>{row.label}</span>
          </button>
        ) : (
          row.label
        )}
      </th>
      {row.cells.map((cell, index) => (
        <td key={index} data-total={cell.total || undefined}>
          {cell.target ? (
            <button
              type="button"
              className="rio-pivot__value"
              aria-haspopup={popup}
              aria-label={t({
                id: 'views.pivot.cellRecords',
                message: `${cell.target.title}, ${cell.text}`,
              })}
              onClick={() => onPick(cell.target!)}
            >
              {cell.text}
            </button>
          ) : (
            cell.text
          )}
        </td>
      ))}
    </tr>
  );

  return (
    <div className="rio-pivot">
      {note ? (
        <p className="rio-pivot__note" role="note">
          {note}
        </p>
      ) : null}
      <div className="rio-pivot__body">
        {!data.rows.length ? (
          <div className="rio-pivot__status">
            <p>{t({ id: 'views.pivot.noRecords', message: 'No records to sum up.' })}</p>
          </div>
        ) : (
          <div
            className="rio-pivot__scroll"
            role="region"
            aria-label={label}
            aria-busy={refreshing || undefined}
            tabIndex={0}
          >
            <table className="rio-pivot__table">
              <caption className="rio-pivot__hidden">{label}</caption>
              <thead>
                {model.header.map((cells, row) => (
                  <tr key={row}>
                    {cells.map((cell, index) => (
                      <th
                        key={index}
                        scope="col"
                        colSpan={cell.colSpan}
                        rowSpan={cell.rowSpan}
                        className={cell.corner ? 'rio-pivot__corner' : undefined}
                      >
                        {cell.text}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>{model.rows.map((row) => renderRow(row))}</tbody>
              {model.footer ? <tfoot>{renderRow(model.footer, true)}</tfoot> : null}
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

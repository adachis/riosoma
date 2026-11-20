import { useLingui } from '@lingui/react/macro';
import { faUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import type { FieldMeta, RowData } from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import type { FormatContext } from '../grid/format';
import { buttonLabel, buttonTarget, requestButtonRun } from './buttons';
import './fields.css';

/**
 * A button field's button for one record: a link that opens in a new tab, or, when the record
 * can't make one, the same label marked unavailable with the reason beside it.
 */
export function FieldButton({
  field,
  row,
  format,
  size = 'md',
  showReason = false,
  focusable = true,
}: {
  field: Extract<FieldMeta, { type: 'button' }>;
  row: RowData | null;
  format: FormatContext;
  size?: 'sm' | 'md';
  /** Shows why a button can't be pressed as text, and not only as a tooltip */
  showReason?: boolean;
  /** False where the button sits inside something the keyboard already opens */
  focusable?: boolean;
}) {
  const { t } = useLingui();
  const target = buttonTarget(field, row, format);
  const label = buttonLabel(field);
  const className = `rio-field-button${size === 'sm' ? ' rio-field-button--sm' : ''}`;
  if (field.options.action.kind !== 'openUrl')
    return (
      <button
        type="button"
        className={className}
        disabled={!row}
        tabIndex={focusable ? undefined : -1}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (row) requestButtonRun(field.id, row.id);
        }}
      >
        {label}
      </button>
    );
  if (target.ok)
    return (
      <a
        href={target.url}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        tabIndex={focusable ? undefined : -1}
        // A card opens its record when pressed, and the button opens only its link.
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {label}
        <Icon
          icon={faUpRightFromSquare}
          size="0.8em"
          label={t({ id: 'fields.button.newTab', message: 'Opens in a new tab' })}
        />
      </a>
    );
  const reason =
    target.reason === 'empty'
      ? t({ id: 'fields.button.noLink', message: 'This button doesn’t have a link yet.' })
      : target.reason === 'missingField'
        ? t({ id: 'fields.button.missingField', message: 'This button uses a field that was deleted.' })
        : t({ id: 'fields.button.invalid', message: 'This record doesn’t make a web link for this button.' });
  return (
    <span className="rio-field-button-unavailable">
      <span className={className} aria-disabled="true" title={reason}>
        {label}
      </span>
      {showReason && <span className="rio-field-button-unavailable__reason">{reason}</span>}
    </span>
  );
}

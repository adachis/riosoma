import { faSquare, faSquareCheck } from '@fortawesome/free-solid-svg-icons';
import { Fragment } from 'react';
import { idsOf, isSignatureValue, type CellValue, type FieldMeta, type RowData } from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import { ChoicePill } from '@riosoma/ui';
import { formatCell, type FormatContext } from '../../../grid/format';
import { FieldButton } from '../../../fields/FieldButton';
import { SignatureView } from '../../../fields/SignatureView';
import { Painted } from '../colors/Painted';
import type { Paint } from '../colors/paint';
import './card-value.css';

/**
 * A field's value on a card: choices as pills, checkboxes as marks, signatures as small drawings,
 * and buttons as buttons, everything else as the grid would copy it.  The text version stays
 * available to screen readers and tooltips.  A value the view colors sits on its tint, or beside
 * its data bar.
 */
export function CardValue({
  field,
  value,
  format,
  row,
  focusable = true,
  paint,
}: {
  field: FieldMeta;
  value: CellValue;
  format: FormatContext;
  /** The record, which a button fills its link from */
  row?: RowData | null;
  /** False inside a card the keyboard already opens as one piece */
  focusable?: boolean;
  paint?: Paint | null;
}) {
  if (field.type === 'button')
    return <FieldButton field={field} row={row ?? null} format={format} size="sm" focusable={focusable} />;
  return (
    <Painted paint={paint}>
      <PlainValue field={field} value={value} format={format} />
    </Painted>
  );
}

function PlainValue({ field, value, format }: { field: FieldMeta; value: CellValue; format: FormatContext }) {
  if (field.type === 'signature' && isSignatureValue(value))
    return <SignatureView value={value} format={format} size="sm" />;
  const text = formatCell(field, value, format);
  if (field.type === 'checkbox') {
    return (
      <span className="rio-card-value rio-card-value--check" data-checked={value === true}>
        <Icon icon={value === true ? faSquareCheck : faSquare} aria-hidden="true" />
        <span className="rio-card-value__text">{text}</span>
      </span>
    );
  }
  if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
    const ids = field.type === 'singleSelect' ? (typeof value === 'string' ? [value] : []) : idsOf(value);
    const choices = ids
      .map((id) => field.options.choices.find((choice) => choice.id === id))
      .filter((choice) => choice !== undefined);
    if (!choices.length) return null;
    return (
      <span className="rio-card-value rio-card-value--choices">
        {choices.map((choice, index) => (
          <Fragment key={choice.id}>
            {index > 0 && ' '}
            <ChoicePill name={choice.name} color={choice.color} size="sm" />
          </Fragment>
        ))}
      </span>
    );
  }
  return <>{text}</>;
}

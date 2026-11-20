import { MoreFieldInput } from '../../fields/MoreFieldInput';
import { useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  cellValue,
  isDateRangeValue,
  isLocationValue,
  isSignatureValue,
  type CellValue,
} from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { DateRangeInput } from '../../fields/DateRangeInput';
import { RichTextEditor } from './RichTextEditor';
import { LocationInput } from '../../fields/LocationInput';
import { SignatureInput } from '../../fields/SignatureInput';
import { EditorPopover } from './EditorPopover';
import { applyValue, type EditorProps } from './types';

/**
 * The grid's editors for date ranges, JSON, locations, and signatures: the record card's own
 * inputs in a popover.  Dismissing one leaves the cell as it was, and each says how it saves.
 */
function useFinish(request: EditorProps['request']) {
  const ended = useRef(false);
  return (move: 'down' | 'none') => {
    if (ended.current) return;
    ended.current = true;
    if (move === 'none') request.cancel();
    else request.done(move);
  };
}

/** Applies each finished range at once, and Done closes the popover. */
export function DateRangeEditor(props: EditorProps) {
  const { request, context } = props;
  const { t } = useLingui();
  const finish = useFinish(request);
  const field = context.field;
  const [value, setValue] = useState(() => {
    const stored = cellValue(request.row, field);
    return isDateRangeValue(stored) ? stored : null;
  });
  if (field.type !== 'dateRange') return null;
  function apply(next: CellValue) {
    if (applyValue(context, next)) setValue(isDateRangeValue(next) ? next : null);
  }
  return (
    <EditorPopover {...props} onDismiss={() => finish('none')}>
      <DateRangeInput
        options={field.options}
        value={value}
        format={context.format}
        label={field.name}
        autoFocus
        onChange={apply}
      />
      <div className="rio-field-input__actions">
        <Button variant="primary" onPress={() => finish('down')}>
          {t({ id: 'fields.dateRange.done', message: 'Done' })}
        </Button>
        <Button
          onPress={() => {
            if (applyValue(context, null)) finish('down');
          }}
        >
          {t({ id: 'fields.dateRange.clear', message: 'Clear' })}
        </Button>
      </div>
    </EditorPopover>
  );
}

/** Saves through Save or Ctrl+Enter, and not while the JSON doesn't parse. */
export function JsonEditor(props: EditorProps) {
  return <RichTextEditor {...props} />;
}

/** Saves through Save or Enter, or at once with "Use my location". */
export function LocationEditor(props: EditorProps) {
  const { request, context } = props;
  const finish = useFinish(request);
  const field = context.field;
  const stored = cellValue(request.row, field);
  if (field.type !== 'location') return null;
  return (
    <EditorPopover {...props} onDismiss={() => finish('none')}>
      <LocationInput
        value={isLocationValue(stored) ? stored : null}
        label={field.name}
        autoFocus
        saveOnBlur={false}
        onChange={(next) => {
          if (applyValue(context, next)) finish('down');
        }}
        onCancel={() => finish('none')}
      />
    </EditorPopover>
  );
}

/** Signs, signs again, or removes.  A signature is never edited in place. */
export function SignatureEditor(props: EditorProps) {
  const { request, context } = props;
  const finish = useFinish(request);
  const field = context.field;
  const stored = cellValue(request.row, field);
  if (field.type !== 'signature') return null;
  return (
    <EditorPopover {...props} onDismiss={() => finish('none')}>
      <SignatureInput
        field={field}
        value={isSignatureValue(stored) ? stored : null}
        format={context.format}
        autoFocus
        onChange={(next) => {
          if (applyValue(context, next)) finish('down');
        }}
        onCancel={() => finish('none')}
      />
    </EditorPopover>
  );
}

export function MoreFieldEditor(props: EditorProps) {
  const { t } = useLingui();
  const { request, context } = props;
  const finish = useFinish(request);
  const field = context.field;
  const [value, setValue] = useState(cellValue(request.row, field));
  if (field.type !== 'barcode' && field.type !== 'time' && field.type !== 'multiCurrency') return null;
  return (
    <EditorPopover {...props} onDismiss={() => finish('none')}>
      <MoreFieldInput
        field={field}
        value={value}
        format={context.format}
        autoFocus
        onChange={(next) => {
          if (applyValue(context, next)) setValue(next);
        }}
      />
      <Button onPress={() => finish('down')}>{t({ id: 'fields.more.done', message: 'Done' })}</Button>
    </EditorPopover>
  );
}

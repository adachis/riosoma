import { MoreFieldInput } from '../../../fields/MoreFieldInput';
import type { DatabaseSession } from '../../../data';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  checkCellValue,
  idsOf,
  isDateRangeValue,
  isLocationValue,
  isSignatureValue,
  sameValue,
  type CellValue,
  type FieldMeta,
} from '@riosoma/contracts';
import { Checkbox, DatePicker, Link, NumberField, TextArea, TextField } from '@riosoma/ui';
import { linkTarget } from '../../../grid/cells/renderers';
import { editText, type FormatContext } from '../../../grid/format';
import { parseText } from '../../../grid/parse';
import { SERVER_MESSAGES } from '../../../messages/server';
import { RatingControl } from '../../../grid/editors/RatingEditor';
import { UserPicker } from '../../../grid/editors/UserEditor';
import { NumericFieldInput } from '../../../grid/editors/NumericFieldInput';
import { SelectEditor } from './SelectEditor';
import { DateRangeInput } from '../../../fields/DateRangeInput';
import { JsonInput } from '../../../fields/JsonInput';
import { LocationInput } from '../../../fields/LocationInput';
import { SignatureInput } from '../../../fields/SignatureInput';
import { RichTextInput } from '../../../fields/richText/lazy';
import { TextCellInput, type TextCellHandle } from '../../../fields/TextCellInput';

export interface FieldEditorProps {
  ref?: Ref<TextCellHandle>;
  recordId?: string;
  session?: DatabaseSession;
  field: FieldMeta;
  value: CellValue;
  values?: Readonly<Record<string, unknown>>;
  format: FormatContext;
  labelId: string;
  autoFocus: boolean;
  canEditOptions: boolean;
  onChange: (fieldId: string, value: CellValue) => void;
  onAddOption: (fieldId: string, name: string) => string;
}

/** The grid's rules, so a value links the same way in both places (bare domains included). */
function safeHref(field: FieldMeta, value: string): string | undefined {
  return linkTarget(field.type, value.trim()) ?? undefined;
}

export function FieldEditor({ ref, ...props }: FieldEditorProps) {
  const { field, value, format, labelId, autoFocus, onChange } = props;
  if (props.session && props.recordId && (field.type === 'longText' || field.type === 'json'))
    return (
      <TextCellInput
        ref={ref}
        session={props.session}
        recordId={props.recordId}
        field={field}
        value={typeof value === 'string' ? value : null}
        labelId={labelId}
        autoFocus={autoFocus}
      />
    );
  // The inputs below check their own values, and this keeps the stored shape the same everywhere.
  const apply = (next: CellValue) => {
    const checked = checkCellValue(field, next);
    if (checked.ok) onChange(field.id, checked.value);
  };
  if (field.type === 'barcode' || field.type === 'time' || field.type === 'multiCurrency')
    return (
      <MoreFieldInput
        field={field}
        value={value}
        format={format}
        labelId={labelId}
        autoFocus={autoFocus}
        onChange={apply}
      />
    );
  if (field.type === 'dateRange')
    return (
      <div className="rio-record-card__editor">
        <DateRangeInput
          options={field.options}
          value={isDateRangeValue(value) ? value : null}
          format={format}
          labelId={labelId}
          autoFocus={autoFocus}
          onChange={apply}
        />
      </div>
    );
  if (field.type === 'json')
    return (
      <div className="rio-record-card__editor">
        <JsonInput
          value={typeof value === 'string' ? value : null}
          labelId={labelId}
          autoFocus={autoFocus}
          onChange={apply}
        />
      </div>
    );
  if (field.type === 'location')
    return (
      <div className="rio-record-card__editor">
        <LocationInput
          value={isLocationValue(value) ? value : null}
          labelId={labelId}
          autoFocus={autoFocus}
          onChange={apply}
        />
      </div>
    );
  if (field.type === 'signature')
    return (
      <div className="rio-record-card__editor" role="group" aria-labelledby={labelId}>
        <SignatureInput
          field={field}
          value={isSignatureValue(value) ? value : null}
          format={format}
          autoFocus={autoFocus}
          onChange={apply}
        />
      </div>
    );
  if (field.type === 'currency' || field.type === 'percent' || field.type === 'duration')
    return (
      <NumericFieldInput
        field={field}
        value={typeof value === 'number' ? value : null}
        format={format}
        labelId={labelId}
        autoFocus={autoFocus}
        onChange={(next) => onChange(field.id, next)}
      />
    );
  if (field.type === 'rating')
    return (
      <RatingControl
        options={field.options}
        value={typeof value === 'number' ? value : null}
        label={field.name}
        autoFocus={autoFocus}
        onChange={(next) => onChange(field.id, next)}
      />
    );
  if (field.type === 'user')
    return (
      <UserPicker
        collaborators={format.collaborators}
        selected={idsOf(value)}
        multiple={field.options.allowMultiple}
        label={field.name}
        locale={format.locale}
        autoFocus={autoFocus}
        onChange={(ids) => onChange(field.id, ids.length ? ids : null)}
      />
    );
  if (field.type === 'singleSelect' || field.type === 'multipleSelect')
    return <SelectEditor {...props} field={field} locale={format.locale} />;
  if (field.type === 'longText' && field.options.richText)
    return (
      <div className="rio-record-card__editor">
        <RichTextInput
          value={typeof value === 'string' ? value : null}
          labelId={labelId}
          autoFocus={autoFocus}
          onChange={apply}
        />
      </div>
    );
  if (field.type === 'checkbox')
    return (
      <div className="rio-record-card__editor">
        <Checkbox
          aria-labelledby={labelId}
          autoFocus={autoFocus}
          isSelected={value === true}
          onChange={(next) => {
            const checked = checkCellValue(field, next);
            if (checked.ok) onChange(field.id, checked.value);
          }}
        />
      </div>
    );
  return <DraftEditor {...props} />;
}

function DraftEditor({ field, value, format, labelId, onChange }: FieldEditorProps) {
  const { t, i18n } = useLingui();
  const initial = editText(field, value, format);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const [raw, setRaw] = useState(false);
  const [revision, setRevision] = useState(0);
  const [number, setNumber] = useState(typeof value === 'number' ? value : NaN);
  const [date, setDate] = useState(typeof value === 'string' ? value : null);
  const [lastSaved, setLastSaved] = useState(value);
  const [source, setSource] = useState(value);
  if (!sameValue(source, value)) {
    setSource(value);
    setLastSaved(value);
    setDraft(editText(field, value, format));
    setNumber(typeof value === 'number' ? value : NaN);
    setDate(typeof value === 'string' ? value : null);
    setError('');
    setRaw(false);
  }
  const root = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const dateDirty = useRef(false);
  const numberDirty = useRef(false);

  useLayoutEffect(() => {
    if (restoreFocus.current) {
      restoreFocus.current = false;
      let canceled = false;
      queueMicrotask(() => {
        if (!canceled) root.current?.querySelector<HTMLElement>('input, [role="spinbutton"]')?.focus();
      });
      return () => {
        canceled = true;
      };
    }
  }, [raw, revision]);

  useLayoutEffect(() => {
    const area = root.current?.querySelector('textarea');
    if (!area) return;
    // Measuring wrapped lines as well as newlines keeps long paragraphs inside twelve lines.
    area.style.blockSize = 'auto';
    area.style.blockSize = `${area.scrollHeight}px`;
  }, [draft]);

  function message(key: string): string {
    if (key === 'notNumber' || key === 'data.value.notNumber')
      return t({ id: 'record.notNumber', message: 'Enter a number.' });
    if (key === 'notDate' || key === 'data.value.notDate')
      return t({ id: 'record.notDate', message: 'Enter a date.' });
    const descriptor = SERVER_MESSAGES[key];
    return descriptor ? i18n._(descriptor) : '';
  }

  function save(text: string): boolean {
    const parsed = parseText(field, text, format);
    if (parsed.ok !== true) {
      if (parsed.ok === false) setError(message(parsed.reason));
      return false;
    }
    const checked = checkCellValue(field, parsed.value);
    if (!checked.ok) {
      setError(message(checked.messageKey));
      return false;
    }
    setError('');
    setDraft(editText(field, checked.value, format));
    if (!sameValue(lastSaved, checked.value)) {
      setLastSaved(checked.value);
      onChange(field.id, checked.value);
    }
    if (raw) {
      setNumber(typeof checked.value === 'number' ? checked.value : NaN);
      setDate(typeof checked.value === 'string' ? checked.value : null);
      restoreFocus.current = root.current?.contains(document.activeElement) ?? false;
      setRaw(false);
    }
    return true;
  }

  function showRaw(text: string) {
    setDraft(text);
    restoreFocus.current = root.current?.contains(document.activeElement) ?? false;
    setRaw(true);
  }

  function revert(event: KeyboardEvent) {
    const dirty =
      draft !== editText(field, lastSaved, format) ||
      raw ||
      error !== '' ||
      dateDirty.current ||
      numberDirty.current;
    if (event.key !== 'Escape' || !dirty) return false;
    event.preventDefault();
    event.stopPropagation();
    setDraft(editText(field, lastSaved, format));
    setNumber(typeof lastSaved === 'number' ? lastSaved : NaN);
    setDate(typeof lastSaved === 'string' ? lastSaved : null);
    setError('');
    setRaw(false);
    dateDirty.current = false;
    numberDirty.current = false;
    restoreFocus.current = true;
    setRevision((current) => current + 1);
    return true;
  }

  function commitNumber(input: HTMLInputElement) {
    if (!numberDirty.current) return;
    const text = input.value;
    setDraft(text);
    if (!save(text)) showRaw(text);
    else numberDirty.current = false;
  }

  const common = {
    'aria-labelledby': labelId,
    isInvalid: error !== '',
    validationBehavior: 'aria' as const,
    'aria-describedby': `${labelId}-error`,
  };
  const href = safeHref(field, draft);
  const numeric = field.type === 'number' && !raw;
  const dated = field.type === 'date' && !raw;

  return (
    <div
      ref={root}
      className="rio-record-card__editor"
      onInputCapture={(event) => {
        if (numeric && event.target instanceof HTMLInputElement) {
          numberDirty.current = true;
          // Capture updates can reset the controlled input before its change handler reads it.
        }
      }}
      onPointerDownCapture={(event) => {
        if (numeric && event.target instanceof Element && event.target.closest('button'))
          numberDirty.current = true;
      }}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || revert(event)) return;
        if (numeric && event.target instanceof HTMLInputElement) {
          const input = event.target;
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') numberDirty.current = true;
          if (event.key === 'Enter') {
            event.preventDefault();
            commitNumber(input);
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const text =
              input.value.slice(0, input.selectionStart ?? 0) +
              event.key +
              input.value.slice(input.selectionEnd ?? input.value.length);
            const parsed = parseText(field, text, format);
            if (parsed.ok !== true || !checkCellValue(field, parsed.value).ok) {
              // The numeric control rejects unreadable keystrokes; retain them for correction instead.
              event.preventDefault();
              event.stopPropagation();
              showRaw(text);
            }
          }
        }
        if (dated && !['Tab', 'Escape', 'Enter'].includes(event.key)) dateDirty.current = true;
      }}
      onPasteCapture={(event) => {
        if (!numeric && !dated) return;
        const pasted = event.clipboardData.getData('text');
        const input = event.target;
        const text =
          numeric && input instanceof HTMLInputElement
            ? input.value.slice(0, input.selectionStart ?? 0) +
              pasted +
              input.value.slice(input.selectionEnd ?? input.value.length)
            : pasted;
        event.preventDefault();
        event.stopPropagation();
        if (dated && save(text)) {
          const parsed = parseText(field, text, format);
          if (parsed.ok === true) setDate(typeof parsed.value === 'string' ? parsed.value : null);
        } else {
          showRaw(text);
          if (dated) setError(message('notDate'));
        }
      }}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        if (numeric) {
          const input = root.current?.querySelector('input');
          if (input) commitNumber(input);
        }
        if (dated && dateDirty.current) {
          const segments = root.current?.querySelectorAll('[role="spinbutton"]');
          if (segments && [...segments].some((segment) => segment.hasAttribute('data-placeholder')))
            setError(message('notDate'));
        }
      }}
    >
      {numeric ? (
        <NumberField
          key={revision}
          {...common}
          value={number}
          onChange={(next) => {
            setNumber(next);
            if (numberDirty.current) setDraft(editText(field, Number.isNaN(next) ? null : next, format));
          }}
          minValue={field.options.allowNegative ? undefined : 0}
          step={field.options.precision === null ? undefined : 10 ** -field.options.precision}
          formatOptions={{
            useGrouping: field.options.thousands,
            minimumFractionDigits: field.options.precision ?? 0,
            maximumFractionDigits: field.options.precision ?? 10,
          }}
        />
      ) : dated ? (
        <DatePicker
          key={revision}
          {...common}
          value={date}
          includeTime={field.options.includeTime}
          timeZone={field.options.timeZone === 'client' ? format.timeZone : field.options.timeZone}
          hourCycle={
            field.options.timeFormat === '12h' ? 12 : field.options.timeFormat === '24h' ? 24 : undefined
          }
          onChange={(next) => {
            if (save(next ?? '')) {
              setDate(next);
              dateDirty.current = false;
            }
          }}
        />
      ) : (
        <div className="rio-record-card__text-control">
          {field.type === 'longText' ? (
            <TextArea
              {...common}
              className="rio-record-card__long-text"
              rows={1}
              value={draft}
              onChange={setDraft}
              onBlur={() => {
                save(draft);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  (event.ctrlKey || event.metaKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  save(draft);
                } else event.continuePropagation();
              }}
            />
          ) : (
            <TextField
              {...common}
              value={draft}
              onChange={setDraft}
              onBlur={() => {
                save(draft);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  save(draft);
                } else event.continuePropagation();
              }}
            />
          )}
          {['url', 'email', 'phone'].includes(field.type) && (
            <span className="rio-record-card__open">
              {href && (
                <Link href={href} external>
                  {t({ id: 'record.open', message: 'Open' })}
                </Link>
              )}
            </span>
          )}
        </div>
      )}
      <div id={`${labelId}-error`} className="rio-record-card__error" aria-live="polite">
        {error}
      </div>
    </div>
  );
}

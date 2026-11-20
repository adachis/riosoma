import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { FieldMeta } from '@riosoma/contracts';
import { TextField } from '@riosoma/ui';
import { editText, formatCell, type FormatContext } from '../format';
import { parseNumericText, parseText } from '../parse';
import { serverMessage } from '../../messages/useServerMessage';

interface NumericFieldInputProps {
  field: FieldMeta;
  value: number | null;
  format: FormatContext;
  label?: string;
  labelId?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  filter?: boolean;
  onChange: (value: number | null) => void;
}

/** Keep incomplete text editable; a blur formats only a successfully parsed value. */
export function NumericFieldInput({
  field,
  value,
  format,
  label,
  labelId,
  autoFocus,
  readOnly,
  filter,
  onChange,
}: NumericFieldInputProps) {
  const { i18n, t } = useLingui();
  const [source, setSource] = useState(value);
  const [saved, setSaved] = useState(value);
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(formatCell(field, value, format));
  const [error, setError] = useState('');
  if (source !== value) {
    setSource(value);
    setSaved(value);
    if (!focused) setDraft(formatCell(field, value, format));
  }
  function parse(text: string): { value: number | null; error?: never } | { error: string } {
    if (filter) {
      if (!text.trim()) return { value: null };
      const value = parseNumericText(field, text, format.locale);
      return value === null ? { error: 'notNumber' } : { value };
    }
    const result = parseText(field, text, format);
    return result.ok === true && (result.value === null || typeof result.value === 'number')
      ? { value: result.value }
      : { error: result.ok === false ? result.reason : 'notNumber' };
  }
  function save(text: string, blur: boolean) {
    const result = parse(text);
    if (result.error !== undefined) {
      if (filter && saved !== null) {
        setSaved(null);
        onChange(null);
      }
      setError(
        result.error === 'notNumber'
          ? t({ id: 'record.notNumber', message: 'Enter a number.' })
          : serverMessage(i18n, result.error),
      );
      return;
    }
    setError('');
    setSaved(result.value);
    if (result.value !== saved) onChange(result.value);
    if (blur) setDraft(formatCell(field, result.value, format));
  }
  return (
    <TextField
      aria-label={label}
      aria-labelledby={labelId}
      autoFocus={autoFocus}
      value={draft}
      isDisabled={readOnly}
      isInvalid={Boolean(error)}
      errorMessage={error}
      validationBehavior="aria"
      onFocus={() => {
        setFocused(true);
        if (!error) setDraft(editText(field, saved, format));
      }}
      onChange={(text) => {
        setDraft(text);
        if (filter) save(text, false);
      }}
      onBlur={() => {
        setFocused(false);
        save(draft, true);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) {
          event.continuePropagation();
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          save(draft, false);
        } else if (event.key === 'Escape' && (error || draft !== editText(field, saved, format))) {
          event.preventDefault();
          setError('');
          setDraft(editText(field, saved, format));
        } else event.continuePropagation();
      }}
    />
  );
}

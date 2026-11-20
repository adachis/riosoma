import { useImperativeHandle, useState, type KeyboardEvent, type Ref } from 'react';
import { useLingui } from '@lingui/react/macro';
import { LIMITS, minifyJson, prettyJson } from '@riosoma/contracts';
import { Button, TextArea } from '@riosoma/ui';
import { jsonProblem } from './json';
import './fields.css';

export interface JsonInputProps {
  ref?: Ref<JsonInputHandle>;
  /** The stored JSON text, or null */
  value: string | null;
  labelId?: string;
  label?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  rows?: number;
  /** Saves when focus leaves, or only through Save when false */
  saveOnBlur?: boolean;
  onChange: (value: string | null) => void;
  /** With `saveOnBlur` false: leaves without saving */
  onCancel?: () => void;
}

export interface JsonInputHandle {
  save(): boolean;
}

/**
 * JSON as a formatted, monospace block.  Saving checks it.  JSON that doesn't parse stays in the
 * box with a message saying where it stops making sense, and nothing is saved until it does.
 */
export function JsonInput({
  value,
  labelId,
  label,
  autoFocus,
  readOnly,
  rows = 8,
  saveOnBlur = true,
  onChange,
  onCancel,
  ref,
}: JsonInputProps) {
  const { t } = useLingui();
  const [source, setSource] = useState(value);
  const [draft, setDraft] = useState(() => (value === null ? '' : prettyJson(value)));
  const [error, setError] = useState('');
  if (source !== value) {
    setSource(value);
    setDraft(value === null ? '' : prettyJson(value));
    setError('');
  }

  function problem(text: string): string {
    const place = jsonProblem(text);
    if (!place)
      return t({
        id: 'fields.json.invalid',
        message: 'This isn’t valid JSON.  Check the quotes, commas, and brackets.',
      });
    const { line, column } = place;
    return t({
      id: 'fields.json.invalidAt',
      message: `This isn’t valid JSON.  Check line ${line}, column ${column}.`,
    });
  }

  function save(): boolean {
    // Saving by hand always reports back, so whatever holds the input open can close it.
    if (draft.trim() === '') {
      setError('');
      if (value !== null || !saveOnBlur) onChange(null);
      return true;
    }
    const compact = minifyJson(draft);
    if (compact === null) {
      setError(problem(draft));
      return false;
    }
    if (compact.length > LIMITS.jsonLength) {
      setError(t({ id: 'fields.json.tooLong', message: 'This JSON is too long to save.' }));
      return false;
    }
    setError('');
    const stored = compact === 'null' ? null : compact;
    setDraft(stored === null ? '' : prettyJson(stored));
    if (stored !== value || !saveOnBlur) onChange(stored);
    return true;
  }

  function revert(event: KeyboardEvent) {
    const saved = value === null ? '' : prettyJson(value);
    if (draft === saved && !error) return false;
    event.preventDefault();
    event.stopPropagation();
    setDraft(saved);
    setError('');
    return true;
  }

  useImperativeHandle(ref, () => ({ save }));

  const errorId = `${labelId ?? 'json'}-json-error`;
  return (
    <div className="rio-json-input">
      <TextArea
        aria-labelledby={labelId}
        aria-label={labelId ? undefined : label}
        aria-describedby={errorId}
        className="rio-json-input__text"
        rows={rows}
        value={draft}
        autoFocus={autoFocus}
        isReadOnly={readOnly}
        isInvalid={error !== ''}
        validationBehavior="aria"
        spellCheck="false"
        onChange={(next) => {
          setDraft(next);
          if (error) setError('');
        }}
        onBlur={() => {
          if (saveOnBlur && !readOnly) save();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return event.continuePropagation();
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (!readOnly) save();
          } else if (event.key === 'Escape' && saveOnBlur) {
            if (!revert(event)) event.continuePropagation();
          } else event.continuePropagation();
        }}
      />
      <div id={errorId} className="rio-field-input__error" aria-live="polite">
        {error}
      </div>
      {!saveOnBlur && (
        <div className="rio-field-input__actions">
          <Button
            variant="primary"
            isDisabled={readOnly}
            onPress={() => {
              save();
            }}
          >
            {t({ id: 'fields.json.save', message: 'Save' })}
          </Button>
          {onCancel && (
            <Button onPress={onCancel}>{t({ id: 'fields.json.cancel', message: 'Cancel' })}</Button>
          )}
        </div>
      )}
    </div>
  );
}

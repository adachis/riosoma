import { useLingui } from '@lingui/react/macro';
import { useId, useRef, useState } from 'react';
import './ScriptField.css';

export function indentScript(value: string, start: number, end: number, outdent: boolean) {
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const next = value.indexOf('\n', last);
  const to = next < 0 ? value.length : next;
  const lines = value.slice(from, to).split('\n');
  const changes = lines.map((line) => (outdent ? -Math.min(2, /^ */.exec(line)![0].length) : 2));
  const text = lines.map((line, i) => (outdent ? line.slice(-changes[i]!) : `  ${line}`)).join('\n');
  return {
    value: value.slice(0, from) + text + value.slice(to),
    start: Math.max(from, start + changes[0]!),
    end: Math.max(from, end + changes.reduce((sum, change) => sum + change, 0)),
  };
}

export function ScriptField({
  value,
  onChange,
  readOnly,
  errorLine,
  label,
  completions = [],
}: {
  value: string;
  onChange(value: string): void;
  readOnly: boolean;
  errorLine?: number;
  label?: string;
  completions?: readonly string[];
}) {
  const { t } = useLingui();
  const id = useId();
  const escaped = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [suggesting, setSuggesting] = useState(false);
  const fragment = /(?:"[^"]*|[\p{L}\p{N}_]+)$/u.exec(value.slice(0, caret));
  const suggestions =
    suggesting && fragment
      ? completions
          .filter((item) =>
            item.toLocaleLowerCase().includes(fragment[0].replaceAll('"', '').toLocaleLowerCase()),
          )
          .slice(0, 12)
      : [];
  const complete = (suggestion: string) => {
    const start = fragment?.index ?? caret;
    onChange(value.slice(0, start) + suggestion + value.slice(caret));
    setSuggesting(false);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(start + suggestion.length, start + suggestion.length);
    });
  };
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const line = position.line;
  const column = position.column;
  return (
    <div className="rio-script-field">
      <label htmlFor={id}>{label ?? t({ id: 'automations.script.code', message: 'JavaScript' })}</label>
      <div className="rio-script-field__body">
        <div className="rio-script-field__lines" aria-hidden="true">
          {value.split('\n').map((_, index) => (
            <div key={index} data-error={index + 1 === errorLine}>
              {index + 1}
            </div>
          ))}
        </div>
        <textarea
          id={id}
          ref={input}
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          wrap="off"
          rows={Math.max(8, value.split('\n').length)}
          style={
            errorLine
              ? {
                  backgroundImage: `linear-gradient(to bottom, var(--rio-surface) calc(var(--rio-space-2) + ${errorLine - 1} * 1.5em), color-mix(in srgb, var(--rio-danger) 12%, var(--rio-surface)) calc(var(--rio-space-2) + ${errorLine - 1} * 1.5em), color-mix(in srgb, var(--rio-danger) 12%, var(--rio-surface)) calc(var(--rio-space-2) + ${errorLine} * 1.5em), var(--rio-surface) calc(var(--rio-space-2) + ${errorLine} * 1.5em))`,
                }
              : undefined
          }
          aria-describedby={`${id}-hint`}
          aria-invalid={Boolean(errorLine)}
          onChange={(event) => {
            onChange(event.target.value);
            setCaret(event.target.selectionStart);
            setSuggesting(true);
          }}
          onSelect={(event) => {
            const field = event.currentTarget;
            setCaret(field.selectionStart);
            const before = field.value.slice(0, field.selectionStart);
            setPosition({
              line: before.split('\n').length,
              column: before.length - before.lastIndexOf('\n'),
            });
          }}
          onBlur={() => {
            escaped.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.ctrlKey && suggestions[0]) {
              event.preventDefault();
              complete(suggestions[0]);
              return;
            }
            if (event.key === 'Escape') {
              // Escape releases Tab from the editor without dismissing its enclosing dialog.
              event.stopPropagation();
              setSuggesting(false);
              escaped.current = true;
              return;
            }
            if (event.key !== 'Tab') {
              escaped.current = false;
              return;
            }
            if (escaped.current || readOnly) {
              escaped.current = false;
              return;
            }
            event.preventDefault();
            const field = event.currentTarget;
            const result = indentScript(value, field.selectionStart, field.selectionEnd, event.shiftKey);
            onChange(result.value);
            requestAnimationFrame(() => field.setSelectionRange(result.start, result.end));
          }}
        />
      </div>
      {suggestions.length > 0 && (
        <div aria-label={t({ id: 'sql.completions', message: 'Table and field suggestions' })}>
          {suggestions.map((suggestion) => (
            <button type="button" key={suggestion} onClick={() => complete(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <span>{t({ id: 'automations.script.position', message: `Line ${line}, column ${column}` })}</span>
      <p id={`${id}-hint`}>
        {t({
          id: 'automations.script.keyboard',
          message:
            'Tab indents by two spaces.  Shift+Tab outdents.  Press Escape, then Tab to leave the field.',
        })}
      </p>
    </div>
  );
}

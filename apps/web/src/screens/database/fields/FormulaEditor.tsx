import { useId, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { msg, plural } from '@lingui/core/macro';
import type {
  FieldMeta,
  FieldOptionsOf,
  ResultType,
  NamedFunctionMeta,
  NamedFunctionInput,
} from '@riosoma/contracts';
import { FUNCTIONS, prepareNamedFunctions, describe as describeFormula } from '@riosoma/formula';
import { TextArea } from '@riosoma/ui';
import { checkFormula, formulaDisplay } from '../../../data/formulas';
import { useServerMessage } from '../../../messages/useServerMessage';
import { anchor } from '../../../demos/anchors';

const TYPE_NAMES = {
  number: msg({ id: 'field.formula.type.number', message: 'Number' }),
  text: msg({ id: 'field.formula.type.text', message: 'Text' }),
  boolean: msg({ id: 'field.formula.type.boolean', message: 'True or false' }),
  date: msg({ id: 'field.formula.type.date', message: 'Date' }),
  datetime: msg({ id: 'field.formula.type.datetime', message: 'Date and time' }),
  array: msg({ id: 'field.formula.type.array', message: 'List' }),
} satisfies Record<ResultType, ReturnType<typeof msg>>;

function completionAt(
  source: string,
  caret: number,
): { index: number; end: number; query: string; field: boolean } | undefined {
  let quote = '';
  let opening = -1;
  for (let index = 0; index < caret; index++) {
    const character = source[index];
    if (character === '\\') {
      index++;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (opening >= 0) {
      if (character === '}') opening = -1;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '{') opening = index;
  }
  if (quote) return;
  if (opening >= 0) {
    let end = caret;
    for (let index = caret; index < source.length; index++) {
      if (source[index] === '\\') {
        index++;
        continue;
      }
      if (source[index] === '}') {
        end = index + 1;
        break;
      }
    }
    return {
      index: opening,
      end,
      query: source.slice(opening + 1, caret).replace(/\\([}\\])/g, '$1'),
      field: true,
    };
  }
  const word = /\b([A-Za-z_][A-Za-z_0-9]*)$/.exec(source.slice(0, caret));
  if (word)
    return {
      index: word.index,
      end: caret + (/^[A-Za-z_0-9]*/.exec(source.slice(caret))?.[0].length ?? 0),
      query: word[1]!,
      field: false,
    };
}

export function FormulaEditor({
  options,
  fields,
  fieldId,
  tables = [],
  tableId,
  namedFunctions = [],
  bodyDefinition,
  isReadOnly,
  onChange,
}: {
  options: FieldOptionsOf<'formula'>;
  bodyDefinition?: NamedFunctionInput;
  isReadOnly?: boolean;
  fields: readonly FieldMeta[];
  namedFunctions?: readonly NamedFunctionMeta[];
  fieldId?: string;
  tableId?: string;
  tables?: readonly { id: string; name: string }[];
  onChange: (options: FieldOptionsOf<'formula'>) => void;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const [draft, setDraft] = useState(() =>
    bodyDefinition ? options.expression : formulaDisplay(options.expression, fields, tables, tableId),
  );
  const [caret, setCaret] = useState(draft.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const checked = bodyDefinition
    ? prepareNamedFunctions(
        [...namedFunctions, { ...bodyDefinition, body: draft }].map(({ name, parameters, body }) => ({
          name,
          parameters,
          body,
        })),
      )
    : checkFormula(draft, fields, fieldId, tables, tableId, namedFunctions);
  // An empty formula isn't a mistake yet; the Create button stays off until there's something to check.
  const error = draft.trim() !== '' && 'error' in checked ? checked.error : undefined;
  const type = 'type' in checked ? i18n._(TYPE_NAMES[checked.type]) : '';
  // Lookups read as one value, which is worth knowing before a record links to two.
  const oneValue =
    'oneValue' in checked
      ? checked.oneValue.flatMap((reference) => fields.find((field) => field.id === reference)?.name ?? [])
      : [];
  const lookups = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(oneValue);
  const count = oneValue.length;
  const column = /((?:'(?:\\.|[^'\\])*'|[A-Za-z_][A-Za-z_0-9]*)\[([^\]]*))$/.exec(draft.slice(0, caret));
  const token = column
    ? { index: column.index, end: caret + (draft[caret] === ']' ? 1 : 0), query: column[1]!, field: false }
    : completionAt(draft, caret);
  const structured = fields
    .filter((field) => field.id !== fieldId && field.tableId !== tableId)
    .map((field) => {
      const table = tables.find((table) => table.id === field.tableId);
      if (!table) return null;
      const text = describeFormula(
        { kind: 'field', name: field.name, tableName: table.name, start: 0, end: 0 },
        [],
      );
      return { label: text, text };
    })
    .filter((item): item is { label: string; text: string } => item !== null);
  const query = token?.query.toLowerCase() ?? '';
  const suggestions: Array<{ label: string; text: string; description?: string }> =
    !token || dismissed || isReadOnly
      ? []
      : token.field
        ? bodyDefinition
          ? bodyDefinition.parameters
              .filter((name) => name.toLowerCase().includes(query))
              .map((name) => ({ label: name, text: `{${name}}` }))
          : fields
              .filter(
                (field) =>
                  field.id !== fieldId &&
                  (!tableId || field.tableId === tableId) &&
                  field.name.toLowerCase().includes(query),
              )
              .map((field) => ({
                label: field.name,
                text: `{${field.name.replaceAll('\\', '\\\\').replaceAll('}', '\\}')}}`,
              }))
        : [
            ...(bodyDefinition?.parameters.map((name) => ({ label: name, text: name })) ?? []),
            ...Object.keys(FUNCTIONS).map((name) => ({ label: name, text: `${name}(` })),
            ...namedFunctions.map(({ name, parameters, description }) => ({
              label: `${name}(${parameters.join(', ')})`,
              text: `${name}(`,
              description,
            })),
            ...structured,
          ].filter(
            (item) =>
              item.label.toLowerCase().startsWith(query) ||
              item.label.replace(/^'/, '').toLowerCase().startsWith(query),
          );

  function update(expression: string) {
    setDraft(expression);
    setCaret(root.current?.querySelector('textarea')?.selectionStart ?? expression.length);
    setActive(0);
    setDismissed(false);
    if (bodyDefinition) onChange({ ...options, expression });
    else {
      const result = checkFormula(expression, fields, fieldId, tables, tableId, namedFunctions);
      onChange({ ...options, expression, ...('type' in result ? { resultType: result.type } : {}) });
    }
  }
  function complete(index: number) {
    const suggestion = suggestions[index];
    if (!suggestion || !token) return;
    const suffix = token.end;
    // Completing an existing call keeps its opening parenthesis and arguments.
    const opening = suggestion.text.endsWith('(') ? /^\s*\(/.exec(draft.slice(suffix))?.[0] : undefined;
    const text = opening ? suggestion.text.slice(0, -1) : suggestion.text;
    const next = draft.slice(0, token.index) + text + draft.slice(suffix);
    update(next);
    setDismissed(true);
    const position = token.index + text.length + (opening?.length ?? 0);
    setCaret(position);
    queueMicrotask(() => {
      const area = root.current?.querySelector('textarea');
      area?.focus();
      area?.setSelectionRange(position, position);
    });
  }
  return (
    <div
      className="rio-formula-editor"
      ref={root}
      onSelect={(event) => {
        if (event.target instanceof HTMLTextAreaElement) setCaret(event.target.selectionStart);
      }}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || !suggestions.length) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((active + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          complete(active % suggestions.length);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setDismissed(true);
        }
      }}
    >
      <TextArea
        isReadOnly={isReadOnly}
        {...anchor('field.formula.expression')}
        label={t({ id: 'field.formula.expression', message: 'Formula' })}
        value={draft}
        onChange={update}
        rows={5}
        maxLength={10_000}
        isInvalid={Boolean(error)}
        aria-describedby={`${id}-status`}
        aria-controls={suggestions.length ? `${id}-suggestions` : undefined}
        aria-activedescendant={
          suggestions.length ? `${id}-suggestion-${active % suggestions.length}` : undefined
        }
      />
      {suggestions.length > 0 && (
        <div
          id={`${id}-suggestions`}
          role="listbox"
          {...anchor('field.formula.suggestions')}
          aria-label={t({ id: 'field.formula.suggestions', message: 'Suggestions' })}
        >
          {suggestions.map((suggestion, index) => (
            <button
              type="button"
              className="rio-formula-editor__suggestion"
              key={suggestion.label}
              id={`${id}-suggestion-${index}`}
              role="option"
              aria-selected={index === active % suggestions.length}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => complete(index)}
            >
              {suggestion.label}
              {suggestion.description && <small>{suggestion.description}</small>}
            </button>
          ))}
        </div>
      )}
      <div id={`${id}-status`} aria-live="polite">
        {error ? (
          <>
            <pre className="rio-formula-editor__problem" aria-hidden="true">
              {draft.slice(0, error.start)}
              <mark data-start={error.start} data-end={error.end}>
                {draft.slice(error.start, error.end) || '\u200b'}
              </mark>
              {draft.slice(error.end)}
            </pre>
            <p className="rio-formula-editor__error">{message(error.messageKey, error.params)}</p>
          </>
        ) : (
          <>
            {bodyDefinition ? (
              <p>
                {t({
                  id: 'namedFunctions.body.valid',
                  message: 'The definition is valid. Test it with sample arguments below.',
                })}
              </p>
            ) : (
              <p>{t({ id: 'field.formula.result', message: `Result: ${type}` })}</p>
            )}
            {count > 0 && (
              <p>
                {t({
                  id: 'field.formula.oneValue',
                  message: plural(count, {
                    one: `${lookups} reads as its one value here: blank when it’s empty, and an error when it holds more than one.`,
                    other: `${lookups} each read as one value here: blank when empty, and an error when holding more than one.`,
                  }),
                })}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

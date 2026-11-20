import { useId, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  AI_FIELD_LIMITS,
  AI_FIELD_OUTPUT_TYPES,
  AI_FIELD_TIERS,
  AI_FIELD_TRIGGERS,
  resolveTemplate,
  type AiFieldOutputType,
  type AiFieldSettingsInput,
  type FieldMeta,
} from '@riosoma/contracts';
import { Banner, ListBoxItem, Select, TextArea } from '@riosoma/ui';
import { useServerMessage } from '../../../messages/useServerMessage';
import { TIER_NAMES, TRIGGER_NAMES } from '../../../features/ai-fields/messages';
import { fieldTypeInfo } from './fieldTypes';

/** The fields a prompt may read: the table's others, leaving out buttons, which hold nothing. */
export function promptFields(fields: readonly FieldMeta[], fieldId?: string): FieldMeta[] {
  return fields.filter((field) => field.id !== fieldId && field.type !== 'button');
}

/** Why a prompt can't be saved, or null when it can. */
export function aiPromptProblem(
  prompt: string,
  fields: readonly FieldMeta[],
  fieldId?: string,
): { kind: 'empty' } | { kind: 'unknown'; name: string } | null {
  if (!prompt.trim()) return { kind: 'empty' };
  const resolved = resolveTemplate(prompt, promptFields(fields, fieldId));
  return 'unknown' in resolved ? { kind: 'unknown', name: resolved.unknown } : null;
}

/** The field name being typed in braces at the caret, if any, with where it starts and ends. */
function tokenAt(source: string, caret: number): { index: number; end: number; query: string } | undefined {
  const opening = source.lastIndexOf('{', caret - 1);
  if (opening < 0 || source.lastIndexOf('}', caret - 1) > opening) return undefined;
  const closing = source.indexOf('}', caret);
  const nextOpening = source.indexOf('{', caret);
  const end = closing >= 0 && (nextOpening < 0 || closing < nextOpening) ? closing + 1 : caret;
  return { index: opening, end, query: source.slice(opening + 1, caret) };
}

/**
 * The prompt, with field names in braces the way formulas take them, and the same suggestions:
 * typing `{` offers the table's fields, and Enter or Tab puts the chosen one in.
 */
function PromptEditor({
  value,
  fields,
  fieldId,
  onChange,
}: {
  value: string;
  fields: readonly FieldMeta[];
  fieldId?: string;
  onChange: (prompt: string) => void;
}) {
  const { t } = useLingui();
  const [caret, setCaret] = useState(value.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const problem = aiPromptProblem(value, fields, fieldId);
  const token = tokenAt(value, caret);
  const query = token?.query.toLowerCase() ?? '';
  const suggestions =
    !token || dismissed
      ? []
      : promptFields(fields, fieldId)
          .filter((field) => field.name.toLowerCase().includes(query))
          .map((field) => ({ id: field.id, label: field.name, text: `{${field.name}}` }));
  const name = problem?.kind === 'unknown' ? problem.name : '';

  function update(prompt: string) {
    setCaret(root.current?.querySelector('textarea')?.selectionStart ?? prompt.length);
    setActive(0);
    setDismissed(false);
    onChange(prompt);
  }
  function complete(index: number) {
    const suggestion = suggestions[index];
    if (!suggestion || !token) return;
    const next = value.slice(0, token.index) + suggestion.text + value.slice(token.end);
    update(next);
    setDismissed(true);
    const position = token.index + suggestion.text.length;
    setCaret(position);
    queueMicrotask(() => {
      const area = root.current?.querySelector('textarea');
      area?.focus();
      area?.setSelectionRange(position, position);
    });
  }
  return (
    <div
      className="rio-formula-editor rio-ai-prompt"
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
        label={t({ id: 'fields.ai.prompt', message: 'Prompt' })}
        description={t({
          id: 'fields.ai.promptHelp',
          message: 'Put a field’s name in braces to use its value, like Summarize {Notes} in one sentence.',
        })}
        value={value}
        onChange={update}
        rows={4}
        maxLength={AI_FIELD_LIMITS.promptLength}
        isInvalid={problem?.kind === 'unknown'}
        validationBehavior="aria"
        errorMessage={t({
          id: 'fields.ai.unknownField',
          message: `There’s no field named ${name} in this table.`,
        })}
        aria-controls={suggestions.length ? `${id}-suggestions` : undefined}
        aria-activedescendant={
          suggestions.length ? `${id}-suggestion-${active % suggestions.length}` : undefined
        }
      />
      {suggestions.length > 0 && (
        <div
          id={`${id}-suggestions`}
          role="listbox"
          aria-label={t({ id: 'field.formula.suggestions', message: 'Suggestions' })}
        >
          {suggestions.map((suggestion, index) => (
            <button
              type="button"
              className="rio-formula-editor__suggestion"
              key={suggestion.id}
              id={`${id}-suggestion-${index}`}
              role="option"
              aria-selected={index === active % suggestions.length}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => complete(index)}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * An AI field's settings: the prompt, the type of value the model writes, how capable a model it
 * asks for, and when it runs.  The type's own options, such as a select's choices, follow below.
 */
export function AiFieldOptions({
  value,
  outputType,
  fields,
  fieldId,
  unavailable,
  onChange,
  onOutputType,
}: {
  value: AiFieldSettingsInput;
  outputType: AiFieldOutputType;
  fields: readonly FieldMeta[];
  fieldId?: string;
  /** Why AI fields can't run in the organization, as a server message key */
  unavailable?: string | null;
  onChange: (value: AiFieldSettingsInput) => void;
  onOutputType: (type: AiFieldOutputType) => void;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  return (
    <>
      {unavailable ? <Banner tone="warning">{message(unavailable)}</Banner> : null}
      <PromptEditor
        value={value.prompt}
        fields={fields}
        fieldId={fieldId}
        onChange={(prompt) => onChange({ ...value, prompt })}
      />
      <Select
        label={t({ id: 'fields.ai.outputType', message: 'Answer type' })}
        selectedKey={outputType}
        onSelectionChange={(key) => {
          const next = AI_FIELD_OUTPUT_TYPES.find((type) => type === key);
          if (next) onOutputType(next);
        }}
      >
        {AI_FIELD_OUTPUT_TYPES.map((type) => {
          const info = fieldTypeInfo(type);
          return (
            <ListBoxItem key={type} id={type} icon={info.icon} textValue={i18n._(info.name)}>
              {i18n._(info.name)}
            </ListBoxItem>
          );
        })}
      </Select>
      <Select
        label={t({ id: 'fields.ai.tier', message: 'Model' })}
        description={t({
          id: 'fields.ai.tierHelp',
          message:
            'Fast uses your organization’s everyday model.  Careful uses its power model, which costs more.',
        })}
        selectedKey={value.tier}
        onSelectionChange={(key) => {
          const tier = AI_FIELD_TIERS.find((item) => item === key);
          if (tier) onChange({ ...value, tier });
        }}
      >
        {AI_FIELD_TIERS.map((tier) => (
          <ListBoxItem key={tier} id={tier}>
            {i18n._(TIER_NAMES[tier])}
          </ListBoxItem>
        ))}
      </Select>
      <Select
        label={t({ id: 'fields.ai.trigger', message: 'Runs' })}
        selectedKey={value.trigger}
        onSelectionChange={(key) => {
          const trigger = AI_FIELD_TRIGGERS.find((item) => item === key);
          if (trigger) onChange({ ...value, trigger });
        }}
      >
        {AI_FIELD_TRIGGERS.map((trigger) => (
          <ListBoxItem key={trigger} id={trigger}>
            {i18n._(TRIGGER_NAMES[trigger])}
          </ListBoxItem>
        ))}
      </Select>
      <p className="rio-ai-field__note">
        {t({
          id: 'fields.ai.runsAs',
          message:
            'Runs read records as you, the person who saves these settings, so the prompt can use only fields you can see.',
        })}
      </p>
    </>
  );
}

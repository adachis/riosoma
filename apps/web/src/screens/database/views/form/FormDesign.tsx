import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useId } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  FORM_CONDITION_TYPES,
  LIMITS,
  type FieldMeta,
  type FormQuestion,
  type FormSettings,
} from '@riosoma/contracts';
import { Button, Checkbox, ListBoxItem, NumberField, Select, TextArea, TextField } from '@riosoma/ui';
import type { FormatContext } from '../../../../grid/format';
import { AnswerEditor } from './AnswerEditor';

export function FormDesign({
  config,
  onChange,
}: {
  config: FormSettings;
  onChange: (patch: Partial<FormSettings>) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="rio-form-view__design">
      <TextField
        label={t({ id: 'form.title', message: 'Title' })}
        value={config.title}
        maxLength={LIMITS.nameLength}
        onChange={(title) => onChange({ title })}
      />
      <TextArea
        label={t({ id: 'form.description', message: 'Description' })}
        value={config.description}
        maxLength={LIMITS.descriptionLength}
        onChange={(description) => onChange({ description })}
      />
      <TextField
        label={t({ id: 'form.submitLabel', message: 'Button label' })}
        value={config.submitLabel}
        maxLength={60}
        onChange={(submitLabel) => onChange({ submitLabel })}
      />
      <TextArea
        label={t({ id: 'form.thankYou', message: 'Message after submitting' })}
        value={config.thankYou}
        maxLength={LIMITS.descriptionLength}
        onChange={(thankYou) => onChange({ thankYou })}
      />
      <Checkbox isSelected={config.allowEdits} onChange={(allowEdits) => onChange({ allowEdits })}>
        {t({ id: 'forms.edit.allow', message: 'Allow submitters to edit their responses' })}
      </Checkbox>
      {config.allowEdits && (
        <>
          <NumberField
            label={t({ id: 'forms.edit.days', message: 'Edit link lifetime in days' })}
            value={config.editLinkDays}
            minValue={1}
            maxValue={365}
            step={1}
            onChange={(editLinkDays) => {
              if (Number.isInteger(editLinkDays) && editLinkDays >= 1 && editLinkDays <= 365)
                onChange({ editLinkDays });
            }}
          />
          <Checkbox
            isSelected={config.editConfirmationEmail}
            onChange={(editConfirmationEmail) => onChange({ editConfirmationEmail })}
          >
            {t({ id: 'forms.edit.offerEmail', message: 'Offer to email the edit link' })}
          </Checkbox>
        </>
      )}
      <Checkbox isSelected={config.allowAnother} onChange={(allowAnother) => onChange({ allowAnother })}>
        {t({ id: 'form.allowAnother', message: 'Offer to submit another' })}
      </Checkbox>
    </div>
  );
}

interface QuestionDesignProps {
  question: FormQuestion;
  name: string;
  index: number;
  count: number;
  onChange: (patch: Partial<FormQuestion>) => void;
  onRemove: () => void;
  onMove: (index: number) => void;
  earlierFields: FieldMeta[];
  format: FormatContext;
}

export function QuestionDesign({
  question,
  name,
  index,
  count,
  onChange,
  onRemove,
  onMove,
  earlierFields,
  format,
}: QuestionDesignProps) {
  const { t } = useLingui();
  const id = useId();
  const parents = earlierFields.filter((field) =>
    (FORM_CONDITION_TYPES as readonly string[]).includes(field.type),
  );
  const parent = parents.find((field) => field.id === question.showIf?.fieldId);
  return (
    <div className="rio-form-view__design">
      <div className="rio-form-view__actions">
        <Button
          isDisabled={index === 0}
          aria-label={t({ id: 'form.moveUp', message: `Move ${name} up` })}
          onPress={() => onMove(index - 1)}
        >
          <span aria-hidden="true">↑</span>
        </Button>
        <Button
          isDisabled={index === count - 1}
          aria-label={t({ id: 'form.moveDown', message: `Move ${name} down` })}
          onPress={() => onMove(index + 1)}
        >
          <span aria-hidden="true">↓</span>
        </Button>
        <Button
          onPress={onRemove}
          aria-label={t({ id: 'form.removeQuestion', message: `Remove ${name}` })}
          icon={faXmark}
        />
      </div>
      <TextField
        label={t({ id: 'form.label', message: 'Question' })}
        value={question.label}
        maxLength={LIMITS.nameLength}
        onChange={(label) => onChange({ label })}
      />
      <TextArea
        label={t({ id: 'form.help', message: 'Help text' })}
        value={question.help}
        maxLength={LIMITS.descriptionLength}
        onChange={(help) => onChange({ help })}
      />
      <Checkbox isSelected={question.required} onChange={(required) => onChange({ required })}>
        {t({ id: 'form.required', message: 'Required' })}
      </Checkbox>
      <label htmlFor={`${id}-parent`}>{t({ id: 'form.showIf', message: 'Show if' })}</label>
      <select
        id={`${id}-parent`}
        className="rio-form-view__select"
        value={question.showIf?.fieldId ?? ''}
        onChange={(event) => {
          const field = parents.find((field) => field.id === event.target.value);
          onChange({
            showIf: field
              ? {
                  fieldId: field.id,
                  equals: field.type === 'checkbox' ? true : field.type === 'number' ? 0 : '',
                }
              : null,
          });
        }}
      >
        <option value="">{t({ id: 'form.alwaysShow', message: 'Always show' })}</option>
        {parents.map((field) => (
          <option key={field.id} value={field.id}>
            {field.name}
          </option>
        ))}
      </select>
      {parent && question.showIf && (
        <div>
          <span id={`${id}-match`}>{t({ id: 'form.matches', message: 'Matches this answer' })}</span>
          {parent.type === 'singleSelect' || parent.type === 'multipleSelect' ? (
            <Select
              aria-labelledby={`${id}-match`}
              selectedKey={
                typeof question.showIf.equals === 'string' && question.showIf.equals
                  ? question.showIf.equals
                  : null
              }
              onSelectionChange={(key) => {
                if (key !== null) onChange({ showIf: { fieldId: parent.id, equals: String(key) } });
              }}
            >
              {parent.options.choices.map((choice) => (
                <ListBoxItem key={choice.id} id={choice.id} textValue={choice.name}>
                  {choice.name}
                </ListBoxItem>
              ))}
            </Select>
          ) : (
            <AnswerEditor
              field={parent}
              value={question.showIf.equals}
              format={format}
              labelId={`${id}-match`}
              onChange={(_fieldId, value) => {
                if (
                  value === null ||
                  typeof value === 'string' ||
                  typeof value === 'number' ||
                  typeof value === 'boolean'
                )
                  onChange({
                    showIf: {
                      fieldId: parent.id,
                      equals:
                        value ?? (parent.type === 'number' ? 0 : parent.type === 'checkbox' ? false : ''),
                    },
                  });
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

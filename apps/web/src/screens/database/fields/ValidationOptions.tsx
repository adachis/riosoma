import { useLingui } from '@lingui/react/macro';
import {
  isComputedType,
  UNIQUE_TYPES,
  validPattern,
  type FieldSpec,
  type FieldType,
  type FieldValidation,
} from '@riosoma/contracts';
import { ListBoxItem, Select, Switch, TextField } from '@riosoma/ui';

export function ValidationOptions({
  type,
  options,
  onChange,
  source,
}: {
  type: FieldType;
  options: FieldSpec['options'];
  onChange(options: FieldSpec['options']): void;
  source?: boolean;
}) {
  const { t } = useLingui();
  if (isComputedType(type)) return null;
  const current = options as {
    validation?: FieldValidation;
    unique?: boolean;
    uniqueCaseInsensitive?: boolean;
  };
  const rules = current.validation ?? {};
  const change = (patch: Partial<FieldValidation>) =>
    onChange({ ...options, validation: { ...rules, ...patch } } as FieldSpec['options']);
  const text = type === 'text' || type === 'longText';
  const numeric = ['number', 'currency', 'percent', 'duration'].includes(type);
  const patterned = text || ['email', 'url', 'phone'].includes(type);
  const labels = {
    min: t({ id: 'field.validation.min', message: 'Minimum' }),
    max: t({ id: 'field.validation.max', message: 'Maximum' }),
    minLength: t({ id: 'field.validation.minLength', message: 'Minimum length' }),
    maxLength: t({ id: 'field.validation.maxLength', message: 'Maximum length' }),
  };
  const keys: Array<keyof typeof labels> = text
    ? ['minLength', 'maxLength']
    : numeric || type === 'date'
      ? ['min', 'max']
      : [];
  const presets = {
    email: t({ id: 'field.validation.email', message: 'Email' }),
    url: t({ id: 'field.validation.url', message: 'URL' }),
    phone: t({ id: 'field.validation.phone', message: 'Phone' }),
    postalCode: t({ id: 'field.validation.postalCode', message: 'Postal code' }),
    digits: t({ id: 'field.validation.digits', message: 'Digits only' }),
    letters: t({ id: 'field.validation.letters', message: 'Letters only' }),
  };
  const customLabel = t({ id: 'field.validation.message', message: 'Custom message' });
  return (
    <fieldset className="rio-validation-options">
      <legend>{t({ id: 'field.validation.title', message: 'Validation and uniqueness' })}</legend>
      <Switch
        isSelected={Boolean(rules.required)}
        onChange={(required) => change({ required: required ? {} : undefined })}
      >
        {t({ id: 'field.validation.required', message: 'Required' })}
      </Switch>
      {rules.required && (
        <TextField
          label={customLabel}
          value={rules.required.message ?? ''}
          onChange={(message) => change({ required: { message } })}
        />
      )}
      {keys.map((key) => (
        <div key={key}>
          <TextField
            label={labels[key]}
            type={type === 'date' ? 'text' : 'number'}
            value={String(rules[key]?.value ?? '')}
            description={
              type === 'date'
                ? t({ id: 'field.validation.dateHelp', message: 'Use an ISO date or timestamp.' })
                : undefined
            }
            onChange={(value) =>
              change({
                [key]:
                  value === ''
                    ? undefined
                    : { ...rules[key], value: type === 'date' ? value : Number(value) },
              })
            }
          />
          {rules[key] && (
            <TextField
              label={customLabel}
              value={rules[key]?.message ?? ''}
              onChange={(message) => change({ [key]: { ...rules[key], message } })}
            />
          )}
        </div>
      ))}
      {patterned && (
        <>
          <Select
            label={t({ id: 'field.validation.pattern', message: 'Pattern' })}
            selectedKey={rules.pattern?.kind === 'custom' ? 'custom' : (rules.pattern?.preset ?? 'none')}
            onSelectionChange={(key) =>
              change({
                pattern:
                  key === 'none'
                    ? undefined
                    : key === 'custom'
                      ? { kind: 'custom', pattern: '' }
                      : { kind: 'preset', preset: key as keyof typeof presets },
              })
            }
          >
            <ListBoxItem id="none">{t({ id: 'field.validation.none', message: 'None' })}</ListBoxItem>
            {Object.entries(presets).map(([key, label]) => (
              <ListBoxItem key={key} id={key}>
                {label}
              </ListBoxItem>
            ))}
            <ListBoxItem id="custom">
              {t({ id: 'field.validation.custom', message: 'Custom pattern' })}
            </ListBoxItem>
          </Select>
          {rules.pattern?.kind === 'custom' && (
            <TextField
              label={t({ id: 'field.validation.custom', message: 'Custom pattern' })}
              value={rules.pattern.pattern}
              isInvalid={!validPattern(rules.pattern.pattern)}
              errorMessage={t({
                id: 'data.validation.patternSyntax',
                message: 'Use a simple pattern without backreferences, lookaround, or nested quantifiers.',
              })}
              onChange={(pattern) => change({ pattern: { ...rules.pattern, kind: 'custom', pattern } })}
            />
          )}
          {rules.pattern && (
            <TextField
              label={customLabel}
              value={rules.pattern.message ?? ''}
              onChange={(message) => change({ pattern: { ...rules.pattern!, message } })}
            />
          )}
        </>
      )}
      {(UNIQUE_TYPES as readonly string[]).includes(type) && (
        <>
          <Switch
            isSelected={Boolean(current.unique)}
            isDisabled={source}
            onChange={(unique) => onChange({ ...options, unique })}
          >
            {t({ id: 'field.validation.unique', message: 'Unique values' })}
          </Switch>
          {type === 'text' && current.unique && (
            <Switch
              isSelected={Boolean(current.uniqueCaseInsensitive)}
              onChange={(uniqueCaseInsensitive) => onChange({ ...options, uniqueCaseInsensitive })}
            >
              {t({ id: 'field.validation.caseInsensitive', message: 'Ignore letter case' })}
            </Switch>
          )}
        </>
      )}
    </fieldset>
  );
}

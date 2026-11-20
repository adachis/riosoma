import { useLingui } from '@lingui/react/macro';
import {
  defaultIssue,
  fieldDefault,
  supportsDefault,
  withDefault,
  type FieldDefault,
  type FieldOptionsOf,
  type FieldSpec,
  type FieldType,
} from '@riosoma/contracts';
import {
  Checkbox,
  CheckboxGroup,
  DatePicker,
  ListBoxItem,
  NumberField,
  Select,
  Switch,
  TextField,
} from '@riosoma/ui';

type Options = FieldSpec['options'];

/**
 * Keeps a default in step with a change to the rest of the field's options.  Options taken off a
 * select drop out of its default, and a date's "today" reads "now" once it includes a time.  Any
 * other default that no longer fits stays as it is and shows why, so the person decides.
 */
export function followOptions(type: FieldType, options: Options): Options {
  const spec = { type, options } as FieldSpec;
  const value = fieldDefault(spec);
  if (!value) return options;
  if ((type === 'singleSelect' || type === 'multipleSelect') && value.kind === 'value') {
    const ids = new Set((options as FieldOptionsOf<'singleSelect'>).choices.map((choice) => choice.id));
    const kept = (Array.isArray(value.value) ? value.value : [value.value]).filter(
      (id): id is string => typeof id === 'string' && ids.has(id),
    );
    if (!kept.length) return withDefault(spec, undefined).options;
    return withDefault(spec, { kind: 'value', value: type === 'singleSelect' ? kept[0]! : kept }).options;
  }
  if (type === 'date' && (value.kind === 'today' || value.kind === 'now')) {
    const kind = (options as FieldOptionsOf<'date'>).includeTime ? 'now' : 'today';
    return kind === value.kind ? options : withDefault(spec, { kind }).options;
  }
  return options;
}

/**
 * The value a new record starts with in this field when nobody gives one.  Each type gets the
 * editor its values need, and a default that doesn't fit the field's options or rules says so.
 */
export function DefaultValueOptions({
  type,
  options,
  onChange,
}: {
  type: FieldType;
  options: Options;
  onChange(options: Options): void;
}) {
  const { t } = useLingui();
  if (!supportsDefault(type)) return null;
  const spec = { type, options } as FieldSpec;
  const current = fieldDefault(spec);
  const set = (value: FieldDefault | undefined) => onChange(withDefault(spec, value).options);
  const fixed = current?.kind === 'value' ? current.value : undefined;
  const issue = defaultIssue(spec);
  const error =
    fixed === ''
      ? t({ id: 'field.default.chooseDate', message: 'Choose a date.' })
      : issue === 'data.field.defaultUnique'
        ? t({
            id: 'field.default.unique',
            message:
              'A field with unique values can’t have a default.  Choose None, or turn off Unique values.',
          })
        : issue
          ? t({
              id: 'field.default.invalid',
              message: 'This default doesn’t fit the field’s options or rules.',
            })
          : undefined;
  const none = t({ id: 'field.default.none', message: 'None' });
  const valueLabel = t({ id: 'field.default.value', message: 'Value' });
  let control;
  switch (type) {
    case 'checkbox':
      control = (
        <Switch
          isSelected={fixed === true}
          onChange={(on) => set(on ? { kind: 'value', value: true } : undefined)}
        >
          {t({ id: 'field.default.checked', message: 'Checked in new records' })}
        </Switch>
      );
      break;
    case 'user':
      control = (
        <Switch
          isSelected={current?.kind === 'creator'}
          onChange={(on) => set(on ? { kind: 'creator' } : undefined)}
        >
          {t({ id: 'field.default.creator', message: 'The person who adds the record' })}
        </Switch>
      );
      break;
    case 'text':
    case 'email':
    case 'url':
    case 'phone':
      control = (
        <TextField
          label={valueLabel}
          type={type === 'email' ? 'email' : type === 'url' ? 'url' : type === 'phone' ? 'tel' : 'text'}
          value={typeof fixed === 'string' ? fixed : ''}
          onChange={(text) => set(text === '' ? undefined : { kind: 'value', value: text })}
        />
      );
      break;
    case 'number':
    case 'currency':
    case 'percent': {
      const own = options as FieldOptionsOf<'number' | 'currency' | 'percent'>;
      control = (
        <NumberField
          label={valueLabel}
          value={typeof fixed === 'number' ? fixed : NaN}
          onChange={(next) => set(Number.isNaN(next) ? undefined : { kind: 'value', value: next })}
          formatOptions={
            type === 'percent'
              ? { style: 'percent', maximumFractionDigits: 8 }
              : type === 'currency'
                ? {
                    style: 'currency',
                    currency: (own as FieldOptionsOf<'currency'>).code,
                    maximumFractionDigits: 8,
                  }
                : { maximumFractionDigits: 8 }
          }
        />
      );
      break;
    }
    case 'rating': {
      const max = (options as FieldOptionsOf<'rating'>).max;
      control = (
        <Select
          label={t({ id: 'field.default.rating', message: 'Default rating' })}
          selectedKey={typeof fixed === 'number' ? String(fixed) : 'none'}
          onSelectionChange={(key) => set(key === 'none' ? undefined : { kind: 'value', value: Number(key) })}
        >
          <ListBoxItem id="none">{none}</ListBoxItem>
          {Array.from({ length: max }, (_, index) => (
            <ListBoxItem key={index + 1} id={String(index + 1)}>
              {String(index + 1)}
            </ListBoxItem>
          ))}
        </Select>
      );
      break;
    }
    case 'date': {
      const own = options as FieldOptionsOf<'date'>;
      const clock = own.includeTime ? 'now' : 'today';
      control = (
        <>
          <Select
            label={t({ id: 'field.default.dateKind', message: 'Default date' })}
            selectedKey={current ? (current.kind === 'value' ? 'value' : 'clock') : 'none'}
            onSelectionChange={(key) =>
              set(
                key === 'none'
                  ? undefined
                  : key === 'value'
                    ? { kind: 'value', value: typeof fixed === 'string' ? fixed : '' }
                    : { kind: clock },
              )
            }
          >
            <ListBoxItem id="none">{none}</ListBoxItem>
            <ListBoxItem id="clock">
              {own.includeTime
                ? t({ id: 'field.default.now', message: 'Now' })
                : t({ id: 'field.default.today', message: 'Today' })}
            </ListBoxItem>
            <ListBoxItem id="value">
              {t({ id: 'field.default.date', message: 'A specific date' })}
            </ListBoxItem>
          </Select>
          {current?.kind === 'value' && (
            <DatePicker
              label={t({ id: 'field.default.dateValue', message: 'Date' })}
              value={typeof fixed === 'string' && fixed ? fixed : null}
              includeTime={own.includeTime}
              timeZone={own.timeZone === 'client' ? undefined : own.timeZone}
              onChange={(next) => set({ kind: 'value', value: next ?? '' })}
            />
          )}
        </>
      );
      break;
    }
    case 'singleSelect': {
      const choices = (options as FieldOptionsOf<'singleSelect'>).choices.filter(({ name }) => name.trim());
      control = (
        <Select
          label={t({ id: 'field.default.option', message: 'Default option' })}
          selectedKey={current?.kind === 'firstChoice' ? 'first' : typeof fixed === 'string' ? fixed : 'none'}
          onSelectionChange={(key) =>
            set(
              key === 'none'
                ? undefined
                : key === 'first'
                  ? { kind: 'firstChoice' }
                  : { kind: 'value', value: String(key) },
            )
          }
        >
          <ListBoxItem id="none">{none}</ListBoxItem>
          <ListBoxItem id="first">
            {t({ id: 'field.default.firstChoice', message: 'The first option' })}
          </ListBoxItem>
          {choices.map((choice) => (
            <ListBoxItem key={choice.id} id={choice.id} textValue={choice.name}>
              {choice.name}
            </ListBoxItem>
          ))}
        </Select>
      );
      break;
    }
    case 'multipleSelect': {
      const choices = (options as FieldOptionsOf<'multipleSelect'>).choices.filter(({ name }) => name.trim());
      control = (
        <CheckboxGroup
          label={t({ id: 'field.default.options', message: 'Default options' })}
          value={Array.isArray(fixed) ? fixed.filter((id): id is string => typeof id === 'string') : []}
          onChange={(ids) => set(ids.length ? { kind: 'value', value: ids } : undefined)}
        >
          {choices.map((choice) => (
            <Checkbox key={choice.id} value={choice.id}>
              {choice.name}
            </Checkbox>
          ))}
        </CheckboxGroup>
      );
      break;
    }
  }
  return (
    <fieldset className="rio-default-options">
      <legend>{t({ id: 'field.default.title', message: 'Default value' })}</legend>
      {control}
      <p className="rio-default-options__help">
        {t({
          id: 'field.default.help',
          message:
            'New records start with this when nobody gives a value.  Records that already exist keep theirs.',
        })}
      </p>
      {error && (
        <p className="rio-default-options__error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { FieldMeta, FilterCondition } from '@riosoma/contracts';
import {
  coordinatesText,
  idsOf,
  LIMITS,
  parseCoordinates,
  parseTimeOfDay,
  formatTimeOfDay,
} from '@riosoma/contracts';
import {
  Avatar,
  Button,
  ChoicePill,
  ComboBox,
  DatePicker,
  ListBoxItem,
  SegmentedControl,
  Select,
  TextField,
} from '@riosoma/ui';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { dateLabels, rangeLabels } from './messages';
import { NumericFieldInput } from '../../../grid/editors/NumericFieldInput';
import { UserPicker } from '../../../grid/editors/UserEditor';
import { ImmediateNumberField } from './ImmediateNumberField';
import { resultField } from '../../../data/formulas';
import type { DatabaseSession } from '../../../data';
import { LinkPicker } from '../../../grid/editors/LinkEditor';
import type { Collaborators } from './filterValues';

interface ValueProps {
  field: FieldMeta;
  session?: DatabaseSession;
  condition: FilterCondition;
  collaborators: Collaborators;
  readOnly: boolean;
  onChange: (value: unknown) => void;
}

function DateValueEditor({ condition, onChange, readOnly }: Omit<ValueProps, 'field' | 'collaborators'>) {
  const { t, i18n } = useLingui();
  const range = condition.operator === 'isWithin' || condition.operator === 'overlaps';
  const labels = range ? rangeLabels : dateLabels;
  const value = typeof condition.value === 'object' && condition.value !== null ? condition.value : {};
  const mode = 'mode' in value && typeof value.mode === 'string' ? value.mode : null;
  const days = 'days' in value ? value.days : undefined;
  const date = 'date' in value && typeof value.date === 'string' ? value.date : null;
  const hasDays = mode === 'daysAgo' || mode === 'daysFromNow' || mode === 'pastDays' || mode === 'nextDays';
  return (
    <div className="rio-view-value">
      <Select
        aria-label={t({ id: 'view.filter.value', message: 'Value' })}
        selectedKey={mode}
        isDisabled={readOnly}
        onSelectionChange={(key) => {
          const mode = String(key);
          if (mode === 'exactDate') onChange({ mode, date: '' });
          else if (mode === 'daysAgo' || mode === 'daysFromNow' || mode === 'pastDays' || mode === 'nextDays')
            onChange({ mode, days: 1 });
          else onChange({ mode });
        }}
      >
        {Object.entries(labels).map(([id, label]) => (
          <ListBoxItem key={id} id={id}>
            {i18n._(label)}
          </ListBoxItem>
        ))}
      </Select>
      {mode === 'exactDate' && (
        <DatePicker
          aria-label={i18n._(dateLabels.exactDate)}
          value={date || null}
          isDisabled={readOnly}
          onChange={(date) => onChange({ mode, date: date ?? '' })}
        />
      )}
      {hasDays && (
        <ImmediateNumberField
          label={t({ id: 'view.filter.days', message: 'Days' })}
          value={days}
          minValue={range ? 1 : 0}
          maxValue={100_000}
          readOnly={readOnly}
          onChange={(days) => onChange({ mode, days })}
        />
      )}
    </div>
  );
}

/** How far from which point: kilometers and coordinates, used once both are there. */
function DistanceValueEditor({ condition, readOnly, onChange }: Omit<ValueProps, 'field' | 'collaborators'>) {
  const { t } = useLingui();
  const saved =
    typeof condition.value === 'object' && condition.value !== null
      ? (condition.value as { lat?: unknown; lng?: unknown; km?: unknown })
      : {};
  const [km, setKm] = useState(typeof saved.km === 'number' ? saved.km : undefined);
  const [point, setPoint] = useState(
    typeof saved.lat === 'number' && typeof saved.lng === 'number'
      ? coordinatesText({ lat: saved.lat, lng: saved.lng })
      : '',
  );
  function report(nextKm: number | undefined, nextPoint: string) {
    const place = parseCoordinates(nextPoint);
    // A condition still missing either part is left out of the filter until it has both.
    onChange(place && nextKm !== undefined && nextKm > 0 ? { ...place, km: nextKm } : undefined);
  }
  const invalid = point.trim() !== '' && parseCoordinates(point) === null;
  return (
    <div className="rio-view-value">
      <ImmediateNumberField
        label={t({ id: 'fields.location.filter.km', message: 'Kilometers' })}
        value={km}
        minValue={0}
        maxValue={20_040}
        readOnly={readOnly}
        onChange={(next) => {
          setKm(next);
          report(next, point);
        }}
      />
      <TextField
        aria-label={t({ id: 'fields.location.filter.point', message: 'From latitude, longitude' })}
        placeholder={t({ id: 'fields.location.example', message: '40.7128, -74.0060' })}
        value={point}
        isDisabled={readOnly}
        isInvalid={invalid}
        errorMessage={t({
          id: 'fields.location.coordinatesFormat',
          message: 'Type the latitude and longitude, like 40.7128, -74.0060.',
        })}
        onChange={(next) => {
          setPoint(next);
          report(km, next);
        }}
      />
    </div>
  );
}

function TimeValueEditor({ field, condition, readOnly, onChange }: ValueProps) {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || 'en-US';
  const [text, setText] = useState(() =>
    typeof condition.value === 'string'
      ? formatTimeOfDay(condition.value, locale, field.type === 'time' ? field.options.timeFormat : 'local')
      : '',
  );
  const parsed = parseTimeOfDay(text, locale);
  return (
    <TextField
      aria-label={t({ id: 'view.filter.value', message: 'Value' })}
      value={text}
      isDisabled={readOnly}
      isInvalid={text.trim() !== '' && parsed === null}
      errorMessage={t({ id: 'data.value.time', message: 'Enter a valid time without a date.' })}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.preventDefault();
        else event.continuePropagation();
      }}
      onChange={(next) => {
        setText(next);
        const value = parseTimeOfDay(next, locale);
        if (value !== null || next.trim() === '') onChange(value ?? undefined);
      }}
    />
  );
}

function ChoiceValueEditor({ field, condition, collaborators, readOnly, onChange }: ValueProps) {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  const single = condition.operator === 'is' || condition.operator === 'isNot';
  const choices =
    field.type === 'singleSelect' || field.type === 'multipleSelect' ? field.options.choices : null;
  const options =
    choices ?? [...collaborators].map(([id, person]) => ({ id, name: person.name, color: 'gray' as const }));
  const selected =
    typeof condition.value === 'string'
      ? [condition.value]
      : Array.isArray(condition.value)
        ? condition.value.filter((id): id is string => typeof id === 'string')
        : [];
  const available = options.filter(
    (option) =>
      !selected.includes(option.id) && option.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const full = selected.length >= LIMITS.choicesPerField;
  function remove(id: string) {
    if (readOnly) return;
    const next = selected.filter((key) => key !== id);
    onChange(single || next.length === 0 ? undefined : next);
  }
  return (
    <div className="rio-view-value">
      <ComboBox
        aria-label={t({ id: 'view.filter.value', message: 'Value' })}
        inputValue={query}
        onInputChange={setQuery}
        selectedKey={selected.at(-1) ?? null}
        isDisabled={readOnly || full}
        onSelectionChange={(key) => {
          if (key === null || readOnly || selected.includes(String(key))) return;
          onChange(single ? String(key) : [...selected, String(key)]);
          setQuery('');
        }}
      >
        {available.map((option) => (
          <ListBoxItem key={option.id} id={option.id} textValue={option.name}>
            {option.name}
          </ListBoxItem>
        ))}
      </ComboBox>
      <div className="rio-view-choices">
        {selected.map((id) => {
          const option = options.find((option) => option.id === id);
          const name = option?.name ?? id;
          return choices ? (
            <ChoicePill
              key={id}
              name={name}
              color={option?.color ?? 'gray'}
              onRemove={readOnly ? undefined : () => remove(id)}
            />
          ) : (
            <span className="rio-view-person" key={id}>
              <Avatar personId={id} name={name} color="gray" size="sm" />
              <span>{name}</span>
              <Button
                size="sm"
                variant="quiet"
                icon={faXmark}
                isDisabled={readOnly}
                aria-label={t({ id: 'view.filter.removeValue', message: `Remove ${name}` })}
                onPress={() => remove(id)}
              />
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function FilterValueEditor(props: ValueProps) {
  const { t, i18n } = useLingui();
  const { field, condition, readOnly, onChange } = props;
  const label = t({ id: 'view.filter.value', message: 'Value' });
  if (condition.operator === 'isEmpty' || condition.operator === 'isNotEmpty') return null;
  if (field.type === 'link' && (condition.operator === 'hasAnyOf' || condition.operator === 'hasNoneOf'))
    return (
      <LinkPicker
        field={{ ...field, options: { ...field.options, prefersSingle: false } }}
        selected={idsOf(
          Array.isArray(condition.value)
            ? condition.value.filter((id): id is string => typeof id === 'string')
            : null,
        )}
        session={props.session}
        format={{
          locale: 'en-US',
          timeZone: 'UTC',
          collaborators: props.collaborators,
          linked: props.session?.linked,
        }}
        readOnly={readOnly}
        onChange={onChange}
      />
    );
  if (field.type === 'time') return <TimeValueEditor {...props} />;
  if (field.type === 'multiCurrency' && ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'].includes(condition.operator))
    return (
      <ImmediateNumberField label={label} value={condition.value} onChange={onChange} readOnly={readOnly} />
    );
  switch (resultField(field).type) {
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating':
    case 'autoNumber':
      return (
        <NumericFieldInput
          field={field}
          value={typeof condition.value === 'number' ? condition.value : null}
          label={label}
          readOnly={readOnly}
          filter
          onChange={(value) => onChange(value ?? undefined)}
          format={{ locale: i18n.locale || 'en-US', timeZone: 'UTC', collaborators: props.collaborators }}
        />
      );
    case 'user':
      return (
        <UserPicker
          collaborators={props.collaborators}
          selected={
            Array.isArray(condition.value)
              ? condition.value.filter((id): id is string => typeof id === 'string')
              : []
          }
          multiple
          label={label}
          locale={i18n.locale || 'en-US'}
          readOnly={readOnly}
          onChange={(ids) => onChange(ids.length ? ids : undefined)}
        />
      );
    case 'number':
      return (
        <ImmediateNumberField label={label} value={condition.value} onChange={onChange} readOnly={readOnly} />
      );
    case 'checkbox':
      return (
        <SegmentedControl
          label={label}
          isDisabled={readOnly}
          selectedId={typeof condition.value === 'boolean' ? String(condition.value) : ''}
          onChange={(id) => onChange(id === 'true')}
          items={[
            { id: 'true', label: t({ id: 'view.filter.checked', message: 'checked' }) },
            { id: 'false', label: t({ id: 'view.filter.unchecked', message: 'unchecked' }) },
          ]}
        />
      );
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime':
    case 'dateRange':
      return <DateValueEditor {...props} />;
    case 'location':
      return <DistanceValueEditor {...props} />;
    case 'singleSelect':
    case 'multipleSelect':
    case 'createdBy':
    case 'lastModifiedBy':
      return <ChoiceValueEditor {...props} />;
    default:
      return (
        <TextField
          aria-label={label}
          value={typeof condition.value === 'string' ? condition.value : ''}
          maxLength={LIMITS.textLength}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
            else event.continuePropagation();
          }}
          isDisabled={readOnly}
          onChange={onChange}
        />
      );
  }
}

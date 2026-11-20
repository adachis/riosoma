import { LineItemsOptions } from './LineItemsOptions';
import { ValidationOptions } from './ValidationOptions';
import { DefaultValueOptions, followOptions } from './DefaultValueOptions';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  DateFormat,
  FieldOptions,
  TimeFormat,
  type FieldOptionsOf,
  type FieldSpec,
  type FieldType,
} from '@riosoma/contracts';
import { ColorSwatchPicker, ComboBox, ListBoxItem, Select, Switch } from '@riosoma/ui';
import { formatCell } from '../../../grid/format';
import { AdditionalFieldOptions } from './AdditionalFieldOptions';
import { ButtonOptions } from './ButtonOptions';
import { SelectOptions } from './SelectOptions';
import type { SchemaState } from '../../../data';
import { ComputedEditor } from './builders/ComputedEditor';
import { RelationalOptions } from './RelationalOptions';
import './FieldOptionsForm.css';

export interface FieldOptionsFormProps {
  type: FieldType;
  schema?: SchemaState;
  tableId?: string;
  fieldId?: string;
  options: FieldSpec['options'];
  onChange: (options: FieldSpec['options']) => void;
  /** Leaves out the default value, for AI fields and the fields of synced and joined tables */
  noDefault?: boolean;
}

function DateOptionsForm({
  options,
  onChange,
}: {
  options: FieldOptionsOf<'date'>;
  onChange: (options: FieldOptionsOf<'date'>) => void;
}) {
  const { i18n, t } = useLingui();
  const [today] = useState(() => new Date().toISOString());
  const [zones] = useState(() => Intl.supportedValuesOf('timeZone'));
  const clientZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zoneItems = [
    { id: 'client', name: t({ id: 'field.date.timeZone.client', message: 'Each person’s own' }) },
    // Existing fields may use UTC or an alias absent from the runtime's canonical list.
    ...Array.from(new Set([...zones, ...(options.timeZone === 'client' ? [] : [options.timeZone])])).map(
      (zone) => ({ id: zone, name: zone }),
    ),
  ];
  function dateExample(dateFormat: FieldOptionsOf<'date'>['dateFormat']) {
    return formatCell(
      {
        id: '',
        tableId: '',
        name: '',
        description: '',
        position: 0,
        createdAt: '',
        updatedAt: '',
        type: 'date',
        options: { ...options, dateFormat, includeTime: false },
      },
      today,
      { locale: i18n.locale, timeZone: clientZone, collaborators: new Map() },
    );
  }
  const formats = DateFormat.options.map((id) => {
    const example = dateExample(id);
    const names = {
      local: t({ id: 'field.date.format.local', message: `Local (${example})` }),
      friendly: t({ id: 'field.date.format.friendly', message: `Friendly (${example})` }),
      us: t({ id: 'field.date.format.us', message: `US (${example})` }),
      european: t({ id: 'field.date.format.european', message: `European (${example})` }),
      iso: t({ id: 'field.date.format.iso', message: `ISO (${example})` }),
    };
    return { id, name: names[id] };
  });
  return (
    <>
      <Switch
        isSelected={options.includeTime}
        onChange={(includeTime) => onChange({ ...options, includeTime })}
      >
        {t({ id: 'field.date.includeTime', message: 'Include a time' })}
      </Switch>
      <Select
        label={t({ id: 'field.date.format', message: 'Date format' })}
        selectedKey={options.dateFormat}
        onSelectionChange={(key) => {
          const result = DateFormat.safeParse(key);
          if (result.success) onChange({ ...options, dateFormat: result.data });
        }}
      >
        {formats.map(({ id, name }) => (
          <ListBoxItem key={id} id={id}>
            {name}
          </ListBoxItem>
        ))}
      </Select>
      {options.includeTime ? (
        <>
          <Select
            label={t({ id: 'field.date.timeFormat', message: 'Time format' })}
            selectedKey={options.timeFormat}
            onSelectionChange={(key) => {
              const result = TimeFormat.safeParse(key);
              if (result.success) onChange({ ...options, timeFormat: result.data });
            }}
          >
            <ListBoxItem id="local">{t({ id: 'field.date.timeFormat.local', message: 'Local' })}</ListBoxItem>
            <ListBoxItem id="12h">{t({ id: 'field.date.timeFormat.12h', message: '12-hour' })}</ListBoxItem>
            <ListBoxItem id="24h">{t({ id: 'field.date.timeFormat.24h', message: '24-hour' })}</ListBoxItem>
          </Select>
          <ComboBox
            label={t({ id: 'field.date.timeZone', message: 'Time zone' })}
            selectedKey={options.timeZone}
            onSelectionChange={(key) => {
              if (key !== null) onChange({ ...options, timeZone: String(key) });
            }}
          >
            {zoneItems.map(({ id, name }) => (
              <ListBoxItem key={id} id={id} textValue={name}>
                {name}
              </ListBoxItem>
            ))}
          </ComboBox>
        </>
      ) : null}
    </>
  );
}

function TypeOptionsForm({ type, options, onChange, schema, tableId, fieldId }: FieldOptionsFormProps) {
  const { t } = useLingui();
  let controls;
  switch (type) {
    case 'lineItems':
      controls = (
        <LineItemsOptions
          options={FieldOptions.lineItems.parse(options)}
          fieldId={fieldId}
          schema={schema}
          tableId={tableId}
          onChange={onChange}
        />
      );
      break;
    case 'link':
    case 'lookup':
    case 'rollup':
    case 'count':
      controls = (
        <RelationalOptions
          spec={{ type, options } as Extract<FieldSpec, { type: 'link' | 'lookup' | 'rollup' | 'count' }>}
          schema={schema}
          tableId={tableId}
          fieldId={fieldId}
          onChange={onChange}
        />
      );
      break;
    case 'formula':
      controls = (
        <ComputedEditor
          options={FieldOptions.formula.parse(options)}
          fields={schema ? [...schema.fieldById.values()] : []}
          tables={schema?.tables}
          namedFunctions={schema?.namedFunctions}
          tableId={tableId}
          fieldId={fieldId}
          onChange={onChange}
        />
      );
      break;
    case 'multiCurrency':
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating':
    case 'user':
    case 'autoNumber':
      controls = <AdditionalFieldOptions type={type} options={options} onChange={onChange} />;
      break;
    case 'number': {
      const number = FieldOptions.number.parse(options);
      controls = (
        <>
          <Select
            label={t({ id: 'field.number.decimals', message: 'Decimal places' })}
            selectedKey={number.precision ?? 'entered'}
            onSelectionChange={(key) => {
              if (key !== null) onChange({ ...number, precision: key === 'entered' ? null : Number(key) });
            }}
          >
            <ListBoxItem id="entered">
              {t({ id: 'field.number.asEntered', message: 'As entered' })}
            </ListBoxItem>
            {Array.from({ length: 9 }, (_, precision) => {
              const example = (1).toFixed(precision);
              return (
                <ListBoxItem key={precision} id={precision}>
                  {t({ id: 'field.number.precisionExample', message: `${precision} (${example})` })}
                </ListBoxItem>
              );
            })}
          </Select>
          <Switch isSelected={number.thousands} onChange={(thousands) => onChange({ ...number, thousands })}>
            {t({ id: 'field.number.thousands', message: 'Thousands separators' })}
          </Switch>
          <Switch
            isSelected={number.allowNegative}
            onChange={(allowNegative) => onChange({ ...number, allowNegative })}
          >
            {t({ id: 'field.number.negative', message: 'Negative numbers' })}
          </Switch>
        </>
      );
      break;
    }
    case 'longText': {
      const long = FieldOptions.longText.parse(options);
      controls = (
        <Switch
          isSelected={long.richText}
          onChange={(richText) => onChange({ ...long, richText })}
          description={t({
            id: 'fields.richText.optionHelp',
            message:
              'Adds bold, italic, links, headings, lists, checklists, quotes, and code.  Values are kept as Markdown text, so turning this on or off never changes them.',
          })}
        >
          {t({ id: 'fields.richText.option', message: 'Rich text' })}
        </Switch>
      );
      break;
    }
    case 'checkbox':
      controls = (
        <ColorSwatchPicker
          label={t({ id: 'field.checkbox.color', message: 'Color' })}
          value={FieldOptions.checkbox.parse(options).color}
          onChange={(color) => onChange({ color })}
        />
      );
      break;
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime':
    case 'dateRange':
      controls = <DateOptionsForm options={FieldOptions[type].parse(options)} onChange={onChange} />;
      break;
    case 'time': {
      const time = FieldOptions.time.parse(options);
      controls = (
        <Select
          label={t({ id: 'field.date.timeFormat', message: 'Time format' })}
          selectedKey={time.timeFormat}
          onSelectionChange={(key) => {
            const parsed = TimeFormat.safeParse(key);
            if (parsed.success) onChange({ ...time, timeFormat: parsed.data });
          }}
        >
          <ListBoxItem id="local">{t({ id: 'field.date.timeFormat.local', message: 'Local' })}</ListBoxItem>
          <ListBoxItem id="12h">{t({ id: 'field.date.timeFormat.12h', message: '12-hour' })}</ListBoxItem>
          <ListBoxItem id="24h">{t({ id: 'field.date.timeFormat.24h', message: '24-hour' })}</ListBoxItem>
        </Select>
      );
      break;
    }
    case 'json':
      controls = (
        <p>
          {t({
            id: 'fields.json.note',
            message: 'Holds any JSON: an object, a list, text, a number, true, or false.  Saving checks it.',
          })}
        </p>
      );
      break;
    case 'location':
      controls = (
        <p>
          {t({
            id: 'fields.location.note',
            message: 'Holds a latitude and longitude, with a label such as an address if you like.',
          })}
        </p>
      );
      break;
    case 'signature':
      controls = (
        <p>
          {t({
            id: 'fields.signature.note',
            message:
              'People sign by drawing or by typing their name.  A signature can be signed again or removed, never changed.',
          })}
        </p>
      );
      break;
    case 'button':
      controls = (
        <ButtonOptions
          options={options}
          automations={schema?.automations}
          scripts={schema?.scripts}
          fields={schema?.fields.get(tableId ?? '') ?? []}
          fieldId={fieldId}
          onChange={onChange}
        />
      );
      break;
    case 'singleSelect':
    case 'multipleSelect':
      // Draft choices can have empty names until save, so keep them outside schema parsing.
      controls = (
        <SelectOptions
          options={options as FieldOptionsOf<'singleSelect'>}
          schema={schema}
          tableId={tableId}
          fieldId={fieldId}
          onChange={onChange}
        />
      );
      break;
    default:
      return null;
  }
  return <div className="rio-field-options">{controls}</div>;
}

export function FieldOptionsForm({ noDefault, ...props }: FieldOptionsFormProps) {
  const { validation: _validation, ...base } = props.options as FieldSpec['options'] & {
    validation?: unknown;
  };
  return (
    <>
      <TypeOptionsForm
        {...props}
        options={base as FieldSpec['options']}
        onChange={(options) =>
          props.onChange(
            followOptions(props.type, {
              ...options,
              ...Object.fromEntries(
                Object.entries(props.options).filter(([key]) =>
                  ['validation', 'unique', 'uniqueCaseInsensitive', 'defaultValue'].includes(key),
                ),
              ),
            } as FieldSpec['options']),
          )
        }
      />
      {!noDefault && (
        <DefaultValueOptions type={props.type} options={props.options} onChange={props.onChange} />
      )}
      <ValidationOptions
        type={props.type}
        options={props.options}
        onChange={props.onChange}
        source={Boolean(props.fieldId && props.schema?.fieldById.get(props.fieldId)?.source)}
      />
    </>
  );
}

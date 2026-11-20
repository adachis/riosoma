import { SettingsAction, SettingsBar, SettingsPicker, SettingsTrigger } from '../../view/ToolbarSettings';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  faBars,
  faCalendarDays,
  faCalculator,
  faDownload,
  faPlus,
  faSliders,
  faTableColumns,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { Dialog } from 'react-aria-components';
import {
  DATE_BUCKETS,
  PIVOT_ORDERS,
  type FieldMeta,
  type GroupBy,
  type PivotSettings as Settings,
} from '@riosoma/contracts';
import { Button, ListBoxItem, Popover, Select, Switch } from '@riosoma/ui';
import { saveFile } from '../../view/download';
import { FilterControl } from '../summary/FilterControl';
import {
  aggregatesAvailable,
  fieldsFor,
  groupFields,
  groupFor,
  isDateField,
  pivotRequest,
  valueFor,
} from '../summary/fields';
import { NONE, fieldOption } from '../summary/options';
import { useSavedConfig, useSummary } from '../summary/store';
import type { ViewComponentProps } from '../types';
import { csvName, pivotCsv, pivotModel } from './layout';
import { AGGREGATE_LABELS, BUCKET_LABELS, ORDER_LABELS, pivotWords } from './messages';
import './pivot.css';

const MAX_ROWS = 3;
const MAX_VALUES = 5;

/** A date field's period picker, beside the field it groups. */
function Bucket({
  group,
  fields,
  label,
  isDisabled,
  onChange,
}: {
  group: GroupBy;
  fields: readonly FieldMeta[];
  label: string;
  isDisabled: boolean;
  onChange(group: GroupBy): void;
}) {
  const { i18n } = useLingui();
  const field = fields.find((item) => item.id === group.fieldId);
  if (!field || !isDateField(field)) return null;
  return (
    <SettingsPicker
      icon={faCalendarDays}
      label={label}
      value={i18n._(BUCKET_LABELS[group.dateBucket ?? 'day'])}
    >
      <Select
        size="sm"
        aria-label={label}
        selectedKey={group.dateBucket ?? 'day'}
        isDisabled={isDisabled}
        onSelectionChange={(key) => {
          const dateBucket = DATE_BUCKETS.find((item) => item === key);
          if (dateBucket) onChange({ ...group, dateBucket });
        }}
      >
        {DATE_BUCKETS.map((bucket) => (
          <ListBoxItem key={bucket} id={bucket}>
            {i18n._(BUCKET_LABELS[bucket])}
          </ListBoxItem>
        ))}
      </Select>
    </SettingsPicker>
  );
}

/** The pivot's settings in the view's settings bar: rows, columns, values, totals, and a download. */
export function PivotSettings(props: ViewComponentProps) {
  const { t, i18n } = useLingui();
  const { session, table, view, fields, format, canEdit, onConfig } = props;
  const settings = view.config.pivot;
  const saved = useSavedConfig(session, view);
  const { state, collapsed } = useSummary(session, view, pivotRequest(saved, fields));
  const save = (patch: Partial<Settings>) => {
    if (canEdit) onConfig({ pivot: { ...settings, ...patch } });
  };
  const groups = groupFields(fields);
  const name = (id: string) => fields.find((field) => field.id === id)?.name ?? '';
  const used = new Set([...settings.rows.map((row) => row.fieldId), settings.column?.fieldId]);
  const unused = groups.filter((field) => !used.has(field.id));
  const rowsLabel = settings.rows.length
    ? t({
        id: 'views.pivot.settings.rowsOf',
        message: `Rows: ${settings.rows.map((row) => name(row.fieldId)).join(', ')}`,
      })
    : t({ id: 'views.pivot.settings.rows', message: 'Rows' });
  const valuesLabel = t({ id: 'views.pivot.settings.values', message: 'Values' });
  const options = t({ id: 'views.pivot.settings.options', message: 'Options' });
  const bucketLabel = t({ id: 'views.pivot.settings.dateBucket', message: 'Dates by' });
  const ready = state.status === 'ready' && state.data.kind === 'pivot' ? state.data : null;

  function download() {
    if (!ready) return;
    const model = pivotModel(ready, settings, fields, format, pivotWords(i18n), collapsed);
    saveFile(new Blob([pivotCsv(model)], { type: 'text/csv;charset=utf-8' }), csvName(table.name, view.name));
  }

  const setRow = (index: number, group: GroupBy) =>
    save({ rows: settings.rows.map((row, at) => (at === index ? group : row)) });

  return (
    <SettingsBar className="rio-pivot-settings">
      <FilterControl
        props={props}
        label={(count, field) =>
          !count
            ? t({ id: 'views.pivot.filter', message: 'Filter' })
            : field
              ? t({ id: 'views.pivot.filteredBy', message: `Filtered by ${field}` })
              : t({
                  id: 'views.pivot.filteredByMany',
                  message: plural(count, { one: 'Filtered by # field', other: 'Filtered by # fields' }),
                })
        }
      />
      <SettingsTrigger label={rowsLabel} icon={faBars}>
        <Button variant="quiet" className="rio-pivot-settings__button">
          {rowsLabel}
        </Button>
        <Popover placement="bottom start">
          <Dialog
            aria-label={t({ id: 'views.pivot.settings.rows', message: 'Rows' })}
            className="rio-pivot-settings__panel"
          >
            {settings.rows.map((row, index) => (
              <div key={index} className="rio-pivot-settings__line">
                <Select
                  size="sm"
                  aria-label={t({ id: 'views.pivot.settings.rowField', message: `Row field ${index + 1}` })}
                  selectedKey={row.fieldId}
                  isDisabled={!canEdit}
                  onSelectionChange={(key) => {
                    const field = groups.find((item) => item.id === key);
                    if (field && field.id !== row.fieldId) setRow(index, groupFor(field));
                  }}
                >
                  {groups
                    .filter((field) => field.id === row.fieldId || !used.has(field.id))
                    .map((field) => fieldOption(field, i18n))}
                </Select>
                <Bucket
                  group={row}
                  fields={fields}
                  label={bucketLabel}
                  isDisabled={!canEdit}
                  onChange={(group) => setRow(index, group)}
                />
                <Button
                  variant="quiet"
                  size="sm"
                  icon={faXmark}
                  aria-label={t({
                    id: 'views.pivot.settings.removeRow',
                    message: `Remove ${name(row.fieldId)}`,
                  })}
                  isDisabled={!canEdit || settings.rows.length <= 1}
                  onPress={() => save({ rows: settings.rows.filter((_, at) => at !== index) })}
                />
              </div>
            ))}
            {settings.rows.length < MAX_ROWS && unused.length ? (
              <Button
                size="sm"
                icon={faPlus}
                isDisabled={!canEdit}
                onPress={() => save({ rows: [...settings.rows, groupFor(unused[0]!)] })}
                aria-label={t({ id: 'views.pivot.settings.addRow', message: 'Add a row field' })}
              />
            ) : null}
          </Dialog>
        </Popover>
      </SettingsTrigger>
      <SettingsPicker
        icon={faTableColumns}
        value={settings.column ? name(settings.column.fieldId) : undefined}
        label={t({ id: 'views.pivot.settings.column', message: 'Columns' })}
      >
        <Select
          size="sm"
          label={t({ id: 'views.pivot.settings.column', message: 'Columns' })}
          selectedKey={settings.column?.fieldId ?? NONE}
          isDisabled={!canEdit}
          onSelectionChange={(key) => {
            const field = groups.find((item) => item.id === key);
            if (key === NONE) save({ column: null });
            else if (field && field.id !== settings.column?.fieldId) save({ column: groupFor(field) });
          }}
        >
          <ListBoxItem id={NONE}>{t({ id: 'views.pivot.settings.noColumn', message: 'None' })}</ListBoxItem>
          {groups
            .filter((field) => field.id === settings.column?.fieldId || !used.has(field.id))
            .map((field) => fieldOption(field, i18n))}
        </Select>
      </SettingsPicker>
      {settings.column ? (
        <Bucket
          group={settings.column}
          fields={fields}
          label={bucketLabel}
          isDisabled={!canEdit}
          onChange={(column) => save({ column })}
        />
      ) : null}
      <SettingsTrigger label={valuesLabel} icon={faCalculator}>
        <Button variant="quiet" className="rio-pivot-settings__button">
          {valuesLabel}
        </Button>
        <Popover placement="bottom start">
          <Dialog aria-label={valuesLabel} className="rio-pivot-settings__panel">
            {settings.values.map((value, index) => {
              const replace = (next: Settings['values'][number]) =>
                save({ values: settings.values.map((item, at) => (at === index ? next : item)) });
              return (
                <div key={index} className="rio-pivot-settings__line">
                  <Select
                    size="sm"
                    aria-label={t({ id: 'views.pivot.settings.valueFn', message: `Value ${index + 1}` })}
                    selectedKey={value.fn}
                    isDisabled={!canEdit}
                    onSelectionChange={(key) => {
                      const fn = aggregatesAvailable(fields).find((item) => item === key);
                      if (fn) replace(valueFor(fn, value, fields));
                    }}
                  >
                    {aggregatesAvailable(fields).map((fn) => (
                      <ListBoxItem key={fn} id={fn}>
                        {i18n._(AGGREGATE_LABELS[fn])}
                      </ListBoxItem>
                    ))}
                  </Select>
                  {value.fn !== 'count' ? (
                    <Select
                      size="sm"
                      aria-label={t({
                        id: 'views.pivot.settings.valueField',
                        message: `Field for value ${index + 1}`,
                      })}
                      selectedKey={value.fieldId}
                      isDisabled={!canEdit}
                      onSelectionChange={(key) => {
                        if (typeof key === 'string') replace({ fn: value.fn, fieldId: key });
                      }}
                    >
                      {fieldsFor(value.fn, fields).map((field) => fieldOption(field, i18n))}
                    </Select>
                  ) : null}
                  <Button
                    variant="quiet"
                    size="sm"
                    icon={faXmark}
                    aria-label={t({
                      id: 'views.pivot.settings.removeValue',
                      message: `Remove value ${index + 1}`,
                    })}
                    isDisabled={!canEdit || settings.values.length <= 1}
                    onPress={() => save({ values: settings.values.filter((_, at) => at !== index) })}
                  />
                </div>
              );
            })}
            {settings.values.length < MAX_VALUES ? (
              <Button
                size="sm"
                icon={faPlus}
                isDisabled={!canEdit}
                onPress={() => save({ values: [...settings.values, { fn: 'count', fieldId: null }] })}
                aria-label={t({ id: 'views.pivot.settings.addValue', message: 'Add a value' })}
              />
            ) : null}
          </Dialog>
        </Popover>
      </SettingsTrigger>
      <SettingsTrigger label={options}>
        <Button variant="quiet" icon={faSliders}>
          {options}
        </Button>
        <Popover placement="bottom end">
          <Dialog aria-label={options} className="rio-pivot-settings__panel">
            <Select
              label={t({ id: 'views.pivot.settings.order', message: 'Order rows' })}
              selectedKey={settings.order}
              isDisabled={!canEdit}
              onSelectionChange={(key) => {
                const order = PIVOT_ORDERS.find((item) => item === key);
                if (order) save({ order });
              }}
            >
              {PIVOT_ORDERS.map((order) => (
                <ListBoxItem key={order} id={order}>
                  {i18n._(ORDER_LABELS[order])}
                </ListBoxItem>
              ))}
            </Select>
            {settings.column ? (
              <Switch
                isSelected={settings.rowTotals}
                isDisabled={!canEdit}
                onChange={(rowTotals) => save({ rowTotals })}
              >
                {t({ id: 'views.pivot.settings.rowTotals', message: 'Total for each row' })}
              </Switch>
            ) : null}
            <Switch
              isSelected={settings.columnTotals}
              isDisabled={!canEdit}
              onChange={(columnTotals) => save({ columnTotals })}
            >
              {settings.column
                ? t({ id: 'views.pivot.settings.columnTotals', message: 'Total for each column' })
                : t({ id: 'views.pivot.settings.grandTotal', message: 'Total row' })}
            </Switch>
          </Dialog>
        </Popover>
      </SettingsTrigger>
      <SettingsAction
        label={t({ id: 'views.pivot.downloadTable', message: 'Download table as CSV' })}
        variant="quiet"
        icon={faDownload}
        isDisabled={!ready}
        onAction={download}
      >
        {t({ id: 'views.pivot.downloadTable', message: 'Download table as CSV' })}
      </SettingsAction>
    </SettingsBar>
  );
}

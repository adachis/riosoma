import { useLingui } from '@lingui/react/macro';
import {
  DATE_BUCKETS,
  PIVOT_ORDERS,
  type FieldMeta,
  type GroupBy,
  type PivotSettings,
} from '@riosoma/contracts';
import { Button, ListBoxItem, Select, Switch } from '@riosoma/ui';
import { faPlus, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import {
  aggregatesAvailable,
  fieldsFor,
  groupFields,
  groupFor,
  isDateField,
  valueFor,
} from '../views/summary/fields';
import { NONE, fieldOption } from '../views/summary/options';
import { AGGREGATE_LABELS, BUCKET_LABELS, ORDER_LABELS } from '../views/pivot/messages';

/** Tile settings use the same field choices, summaries, date buckets, and totals as a pivot view. */
export function PivotTileSettings({
  settings,
  fields,
  onChange,
}: {
  settings: PivotSettings;
  fields: readonly FieldMeta[];
  onChange(settings: PivotSettings): void;
}) {
  const { t, i18n } = useLingui();
  const save = (patch: Partial<PivotSettings>) => onChange({ ...settings, ...patch });
  const groups = groupFields(fields);
  const used = new Set([...settings.rows.map((group) => group.fieldId), settings.column?.fieldId]);
  const unused = groups.filter((field) => !used.has(field.id));
  const bucket = (group: GroupBy, onChange: (group: GroupBy) => void) => {
    const field = fields.find((field) => field.id === group.fieldId);
    if (!field || !isDateField(field)) return null;
    return (
      <Select
        label={t({ id: 'views.pivot.settings.dateBucket', message: 'Dates by' })}
        selectedKey={group.dateBucket ?? 'day'}
        onSelectionChange={(key) => {
          const dateBucket = DATE_BUCKETS.find((item) => item === key);
          if (dateBucket) onChange({ ...group, dateBucket });
        }}
      >
        {DATE_BUCKETS.map((item) => (
          <ListBoxItem key={item} id={item}>
            {i18n._(BUCKET_LABELS[item])}
          </ListBoxItem>
        ))}
      </Select>
    );
  };
  return (
    <>
      {settings.rows.map((group, index) => {
        const replace = (next: GroupBy) =>
          save({ rows: settings.rows.map((item, at) => (at === index ? next : item)) });
        const name = fields.find((field) => field.id === group.fieldId)?.name ?? '';
        return (
          <div className="rio-dashboard-editor__row" key={index}>
            <Select
              label={t({ id: 'views.pivot.settings.rowField', message: `Row field ${index + 1}` })}
              selectedKey={group.fieldId}
              onSelectionChange={(key) => {
                const field = groups.find((field) => field.id === key);
                if (field) replace(groupFor(field));
              }}
            >
              {groups
                .filter((field) => field.id === group.fieldId || !used.has(field.id))
                .map((field) => fieldOption(field, i18n))}
            </Select>
            {bucket(group, replace)}
            <Button
              icon={faTrashCan}
              aria-label={t({ id: 'dashboards.pivot.removeRow', message: `Remove ${name}` })}
              isDisabled={settings.rows.length <= 1}
              onPress={() => save({ rows: settings.rows.filter((_, at) => at !== index) })}
            />
          </div>
        );
      })}
      {settings.rows.length < 3 && unused.length ? (
        <Button
          icon={faPlus}
          aria-label={t({ id: 'views.pivot.settings.addRow', message: 'Add a row field' })}
          onPress={() => save({ rows: [...settings.rows, groupFor(unused[0]!)] })}
        />
      ) : null}
      <div className="rio-dashboard-editor__row">
        <Select
          label={t({ id: 'views.pivot.settings.column', message: 'Columns' })}
          selectedKey={settings.column?.fieldId ?? NONE}
          onSelectionChange={(key) => {
            const field = groups.find((field) => field.id === key);
            if (key === NONE) save({ column: null });
            else if (field) save({ column: groupFor(field) });
          }}
        >
          <ListBoxItem id={NONE}>{t({ id: 'views.pivot.settings.noColumn', message: 'None' })}</ListBoxItem>
          {groups
            .filter((field) => field.id === settings.column?.fieldId || !used.has(field.id))
            .map((field) => fieldOption(field, i18n))}
        </Select>
        {settings.column ? bucket(settings.column, (column) => save({ column })) : null}
      </div>
      {settings.values.map((value, index) => {
        const replace = (next: PivotSettings['values'][number]) =>
          save({ values: settings.values.map((item, at) => (at === index ? next : item)) });
        return (
          <div className="rio-dashboard-editor__row" key={index}>
            <Select
              label={t({ id: 'views.pivot.settings.valueFn', message: `Value ${index + 1}` })}
              selectedKey={value.fn}
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
                label={t({ id: 'views.pivot.settings.valueField', message: `Field for value ${index + 1}` })}
                selectedKey={value.fieldId}
                onSelectionChange={(key) => {
                  if (typeof key === 'string') replace({ ...value, fieldId: key });
                }}
              >
                {fieldsFor(value.fn, fields).map((field) => fieldOption(field, i18n))}
              </Select>
            ) : null}
            <Button
              icon={faTrashCan}
              aria-label={t({ id: 'views.pivot.settings.removeValue', message: `Remove value ${index + 1}` })}
              isDisabled={settings.values.length <= 1}
              onPress={() => save({ values: settings.values.filter((_, at) => at !== index) })}
            />
          </div>
        );
      })}
      {settings.values.length < 5 ? (
        <Button
          icon={faPlus}
          aria-label={t({ id: 'views.pivot.settings.addValue', message: 'Add a value' })}
          onPress={() => save({ values: [...settings.values, { fn: 'count', fieldId: null }] })}
        />
      ) : null}
      <Select
        label={t({ id: 'views.pivot.settings.order', message: 'Order rows' })}
        selectedKey={settings.order}
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
        <Switch isSelected={settings.rowTotals} onChange={(rowTotals) => save({ rowTotals })}>
          {t({ id: 'views.pivot.settings.rowTotals', message: 'Total for each row' })}
        </Switch>
      ) : null}
      <Switch isSelected={settings.columnTotals} onChange={(columnTotals) => save({ columnTotals })}>
        {settings.column
          ? t({ id: 'views.pivot.settings.columnTotals', message: 'Total for each column' })
          : t({ id: 'views.pivot.settings.grandTotal', message: 'Total row' })}
      </Switch>
    </>
  );
}

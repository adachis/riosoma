import { SettingsBar, SettingsPicker, SettingsTrigger } from '../../view/ToolbarSettings';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import {
  faCalendarDays,
  faCalculator,
  faChartColumn,
  faHashtag,
  faLayerGroup,
  faSliders,
} from '@fortawesome/free-solid-svg-icons';
import { Dialog } from 'react-aria-components';
import { CHART_SORTS, CHART_TYPES, DATE_BUCKETS, type ChartSettings as Settings } from '@riosoma/contracts';
import { Button, ListBoxItem, Popover, Select, Switch } from '@riosoma/ui';
import { FilterControl } from '../summary/FilterControl';
import {
  aggregatesAvailable,
  fieldsFor,
  groupFields,
  groupFor,
  isDateField,
  valueFor,
} from '../summary/fields';
import { NONE, fieldOption } from '../summary/options';
import type { ViewComponentProps } from '../types';
import { AGGREGATE_LABELS, BUCKET_LABELS, KIND_LABELS, SORT_LABELS } from './messages';
import './chart-view.css';

/** The chart's settings in the view's settings bar: what it draws, what it groups by, and what it counts. */
export function ChartSettings(props: ViewComponentProps) {
  const { t, i18n } = useLingui();
  const { view, fields, canEdit, onConfig } = props;
  const settings = view.config.chart;
  const save = (patch: Partial<Settings>) => {
    if (canEdit) onConfig({ chart: { ...settings, ...patch } });
  };
  const groups = groupFields(fields);
  const groupField = fields.find((field) => field.id === settings.groupBy?.fieldId);
  const round = settings.chart === 'pie' || settings.chart === 'donut';
  const more = t({ id: 'views.chart.settings.options', message: 'Chart options' });
  return (
    <SettingsBar className="rio-chart-view-settings">
      <FilterControl
        props={props}
        label={(count, name) =>
          !count
            ? t({ id: 'views.chart.filter', message: 'Filter' })
            : name
              ? t({ id: 'views.chart.filteredBy', message: `Filtered by ${name}` })
              : t({
                  id: 'views.chart.filteredByMany',
                  message: plural(count, { one: 'Filtered by # field', other: 'Filtered by # fields' }),
                })
        }
      />
      <SettingsPicker
        icon={faChartColumn}
        value={i18n._(KIND_LABELS[settings.chart])}
        label={t({ id: 'views.chart.settings.kind', message: 'Chart' })}
      >
        <Select
          size="sm"
          label={t({ id: 'views.chart.settings.kind', message: 'Chart' })}
          selectedKey={settings.chart}
          isDisabled={!canEdit}
          onSelectionChange={(key) => {
            const chart = CHART_TYPES.find((item) => item === key);
            if (chart) save({ chart });
          }}
        >
          {CHART_TYPES.map((chart) => (
            <ListBoxItem key={chart} id={chart}>
              {i18n._(KIND_LABELS[chart])}
            </ListBoxItem>
          ))}
        </Select>
      </SettingsPicker>
      <SettingsPicker
        icon={faLayerGroup}
        value={groupField?.name}
        label={t({ id: 'views.chart.settings.groupBy', message: 'Group by' })}
      >
        <Select
          size="sm"
          label={t({ id: 'views.chart.settings.groupBy', message: 'Group by' })}
          placeholder={t({ id: 'views.chart.settings.chooseField', message: 'Choose a field' })}
          selectedKey={groupField?.id ?? null}
          isDisabled={!canEdit}
          onSelectionChange={(key) => {
            const field = groups.find((item) => item.id === key);
            if (field && field.id !== groupField?.id)
              save({
                groupBy: groupFor(field),
                seriesBy: settings.seriesBy === field.id ? null : settings.seriesBy,
              });
          }}
        >
          {groups.map((field) => fieldOption(field, i18n))}
        </Select>
      </SettingsPicker>
      {groupField && isDateField(groupField) && settings.groupBy ? (
        <SettingsPicker
          icon={faCalendarDays}
          value={i18n._(BUCKET_LABELS[settings.groupBy.dateBucket ?? 'day'])}
          label={t({ id: 'views.chart.settings.dateBucket', message: 'Dates by' })}
        >
          <Select
            size="sm"
            label={t({ id: 'views.chart.settings.dateBucket', message: 'Dates by' })}
            selectedKey={settings.groupBy.dateBucket ?? 'day'}
            isDisabled={!canEdit}
            onSelectionChange={(key) => {
              const dateBucket = DATE_BUCKETS.find((item) => item === key);
              if (dateBucket && settings.groupBy) save({ groupBy: { ...settings.groupBy, dateBucket } });
            }}
          >
            {DATE_BUCKETS.map((bucket) => (
              <ListBoxItem key={bucket} id={bucket}>
                {i18n._(BUCKET_LABELS[bucket])}
              </ListBoxItem>
            ))}
          </Select>
        </SettingsPicker>
      ) : null}
      <SettingsPicker
        icon={faCalculator}
        value={i18n._(AGGREGATE_LABELS[settings.value.fn])}
        label={t({ id: 'views.chart.settings.value', message: 'Value' })}
      >
        <Select
          size="sm"
          label={t({ id: 'views.chart.settings.value', message: 'Value' })}
          selectedKey={settings.value.fn}
          isDisabled={!canEdit}
          onSelectionChange={(key) => {
            const fn = aggregatesAvailable(fields).find((item) => item === key);
            if (fn) save({ value: valueFor(fn, settings.value, fields) });
          }}
        >
          {aggregatesAvailable(fields).map((fn) => (
            <ListBoxItem key={fn} id={fn}>
              {i18n._(AGGREGATE_LABELS[fn])}
            </ListBoxItem>
          ))}
        </Select>
      </SettingsPicker>
      {settings.value.fn !== 'count' ? (
        <SettingsPicker
          icon={faHashtag}
          value={fields.find((field) => field.id === settings.value.fieldId)?.name}
          label={t({ id: 'views.chart.settings.valueField', message: 'Of' })}
        >
          <Select
            size="sm"
            label={t({ id: 'views.chart.settings.valueField', message: 'Of' })}
            placeholder={t({ id: 'views.chart.settings.chooseField', message: 'Choose a field' })}
            selectedKey={settings.value.fieldId}
            isDisabled={!canEdit}
            onSelectionChange={(key) => {
              if (typeof key === 'string') save({ value: { fn: settings.value.fn, fieldId: key } });
            }}
          >
            {fieldsFor(settings.value.fn, fields).map((field) => fieldOption(field, i18n))}
          </Select>
        </SettingsPicker>
      ) : null}
      <SettingsTrigger label={more}>
        <Button variant="quiet" icon={faSliders}>
          {more}
        </Button>
        <Popover placement="bottom end">
          <Dialog aria-label={more} className="rio-chart-view-settings__panel">
            {round ? null : (
              <Select
                label={t({ id: 'views.chart.settings.seriesBy', message: 'Split by' })}
                selectedKey={settings.seriesBy ?? NONE}
                isDisabled={!canEdit}
                onSelectionChange={(key) =>
                  save({ seriesBy: typeof key === 'string' && key !== NONE ? key : null })
                }
              >
                <ListBoxItem id={NONE}>
                  {t({ id: 'views.chart.settings.noSeries', message: 'Nothing' })}
                </ListBoxItem>
                {groups
                  .filter((field) => field.id !== groupField?.id)
                  .map((field) => fieldOption(field, i18n))}
              </Select>
            )}
            <Select
              label={t({ id: 'views.chart.settings.sort', message: 'Order' })}
              selectedKey={settings.sort}
              isDisabled={!canEdit}
              onSelectionChange={(key) => {
                const sort = CHART_SORTS.find((item) => item === key);
                if (sort) save({ sort });
              }}
            >
              {CHART_SORTS.map((sort) => (
                <ListBoxItem key={sort} id={sort}>
                  {i18n._(SORT_LABELS[sort])}
                </ListBoxItem>
              ))}
            </Select>
            {!round && settings.chart !== 'scatter' && settings.seriesBy ? (
              <Switch
                isSelected={settings.stacked}
                isDisabled={!canEdit}
                onChange={(stacked) => save({ stacked })}
              >
                {t({ id: 'views.chart.settings.stacked', message: 'Stack the series' })}
              </Switch>
            ) : null}
          </Dialog>
        </Popover>
      </SettingsTrigger>
    </SettingsBar>
  );
}

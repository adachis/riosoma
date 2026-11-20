import { faCalendarDay } from '@fortawesome/free-solid-svg-icons';
import { SettingsAction, SettingsBar } from '../../view/ToolbarSettings';
import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  cellValue,
  isTimelineGroupField,
  type RowData,
  type TimelineSettings as Settings,
} from '@riosoma/contracts';
import { formatCell } from '../../../../grid/format';
import { isCalendarField } from '../calendar/dates';
import { DateFormulaNote } from '../calendar/DateFormulaNote';
import type { ViewComponentProps } from '../types';
import { showToday, useZoom } from './channel';
import { FieldSelect, NoDateButton, RecordsDialog, SettingsPanel, ZoomSelect } from './controls';
import { dateField, dateFields, labelField, recordDays } from './model';
import { useViewRecords } from './records';
import './timeline.css';

/** The timeline's part of the settings bar: Today, the zoom, records with no date, and the list. */
export function TimelineSettings(props: ViewComponentProps) {
  const { t } = useLingui();
  const { session, view, fields, table, format, canEdit, onConfig, onExpand } = props;
  const settings = view.config.timeline;
  const [zoom, setZoom] = useZoom(view.id, settings.zoom, canEdit);
  const records = useViewRecords(session, view.id);
  const start = dateField(fields, settings.startFieldId);
  const end = dateField(fields, settings.endFieldId);
  const dates = useMemo(() => (start ? dateFields(start, end, format) : null), [start, end, format]);
  const group = fields.find((field) => field.id === settings.groupFieldId && isTimelineGroupField(field));
  const label = labelField(fields, settings.labelFieldId, table.primaryFieldId);
  const undated = useMemo(
    () =>
      dates
        ? records.rows.filter((row): row is RowData => !!row && recordDays(row, dates).start === null)
        : [],
    [records.rows, dates],
  );
  const save = (patch: Partial<Settings>) => onConfig({ timeline: { ...settings, ...patch } });
  const dateChoices = fields.filter(isCalendarField);
  const none = t({ id: 'views.timeline.settings.none', message: 'None' });
  return (
    <SettingsBar className="rio-timeline-settings">
      {dates && (
        <>
          <SettingsAction
            icon={faCalendarDay}
            label={t({ id: 'views.timeline.today', message: 'Today' })}
            size="sm"
            variant="quiet"
            onAction={() => showToday(view.id)}
          >
            {t({ id: 'views.timeline.today', message: 'Today' })}
          </SettingsAction>
          <ZoomSelect zoom={zoom} onChange={(next) => (canEdit ? save({ zoom: next }) : setZoom(next))} />
          <NoDateButton rows={undated} label={label} format={format} onExpand={onExpand} />
          <RecordsDialog
            rows={records.rows}
            dates={dates}
            label={label}
            columns={
              group
                ? [
                    {
                      id: group.id,
                      name: group.name,
                      text: (row) => formatCell(group, cellValue(row, group), format),
                    },
                  ]
                : []
            }
            format={format}
            onExpand={onExpand}
          />
        </>
      )}
      <SettingsPanel label={t({ id: 'views.timeline.settings', message: 'Timeline settings' })}>
        <FieldSelect
          label={t({ id: 'views.timeline.start', message: 'Start date' })}
          fields={dateChoices}
          selected={settings.startFieldId}
          isDisabled={!canEdit}
          onChange={(id) => {
            if (id) save({ startFieldId: id });
          }}
        />
        <FieldSelect
          label={t({ id: 'views.timeline.end', message: 'End date' })}
          fields={dateChoices}
          selected={settings.endFieldId}
          none={none}
          isDisabled={!canEdit}
          onChange={(id) => save({ endFieldId: id })}
        />
        <DateFormulaNote fields={fields} />
        <FieldSelect
          label={t({ id: 'views.timeline.group', message: 'Lanes by' })}
          fields={fields.filter(isTimelineGroupField)}
          selected={settings.groupFieldId}
          none={t({ id: 'views.timeline.group.none', message: 'None, packed together' })}
          isDisabled={!canEdit}
          onChange={(id) => save({ groupFieldId: id })}
        />
        <FieldSelect
          label={t({ id: 'views.timeline.label', message: 'Label' })}
          fields={fields}
          selected={label?.id ?? null}
          isDisabled={!canEdit}
          onChange={(id) => save({ labelFieldId: id === table.primaryFieldId ? null : id })}
        />
      </SettingsPanel>
    </SettingsBar>
  );
}

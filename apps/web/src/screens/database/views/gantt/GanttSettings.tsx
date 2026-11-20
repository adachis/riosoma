import { faCalendarDay, faDiagramProject } from '@fortawesome/free-solid-svg-icons';
import { SettingsAction, SettingsBar } from '../../view/ToolbarSettings';
import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  cellValue,
  isDependencyField,
  isProgressField,
  type GanttSettings as Settings,
} from '@riosoma/contracts';
import { formatCell } from '../../../../grid/format';
import { isCalendarField } from '../calendar/dates';
import { DateFormulaNote } from '../calendar/DateFormulaNote';
import type { ViewComponentProps } from '../types';
import { showDependencies, showToday, useZoom } from '../timeline/channel';
import { FieldSelect, RecordsDialog, SettingsPanel, ZoomSelect, type ListColumn } from '../timeline/controls';
import { dateField, dateFields, labelField } from '../timeline/model';
import { useViewRecords } from '../timeline/records';
import './gantt.css';

/** The Gantt chart's part of the settings bar: Today, the zoom, the list, and its fields. */
export function GanttSettings(props: ViewComponentProps) {
  const { t } = useLingui();
  const { session, view, fields, table, format, canEdit, onConfig, onExpand } = props;
  const settings = view.config.gantt;
  const [zoom, setZoom] = useZoom(view.id, settings.zoom, canEdit);
  const records = useViewRecords(session, view.id);
  const start = dateField(fields, settings.startFieldId);
  const end = dateField(fields, settings.endFieldId);
  const dates = useMemo(() => (start ? dateFields(start, end, format) : null), [start, end, format]);
  const dependency = fields.find(
    (field) => field.id === settings.dependencyFieldId && isDependencyField(field),
  );
  const progress = fields.find((field) => field.id === settings.progressFieldId && isProgressField(field));
  const label = labelField(fields, settings.labelFieldId, table.primaryFieldId);
  const save = (patch: Partial<Settings>) => onConfig({ gantt: { ...settings, ...patch } });
  const dateChoices = fields.filter(isCalendarField);
  const none = t({ id: 'views.gantt.settings.none', message: 'None' });
  const dependencyLabel = t({ id: 'views.gantt.dependencies', message: 'Dependencies' });
  const columns: ListColumn[] = [progress, dependency].flatMap((field) =>
    field
      ? [{ id: field.id, name: field.name, text: (row) => formatCell(field, cellValue(row, field), format) }]
      : [],
  );
  return (
    <SettingsBar className="rio-timeline-settings">
      {dates && (
        <>
          <SettingsAction
            icon={faCalendarDay}
            label={t({ id: 'views.gantt.today', message: 'Today' })}
            size="sm"
            variant="quiet"
            onAction={() => showToday(view.id)}
          >
            {t({ id: 'views.gantt.today', message: 'Today' })}
          </SettingsAction>
          <ZoomSelect zoom={zoom} onChange={(next) => (canEdit ? save({ zoom: next }) : setZoom(next))} />
          <RecordsDialog
            rows={records.rows}
            dates={dates}
            label={label}
            columns={columns}
            format={format}
            onExpand={onExpand}
          />
          {/* The way into dependency actions without a keyboard or a diamond wide enough to drag. */}
          {dependency && !props.readOnly && (
            <SettingsAction
              icon={faDiagramProject}
              label={dependencyLabel}
              size="sm"
              variant="quiet"
              onAction={() => showDependencies(view.id)}
            >
              {dependencyLabel}
            </SettingsAction>
          )}
        </>
      )}
      <SettingsPanel label={t({ id: 'views.gantt.settings', message: 'Gantt settings' })}>
        <FieldSelect
          label={t({ id: 'views.gantt.start', message: 'Start date' })}
          fields={dateChoices}
          selected={settings.startFieldId}
          isDisabled={!canEdit}
          onChange={(id) => {
            if (id) save({ startFieldId: id });
          }}
        />
        <FieldSelect
          label={t({ id: 'views.gantt.end', message: 'End date' })}
          fields={dateChoices}
          selected={settings.endFieldId}
          none={none}
          isDisabled={!canEdit}
          onChange={(id) => save({ endFieldId: id })}
        />
        <DateFormulaNote fields={fields} />
        <FieldSelect
          label={t({ id: 'views.gantt.dependency', message: 'Depends on' })}
          fields={fields.filter(isDependencyField)}
          selected={settings.dependencyFieldId}
          none={none}
          isDisabled={!canEdit}
          onChange={(id) => save({ dependencyFieldId: id })}
        />
        <FieldSelect
          label={t({ id: 'views.gantt.progress', message: 'Progress' })}
          fields={fields.filter(isProgressField)}
          selected={settings.progressFieldId}
          none={none}
          isDisabled={!canEdit}
          onChange={(id) => save({ progressFieldId: id })}
        />
        <FieldSelect
          label={t({ id: 'views.gantt.label', message: 'Label' })}
          fields={fields}
          selected={label?.id ?? null}
          isDisabled={!canEdit}
          onChange={(id) => save({ labelFieldId: id === table.primaryFieldId ? null : id })}
        />
      </SettingsPanel>
    </SettingsBar>
  );
}

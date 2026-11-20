import { SettingsAction, SettingsBar } from '../../view/ToolbarSettings';
import { useMemo } from 'react';
import { faExpand } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import type { MapSettings as Settings, RowData } from '@riosoma/contracts';
import { appConfigQuery } from '../../../../app-config';
import { FieldSelect, SettingsPanel } from '../timeline/controls';
import { useViewRecords } from '../timeline/records';
import type { ViewComponentProps } from '../types';
import { requestMap } from './channel';
import { NoLocationButton, PlacesDialog } from './controls';
import { placeOf } from './pins';
import '../timeline/timeline.css';
import './map.css';

/** The map's part of the settings bar: Fit all, records with no place, the list, and the fields. */
export function MapSettings(props: ViewComponentProps) {
  const { t } = useLingui();
  const { session, view, fields, table, format, canEdit, onConfig, onExpand, colors, readOnly } = props;
  const settings = view.config.map;
  const config = useQuery(appConfigQuery);
  const records = useViewRecords(session, view.id);
  const location = fields.find((field) => field.id === settings.locationFieldId && field.type === 'location');
  const color = fields.find((field) => field.id === settings.colorFieldId && field.type === 'singleSelect');
  const unplaced = useMemo(
    () => (location ? records.rows.filter((row): row is RowData => !!row && !placeOf(row, location)) : []),
    [records.rows, location],
  );
  const save = (patch: Partial<Settings>) => onConfig({ map: { ...settings, ...patch } });
  const names = { primary: fields.find((field) => field.id === table.primaryFieldId), format };
  // With maps off, the view already lists every place, so there's nothing to frame or list here.
  const mapsOn = !!config.data?.map.styleUrl;
  return (
    <SettingsBar className="rio-timeline-settings rio-map-view-settings">
      {location && mapsOn && (
        <SettingsAction
          label={t({ id: 'views.map.fit', message: 'Fit all' })}
          size="sm"
          variant="quiet"
          icon={faExpand}
          onAction={() => requestMap(view.id, { kind: 'fit' })}
        >
          {t({ id: 'views.map.fit', message: 'Fit all' })}
        </SettingsAction>
      )}
      {location && <NoLocationButton rows={unplaced} names={names} onOpen={onExpand} />}
      {location && mapsOn && (
        <PlacesDialog
          rows={records.rows}
          location={location}
          color={color}
          names={names}
          colors={colors}
          onOpen={onExpand}
          onShow={(recordId) => requestMap(view.id, { kind: 'show', recordId })}
        />
      )}
      {/* A page shared by link reads the map and changes none of its settings. */}
      {!readOnly && (
        <SettingsPanel label={t({ id: 'views.map.settings', message: 'Map settings' })}>
          <FieldSelect
            label={t({ id: 'views.map.location', message: 'Location' })}
            fields={fields.filter((field) => field.type === 'location')}
            selected={settings.locationFieldId}
            isDisabled={!canEdit}
            onChange={(id) => {
              if (id) save({ locationFieldId: id });
            }}
          />
          <FieldSelect
            label={t({ id: 'views.map.color', message: 'Color by' })}
            fields={fields.filter((field) => field.type === 'singleSelect')}
            selected={settings.colorFieldId}
            none={t({ id: 'views.map.color.none', message: 'None' })}
            isDisabled={!canEdit}
            onChange={(id) => save({ colorFieldId: id })}
          />
        </SettingsPanel>
      )}
    </SettingsBar>
  );
}

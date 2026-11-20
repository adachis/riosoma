import { lazy, Suspense, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { faMinus, faPlus, faXmark } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { cellValue, visibleFieldIds, type FieldMeta, type RowData } from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { appConfigQuery } from '../../../../app-config';
import { formatCell } from '../../../../grid/format';
import { ColorMark } from '../../colors/ColorMark';
import { Painted } from '../../colors/Painted';
import { watchTheme } from '../../dashboards/chart-theme';
import { CardValue } from '../CardValue';
import { MAX_RECORDS, useViewRecords } from '../timeline/records';
import type { ViewComponentProps } from '../types';
import { useMapRequests } from './channel';
import { FALLBACK_COLORS, readMapColors } from './colors';
import { LocationSetup, PlacesTable } from './controls';
import type { MapControls } from './MapCanvas';
import { pinData, placeOf, placeText } from './pins';
import './map.css';

/** How many of the view's visible fields a pin's card shows under its title. */
const CARD_FIELDS = 3;

// MapLibre is most of this view's weight, so it loads only when there's a map to draw.
const MapCanvas = lazy(() => import('./MapCanvas').then((module) => ({ default: module.MapCanvas })));

export function MapView(props: ViewComponentProps) {
  const location = props.fields.find(
    (field) => field.id === props.view.config.map.locationFieldId && field.type === 'location',
  );
  if (!location) return <LocationSetup view={props} />;
  return <Places key={`${props.view.id}:${location.id}`} {...props} location={location} />;
}

function Places(props: ViewComponentProps & { location: FieldMeta }) {
  const { t } = useLingui();
  const { session, view, table, fields, format, location, onExpand, colors: ruled } = props;
  const config = useQuery(appConfigQuery);
  const records = useViewRecords(session, view.id);
  const color = fields.find(
    (field) => field.id === view.config.map.colorFieldId && field.type === 'singleSelect',
  );
  const primary = fields.find((field) => field.id === table.primaryFieldId);
  const root = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState(FALLBACK_COLORS);
  const [selected, setSelected] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [controls, setControls] = useState<MapControls | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const descriptionId = useId();

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const read = () => setColors(readMapColors(node));
    read();
    return watchTheme(read);
  }, []);

  // A record the view's color rules color takes that color on its pin.
  const data = useMemo(
    () =>
      pinData(
        records.rows,
        location,
        color,
        (choice) => (choice ? colors.choices[choice] : colors.accent),
        ruled ? (row) => ruled.record(row)?.color ?? null : undefined,
      ),
    [records.rows, location, color, colors, ruled],
  );
  const byId = useMemo(() => {
    const rows = new Map<string, RowData>();
    for (const row of records.rows) if (row) rows.set(row.id, row);
    return rows;
  }, [records.rows]);

  const untitled = t({ id: 'views.map.untitled', message: 'Untitled record' });
  const title = (row: RowData) =>
    (primary ? formatCell(primary, cellValue(row, primary), format) : '') || untitled;

  useMapRequests(view.id, (request) => {
    if (!controls) return;
    if (request.kind === 'fit') controls.fitAll();
    else {
      controls.show(request.recordId);
      const row = byId.get(request.recordId);
      if (row) {
        const name = title(row);
        setAnnouncement(t({ id: 'views.map.showing', message: `Showing ${name} on the map` }));
      }
    }
  });

  const styleUrl = config.data?.map.styleUrl ?? null;
  const names = { primary, format };
  const limit = new Intl.NumberFormat(format.locale).format(MAX_RECORDS);
  const notice =
    records.limited || records.loading ? (
      <p className="rio-map-view__notice">
        {records.limited
          ? t({
              id: 'views.map.limited',
              message: `Showing the first ${limit} records.  Filter the view to see the rest.`,
            })
          : t({ id: 'views.map.loading', message: 'Loading records…' })}
      </p>
    ) : null;

  if (config.isPending) return <div ref={root} className="rio-map-view" aria-busy="true" />;

  // With maps off, or no way to draw one, the records and their places show as a list.
  if (!styleUrl || failed || config.isError)
    return (
      <div ref={root} className="rio-map-view rio-map-view--list" aria-busy={records.loading || undefined}>
        <p className="rio-map-view__note" role="note">
          {config.data?.map.styleUrl === null
            ? t({
                id: 'views.map.off',
                message: 'Maps are turned off on this server, so each record’s place is listed instead.',
              })
            : t({
                id: 'views.map.failed',
                message: 'The map couldn’t load here, so each record’s place is listed instead.',
              })}
        </p>
        <PlacesTable
          rows={records.rows}
          location={location}
          color={color}
          names={names}
          colors={ruled}
          onOpen={onExpand}
        />
        {!records.loading && records.count === 0 && (
          <p className="rio-map-view__empty">
            {t({ id: 'views.map.empty', message: 'No records in this view' })}
          </p>
        )}
        {notice}
      </div>
    );

  const name = view.name;
  const count = data.pins.features.length;
  const card = selected ? byId.get(selected) : undefined;
  return (
    <div ref={root} className="rio-map-view">
      <Suspense fallback={<div className="rio-map-view__canvas" />}>
        <MapCanvas
          styleUrl={styleUrl}
          pins={data.pins}
          colors={colors}
          selected={card ? card.id : null}
          label={t({
            id: 'views.map.label',
            message: `${name} map, ${plural(count, { one: '# pin', other: '# pins' })}`,
          })}
          descriptionId={descriptionId}
          strings={{
            'AttributionControl.ToggleAttribution': t({
              id: 'views.map.attribution',
              message: 'Show or hide map credits',
            }),
            'AttributionControl.MapFeedback': t({ id: 'views.map.feedback', message: 'Improve this map' }),
          }}
          onSelect={setSelected}
          onFail={() => setFailed(true)}
          onControls={setControls}
        />
      </Suspense>
      <p id={descriptionId} hidden>
        {t({
          id: 'views.map.help',
          message:
            'Use the arrow keys to move the map, and plus and minus to zoom.  The List button above it lists every record and its place.',
        })}
      </p>
      {controls && (
        <div className="rio-map-view__zoom">
          <Button
            size="sm"
            icon={faPlus}
            aria-label={t({ id: 'views.map.zoomIn', message: 'Zoom in' })}
            onPress={() => controls.zoomIn()}
          />
          <Button
            size="sm"
            icon={faMinus}
            aria-label={t({ id: 'views.map.zoomOut', message: 'Zoom out' })}
            onPress={() => controls.zoomOut()}
          />
        </div>
      )}
      {card && (
        <PinCard
          {...props}
          row={card}
          title={title(card)}
          onOpen={() => onExpand(card.id)}
          onClose={() => setSelected(null)}
        />
      )}
      <div className="rio-map-view__status" role="status">
        {announcement}
      </div>
      {!records.loading && records.count === 0 && (
        <p className="rio-map-view__empty">
          {t({ id: 'views.map.empty', message: 'No records in this view' })}
        </p>
      )}
      {notice}
    </div>
  );
}

/** A selected pin's record: its title, place, and first few fields, with a way to open it. */
function PinCard({
  row,
  title,
  location,
  view,
  fields,
  table,
  format,
  colors,
  onOpen,
  onClose,
}: ViewComponentProps & {
  row: RowData;
  title: string;
  location: FieldMeta;
  onOpen(): void;
  onClose(): void;
}) {
  const { t } = useLingui();
  const headingId = useId();
  const place = placeOf(row, location);
  const primary = fields.find((field) => field.id === table.primaryFieldId);
  const record = colors?.record(row) ?? null;
  const shown = visibleFieldIds(view.config, fields, table.primaryFieldId)
    .filter((id) => id !== table.primaryFieldId && id !== location.id)
    .slice(0, CARD_FIELDS)
    .flatMap((id) => fields.find((field) => field.id === id) ?? []);
  return (
    <section className="rio-map-view-card" aria-labelledby={headingId}>
      <div className="rio-map-view-card__header">
        {record && <ColorMark record={record} />}
        <h2 id={headingId} className="rio-map-view-card__title" title={title}>
          {primary ? <Painted paint={colors?.cell(row, primary)}>{title}</Painted> : title}
        </h2>
        <Button
          size="sm"
          variant="quiet"
          icon={faXmark}
          aria-label={t({ id: 'views.map.card.close', message: 'Close' })}
          onPress={onClose}
        />
      </div>
      {place && <p className="rio-map-view-card__place">{placeText(place)}</p>}
      {shown.length > 0 && (
        <dl className="rio-map-view-card__fields">
          {shown.map((field) => {
            const value = cellValue(row, field);
            return (
              <div key={field.id}>
                <dt>{field.name}</dt>
                <dd title={formatCell(field, value, format)}>
                  <CardValue
                    field={field}
                    value={value}
                    format={format}
                    row={row}
                    paint={colors?.cell(row, field)}
                  />
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      <Button
        size="sm"
        variant="primary"
        aria-label={t({ id: 'views.map.card.openLabel', message: `Open ${title}` })}
        onPress={onOpen}
      >
        {t({ id: 'views.map.card.open', message: 'Open' })}
      </Button>
    </section>
  );
}
